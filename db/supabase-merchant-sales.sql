begin;

create table public.tsun_order_numbers (
  merchant_order_id text primary key,
  order_number bigint unique not null check (order_number > 0)
);
alter table public.tsun_order_numbers enable row level security;
revoke all on public.tsun_order_numbers from public, anon, authenticated;

alter table public.tsun_production_jobs
  add column sales_items jsonb not null default '[]'::jsonb
    check (jsonb_typeof(sales_items) = 'array' and jsonb_array_length(sales_items) <= 20);

create schema if not exists private;
create function private.assign_tsun_order_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $number$
begin
  if not exists (select 1 from public.tsun_order_numbers where merchant_order_id = new.merchant_order_id) then
    perform pg_catalog.pg_advisory_xact_lock(8828, 4);
    if not exists (select 1 from public.tsun_order_numbers where merchant_order_id = new.merchant_order_id) then
      insert into public.tsun_order_numbers (merchant_order_id, order_number)
      select new.merchant_order_id, coalesce(max(order_number), 0) + 1 from public.tsun_order_numbers;
    end if;
  end if;
  return new;
end
$number$;
revoke all on function private.assign_tsun_order_number() from public;

-- Hold new order inserts until the old orders receive their permanent numbers.
lock table public.tsun_merchant_orders, public.tsun_order_reviews, public.tsun_production_jobs
  in share row exclusive mode;

with history as (
  select merchant_order_id, created_at from public.tsun_merchant_orders
  union all
  select merchant_order_id, created_at from public.tsun_production_jobs
  union all
  select merchant_order_id, created_at from public.tsun_order_reviews
), orders as (
  select merchant_order_id, min(created_at) as created_at from history group by merchant_order_id
)
insert into public.tsun_order_numbers (merchant_order_id, order_number)
select merchant_order_id, row_number() over (order by created_at, merchant_order_id) from orders;

create trigger tsun_number_merchant_order after insert on public.tsun_merchant_orders
  for each row execute function private.assign_tsun_order_number();
create trigger tsun_number_paid_review after insert on public.tsun_order_reviews
  for each row execute function private.assign_tsun_order_number();
create trigger tsun_number_production_order after insert on public.tsun_production_jobs
  for each row execute function private.assign_tsun_order_number();

do $roles$
declare role_name text;
begin
  foreach role_name in array array['merchant_order_store','merchant_order_preview'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('grant select on public.tsun_order_numbers to %I', role_name);
      execute format('create policy %I on public.tsun_order_numbers for select to %I using (true)',
        role_name || '_read_order_numbers', role_name);
      execute format('grant select (sales_items) on public.tsun_production_jobs to %I', role_name);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'production_queue_writer') then
    grant insert (sales_items) on public.tsun_production_jobs to production_queue_writer;
  end if;
end
$roles$;
commit;
