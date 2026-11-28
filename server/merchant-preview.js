'use strict';

const {createHash, createHmac, timingSafeEqual} = require('node:crypto');
const {escape, safeUrl} = require('./email-template');
const {GMAIL_ADDRESS, sendGmail} = require('./gmail-mailer');
const {historyPageSize, saveMerchantImages, loadMerchantPrintFiles, listReviews, loadReview, loadImage, printFiles} = require('./order-review');
const {postgres} = require('./postgres');
const {salesSummary} = require('./merchant-sales');
const {shippingLabelAttachment, shippingLabelPrintTip} = require('./shipping-label');
const {completeHongKongAddress} = require('./hong-kong-district');
const {namedPath} = require('../assets/tsun-profile-url');

const COOKIE = '__Host-tsun_merchant_preview';
const SESSION_SECONDS = 60 * 60;

function failure(status, code) {
  return Object.assign(new Error(code), {status, code});
}

function configuration(env = process.env) {
  const preview = env.VERCEL_ENV === 'preview';
  const production = env.VERCEL_ENV === 'production' && env.MERCHANT_ORDERS_ENABLED === '1';
  const connection = preview ? env.MERCHANT_PREVIEW_DATABASE_URL : env.MERCHANT_ORDERS_DATABASE_URL;
  const key = preview ? env.MERCHANT_PREVIEW_ACCESS_KEY : env.MERCHANT_ORDERS_ACCESS_KEY;
  const signingKey = preview ? env.MERCHANT_PREVIEW_SESSION_SECRET : env.MERCHANT_ORDERS_SESSION_SECRET;
  if ((!preview && !production) || !connection ||
      !/^[0-9a-f]{64}$/.test(key || '') || !/^[0-9a-f]{64}$/.test(signingKey || '')) {
    throw failure(404, 'not_available');
  }
  const db = new URL(connection);
  const productionProject = 'zujdfvnhxbalyhjmmmtl';
  const correctUser = preview
    ? /^merchant_order_preview\.[a-z]{20}$/.test(db.username) && !db.username.endsWith('.' + productionProject)
    : db.username === 'merchant_order_store.' + productionProject;
  if (db.protocol !== 'postgresql:' || !db.hostname.endsWith('.pooler.supabase.com') ||
      !correctUser || db.searchParams.get('sslmode') !== 'verify-full') {
    throw failure(503, 'invalid_preview_database');
  }
  return {connection, key, signingKey, preview};
}

function validOrderId(id, preview) {
  const pattern = preview ? /^TEST-M-[0-9a-f]{32}$/ : /^M-[0-9a-f]{32}$/;
  return typeof id === 'string' && pattern.test(id);
}

function equal(left, right) {
  return timingSafeEqual(
    createHash('sha256').update(left).digest(),
    createHash('sha256').update(right).digest()
  );
}

function sessionCookie(token, age) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
}

function signature(expires, config) {
  return createHmac('sha256', config.signingKey).update(expires).digest('hex');
}

function signIn(key, config, now = Date.now()) {
  if (typeof key !== 'string' || key.length !== 64 || !equal(key, config.key)) {
    throw failure(401, 'invalid_key');
  }
  const expires = String(Math.floor(now / 1000) + SESSION_SECONDS);
  return sessionCookie(expires + '.' + signature(expires, config), SESSION_SECONDS);
}

function isSignedIn(header, config, now = Date.now()) {
  const session = String(header || '').split(';').map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith(COOKIE + '='));
  const match = session?.slice(COOKIE.length + 1).match(/^(\d{10})\.([0-9a-f]{64})$/);
  return !!match && Number(match[1]) > now / 1000 && equal(match[2], signature(match[1], config));
}

function field(value, limit, name, required = false) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.length <= limit && (!required || text)) return text;
  } else if (value == null && !required) {
    return '';
  }
  throw failure(422, 'invalid_' + name);
}

const profileFields = {
  pet_name: 50, gender: 30, neutered: 30, breed: 100, birth_date: 30, coat_marks: 300,
  owner_name: 80, owner_phone: 40, backup_owner_name: 80, backup_phone: 40, location: 200,
  owner_message: 1000, diet: 500, personality: 500, clinic: 150, clinic_phone: 40, photo_data: 1200000
};
const profileRequired = new Set(['pet_name', 'breed', 'owner_phone', 'backup_owner_name', 'backup_phone']);
const designFields = ['contactFont', 'baseVariant', 'baseLabel', 'faceKey', 'selectedBreedKey', 'selectedBreedColor'];

function validateSubmission(input, preview = true) {
  const {id, customerEmail, shipping, items} = input || {};
  if (!validOrderId(id, preview)) throw failure(422, 'invalid_id');
  if (!Array.isArray(items) || items.length < 1 || items.length > 20) throw failure(422, 'invalid_items');
  const email = field(customerEmail, 254, 'customer_email', true);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw failure(422, 'invalid_customer_email');
  const shipPhone = field(shipping?.phone, 40, 'shipping_phone', true);
  if (!/^\+?[\d ()-]{8,24}$/.test(shipPhone) || shipPhone.replace(/\D/g, '').length < 8) {
    throw failure(422, 'invalid_shipping_phone');
  }
  const profiles = items.map(item => {
    const profile = Object.fromEntries(Object.entries(profileFields).map(([name, limit]) =>
      [name, field(item?.profile?.[name], limit, name, profileRequired.has(name))]));
    if (profile.photo_data && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(profile.photo_data)) {
      throw failure(422, 'invalid_photo_data');
    }
    return profile;
  });
  let decorCount = 0;
  const designs = items.map((item, index) => {
    const design = Object.fromEntries(designFields.map(name => [name, field(item?.[name], 100, name)]));
    if (!design.baseVariant || !design.faceKey) throw failure(422, 'invalid_design');
    const decorItems = {};
    for (const side of ['front', 'back']) {
      const decorations = item.decorItems?.[side];
      if (!Array.isArray(decorations) || (decorCount += decorations.length) > 240) {
        throw failure(422, 'invalid_decorations');
      }
      decorItems[side] = decorations.map(decor => {
        if (!Number.isFinite(decor?.x) || !Number.isFinite(decor?.y) ||
            decor.x < 0 || decor.x > 100 || decor.y < 0 || decor.y > 100 ||
            !Number.isInteger(decor.slot) || decor.slot < 1 || decor.slot > 6) {
          throw failure(422, 'invalid_decoration_position');
        }
        return {key: field(decor.key, 60, 'decoration', true), color: field(decor.color, 60, 'decoration_color'),
          x: decor.x, y: decor.y, slot: decor.slot, side};
      });
    }
    const {pet_name: petName, owner_name: ownerName, owner_phone: ownerPhone, breed} = profiles[index];
    return {...design, petName, ownerName, ownerPhone, breed, decorItems};
  });
  const order = {
    customerEmail: email,
    shipName: field(shipping?.name, 120, 'shipping_name', true),
    shipPhone,
    shipAddress: field(shipping?.address, 1000, 'shipping_address', true),
    language: input.language === 'zh-Hant' ? 'zh-Hant' : 'en',
    items: designs
  };
  const hash = createHash('sha256').update(JSON.stringify({order, profiles})).digest('hex');
  return {id, order, profiles, hash};
}

function profileLinks(saved, origin, preview = true) {
  return saved.profile_slugs.map((slug, index) => {
    const design = saved.order_details.items[index];
    const url = preview
      ? new URL('/merchant-profile', origin)
      : new URL(namedPath(slug, design.petName, design.ownerName), 'https://www.8tsun8.com');
    if (preview) url.searchParams.set('p', slug);
    url.searchParams.set('base', design.baseVariant);
    return {name: design.petName, url: url.href};
  });
}

function addressKey(value) {
  return value.normalize('NFKC').toLowerCase().replace(/[\s,，]+/g, ' ').trim();
}

function merchantDeliveryDetails(order, profiles) {
  const reference = profiles[0];
  const location = reference?.location?.trim();
  const address = location?.normalize('NFKC');
  const street = /\b\d+[a-z]?(?:[-/]\d+[a-z]?)?\s+[^\r\n]{1,120}\b(?:road|rd|street|st|lane|ln|avenue|ave|drive|dr|court|ct|way|place|pl|terrace|close|crescent|boulevard|blvd)\b/i;
  const number = /\d+\s*[a-z]?\s*[號号樓楼室]/i;
  if (!address || (!street.test(address) && !number.test(address)) ||
      !profiles.every(profile => profile?.location?.trim() === location)) return order;
  const orderAddress = addressKey(order.shipAddress || '');
  const profileAddress = addressKey(location);
  const includesProfileAddress = /[\p{Script=Han}]/u.test(location)
    ? orderAddress.replaceAll(' ', '').includes(profileAddress.replaceAll(' ', ''))
    : (' ' + orderAddress + ' ').includes(' ' + profileAddress + ' ');
  // Preserve locality and postal details from checkout when it names the same address.
  const shipAddress = includesProfileAddress && orderAddress.length > profileAddress.length
    ? order.shipAddress : location;
  return {...order, shipName: reference.owner_name?.trim() || order.shipName,
    shipPhone: reference.owner_phone?.trim() || '', shipAddress};
}

function buildMerchantMessage(id, order, links, origin, preview = true, hasAttachments = false, addressLabel = false) {
  const language = order.language === 'zh-Hant' ? '繁體中文' : 'English';
  const profiles = links.map(({name, url}) => {
    const profileUrl = escape(safeUrl(url));
    return `<li>${escape(name)}（${language}）<br><a href="${profileUrl}">${profileUrl}</a></li>`;
  }).join('');
  const address = [order.shipName, order.shipPhone, order.shipAddress].filter(Boolean).map(escape).join('<br>');
  const review = new URL('/merchant/orders', origin);
  review.searchParams.set('order', id);
  return {
    to: [GMAIL_ADDRESS],
    subject: (preview ? '[測試] ' : '') + '8TSUN8 商家免付款訂單 | ' + id,
    html: `<h2>商家免付款訂單</h2><p>訂單編號 ${escape(id)}<br>狗牌 ${links.length} 件<br>客戶電郵 ${escape(order.customerEmail)}</p><p>${address.replaceAll('\n', '<br>')}</p>${order.shippingDistrictUnverified ? '<p><strong>香港區名待核對。</strong> 地址標籤使用原填資料。</p>' : ''}${hasAttachments ? '<p>每枚狗牌提供四張透明 PNG：正面底板、完整背面、獨立狗狗頭像及正反面並排圖。</p>' : ''}${addressLabel ? shippingLabelPrintTip : ''}<h3>NFC 寵物檔案</h3><ul>${profiles}</ul><p><a href="${escape(review.href)}">在商家後台查看狗牌正反面和檔案</a></p><p>${preview ? '測試訂單已進入預覽生產隊列。' : '訂單已進入生產隊列。'}</p>`
  };
}

function receipt(saved, origin, notificationStatus, preview) {
  return {id: saved.merchant_order_id, paymentStatus: 'not_required', queueStatus: 'awaiting_assets',
    notificationStatus, profiles: profileLinks(saved, origin, preview)};
}

async function captureNotice(sql, id, saved, origin, attachments = []) {
  if (saved.notification_status !== 'pending') return saved.notification_status;
  const order = saved.delivery || saved.order_details;
  const addressLabel = await shippingLabelAttachment(order, {threeAcross: true});
  const message = buildMerchantMessage(id, order, profileLinks(saved, origin), origin, true,
    attachments.length > 0, Boolean(addressLabel));
  const files = addressLabel ? [...attachments, addressLabel] : attachments;
  if (files.length) message.attachments = files.map(({filename, content_type}) => ({filename, content_type}));
  await sql`update public.tsun_merchant_orders
    set notification_status = 'captured', notification_message = ${JSON.stringify(message)}::jsonb
    where merchant_order_id = ${id} and notification_status = 'pending'`;
  return 'captured';
}

const printFilesPerTag = 4;
// Leave room for MIME headers and line wrapping when sending through Gmail.
const printMailBudget = 23000000;

function selectPrintAttachments(attachments, firstAttachment, reservedBytes) {
  let lastAttachment = firstAttachment;
  let length = reservedBytes;
  for (; lastAttachment < attachments.length; lastAttachment += printFilesPerTag) {
    const tag = attachments.slice(lastAttachment, lastAttachment + printFilesPerTag);
    const size = tag.reduce((sum, file) => sum + file.content.length, 0);
    if (length + size > printMailBudget) break;
    length += size;
  }
  return lastAttachment;
}

function printDownloadNotice(id, origin) {
  const url = new URL('/merchant/orders', origin);
  url.searchParams.set('order', id);
  url.hash = 'merchant-print-files';
  return '<p>此訂單的部分製作圖片可在商家後台下載。' +
    `<a href="${escape(url.href)}">登入後下載原尺寸 PNG</a></p>`;
}

async function notifyReviewedOrder(sql, id, saved, origin, attachments, env = process.env, deliver = sendGmail) {
  const preview = env.VERCEL_ENV !== 'production';
  // A branch can deliver a test message only to its explicitly configured
  // merchant mailbox. Normal preview deployments capture the message locally.
  if (preview && env.MERCHANT_REVIEW_EMAIL_MODE !== 'smtp') {
    return captureNotice(sql, id, saved, origin, attachments);
  }
  if (saved.notification_status === 'sent') return 'sent';
  const recipient = preview ? env.MERCHANT_REVIEW_TEST_RECIPIENT : GMAIL_ADDRESS;
  if (!recipient || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipient) || !env.SMTP_APP_PASSWORD) {
    return 'pending';
  }
  const order = saved.delivery || saved.order_details;
  const addressLabel = await shippingLabelAttachment(order, {threeAcross: true});
  const message = buildMerchantMessage(id, order, profileLinks(saved, origin, preview), origin, preview, true);
  message.to = [recipient];
  const [claim] = await sql`update public.tsun_merchant_orders
    set notification_status = 'sending', notification_lease_until = now() + interval '2 minutes',
        notification_message = ${JSON.stringify(message)}::jsonb ||
          jsonb_build_object('sent_attachment_count', coalesce(notification_message->'sent_attachment_count', '0'::jsonb))
    where merchant_order_id = ${id} and (notification_status in ('pending', 'captured')
      or (notification_status = 'sending' and notification_lease_until < now()))
    returning merchant_order_id, notification_lease_until::text as lease,
      (notification_message->>'sent_attachment_count')::integer as sent_attachment_count`;
  if (!claim) return 'sending';

  const sent = claim.sent_attachment_count || 0;
  if (sent >= attachments.length) return 'sent';
  const label = sent === 0 ? addressLabel : null;
  const last = selectPrintAttachments(attachments, sent, label?.content.length || 0);
  const files = attachments.slice(sent, last);
  const downloads = last < attachments.length ? printDownloadNotice(id, origin) : '';
  let delivered = false;
  try {
    delivered = (await deliver({...message,
      html: message.html + (label ? shippingLabelPrintTip : '') + downloads,
      attachments: label ? [...files, label] : files},
    'tsun-merchant-' + id + (sent ? '-' + sent : ''))).sent;
  } catch (error) {
    console.error('[Merchant order] SMTP delivery failed', /^[a-z0-9_]{1,40}$/i.test(error?.code || '') ? error.code : 'unknown');
  }
  const status = delivered ? 'sent' : 'pending';
  const count = delivered ? last : sent;
  const [recorded] = await sql`update public.tsun_merchant_orders
    set notification_status = ${status},
        notification_message = jsonb_set(notification_message, '{sent_attachment_count}', to_jsonb(${count}::integer)),
        notification_lease_until = null
    where merchant_order_id = ${id} and notification_status = 'sending'
      and notification_lease_until = ${claim.lease}::timestamptz
    returning merchant_order_id`;
  return recorded ? status : 'sending';
}

async function createOrder(sql, input, origin, deferNotice, preview) {
  const {id, hash, order, profiles} = validateSubmission(input, preview);
  const localizedProfiles = profiles.map((profile, index) => ({
    ...profile, profile_language: order.language, base_variant: order.items[index].baseVariant
  }));
  let saved;
  try {
    [saved] = await sql`select * from public.create_merchant_preview_order(
      ${id}, ${hash}, ${JSON.stringify(order)}::jsonb, ${JSON.stringify(localizedProfiles)}::jsonb)`;
  } catch (error) {
    if (error.code === '23505') throw failure(409, 'order_changed');
    throw error;
  }
  if (!deferNotice) saved.delivery = merchantDeliveryDetails(saved.order_details, localizedProfiles);
  const status = deferNotice ? saved.notification_status : await captureNotice(sql, id, saved, origin);
  return receipt({...saved, merchant_order_id: id}, origin, status, preview);
}

async function finishReview(sql, id, origin, preview) {
  if (!validOrderId(id, preview)) throw failure(422, 'invalid_id');
  const [saved] = await sql`select * from public.tsun_merchant_orders where merchant_order_id = ${id}`;
  if (!saved) throw failure(404, 'order_missing');
  if (saved.notification_status === 'sent') return receipt(saved, origin, 'sent', preview);
  const [images] = await sql`select count(*)::integer as total from public.tsun_order_review_images
    where merchant_order_id = ${id} and side in ('front', 'back')`;
  if (images.total !== saved.profile_slugs.length * 2) throw failure(409, 'images_incomplete');
  const attachments = await loadMerchantPrintFiles(sql, id, saved.order_details.items);
  const profiles = await sql`select profile->>'location' as location, profile->>'owner_name' as owner_name,
      profile->>'owner_phone' as owner_phone
    from unnest(${saved.profile_slugs}::text[]) with ordinality as slugs(slug, tag_number)
    cross join lateral (select public.get_pet_profile(slug) as profile offset 0) as pet
    order by tag_number`;
  saved.delivery = await completeHongKongAddress(merchantDeliveryDetails(saved.order_details, profiles));
  return receipt(saved, origin, await notifyReviewedOrder(sql, id, saved, origin, attachments), preview);
}

async function loadProfile(sql, slug) {
  if (typeof slug !== 'string' || !/^[A-F0-9]{12}$/.test(slug)) throw failure(404, 'profile_missing');
  const [row] = await sql`select public.get_pet_profile(${slug}) as profile
    where exists (select 1 from public.tsun_merchant_orders where ${slug} = any(profile_slugs))`;
  if (!row?.profile) throw failure(404, 'profile_missing');
  return row.profile;
}

function makeHandler({getConfig = configuration, getDb = postgres} = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    try {
      const config = getConfig();
      const authenticated = isSignedIn(req.headers.cookie, config);
      const preview = config.preview !== false;
      const origin = 'https://' + req.headers.host;
      if (req.method === 'GET') {
        if (req.query?.profile) {
          if (!authenticated) throw failure(401, 'sign_in_required');
          return res.status(200).json(await loadProfile(getDb(config.connection), req.query.profile));
        }
        if (req.query?.reviews === '1' || req.query?.sales === '1' || req.query?.review || req.query?.image) {
          if (!authenticated) throw failure(401, 'sign_in_required');
          const sql = getDb(config.connection);
          if (req.query.image) {
            const image = await loadImage(sql, req.query.image, req.query.tag, req.query.side);
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            if (printFiles.includes(req.query.side)) {
              res.setHeader('Content-Disposition', `attachment; filename="8TSUN8-${req.query.tag}-${req.query.side}.png"`);
            }
            return res.status(200).send(image);
          }
          if (req.query.review) {
            const detail = await loadReview(sql, req.query.review);
            const {merchant, paid, ...review} = detail;
            const profiles = merchant ? profileLinks({profile_slugs: merchant.profile_slugs,
              order_details: {items: merchant.items}}, origin, preview) : paid?.profiles || [];
            return res.status(200).json({...review, profiles, items: merchant?.items || paid?.items || []});
          }
          if (req.query.sales === '1') return res.status(200).json(await salesSummary(sql, req.query));
          const requested = req.query.page ?? '1';
          if (typeof requested !== 'string' || !/^[1-9][0-9]{0,5}$/.test(requested)) {
            throw failure(422, 'invalid_history_page');
          }
          const page = Number(requested);
          const rows = await listReviews(sql, '', page);
          return res.status(200).json({orders: rows.slice(0, historyPageSize), page, hasMore: rows.length > historyPageSize});
        }
        return res.status(200).json({authenticated, preview});
      }
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        throw failure(405, 'method_not_allowed');
      }
      if (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
        throw failure(403, 'invalid_origin');
      }
      if (req.body?.action === 'login') {
        res.setHeader('Set-Cookie', signIn(req.body.key, config));
        return res.status(200).json({authenticated: true, preview});
      }
      if (req.body?.action === 'logout') {
        res.setHeader('Set-Cookie', sessionCookie('', 0));
        return res.status(200).json({authenticated: false});
      }
      if (!authenticated) throw failure(401, 'sign_in_required');
      const sql = getDb(config.connection);
      const {action, order, review, orderId, tagNumber, previews} = req.body || {};
      if (action === 'resend-production-mail') {
        if (preview) throw failure(404, 'not_available');
        const detail = await loadReview(sql, orderId);
        if (detail.provider !== 'airwallex' || !detail.paid?.profiles?.length) {
          throw failure(409, 'production_assets_missing');
        }
        const legacy = req.body.legacy;
        if (legacy && Buffer.byteLength(JSON.stringify(legacy)) > 4 * 1024 * 1024) {
          throw failure(413, 'production_assets_too_large');
        }
        const {resendProductionMail} = require('./airwallex-production-mail');
        return res.status(200).json(await resendProductionMail(orderId, legacy, detail.paid.profiles[0].url));
      }
      if (action === 'save-review-images' || action === 'save-print-images') {
        await saveMerchantImages(sql, orderId, tagNumber, previews, action === 'save-print-images');
        return res.status(200).json({saved: true});
      }
      if (action === 'finish-review') return res.status(200).json(await finishReview(sql, orderId, origin, preview));
      if (action !== 'submit') throw failure(400, 'invalid_action');
      return res.status(200).json(await createOrder(sql, order, origin, !preview || review === true, preview));
    } catch (error) {
      if (!error.status) console.error('[Merchant preview]', /^[a-z0-9_]{1,50}$/i.test(error.code || '') ? error.code : 'unknown');
      return res.status(error.status || 503).json({error: error.status ? error.code : 'temporarily_unavailable'});
    }
  };
}

module.exports = {makeHandler, configuration, signIn, isSignedIn, validateSubmission, merchantDeliveryDetails, profileLinks, buildMerchantMessage, notifyReviewedOrder};
