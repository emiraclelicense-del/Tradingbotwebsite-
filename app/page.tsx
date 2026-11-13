"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
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

  useEffect(() => {
    async function load() {
      const [{ data, error: loadError }, { data: { session } }] = await Promise.all([supabase.from("trade_results").select("*").order("trade_date", { ascending: false }), supabase.auth.getSession()]);
      if (loadError) setError("Database is not ready yet. Complete the Supabase setup steps below.");
      if (data) setResults(data.map((row) => ({ id: row.id, date: row.trade_date, botName: row.bot_name, trades: row.trades, opening: Number(row.opening), closing: Number(row.closing), profit: Number(row.profit), loss: Number(row.loss), deposit: Number(row.deposit), withdraw: Number(row.withdraw) })));
      setIsAdmin(Boolean(session));
    }
    load();
  }, []);

  const filteredResults = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    if (timeFilter === "weekly") start.setDate(today.getDate() - 6);
    if (timeFilter === "monthly") start.setDate(today.getDate() - 29);
    return results.filter((row) => {
      if (botFilter !== "all" && row.botName !== botFilter) return false;
      if (timeFilter === "all") return true;
      if (timeFilter === "custom") return (!customStart || row.date >= customStart) && (!customEnd || row.date <= customEnd);
      return new Date(`${row.date}T00:00:00`) >= start;
    });
  }, [results, botFilter, timeFilter, customStart, customEnd]);

  const totals = useMemo(() => filteredResults.reduce((total, row) => ({
    profit: total.profit + row.profit, loss: total.loss + row.loss,
    deposits: total.deposits + row.deposit, withdraws: total.withdraws + row.withdraw
  }), { profit: 0, loss: 0, deposits: 0, withdraws: 0 }), [filteredResults]);

  const botNames = useMemo(() => [...new Set(results.map((row) => row.botName))].sort(), [results]);

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

  return <main>
    <section className="hero">
      <div><p className="eyebrow">TRADING PERFORMANCE</p><h1>Emircale<span>X</span> Bot</h1><p className="subhead">Daily results, clearly tracked.</p></div>
      <button className="primary" onClick={() => isAdmin ? (setEditing(null), setShowForm((visible) => !visible)) : setLoginOpen(true)}>{isAdmin ? (showForm ? "Close form" : "+ Add daily result") : "Admin sign in"}</button>
    </section>

    {error && <p className="notice">{error}</p>}
    {loginOpen && <section className="login-card"><h2>Admin sign in</h2><form onSubmit={signIn}><input name="email" type="email" placeholder="Email" required /><input name="password" type="password" placeholder="Password" required /><button className="primary">Sign in</button></form></section>}
    {isAdmin && <button className="signout" onClick={signOut}>Sign out of admin</button>}

    <section className="stats" aria-label="Performance summary">
      <article><span>Net profit</span><strong className="positive">{money.format(totals.profit - totals.loss)}</strong></article>
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

    <section className="table-card"><div className="table-title"><div><p className="eyebrow">DAILY LOG</p><h2>Trade results</h2></div><span>{filteredResults.length} entries</span></div>
      <div className="filters"><label>Bot Name<select value={botFilter} onChange={(event) => setBotFilter(event.target.value)}><option value="all">All bots</option>{botNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></label><label>Time<select value={timeFilter} onChange={(event) => setTimeFilter(event.target.value)}><option value="all">All time</option><option value="daily">Daily (today)</option><option value="weekly">Weekly (last 7 days)</option><option value="monthly">Monthly (last 30 days)</option><option value="custom">Custom range</option></select></label>{timeFilter === "custom" && <><label>From<input type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)} /></label><label>To<input type="date" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} /></label></>}</div>
      <div className="table-wrap"><table><thead><tr><th>Date</th><th>Bot Name</th><th>Opening Balance</th><th>Trades</th><th>Closing Balance</th><th>Net Profit</th><th>Total Loss</th><th>Deposit</th><th>Withdraw</th><th>Return %</th><th></th></tr></thead>
      <tbody>{filteredResults.length === 0 ? <tr><td className="empty" colSpan={11}>No matching trade results found.</td></tr> : filteredResults.map((row) => {
        const closing = row.closing ?? row.opening + row.profit - row.loss + row.deposit - row.withdraw;
        const percentage = row.opening ? ((row.profit - row.loss) / row.opening) * 100 : 0;
        return <tr key={row.id}><td>{new Date(`${row.date}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}</td><td><b>{row.botName}</b></td><td>{money.format(row.opening)}</td><td>{row.trades}</td><td>{money.format(closing)}</td><td className="positive">{money.format(row.profit)}</td><td className="negative">{money.format(row.loss)}</td><td>{money.format(row.deposit)}</td><td>{money.format(row.withdraw)}</td><td><span className={percentage >= 0 ? "pill gain" : "pill loss"}>{percentage >= 0 ? "+" : ""}{percentage.toFixed(2)}%</span></td><td>{isAdmin && <><button className="edit" onClick={() => editResult(row)}>Edit</button><button className="delete" onClick={() => removeResult(row.id)} aria-label={`Delete ${row.date} result`}>×</button></>}</td></tr>;
      })}</tbody></table></div>
    </section>
  </main>;
}
