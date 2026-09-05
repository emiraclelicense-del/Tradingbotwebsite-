create table public.trade_results (
  id uuid primary key default gen_random_uuid(), trade_date date not null, bot_name text not null, trades text not null,
  opening numeric not null default 0, closing numeric not null default 0, profit numeric not null default 0,
  loss numeric not null default 0, deposit numeric not null default 0, withdraw numeric not null default 0,
  created_at timestamptz not null default now()
);
alter table public.trade_results enable row level security;
grant select on public.trade_results to anon;
grant select, insert, update, delete on public.trade_results to authenticated;
create policy "Anyone can view trade results" on public.trade_results for select using (true);
create policy "Signed-in users can add results" on public.trade_results for insert to authenticated with check (true);
create policy "Signed-in users can update results" on public.trade_results for update to authenticated using (true) with check (true);
create policy "Signed-in users can delete results" on public.trade_results for delete to authenticated using (true);
