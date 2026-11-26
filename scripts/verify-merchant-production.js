'use strict';

const assert = require('node:assert/strict');
const {configuration, makeHandler} = require('../server/merchant-preview');
const {postgres} = require('../server/postgres');
const {GMAIL_ADDRESS, sendGmail} = require('../server/gmail-mailer');

async function simulateRequest(handler, method, query, body, cookie) {
  const received = {};
  const host = 'www.8tsun8.com';
  const headers = {host, origin: 'https://' + host, 'content-type': 'application/json', cookie};
  await handler({method, query, body, headers}, {
    setHeader(name, value) { received[name] = value; },
    status(code) { received.status = code; return this; },
    json(value) { received.body = value; }
  });
  return received;
}

async function verify(env = process.env) {
  if (env.VERCEL_ENV !== 'production' || env.MERCHANT_ORDERS_ENABLED !== '1') return;
  const config = configuration(env);
  const sql = postgres(config.connection);
  const [merchant] = await sql`select current_user as role,
    has_function_privilege(current_user, 'public.create_merchant_preview_order(text,text,jsonb,jsonb)', 'EXECUTE') as can_create,
    has_table_privilege(current_user, 'public.tsun_order_review_images', 'INSERT') as can_save_images,
    has_table_privilege(current_user, 'public.tsun_order_review_images', 'SELECT') as can_read_images,
    has_table_privilege(current_user, 'public.tsun_order_reviews', 'SELECT') as can_read_paid_reviews,
    not has_table_privilege('anon', 'public.tsun_order_review_images', 'SELECT') as image_table_is_private`;
  assert.equal(merchant.role, 'merchant_order_store');
  assert.ok(merchant.can_create && merchant.can_save_images && merchant.can_read_images &&
    merchant.can_read_paid_reviews && merchant.image_table_is_private, 'Merchant database privileges are incomplete');

  assert.equal(env.MERCHANT_ORDER_REVIEW_ENABLED, '1');
  assert.equal(env.MERCHANT_ORDER_REVIEW_URL, 'https://www.8tsun8.com/merchant/orders');
  const writer = postgres(env.PRODUCTION_QUEUE_DATABASE_URL);
  const [paid] = await writer`select current_user as role,
    has_table_privilege(current_user, 'public.tsun_order_reviews', 'INSERT') as can_save_review,
    has_table_privilege(current_user, 'public.tsun_order_review_images', 'INSERT') as can_save_images,
    has_column_privilege(current_user, 'public.pet_profiles', 'order_id', 'SELECT') as can_check_profile,
    has_column_privilege(current_user, 'public.tsun_production_jobs', 'merchant_order_id', 'INSERT') as can_enqueue`;
  assert.equal(paid.role, 'production_queue_writer');
  assert.ok(paid.can_save_review && paid.can_save_images && paid.can_check_profile && paid.can_enqueue,
    'Payment queue database privileges are incomplete');

  const handler = makeHandler();
  const anonymous = await simulateRequest(handler, 'GET', {reviews: '1'});
  assert.equal(anonymous.status, 401, 'Merchant dashboard must require login');
  const login = await simulateRequest(handler, 'POST', {}, {action: 'login', key: config.key});
  assert.equal(login.status, 200, 'Merchant login was unsuccessful');
  assert.equal(login.body.preview, false, 'Merchant login is not in production mode');
  const authenticated = await simulateRequest(handler, 'GET', {reviews: '1'}, null, login['Set-Cookie']);
  assert.equal(authenticated.status, 200, 'Merchant dashboard could not read the production database');
  assert.ok(Array.isArray(authenticated.body.orders), 'Merchant dashboard did not return an order list');
  assert.ok((env.SMTP_APP_PASSWORD || '').replace(/\s/g, ''), 'The merchant mail transport is not configured');
  console.log('Merchant production preflight passed: isolated roles, dashboard login and paid-order permissions.');

  if (!env.MERCHANT_LAUNCH_EMAIL_TEST || env.MERCHANT_LAUNCH_EMAIL_TEST !== env.VERCEL_GIT_COMMIT_SHA) return;
  const recipient = env.MERCHANT_EMAIL || GMAIL_ADDRESS;
  assert.match(recipient, /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/);
  const result = await sendGmail({
    to: [recipient],
    subject: '[測試] 8TSUN8 商家後台上線驗證',
    text: '這是一封商家後台上線測試郵件。沒有建立訂單、扣款或觸發列印。商家訂單後台：https://www.8tsun8.com/merchant/orders'
  }, '8tsun8-merchant-production-launch-' + (env.VERCEL_GIT_COMMIT_SHA || '20261126'));
  assert.equal(result.sent, true, 'SMTP did not accept the merchant launch test email');
  console.log('Merchant launch message accepted by SMTP.');
}

verify().catch(error => {
  const code = String(error?.code || 'preflight_failed');
  const output = /^[A-Za-z0-9_]{1,50}$/.test(code) ? code : 'preflight_failed';
  const assertion = code === 'ERR_ASSERTION' ? String(error.message).split('\n')[0] : '';
  console.error('Merchant production preflight failed:', output, assertion);
  process.exitCode = 1;
});
