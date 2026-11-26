import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";

// MT5 EA -> Trade History. The EA posts one JSON per change of an ACTIVE setup (at least one broker fill):
//   {"ea_key":"...","event":"open"|"close","trade_date":"2026-11-24","bot_name":"OB Touch XAUUSD","session":"london",
//    "timeframe":"M10","side":"buy","entry":"4128.10-4131.40","layers":3,"active_entry":"E3 4130.20","stop_loss":"4125.00",
//    "take_profit":"4135.00-4160.00","result":"open"|"tp"|"sl"|"be","pips":12.5,"profit_usd":70.92,"comment":"..."}
// Header "x-ea-token" must equal the Vercel env EA_LOG_TOKEN. Rows are written with SUPABASE_SERVICE_ROLE_KEY (server only).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSIONS = ["asian", "london", "newyork"];
const RESULTS = ["open", "tp", "sl", "be"];

function tokenOk(given: string | null, expected: string) {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const text = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

export async function POST(request: Request) {
  const token = process.env.EA_LOG_TOKEN, url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!token || !url || !key) return Response.json({ error: "EA_LOG_TOKEN / SUPABASE_SERVICE_ROLE_KEY not set on the server" }, { status: 500 });
  if (!tokenOk(request.headers.get("x-ea-token"), token)) return Response.json({ error: "bad token" }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }

  const eaKey = text(body.ea_key, 120);
  const event = body.event === "close" ? "close" : body.event === "open" ? "open" : null;
  const side = body.side === "buy" || body.side === "sell" ? body.side : null;
  const result = typeof body.result === "string" && RESULTS.includes(body.result) ? body.result : null;
  const date = typeof body.trade_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.trade_date) ? body.trade_date : null;
  if (!eaKey || !event || !side || !result || (event === "open") !== (result === "open"))
    return Response.json({ error: "ea_key, event, side and result are required (event open <-> result open)" }, { status: 400 });

  const row = {
    ea_key: eaKey, trade_date: date, bot_name: text(body.bot_name, 80), timeframe: text(body.timeframe, 20) ?? "M10", side,
    session: typeof body.session === "string" && SESSIONS.includes(body.session) ? body.session : null,
    entry: text(body.entry, 60), layers: typeof body.layers === "number" ? Math.max(0, Math.round(body.layers)) : null,
    active_entry: text(body.active_entry, 40), stop_loss: text(body.stop_loss, 40), take_profit: text(body.take_profit, 60),
    result, pips: num(body.pips), profit_usd: num(body.profit_usd),
  };
  // EA trend ("With trend" / "Against trend", H1 EMA 50/200 at the first fill)
  const trend = text(body.trend, 60);

  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data: existing, error: findError } = await db.from("trade_entries").select("id, result, trend").eq("ea_key", eaKey).maybeSingle();
  if (findError) return Response.json({ error: findError.message }, { status: 500 });

  if (!existing) {
    const { error } = await db.from("trade_entries").insert({ ...row, trend, comment: text(body.comment, 1000) });
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ ok: true, action: "inserted" });
  }
  // a late / repeated "open" never turns a finished trade back into a running one
  if (event === "open" && existing.result !== "open") return Response.json({ ok: true, action: "ignored" });
  // comment, proof, MAE / MFE edited by the admin stay as they are; the trend is only filled when still empty
  const { error } = await db.from("trade_entries").update(existing.trend || !trend ? row : { ...row, trend }).eq("id", existing.id);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true, action: "updated" });
}
