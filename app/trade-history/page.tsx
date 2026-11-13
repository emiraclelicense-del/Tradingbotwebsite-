"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { BotStrategy, TouchPair, matchesPair, matchesStrategy, pairLabels, strategyLabels } from "../bot-strategy";
import SiteNav from "../site-nav";
import { supabase } from "../supabase";
import TradeEntries from "./trade-entries";

const TIME_OPTIONS = [{ value: "all", label: "All time" }, { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }, { value: "yearly", label: "Yearly" }, { value: "custom", label: "Custom" }];
const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const formatDate = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

export default function TradeHistoryPage() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [allBotNames, setAllBotNames] = useState<string[]>([]);
  const [strategy, setStrategy] = useState<BotStrategy>("all");
  const [pair, setPair] = useState<TouchPair>("all");
  const [bot, setBot] = useState("all");
  const [time, setTime] = useState("all");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const activePair = strategy === "ob" ? pair : "all";

  useEffect(() => { document.body.dataset.theme = "dark"; }, []);

  useEffect(() => {
    async function load() {
      const [{ data: { session } }, { data: resultBots }, { data: entryBots }] = await Promise.all([
        supabase.auth.getSession(),
        supabase.from("trade_results").select("bot_name"),
        supabase.from("trade_entries").select("bot_name"),
      ]);
      setIsAdmin(Boolean(session));
      const names = new Set([...(resultBots ?? []), ...(entryBots ?? [])].map((row) => String(row.bot_name)));
      setAllBotNames([...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })));
    }
    load();
  }, []);

  const botOptions = useMemo(() => allBotNames.filter((name) => matchesStrategy(name, strategy) && matchesPair(name, activePair)), [allBotNames, strategy, activePair]);

  const inScope = useCallback((botName: string, date: string) => {
    if (!matchesStrategy(botName, strategy) || !matchesPair(botName, activePair)) return false;
    if (bot !== "all" && botName !== bot) return false;
    if (time === "all") return true;
    if (time === "custom") return (!customStart || date >= customStart) && (!customEnd || date <= customEnd);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    if (time === "weekly") start.setDate(today.getDate() - 6);
    if (time === "monthly") start.setDate(1);
    if (time === "yearly") start.setDate(today.getDate() - 364);
    return date >= dateKey(start);
  }, [strategy, activePair, bot, time, customStart, customEnd]);

  const periodLabel = time === "custom"
    ? customStart && customEnd ? `${formatDate(customStart)} – ${formatDate(customEnd)}` : customStart ? `From ${formatDate(customStart)}` : customEnd ? `Up to ${formatDate(customEnd)}` : "Custom range"
    : TIME_OPTIONS.find((option) => option.value === time)?.label ?? "All time";
  const scopeLabel = [strategy === "all" ? "" : `${strategyLabels[strategy]}${activePair === "all" ? "" : ` ${pairLabels[activePair]}`}`, bot === "all" ? "" : bot, periodLabel].filter(Boolean).join(" · ");

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const { error } = await supabase.auth.signInWithPassword({ email: String(data.get("email")), password: String(data.get("password")) });
    if (error) { setLoginError(error.message); return; }
    setIsAdmin(true); setLoginOpen(false); setLoginError("");
  }
  async function signOut() { await supabase.auth.signOut(); setIsAdmin(false); }

  return <main className="dark-theme">
    <SiteNav />
    <section className="hero"><div className="hero-copy"><div className="hero-top"><p className="eyebrow">TRADE HISTORY</p><div className="hero-actions">
      {isAdmin ? <button className="primary" type="button" onClick={signOut}>Sign out</button> : <button className="primary" type="button" onClick={() => setLoginOpen((open) => !open)}>Admin Login</button>}
    </div></div><h1>Trade <span>History</span></h1><p className="subhead">Every entry each bot took, and how it closed.</p></div></section>

    {loginOpen && !isAdmin && <section className="login-card"><h2>Admin sign in</h2><form onSubmit={signIn}><input name="email" type="email" placeholder="Email" required /><input name="password" type="password" placeholder="Password" required /><button className="primary">Sign in</button></form></section>}
    {loginError && <p className="notice">{loginError}</p>}

    <section className="history-filters" aria-label="Trade history filters">
      <fieldset className="time-filter"><legend>Bot Strategy</legend><div className="time-filter-buttons">
        {(Object.keys(strategyLabels) as BotStrategy[]).map((value) => <button key={value} type="button" className={strategy === value ? "active" : ""} aria-pressed={strategy === value} onClick={() => { setStrategy(value); setPair("all"); setBot("all"); }}>{strategyLabels[value]}</button>)}
      </div></fieldset>
      {strategy === "ob" && <fieldset className="time-filter"><legend>Touch Pair</legend><div className="time-filter-buttons">
        {(Object.keys(pairLabels) as TouchPair[]).map((value) => <button key={value} type="button" className={pair === value ? "active" : ""} aria-pressed={pair === value} onClick={() => { setPair(value); setBot("all"); }}>{pairLabels[value]}</button>)}
      </div></fieldset>}
      <fieldset className="time-filter"><legend>Time</legend><div className="time-filter-buttons">
        {TIME_OPTIONS.map(({ value, label }) => <button key={value} type="button" className={time === value ? "active" : ""} aria-pressed={time === value} onClick={() => setTime(value)}>{label}</button>)}
      </div>
        {time === "custom" && <div className="custom-date-range"><label>From<input type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)} /></label><label>To<input type="date" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} /></label></div>}
      </fieldset>
      <label className="history-bot">Bot<select value={bot} onChange={(event) => setBot(event.target.value)}><option value="all">All bots</option>{botOptions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
    </section>

    <TradeEntries isAdmin={isAdmin} botNames={allBotNames} inScope={inScope} scopeLabel={scopeLabel} />
  </main>;
}
