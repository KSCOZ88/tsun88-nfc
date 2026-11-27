'use strict';

const saleSources = new Set(['all', 'online', 'merchant']);
const salePeriods = new Set(['7', '30', '90', 'all']);

function saleOptions(query) {
  const {source = 'all', days = '30'} = query;
  if (!saleSources.has(source) || !salePeriods.has(days)) {
    throw Object.assign(new Error('invalid_sales_filter'), {status: 422, code: 'invalid_sales_filter'});
  }
  return {source, days: days === 'all' ? null : Number(days)};
}

// Only product metadata crosses from payment storage into the production database.
function salesItems(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  return items.slice(0, 20).map(item => ({
    baseVariant: typeof item?.baseVariant === 'string' ? item.baseVariant.slice(0, 40) : '',
    selectedBreedKey: typeof item?.selectedBreedKey === 'string' ? item.selectedBreedKey.slice(0, 80) : '',
    breed: typeof item?.breedName === 'string' ? item.breedName.slice(0, 100) : ''
  }));
}

async function salesSummary(sql, options) {
  const {source, days} = saleOptions(options);
  const [summary] = await sql`with sources as (
    select o.merchant_order_id, 'merchant' as source, o.created_at, o.order_details->'items' as items
    from public.tsun_merchant_orders o
    union all
    select q.merchant_order_id, 'online', q.created_at,
      case when q.sales_items <> '[]'::jsonb then q.sales_items else r.items end
    from public.tsun_production_jobs q
    left join public.tsun_order_reviews r using (merchant_order_id)
    where q.payment_provider in ('stripe', 'paypal', 'airwallex')
    union all
    select r.merchant_order_id, 'online', r.created_at, r.items
    from public.tsun_order_reviews r
    where not exists (select 1 from public.tsun_production_jobs q where q.merchant_order_id = r.merchant_order_id)
  ), filtered as (
    select *, created_at at time zone 'Asia/Hong_Kong' as local_time from sources
    where (${source} = 'all' or source = ${source})
      and (${days}::integer is null or created_at >=
        ((now() at time zone 'Asia/Hong_Kong')::date - (${days}::integer - 1))::timestamp at time zone 'Asia/Hong_Kong')
  ), tags as (
    select case i.value->>'baseVariant'
      when 'green-blue' then 'green1' when 'orange-blue' then 'orange1'
      when 'white-blue' then 'white1' when 'red-white' then 'red1'
      when 'yellow-gray' then 'yellow1' when 'pink-blue' then 'pink5'
      else nullif(trim(i.value->>'baseVariant'), '') end as colour,
    coalesce(nullif(trim(i.value->>'selectedBreedKey'), ''),
      regexp_replace(nullif(lower(trim(i.value->>'breed')), ''), '[[:space:]]+', '-', 'g')) as breed
    from filtered f cross join lateral jsonb_array_elements(coalesce(f.items, '[]'::jsonb)) i
  )
  select
    (select count(*)::int from filtered) as order_count,
    (select count(*)::int from filtered where source = 'online') as online_count,
    (select count(*)::int from filtered where source = 'merchant') as merchant_count,
    (select count(*)::int from filtered where coalesce(items, '[]'::jsonb) = '[]'::jsonb) as orders_without_items,
    (select count(*)::int from tags) as tag_count,
    (select count(*)::int from tags where colour is not null) as colour_tag_count,
    (select count(*)::int from tags where breed is not null) as breed_tag_count,
    coalesce((select jsonb_agg(row order by row.count desc, row.key) from
      (select colour as key, count(*)::int as count from tags where colour is not null
       group by colour order by count desc, colour limit 10) row), '[]'::jsonb) as colours,
    coalesce((select jsonb_agg(row order by row.count desc, row.key) from
      (select breed as key, count(*)::int as count from tags where breed is not null
       group by breed order by count desc, breed limit 10) row), '[]'::jsonb) as breeds,
    coalesce((select jsonb_agg(row order by row.slot) from
      (select extract(hour from local_time)::int as slot, count(*)::int as count from filtered group by slot) row),
      '[]'::jsonb) as hours,
    coalesce((select jsonb_agg(row order by row.slot) from
      (select extract(isodow from local_time)::int as slot, count(*)::int as count from filtered group by slot) row),
      '[]'::jsonb) as weekdays`;
  return summary;
}

module.exports = {salesItems, salesSummary};
