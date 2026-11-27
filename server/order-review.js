'use strict';

const {postgres} = require('./postgres');

const providers = new Set(['stripe', 'paypal', 'airwallex', 'merchant']);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const printSides = ['print_front', 'print_back', 'print_dog'];
// 20 tags × 3 images × 300 KB stays within one Gmail message after MIME encoding.
const printImageLimit = 300000;

function fail(status, code) {
  return Object.assign(new Error(code), {status, code});
}

function checkOrderId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) throw fail(422, 'invalid_id');
  return value;
}

function pngContent(file, limit) {
  const data = file?.data;
  if (typeof data !== 'string' || data.length > 22 + Math.ceil(limit / 3) * 4 ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw fail(422, 'invalid_review_image');
  }
  const content = Buffer.from(data.slice(22), 'base64');
  if (content.length > limit || !content.subarray(0, 8).equals(pngSignature)) {
    throw fail(422, 'invalid_review_image');
  }
  return content;
}

function imageRows(previews, start = 1) {
  if (!Array.isArray(previews) || previews.length === 0 || previews.length % 2 || previews.length > 40) {
    throw fail(422, 'invalid_review_images');
  }
  return previews.map((preview, index) => ({
    tag_number: start + Math.floor(index / 2),
    side: index % 2 ? 'back' : 'front',
    content: pngContent(preview, 600000).toString('base64')
  }));
}

function insertImages(sql, orderId, rows) {
  return sql`insert into public.tsun_order_review_images (merchant_order_id, tag_number, side, image_png)
    select ${orderId}, image.tag_number, image.side, decode(image.content, 'base64')
      from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as image(tag_number smallint, side text, content text)
    on conflict do nothing`;
}

async function saveMerchantImages(sql, orderId, tagNumber, previews, forPrinting = false) {
  checkOrderId(orderId);
  if (!Number.isInteger(tagNumber) || tagNumber < 1 || tagNumber > 20 ||
      !Array.isArray(previews) || previews.length !== (forPrinting ? printSides.length : 2)) {
    throw fail(422, 'invalid_review_images');
  }
  const [order] = await sql`select cardinality(profile_slugs) as tag_count
    from public.tsun_merchant_orders where merchant_order_id = ${orderId}`;
  if (!order || tagNumber > order.tag_count) throw fail(404, 'order_missing');
  const rows = forPrinting ? printSides.map((side, index) => {
    const image = pngContent(previews[index], printImageLimit);
    // PNG colour types 4 and 6 store an alpha channel.
    if (image.length < 33 || image.toString('ascii', 12, 16) !== 'IHDR' ||
        ![4, 6].includes(image[25])) throw fail(422, 'invalid_print_image');
    return {tag_number: tagNumber, side, content: image.toString('base64')};
  }) : imageRows(previews, tagNumber);
  await insertImages(sql, orderId, rows);
}

async function loadMerchantPrintFiles(sql, orderId, items) {
  const stored = await sql`select tag_number, side, encode(image_png, 'base64') as content
    from public.tsun_order_review_images
    where merchant_order_id = ${orderId} and side in ('print_front', 'print_back', 'print_dog')`;
  const files = new Map(stored.map(file => [file.tag_number + ':' + file.side, file.content]));
  return items.flatMap((item, index) => {
    const tag = String(index + 1).padStart(2, '0');
    const name = String(item.petName || 'Tag').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 50) || 'Tag';
    const labels = ['01-正面底板', '02-完整背面', '03-狗狗頭像'];
    return printSides.map((side, i) => {
      const content = files.get((index + 1) + ':' + side);
      if (!content) throw fail(409, 'print_images_incomplete');
      return {filename: tag + '-' + name + '-' + labels[i] + '.png', content, content_type: 'image/png'};
    });
  });
}

function paidProfiles(order) {
  const profile = order.cloudProfile;
  try {
    const url = new URL(profile?.publicUrl);
    const slug = url.searchParams.get('p');
    if (url.protocol !== 'https:' || !['8tsun8.com', 'www.8tsun8.com', 'tsun88-nfc-l86b.vercel.app'].includes(url.host) ||
        url.username || url.password || url.pathname !== '/lucky88.html' ||
        !/^[A-F0-9]{12}$/.test(slug || '') || (profile.publicSlug && profile.publicSlug !== slug)) {
      throw new Error('Invalid profile');
    }
    const profileUrl = new URL('/lucky88.html', 'https://www.8tsun8.com');
    profileUrl.searchParams.set('p', slug);
    const base = [url.searchParams.get('b'), url.searchParams.get('base')].find(value => value && /^[a-z0-9_-]{1,40}$/i.test(value));
    if (base) profileUrl.searchParams.set('base', base);
    return [{name: String(order.petName || order.items?.[0]?.petName || 'Pet').slice(0, 80), url: profileUrl.href}];
  } catch {
    throw fail(422, 'invalid_review_profile');
  }
}

async function storePaidReview(sql, provider, order, previews) {
  if (!providers.has(provider) || provider === 'merchant' || order.paymentStatus !== 'paid') throw fail(422, 'invalid_review_provider');
  const orderId = checkOrderId(order.id);
  if (!Array.isArray(order.items) || order.items.length * 2 !== previews?.length) throw fail(422, 'invalid_review_images');
  const profiles = paidProfiles(order);
  const rows = imageRows(previews);
  const items = order.items.map(item => ({petName: String(item.petName || 'Pet').slice(0, 80)}));
  await sql.transaction([
    sql`insert into public.tsun_order_reviews (merchant_order_id, payment_provider, profiles, items)
      values (${orderId}, ${provider}, ${JSON.stringify(profiles)}::jsonb, ${JSON.stringify(items)}::jsonb)
      on conflict do nothing`,
    insertImages(sql, orderId, rows)
  ]);
}

// The callers must authenticate the payment with its provider first. Preview
// never uses the production writer connection supplied to the storefront.
async function publishPaidReview(provider, order, previews, env = process.env) {
  if (env.VERCEL_ENV !== 'production' || env.MERCHANT_ORDER_REVIEW_ENABLED !== '1') return;
  if (!env.PRODUCTION_QUEUE_DATABASE_URL) throw fail(503, 'order_review_unavailable');
  const sql = postgres(env.PRODUCTION_QUEUE_DATABASE_URL);
  const [profile] = paidProfiles(order);
  const slug = new URL(profile.url).searchParams.get('p');
  const linked = await sql`select public_slug from public.pet_profiles
    where order_id = ${checkOrderId(order.id)} and public_slug = ${slug} and is_published`;
  if (!linked.length) throw fail(422, 'invalid_review_profile');
  await storePaidReview(sql, provider, order, previews);
}

async function listReviews(sql, orderId = '') {
  if (orderId !== '') checkOrderId(orderId);
  return sql`with entries as (
    select merchant_order_id, payment_provider, created_at from public.tsun_order_reviews
    union all
    select merchant_order_id, 'merchant', created_at from public.tsun_merchant_orders
    union all
    select q.merchant_order_id, q.payment_provider, q.created_at from public.tsun_production_jobs q
      where not exists (select 1 from public.tsun_order_reviews r where r.merchant_order_id = q.merchant_order_id)
      and not exists (select 1 from public.tsun_merchant_orders o where o.merchant_order_id = q.merchant_order_id)
  )
  select e.merchant_order_id as id, e.payment_provider as provider, e.created_at, q.status as queue_status,
    coalesce(o.order_details->'items'->0->>'petName', r.items->0->>'petName') as pet_name,
    o.notification_status
  from entries e
  left join public.tsun_merchant_orders o using (merchant_order_id)
  left join public.tsun_order_reviews r using (merchant_order_id)
  left join public.tsun_production_jobs q using (merchant_order_id)
  where (${orderId} = '' or e.merchant_order_id = ${orderId})
  order by e.created_at desc, e.merchant_order_id desc limit 100`;
}

async function loadReview(sql, orderId) {
  checkOrderId(orderId);
  const [row] = await listReviews(sql, orderId);
  if (!row) throw fail(404, 'order_missing');
  const [merchant] = row.provider === 'merchant' ? await sql`select profile_slugs, order_details->'items' as items
    from public.tsun_merchant_orders where merchant_order_id = ${orderId}` : [];
  const [paid] = row.provider !== 'merchant' ? await sql`select profiles, items
    from public.tsun_order_reviews where merchant_order_id = ${orderId}` : [];
  const images = await sql`select tag_number, side from public.tsun_order_review_images
    where merchant_order_id = ${orderId} order by tag_number, side desc`;
  return {...row, merchant, paid, images};
}

async function loadImage(sql, orderId, tag, side) {
  checkOrderId(orderId);
  if (!/^(?:[1-9]|1[0-9]|20)$/.test(tag) || !['front', 'back'].includes(side)) throw fail(404, 'image_missing');
  const [row] = await sql`select image_png from public.tsun_order_review_images
    where merchant_order_id = ${orderId} and tag_number = ${Number(tag)} and side = ${side}`;
  if (!row) throw fail(404, 'image_missing');
  return row.image_png;
}

module.exports = {saveMerchantImages, loadMerchantPrintFiles, storePaidReview, publishPaidReview, listReviews, loadReview, loadImage};
