"use client";

import { useEffect, useMemo, useState } from "react";
import SiteNav from "../site-nav";
import { supabase } from "../supabase";

type Result = "target" | "be" | "worked" | "fail";
type TvTrade = { key: string; symbol: string; tf: string; side: "buy" | "sell"; closedAt: string; result: Result; bestRun: number | null; runs: string; entry: string; stopLoss: string };

const RESULT_LABELS: Record<Result, string> = { target: "TARGET", be: "BE after TP", worked: "WORKED then SL", fail: "FAIL (SL)" };
const RESULT_TONE: Record<Result, string> = { target: "gain", be: "open", worked: "be", fail: "loss" };
const DAY_OPTIONS = [{ value: 1, label: "Today" }, { value: 7, label: "7 days" }, { value: 31, label: "Last month" }];

/** Pine timeframe -> label: "5" -> M5, "60" -> H1, "D" -> D */
const tfLabel = (tf: string) => /^\d+$/.test(tf) ? (Number(tf) % 60 === 0 ? `H${Number(tf) / 60}` : `M${tf}`) : tf;
const tfMinutes = (tf: string) => /^\d+$/.test(tf) ? Number(tf) : 100000;
const closedText = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

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
        bestRun: row.best_run == null ? null : Number(row.best_run), runs: row.runs ? String(row.runs) : "", entry: row.entry ? String(row.entry) : "", stopLoss: row.stop_loss ? String(row.stop_loss) : "",
      })));
      setLoading(false);
    }
    load();
  }, []);

  const symbols = useMemo(() => [...new Set(trades.map((t) => t.symbol))].sort(), [trades]);
  const tfs = useMemo(() => [...new Set(trades.filter((t) => symbol === "all" || t.symbol === symbol).map((t) => t.tf))].sort((a, b) => tfMinutes(a) - tfMinutes(b)), [trades, symbol]);
  const shown = useMemo(() => {
    const from = days === 1 ? new Date(new Date().setHours(0, 0, 0, 0)).getTime() : Date.now() - days * 86400000;
    return trades.filter((t) => (symbol === "all" || t.symbol === symbol) && (tf === "all" || t.tf === tf) && new Date(t.closedAt).getTime() >= from);
  }, [trades, symbol, tf, days]);
  const count = (r: Result) => shown.filter((t) => t.result === r).length;
  const wins = count("target") + count("be");
  const runs = shown.filter((t) => t.result !== "fail" && t.result !== "worked" && t.bestRun != null);
  const avgRun = runs.length ? runs.reduce((sum, t) => sum + (t.bestRun ?? 0), 0) / runs.length : null;

  return <main className="dark-theme">
    <SiteNav />
    <section className="hero"><div className="hero-copy"><p className="eyebrow">TRADINGVIEW</p>
      <h1>TradingView <span>History</span></h1><p className="subhead">Every trade the TradingView OB Touch &amp; Go script closed in the last month.</p></div></section>

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
      <article><span>Avg best run (wins)</span><strong>{avgRun == null ? "—" : `+${avgRun.toFixed(1)}p`}</strong></article>
    </section>

    {error && <p className="notice">{error}</p>}
    <section className="table-card">
      <div className="table-title"><h2>Closed trades</h2><span>{loading ? "Loading…" : `${shown.length} trade${shown.length === 1 ? "" : "s"}`}</span></div>
      <div className="table-wrap"><table className="entries-table tv-table"><thead><tr><th>Closed</th><th>Symbol</th><th>TF</th><th>Side</th><th>Result</th><th>Runs (pips from each entry)</th><th>Best run</th><th>Entry / SL</th></tr></thead>
        <tbody>{shown.length === 0 ? <tr><td className="empty" colSpan={8}>{loading ? "Loading…" : "No TradingView trades in this period yet."}</td></tr> : shown.map((t) => <tr key={t.key}>
          <td>{closedText(t.closedAt)}</td>
          <td><b>{t.symbol}</b></td>
          <td>{tfLabel(t.tf)}</td>
          <td><span className={`pill ${t.side === "buy" ? "gain" : "loss"}`}>{t.side === "buy" ? "BUY" : "SELL"}</span></td>
          <td><span className={`pill ${RESULT_TONE[t.result]}`}>{RESULT_LABELS[t.result]}</span></td>
          <td className="tv-runs">{t.runs || "—"}</td>
          <td className={t.bestRun == null ? "" : t.bestRun > 0 ? "positive" : ""}>{t.bestRun == null ? "—" : <b>{t.bestRun > 0 ? "+" : ""}{t.bestRun}p</b>}</td>
          <td>{t.entry ? <><b>{t.entry}</b>{t.stopLoss && <span className="entry-sub negative">SL {t.stopLoss}</span>}</> : "—"}</td>
        </tr>)}</tbody></table></div>
    </section>
  </main>;
}
