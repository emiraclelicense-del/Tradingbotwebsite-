"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@supabase/supabase-js";

type Result = { id: string; date: string; botName: string; trades: string; opening: number; closing: number; profit: number; loss: number; deposit: number; withdraw: number };

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);

export default function ResultListPage() {
  const { type } = useParams<{ type: string }>();
  const isWinning = type === "win";
  const title = isWinning ? "Winning results" : "Losing results";
  const [results, setResults] = useState<Result[]>([]);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState({ bot: "all", time: "all", start: "", end: "" });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setFilters({ bot: params.get("bot") ?? "all", time: params.get("time") ?? "all", start: params.get("start") ?? "", end: params.get("end") ?? "" });
  }, []);

  useEffect(() => {
    async function load() {
      const { data, error: loadError } = await supabase.from("trade_results").select("*").order("trade_date", { ascending: false });
      if (loadError) { setError("Could not load trade results."); return; }
      setResults((data ?? []).map((row) => ({ id: row.id, date: row.trade_date, botName: row.bot_name, trades: row.trades, opening: Number(row.opening), closing: Number(row.closing), profit: Number(row.profit), loss: Number(row.loss), deposit: Number(row.deposit), withdraw: Number(row.withdraw) })));
    }
    load();
  }, []);

  const matchingResults = useMemo(() => results
    .filter((row) => {
      if (filters.bot !== "all" && row.botName !== filters.bot) return false;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      const start = new Date(today);
      if (filters.time === "weekly") start.setDate(today.getDate() - 6);
      if (filters.time === "monthly") start.setDate(today.getDate() - 29);
      if (filters.time === "yearly") start.setDate(today.getDate() - 364);
      if (filters.time === "custom" && ((filters.start && row.date < filters.start) || (filters.end && row.date > filters.end))) return false;
      if (filters.time === "yesterday") { const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1); if (row.date !== dateKey(yesterday)) return false; }
      if (filters.time === "daily" && row.date !== dateKey(today)) return false;
      if (["weekly", "monthly", "yearly"].includes(filters.time) && new Date(`${row.date}T00:00:00`) < start) return false;
      return isWinning ? row.profit - row.loss > 0 : row.profit - row.loss < 0;
    })
    .sort((a, b) => isWinning ? (b.profit - b.loss) - (a.profit - a.loss) : (a.profit - a.loss) - (b.profit - b.loss)), [results, isWinning, filters]);

  return <main>
    <section className="hero"><div><p className="eyebrow">TRADE RESULTS</p><h1>{title}</h1><p className="subhead">{matchingResults.length} closed trades</p></div><Link className="primary" href="/">← Back to dashboard</Link></section>
    {error && <p className="notice">{error}</p>}
    <section className="table-card"><div className="table-title"><div><p className="eyebrow">{isWinning ? "PROFITABLE TRADES" : "LOSS-MAKING TRADES"}</p><h2>All {title.toLowerCase()}</h2></div><span>{matchingResults.length} entries</span></div>
      <div className="table-wrap"><table><thead><tr><th>Date</th><th>Bot Name</th><th>Opening Balance</th><th>Trades</th><th>Closing Balance</th><th>Net Profit</th><th>Total Loss</th><th>Return %</th></tr></thead><tbody>{matchingResults.length === 0 ? <tr><td className="empty" colSpan={8}>No {title.toLowerCase()} found.</td></tr> : matchingResults.map((row) => {
        const net = row.profit - row.loss;
        const percent = row.opening ? (net / row.opening) * 100 : 0;
        return <tr key={row.id}><td>{new Date(`${row.date}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}</td><td><b>{row.botName}</b></td><td>{money.format(row.opening)}</td><td>{row.trades}</td><td>{money.format(row.closing)}</td><td className={net >= 0 ? "positive" : "negative"}>{money.format(net)}</td><td className="negative">{money.format(row.loss)}</td><td><span className={percent >= 0 ? "pill gain" : "pill loss"}>{percent >= 0 ? "+" : ""}{percent.toFixed(2)}%</span></td></tr>;
      })}</tbody></table></div>
    </section>
  </main>;
}
