begin;

alter table public.tsun_production_jobs
  drop constraint tsun_production_jobs_payment_provider_check,
  add constraint tsun_production_jobs_payment_provider_check
    check (payment_provider in ('stripe', 'paypal', 'airwallex', 'merchant'));

create table public.tsun_merchant_orders (
  merchant_order_id text primary key,
  request_hash text not null,
  order_details jsonb not null,
  profile_slugs text[] not null default '{}',
  created_at timestamptz not null default now(),
  payment_status text not null default 'not_required' check (payment_status = 'not_required'),
  notification_status text not null default 'pending' check (notification_status in ('pending', 'captured')),
  notification_message jsonb
);

alter table public.tsun_merchant_orders enable row level security;
revoke all on table public.tsun_merchant_orders from public, anon, authenticated;

-- On production, provision the separate LOGIN role merchant_order_store with
-- INHERIT membership in this role. Use the login only for the merchant API.
create role merchant_order_preview nologin noinherit;
grant usage on schema public to merchant_order_preview;
grant select, insert, update (profile_slugs, notification_status, notification_message)
  on public.tsun_merchant_orders to merchant_order_preview;
create policy merchant_order_preview_read on public.tsun_merchant_orders
  for select to merchant_order_preview using (true);
create policy merchant_order_preview_insert on public.tsun_merchant_orders
  for insert to merchant_order_preview with check (true);
create policy merchant_order_preview_update on public.tsun_merchant_orders
  for update to merchant_order_preview using (true) with check (true);

grant insert (merchant_order_id, payment_provider) on public.tsun_production_jobs to merchant_order_preview;
create policy merchant_order_preview_enqueue on public.tsun_production_jobs
  for insert to merchant_order_preview
  with check (status = 'awaiting_assets' and payment_provider = 'merchant');
grant execute on function public.create_locked_pet_profile(jsonb), public.get_pet_profile(text)
  to merchant_order_preview;

create function public.create_merchant_preview_order(
  order_id text, submitted_hash text, details jsonb, profiles jsonb
) returns public.tsun_merchant_orders
language plpgsql
security invoker
set search_path = ''
as $$
declare
  saved public.tsun_merchant_orders;
  profile jsonb;
  slug text;
  slugs text[] := '{}';
begin
  if order_id !~ '^(TEST-)?M-[0-9a-f]{32}$' or
     submitted_hash !~ '^[0-9a-f]{64}$' or
     jsonb_typeof(profiles) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Invalid preview order';
  end if;
  if jsonb_array_length(profiles) not between 1 and 20
     or jsonb_array_length(profiles) is distinct from jsonb_array_length(details->'items') then
    raise exception using errcode = '22023', message = 'Invalid preview profiles';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(order_id, 0));
  select * into saved from public.tsun_merchant_orders where merchant_order_id = order_id;
  if found then
    if saved.request_hash <> submitted_hash then
      raise exception using errcode = '23505', message = 'Preview order data changed';
    end if;
    return saved;
  end if;

  insert into public.tsun_merchant_orders (merchant_order_id, request_hash, order_details)
    values (order_id, submitted_hash, details);
  for profile in select value from jsonb_array_elements(profiles) loop
    slug := public.create_locked_pet_profile(profile || jsonb_build_object('order_id', order_id))->>'public_slug';
    if slug is null then
      raise exception 'Pet profile slug missing';
    end if;
    slugs := array_append(slugs, slug);
  end loop;
  insert into public.tsun_production_jobs (merchant_order_id, payment_provider)
    values (order_id, 'merchant');
  update public.tsun_merchant_orders set profile_slugs = slugs
    where merchant_order_id = order_id returning * into saved;
  return saved;
end;
$$;

revoke all on function public.create_merchant_preview_order(text, text, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_merchant_preview_order(text, text, jsonb, jsonb)
  to merchant_order_preview;

commit;
