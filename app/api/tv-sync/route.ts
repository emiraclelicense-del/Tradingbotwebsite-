import { createClient } from "@supabase/supabase-js";

// Webhook bridge -> tv_trades (TradingView History tab).
// Reads the bridge (env TV_BRIDGE_URL = "http://<server>/<topic>", kept secret: the same topic feeds the MT5 EAs)
// and stores every closed Pine trade:
//   "history" alerts : {"event":"history","symbol":"XAUUSD","tf":"5","trades":"<unix>|<code>|<side>|<best>|<runs>|<obId>|<E1,E2,E3,E4>|<SL>|<TP1/TP2/..>|<TPs hit>|<entries filled>|<max move from E1, pips>|<max against after the last fill, pips>|<trend 1 with / -1 against / 0>;..."}
//                      code 2 target, 1 BE after TP, 3 worked then SL, 0 fail
//   "result" alerts  : the full result at the candle close of a trade whose close went out live (the EA ignores them)
//   "close" alerts   : the live end of a trade, e.g. msg "TP2 ✓ TARGET (LIVE)", "SL | FAIL | AGAINST E1 12.0p | TREND WITH | RUNS E1 +8.5p"
// Flux OB script (newFlux.pine): its alerts carry "src":"flux" and (website-only mode) events flux_limits / flux_close ...
// that the MT5 EA ignores; they are stored with keys "FLUX|symbol|tf|OB id" (Flux OB History tab).
// Called by the TradingView History page on load and once a day by the Vercel cron. Safe to call any time.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = { key: string; symbol: string; tf: string; side: string; closed_at: string; result: string; best_run: number | null; runs: string | null; entry: string | null; stop_loss: string | null; take_profit: string | null; tp_hit: number | null; filled: number | null; max_move: number | null; max_against: number | null; trend?: string | null; market?: string | null; adx?: number | null; after_sl?: number | null; after_sl_result?: string | null; opened_at?: string | null; from_history: boolean };

// The chart history (Pine) is the reference for time / result / runs; a live close only adds the entry and SL,
// and fills the rest while the history for that trade has not arrived yet.
function merge(base: Row | undefined, add: Row): Row {
  if (!base) return add;
  const hist = add.from_history ? add : base.from_history ? base : add;
  const other = hist === add ? base : add;
  return { ...hist, best_run: hist.best_run ?? other.best_run, runs: hist.runs ?? other.runs,
    entry: add.entry ?? base.entry, stop_loss: add.stop_loss ?? base.stop_loss, take_profit: add.take_profit ?? base.take_profit,
    tp_hit: hist.tp_hit ?? other.tp_hit, filled: hist.filled ?? other.filled, max_move: hist.max_move ?? other.max_move, max_against: hist.max_against ?? other.max_against, trend: hist.trend ?? other.trend ?? null, market: hist.market ?? other.market ?? null, adx: hist.adx ?? other.adx ?? null, after_sl: hist.after_sl ?? other.after_sl ?? null, after_sl_result: hist.after_sl_result ?? other.after_sl_result ?? null, opened_at: hist.opened_at ?? other.opened_at ?? null, from_history: base.from_history || add.from_history };
}

const COLS = "key, symbol, tf, side, closed_at, result, best_run, runs, entry, stop_loss, take_profit, tp_hit, filled, max_move, max_against, from_history";
const CODES: Record<string, string> = { "2": "target", "1": "be", "3": "worked", "0": "fail" };
const int = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : null);
const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : null);
// trend at the first fill (H1 EMA 50/200, like the MT5 EA)
// market at the first fill (H1 ADX / EMA 50-200): 1 bullish, -1 bearish, 2 ranging
const marketOf = (v: string | undefined) => (v === "1" || /^bullish$/i.test(v ?? "") ? "bullish" : v === "-1" || /^bearish$/i.test(v ?? "") ? "bearish" : v === "2" || /^ranging$/i.test(v ?? "") ? "ranging" : null);
// after an SL: 1 = price came back to TP1 within the limit, 2 = went past the limit beyond E4
const afterSlOf = (v: string | undefined) => (v === "1" ? "tp1" : v === "2" ? "over" : null);
// E1 fill time (unix seconds) -> ISO
const unixIso = (v: string | undefined) => (v && /^\d{9,11}$/.test(v) ? new Date(Number(v) * 1000).toISOString() : null);
const trendOf = (v: string | undefined) => (v === "1" || /^with$/i.test(v ?? "") ? "with" : v === "-1" || /^against$/i.test(v ?? "") ? "against" : null);
const fmt = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : null);

// Start of the chart candle a close alert belongs to (the history table shows that time, not the alert time):
// an alert at a candle close (12:40:07 on M10, may come some seconds late) -> 12:30; a "(LIVE)" alert mid-candle (12:43) -> 12:40.
function candleOpen(tf: string, unix: number, live: boolean) {
  const secs = /^\d+$/.test(tf) ? Number(tf) * 60 : 0;
  return secs > 0 ? Math.floor(unix / secs) * secs - (live ? 0 : secs) : unix;
}

function closeResult(msg: string) {
  if (/TARGET/i.test(msg)) return "target";
  if (/(BE|SL) AFTER TP/i.test(msg)) return "be";
  if (/WORKED/i.test(msg)) return "worked";
  return "fail";
}

async function sync() {
  const bridge = process.env.TV_BRIDGE_URL, url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!bridge || !url || !key) return Response.json({ error: "TV_BRIDGE_URL / SUPABASE_SERVICE_ROLE_KEY not set on the server" }, { status: 500 });
  const db = createClient(url, key, { auth: { persistSession: false } });

  // the bridge keeps its last ~2000 alerts (about a week): read them all, upserts make repeats harmless
  const since = Math.floor(Date.now() / 1000) - 10 * 86400;
  let text: string;
  try {
    const res = await fetch(`${bridge.replace(/\/+$/, "")}/json?poll=1&since=${since}`, { cache: "no-store", signal: AbortSignal.timeout(20000) });
    if (!res.ok) return Response.json({ error: `bridge answered HTTP ${res.status}` }, { status: 502 });
    text = await res.text();
  } catch {
    return Response.json({ error: "bridge not reachable" }, { status: 502 });
  }

  // The first Flux script version (26 Nov) sent its history WITHOUT "src":"flux": an item without src that is
  // exactly the same as an item of a Flux history (same chart) is that Flux trade, not a LuxAlgo one -> skipped.
  const fluxItems = new Set<string>();
  for (const line of text.split("\n")) {
    try {
      const env = JSON.parse(line), a = env.event === "message" && env.message ? JSON.parse(env.message) : null;
      if (a && a.src === "flux" && a.event === "history" && typeof a.trades === "string" && typeof a.tf === "string")
        for (const item of a.trades.split(";")) fluxItems.add(`${a.tf}|${item}`);
    } catch { /* not JSON */ }
  }

  const rows = new Map<string, Row>();
  // "postsl" alerts: how far price went beyond E4 after the SL (key -> values), applied to the stored trade
  const postSl = new Map<string, { after_sl: number | null; after_sl_result: string | null }>();
  // original SL of each setup (its "limits" / "fill" alerts): a close alert carries the trailed BE SL instead
  const firstSl = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let env: { event?: string; time?: number; message?: string };
    let a: Record<string, unknown>;
    try { env = JSON.parse(line); if (env.event !== "message" || !env.message) continue; a = JSON.parse(env.message); } catch { continue; }
    const symbol = typeof a.symbol === "string" ? a.symbol.replace(/^.*:/, "").toUpperCase() : "";
    const tf = typeof a.tf === "string" ? a.tf : "";
    if (!symbol || !tf) continue;
    // Flux OB script: own key space, event without its "flux_" prefix
    const flux = a.src === "flux" || (typeof a.event === "string" && a.event.startsWith("flux_"));
    if (flux && typeof a.event === "string") a.event = a.event.replace(/^flux_/, "");
    const pre = flux ? "FLUX|" : "";

    if (a.event === "history" && typeof a.trades === "string") {
      for (const item of a.trades.split(";")) {
        if (!flux && fluxItems.has(`${tf}|${item}`)) continue;
        const [t, code, side, best, runs, obId, lims, sl, tps, hit, fil, move, against, trd, mk, ax, psl, psq, op] = item.split("|");
        const unix = Number(t);
        if (!Number.isFinite(unix) || !CODES[code] || (side !== "1" && side !== "-1")) continue;
        const k = `${pre}${symbol}|${tf}|${obId || `t${unix}`}`;
        rows.set(k, merge(rows.get(k), { key: k, symbol, tf, side: side === "1" ? "buy" : "sell", closed_at: new Date(unix * 1000).toISOString(), result: CODES[code],
          best_run: best ? Number(best) : null, runs: runs || null, entry: lims ? lims.split(",").join(", ") : null, stop_loss: sl || null,
          take_profit: tps ? tps.split("/").join(" / ") : null, tp_hit: int(hit), filled: int(fil), max_move: num(move), max_against: num(against), trend: trendOf(trd), market: marketOf(mk), adx: num(ax), after_sl: psq === "1" || psq === "2" ? num(psl) : null, after_sl_result: afterSlOf(psq), opened_at: unixIso(op), from_history: true }));
      }
      continue;
    }
    if ((a.event === "limits" || a.event === "fill") && typeof a.id === "string" && a.id.endsWith("_tg") && fmt(a.sl)) {
      const k = `${pre}${symbol}|${tf}|${a.id.slice(0, -3)}`;
      if (a.event === "limits" || !firstSl.has(k)) firstSl.set(k, fmt(a.sl)!);
      continue;
    }
    if (a.event === "postsl" && typeof a.id === "string" && a.id.endsWith("_tg")) {
      const msg = typeof a.msg === "string" ? a.msg : "";
      const res = /TP1 REACHED/i.test(msg) ? "tp1" : /NO TP1/i.test(msg) ? "over" : null;
      if (res) postSl.set(`${pre}${symbol}|${tf}|${a.id.slice(0, -3)}`, { after_sl: num(/AFTER SL ([\d.]+)/i.exec(msg)?.[1]), after_sl_result: res });
      continue;
    }
    if ((a.event === "close" || a.event === "result") && typeof a.id === "string" && a.id.endsWith("_tg") && (a.side === "buy" || a.side === "sell") && typeof env.time === "number") {
      const msg = typeof a.msg === "string" ? a.msg : "";
      const k = `${pre}${symbol}|${tf}|${a.id.slice(0, -3)}`;
      const limits = Array.isArray(a.limits) ? a.limits.filter((v): v is number => typeof v === "number") : [];
      const tps = Array.isArray(a.tp) ? a.tp.filter((v): v is number => typeof v === "number") : [];
      const runs = msg.includes("RUNS ") ? msg.slice(msg.indexOf("RUNS ") + 5).trim() : null;
      rows.set(k, merge(rows.get(k), { key: k, symbol, tf, side: a.side, closed_at: new Date(candleOpen(tf, env.time, /\(LIVE\)/i.test(msg)) * 1000).toISOString(), result: closeResult(msg),
        best_run: null, runs, entry: limits.length ? limits.join(", ") : null, stop_loss: firstSl.get(k) ?? fmt(a.sl), take_profit: tps.length ? tps.join(" / ") : null,
        tp_hit: /TARGET/i.test(msg) ? tps.length : Number(/AFTER TP(\d+)/i.exec(msg)?.[1] ?? 0), filled: typeof a.filled === "number" ? a.filled : null, max_move: null, max_against: num(/AGAINST E\d+ ([\d.]+)p/i.exec(msg)?.[1]), trend: trendOf(/TREND (WITH|AGAINST)/i.exec(msg)?.[1]), market: marketOf(/MARKET (BULLISH|BEARISH|RANGING)/i.exec(msg)?.[1]), adx: num(/ADX ([\d.]+)/i.exec(msg)?.[1]), opened_at: unixIso(/OPENED (\d+)/i.exec(msg)?.[1]), from_history: false }));
    }
  }

  // merge with what is stored already (an older sync may hold the history or the entry of the same trade)
  // (newer columns "trend" / "market": until they are added in Supabase the sync keeps working without them)
  const keys = [...new Set([...rows.keys(), ...postSl.keys()])];
  let extra = ["trend", "market", "adx", "after_sl", "after_sl_result", "opened_at"];
  for (let i = 0; i < keys.length; i += 200) {
    const read = (cols: string) => db.from("tv_trades").select(cols).in("key", keys.slice(i, i + 200));
    let { data, error } = await read([COLS, ...extra].join(", "));
    while (error && extra.some((c) => error!.message.includes(c))) {
      extra = extra.filter((c) => !error!.message.includes(c));
      ({ data, error } = await read([COLS, ...extra].join(", ")));
    }
    if (error) return Response.json({ error: error.message }, { status: 500 });
    for (const old of (data ?? []) as unknown as Row[]) { const add = rows.get(old.key); rows.set(old.key, add ? merge(old, add) : old); }
  }
  for (const [k, v] of postSl) { const r = rows.get(k); if (r) rows.set(k, { ...r, after_sl: r.after_sl ?? v.after_sl, after_sl_result: r.after_sl_result ?? v.after_sl_result }); }
  const list = [...rows.values()].map((r) => {
    const out: Record<string, unknown> = { ...r };
    for (const c of ["trend", "market", "adx", "after_sl", "after_sl_result", "opened_at"]) if (!extra.includes(c)) delete out[c];
    return out;
  });
  for (let i = 0; i < list.length; i += 500) {
    const { error } = await db.from("tv_trades").upsert(list.slice(i, i + 500), { onConflict: "key" });
    if (error) return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ ok: true, trades: list.length });
}

export const GET = sync;
export const POST = sync;
