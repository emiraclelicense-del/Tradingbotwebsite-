"use client";

import { CSSProperties, FormEvent, useEffect, useMemo, useState } from "react";
import { createClient } from "@supabase/supabase-js";

type Result = {
  id: string; date: string; botName: string; trades: string; opening: number;
  profit: number; loss: number; deposit: number; withdraw: number; closing?: number;
};

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const numberValue = (value: FormDataEntryValue | null) => Math.max(0, Number(value) || 0);
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);

export default function Home() {
  const [results, setResults] = useState<Result[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Result | null>(null);
  const [botFilter, setBotFilter] = useState("all");
  const [timeFilter, setTimeFilter] = useState("all");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [error, setError] = useState("");
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    async function load() {
      const [{ data, error: loadError }, { data: { session } }] = await Promise.all([supabase.from("trade_results").select("*").order("trade_date", { ascending: false }), supabase.auth.getSession()]);
      if (loadError) setError("Database is not ready yet. Complete the Supabase setup steps below.");
      if (data) setResults(data.map((row) => ({ id: row.id, date: row.trade_date, botName: row.bot_name, trades: row.trades, opening: Number(row.opening), closing: Number(row.closing), profit: Number(row.profit), loss: Number(row.loss), deposit: Number(row.deposit), withdraw: Number(row.withdraw) })));
      setIsAdmin(Boolean(session));
    }
    load();
  }, []);

  useEffect(() => {
    document.body.dataset.theme = theme;
  }, [theme]);

  const filteredResults = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    if (timeFilter === "weekly") start.setDate(today.getDate() - 6);
    if (timeFilter === "monthly") start.setDate(today.getDate() - 29);
    if (timeFilter === "yearly") start.setDate(today.getDate() - 364);
    return results.filter((row) => {
      if (botFilter !== "all" && row.botName !== botFilter) return false;
      if (timeFilter === "all") return true;
      if (timeFilter === "custom") return (!customStart || row.date >= customStart) && (!customEnd || row.date <= customEnd);
      if (timeFilter === "daily") return row.date === dateKey(today);
      if (timeFilter === "yesterday") { const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1); return row.date === dateKey(yesterday); }
      return new Date(`${row.date}T00:00:00`) >= start;
    });
  }, [results, botFilter, timeFilter, customStart, customEnd]);

  const sortedFilteredResults = useMemo(() => [...filteredResults].sort((a, b) => {
    const dateOrder = b.date.localeCompare(a.date);
    if (dateOrder) return dateOrder;
    const netOrder = (b.profit - b.loss) - (a.profit - a.loss);
    return netOrder || a.botName.localeCompare(b.botName, undefined, { numeric: true, sensitivity: "base" });
  }), [filteredResults]);
  const formatDate = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const selectedPeriod = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const rangeLabel = (start: Date, end: Date) => `${formatDate(dateKey(start))} – ${formatDate(dateKey(end))}`;
    if (timeFilter === "all") return "All time";
    if (timeFilter === "custom") {
      if (customStart && customEnd) return customStart === customEnd ? formatDate(customStart) : `${formatDate(customStart)} – ${formatDate(customEnd)}`;
      if (customStart) return `From ${formatDate(customStart)}`;
      if (customEnd) return `Up to ${formatDate(customEnd)}`;
      return "Custom range";
    }
    if (timeFilter === "yesterday") { const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1); return formatDate(dateKey(yesterday)); }
    if (timeFilter === "daily") return formatDate(dateKey(today));
    const start = new Date(today);
    if (timeFilter === "weekly") start.setDate(today.getDate() - 6);
    if (timeFilter === "monthly") start.setDate(today.getDate() - 29);
    if (timeFilter === "yearly") start.setDate(today.getDate() - 364);
    return rangeLabel(start, today);
  }, [timeFilter, customStart, customEnd]);
  const selectedScope = botFilter === "all" ? selectedPeriod : `${botFilter} · ${selectedPeriod}`;
  const hasActiveFilter = botFilter !== "all" || timeFilter !== "all";
  const latestDate = sortedFilteredResults[0]?.date ?? "";
  const visibleResults = hasActiveFilter ? sortedFilteredResults : sortedFilteredResults.filter((row) => row.date === latestDate);
  const tableScope = hasActiveFilter ? selectedScope : (latestDate ? formatDate(latestDate) : "Latest day");

  const totals = useMemo(() => filteredResults.reduce((total, row) => ({
    profit: total.profit + row.profit, loss: total.loss + row.loss,
    deposits: total.deposits + row.deposit, withdraws: total.withdraws + row.withdraw,
    opening: total.opening + row.opening
  }), { profit: 0, loss: 0, deposits: 0, withdraws: 0, opening: 0 }), [filteredResults]);
  const initialBalance = useMemo(() => Object.values(filteredResults.reduce<Record<string, { date: string; opening: number }>>((balances, row) => {
    const current = balances[row.botName];
    if (!current || row.date < current.date) balances[row.botName] = { date: row.date, opening: row.opening };
    return balances;
  }, {})).reduce((sum, bot) => sum + bot.opening, 0), [filteredResults]);
  const profitPercent = initialBalance ? ((totals.profit - totals.loss) / initialBalance) * 100 : 0;
  const performanceCounts = useMemo(() => filteredResults.reduce((counts, row) => {
    const net = row.profit - row.loss;
    if (net > 0) counts.wins += 1;
    if (net < 0) counts.losses += 1;
    return counts;
  }, { wins: 0, losses: 0 }), [filteredResults]);
  const decidedResults = performanceCounts.wins + performanceCounts.losses;
  const winRate = decidedResults ? (performanceCounts.wins / decidedResults) * 100 : 0;

  const botPerformance = useMemo(() => Object.values(filteredResults.reduce<Record<string, { name: string; profit: number; loss: number; opening: number; initialDate: string; net: number }>>((performance, row) => {
    const current = performance[row.botName] ?? { name: row.botName, profit: 0, loss: 0, opening: row.opening, initialDate: row.date, net: 0 };
    current.profit += row.profit;
    current.loss += row.loss;
    if (row.date < current.initialDate) { current.opening = row.opening; current.initialDate = row.date; }
    current.net += row.profit - row.loss;
    performance[row.botName] = current;
    return performance;
  }, {})).sort((a, b) => b.net - a.net), [filteredResults]);
  const cumulativeValues = botPerformance.reduce<number[]>((values, bot) => [...values, (values.at(-1) ?? 0) + bot.net], []);
  const chartMaxValue = Math.max(...cumulativeValues, 0);
  const chartMinValue = Math.min(...cumulativeValues, 0);
  const chartRange = Math.max(chartMaxValue - chartMinValue, 1);
  const chartWidth = 900;
  const chartHeight = 360;
  const chartLeft = 64;
  const chartRight = 24;
  const chartTop = 35;
  const chartBottom = 64;
  const chartPlotHeight = chartHeight - chartTop - chartBottom;
  const chartPlotWidth = chartWidth - chartLeft - chartRight;
  const chartZeroY = chartTop + (chartMaxValue / chartRange) * chartPlotHeight;
  const chartStep = chartPlotWidth / Math.max(botPerformance.length, 1);
  const chartPointY = (value: number) => chartTop + ((chartMaxValue - value) / chartRange) * chartPlotHeight;
  const cumulativeChartPoints = cumulativeValues.map((value, index) => `${chartLeft + chartStep * (index + 0.5)},${chartPointY(value)}`).join(" ");

  async function addResult(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const row: Result = {
      id: editing?.id ?? crypto.randomUUID(), date: String(data.get("date")), botName: String(data.get("botName")).trim(),
      trades: String(data.get("trades")).trim(), opening: numberValue(data.get("opening")),
      profit: numberValue(data.get("profit")), loss: numberValue(data.get("loss")),
      deposit: numberValue(data.get("deposit")), withdraw: numberValue(data.get("withdraw")),
      closing: numberValue(data.get("closing"))
    };
    const databaseRow = { trade_date: row.date, bot_name: row.botName, trades: row.trades, opening: row.opening, closing: row.closing, profit: row.profit, loss: row.loss, deposit: row.deposit, withdraw: row.withdraw };
    const { error: saveError } = editing ? await supabase.from("trade_results").update(databaseRow).eq("id", row.id) : await supabase.from("trade_results").insert(databaseRow);
    if (saveError) { setError("Could not save the result. Please sign in as admin and try again."); return; }
    setResults((current) => editing ? current.map((item) => item.id === editing.id ? row : item) : [row, ...current]);
    event.currentTarget.reset();
    setEditing(null);
    setShowForm(false);
  }

  async function removeResult(id: string) {
    if (!confirm("Delete this result?")) return;
    const { error: deleteError } = await supabase.from("trade_results").delete().eq("id", id);
    if (deleteError) { setError("Could not delete the result."); return; }
    setResults((current) => current.filter((row) => row.id !== id));
  }

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const { error: loginError } = await supabase.auth.signInWithPassword({ email: String(data.get("email")), password: String(data.get("password")) });
    if (loginError) { setError(loginError.message); return; }
    setIsAdmin(true); setLoginOpen(false); setError("");
  }
  async function signOut() { await supabase.auth.signOut(); setIsAdmin(false); setShowForm(false); }

  function editResult(row: Result) {
    setEditing(row);
    setShowForm(true);
  }

  function browseDay(offset: number) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const selected = timeFilter === "custom" && customStart ? new Date(`${customStart}T00:00:00`) : new Date(today);
    if (timeFilter === "yesterday") selected.setDate(selected.getDate() - 1);
    selected.setDate(selected.getDate() + offset);
    const date = `${selected.getFullYear()}-${String(selected.getMonth() + 1).padStart(2, "0")}-${String(selected.getDate()).padStart(2, "0")}`;
    setCustomStart(date); setCustomEnd(date); setTimeFilter("custom");
  }

  const filters = <div className="filters"><fieldset className="time-filter"><legend>Time</legend><div className="time-filter-buttons">{[{ value: "all", label: "All time" }, { value: "yesterday", label: "Recent" }, { value: "custom", label: "Custom" }, { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }, { value: "yearly", label: "Yearly" }].map(({ value, label }) => <button className={timeFilter === value ? "active" : ""} key={value} type="button" aria-pressed={timeFilter === value} onClick={() => setTimeFilter(value)}>{label}</button>)}</div><div className="day-navigation"><span>Browse individual days</span><button type="button" onClick={() => browseDay(-1)}>← Previous day</button><button type="button" onClick={() => browseDay(1)}>Next day →</button></div></fieldset>{timeFilter === "custom" && <div className="custom-date-range"><label>From<input type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)} /></label><label>To<input type="date" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} /></label></div>}</div>;

  return <main className={`${theme}-theme`}>
    <section className="hero"><div className="hero-copy"><div className="hero-top"><p className="eyebrow">TRADING PERFORMANCE</p><div className="hero-actions"><button className="theme-toggle" type="button" aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}>{theme === "dark" ? "☀" : "◐"}</button><button className="primary" onClick={() => isAdmin ? (setEditing(null), setShowForm((visible) => !visible)) : setLoginOpen(true)}>{isAdmin ? (showForm ? "Close form" : "+ Add daily result") : "Admin Login"}</button></div></div><h1>eMiracle <span>X</span> Bots</h1><p className="subhead">Daily results, clearly tracked.</p></div></section>

    {error && <p className="notice">{error}</p>}
    {loginOpen && <section className="login-card"><h2>Admin sign in</h2><form onSubmit={signIn}><input name="email" type="email" placeholder="Email" required /><input name="password" type="password" placeholder="Password" required /><button className="primary">Sign in</button></form></section>}
    {isAdmin && <button className="signout" onClick={signOut}>Sign out of admin</button>}

    <section className="stats" aria-label="Performance summary">
      <article><span>Net profit</span><strong className="positive">{money.format(totals.profit - totals.loss)}</strong></article>
      <article><span>Initial balance</span><strong>{money.format(initialBalance)}</strong></article>
      <article><span>Profit percentage</span><strong className={profitPercent >= 0 ? "positive" : "negative"}>{profitPercent >= 0 ? "+" : ""}{profitPercent.toFixed(2)}%</strong></article>
      <article><span>Total profit</span><strong>{money.format(totals.profit)}</strong></article>
      <article><span>Total loss</span><strong className="negative">{money.format(totals.loss)}</strong></article>
      <article><span>Results logged</span><strong>{filteredResults.length}</strong></article>
    </section>

    {showForm && <section className="form-card"><div><p className="eyebrow">{editing ? "EDIT ENTRY" : "NEW ENTRY"}</p><h2>{editing ? "Edit daily trade result" : "Add daily trade result"}</h2></div>
      <form key={editing?.id ?? "new"} onSubmit={addResult}>
        <label>Date<input name="date" type="date" defaultValue={editing?.date} required /></label>
        <label>Bot Name<input name="botName" defaultValue={editing?.botName} placeholder="e.g. EmircaleX Gold" required /></label>
        <label>Opening Balance<input name="opening" type="number" defaultValue={editing?.opening} min="0" step="0.01" placeholder="0.00" required /></label>
        <label>Closing Balance<input name="closing" type="number" defaultValue={editing?.closing} min="0" step="0.01" placeholder="0.00" required /></label>
        <label>Trades Summary<input name="trades" defaultValue={editing?.trades} placeholder="e.g. 2 Trades (1 TP, 1 BE)" required /></label>
        <label>Net Profit<input name="profit" type="number" defaultValue={editing?.profit} min="0" step="0.01" placeholder="0.00" /></label>
        <label>Total Loss<input name="loss" type="number" defaultValue={editing?.loss} min="0" step="0.01" placeholder="0.00" /></label>
        <label>Deposit<input name="deposit" type="number" defaultValue={editing?.deposit} min="0" step="0.01" placeholder="0.00" /></label>
        <label>Withdraw<input name="withdraw" type="number" defaultValue={editing?.withdraw} min="0" step="0.01" placeholder="0.00" /></label>
        <button className="primary submit" type="submit">{editing ? "Update result" : "Save result"}</button>
      </form>
    </section>}

    <section className="table-card"><div className="table-title"><div><p className="eyebrow">TRADE LOG</p><h2>Trade results for {tableScope}</h2></div><span>{visibleResults.length} entries · {hasActiveFilter ? selectedScope : "Latest day"}</span></div>
      <div className="table-wrap"><table><thead><tr><th>Date</th><th>Bot Name</th><th>Opening Balance</th><th>Trades</th><th>Closing Balance</th><th>Net Profit</th><th>Total Loss</th><th>Deposit</th><th>Withdraw</th><th>Return %</th><th></th></tr></thead>
      <tbody>{filteredResults.length === 0 ? <tr><td className="empty" colSpan={11}>No matching trade results found for {selectedScope}.</td></tr> : visibleResults.map((row) => {
        const closing = row.closing ?? row.opening + row.profit - row.loss + row.deposit - row.withdraw;
        const percentage = row.opening ? ((row.profit - row.loss) / row.opening) * 100 : 0;
        return <tr key={row.id}><td>{new Date(`${row.date}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}</td><td><b>{row.botName}</b></td><td>{money.format(row.opening)}</td><td>{row.trades}</td><td>{money.format(closing)}</td><td className="positive">{money.format(row.profit)}</td><td className="negative">{money.format(row.loss)}</td><td>{money.format(row.deposit)}</td><td>{money.format(row.withdraw)}</td><td><span className={percentage >= 0 ? "pill gain" : "pill loss"}>{percentage >= 0 ? "+" : ""}{percentage.toFixed(2)}%</span></td><td>{isAdmin && <><button className="edit" onClick={() => editResult(row)}>Edit</button><button className="delete" onClick={() => removeResult(row.id)} aria-label={`Delete ${row.date} result`}>×</button></>}</td></tr>;
      })}</tbody></table></div>
    </section>

    <section className="priority-card" aria-labelledby="bot-priority-heading"><div className="filter-area" aria-label="Trade result filters">{filters}</div>
      <div className="table-title"><div><p className="eyebrow">BOT PERFORMANCE</p><h2 id="bot-priority-heading">Bot priority graph</h2></div><span>Ranked by net profit</span></div>
      <div className="performance-total"><div className="verified-total"><strong>{filteredResults.length}</strong><div><b>Verified closed results</b><span>{selectedScope}</span></div></div><div className="performance-grid"><article className="loss-panel"><strong>{performanceCounts.losses}</strong><span>Losing results</span></article><article className="win-rate"><div className="rate-ring" style={{ "--win-rate": `${winRate * 3.6}deg` } as CSSProperties}><strong>{winRate.toFixed(0)}%</strong><span>Win rate</span></div></article><article className="gain-panel"><strong>{performanceCounts.wins}</strong><span>Winning results</span></article><article className="loss-panel"><strong>{money.format(totals.loss)}</strong><span>Total loss</span></article><article className="gain-panel"><strong>{money.format(totals.profit)}</strong><span>Total profit</span></article></div><div className="net-total"><span>Net performance</span><strong className={totals.profit - totals.loss >= 0 ? "positive" : "negative"}>{totals.profit - totals.loss >= 0 ? "+" : "−"}{money.format(Math.abs(totals.profit - totals.loss))}</strong></div></div>
      {botPerformance.length === 0 ? <p className="chart-empty">Add trade results to see each bot's priority.</p> : <><div className="priority-chart">
        {botPerformance.map((bot, index) => <button className={`priority-row${botFilter === bot.name ? " selected" : ""}`} key={bot.name} type="button" onClick={() => setBotFilter((current) => current === bot.name ? "all" : bot.name)} aria-pressed={botFilter === bot.name} aria-label={botFilter === bot.name ? `Clear ${bot.name} filter` : `Filter results by ${bot.name}`}><div className="bot-label"><b>{bot.name}</b><span className={index === 0 && bot.net > 0 ? "priority high" : bot.net > 0 ? "priority standard" : "priority review"}>{index === 0 && bot.net > 0 ? "High priority" : bot.net > 0 ? "Standard" : "Review"}</span></div><div className="bar-track"><div className={bot.net >= 0 ? "bot-bar positive-bar" : "bot-bar negative-bar"} style={{ width: `${(Math.abs(bot.net) / Math.max(...botPerformance.map((item) => Math.abs(item.net)), 1)) * 100}%` }} /></div><strong className={bot.net >= 0 ? "positive" : "negative"}>{bot.net >= 0 ? "+" : "−"}{money.format(Math.abs(bot.net))}<small>{bot.opening ? `${bot.net >= 0 ? "+" : ""}${((bot.net / bot.opening) * 100).toFixed(2)}%` : "—"}</small></strong></button>)}
      </div><div className="pivot-wrap"><table className="pivot-table"><caption>Bot performance pivot</caption><thead><tr><th>Bot</th><th>Initial Balance</th><th>Profit</th><th>Loss</th><th>Net</th><th>Return</th><th>Priority</th></tr></thead><tbody>{botPerformance.map((bot, index) => { const returnPercent = bot.opening ? (bot.net / bot.opening) * 100 : 0; const label = index === 0 && bot.net > 0 ? "High" : bot.net > 0 ? "Standard" : "Review"; return <tr key={bot.name}><td><b>{bot.name}</b></td><td>{money.format(bot.opening)}</td><td className="positive">{money.format(bot.profit)}</td><td className="negative">{money.format(bot.loss)}</td><td className={bot.net >= 0 ? "positive" : "negative"}>{money.format(bot.net)}</td><td>{returnPercent >= 0 ? "+" : ""}{returnPercent.toFixed(2)}%</td><td><span className={`priority ${label.toLowerCase()}`}>{label}</span></td></tr>; })}</tbody></table></div></>}
    </section>
  </main>;
}
