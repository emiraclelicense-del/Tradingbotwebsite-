"use client";

import { useEffect, useMemo, useState } from "react";
import SiteNav from "../site-nav";
import { supabase } from "../supabase";

type Result = "target" | "be" | "worked" | "fail";
type TvTrade = { key: string; symbol: string; tf: string; side: "buy" | "sell"; closedAt: string; result: Result; bestRun: number | null; runs: string; limits: string[]; stopLoss: string; takeProfit: string; tpHit: number | null; filled: number | null; maxMove: number | null; maxAgainst: number | null; trend: string | null; market: string | null; adx: number | null; afterSl: number | null; afterSlResult: string | null };

const RESULT_LABELS: Record<Result, string> = { target: "TARGET", be: "BE after TP", worked: "WORKED then SL", fail: "FAIL (SL)" };
const RESULT_TONE: Record<Result, string> = { target: "gain", be: "open", worked: "be", fail: "loss" };
const DAY_OPTIONS = [{ value: 1, label: "Today" }, { value: 7, label: "7 days" }, { value: 31, label: "Last month" }];

/** Pine timeframe -> label: "5" -> M5, "60" -> H1, "D" -> D */
const tfLabel = (tf: string) => /^\d+$/.test(tf) ? (Number(tf) % 60 === 0 ? `H${Number(tf) / 60}` : `M${tf}`) : tf;
const tfMinutes = (tf: string) => /^\d+$/.test(tf) ? Number(tf) : 100000;
// Lots per entry for 1 lot in total (E1 5 x 0.1, E2 3 x 0.1, E3 0.1, E4 0.1); the page can show 2 lots (x2 = the EA now:
// E1 5 x 0.2, E2 3 x 0.2, E3 0.2, E4 0.2). E1 orders -> TP1, E2 -> TP2, E3 -> TP3, E4 -> TP4 (TP list capped at 4)
const LOTS = [0.5, 0.3, 0.1, 0.1];
const BE_PIPS = 10;                // TP1 hit -> the rest closes at E1 + 10 pips (later TPs: one TP behind)
const spec = (symbol: string) => /XAU|GOLD/.test(symbol) ? { pip: 0.1, contract: 100 } : /BTC/.test(symbol) ? { pip: 1, contract: 1 } : { pip: 0.0001, contract: 100000 };
// a price with the decimals of its symbol (gold 2, BTC 1, forex 5)
const priceText = (symbol: string, v: number) => v.toFixed(spec(symbol).pip >= 1 ? 1 : spec(symbol).pip >= 0.1 ? 2 : 5);
const usd = (v: number) => `${v < 0 ? "-" : "+"}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Profit of a TradingView trade with the lots above, and (SL trades) the highest open profit it had before the SL. */
/** Entries filled (1..4): stored count, else the deepest entry in the runs. */
function filledOf(t: TvTrade) {
  const lv = [...t.runs.matchAll(/E(\d)/g)].map((m) => Number(m[1]));
  return Math.max(1, Math.min(4, t.filled ?? (lv.length ? Math.max(...lv) : 1)));
}

/** The trade's max move: the entry run with the MOST total profit of the entries open then (E1..that entry), e.g. "E2 +176.8p".
 *  (E1 +0.0p beats E4 +10.2p when E1-E4 open at that E4 peak are still in loss.) */
function maxMove(t: TvTrade): { pips: number; lvl: number; usd: number; price: number } | null {
  const lims = t.limits.map(Number);
  const { pip, contract } = spec(t.symbol), dir = t.side === "buy" ? 1 : -1;
  let best: { pips: number; lvl: number; usd: number; price: number } | null = null;
  for (const m of t.runs.matchAll(/E(\d)\s*([+-]?\d+(?:\.\d+)?)p/g)) {
    const lvl = Number(m[1]), pips = Number(m[2]);
    if (lvl < 1 || !Number.isFinite(lims[lvl - 1])) continue;
    const price = lims[lvl - 1] + dir * pips * pip;
    let usdSum = 0;
    for (let L = 0; L < lvl; L++) if (Number.isFinite(lims[L])) usdSum += LOTS[L] * (price - lims[L]) * dir * contract;
    if (!best || usdSum > best.usd || (usdSum === best.usd && pips > best.pips)) best = { pips, lvl, usd: usdSum, price };
  }
  return best;
}

/** Max move AGAINST the trade after its last fill (e.g. E2 filled, price went 38.5 pips below E2), and the open loss of E1..En then. */
function against(t: TvTrade, n: number): { pips: number; usd: number; price: number } | null {
  const lims = t.limits.map(Number);
  if (t.maxAgainst == null || !Number.isFinite(lims[n - 1])) return null;
  const { pip, contract } = spec(t.symbol), dir = t.side === "buy" ? 1 : -1;
  const price = lims[n - 1] - dir * t.maxAgainst * pip;
  let sum = 0;
  for (let L = 0; L < n; L++) if (Number.isFinite(lims[L])) sum += LOTS[L] * (price - lims[L]) * dir * contract;
  return { pips: t.maxAgainst, usd: sum, price };
}

function money(t: TvTrade): { pl: number | null; peak: number | null } {
  const lims = t.limits.map(Number), tps = t.takeProfit ? t.takeProfit.split(/\s*\/\s*/).map(Number).slice(0, 4) : [], sl = Number(t.stopLoss);
  if (lims.length < 1 || lims.some((v) => !Number.isFinite(v))) return { pl: null, peak: null };
  const { pip, contract } = spec(t.symbol), dir = t.side === "buy" ? 1 : -1;
  const runs = [...t.runs.matchAll(/E(\d)\s*([+-]?\d+(?:\.\d+)?)p/g)].map((m) => ({ lvl: Number(m[1]), run: Number(m[2]) }));
  const n = Math.min(lims.length, filledOf(t));
  const ntp = tps.length;
  const value = (L: number, exit: number) => LOTS[L] * (exit - lims[L]) * dir * contract;
  let pl: number | null = 0;
  if (t.result === "fail" || t.result === "worked") {
    if (!Number.isFinite(sl)) pl = null; else for (let L = 0; L < n; L++) pl += value(L, sl);
  } else if (!ntp) pl = null;
  else {
    const k = t.result === "target" ? ntp : Math.min(ntp, t.tpHit ?? 1);
    const lock = lims[0] + dir * BE_PIPS * pip;
    let be = k >= 2 ? tps[k - 2] : lock;
    if ((lock - be) * dir > 0) be = lock;
    for (let L = 0; L < n; L++) { const ti = Math.min(L, ntp - 1); pl += value(L, ti < k ? tps[ti] : be); }
  }
  // SL trades: best moment = the best run of each entry stage, with E1..Ek open
  let peak: number | null = null;
  if (t.result === "fail" || t.result === "worked")
    for (const { lvl, run } of runs) {
      if (lvl < 1 || lvl > lims.length) continue;
      const price = lims[lvl - 1] + dir * run * pip;
      let open = 0;
      for (let L = 0; L < lvl; L++) open += value(L, price);
      if (peak == null || open > peak) peak = open;
    }
  return { pl, peak };
}

/** The same setup on the live MT5 account (Trade History): EA key "<account>_<magic>_<M10>_<OB id>_<setup>" <-> TradingView "XAUUSD|10|<OB id>". */
type LiveTrade = { tf: string; obId: string; account: string; result: string; pips: number | null; usd: number | null; trend: string | null };
const liveKey = (tf: string, obId: string) => `${tf}|${obId}`;
const LIVE_RESULT: Record<string, string> = { tp: "TP", sl: "SL", be: "BE", open: "Running" };

// always Pakistan time (PKT, UTC+5), whatever the viewer's computer is set to
// Forex sessions (of the candle the trade closed on), with the US / UK summer time:
//   New York 13:00-22:00 GMT = 6 PM-3 AM Pakistan (US summer time, mid-March .. early November: 5 PM-2 AM)
//   London   08:00 GMT (UK summer time 07:00) until New York opens = 1 PM-6 PM Pakistan
//   Asian    the rest (after New York closes until London opens)
type Session = "asian" | "london" | "newyork";
const SESSION_LABELS: Record<Session, string> = { asian: "Asian", london: "London", newyork: "New York" };
const nthSunday = (y: number, m: number, from: number) => { const d = new Date(Date.UTC(y, m, from)); d.setUTCDate(from + ((7 - d.getUTCDay()) % 7)); return d; };
const lastSunday = (y: number, m: number) => { const d = new Date(Date.UTC(y, m + 1, 0)); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d; };
// US: 2nd Sunday of March 07:00 GMT .. 1st Sunday of November 06:00 GMT; UK: last Sunday of March .. last Sunday of October, 01:00 GMT
const usSummer = (d: Date) => { const y = d.getUTCFullYear(); const a = nthSunday(y, 2, 8), b = nthSunday(y, 10, 1); a.setUTCHours(7); b.setUTCHours(6); return d >= a && d < b; };
const ukSummer = (d: Date) => { const y = d.getUTCFullYear(); const a = lastSunday(y, 2), b = lastSunday(y, 9); a.setUTCHours(1); b.setUTCHours(1); return d >= a && d < b; };
const sessionHours = (d: Date) => { const ny = usSummer(d) ? 12 : 13; return { ny, nyEnd: ny + 9, london: ukSummer(d) ? 7 : 8 }; };
const sessionOf = (iso: string): Session => {
  const d = new Date(iso), h = d.getUTCHours() + d.getUTCMinutes() / 60, s = sessionHours(d);
  return h >= s.ny && h < s.nyEnd ? "newyork" : h >= s.london && h < s.ny ? "london" : "asian";
};
const pkt = (gmt: number) => { const h = ((gmt + 5) % 24 + 24) % 24; return `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`; };
const sessionRange = (v: Session) => { const s = sessionHours(new Date()); return v === "newyork" ? `${pkt(s.ny)}–${pkt(s.nyEnd)}` : v === "london" ? `${pkt(s.london)}–${pkt(s.ny)}` : `${pkt(s.nyEnd)}–${pkt(s.london)}`; };
const closedText = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Karachi" }) + " PKT";

/** flux = the Flux OB script (tv_trades keys "FLUX|..."), else the LuxAlgo Touch & Go script. */
export default function TvHistoryView({ flux = false }: { flux?: boolean }) {
  const [trades, setTrades] = useState<TvTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [symbol, setSymbol] = useState("all");
  const [tf, setTf] = useState("all");
  const [days, setDays] = useState(31);
  const [session, setSession] = useState<"all" | Session>("all");
  const [market, setMarket] = useState<"all" | "bullish" | "bearish" | "ranging">("all");
  // result filter: "sl" = every trade that ended on its SL (FAIL + WORKED then SL)
  const [res, setRes] = useState<"all" | "target" | "be" | "sl">("all");
  const [trendF, setTrendF] = useState<"all" | "with" | "against">("all");
  const lotN = 1;                 // USD figures in 1 lot; the P/L also in 2 lots (x2) next to it
  const LOT_TOTAL = "1 lot";
  const [live, setLive] = useState<Map<string, LiveTrade[]>>(new Map());

  useEffect(() => { document.body.dataset.theme = "dark"; }, []);

  useEffect(() => {
    let alive = true;
    async function load() {
      const from = new Date(Date.now() - 31 * 86400000).toISOString();
      const base = supabase.from("tv_trades").select("*").gte("closed_at", from);
      const { data, error: loadError } = await (flux ? base.like("key", "FLUX|%") : base.not("key", "like", "FLUX|%")).order("closed_at", { ascending: false }).limit(2000);
      if (!alive) return;
      if (loadError) setError("Could not load the TradingView history.");
      // the live account trades of the same period (MT5 EA -> Trade History), matched by chart + order block
      const { data: eaRows } = flux ? { data: [] } : await supabase.from("trade_entries").select("ea_key, bot_name, result, pips, profit_usd, trend").not("ea_key", "is", null).gte("created_at", new Date(Date.now() - 33 * 86400000).toISOString()).limit(2000);
      const byKey = new Map<string, LiveTrade[]>();
      for (const r of eaRows ?? []) {
        const parts = String(r.ea_key).split("_"), m = /^M(\d+)$/.exec(parts[2] ?? "");
        if (parts.length < 5 || !m) continue;
        const lt: LiveTrade = { tf: m[1], obId: parts[3], account: String(r.bot_name ?? parts[0]).replace(/^.*\((.*)\)$/, "$1"), result: String(r.result), pips: r.pips == null ? null : Number(r.pips), usd: r.profit_usd == null ? null : Number(r.profit_usd), trend: r.trend ? String(r.trend) : null };
        const k = liveKey(lt.tf, lt.obId);
        byKey.set(k, [...(byKey.get(k) ?? []), lt]);
      }
      if (!alive) return;
      setLive(byKey);
      setTrades((data ?? []).map((row) => ({
        key: String(row.key), symbol: String(row.symbol), tf: String(row.tf), side: row.side === "sell" ? "sell" : "buy", closedAt: String(row.closed_at),
        result: (["target", "be", "worked", "fail"].includes(row.result) ? row.result : "fail") as Result,
        bestRun: row.best_run == null ? null : Number(row.best_run), runs: row.runs ? String(row.runs) : "", limits: row.entry ? String(row.entry).split(/\s*,\s*/) : [], stopLoss: row.stop_loss ? String(row.stop_loss) : "",
        takeProfit: row.take_profit ? String(row.take_profit) : "", tpHit: row.tp_hit == null ? null : Number(row.tp_hit), filled: row.filled == null ? null : Number(row.filled), maxMove: row.max_move == null ? null : Number(row.max_move), maxAgainst: row.max_against == null ? null : Number(row.max_against), trend: row.trend ? String(row.trend) : null, market: row.market ? String(row.market) : null, adx: row.adx == null ? null : Number(row.adx), afterSl: row.after_sl == null ? null : Number(row.after_sl), afterSlResult: row.after_sl_result ? String(row.after_sl_result) : null,
      })));
      setLoading(false);
    }
    // show what is stored at once, then pull the newest TradingView alerts from the bridge (a few seconds) and refresh
    load().then(() => fetch("/api/tv-sync", { method: "POST" })).catch(() => undefined).then(() => (alive ? load() : undefined));
    return () => { alive = false; };
  }, [flux]);

  const symbols = useMemo(() => [...new Set(trades.map((t) => t.symbol))].sort(), [trades]);
  const tfs = useMemo(() => [...new Set(trades.filter((t) => symbol === "all" || t.symbol === symbol).map((t) => t.tf))].sort((a, b) => tfMinutes(a) - tfMinutes(b)), [trades, symbol]);
  const shown = useMemo(() => {
    const from = days === 1 ? Math.floor((Date.now() + 5 * 3600000) / 86400000) * 86400000 - 5 * 3600000 : Date.now() - days * 86400000;   // "Today" = since midnight Pakistan time
    return trades.filter((t) => (symbol === "all" || t.symbol === symbol) && (tf === "all" || t.tf === tf) && (session === "all" || sessionOf(t.closedAt) === session) && (market === "all" || t.market === market) && (res === "all" || (res === "sl" ? t.result === "fail" || t.result === "worked" : t.result === res)) && (trendF === "all" || t.trend === trendF) && new Date(t.closedAt).getTime() >= from);
  }, [trades, symbol, tf, days, session, market, res, trendF]);
  const count = (r: Result) => shown.filter((t) => t.result === r).length;
  const wins = count("target") + count("be");
  const winMoves = shown.filter((t) => t.result === "target" || t.result === "be").map((t) => maxMove(t)?.pips).filter((v): v is number => v != null);
  const moneyOf = useMemo(() => new Map(shown.map((t) => { const m = money(t); return [t.key, { pl: m.pl == null ? null : m.pl * lotN, peak: m.peak == null ? null : m.peak * lotN }]; })), [shown, lotN]);
  const totalPl = shown.reduce((sum, t) => sum + (moneyOf.get(t.key)?.pl ?? 0), 0);
  const liveOf = (t: TvTrade) => /XAU|GOLD/.test(t.symbol) ? live.get(liveKey(t.tf, t.key.split("|").pop() ?? "")) ?? [] : [];
  const liveShown = shown.flatMap(liveOf);
  const liveTotal = liveShown.reduce((sum, l) => sum + (l.usd ?? 0), 0);
  const avgRun = winMoves.length ? winMoves.reduce((sum, v) => sum + v, 0) / winMoves.length : null;

  // the trades now shown (all filters) as an Excel file (.xlsx); exceljs is loaded only when the button is clicked
  async function exportExcel() {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    // sheet 1: the summary boxes of the page + the filters used
    const sum = wb.addWorksheet("Summary");
    sum.columns = [{ width: 28 }, { width: 22 }];
    const dayLabel = DAY_OPTIONS.find((d) => d.value === days)?.label ?? `${days} days`;
    const rows: [string, string | number][] = [
      [flux ? "Flux OB History" : "TradingView History", `exported ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Karachi" })} PKT`],
      ["", ""],
      ["Filters", ""],
      ["Symbol", symbol === "all" ? "All" : symbol], ["Timeframe", tf === "all" ? "All" : tfLabel(tf)], ["Time", dayLabel],
      ["Session", session === "all" ? "All" : SESSION_LABELS[session]], ["Market", market === "all" ? "All" : market[0].toUpperCase() + market.slice(1)],
      ["Result", res === "all" ? "All" : res === "sl" ? "SL hit" : RESULT_LABELS[res]], ["Trend", trendF === "all" ? "All" : trendF === "with" ? "With trend" : "Against trend"],
      ["", ""],
      ["Results", ""],
      ["Trades", shown.length], ["Target", count("target")], ["BE after TP", count("be")], ["Worked then SL", count("worked")], ["Fail (SL)", count("fail")],
      ["Win rate", shown.length ? `${Math.round((wins / shown.length) * 100)}%` : "—"],
      ["Total P/L (1 lot, USD)", shown.length ? Math.round(totalPl * 100) / 100 : "—"], ["Total P/L (2 lots, USD)", shown.length ? Math.round(totalPl * 200) / 100 : "—"],
      [`Live account P/L (${liveShown.length} trades, USD)`, liveShown.length ? Math.round(liveTotal * 100) / 100 : "—"],
      ["Avg max move (wins)", avgRun == null ? "—" : `+${avgRun.toFixed(1)}p`],
    ];
    for (const r of rows) sum.addRow(r);
    sum.getRow(1).font = { bold: true, size: 14 };
    for (const r of [3, 12]) sum.getRow(r).font = { bold: true, color: { argb: "FF1B7F4B" } };
    for (const r of [19, 20, 21]) { const c = sum.getRow(r).getCell(2); if (typeof c.value === "number") { c.numFmt = "#,##0.00"; c.font = { bold: true, color: { argb: c.value >= 0 ? "FF1B7F4B" : "FFC0392B" } }; } }
    const ws = wb.addWorksheet(flux ? "Flux OB History" : "TradingView History", { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = [
      ["Closed (PKT)", 18], ["Symbol", 9], ["Chart", 7], ["Session", 10], ["Side", 6], ["Result", 15], ["Trend", 9], ["Market", 9], ["H1 ADX", 8],
      ["Entries filled", 9], ["E1", 10], ["E2", 10], ["E3", 10], ["E4", 10], ["SL", 10], ["Take profit", 34], ["TPs hit", 7],
      ["P/L 1 lot (USD)", 13], ["P/L 2 lots (USD)", 13], ["Live account P/L (USD)", 14], ["Max move (pips)", 11], ["Max move from", 9], ["Max move price", 12], ["Max move profit (USD)", 14],
      ["Max against (pips)", 11], ["Max against price", 12], ["After SL beyond E4 (pips)", 13], ["After SL: TP1 reached", 12], ["Max profit before SL (USD)", 15], ["Runs", 48],
    ].map(([header, width]) => ({ header: String(header), width: Number(width) }));
    const num = (v: string | undefined) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : v ?? "");
    for (const t of shown) {
      const n = filledOf(t), m = moneyOf.get(t.key), mv = maxMove(t), ag = against(t, n), lv = liveOf(t);
      const trend = t.trend ?? (/against/i.test(lv.find((l) => l.trend)?.trend ?? "") ? "against" : lv.some((l) => l.trend) ? "with" : "");
      const row = ws.addRow([closedText(t.closedAt).replace(" PKT", ""), t.symbol, tfLabel(t.tf), SESSION_LABELS[sessionOf(t.closedAt)], t.side.toUpperCase(), RESULT_LABELS[t.result], trend, t.market ?? "", t.adx ?? "",
        n, num(t.limits[0]), num(t.limits[1]), num(t.limits[2]), num(t.limits[3]), num(t.stopLoss), t.takeProfit, t.tpHit ?? "",
        m?.pl == null ? "" : Math.round(m.pl * 100) / 100, m?.pl == null ? "" : Math.round(m.pl * 200) / 100, lv.length ? Math.round(lv.reduce((sum, l) => sum + (l.usd ?? 0), 0) * 100) / 100 : "",
        mv?.pips ?? "", mv ? `E${mv.lvl}` : "", mv ? Number(priceText(t.symbol, mv.price)) : "", mv ? Math.round(mv.usd * lotN * 100) / 100 : "",
        ag?.pips ?? "", ag ? Number(priceText(t.symbol, ag.price)) : "", t.afterSlResult === "over" ? "70+" : t.afterSl ?? "", t.afterSlResult === "tp1" ? "yes" : t.afterSlResult === "over" ? "no" : "", m?.peak == null ? "" : Math.round(m.peak * 100) / 100, t.runs]);
      for (const ci of [18, 19]) { const pl = row.getCell(ci); if (typeof pl.value === "number") pl.font = { color: { argb: pl.value >= 0 ? "FF1B7F4B" : "FFC0392B" } }; }
      row.getCell(6).font = { color: { argb: t.result === "fail" ? "FFC0392B" : t.result === "worked" ? "FFB9770E" : "FF1B7F4B" } };
    }
    for (const c of [18, 19, 20, 24, 29]) ws.getColumn(c).numFmt = "#,##0.00";
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: "FFFFFFFF" } };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF14382C" } };
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
    const blob = new Blob([await wb.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${flux ? "flux" : "tradingview"}-history-${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return <main className="dark-theme">
    <SiteNav />
    <section className="hero"><div className="hero-copy"><p className="eyebrow">{flux ? "TRADINGVIEW · FLUX OB" : "TRADINGVIEW"}</p>
      <h1>{flux ? <>Flux OB <span>History</span></> : <>TradingView <span>History</span></>}</h1><p className="subhead">{flux ? "Every trade the OB TouchGo Flux script (Flux Volumized order blocks only, not traded by the EA) closed in the last month." : "Every trade the TradingView OB Touch & Go script closed in the last month."} P/L with 1 lot: E1 0.5 (5 × 0.1) · E2 0.3 (3 × 0.1) · E3 0.1 · E4 0.1 — and with 2 lots: E1 1.0 (5 × 0.2) · E2 0.6 (3 × 0.2) · E3 0.2 · E4 0.2 (E1 → TP1, E2 → TP2, E3 → TP3, E4 → TP4).</p></div></section>

    <section className="history-filters" aria-label="TradingView history filters">
      <fieldset className="time-filter"><legend>Symbol</legend><div className="time-filter-buttons">
        {["all", ...symbols].map((s) => <button key={s} type="button" className={symbol === s ? "active" : ""} aria-pressed={symbol === s} onClick={() => { setSymbol(s); setTf("all"); }}>{s === "all" ? "All" : s}</button>)}
      </div></fieldset>
      <fieldset className="time-filter"><legend>Timeframe</legend><div className="time-filter-buttons">
        {["all", ...tfs].map((v) => <button key={v} type="button" className={tf === v ? "active" : ""} aria-pressed={tf === v} onClick={() => setTf(v)}>{v === "all" ? "All" : tfLabel(v)}</button>)}
      </div></fieldset>
      <fieldset className="time-filter"><legend>Time</legend><div className="time-filter-buttons">
        {DAY_OPTIONS.map(({ value, label }) => <button key={value} type="button" className={days === value ? "active" : ""} aria-pressed={days === value} onClick={() => setDays(value)}>{label}</button>)}
      </div></fieldset>
      <fieldset className="time-filter"><legend>Session</legend><div className="time-filter-buttons">
        {(["all", "asian", "london", "newyork"] as const).map((v) => <button key={v} type="button" className={session === v ? "active" : ""} aria-pressed={session === v} onClick={() => setSession(v)} title={v === "all" ? undefined : `${SESSION_LABELS[v]}: ${sessionRange(v)} Pakistan time`}>{v === "all" ? "All" : <>{SESSION_LABELS[v]}<span className="tv-range">{sessionRange(v)}</span></>}</button>)}
      </div></fieldset>
      <fieldset className="time-filter"><legend>Market</legend><div className="time-filter-buttons">
        {(["all", "bullish", "bearish", "ranging"] as const).map((v) => <button key={v} type="button" className={market === v ? "active" : ""} aria-pressed={market === v} onClick={() => setMarket(v)}>{v === "all" ? "All" : v[0].toUpperCase() + v.slice(1)}</button>)}
      </div></fieldset>
      <fieldset className="time-filter"><legend>Result</legend><div className="time-filter-buttons">
        {([["all", "All"], ["target", "Target"], ["be", "BE after TP"], ["sl", "SL hit"]] as const).map(([v, label]) => <button key={v} type="button" className={res === v ? "active" : ""} aria-pressed={res === v} onClick={() => setRes(v)}>{label}</button>)}
      </div></fieldset>
      <fieldset className="time-filter"><legend>Trend</legend><div className="time-filter-buttons">
        {([["all", "All"], ["with", "With trend"], ["against", "Against trend"]] as const).map(([v, label]) => <button key={v} type="button" className={trendF === v ? "active" : ""} aria-pressed={trendF === v} onClick={() => setTrendF(v)}>{label}</button>)}
      </div></fieldset>
    </section>

    <section className={`stats tv-stats${flux ? " tv-stats-8" : ""}`} aria-label="TradingView results">
      <article><span>Trades</span><strong>{shown.length}</strong></article>
      <article><span>Target</span><strong className="positive">{count("target")}</strong></article>
      <article><span>BE after TP</span><strong>{count("be")}</strong></article>
      <article><span>Worked then SL</span><strong>{count("worked")}</strong></article>
      <article><span>Fail (SL)</span><strong className="negative">{count("fail")}</strong></article>
      <article><span>Win rate</span><strong>{shown.length ? `${Math.round((wins / shown.length) * 100)}%` : "—"}</strong></article>
      <article><span>Total P/L (1 lot / 2 lots)</span><strong className={totalPl > 0 ? "positive" : totalPl < 0 ? "negative" : ""}>{shown.length ? usd(totalPl) : "—"}</strong>{shown.length > 0 && <small className={`tv-lot2 ${totalPl > 0 ? "positive" : totalPl < 0 ? "negative" : ""}`}>2 lots: {usd(totalPl * 2)}</small>}</article>
      {!flux && <article><span>Live account P/L ({liveShown.length} trades)</span><strong className={liveTotal > 0 ? "positive" : liveTotal < 0 ? "negative" : ""}>{liveShown.length ? usd(liveTotal) : "—"}</strong></article>}
      <article><span>Avg max move (wins)</span><strong>{avgRun == null ? "—" : `+${avgRun.toFixed(1)}p`}</strong></article>
    </section>

    {error && <p className="notice">{error}</p>}
    <section className="table-card">
      <div className="table-title"><h2>Closed trades</h2><span className="tv-title-right">{loading ? "Loading…" : `${shown.length} trade${shown.length === 1 ? "" : "s"}`}<button type="button" className="tv-export" disabled={!shown.length} onClick={() => { exportExcel().catch(() => setError("Could not make the Excel file.")); }}>Export Excel</button></span></div>
      <div className="table-wrap"><table className="entries-table tv-table"><thead><tr><th>Closed (Pakistan time) / Chart / Session</th><th>Side / Result / Trend / Market</th><th>Entries (✓ filled) / SL</th><th>Take Profit</th><th>P/L (1 lot)</th><th>P/L (2 lots)</th>{!flux && <th>Live account (MT5)</th>}<th>Max Move / Profit</th><th>Max Against (after last entry)</th><th>Max Profit before SL</th><th>Runs (pips per entry)</th></tr></thead>
        <tbody>{shown.length === 0 ? <tr><td className="empty" colSpan={flux ? 10 : 11}>{loading ? "Loading…" : "No TradingView trades in this period yet."}</td></tr> : shown.map((t) => {
          const n = filledOf(t), m = moneyOf.get(t.key), mv = maxMove(t), ag = against(t, n), lv = liveOf(t);
          const trend = t.trend ?? (/against/i.test(lv.find((l) => l.trend)?.trend ?? "") ? "against" : lv.some((l) => l.trend) ? "with" : null);
          const lvUsd = lv.reduce((sum, l) => sum + (l.usd ?? 0), 0);
          return <tr key={t.key}>
            <td><b>{closedText(t.closedAt)}</b><span className="entry-sub">{t.symbol} · {tfLabel(t.tf)}</span><span className="entry-sub tv-session">{SESSION_LABELS[sessionOf(t.closedAt)]} session</span></td>
            <td><span className={`pill ${t.side === "buy" ? "gain" : "loss"}`}>{t.side === "buy" ? "BUY" : "SELL"}</span><span className="cell-stack"><span className={`pill ${RESULT_TONE[t.result]}`}>{RESULT_LABELS[t.result]}</span></span>{trend && <span className={`entry-sub ${trend === "with" ? "positive" : "negative"}`}>{trend === "with" ? "With trend" : "Against trend"}</span>}{t.market && <span className={`entry-sub tv-mkt-${t.market}`}>{t.market === "bullish" ? "Bullish market" : t.market === "bearish" ? "Bearish market" : "Ranging market"}{t.adx != null && ` · ADX ${t.adx.toFixed(1)}`}</span>}</td>
            <td className="tv-levels"><span className="pill tv-active">{n === 1 ? "E1" : `E1–E${n}`} active ({n}/4)</span>
              {[0, 1, 2, 3].map((k) => t.limits[k] ? <span key={k} className={`entry-sub ${k < n ? "tv-lvl-on" : "tv-lvl-off"}`}>{k < n ? "✓" : "·"} E{k + 1} {t.limits[k]}</span> : null)}
              {t.stopLoss && <span className="entry-sub negative">SL {t.stopLoss}</span>}</td>
            <td className={`tv-tps ${t.takeProfit ? "positive" : ""}`}>{t.takeProfit ? t.takeProfit.split(/\s*\/\s*/).map((tp, k) => <span key={k} className="entry-sub">TP{k + 1} {tp}</span>) : "—"}</td>
            <td className={m?.pl == null ? "" : m.pl > 0 ? "positive" : m.pl < 0 ? "negative" : ""}>{m?.pl == null ? "—" : <b>{usd(m.pl)}</b>}</td>
            <td className={m?.pl == null ? "" : m.pl > 0 ? "positive" : m.pl < 0 ? "negative" : ""}>{m?.pl == null ? "—" : <b>{usd(m.pl * 2)}</b>}</td>
            {!flux && <td className={lv.length === 0 ? "" : lvUsd > 0 ? "positive" : lvUsd < 0 ? "negative" : ""}>{lv.length === 0 ? <span className="tv-from">not traded</span> : <><b>{usd(lvUsd)}</b>{lv.map((l, k) => <span key={k} className="entry-sub">{LIVE_RESULT[l.result] ?? l.result}{l.pips == null ? "" : ` ${l.pips > 0 ? "+" : ""}${l.pips}p`} · {l.account}</span>)}</>}</td>}
            <td className={mv && mv.pips > 0 ? "positive" : ""}>{mv == null ? "—" : <><b>{mv.pips >= 0 ? "+" : ""}{mv.pips}p</b> <span className="tv-from">from E{mv.lvl}</span><span className="entry-sub">Price {priceText(t.symbol, mv.price)}</span><span className="entry-sub">E1{mv.lvl > 1 ? `–E${mv.lvl}` : ""} open: {usd(mv.usd * lotN)}</span></>}</td>
            <td className={ag && ag.pips > 0 ? "negative" : ""}>{ag == null ? "—" : <><b>-{ag.pips}p</b> <span className="tv-from">{t.side === "buy" ? "below" : "above"} E{n}</span><span className="entry-sub">Price {priceText(t.symbol, ag.price)}{(() => { const sl = Number(t.stopLoss); const hit = (t.result === "fail" || t.result === "worked") && Number.isFinite(sl) && Math.abs(ag.price - sl) <= spec(t.symbol).pip * 0.6; return hit ? <b className="negative"> · SL hit</b> : <span className="positive"> · came back</span>; })()}</span><span className="entry-sub">E1{n > 1 ? `–E${n}` : ""} open: {usd(ag.usd * lotN)}</span>{t.afterSlResult && <span className={`entry-sub ${t.afterSlResult === "tp1" ? "positive" : "negative"}`}>After SL: {t.afterSlResult === "over" ? "70p+" : `-${t.afterSl}p`} beyond E4 · {t.afterSlResult === "tp1" ? "came back to TP1 ✓" : "no TP1 ✗"}</span>}</>}</td>
            <td className={m?.peak != null && m.peak > 0 ? "positive" : ""}>{m?.peak == null ? "—" : <b>{usd(m.peak)}</b>}</td>
            <td className="tv-runs">{t.runs || "—"}</td>
          </tr>;
        })}</tbody></table></div>
    </section>
  </main>;
}
