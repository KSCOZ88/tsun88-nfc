'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {configuration, makeHandler, isSignedIn, signIn} = require('../server/merchant-preview');

const now = 1795348800000;
const config = {key: 'a'.repeat(64), signingKey: 'b'.repeat(64), connection: 'test'};
const host = 'merchant-preview.example.test';
const origin = 'https://' + host;
const id = 'TEST-M-' + 'c'.repeat(32);
const order = {
  id, customerEmail: 'customer@example.test', shipping: {name: 'Test recipient', phone: '+85221234567',
    address: 'Flat 12, 14/F, Block B, Test Street'},
  language: 'zh-Hant',
  items: [{
    baseVariant: 'green1', faceKey: 'corgi', decorItems: {front: [], back: []},
    profile: {pet_name: 'Preview pet', breed: 'Corgi', owner_phone: '+85221234567',
      backup_owner_name: 'Test contact', backup_phone: '+85221234568', diet: 'No chocolate'}
  }]
};

async function send(handler, {method = 'POST', body, cookie, from = origin, query} = {}) {
  const req = {method, body, query, headers: {host, origin: from, cookie, 'content-type': 'application/json'}};
  const result = {headers: {}};
  const res = {
    setHeader(key, value) { result.headers[key] = value; },
    status(code) { result.status = code; return this; },
    json(data) { result.data = data; return this; }
  };
  await handler(req, res);
  return result;
}

test('only preview can use the merchant role in a non-production database', () => {
  const env = {VERCEL_ENV: 'preview', MERCHANT_PREVIEW_ACCESS_KEY: config.key,
    MERCHANT_PREVIEW_SESSION_SECRET: config.signingKey};
  const url = ref => 'postgresql://merchant_order_preview.' + ref +
    ':password@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=verify-full';
  env.MERCHANT_PREVIEW_DATABASE_URL = url('rziyucbmascwdrtwqvgy');
  assert.equal(configuration(env).connection, env.MERCHANT_PREVIEW_DATABASE_URL);
  assert.throws(() => configuration({...env, VERCEL_ENV: 'production'}), {status: 404});
  assert.throws(() => configuration({...env, MERCHANT_PREVIEW_DATABASE_URL: url('zujdfvnhxbalyhjmmmtl')}), {status: 503});
});

test('merchant session rejects bad credentials, tampering and expired sessions', () => {
  assert.throws(() => signIn('x'.repeat(64), config, now), {status: 401});
  const cookie = signIn(config.key, config, now);
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
  assert.ok(isSignedIn(cookie, config, now));
  assert.equal(isSignedIn(cookie.replace(/\.([a-f0-9])/, (_, char) => char === 'a' ? '.b' : '.a'), config, now), false);
  assert.equal(isSignedIn(cookie, config, now + 3600000), false);
});

test('invalid origins and unauthenticated requests never open the database', async () => {
  const handler = makeHandler({
    getConfig: () => config, getDb: () => assert.fail('unexpected database access')
  });
  assert.equal((await send(handler, {body: {action: 'submit', order}})).status, 401);
  assert.equal((await send(handler, {body: {action: 'login', key: config.key}, from: 'https://other.example.test'})).status, 403);
  assert.equal((await send(handler, {method: 'GET', query: {profile: 'ABCDEF012345'}})).status, 401);
});

test('validated orders only capture one merchant notification and replay the same profile', async () => {
  let saved;
  let captured;
  let captureCount = 0;
  const sql = async (strings, ...values) => {
    const statement = strings.join('');
    if (statement.includes('create_merchant_preview_order')) {
      const [savedId, hash, details, profiles] = values;
      assert.equal(savedId, id);
      assert.equal(JSON.parse(profiles)[0].diet, 'No chocolate');
      if (saved && saved.request_hash !== hash) throw Object.assign(new Error('Changed'), {code: '23505'});
      saved ||= {request_hash: hash, order_details: JSON.parse(details), notification_status: 'pending',
        profile_slugs: ['ABCDEF012345']};
      return [saved];
    }
    assert.match(statement, /where merchant_order_id = .*notification_status = 'pending'/s);
    captureCount += 1;
    captured = JSON.parse(values[0]);
    saved.notification_status = 'captured';
    return [];
  };
  const handler = makeHandler({getConfig: () => config, getDb: () => sql});
  const cookie = (await send(handler, {body: {action: 'login', key: config.key}})).headers['Set-Cookie'];
  const payload = {action: 'submit', order};
  const first = await send(handler, {body: payload, cookie});
  assert.equal(first.status, 200);
  assert.equal(first.data.paymentStatus, 'not_required');
  assert.equal(first.data.queueStatus, 'awaiting_assets');
  assert.match(first.data.profiles[0].url, /\/merchant-profile\?p=ABCDEF012345/);
  assert.equal(captureCount, 1);
  assert.equal(captured.to.length, 1);
  assert.doesNotMatch(captured.to[0], /^customer@/);
  assert.match(captured.subject, /^\[測試\]/);
  assert.deepEqual((await send(handler, {body: payload, cookie})).data, first.data);
  assert.equal(captureCount, 1);
  const changed = {...order, shipping: {...order.shipping, name: 'Changed name'}};
  assert.equal((await send(handler, {body: {action: 'submit', order: changed}, cookie})).status, 409);
  assert.equal((await send(handler, {body: {action: 'submit', order: {...order, id: 'LIVE-ORDER'}}, cookie})).status, 422);
});

test('preview handler can submit and retrieve a fictional order from isolated Supabase', {
  skip: process.env.MERCHANT_PREVIEW_VERIFY !== '1'
}, async () => {
  const handler = require('../api/order-email');
  const sendPreview = options => send(handler, {
    ...options, query: {...options.query, merchantPreview: '1'}
  });
  const payload = {action: 'submit', order};
  assert.equal((await sendPreview({body: payload})).status, 401);
  const login = await sendPreview({body: {action: 'login', key: process.env.MERCHANT_PREVIEW_ACCESS_KEY}});
  assert.equal(login.status, 200);
  const cookie = login.headers['Set-Cookie'];
  const first = await sendPreview({body: payload, cookie});
  assert.equal(first.status, 200, first.data.error);
  assert.equal(first.data.notificationStatus, 'captured');
  assert.equal(first.data.queueStatus, 'awaiting_assets');
  const slug = new URL(first.data.profiles[0].url).searchParams.get('p');
  const profile = await sendPreview({method: 'GET', query: {profile: slug}, cookie});
  assert.equal(profile.status, 200, profile.data.error);
  assert.equal(profile.data.diet, 'No chocolate');
  assert.equal(Object.hasOwn(profile.data, 'edit_token'), false);
  const retry = await sendPreview({body: payload, cookie});
  assert.deepEqual(retry.data, first.data);
  const logout = await sendPreview({body: {action: 'logout'}, cookie});
  assert.match(logout.headers['Set-Cookie'], /Max-Age=0/);
});

test('legacy email API still handles the existing demo flow', async () => {
  const legacy = await send(require('../api/order-email'), {body: {
    demo: true, type: 'payment_received', order: {customerEmail: 'customer@example.test'}
  }});
  assert.equal(legacy.status, 200);
  assert.equal(legacy.data.customerSent, false);
  assert.equal(legacy.data.merchantSent, false);
});
