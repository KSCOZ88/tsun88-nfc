'use strict';

const {createHash, createHmac, timingSafeEqual} = require('node:crypto');
const {escape, safeUrl} = require('./email-template');
const {GMAIL_ADDRESS} = require('./gmail-mailer');
const {postgres} = require('./postgres');

const COOKIE = '__Host-tsun_merchant_preview';
const SESSION_SECONDS = 60 * 60;

function failure(status, code) {
  return Object.assign(new Error(code), {status, code});
}

function configuration(env = process.env) {
  if (env.VERCEL_ENV !== 'preview' || !env.MERCHANT_PREVIEW_DATABASE_URL ||
      !/^[0-9a-f]{64}$/.test(env.MERCHANT_PREVIEW_ACCESS_KEY || '') ||
      !/^[0-9a-f]{64}$/.test(env.MERCHANT_PREVIEW_SESSION_SECRET || '')) {
    throw failure(404, 'not_available');
  }
  const connection = new URL(env.MERCHANT_PREVIEW_DATABASE_URL);
  if (!connection.hostname.endsWith('.pooler.supabase.com') ||
      !/^merchant_order_preview\.[a-z]{20}$/.test(connection.username) ||
      connection.username.endsWith('.zujdfvnhxbalyhjmmmtl') ||
      connection.searchParams.get('sslmode') !== 'verify-full') {
    throw failure(503, 'invalid_preview_database');
  }
  return {
    connection: env.MERCHANT_PREVIEW_DATABASE_URL,
    key: env.MERCHANT_PREVIEW_ACCESS_KEY,
    signingKey: env.MERCHANT_PREVIEW_SESSION_SECRET
  };
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

function validateSubmission(input) {
  const {id, customerEmail, shipping, items} = input || {};
  if (typeof id !== 'string' || !/^TEST-M-[0-9a-f]{32}$/.test(id)) throw failure(422, 'invalid_id');
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

function profileLinks(saved, origin) {
  return saved.profile_slugs.map((slug, index) => {
    const design = saved.order_details.items[index];
    const url = new URL('/merchant-profile', origin);
    url.searchParams.set('p', slug);
    url.searchParams.set('base', design.baseVariant);
    return {name: design.petName, url: url.href};
  });
}

function buildMerchantMessage(id, order, links) {
  const profiles = links.map(({name, url}) =>
    `<li><a href="${escape(safeUrl(url))}">${escape(name)}</a></li>`).join('');
  const address = [order.shipName, order.shipPhone, order.shipAddress].map(escape).join('<br>');
  return {
    to: [process.env.MERCHANT_EMAIL || GMAIL_ADDRESS],
    subject: '[測試] 8TSUN8 商家免付款訂單 | ' + id,
    html: `<h2>商家免付款訂單</h2><p>訂單編號 ${escape(id)}<br>狗牌 ${links.length} 件<br>客戶電郵 ${escape(order.customerEmail)}</p><p>${address}</p><h3>NFC 寵物檔案</h3><ul>${profiles}</ul><p>測試訂單已進入預覽生產隊列，狀態為等待素材。</p>`
  };
}

async function createOrder(sql, input, origin) {
  const {id, hash, order, profiles} = validateSubmission(input);
  let saved;
  try {
    [saved] = await sql`select * from public.create_merchant_preview_order(
      ${id}, ${hash}, ${JSON.stringify(order)}::jsonb, ${JSON.stringify(profiles)}::jsonb)`;
  } catch (error) {
    if (error.code === '23505') throw failure(409, 'order_changed');
    throw error;
  }
  const links = profileLinks(saved, origin);
  if (saved.notification_status === 'pending') {
    const message = buildMerchantMessage(id, saved.order_details, links);
    await sql`update public.tsun_merchant_orders
      set notification_status = 'captured', notification_message = ${JSON.stringify(message)}::jsonb
      where merchant_order_id = ${id} and notification_status = 'pending'`;
  }
  return {id, paymentStatus: 'not_required', queueStatus: 'awaiting_assets', notificationStatus: 'captured', profiles: links};
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
      if (req.method === 'GET') {
        if (req.query?.profile) {
          if (!authenticated) throw failure(401, 'sign_in_required');
          return res.status(200).json(await loadProfile(getDb(config.connection), req.query.profile));
        }
        return res.status(200).json({authenticated});
      }
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        throw failure(405, 'method_not_allowed');
      }
      const origin = 'https://' + req.headers.host;
      if (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
        throw failure(403, 'invalid_origin');
      }
      if (req.body?.action === 'login') {
        res.setHeader('Set-Cookie', signIn(req.body.key, config));
        return res.status(200).json({authenticated: true});
      }
      if (req.body?.action === 'logout') {
        res.setHeader('Set-Cookie', sessionCookie('', 0));
        return res.status(200).json({authenticated: false});
      }
      if (!authenticated) throw failure(401, 'sign_in_required');
      if (req.body?.action !== 'submit') throw failure(400, 'invalid_action');
      const result = await createOrder(getDb(config.connection), req.body.order, origin);
      return res.status(200).json(result);
    } catch (error) {
      if (!error.status) console.error('[Merchant preview]', /^[a-z0-9_]{1,50}$/i.test(error.code || '') ? error.code : 'unknown');
      return res.status(error.status || 503).json({error: error.status ? error.code : 'temporarily_unavailable'});
    }
  };
}

module.exports = {makeHandler, configuration, signIn, isSignedIn, validateSubmission};
