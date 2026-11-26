import { createClient } from "@supabase/supabase-js";

// Webhook bridge -> tv_trades (TradingView History tab).
// Reads the bridge (env TV_BRIDGE_URL = "http://<server>/<topic>", kept secret: the same topic feeds the MT5 EAs)
// and stores every closed Pine trade:
//   "history" alerts : {"event":"history","symbol":"XAUUSD","tf":"5","trades":"<unix>|<code>|<side>|<best>|<runs>|<obId>|<E1,E2,E3,E4>|<SL>|<TP1/TP2/..>;..."}
//                      code 2 target, 1 BE after TP, 3 worked then SL, 0 fail
//   "close" alerts   : the live end of a trade, e.g. msg "TP2 ✓ TARGET (LIVE)", "SL | FAIL | RUNS E1 +8.5p"
// Called by the TradingView History page on load and once a day by the Vercel cron. Safe to call any time.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = { key: string; symbol: string; tf: string; side: string; closed_at: string; result: string; best_run: number | null; runs: string | null; entry: string | null; stop_loss: string | null; take_profit: string | null; from_history: boolean };

// The chart history (Pine) is the reference for time / result / runs; a live close only adds the entry and SL,
// and fills the rest while the history for that trade has not arrived yet.
function merge(base: Row | undefined, add: Row): Row {
  if (!base) return add;
  const hist = add.from_history ? add : base.from_history ? base : add;
  const other = hist === add ? base : add;
  return { ...hist, best_run: hist.best_run ?? other.best_run, runs: hist.runs ?? other.runs,
    entry: add.entry ?? base.entry, stop_loss: add.stop_loss ?? base.stop_loss, take_profit: add.take_profit ?? base.take_profit, from_history: base.from_history || add.from_history };
}

const CODES: Record<string, string> = { "2": "target", "1": "be", "3": "worked", "0": "fail" };
const fmt = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : null);

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

  const rows = new Map<string, Row>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let env: { event?: string; time?: number; message?: string };
    let a: Record<string, unknown>;
    try { env = JSON.parse(line); if (env.event !== "message" || !env.message) continue; a = JSON.parse(env.message); } catch { continue; }
    const symbol = typeof a.symbol === "string" ? a.symbol.replace(/^.*:/, "").toUpperCase() : "";
    const tf = typeof a.tf === "string" ? a.tf : "";
    if (!symbol || !tf) continue;

    if (a.event === "history" && typeof a.trades === "string") {
      for (const item of a.trades.split(";")) {
        const [t, code, side, best, runs, obId, lims, sl, tps] = item.split("|");
        const unix = Number(t);
        if (!Number.isFinite(unix) || !CODES[code] || (side !== "1" && side !== "-1")) continue;
        const k = `${symbol}|${tf}|${obId || `t${unix}`}`;
        rows.set(k, merge(rows.get(k), { key: k, symbol, tf, side: side === "1" ? "buy" : "sell", closed_at: new Date(unix * 1000).toISOString(), result: CODES[code],
          best_run: best ? Number(best) : null, runs: runs || null, entry: lims ? lims.split(",").join(", ") : null, stop_loss: sl || null,
          take_profit: tps ? tps.split("/").join(" / ") : null, from_history: true }));
      }
      continue;
    }
    if (a.event === "close" && typeof a.id === "string" && a.id.endsWith("_tg") && (a.side === "buy" || a.side === "sell") && typeof env.time === "number") {
      const msg = typeof a.msg === "string" ? a.msg : "";
      const k = `${symbol}|${tf}|${a.id.slice(0, -3)}`;
      const limits = Array.isArray(a.limits) ? a.limits.filter((v): v is number => typeof v === "number") : [];
      const tps = Array.isArray(a.tp) ? a.tp.filter((v): v is number => typeof v === "number") : [];
      const runs = msg.includes("RUNS ") ? msg.slice(msg.indexOf("RUNS ") + 5).trim() : null;
      rows.set(k, merge(rows.get(k), { key: k, symbol, tf, side: a.side, closed_at: new Date(env.time * 1000).toISOString(), result: closeResult(msg),
        best_run: null, runs, entry: limits.length ? limits.join(", ") : null, stop_loss: fmt(a.sl), take_profit: tps.length ? tps.join(" / ") : null, from_history: false }));
    }
  }

  // merge with what is stored already (an older sync may hold the history or the entry of the same trade)
  const keys = [...rows.keys()];
  for (let i = 0; i < keys.length; i += 200) {
    const { data, error } = await db.from("tv_trades").select("key, symbol, tf, side, closed_at, result, best_run, runs, entry, stop_loss, take_profit, from_history").in("key", keys.slice(i, i + 200));
    if (error) return Response.json({ error: error.message }, { status: 500 });
    for (const old of (data ?? []) as Row[]) rows.set(old.key, merge(old, rows.get(old.key)!));
  }
  const list = [...rows.values()];
  for (let i = 0; i < list.length; i += 500) {
    const { error } = await db.from("tv_trades").upsert(list.slice(i, i + 500), { onConflict: "key" });
    if (error) return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ ok: true, trades: list.length });
}

export const GET = sync;
export const POST = sync;
