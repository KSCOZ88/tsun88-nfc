'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {PNG} = require('pngjs');
const {inflateSync} = require('node:zlib');
const {completeHongKongAddress, hongKongAddressParts} = require('../server/hong-kong-district');
const {combinePrintSides} = require('../server/print-layout');
const {salesItems, salesSummary} = require('../server/merchant-sales');
const {listReviews, storePaidReview, publishPaidReview, saveMerchantImages, loadMerchantPrintFiles} = require('../server/order-review');
const {notifyReviewedOrder, makeHandler, signIn, merchantDeliveryDetails, profileLinks, buildMerchantMessage} = require('../server/merchant-preview');

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

test('merchant notification includes four images, the NFC link and a PDF of the private delivery address', async () => {
  const row = {notification_status: 'pending', profile_slugs: ['ABCDEF012345'],
    order_details: {items: [{petName: 'Lucky', ownerName: 'ANN', baseVariant: 'green3'}], customerEmail: 'customer@example.test',
      shipName: '陳小明', shipAddress: '香港九龍\n示範街18號示範大廈4樓12室'}};
  let sent = 0;
  const attachments = ['front', 'back', 'dog', 'combined'].map(side => ({
    filename: side + '.png', content: png.split(',')[1], content_type: 'image/png'
  }));
  const sql = async (strings, ...values) => {
    const query = strings.join('');
    if (query.includes("notification_status = 'captured'")) {
      row.notification_status = 'captured';
      const captured = JSON.parse(values[0]);
      assert.equal(captured.attachments.length, 5);
      assert.equal(captured.attachments.at(-1).content_type, 'application/pdf');
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
    assert.deepEqual(message.attachments.slice(0, 4), attachments);
    assert.equal(message.attachments.length, 5);
    const label = message.attachments.at(-1);
    assert.equal(label.content_type, 'application/pdf');
    const pdf = Buffer.from(label.content, 'base64');
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    const raw = pdf.toString('latin1');
    assert.match(raw, /MediaBox \[0 0 841\.89 595\.28\]/);
    const streams = [...raw.matchAll(/\/Filter \/FlateDecode[\s\S]*?stream\n([\s\S]*?)\nendstream/g)];
    const text = streams.map(([, value]) => inflateSync(Buffer.from(value, 'latin1')).toString()).join('\n');
    assert.equal([...text.matchAll(/\/I1 Do/g)].length, 3);
    assert.match(message.html, /100% 實際大小/);
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

test('oversized merchant orders send one mail with the PDF, complete tag images and signed-in downloads', async () => {
  const bigContent = 'A'.repeat(3000000);
  const names = Array.from({length: 8}, (_, i) => 'tag-file-' + i + '.png');
  const attachments = names.map(filename => ({filename, content: bigContent, content_type: 'image/png'}));
  const row = {notification_status: 'pending', profile_slugs: ['ABCDEF012345','ABCDEF012346'],
    order_details: {items: [{petName:'One', baseVariant:'green2'}, {petName:'Two', baseVariant:'green2'}],
      shipName: 'Alex Chan', shipAddress: 'Flat 12, 4/F, 18 Example Road, Kowloon, Hong Kong'}};
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
    attempts.push({names: mail.attachments.map(file => file.filename), messageId, html: mail.html});
    return {sent: attempts.length > 1};
  };
  const env = {VERCEL_ENV:'production', SMTP_APP_PASSWORD:'test-secret'};
  assert.equal(await notifyReviewedOrder(sql, id, row, origin, attachments, env, deliver), 'pending');
  assert.equal(sentCount, 0);
  assert.equal(await notifyReviewedOrder(sql, id, row, origin, attachments, env, deliver), 'sent');
  assert.equal(await notifyReviewedOrder(sql, id, row, origin, attachments, env, deliver), 'sent');
  assert.equal(sentCount, 4);
  const files = [...names.slice(0, 4), '8TSUN8-收件地址.pdf'];
  assert.deepEqual(attempts.map(item => item.names), [files, files]);
  assert.equal(attempts[0].messageId, attempts[1].messageId);
  assert.match(attempts[1].html, /merchant\/orders\?order=[^"#]+#merchant-print-files/);
});

test('order details and production downloads require a merchant session before accessing SQL', async () => {
  const config = {key: 'a'.repeat(64), signingKey: 'b'.repeat(64), connection: 'test'};
  const delivery = {customerEmail:'merchant-fixture@example.test',shipName:'Fixture Recipient',
    shipPhone:'51234567',shipAddress:'2 Tim Mei Avenue, Hong Kong'};
  let opened = 0;
  const handler = makeHandler({getConfig: () => config, getDb: () => {
    opened++;
    return async strings => {
      const statement = strings.join('');
      if (statement.includes('with entries')) return [{id,provider:'merchant'}];
      if (statement.includes('select profile_slugs')) return [{profile_slugs:['ABCDEF012345'],items:[{petName:'Lucky'}],delivery}];
      if (statement.includes('select tag_number')) return [];
      if (statement.includes("side in ('print_front', 'print_back')"))
        return ['print_front', 'print_back'].map(side => ({side, image_png: Buffer.from(png.split(',')[1], 'base64')}));
      return [{image_png: Buffer.from('test')}];
    };
  }});
  const respond = async (query, cookie, body) => {
    const result = {headers: {}};
    const headers = {host: 'preview.example.test', cookie, origin, 'content-type': 'application/json'};
    await handler({method: body ? 'POST' : 'GET', query, body, headers}, {
      setHeader(name, value) { result.headers[name] = value; },
      status(status) { result.status = status; return this; },
      json(body) { result.body = body; },
      send(body) { result.body = body; }
    });
    return result;
  };
  const download = {image: id, tag: '1', side: 'print_combined'};
  for (const query of [{reviews: '1'}, {sales: '1'}, {review: id}, {image: id, tag: '1', side: 'front'}, download, {addressPdf:id}]) {
    assert.deepEqual((await respond(query)).body, {error: 'sign_in_required'});
  }
  assert.deepEqual((await respond({}, undefined, {action: 'resend-production-mail', orderId: id})).body,
    {error: 'sign_in_required'});
  assert.equal(opened, 0);
  const image = await respond({image: id, tag: '1', side: 'front'}, signIn(config.key, config));
  assert.equal(image.status, 200);
  assert.equal(image.headers['Content-Type'], 'image/png');
  assert.equal(image.headers['Cache-Control'], 'private, no-store');
  const file = await respond(download, signIn(config.key, config));
  assert.equal(file.status, 200);
  assert.equal(file.headers['Content-Disposition'], `attachment; filename="8TSUN8-${id}-1-print_combined.png"`);
  assert.ok(PNG.sync.read(file.body).width > 3);
  const detail = await respond({review:id},signIn(config.key,config));
  assert.deepEqual(detail.body.delivery,delivery);
  assert.equal(detail.body.quantity,1);
  const label = await respond({addressPdf:id},signIn(config.key,config));
  assert.equal(label.status,200);
  assert.equal(label.headers['Content-Type'],'application/pdf');
  assert.equal(label.body.subarray(0,5).toString(),'%PDF-');
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

test('merchant labels use a specific pet profile address and retain matching checkout details', () => {
  const profile = {location: '52 Example Road', owner_name: 'Ann', owner_phone: '12345678'};
  const order = {shipName: 'Checkout name', shipPhone: '11111111', shipAddress: 'Other delivery address'};
  assert.deepEqual(merchantDeliveryDetails(order, [profile]), {
    shipName: 'Ann', shipPhone: '12345678', shipAddress: '52 Example Road'
  });
  const complete = {...order, shipAddress: '52 Example Road, Sample City, EX1 1XX'};
  assert.equal(merchantDeliveryDetails(complete, [profile]).shipAddress, complete.shipAddress);
  assert.equal(merchantDeliveryDetails(order, [{location: '九龍'}]), order);
  assert.equal(merchantDeliveryDetails(order, [profile, {location: '12 Other Road'}]), order);
  assert.equal(merchantDeliveryDetails(order, [{location: '九龍示範街18號', owner_name: '陳小明'}]).shipAddress,
    '九龍示範街18號');
});


test('Hong Kong district lookup sends only the building details and adds an exact English district', async () => {
  const order = {shipAddress: "Flat 12, 4/F, 88 Queen’s Road Central, Hong Kong", shipName: 'Example Name', shipPhone: '12345678'};
  const en = {EngStreet: {StreetName: "QUEEN'S ROAD CENTRAL", BuildingNoFrom: '88', BuildingNoTo: '88'},
    EngDistrict: {DcDistrict: 'Central & Western District'}};
  const record = EngPremisesAddress => ({Address: {PremisesAddress: {EngPremisesAddress}}});
  const result = await completeHongKongAddress(order, async (url, options) => {
    assert.equal(url.origin, 'https://www.als.gov.hk');
    assert.equal(url.searchParams.get('q'), '88 Queen’s Road Central');
    assert.equal(options.headers.Accept, 'application/json');
    return {ok: true, json: async () => ({SuggestedAddress: [
      record({...en, EngStreet: {...en.EngStreet, StreetName: "QUEEN'S ROAD WEST"}}), record(en)
    ]})};
  });
  assert.equal(result.shipAddress, 'Flat 12, 4/F, 88 Queen’s Road Central\nCentral and Western District\nHong Kong');
  assert.equal(result.shipName, order.shipName);
});

test('Hong Kong district lookup supports a Chinese street and respects districts already supplied', async () => {
  const order = {shipAddress: '香港中環皇后大道中88號12樓'};
  const result = await completeHongKongAddress(order, async url => {
    assert.equal(url.searchParams.get('q'), '香港中環皇后大道中88號');
    return {ok: true, json: async () => ({SuggestedAddress: [{Address: {PremisesAddress: {
      EngPremisesAddress: {EngDistrict: {DcDistrict: 'Central & Western District'}},
      ChiPremisesAddress: {Region: '香港', ChiStreet: {LocationName: '中環',
        StreetName: '皇后大道中', BuildingNoFrom: '88', BuildingNoTo: '88'}}
    }}}]})};
  });
  assert.equal(result.shipAddress, '中環皇后大道中88號12樓\nCentral and Western District\nHong Kong');
  const withDistrict = {shipAddress: order.shipAddress + ', 中西區'};
  assert.equal(await completeHongKongAddress(withDistrict, () => assert.fail('address already has a district')), withDistrict);
});

test('fuzzy, conflicting or unavailable address results keep the original address for review', async () => {
  const order = {shipAddress: '52 Littlestone Road'};
  const record = (street, district) => ({Address: {PremisesAddress: {EngPremisesAddress: {
    EngStreet: {StreetName: street, BuildingNoFrom: '52'}, EngDistrict: {DcDistrict: district}
  }}}});
  for (const result of [
    [record('Little Road', 'Central & Western District')],
    [record('Littlestone Road', 'Central & Western District'), record('Littlestone Road', 'Eastern District')],
    null
  ]) {
    const unchanged = await completeHongKongAddress(order, async () => {
      if (!result) throw Error('unavailable');
      return {ok: true, json: async () => ({SuggestedAddress: result})};
    });
    assert.equal(unchanged.shipAddress, order.shipAddress);
    assert.equal(unchanged.shippingDistrictUnverified, true);
  }
});


test('Hong Kong labels separate the district and country for manual and automatically formatted addresses', () => {
  const locality = {street: '88 Example Road', district: 'Central and Western District', country: 'Hong Kong'};
  assert.deepEqual(hongKongAddressParts('88 Example Road, Central & Western District, Hong Kong'), locality);
  assert.deepEqual(hongKongAddressParts('88 Example Road\nCentral and Western District\nHong Kong'), locality);
  assert.deepEqual(hongKongAddressParts('香港中西區示範街18號'), {...locality, street:'示範街18號'});
  assert.deepEqual(hongKongAddressParts('88 Example Road, Hong Kong'),
    {street:'88 Example Road', district:undefined, country:'Hong Kong'});
  assert.deepEqual(hongKongAddressParts('North District Hospital, Hong Kong'),
    {street:'North District Hospital', district:undefined, country:'Hong Kong'});
  assert.deepEqual(hongKongAddressParts('香港大學, 中西區, 香港'),
    {...locality, street:'香港大學'});
  assert.equal(hongKongAddressParts('台灣台南市北區示範路18號'), null);
});

test('sign-in works without PDF assets and labels only use their embedded fonts', () => {
  const {execFileSync} = require('node:child_process');
  execFileSync(process.execPath, ['--no-require-module', '-e', `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const originalLoad = Module._load;
    Module._load = function (request, ...rest) {
      if (request === 'pdfkit') throw new Error('PDF renderer unavailable');
      return originalLoad.call(this, request, ...rest);
    };
    const fs = require('node:fs');
    const originalRead = fs.readFileSync;
    fs.readFileSync = function (path, ...rest) {
      if (/address-vintage|pinyon-script|NotoSansHant/.test(String(path))) {
        throw new Error('PDF assets unavailable');
      }
      return originalRead.call(this, path, ...rest);
    };

    Object.assign(process.env, {
      VERCEL_ENV: 'production',
      MERCHANT_ORDERS_ENABLED: '1',
      MERCHANT_ORDERS_ACCESS_KEY: 'a'.repeat(64),
      MERCHANT_ORDERS_SESSION_SECRET: 'b'.repeat(64),
      MERCHANT_ORDERS_DATABASE_URL:
        'postgresql://merchant_order_store.zujdfvnhxbalyhjmmmtl:fake@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=verify-full'
    });
    const handler = require('./api/order-email');
    assert.equal(typeof require('./api/create-checkout-session'), 'function');

    async function respond(method, body, cookie) {
      const headers = {
        host: 'www.8tsun8.com',
        origin: 'https://www.8tsun8.com',
        'content-type': 'application/json',
        cookie
      };
      const result = {headers: {}};
      await handler({method, body, headers, query: {merchantPreview: '1'}}, {
        setHeader(name, value) { result.headers[name] = value; },
        status(status) { result.status = status; return this; },
        json(data) { result.body = data; }
      });
      return result;
    }
    async function check() {
      const initial = await respond('GET');
      assert.equal(initial.status, 200);
      assert.deepEqual(initial.body, {authenticated: false, preview: false});
      const signIn = await respond('POST', {action: 'login', key: 'a'.repeat(64)});
      assert.equal(signIn.status, 200);
      const session = await respond('GET', undefined, signIn.headers['Set-Cookie'].split(';')[0]);
      assert.deepEqual(session.body, {authenticated: true, preview: false});

      fs.readFileSync = originalRead;
      delete require.cache[require.resolve('./server/shipping-label')];
      Module._load = function (request, ...rest) {
        if (request.includes('standard-fonts/')) throw new Error('PDFKit standard fonts unavailable');
        return originalLoad.call(this, request, ...rest);
      };
      const {shippingLabelAttachment} = require('./server/shipping-label');
      const label = await shippingLabelAttachment({
        shipName: '陳小明',
        shipAddress: ['示範道8號', 'Central and Western District', 'Hong Kong'].join(String.fromCharCode(10))
      }, {threeAcross: true});
      assert.equal(label.content_type, 'application/pdf');
      assert.equal(Buffer.from(label.content, 'base64').subarray(0, 5).toString(), '%PDF-');
      const mainland = await shippingLabelAttachment({
        shipName: '測試收件人', shipAddress: '深圳市南山區示範路8號12室'
      }, {threeAcross: true});
      assert.equal(Buffer.from(mainland.content, 'base64').subarray(0, 5).toString(), '%PDF-');
    }
    check().catch(error => { console.error(error); process.exitCode = 1; });
  `], {cwd: require('node:path').join(__dirname, '..'), stdio: 'pipe'});
});
