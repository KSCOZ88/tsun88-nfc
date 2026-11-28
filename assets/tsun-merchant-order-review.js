'use strict';

(function () {
  if (location.pathname.replace(/\/$/, '') !== '/merchant/orders') return;

  const endpoint = '/api/order-email?merchantPreview=1';
  const page = document.createElement('main');
  page.id = 'merchantOrderReview';
  page.translate = false;
  page.hidden = true;
  document.body.append(page);

  const local = (zh, en) => document.documentElement.lang.toLowerCase().startsWith('zh') ? zh : en;
  const params = new URLSearchParams(location.search);
  const orderId = params.get('order');
  const historyUrl = '/merchant/orders';
  const salesUrl = historyUrl + '?view=sales';
  const salesView = !orderId && params.get('view') === 'sales';
  const period = ['7', '30', '90', 'all'].includes(params.get('days')) ? params.get('days') : '30';
  const source = ['all', 'online', 'merchant'].includes(params.get('source')) ? params.get('source') : 'all';
  const dateTime = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const heading = element('h1');
  const header = element('header');
  header.className = 'merchant-review-header';
  const nav = element('nav');
  const languageSwitch = element('div');
  languageSwitch.className = 'merchant-review-language';
  languageSwitch.setAttribute('role', 'group');
  for (const [locale, label] of [['zh-Hant', '繁體中文'], ['en', 'English']]) {
    const button = element('button', label);
    button.type = 'button';
    button.lang = locale;
    button.dataset.locale = locale;
    button.addEventListener('click', () => window.TsunI18n.setLocale(locale));
    languageSwitch.append(button);
  }
  const status = element('p');
  status.setAttribute('role', 'status');
  const content = element('div');
  let result;
  let statusMessage = ['', ''];
  header.append(heading, languageSwitch);
  page.append(header, nav, status, content);

  function report(zh = '', en = '') {
    statusMessage = [zh, en];
    status.textContent = local(zh, en);
  }

  function render() {
    heading.textContent = salesView ? local('銷售分析', 'Sales analytics')
      : orderId ? local('訂單詳情', 'Order details') : local('商家訂單', 'Merchant orders');
    const navigation = [link('/merchant', local('建立免付款訂單', 'Create a no-payment order'))];
    if (orderId || salesView) navigation.push(link(historyUrl, local('訂單歷史', 'Order history')));
    if (!salesView) navigation.push(link(salesUrl, local('銷售分析', 'Sales analytics')));
    nav.replaceChildren(...navigation);
    languageSwitch.setAttribute('aria-label', local('商家後台語言', 'Dashboard language'));
    for (const button of languageSwitch.children) {
      button.setAttribute('aria-pressed', String(button.dataset.locale === document.documentElement.lang));
    }
    report(...statusMessage);
    if (!result) return;
    if (orderId) showDetail(result);
    else if (salesView) showSales(result);
    else showList(result);
  }

  window.addEventListener('tsun-language-change', () => {
    if (!page.hidden) render();
  });

  function element(tag, label) {
    const node = document.createElement(tag);
    if (label) node.textContent = label;
    return node;
  }

  function link(url, label, newTab = false) {
    const a = element('a', label);
    a.href = url;
    if (newTab) {
      a.target = '_blank';
      a.rel = 'noopener';
    }
    return a;
  }

  async function request(query, body) {
    const response = await fetch(endpoint + query, body ? {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
    } : {});
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw Object.assign(new Error('Order review unavailable'), {status: response.status, code: data.error});
    }
    return response.json();
  }

  async function resendAirwallexProduction(orderId) {
    const payload = {action: 'resend-production-mail', orderId};
    try {
      return await request('', payload);
    } catch (error) {
      if (error.code !== 'production_assets_missing') throw error;
      const saved = savedProductionOrder(orderId, 'airwallex');
      if (!saved) throw error;
      return request('', {...payload, legacy: await browserProductionAssets(saved)});
    }
  }

  function savedProductionOrder(id, provider) {
    const credentials = {
      airwallex: ['airwallexOrderToken','airwallexSessionId'],
      stripe: ['stripeOrderToken','stripeSessionId'],
      paypal: ['paypalOrderToken','paypalOrderId']
    }[provider];
    if (!credentials) return;
    try {
      return JSON.parse(localStorage.getItem('tsun88_orders_v1') || '[]').find(order =>
        order.id === id && order.status === '资料已完善' && order.paymentStatus === 'paid' &&
        credentials.every(field => order[field]));
    } catch {}
  }

  async function browserProductionAssets(saved) {
    const files = await prepareProductionFiles(saved);
    const attachments = await Promise.all(Object.values(files).map(async file =>
      ({name: file.name, data: await blobToDataUrl(file.blob)})));
    const {id, items, customerEmail, language, shipName, shipPhone, shipAddress,
      airwallexOrderToken, airwallexSessionId, stripeOrderToken, stripeSessionId, paypalOrderToken, paypalOrderId} = saved;
    return {attachments, order: {
      id, items: items.map(({petName, decorItems}) => ({petName, decorItems})),
      customerEmail, language, shipName, shipPhone, shipAddress,
      airwallexOrderToken, airwallexSessionId, stripeOrderToken, stripeSessionId, paypalOrderToken, paypalOrderId
    }};
  }

  function providerName(provider) {
    if (provider === 'merchant') return local('商家免付款', 'Merchant · No payment');
    return {stripe: 'Stripe', paypal: 'PayPal', airwallex: 'Airwallex'}[provider] || provider;
  }

  function queueStatus(value) {
    return {
      awaiting_assets: local('等待素材', 'Awaiting production assets'),
      downloaded: local('已取單', 'Downloaded'),
      generating: local('製作中', 'In progress'),
      review_ready: local('待審核', 'Ready for review'),
      failed: local('失敗待處理', 'Needs attention')
    }[value] || value || '—';
  }

  function orderUrl(id) {
    return '/merchant/orders?order=' + encodeURIComponent(id);
  }

  function orderTime(value) {
    const date = value ? new Date(value) : null;
    if (!date || !Number.isFinite(date.getTime())) return element('span', '—');
    const time = element('time', dateTime.format(date));
    time.dateTime = date.toISOString();
    return time;
  }

  function orderNumber(order) {
    return order.order_number ? '#' + order.order_number : '—';
  }

  function showList({orders, page: current, hasMore}) {
    const blocks = [];
    if (orders.length) {
      const frame = element('div');
      frame.className = 'merchant-history-table';
      frame.tabIndex = 0;
      frame.setAttribute('role', 'region');
      frame.setAttribute('aria-label', local('訂單歷史', 'Order history'));
      const table = element('table');
      const header = table.createTHead().insertRow();
      for (const title of [
        local('訂單編號', 'Order #'), local('下單日期及時間（香港）', 'Date and time (HKT)'),
        local('寵物', 'Pet'), local('來源', 'Source'), local('生產狀態', 'Queue status')
      ]) {
        const column = element('th', title);
        column.scope = 'col';
        header.append(column);
      }
      const body = table.createTBody();
      for (const order of orders) {
        const row = body.insertRow();
        row.insertCell().append(link(orderUrl(order.id), orderNumber(order)));
        row.insertCell().append(orderTime(order.created_at));
        row.insertCell().textContent = order.pet_name || '—';
        row.insertCell().textContent = providerName(order.provider);
        row.insertCell().textContent = queueStatus(order.queue_status);
      }
      frame.append(table);
      blocks.push(frame);
    } else {
      blocks.push(element('p', local('此頁暫無訂單。', 'No orders on this page.')));
    }
    if (current > 1 || hasMore) {
      const navigation = element('nav');
      navigation.setAttribute('aria-label', local('訂單分頁', 'Order pages'));
      if (current > 1) navigation.append(link(historyUrl + '?page=' + (current - 1), local('上一頁', 'Previous')));
      navigation.append(element('span', local('第 ' + current + ' 頁', 'Page ' + current)));
      if (hasMore) navigation.append(link(historyUrl + '?page=' + (current + 1), local('下一頁', 'Next')));
      blocks.push(navigation);
    }
    content.replaceChildren(...blocks);
  }

  function filterField(name, title, options, selected) {
    const label = element('label', title);
    const select = element('select');
    select.name = name;
    for (const [value, caption] of options) {
      const option = element('option', caption);
      option.value = value;
      select.append(option);
    }
    select.value = selected;
    label.append(select);
    return label;
  }

  function salesFilters() {
    const form = element('form');
    form.className = 'merchant-sales-filters';
    form.action = historyUrl;
    const view = element('input');
    view.type = 'hidden';
    view.name = 'view';
    view.value = 'sales';
    form.append(view, filterField('days', local('日期範圍', 'Date range'), [
      ['7', local('最近 7 天', 'Last 7 days')], ['30', local('最近 30 天', 'Last 30 days')],
      ['90', local('最近 90 天', 'Last 90 days')], ['all', local('全部日期', 'All dates')]
    ], period), filterField('source', local('訂單來源', 'Order source'), [
      ['all', local('全部來源', 'All sources')], ['online', local('線上付款', 'Online paid')],
      ['merchant', local('商家免付款', 'Merchant no-payment')]
    ], source));
    const submit = element('button', local('套用', 'Apply'));
    submit.type = 'submit';
    form.append(submit);
    return form;
  }

  function timeRange(slot) {
    const hour = String(slot).padStart(2, '0');
    return hour + ':00–' + hour + ':59';
  }

  function weekday(slot) {
    return local(['', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'][slot],
      ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][slot]);
  }

  function colourLabel(key) {
    const variant = typeof baseVariants === 'undefined' ? null : baseVariants[key];
    const caption = variant?.description || variant?.label;
    return caption ? window.TsunI18n?.t(caption) || caption : key;
  }

  function breedLabel(key) {
    const breed = typeof breedByKey === 'function' ? breedByKey(key) : null;
    if (breed) return window.TsunI18n?.t(breed.name) || breed.name;
    return key.replace(/-/g, ' ').replace(/\b[a-z]/g, first => first.toUpperCase());
  }

  function salesCard(title, rows, label, unit) {
    const card = element('section');
    card.className = 'merchant-sales-card';
    card.append(element('h2', title));
    if (!rows.length) {
      card.append(element('p', local('此範圍內暫無資料。', 'No data in this range.')));
      return card;
    }
    const list = element('ul');
    const max = Math.max(...rows.map(row => row.count));
    for (const row of rows) {
      const item = element('li');
      const caption = element('div');
      caption.append(element('span', label(row)), element('strong', row.count + ' ' + unit(row.count)));
      const track = element('div');
      track.className = 'merchant-sales-bar';
      track.setAttribute('aria-hidden', 'true');
      const fill = element('span');
      fill.style.width = row.count / max * 100 + '%';
      track.append(fill);
      item.append(caption, track);
      list.append(item);
    }
    card.append(list);
    return card;
  }

  function showSales(summary) {
    const metrics = element('dl');
    metrics.className = 'merchant-sales-metrics';
    for (const [label, count] of [
      [local('訂單數量', 'Orders'), summary.order_count],
      [local('線上付款訂單', 'Online paid'), summary.online_count],
      [local('商家免付款訂單', 'Merchant no-payment'), summary.merchant_count]
    ]) {
      const metric = element('div');
      metric.append(element('dt', label), element('dd', String(count)));
      metrics.append(metric);
    }
    const maximum = Math.max(0, ...summary.hours.map(row => row.count));
    const peak = summary.hours.filter(row => row.count === maximum).map(row => timeRange(row.slot));
    const peakText = peak.length ? element('p', local('最多訂單的時段（香港時間）', 'Busiest hours (HKT)')) : null;
    if (peakText) {
      peakText.className = 'merchant-sales-peak';
      peakText.append(element('strong', peak.join(' / ')));
    }

    const grid = element('div');
    grid.className = 'merchant-sales-grid';
    const tags = count => local('塊', count === 1 ? 'tag' : 'tags');
    const orders = count => local('筆', count === 1 ? 'order' : 'orders');
    grid.append(
      salesCard(local('底板配色排行', 'Top base colours'), summary.colours, row => colourLabel(row.key), tags),
      salesCard(local('犬種排行', 'Top breeds'), summary.breeds, row => breedLabel(row.key), tags),
      salesCard(local('每小時訂單（香港時間）', 'Orders by hour (HKT)'), summary.hours, row => timeRange(row.slot), orders),
      salesCard(local('每週各日訂單（香港時間）', 'Orders by day of week (HKT)'), summary.weekdays, row => weekday(row.slot), orders)
    );
    const scope = element('p', local(
      '配色與犬種按狗牌數量統計。時段按訂單數量統計。',
      'Colour and breed rankings count individual tags. Time charts count orders.'));
    scope.className = 'merchant-sales-scope';
    if (summary.orders_without_items || summary.tag_count > Math.min(summary.colour_tag_count, summary.breed_tag_count)) {
      scope.append(' ' + local(
        '缺少配色或犬種的記錄只計入有資料的排行，訂單仍計入時段。',
        'Rankings omit missing colours or breeds. These orders still count in the time charts.'));
    }
    const filters = salesFilters();
    for (const field of ['days', 'source']) {
      const selected = content.querySelector('select[name=' + field + ']');
      if (selected) filters.elements.namedItem(field).value = selected.value;
    }
    content.replaceChildren(filters, metrics, ...(peakText ? [peakText] : []), grid, scope);
  }

  function showDetail(order) {
    heading.textContent = order.pet_name || local('訂單詳情', 'Order details');
    const info = element('p', orderNumber(order) + ' · ');
    info.append(orderTime(order.created_at), ' ' + local('（香港時間）', '(HKT)'),
      ' · ' + providerName(order.provider) + ' · ' + queueStatus(order.queue_status));
    const delivery = order.delivery || {};
    const details = element('section');
    details.className = 'merchant-order-details';
    details.append(element('h2', local('訂單及配送資料', 'Order and delivery details')));
    const fields = element('dl');
    for (const [label,value] of [
      [local('訂單編號', 'Order number'), order.id],
      [local('狗牌數量', 'Number of tags'), order.quantity || order.items.length || null],
      [local('客戶電郵', 'Customer email'), delivery.customerEmail],
      [local('收件人', 'Recipient'), delivery.shipName],
      [local('配送電話', 'Delivery phone'), delivery.shipPhone],
      [local('配送地址', 'Delivery address'), delivery.shipAddress]
    ]) {
      const field = element('div');
      field.append(element('dt',label),element('dd',value ? String(value) : '—'));
      fields.append(field);
    }
    details.append(fields);
    const actions = element('div');
    actions.className = 'merchant-order-actions';
    const orderLink = link(orderUrl(order.id), local('商家後台訂單連結', 'Merchant dashboard order link'));
    const copyLink = element('button', local('複製訂單連結', 'Copy order link'));
    copyLink.type = 'button';
    copyLink.className = 'secondary';
    copyLink.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(orderLink.href);
        report('已複製訂單連結。', 'Order link copied.');
      } catch {
        report('暫時未能複製。可在訂單連結上使用瀏覽器的複製功能。', 'Unable to copy. Use the browser’s copy-link action on the order link.');
      }
    });
    actions.append(orderLink,copyLink);
    if (delivery.shipName && delivery.shipAddress) {
      actions.append(link(endpoint + '&addressPdf=' + encodeURIComponent(order.id),
        local('下載 A4 三聯地址 PDF', 'Download A4 address PDF (3 copies)')));
    }
    details.append(actions);
    const profiles = element('section');
    profiles.append(element('h2', local('NFC 寵物檔案', 'NFC pet profiles')));
    const links = element('ul');
    for (const profile of order.profiles) {
      const item = element('li');
      item.append(link(profile.url, local('查看 ' + profile.name + ' 的檔案', 'Open ' + profile.name + ' profile'), true));
      links.append(item);
    }
    profiles.append(order.profiles.length ? links : element('p', local('此訂單尚未有檔案。', 'No saved profile for this order.')));

    const tags = element('section');
    tags.append(element('h2', local('狗牌正反面', 'Tag front and back')));
    const gallery = element('div');
    gallery.className = 'merchant-tag-gallery';
    const haveImages = new Set(order.images.map(image => image.tag_number + ':' + image.side));
    for (const [index, tag] of order.items.entries()) {
      for (const side of ['front', 'back']) {
        const label = (tag.petName || local('狗牌', 'Tag')) + ' · ' +
          (side === 'front' ? local('正面', 'Front') : local('背面', 'Back'));
        const card = element('figure');
        card.append(element('figcaption', label));
        if (haveImages.has((index + 1) + ':' + side)) {
          const url = endpoint + '&image=' + encodeURIComponent(order.id) + '&tag=' + (index + 1) + '&side=' + side;
          const open = link(url, '', true);
          const image = element('img');
          image.alt = label;
          image.loading = 'lazy';
          image.src = url;
          open.append(image);
          card.append(open);
        } else {
          card.append(element('p', local('尚未保存圖片。', 'Image not saved yet.')));
        }
        gallery.append(card);
      }
    }
    tags.append(order.items.length ? gallery : element('p', local('此訂單尚未有圖片。', 'No saved images for this order.')));
    const filesReady = order.items.every((_, index) =>
      ['front', 'back', 'print_front', 'print_back', 'print_dog'].every(side => haveImages.has((index + 1) + ':' + side)));
    if (order.provider === 'merchant' && order.items.length && !filesReady) {
      const button = element('button', local('從已保存設計生成印製圖片', 'Generate print images from saved design'));
      button.type = 'button';
      button.addEventListener('click', async () => {
        button.disabled = true;
        report('正在生成狗牌圖片…', 'Generating tag images…');
        try {
          await window.saveMerchantOrderPreviewImages({id: order.id, items: order.items}, haveImages);
          await load();
        } catch {
          report('暫時未能生成圖片，請重試。', 'Unable to generate the images. Please retry.');
        } finally {
          button.disabled = false;
        }
      });
      tags.append(button);
    }
    const print = element('section');
    print.id = 'merchant-print-files';
    print.append(element('h2', local('下載原尺寸透明 PNG', 'Download original transparent PNGs')));
    const printList = element('ul');
    const printLabels = [
      ['print_front', local('正面底板', 'Front plate')], ['print_back', local('完整背面', 'Full back')],
      ['print_dog', local('狗狗頭像', 'Dog portrait')], ['print_combined', local('正反面並排', 'Front and back')]
    ];
    for (const [index, tag] of order.items.entries()) {
      const number = index + 1;
      const ready = order.provider === 'merchant'
        ? printLabels.slice(0, 3).every(([side]) => haveImages.has(number + ':' + side))
        : number <= order.printCount;
      if (!ready) continue;
      const item = element('li');
      item.append(element('strong', tag.petName || local('狗牌 ' + number, 'Tag ' + number)));
      for (const [side, label] of printLabels) {
        const url = endpoint + '&image=' + encodeURIComponent(order.id) + '&tag=' + number + '&side=' + side;
        item.append(' · ', link(url, label));
      }
      printList.append(item);
    }
    if (printList.childElementCount) print.append(printList);
    else print.append(element('p', order.productionUnavailable
      ? local('暫時未能讀取製作檔案。', 'Production files are temporarily unavailable.')
      : local('這筆訂單尚無可下載的製作圖片。', 'There are no saved production images for this order yet.')));
    if (order.profiles.length && !order.productionUnavailable && !order.printCount) {
      const saved = savedProductionOrder(order.id,order.provider);
      if (saved) {
        const restore = element('button',local('載入這個瀏覽器已保存的製作資料','Restore production files from this browser'));
        restore.type = 'button';
        restore.className = 'secondary';
        restore.addEventListener('click',async () => {
          restore.disabled = true;
          report('正在還原製作資料…','Restoring production files…');
          try {
            const legacy = await browserProductionAssets(saved);
            await request('',{action:'recover-production-assets',orderId:order.id,legacy});
            await load();
            report('製作資料已還原。','Production files restored.');
          } catch {
            report('暫時未能還原此訂單的製作資料。','Could not restore the production files for this order.');
          } finally {
            restore.disabled = false;
          }
        });
        print.append(restore);
      }
    }
    const blocks = [info, details, profiles, tags, print];
    if (order.provider === 'airwallex' && order.items.length && order.profiles.length) {
      const resend = element('button', local('重發商家製作郵件', 'Resend merchant production email'));
      resend.type = 'button';
      resend.addEventListener('click', async () => {
        resend.disabled = true;
        report('正在寄送商家製作郵件…', 'Sending merchant production email…');
        try {
          const receipt = await resendAirwallexProduction(order.id);
          if (receipt.notificationStatus === 'sent') report('商家製作郵件已寄出。', 'Merchant production email sent.');
          else report('郵件待發送。請稍後重試。', 'Email is pending. Try again later.');
        } catch (error) {
          if (error.code === 'production_assets_missing') {
            report('這筆舊訂單需在原付款瀏覽器登入商家後台，再重發郵件。',
              'For this older order, sign in to the merchant dashboard from the original checkout browser and resend.');
          } else if (error.code === 'production_mail_busy') {
            report('郵件正在寄送，請稍後查看收件箱。', 'Email is already being sent. Check your inbox shortly.');
          } else {
            report('暫時無法發送商家製作郵件。', 'Unable to send the merchant production email.');
          }
        } finally {
          resend.disabled = false;
        }
      });
      blocks.push(resend);
    }
    if (order.provider === 'merchant' && ['pending', 'sending'].includes(order.notification_status)
        && order.items.length && filesReady) {
      const retry = element('button', local('重試商家郵件', 'Retry merchant email'));
      retry.type = 'button';
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        try {
          const receipt = await request('', {action: 'finish-review', orderId: order.id});
          await load();
          if (receipt.notificationStatus === 'sent') report('商家郵件已寄出。', 'Merchant email sent.');
          else if (receipt.notificationStatus === 'captured') report('商家測試郵件已記錄。', 'Merchant test email captured.');
          else report('郵件待發送。請稍後重試。', 'Email is pending. Try again later.');
        } catch {
          report('暫時無法發送商家郵件。', 'Unable to send the merchant email.');
        } finally {
          retry.disabled = false;
        }
      });
      blocks.push(retry);
    }
    content.replaceChildren(...blocks);
    if (location.hash === '#merchant-print-files' && printList.childElementCount) {
      print.scrollIntoView();
    }
  }

  async function load() {
    if (salesView) report('正在讀取銷售資料…', 'Loading sales data…');
    else report('正在讀取訂單…', 'Loading orders…');
    try {
      if (orderId) result = await request('&review=' + encodeURIComponent(orderId));
      else if (salesView) result = await request('&sales=1&days=' + period + '&source=' + source);
      else {
        const current = params.get('page');
        const pageQuery = current && /^[1-9][0-9]{0,5}$/.test(current) ? '&page=' + current : '';
        result = await request('&reviews=1' + pageQuery);
      }
      report();
      render();
    } catch (error) {
      if (error.status === 404) report('找不到這筆訂單。', 'Order not found.');
      else report('暫時無法讀取訂單。請重新載入，並確認已登入。', 'Unable to load orders. Reload and check that you are signed in.');
    }
  }

  window.openMerchantOrderReview = () => {
    page.hidden = false;
    render();
    load();
  };
})();
