create table if not exists public.trade_results (
  id uuid primary key default gen_random_uuid(), trade_date date not null, bot_name text not null, trades text not null,
  opening numeric not null default 0, closing numeric not null default 0, profit numeric not null default 0,
  loss numeric not null default 0, deposit numeric not null default 0, withdraw numeric not null default 0,
  created_at timestamptz not null default now()
);
alter table public.trade_results enable row level security;
grant select on public.trade_results to anon;
grant select, insert, update, delete on public.trade_results to authenticated;
drop policy if exists "Anyone can view trade results" on public.trade_results;
create policy "Anyone can view trade results" on public.trade_results for select using (true);
drop policy if exists "Signed-in users can add results" on public.trade_results;
create policy "Signed-in users can add results" on public.trade_results for insert to authenticated with check (true);
drop policy if exists "Signed-in users can update results" on public.trade_results;
create policy "Signed-in users can update results" on public.trade_results for update to authenticated using (true) with check (true);
drop policy if exists "Signed-in users can delete results" on public.trade_results;
create policy "Signed-in users can delete results" on public.trade_results for delete to authenticated using (true);

-- ===== Trade History (run this whole block in the Supabase SQL Editor; safe to run again) =====
create table if not exists public.trade_entries (
  id uuid primary key default gen_random_uuid(), trade_date date not null, bot_name text not null,
  timeframe text not null default 'M10', side text not null check (side in ('buy', 'sell')), entry text not null,
  result text not null check (result in ('tp', 'sl', 'be')), pips numeric not null default 0, proof_url text,
  created_at timestamptz not null default now()
);
alter table public.trade_entries add column if not exists session text;
alter table public.trade_entries add column if not exists trend text;
alter table public.trade_entries add column if not exists layers integer;
alter table public.trade_entries add column if not exists active_entry text;
alter table public.trade_entries add column if not exists stop_loss text;
alter table public.trade_entries add column if not exists take_profit text;
alter table public.trade_entries add column if not exists max_move numeric;
alter table public.trade_entries add column if not exists comment text;
alter table public.trade_entries alter column pips drop not null;
alter table public.trade_entries add column if not exists mae text;
alter table public.trade_entries add column if not exists mfe text;
alter table public.trade_entries add column if not exists profit_usd numeric;
alter table public.trade_entries alter column trade_date drop not null;
alter table public.trade_entries alter column bot_name drop not null;
alter table public.trade_entries alter column entry drop not null;
alter table public.trade_entries drop constraint if exists trade_entries_session_check;
alter table public.trade_entries add constraint trade_entries_session_check check (session is null or session in ('asian', 'london', 'newyork'));
alter table public.trade_entries enable row level security;
grant select on public.trade_entries to anon;
grant select, insert, update, delete on public.trade_entries to authenticated;
drop policy if exists "Anyone can view trade entries" on public.trade_entries;
drop policy if exists "Signed-in users can add trade entries" on public.trade_entries;
drop policy if exists "Signed-in users can update trade entries" on public.trade_entries;
drop policy if exists "Signed-in users can delete trade entries" on public.trade_entries;
create policy "Anyone can view trade entries" on public.trade_entries for select using (true);
create policy "Signed-in users can add trade entries" on public.trade_entries for insert to authenticated with check (true);
create policy "Signed-in users can update trade entries" on public.trade_entries for update to authenticated using (true) with check (true);
create policy "Signed-in users can delete trade entries" on public.trade_entries for delete to authenticated using (true);

-- Storage bucket for trade proof screenshots (public read, admin upload/delete)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('trade-proofs', 'trade-proofs', true, 5242880, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do nothing;
drop policy if exists "Signed-in users can upload trade proofs" on storage.objects;
drop policy if exists "Signed-in users can update trade proofs" on storage.objects;
drop policy if exists "Signed-in users can delete trade proofs" on storage.objects;
create policy "Signed-in users can upload trade proofs" on storage.objects for insert to authenticated with check (bucket_id = 'trade-proofs');
create policy "Signed-in users can update trade proofs" on storage.objects for update to authenticated using (bucket_id = 'trade-proofs') with check (bucket_id = 'trade-proofs');
create policy "Signed-in users can delete trade proofs" on storage.objects for delete to authenticated using (bucket_id = 'trade-proofs');

-- ===== Auto trades from the MT5 EA (run this block in the Supabase SQL Editor; safe to run again) =====
-- ea_key = one row per EA setup; result 'open' = trade still running (shown as "Running")
alter table public.trade_entries add column if not exists ea_key text;
create unique index if not exists trade_entries_ea_key_idx on public.trade_entries (ea_key);
alter table public.trade_entries drop constraint if exists trade_entries_result_check;
alter table public.trade_entries add constraint trade_entries_result_check check (result in ('tp', 'sl', 'be', 'open'));
-- the EA log API (/api/ea-log) writes with the service_role (secret) key: it needs its own table rights
grant select, insert, update on public.trade_entries to service_role;

-- ===== TradingView History tab (run this block in the Supabase SQL Editor; safe to run again) =====
-- One row per TradingView (Pine) trade, filled by /api/tv-sync from the webhook bridge:
-- "history" alerts (last 31 days, sent when the alert starts) and every live "close" alert.
create table if not exists public.tv_trades (
  key text primary key,                 -- symbol|tf|OB id
  symbol text not null, tf text not null, side text not null check (side in ('buy', 'sell')),
  closed_at timestamptz not null,
  result text not null check (result in ('target', 'be', 'worked', 'fail')),
  best_run numeric, runs text, entry text, stop_loss text,
  from_history boolean not null default false,  -- true once the chart history (reference) for this trade arrived
  created_at timestamptz not null default now()
);
create index if not exists tv_trades_closed_idx on public.tv_trades (closed_at desc);
alter table public.tv_trades enable row level security;
grant select on public.tv_trades to anon, authenticated;
grant select, insert, update on public.tv_trades to service_role;
drop policy if exists "Anyone can view TradingView trades" on public.tv_trades;
create policy "Anyone can view TradingView trades" on public.tv_trades for select using (true);
alter table public.tv_trades add column if not exists take_profit text;   -- TP1 / TP2 / ... of the TradingView setup
alter table public.tv_trades add column if not exists tp_hit integer;     -- TPs hit before the trade ended
alter table public.tv_trades add column if not exists filled integer;     -- entries filled (1 = E1 .. 4 = E1-E4)
alter table public.tv_trades add column if not exists max_move numeric;    -- max move in favour from E1 (pips), from the chart
alter table public.tv_trades add column if not exists max_against numeric; -- max move against after the last fill (pips), from the chart
alter table public.tv_trades add column if not exists trend text;          -- 'with' / 'against': H1 EMA 50/200 trend at the first fill, from the chart
alter table public.tv_trades add column if not exists market text;         -- 'bullish' / 'bearish' / 'ranging': H1 ADX(14) + EMA 50/200 at the first fill, from the chart
alter table public.tv_trades add column if not exists adx numeric;          -- H1 ADX(14) at the first fill (below 20 = ranging), from the chart
alter table public.tv_trades add column if not exists after_sl numeric;      -- SL trades: pips price went beyond E4 after the SL (up to 70), from the chart
alter table public.tv_trades add column if not exists after_sl_result text; -- 'tp1' = came back to TP1 within the limit, 'over' = went past the limit
alter table public.tv_trades add column if not exists opened_at timestamptz; -- when E1 filled (the OB became active), from the chart
