"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { supabase } from "../supabase";

type Side = "buy" | "sell";
type Outcome = "tp" | "sl" | "be";
type Session = "asian" | "london" | "newyork";
type TradeEntry = { id: string; date: string; botName: string; session: Session | null; timeframe: string; side: Side; entry: string; result: Outcome; pips: number; proofUrl: string };

const TIMEFRAMES = ["M1", "M5", "M10", "M15", "M30", "H1", "H4", "D1"];
const SESSION_LABELS: Record<Session, string> = { asian: "Asian", london: "London", newyork: "New York" };
const OUTCOME_LABELS: Record<Outcome, string> = { tp: "TP Hit", sl: "SL Hit", be: "Breakeven" };
const PAGE_SIZE = 10;
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

const toEntry = (row: Record<string, unknown>): TradeEntry => ({
  id: String(row.id), date: String(row.trade_date), botName: String(row.bot_name), session: (row.session as Session | null) ?? null,
  timeframe: String(row.timeframe), side: row.side as Side, entry: String(row.entry), result: row.result as Outcome,
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
  const [timeframe, setTimeframe] = useState("M10");
  const [session, setSession] = useState<Session | "all">("all");
  const [page, setPage] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState("");
  const [uploadingId, setUploadingId] = useState("");

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
  const timeframes = useMemo(() => {
    const used = new Set(scopedEntries.map((row) => row.timeframe));
    return TIMEFRAMES.filter((tf) => used.has(tf) || tf === "M10").concat([...used].filter((tf) => !TIMEFRAMES.includes(tf)));
  }, [scopedEntries]);
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
    let proofUrl = String(data.get("proofUrl") ?? "").trim();
    try {
      if (file) proofUrl = await uploadProof(file, date);
    } catch {
      setSaving(false);
      setError("Could not upload the proof image. Make sure the Trade History SQL has been run and you are signed in.");
      return;
    }
    const databaseRow = {
      trade_date: date, bot_name: String(data.get("botName")).trim(), session: String(data.get("session")) as Session,
      timeframe: String(data.get("timeframe")), side: String(data.get("side")) as Side, entry: String(data.get("entry")).trim(), result,
      pips: signedPips(result, Number(data.get("pips")) || 0), proof_url: proofUrl || null,
    };
    const { data: saved, error: saveError } = await supabase.from("trade_entries").insert(databaseRow).select().single();
    setSaving(false);
    if (saveError || !saved) {
      const uploadedPath = file ? proofPath(proofUrl) : null;
      if (uploadedPath) await supabase.storage.from(PROOF_BUCKET).remove([uploadedPath]);
      setError("Could not save the trade. Please sign in as admin and try again.");
      return;
    }
    setEntries((current) => [toEntry(saved), ...current].sort((a, b) => b.date.localeCompare(a.date)));
    setPreview("");
    setError("");
    form.reset();
    setShowForm(false);
  }

  async function removeEntry(row: TradeEntry) {
    if (!confirm("Delete this trade?")) return;
    const { error: deleteError } = await supabase.from("trade_entries").delete().eq("id", row.id);
    if (deleteError) { setError("Could not delete the trade."); return; }
    const path = proofPath(row.proofUrl);
    if (path) await supabase.storage.from(PROOF_BUCKET).remove([path]);
    setEntries((current) => current.filter((item) => item.id !== row.id));
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
      <fieldset className="time-filter"><legend>Timeframe</legend><div className="time-filter-buttons">
        {[...timeframes, "all"].map((tf) => <button key={tf} type="button" className={timeframe === tf ? "active" : ""} aria-pressed={timeframe === tf} onClick={() => setTimeframe(tf)}>{tf === "all" ? "All" : tf}</button>)}
      </div></fieldset>
      {isAdmin && <button className="primary" type="button" onClick={() => { setPreview(""); setShowForm((visible) => !visible); }}>{showForm ? "Close" : "+ Add trade"}</button>}
    </div>

    {error && <p className="notice entries-notice">{error}</p>}

    {isAdmin && showForm && <form className="entries-form" onSubmit={addEntry}>
      <label>Date<input name="date" type="date" defaultValue={today()} required /></label>
      <label>Bot Name<input name="botName" list="trade-entry-bots" placeholder="e.g. OB Touch XAUUSD" required /></label>
      <datalist id="trade-entry-bots">{botNames.map((name) => <option key={name} value={name} />)}</datalist>
      <label>Session<select name="session" defaultValue={session === "all" ? currentSession() : session}>{(Object.keys(SESSION_LABELS) as Session[]).map((value) => <option key={value} value={value}>{SESSION_LABELS[value]}</option>)}</select></label>
      <label>Timeframe<select name="timeframe" defaultValue={timeframe === "all" ? "M10" : timeframe}>{TIMEFRAMES.map((tf) => <option key={tf}>{tf}</option>)}</select></label>
      <label>Type<select name="side" defaultValue="buy"><option value="buy">Buy</option><option value="sell">Sell</option></select></label>
      <label>Entry<input name="entry" placeholder="e.g. 4128-4132" required /></label>
      <label>Result<select name="result" defaultValue="tp"><option value="tp">TP Hit</option><option value="sl">SL Hit</option><option value="be">Breakeven</option></select></label>
      <label>Pips<input name="pips" type="number" min="0" step="0.1" placeholder="e.g. 140" required /></label>
      <label className="proof-upload">Proof screenshot<input name="proofFile" type="file" accept={PROOF_TYPES.join(",")} onChange={(event) => pickProof(event.currentTarget.files?.[0], event.currentTarget)} /><small>PNG, JPG, WEBP or GIF · max 5 MB</small></label>
      <label>…or proof link<input name="proofUrl" type="url" placeholder="https://… (optional)" /></label>
      {preview && <img className="proof-preview" src={preview} alt="Selected proof screenshot preview" />}
      <button className="primary submit" type="submit" disabled={saving}>{saving ? "Saving…" : "Save trade"}</button>
    </form>}

    <div className="table-wrap"><table className="entries-table"><thead><tr><th>Date</th><th>Bot</th><th>Session</th><th>TF</th><th>Type</th><th>Entry</th><th>Result</th><th>Pips</th><th>Proof</th>{isAdmin && <th></th>}</tr></thead>
      <tbody>{pageEntries.length === 0 ? <tr><td className="empty" colSpan={isAdmin ? 10 : 9}>No trades found for {scopeLabel}.</td></tr> : pageEntries.map((row) => <tr key={row.id}>
        <td>{formatDate(row.date)}</td>
        <td><b>{row.botName}</b></td>
        <td>{row.session ? <span className={`pill session ${row.session}`}>{SESSION_LABELS[row.session]}</span> : "—"}</td>
        <td><span className="pill tf">{row.timeframe}</span></td>
        <td><span className={`pill ${row.side === "buy" ? "gain" : "loss"}`}>{row.side === "buy" ? "Buy" : "Sell"}</span></td>
        <td><b>{row.entry}</b></td>
        <td><span className={`pill ${row.result === "tp" ? "gain" : row.result === "sl" ? "loss" : "be"}`}>{OUTCOME_LABELS[row.result]}</span></td>
        <td className={row.pips > 0 ? "positive" : row.pips < 0 ? "negative" : ""}><b>{row.pips > 0 ? "+" : ""}{row.pips} pips</b></td>
        <td>{row.proofUrl ? <a className="proof-link" href={row.proofUrl} target="_blank" rel="noopener noreferrer">View Proof</a>
          : isAdmin ? <label className={`proof-link proof-add${uploadingId === row.id ? " busy" : ""}`}>{uploadingId === row.id ? "Uploading…" : "+ Upload Proof"}<input type="file" accept={PROOF_TYPES.join(",")} disabled={Boolean(uploadingId)} onChange={(event) => addProofToEntry(row, event.currentTarget)} /></label>
          : <span className="pill loss">No Screenshot</span>}</td>
        {isAdmin && <td><button className="delete" onClick={() => removeEntry(row)} aria-label={`Delete ${row.botName} trade on ${row.date}`}>×</button></td>}
      </tr>)}</tbody></table></div>

    {visibleEntries.length > PAGE_SIZE && <nav className="pagination" aria-label="Trade history pages">
      <button type="button" onClick={() => setPage((p) => p - 1)} disabled={page === 0}>← Previous</button>
      <span>Page {page + 1} of {pageCount}</span>
      <button type="button" onClick={() => setPage((p) => p + 1)} disabled={page >= pageCount - 1}>Next →</button>
    </nav>}
  </section>;
}
