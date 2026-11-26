"use client";

import { useEffect, useMemo, useState } from "react";
import SiteNav from "../site-nav";
import { supabase } from "../supabase";

type Result = "target" | "be" | "worked" | "fail";
type TvTrade = { key: string; symbol: string; tf: string; side: "buy" | "sell"; closedAt: string; result: Result; bestRun: number | null; runs: string; limits: string[]; stopLoss: string; takeProfit: string; tpHit: number | null; filled: number | null; maxMove: number | null; maxAgainst: number | null };

const RESULT_LABELS: Record<Result, string> = { target: "TARGET", be: "BE after TP", worked: "WORKED then SL", fail: "FAIL (SL)" };
const RESULT_TONE: Record<Result, string> = { target: "gain", be: "open", worked: "be", fail: "loss" };
const DAY_OPTIONS = [{ value: 1, label: "Today" }, { value: 7, label: "7 days" }, { value: 31, label: "Last month" }];

/** Pine timeframe -> label: "5" -> M5, "60" -> H1, "D" -> D */
const tfLabel = (tf: string) => /^\d+$/.test(tf) ? (Number(tf) % 60 === 0 ? `H${Number(tf) / 60}` : `M${tf}`) : tf;
const tfMinutes = (tf: string) => /^\d+$/.test(tf) ? Number(tf) : 100000;
// Lots per entry (1 lot in total), like the MT5 EA: E1 orders -> TP1, E2 -> TP2, E3 -> TP3, E4 -> TP4 (TP list capped at 4)
const LOTS = [0.5, 0.3, 0.1, 0.1];
const BE_PIPS = 10;                // TP1 hit -> the rest closes at E1 + 10 pips (later TPs: one TP behind)
const spec = (symbol: string) => /XAU|GOLD/.test(symbol) ? { pip: 0.1, contract: 100 } : /BTC/.test(symbol) ? { pip: 1, contract: 1 } : { pip: 0.0001, contract: 100000 };
const usd = (v: number) => `${v < 0 ? "-" : "+"}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Profit of a TradingView trade with the lots above, and (SL trades) the highest open profit it had before the SL. */
/** Entries filled (1..4): stored count, else the deepest entry in the runs. */
function filledOf(t: TvTrade) {
  const lv = [...t.runs.matchAll(/E(\d)/g)].map((m) => Number(m[1]));
  return Math.max(1, Math.min(4, t.filled ?? (lv.length ? Math.max(...lv) : 1)));
}

/** The trade's max move: its biggest entry run (e.g. "E2 +176.8p"), and the profit of all entries open then (E1..that entry). */
function maxMove(t: TvTrade): { pips: number; lvl: number; usd: number } | null {
  const lims = t.limits.map(Number);
  const { pip, contract } = spec(t.symbol), dir = t.side === "buy" ? 1 : -1;
  let best: { pips: number; lvl: number; usd: number } | null = null;
  for (const m of t.runs.matchAll(/E(\d)\s*([+-]?\d+(?:\.\d+)?)p/g)) {
    const lvl = Number(m[1]), pips = Number(m[2]);
    if (lvl < 1 || !Number.isFinite(lims[lvl - 1]) || (best && pips <= best.pips)) continue;
    const price = lims[lvl - 1] + dir * pips * pip;
    let usdSum = 0;
    for (let L = 0; L < lvl; L++) if (Number.isFinite(lims[L])) usdSum += LOTS[L] * (price - lims[L]) * dir * contract;
    best = { pips, lvl, usd: usdSum };
  }
  return best;
}

/** Max move AGAINST the trade after its last fill (e.g. E2 filled, price went 38.5 pips below E2), and the open loss of E1..En then. */
function against(t: TvTrade, n: number): { pips: number; usd: number } | null {
  const lims = t.limits.map(Number);
  if (t.maxAgainst == null || !Number.isFinite(lims[n - 1])) return null;
  const { pip, contract } = spec(t.symbol), dir = t.side === "buy" ? 1 : -1;
  const price = lims[n - 1] - dir * t.maxAgainst * pip;
  let sum = 0;
  for (let L = 0; L < n; L++) if (Number.isFinite(lims[L])) sum += LOTS[L] * (price - lims[L]) * dir * contract;
  return { pips: t.maxAgainst, usd: sum };
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

// always Pakistan time (PKT, UTC+5), whatever the viewer's computer is set to
const closedText = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Karachi" }) + " PKT";

export default function TvHistoryPage() {
  const [trades, setTrades] = useState<TvTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [symbol, setSymbol] = useState("all");
  const [tf, setTf] = useState("all");
  const [days, setDays] = useState(31);

  useEffect(() => { document.body.dataset.theme = "dark"; }, []);

  useEffect(() => {
    async function load() {
      // pull the newest TradingView alerts from the bridge first (does not block the page if it fails)
      await fetch("/api/tv-sync", { method: "POST" }).catch(() => undefined);
      const from = new Date(Date.now() - 31 * 86400000).toISOString();
      const { data, error: loadError } = await supabase.from("tv_trades").select("*").gte("closed_at", from).order("closed_at", { ascending: false }).limit(2000);
      if (loadError) setError("Could not load the TradingView history.");
      setTrades((data ?? []).map((row) => ({
        key: String(row.key), symbol: String(row.symbol), tf: String(row.tf), side: row.side === "sell" ? "sell" : "buy", closedAt: String(row.closed_at),
        result: (["target", "be", "worked", "fail"].includes(row.result) ? row.result : "fail") as Result,
        bestRun: row.best_run == null ? null : Number(row.best_run), runs: row.runs ? String(row.runs) : "", limits: row.entry ? String(row.entry).split(/\s*,\s*/) : [], stopLoss: row.stop_loss ? String(row.stop_loss) : "",
        takeProfit: row.take_profit ? String(row.take_profit) : "", tpHit: row.tp_hit == null ? null : Number(row.tp_hit), filled: row.filled == null ? null : Number(row.filled), maxMove: row.max_move == null ? null : Number(row.max_move), maxAgainst: row.max_against == null ? null : Number(row.max_against),
      })));
      setLoading(false);
    }
    load();
  }, []);

  const symbols = useMemo(() => [...new Set(trades.map((t) => t.symbol))].sort(), [trades]);
  const tfs = useMemo(() => [...new Set(trades.filter((t) => symbol === "all" || t.symbol === symbol).map((t) => t.tf))].sort((a, b) => tfMinutes(a) - tfMinutes(b)), [trades, symbol]);
  const shown = useMemo(() => {
    const from = days === 1 ? Math.floor((Date.now() + 5 * 3600000) / 86400000) * 86400000 - 5 * 3600000 : Date.now() - days * 86400000;   // "Today" = since midnight Pakistan time
    return trades.filter((t) => (symbol === "all" || t.symbol === symbol) && (tf === "all" || t.tf === tf) && new Date(t.closedAt).getTime() >= from);
  }, [trades, symbol, tf, days]);
  const count = (r: Result) => shown.filter((t) => t.result === r).length;
  const wins = count("target") + count("be");
  const winMoves = shown.filter((t) => t.result === "target" || t.result === "be").map((t) => maxMove(t)?.pips).filter((v): v is number => v != null);
  const moneyOf = useMemo(() => new Map(shown.map((t) => [t.key, money(t)])), [shown]);
  const totalPl = shown.reduce((sum, t) => sum + (moneyOf.get(t.key)?.pl ?? 0), 0);
  const avgRun = winMoves.length ? winMoves.reduce((sum, v) => sum + v, 0) / winMoves.length : null;

  return <main className="dark-theme">
    <SiteNav />
    <section className="hero"><div className="hero-copy"><p className="eyebrow">TRADINGVIEW</p>
      <h1>TradingView <span>History</span></h1><p className="subhead">Every trade the TradingView OB Touch &amp; Go script closed in the last month. P/L with 1 lot: E1 0.5 · E2 0.3 · E3 0.1 · E4 0.1 (E1 → TP1, E2 → TP2, E3 → TP3, E4 → TP4).</p></div></section>

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
    </section>

    <section className="stats tv-stats" aria-label="TradingView results">
      <article><span>Trades</span><strong>{shown.length}</strong></article>
      <article><span>Target</span><strong className="positive">{count("target")}</strong></article>
      <article><span>BE after TP</span><strong>{count("be")}</strong></article>
      <article><span>Worked then SL</span><strong>{count("worked")}</strong></article>
      <article><span>Fail (SL)</span><strong className="negative">{count("fail")}</strong></article>
      <article><span>Win rate</span><strong>{shown.length ? `${Math.round((wins / shown.length) * 100)}%` : "—"}</strong></article>
      <article><span>Total P/L (1 lot)</span><strong className={totalPl > 0 ? "positive" : totalPl < 0 ? "negative" : ""}>{shown.length ? usd(totalPl) : "—"}</strong></article>
      <article><span>Avg max move (wins)</span><strong>{avgRun == null ? "—" : `+${avgRun.toFixed(1)}p`}</strong></article>
    </section>

    {error && <p className="notice">{error}</p>}
    <section className="table-card">
      <div className="table-title"><h2>Closed trades</h2><span>{loading ? "Loading…" : `${shown.length} trade${shown.length === 1 ? "" : "s"}`}</span></div>
      <div className="table-wrap"><table className="entries-table tv-table"><thead><tr><th>Closed (Pakistan time) / Chart</th><th>Side / Result</th><th>Entries (✓ filled) / SL</th><th>Take Profit</th><th>P/L (1 lot)</th><th>Max Move / Profit</th><th>Max Against (after last entry)</th><th>Max Profit before SL</th><th>Runs (pips per entry)</th></tr></thead>
        <tbody>{shown.length === 0 ? <tr><td className="empty" colSpan={9}>{loading ? "Loading…" : "No TradingView trades in this period yet."}</td></tr> : shown.map((t) => {
          const n = filledOf(t), m = moneyOf.get(t.key), mv = maxMove(t), ag = against(t, n);
          return <tr key={t.key}>
            <td><b>{closedText(t.closedAt)}</b><span className="entry-sub">{t.symbol} · {tfLabel(t.tf)}</span></td>
            <td><span className={`pill ${t.side === "buy" ? "gain" : "loss"}`}>{t.side === "buy" ? "BUY" : "SELL"}</span><span className="cell-stack"><span className={`pill ${RESULT_TONE[t.result]}`}>{RESULT_LABELS[t.result]}</span></span></td>
            <td className="tv-levels"><span className="pill tv-active">{n === 1 ? "E1" : `E1–E${n}`} active ({n}/4)</span>
              {[0, 1, 2, 3].map((k) => t.limits[k] ? <span key={k} className={`entry-sub ${k < n ? "tv-lvl-on" : "tv-lvl-off"}`}>{k < n ? "✓" : "·"} E{k + 1} {t.limits[k]}</span> : null)}
              {t.stopLoss && <span className="entry-sub negative">SL {t.stopLoss}</span>}</td>
            <td className={`tv-tps ${t.takeProfit ? "positive" : ""}`}>{t.takeProfit ? t.takeProfit.split(/\s*\/\s*/).map((tp, k) => <span key={k} className="entry-sub">TP{k + 1} {tp}</span>) : "—"}</td>
            <td className={m?.pl == null ? "" : m.pl > 0 ? "positive" : m.pl < 0 ? "negative" : ""}>{m?.pl == null ? "—" : <b>{usd(m.pl)}</b>}</td>
            <td className={mv && mv.pips > 0 ? "positive" : ""}>{mv == null ? "—" : <><b>{mv.pips >= 0 ? "+" : ""}{mv.pips}p</b> <span className="tv-from">from E{mv.lvl}</span><span className="entry-sub">E1{mv.lvl > 1 ? `–E${mv.lvl}` : ""} open: {usd(mv.usd)}</span></>}</td>
            <td className={ag && ag.pips > 0 ? "negative" : ""}>{ag == null ? "—" : <><b>-{ag.pips}p</b> <span className="tv-from">{t.side === "buy" ? "below" : "above"} E{n}</span><span className="entry-sub">E1{n > 1 ? `–E${n}` : ""} open: {usd(ag.usd)}</span></>}</td>
            <td className={m?.peak != null && m.peak > 0 ? "positive" : ""}>{m?.peak == null ? "—" : <b>{usd(m.peak)}</b>}</td>
            <td className="tv-runs">{t.runs || "—"}</td>
          </tr>;
        })}</tbody></table></div>
    </section>
  </main>;
}
