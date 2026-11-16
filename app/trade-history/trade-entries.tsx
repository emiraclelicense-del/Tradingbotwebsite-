"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { supabase } from "../supabase";

type Side = "buy" | "sell";
type Outcome = "tp" | "sl" | "be";
type Session = "asian" | "london" | "newyork";
type TradeEntry = { id: string; date: string; botName: string; session: Session | null; trend: string; timeframe: string; side: Side; entry: string; layers: number | null; activeEntry: string; stopLoss: string; takeProfit: string; maxMove: number | null; result: Outcome; pips: number; proofUrl: string };

const TIMEFRAMES = ["M10", "M12", "M15", "M20", "M30", "Emiracle", "Range of Candle"];
const SESSION_LABELS: Record<Session, string> = { asian: "Asian", london: "London", newyork: "New York" };
const OUTCOME_LABELS: Record<Outcome, string> = { tp: "TP Hit", sl: "SL Hit", be: "Breakeven" };
const PAGE_SIZE = 10;
/** Green for "with trend", red for "against trend", neutral for anything else typed. */
const trendTone = (trend: string) => /against/i.test(trend) ? "loss" : /with/i.test(trend) ? "gain" : "tf";
const formatDate = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
const signedPips = (result: Outcome, pips: number) => result === "be" ? 0 : result === "sl" ? -Math.abs(pips) : Math.abs(pips);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
/** Guesses the session from the current UTC hour, used only as the form's default. */
const currentSession = (): Session => { const hour = new Date().getUTCHours(); return hour < 7 ? "asian" : hour < 12 ? "london" : "newyork"; };

const PROOF_BUCKET = "trade-proofs";
const MAX_PROOF_BYTES = 5 * 1024 * 1024;
const PROOF_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

function checkProofFile(file: File) {
  if (!PROOF_TYPES.includes(file.type)) return "Proof must be a PNG, JPG, WEBP or GIF image.";
  if (file.size > MAX_PROOF_BYTES) return "Proof image must be 5 MB or smaller.";
  return "";
}

async function uploadProof(file: File, date: string) {
  const extension = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
  const path = `${date}/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from(PROOF_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  return supabase.storage.from(PROOF_BUCKET).getPublicUrl(path).data.publicUrl;
}

/** Storage path if the URL is a file in our proof bucket, else null (external links). */
function proofPath(url: string) {
  const marker = `/storage/v1/object/public/${PROOF_BUCKET}/`;
  const index = url.indexOf(marker);
  return index === -1 ? null : decodeURIComponent(url.slice(index + marker.length));
}

const optionalText = (data: FormData, name: string) => String(data.get(name) ?? "").trim() || null;

const toEntry = (row: Record<string, unknown>): TradeEntry => ({
  id: String(row.id), date: String(row.trade_date), botName: String(row.bot_name), session: (row.session as Session | null) ?? null, trend: row.trend ? String(row.trend) : "",
  timeframe: String(row.timeframe), side: row.side as Side, entry: String(row.entry), result: row.result as Outcome,
  layers: row.layers == null ? null : Number(row.layers), activeEntry: row.active_entry ? String(row.active_entry) : "",
  stopLoss: row.stop_loss ? String(row.stop_loss) : "", takeProfit: row.take_profit ? String(row.take_profit) : "",
  maxMove: row.max_move == null ? null : Number(row.max_move),
  pips: Number(row.pips), proofUrl: row.proof_url ? String(row.proof_url) : "",
});

type Props = {
  isAdmin: boolean;
  botNames: string[];
  /** Strategy, pair, bot and time filters from the page. */
  inScope: (botName: string, date: string) => boolean;
  scopeLabel: string;
};

export default function TradeEntries({ isAdmin, botNames, inScope, scopeLabel }: Props) {
  const [entries, setEntries] = useState<TradeEntry[]>([]);
  const [error, setError] = useState("");
  const [timeframe, setTimeframe] = useState("all");
  const [session, setSession] = useState<Session | "all">("all");
  const [page, setPage] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState("");
  const [uploadingId, setUploadingId] = useState("");
  /** Trade being edited in the form, or null when the form adds a new trade. */
  const [editing, setEditing] = useState<TradeEntry | null>(null);

  useEffect(() => {
    async function load() {
      const { data, error: loadError } = await supabase.from("trade_entries").select("*").order("trade_date", { ascending: false }).order("created_at", { ascending: false });
      if (loadError) { setError("Trade history is not ready yet. Run the Trade History block from supabase-schema.sql in Supabase."); return; }
      setEntries((data ?? []).map(toEntry));
    }
    load();
  }, []);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const scopedEntries = useMemo(() => entries.filter((row) => inScope(row.botName, row.date)), [entries, inScope]);
  // All standard timeframes are always selectable, plus any custom ones typed in when adding trades.
  const timeframes = useMemo(() => TIMEFRAMES.concat([...new Set(entries.map((row) => row.timeframe))].filter((tf) => !TIMEFRAMES.includes(tf)).sort()), [entries]);
  const visibleEntries = useMemo(() => scopedEntries.filter((row) => (timeframe === "all" || row.timeframe === timeframe) && (session === "all" || row.session === session)), [scopedEntries, timeframe, session]);
  const pageCount = Math.max(Math.ceil(visibleEntries.length / PAGE_SIZE), 1);
  const pageEntries = visibleEntries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const summary = useMemo(() => visibleEntries.reduce((total, row) => ({
    wins: total.wins + (row.result === "tp" ? 1 : 0),
    losses: total.losses + (row.result === "sl" ? 1 : 0),
    pips: total.pips + row.pips,
  }), { wins: 0, losses: 0, pips: 0 }), [visibleEntries]);
  const decided = summary.wins + summary.losses;

  useEffect(() => { setPage(0); }, [timeframe, session, inScope]);
  useEffect(() => { if (page >= pageCount) setPage(pageCount - 1); }, [page, pageCount]);

  function pickProof(file: File | undefined, input: HTMLInputElement) {
    setPreview(file && !checkProofFile(file) ? URL.createObjectURL(file) : "");
    input.setCustomValidity(file ? checkProofFile(file) : "");
    input.reportValidity();
  }

  async function addEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const result = String(data.get("result")) as Outcome;
    const date = String(data.get("date"));
    const proofFile = data.get("proofFile");
    const file = proofFile instanceof File && proofFile.size > 0 ? proofFile : null;
    if (file && checkProofFile(file)) { setError(checkProofFile(file)); return; }
    setSaving(true);
    const previousProof = editing?.proofUrl ?? "";
    let proofUrl = String(data.get("proofUrl") ?? "").trim();
    try {
      if (file) proofUrl = await uploadProof(file, date);
    } catch {
      setSaving(false);
      setError("Could not upload the proof image. Make sure the Trade History SQL has been run and you are signed in.");
      return;
    }
    const databaseRow = {
      trade_date: date, bot_name: String(data.get("botName")).trim(), session: String(data.get("session")) as Session, trend: String(data.get("trend") ?? "").trim() || null,
      timeframe: String(data.get("timeframe")), side: String(data.get("side")) as Side, entry: String(data.get("entry")).trim(), result,
      layers: String(data.get("layers") ?? "").trim() === "" ? null : Number(data.get("layers")), active_entry: optionalText(data, "activeEntry"),
      stop_loss: optionalText(data, "stopLoss"), take_profit: optionalText(data, "takeProfit"),
      max_move: String(data.get("maxMove") ?? "").trim() === "" ? null : Math.abs(Number(data.get("maxMove"))),
      pips: signedPips(result, Number(data.get("pips")) || 0), proof_url: proofUrl || null,
    };
    const request = editing
      ? supabase.from("trade_entries").update(databaseRow).eq("id", editing.id).select().single()
      : supabase.from("trade_entries").insert(databaseRow).select().single();
    const { data: saved, error: saveError } = await request;
    setSaving(false);
    if (saveError || !saved) {
      const uploadedPath = file ? proofPath(proofUrl) : null;
      if (uploadedPath) await supabase.storage.from(PROOF_BUCKET).remove([uploadedPath]);
      setError(`Could not ${editing ? "update" : "save"} the trade. Please sign in as admin and try again.`);
      return;
    }
    // A replaced or cleared proof image would otherwise be left orphaned in storage.
    const oldPath = previousProof && previousProof !== proofUrl ? proofPath(previousProof) : null;
    if (oldPath) await supabase.storage.from(PROOF_BUCKET).remove([oldPath]);
    const savedEntry = toEntry(saved);
    setEntries((current) => (editing ? current.map((item) => item.id === savedEntry.id ? savedEntry : item) : [savedEntry, ...current]).sort((a, b) => b.date.localeCompare(a.date)));
    setPreview("");
    setError("");
    form.reset();
    setEditing(null);
    setShowForm(false);
  }

  function startEdit(row: TradeEntry) {
    setPreview("");
    setEditing(row);
    setShowForm(true);
    requestAnimationFrame(() => document.querySelector(".entries-form")?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }

  function closeForm() {
    setPreview("");
    setEditing(null);
    setShowForm(false);
  }

  async function removeEntry(row: TradeEntry) {
    if (!confirm("Delete this trade?")) return;
    const { error: deleteError } = await supabase.from("trade_entries").delete().eq("id", row.id);
    if (deleteError) { setError("Could not delete the trade."); return; }
    const path = proofPath(row.proofUrl);
    if (path) await supabase.storage.from(PROOF_BUCKET).remove([path]);
    setEntries((current) => current.filter((item) => item.id !== row.id));
    if (editing?.id === row.id) closeForm();
  }

  async function addProofToEntry(row: TradeEntry, input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const problem = checkProofFile(file);
    if (problem) { setError(problem); return; }
    setUploadingId(row.id);
    try {
      const url = await uploadProof(file, row.date);
      const { error: updateError } = await supabase.from("trade_entries").update({ proof_url: url }).eq("id", row.id);
      if (updateError) {
        const path = proofPath(url);
        if (path) await supabase.storage.from(PROOF_BUCKET).remove([path]);
        throw updateError;
      }
      setEntries((current) => current.map((item) => item.id === row.id ? { ...item, proofUrl: url } : item));
      setError("");
    } catch {
      setError("Could not upload the proof image. Please sign in as admin and try again.");
    } finally {
      setUploadingId("");
    }
  }

  return <section className="table-card entries-card" aria-labelledby="trade-entries-heading">
    <div className="table-title"><div><p className="eyebrow">TRADE PERFORMANCE</p><h2 id="trade-entries-heading">Where each bot entered &amp; the result</h2></div>
      <span>{visibleEntries.length} trades · {decided ? `${((summary.wins / decided) * 100).toFixed(0)}% win rate · ` : ""}<b className={summary.pips >= 0 ? "positive" : "negative"}>{summary.pips >= 0 ? "+" : ""}{summary.pips} pips</b> · {scopeLabel}</span></div>

    <div className="entries-menu">
      <fieldset className="time-filter"><legend>Session</legend><div className="time-filter-buttons">
        {(["all", "asian", "london", "newyork"] as const).map((value) => <button key={value} type="button" className={session === value ? "active" : ""} aria-pressed={session === value} onClick={() => setSession(value)}>{value === "all" ? "All" : SESSION_LABELS[value]}</button>)}
      </div></fieldset>
      <label className="entries-timeframe">Timeframe<select value={timeframe} onChange={(event) => setTimeframe(event.target.value)}>
        <option value="all">All timeframes</option>
        {timeframes.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
      </select></label>
      {isAdmin && <button className="primary" type="button" onClick={() => showForm ? closeForm() : (setPreview(""), setShowForm(true))}>{showForm ? "Close" : "+ Add trade"}</button>}
    </div>

    {error && <p className="notice entries-notice">{error}</p>}

    {isAdmin && showForm && <form key={editing?.id ?? "new"} className="entries-form" onSubmit={addEntry}>
      {editing && <p className="entries-editing">Editing trade from {formatDate(editing.date)} · {editing.botName}</p>}
      <label>Date<input name="date" type="date" defaultValue={editing?.date ?? today()} required /></label>
      <label>Bot Name<input name="botName" list="trade-entry-bots" placeholder="e.g. OB Touch XAUUSD" defaultValue={editing?.botName} required /></label>
      <datalist id="trade-entry-bots">{botNames.map((name) => <option key={name} value={name} />)}</datalist>
      <label>Session<select name="session" defaultValue={editing?.session ?? (session === "all" ? currentSession() : session)}>{(Object.keys(SESSION_LABELS) as Session[]).map((value) => <option key={value} value={value}>{SESSION_LABELS[value]}</option>)}</select></label>
      <label>Timeframe<select name="timeframe" defaultValue={editing?.timeframe ?? (timeframe === "all" || !TIMEFRAMES.includes(timeframe) ? "M10" : timeframe)}>{(editing ? timeframes : TIMEFRAMES).map((tf) => <option key={tf} value={tf}>{tf}</option>)}</select></label>
      <label>Trend<input name="trend" list="trade-entry-trends" maxLength={60} placeholder="With trend / Against trend" defaultValue={editing?.trend} /></label>
      <datalist id="trade-entry-trends"><option value="With trend" /><option value="Against trend" /></datalist>
      <label>Type<select name="side" defaultValue={editing?.side ?? "buy"}><option value="buy">Buy</option><option value="sell">Sell</option></select></label>
      <label>Entry<input name="entry" placeholder="e.g. 4128-4132" defaultValue={editing?.entry} required /></label>
      <label>Layers activated<input name="layers" type="number" min="0" step="1" placeholder="e.g. 3" defaultValue={editing?.layers ?? undefined} /></label>
      <label>Active entry<input name="activeEntry" maxLength={40} placeholder="Entry that ran to TP, e.g. 4130" defaultValue={editing?.activeEntry} /></label>
      <label>SL<input name="stopLoss" maxLength={40} placeholder="e.g. 4120" defaultValue={editing?.stopLoss} /></label>
      <label>TP<input name="takeProfit" maxLength={40} placeholder="e.g. 4145" defaultValue={editing?.takeProfit} /></label>
      <label>Max Move (pips)<input name="maxMove" type="number" min="0" step="0.1" placeholder="How far price ran, e.g. 150" defaultValue={editing?.maxMove ?? undefined} /></label>
      <label>Result<select name="result" defaultValue={editing?.result ?? "tp"}><option value="tp">TP Hit</option><option value="sl">SL Hit</option><option value="be">Breakeven</option></select></label>
      <label>Pips<input name="pips" type="number" min="0" step="0.1" placeholder="e.g. 140" defaultValue={editing ? Math.abs(editing.pips) : undefined} required /></label>
      <label className="proof-upload">Proof screenshot<input name="proofFile" type="file" accept={PROOF_TYPES.join(",")} onChange={(event) => pickProof(event.currentTarget.files?.[0], event.currentTarget)} /><small>{editing?.proofUrl ? "Choose a file to replace the current proof" : "PNG, JPG, WEBP or GIF · max 5 MB"}</small></label>
      <label>…or proof link<input name="proofUrl" type="url" placeholder="https://… (optional)" defaultValue={editing?.proofUrl} /></label>
      {preview && <img className="proof-preview" src={preview} alt="Selected proof screenshot preview" />}
      <button className="primary submit" type="submit" disabled={saving}>{saving ? "Saving…" : editing ? "Update trade" : "Save trade"}</button>
    </form>}

    <div className="table-wrap"><table className="entries-table"><thead><tr><th>Date</th><th>Bot</th><th>Session</th><th>Trend</th><th>Type</th><th>Entry</th><th>Layers</th><th>Active Entry</th><th>SL</th><th>TP</th><th>Max Move</th><th>Result</th><th>Pips</th><th>Reason</th>{isAdmin && <th></th>}</tr></thead>
      <tbody>{pageEntries.length === 0 ? <tr><td className="empty" colSpan={isAdmin ? 15 : 14}>No trades found for {scopeLabel}.</td></tr> : pageEntries.map((row) => <tr key={row.id}>
        <td>{formatDate(row.date)}</td>
        <td><b>{row.botName}</b></td>
        <td>{row.session ? <span className={`pill session ${row.session}`}>{SESSION_LABELS[row.session]}</span> : "—"}</td>
        <td>{row.trend ? <span className={`pill ${trendTone(row.trend)}`}>{row.trend}</span> : "—"}</td>
        <td><span className={`pill ${row.side === "buy" ? "gain" : "loss"}`}>{row.side === "buy" ? "Buy" : "Sell"}</span></td>
        <td><b>{row.entry}</b></td>
        <td>{row.layers ?? "—"}</td>
        <td>{row.activeEntry ? <b>{row.activeEntry}</b> : "—"}</td>
        <td className={row.stopLoss ? "negative" : ""}>{row.stopLoss || "—"}</td>
        <td className={row.takeProfit ? "positive" : ""}>{row.takeProfit || "—"}</td>
        <td>{row.maxMove != null ? <b>+{row.maxMove} pips</b> : "—"}</td>
        <td><span className={`pill ${row.result === "tp" ? "gain" : row.result === "sl" ? "loss" : "be"}`}>{OUTCOME_LABELS[row.result]}</span></td>
        <td className={row.pips > 0 ? "positive" : row.pips < 0 ? "negative" : ""}><b>{row.pips > 0 ? "+" : ""}{row.pips} pips</b></td>
        <td>{row.proofUrl ? <a className="proof-link" href={row.proofUrl} target="_blank" rel="noopener noreferrer">View Proof</a>
          : isAdmin ? <label className={`proof-link proof-add${uploadingId === row.id ? " busy" : ""}`}>{uploadingId === row.id ? "Uploading…" : "+ Upload Proof"}<input type="file" accept={PROOF_TYPES.join(",")} disabled={Boolean(uploadingId)} onChange={(event) => addProofToEntry(row, event.currentTarget)} /></label>
          : <span className="pill loss">No Screenshot</span>}</td>
        {isAdmin && <td><button className="edit" type="button" onClick={() => startEdit(row)} aria-label={`Edit ${row.botName} trade on ${row.date}`}>Edit</button><button className="delete" onClick={() => removeEntry(row)} aria-label={`Delete ${row.botName} trade on ${row.date}`}>×</button></td>}
      </tr>)}</tbody></table></div>

    {visibleEntries.length > PAGE_SIZE && <nav className="pagination" aria-label="Trade history pages">
      <button type="button" onClick={() => setPage((p) => p - 1)} disabled={page === 0}>← Previous</button>
      <span>Page {page + 1} of {pageCount}</span>
      <button type="button" onClick={() => setPage((p) => p + 1)} disabled={page >= pageCount - 1}>Next →</button>
    </nav>}
  </section>;
}
