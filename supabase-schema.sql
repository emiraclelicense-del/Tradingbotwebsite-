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
