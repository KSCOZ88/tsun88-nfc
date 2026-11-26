begin;

create table public.tsun_order_reviews (
  merchant_order_id text primary key,
  payment_provider text not null check (payment_provider in ('stripe', 'paypal', 'airwallex')),
  profiles jsonb not null check (jsonb_typeof(profiles) = 'array'),
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  created_at timestamptz not null default now()
);

create table public.tsun_order_review_images (
  merchant_order_id text not null,
  tag_number smallint not null check (tag_number between 1 and 20),
  side text not null check (side in ('front', 'back')),
  image_png bytea not null check (octet_length(image_png) between 8 and 600000),
  primary key (merchant_order_id, tag_number, side)
);

alter table public.tsun_order_reviews enable row level security;
alter table public.tsun_order_review_images enable row level security;
revoke all on public.tsun_order_reviews, public.tsun_order_review_images from public, anon, authenticated;

-- The production writer and admin reader are provisioned separately from the
-- preview storefront. Grant only to roles that are present in this database.
do $roles$
begin
  if exists (select 1 from pg_roles where rolname = 'production_queue_writer') then
    grant insert on public.tsun_order_reviews, public.tsun_order_review_images to production_queue_writer;
    grant select (public_slug, order_id, is_published) on public.pet_profiles to production_queue_writer;
    create policy paid_order_profile_check on public.pet_profiles for select to production_queue_writer using (is_published);
    create policy paid_order_review_insert on public.tsun_order_reviews for insert to production_queue_writer
      with check (payment_provider in ('stripe', 'paypal', 'airwallex'));
    create policy paid_order_image_insert on public.tsun_order_review_images for insert to production_queue_writer
      with check (true);
  end if;
  if exists (select 1 from pg_roles where rolname = 'production_admin_reader') then
    grant select on public.tsun_order_reviews, public.tsun_order_review_images to production_admin_reader;
    create policy admin_paid_order_review_read on public.tsun_order_reviews for select to production_admin_reader using (true);
    create policy admin_order_image_read on public.tsun_order_review_images for select to production_admin_reader using (true);
  end if;
  if exists (select 1 from pg_roles where rolname = 'merchant_order_preview') then
    grant select on public.tsun_order_reviews, public.tsun_order_review_images to merchant_order_preview;
    grant insert on public.tsun_order_review_images to merchant_order_preview;
    grant select (merchant_order_id, payment_provider, status, created_at)
      on public.tsun_production_jobs to merchant_order_preview;
    create policy preview_paid_order_review_read on public.tsun_order_reviews for select to merchant_order_preview using (true);
    create policy preview_order_image_read on public.tsun_order_review_images for select to merchant_order_preview using (true);
    create policy preview_order_image_insert on public.tsun_order_review_images for insert to merchant_order_preview
      with check (exists (
        select 1 from public.tsun_merchant_orders o
        where o.merchant_order_id = tsun_order_review_images.merchant_order_id
          and tsun_order_review_images.tag_number <= cardinality(o.profile_slugs)
      ));
    create policy preview_queue_read on public.tsun_production_jobs for select to merchant_order_preview using (true);

    alter table public.tsun_merchant_orders
      drop constraint tsun_merchant_orders_notification_status_check,
      add constraint tsun_merchant_orders_notification_status_check
        check (notification_status in ('pending', 'captured', 'sending', 'sent')),
      add column notification_lease_until timestamptz;
    grant update (notification_lease_until) on public.tsun_merchant_orders to merchant_order_preview;
  end if;
end
$roles$;

commit;
