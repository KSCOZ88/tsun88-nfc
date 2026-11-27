'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {PNG} = require('pngjs');
const {combinePrintSides} = require('../server/print-layout');
const {salesItems, salesSummary} = require('../server/merchant-sales');
const {listReviews, storePaidReview, publishPaidReview, saveMerchantImages, loadMerchantPrintFiles} = require('../server/order-review');
const {notifyReviewedOrder, makeHandler, signIn, profileLinks, buildMerchantMessage} = require('../server/merchant-preview');

function makePng(width, height, colour) {
  const image = new PNG({width, height, fill: true});
  const center = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
  Buffer.from(colour).copy(image.data, center);
  return PNG.sync.write(image);
}
const png = 'data:image/png;base64,' + makePng(3, 3, [255, 0, 0, 255]).toString('base64');
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

test('paid review links retain the palette from the checkout URL', async () => {
  const sql = (_strings, ...values) => values;
  let stored;
  sql.transaction = async statements => { stored = statements; };
  const publicUrl = order.cloudProfile.publicUrl.replace('base=green3', 'b=green2');
  await storePaidReview(sql, 'stripe', {...order, cloudProfile: {...order.cloudProfile, publicUrl}}, previews);
  assert.match(JSON.parse(stored[0][2])[0].url, /base=green2$/);
});

test('paid reviews keep the named route and rebuild its label from the verified order', async () => {
  const sql = (_strings, ...values) => values;
  let stored;
  sql.transaction = async statements => { stored = statements; };
  await storePaidReview(sql, 'stripe', {...order, ownerName:'ANN', cloudProfile:{
    publicSlug:'ABCDEF012345',
    publicUrl:'https://www.8tsun8.com/p/other-label-ABCDEF012345?b=green2'
  }}, previews);
  assert.deepEqual(JSON.parse(stored[0][2]), [{name:'Lucky',
    url:'https://www.8tsun8.com/p/lucky-ann-ABCDEF012345?base=green2'}]);
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

test('merchant print layers are saved together and all three are required before mail', async () => {
  let written = [];
  const sql = async (strings, ...values) => {
    const statement = strings.join('');
    if (statement.includes('select cardinality')) return [{tag_count: 1}];
    if (statement.includes('insert into')) {
      written = JSON.parse(values[1]);
      return [];
    }
    return written;
  };
  const layers = ['print_front', 'print_back', 'print_dog'];
  await assert.rejects(saveMerchantImages(sql, id, 1, previews, true), {code: 'invalid_review_images'});
  await saveMerchantImages(sql, id, 1, [...previews, previews[0]], true);
  assert.deepEqual(written.map(image => image.side), layers);
  const attachments = await loadMerchantPrintFiles(sql, id, [{petName:'LOKI'}]);
  assert.deepEqual(attachments.map(file => file.filename), [
    '01-LOKI-01-正面底板.png', '01-LOKI-02-完整背面.png', '01-LOKI-03-狗狗頭像.png', '01-LOKI-04-正反面並排.png'
  ]);
  assert.ok(attachments.slice(0, 3).every(file => file.content === png.split(',')[1]));
  assert.ok(attachments.every(file => file.content_type === 'image/png'));
  written.pop();
  await assert.rejects(loadMerchantPrintFiles(sql, id, [{petName:'LOKI'}]), {code:'print_images_incomplete'});
});

test('merchant test mode captures by default and delivery sends one merchant-only email with both links', async () => {
  const row = {notification_status: 'pending', profile_slugs: ['ABCDEF012345'],
    order_details: {items: [{petName: 'Lucky', ownerName: 'ANN', baseVariant: 'green3'}], customerEmail: 'customer@example.test'}};
  let sent = 0;
  const attachments = ['front', 'back', 'dog', 'combined'].map(side => ({
    filename: side + '.png', content: png.split(',')[1], content_type: 'image/png'
  }));
  const sql = async (strings, ...values) => {
    const query = strings.join('');
    if (query.includes("notification_status = 'captured'")) {
      row.notification_status = 'captured';
      assert.equal(JSON.parse(values[0]).attachments.length, 4);
    } else if (query.includes("now() + interval")) {
      if (row.notification_status === 'sent') return [];
      row.notification_status = 'sending';
      return [{merchant_order_id: id, lease: '2026-11-27T00:00:00Z', sent_attachment_count: 0}];
    } else {
      row.notification_status = values[0];
      return [{merchant_order_id: id}];
    }
    return [];
  };
  const delivery = async message => {
    sent += 1;
    assert.deepEqual(message.to, [sent < 3 ? 'merchant@example.test' : 'tsunlab888@gmail.com']);
    assert.deepEqual(message.attachments, attachments);
    assert.match(message.html, /(?:merchant-profile\?p=ABCDEF012345|p\/lucky-ann-ABCDEF012345)/);
    assert.match(message.html, /merchant\/orders\?order=TEST-M-/);
    return {sent: sent > 1};
  };
  assert.equal(await notifyReviewedOrder(sql, id, row, origin, attachments, {}, delivery), 'captured');
  assert.equal(sent, 0);
  const env = {VERCEL_ENV: 'preview', MERCHANT_REVIEW_EMAIL_MODE: 'smtp',
    MERCHANT_REVIEW_TEST_RECIPIENT: 'merchant@example.test', SMTP_APP_PASSWORD: 'test-secret'};
  assert.equal(await notifyReviewedOrder(sql, id, row, origin, attachments, env, delivery), 'pending');
  assert.equal(await notifyReviewedOrder(sql, id, row, origin, attachments, env, delivery), 'sent');
  assert.equal(await notifyReviewedOrder(sql, id, row, origin, attachments, env, delivery), 'sent');
  assert.equal(sent, 2);
  row.notification_status = 'pending';
  assert.equal(await notifyReviewedOrder(sql, id, row, origin, attachments,
    {VERCEL_ENV:'production', MERCHANT_EMAIL:'other@example.test', SMTP_APP_PASSWORD:'test-secret'}, delivery), 'sent');
  assert.equal(sent, 3);
});

test('the combined PNG matches side scale and preserves a transparent gap', () => {
  const red = [255, 0, 0, 255];
  const green = [0, 255, 0, 255];
  const combined = PNG.sync.read(combinePrintSides(makePng(6, 6, red), makePng(3, 3, green)));
  assert.deepEqual([combined.width, combined.height], [13, 6]);
  const pixel = (x, y) => [...combined.data.subarray((y * combined.width + x) * 4, (y * combined.width + x + 1) * 4)];
  assert.deepEqual(pixel(3, 3), red);
  assert.deepEqual(pixel(9, 3), green);
  assert.deepEqual(pixel(10, 3), green);
  assert.deepEqual(pixel(6, 3), [0, 0, 0, 0]);
  assert.deepEqual(pixel(0, 0), [0, 0, 0, 0]);
});

test('large merchant mail batches keep four files per tag and retry only unsent tags', async () => {
  const bigContent = 'A'.repeat(3000000);
  const names = Array.from({length: 8}, (_, i) => 'tag-file-' + i + '.png');
  const attachments = names.map(filename => ({filename, content: bigContent, content_type: 'image/png'}));
  const row = {notification_status: 'pending', profile_slugs: ['ABCDEF012345','ABCDEF012346'],
    order_details: {items: [{petName:'One', baseVariant:'green2'}, {petName:'Two', baseVariant:'green2'}]}};
  const attempts = [];
  let sentCount = 0;
  const sql = async (strings, ...values) => {
    if (strings.join('').includes("now() + interval")) {
      row.notification_status = 'sending';
      return [{merchant_order_id: id, lease: '2026-11-27T01:00:00Z', sent_attachment_count: sentCount}];
    }
    row.notification_status = values[0];
    sentCount = values[1];
    return [{merchant_order_id: id}];
  };
  const deliver = async (mail, messageId) => {
    attempts.push({names: mail.attachments.map(file => file.filename), messageId});
    return {sent: attempts.length !== 2};
  };
  const env = {VERCEL_ENV:'production', SMTP_APP_PASSWORD:'test-secret'};
  assert.equal(await notifyReviewedOrder(sql, id, row, origin, attachments, env, deliver), 'pending');
  assert.equal(sentCount, 4);
  assert.equal(await notifyReviewedOrder(sql, id, row, origin, attachments, env, deliver), 'sent');
  assert.equal(sentCount, 8);
  assert.deepEqual(attempts.map(item => item.names), [names.slice(0, 4),names.slice(4),names.slice(4)]);
  assert.equal(attempts[1].messageId, attempts[2].messageId);
});

test('order listing, sales analytics, detail and images require a merchant session before accessing SQL', async () => {
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
  for (const query of [{reviews: '1'}, {sales: '1'}, {review: id}, {image: id, tag: '1', side: 'front'}]) {
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

test('paid analytics keeps selected tag variants and breeds without customer data', () => {
  assert.deepEqual(salesItems({items: [{
    baseVariant: 'green2', selectedBreedKey: 'golden-retriever', breedName: 'Golden Retriever',
    faceKey: 'corgi', petName: 'LOKI', ownerName: 'Owner', ownerPhone: '12345678'
  }]}), [{baseVariant: 'green2', selectedBreedKey: 'golden-retriever', breed: 'Golden Retriever'}]);
});

test('sales filters pass only explicitly supported sources and Hong Kong date ranges to SQL', async () => {
  const summary = {order_count: 2};
  const sql = async (parts, ...values) => {
    assert.match(parts.join(''), /Asia\/Hong_Kong/);
    assert.deepEqual(values, ['online', 'online', 7, 7]);
    return [summary];
  };
  assert.deepEqual(await salesSummary(sql, {source: 'online', days: '7'}), summary);
  await assert.rejects(salesSummary(() => assert.fail('unexpected query'), {source: 'online', days: '-1'}),
    {code: 'invalid_sales_filter'});
});

test('order history sorts by the newest order time before paginating and keeps permanent order numbers', async () => {
  const sql = async (strings, ...values) => {
    assert.match(strings.join('?'), /order by created_at desc, n\.order_number desc limit \? offset \?/);
    assert.deepEqual(values.slice(-2), [101, 100]);
    return [{order_number: '3'}];
  };
  assert.deepEqual(await listReviews(sql, '', 2), [{order_number: '3'}]);
});

test('merchant email shows the named profile URL, selected palette and saved checkout language', () => {
  for (const language of ['en', 'zh-Hant']) {
    const order = {language, items: [{petName: 'LOKI', ownerName: 'ANN', baseVariant: 'green2'}]};
    const links = profileLinks({profile_slugs: ['000BC3E24C4C'], order_details: order}, origin, false);
    const url = 'https://www.8tsun8.com/p/loki-ann-000BC3E24C4C?base=green2';
    assert.deepEqual(links, [{name:'LOKI', url}]);
    const {html} = buildMerchantMessage(id, order, links, origin, false, true);
    assert.ok(html.includes('<a href="' + url + '">' + url + '</a>'));
    assert.ok(html.includes(language === 'en' ? 'LOKI（English）' : 'LOKI（繁體中文）'));
    assert.match(html, /四張透明 PNG/);
  }
});
