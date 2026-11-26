'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {storePaidReview, publishPaidReview, saveMerchantImages} = require('../server/order-review');
const {notifyReviewedOrder, makeHandler, signIn} = require('../server/merchant-preview');

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD2QAAAAASUVORK5CYII=';
const previews = [{data: png}, {data: png}];
const id = 'TEST-M-' + 'c'.repeat(32);
const order = {
  id: 'TS20261126-123456', paymentStatus: 'paid', items: [{petName: 'Lucky'}],
  cloudProfile: {publicSlug: 'ABCDEF012345', publicUrl: 'https://www.8tsun8.com/lucky88.html?p=ABCDEF012345&base=green3'}
};
const origin = 'https://preview.example.test';

test('verified paid providers store the NFC link and both sides atomically', async () => {
  for (const provider of ['stripe', 'paypal', 'airwallex']) {
    const sql = (strings, ...values) => ({statement: strings.join('?'), values});
    let stored;
    sql.transaction = async statements => { stored = statements; };
    await storePaidReview(sql, provider, order, previews);
    assert.equal(stored.length, 2);
    assert.equal(stored[0].values[1], provider);
    assert.deepEqual(JSON.parse(stored[0].values[2]), [{name: 'Lucky', url: order.cloudProfile.publicUrl}]);
    const images = JSON.parse(stored[1].values[1]);
    assert.deepEqual(images.map(({tag_number, side}) => [tag_number, side]), [[1, 'front'], [1, 'back']]);
    assert.equal(images[0].content, png.split(',')[1]);
    assert.match(stored[1].statement, /on conflict do nothing/);
  }
});

test('no production connection is opened by a paid preview', async () => {
  await publishPaidReview('stripe', order, previews, {
    VERCEL_ENV: 'preview', MERCHANT_ORDER_REVIEW_ENABLED: '1',
    PRODUCTION_QUEUE_DATABASE_URL: 'should-not-open'
  });
});

test('one side, fake image content, unsafe links and unpaid orders cannot create paid reviews', async () => {
  const sql = () => assert.fail('unexpected write');
  await assert.rejects(storePaidReview(sql, 'stripe', order, [previews[0]]), {code: 'invalid_review_images'});
  await assert.rejects(storePaidReview(sql, 'stripe', order, [{data: 'data:image/png;base64,eA=='}, previews[0]]),
    {code: 'invalid_review_image'});
  await assert.rejects(storePaidReview(sql, 'stripe', {...order, paymentStatus: 'pending'}, previews),
    {code: 'invalid_review_provider'});
  await assert.rejects(storePaidReview(sql, 'stripe', {...order, cloudProfile: {publicUrl: 'https://external.example/lucky88.html?p=ABCDEF012345'}}, previews),
    {code: 'invalid_review_profile'});
});

test('merchant review uploads only write a pair for an existing tag', async () => {
  let written;
  const sql = async (strings, ...values) => {
    if (strings.join('').includes('select cardinality')) return [{tag_count: 1}];
    written = JSON.parse(values[1]);
    return [];
  };
  await assert.rejects(saveMerchantImages(sql, id, 2, previews), {code: 'order_missing'});
  assert.equal(written, undefined);
  await saveMerchantImages(sql, id, 1, previews);
  assert.deepEqual(written.map(image => image.side), ['front', 'back']);
});

test('merchant test mode captures by default and delivery sends one merchant-only email with both links', async () => {
  const row = {notification_status: 'pending', profile_slugs: ['ABCDEF012345'],
    order_details: {items: [{petName: 'Lucky', baseVariant: 'green3'}], customerEmail: 'customer@example.test'}};
  let sent = 0;
  const sql = async (strings, ...values) => {
    const query = strings.join('');
    if (query.includes("notification_status = 'captured'")) {
      row.notification_status = 'captured';
    } else if (query.includes('returning merchant_order_id')) {
      if (row.notification_status === 'sent') return [];
      row.notification_status = 'sending';
      return [{merchant_order_id: id}];
    } else {
      row.notification_status = values[0];
    }
    return [];
  };
  const delivery = async message => {
    sent += 1;
    assert.deepEqual(message.to, ['merchant@example.test']);
    assert.match(message.html, /merchant-profile\?p=ABCDEF012345/);
    assert.match(message.html, /merchant\/orders\?order=TEST-M-/);
    return {sent: sent > 1};
  };
  assert.equal(await notifyReviewedOrder(sql, id, row, origin, {}, delivery), 'captured');
  assert.equal(sent, 0);
  const env = {VERCEL_ENV: 'preview', MERCHANT_REVIEW_EMAIL_MODE: 'smtp',
    MERCHANT_REVIEW_TEST_RECIPIENT: 'merchant@example.test', SMTP_APP_PASSWORD: 'test-secret'};
  assert.equal(await notifyReviewedOrder(sql, id, row, origin, env, delivery), 'pending');
  assert.equal(await notifyReviewedOrder(sql, id, row, origin, env, delivery), 'sent');
  assert.equal(await notifyReviewedOrder(sql, id, row, origin, env, delivery), 'sent');
  assert.equal(sent, 2);
});

test('order listing, detail and images require a merchant session before accessing SQL', async () => {
  const config = {key: 'a'.repeat(64), signingKey: 'b'.repeat(64), connection: 'test'};
  let opened = 0;
  const handler = makeHandler({getConfig: () => config, getDb: () => {
    opened++;
    return async () => [{image_png: Buffer.from('test')}];
  }});
  const respond = async (query, cookie) => {
    const result = {headers: {}};
    await handler({method: 'GET', query, headers: {host: 'preview.example.test', cookie}}, {
      setHeader(name, value) { result.headers[name] = value; },
      status(status) { result.status = status; return this; },
      json(body) { result.body = body; },
      send(body) { result.body = body; }
    });
    return result;
  };
  for (const query of [{reviews: '1'}, {review: id}, {image: id, tag: '1', side: 'front'}]) {
    assert.deepEqual((await respond(query)).body, {error: 'sign_in_required'});
  }
  assert.equal(opened, 0);
  const image = await respond({image: id, tag: '1', side: 'front'}, signIn(config.key, config));
  assert.equal(image.status, 200);
  assert.equal(image.headers['Content-Type'], 'image/png');
  assert.equal(image.headers['Cache-Control'], 'private, no-store');
});

test('the enabled production merchant route uses its own role and generates live IDs', () => {
  const {configuration, validateSubmission} = require('../server/merchant-preview');
  const env = {VERCEL_ENV: 'production', MERCHANT_ORDERS_ENABLED: '1',
    MERCHANT_ORDERS_ACCESS_KEY: 'a'.repeat(64), MERCHANT_ORDERS_SESSION_SECRET: 'b'.repeat(64),
    MERCHANT_ORDERS_DATABASE_URL: 'postgresql://merchant_order_store.zujdfvnhxbalyhjmmmtl:fake@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=verify-full'};
  assert.equal(configuration(env).preview, false);
  assert.throws(() => configuration({...env, MERCHANT_ORDERS_ENABLED: '0'}), {status: 404});
  assert.throws(() => configuration({...env, MERCHANT_ORDERS_DATABASE_URL:
    env.MERCHANT_ORDERS_DATABASE_URL.replace('zujdfvnhxbalyhjmmmtl', 'rziyucbmascwdrtwqvgy')}), {status: 503});
  assert.throws(() => validateSubmission({id}, false), {code: 'invalid_id'});
  assert.throws(() => validateSubmission({id: id.replace(/^TEST-/, '')}, false), {code: 'invalid_items'});
});
