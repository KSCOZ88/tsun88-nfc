'use strict';

(function () {
  if (location.pathname.replace(/\/$/, '') !== '/merchant/orders') return;

  const endpoint = '/api/order-email?merchantPreview=1';
  const page = document.createElement('main');
  page.id = 'merchantOrderReview';
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
  const heading = element('h1', salesView ? local('銷售分析', 'Sales analytics') : local('商家訂單', 'Merchant orders'));
  const nav = element('nav');
  nav.append(link('/merchant', local('建立免付款訂單', 'Create a no-payment order')));
  if (orderId || salesView) nav.append(link(historyUrl, local('訂單歷史', 'Order history')));
  if (!salesView) nav.append(link(salesUrl, local('銷售分析', 'Sales analytics')));
  const status = element('p');
  status.setAttribute('role', 'status');
  const content = element('div');
  page.append(heading, nav, status, content);

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
    if (!response.ok) throw Object.assign(new Error('Order review unavailable'), {status: response.status});
    return response.json();
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
    content.replaceChildren(salesFilters(), metrics, ...(peakText ? [peakText] : []), grid, scope);
  }

  function showDetail(order) {
    heading.textContent = order.pet_name || local('訂單詳情', 'Order details');
    const info = element('p', orderNumber(order) + ' · ');
    info.append(orderTime(order.created_at), ' ' + local('（香港時間）', '(HKT)'),
      ' · ' + providerName(order.provider) + ' · ' + queueStatus(order.queue_status));
    const reference = element('p', local('訂單參考號 ', 'Order reference ') + order.id);
    reference.className = 'merchant-order-reference';
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
        status.textContent = local('正在生成狗牌圖片…', 'Generating tag images…');
        try {
          await window.saveMerchantOrderPreviewImages({id: order.id, items: order.items}, haveImages);
          await load();
        } catch {
          status.textContent = local('暫時未能生成圖片，請重試。', 'Unable to generate the images. Please retry.');
        } finally {
          button.disabled = false;
        }
      });
      tags.append(button);
    }
    const blocks = [info, reference, profiles, tags];
    if (order.provider === 'merchant' && ['pending', 'sending'].includes(order.notification_status)
        && order.items.length && filesReady) {
      const retry = element('button', local('重試商家郵件', 'Retry merchant email'));
      retry.type = 'button';
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        try {
          const receipt = await request('', {action: 'finish-review', orderId: order.id});
          await load();
          status.textContent = receipt.notificationStatus === 'sent'
            ? local('商家郵件已寄出。', 'Merchant email sent.')
            : receipt.notificationStatus === 'captured'
              ? local('商家測試郵件已記錄。', 'Merchant test email captured.')
              : local('郵件待發送。請稍後重試。', 'Email is pending. Try again later.');
        } catch {
          status.textContent = local('暫時無法發送商家郵件。', 'Unable to send the merchant email.');
        } finally {
          retry.disabled = false;
        }
      });
      blocks.push(retry);
    }
    content.replaceChildren(...blocks);
  }

  async function load() {
    status.textContent = salesView ? local('正在讀取銷售資料…', 'Loading sales data…')
      : local('正在讀取訂單…', 'Loading orders…');
    try {
      if (orderId) showDetail(await request('&review=' + encodeURIComponent(orderId)));
      else if (salesView) showSales(await request('&sales=1&days=' + period + '&source=' + source));
      else {
        const current = params.get('page');
        const pageQuery = current && /^[1-9][0-9]{0,5}$/.test(current) ? '&page=' + current : '';
        showList(await request('&reviews=1' + pageQuery));
      }
      status.textContent = '';
    } catch (error) {
      status.textContent = error.status === 404
        ? local('找不到這筆訂單。', 'Order not found.')
        : local('暫時無法讀取訂單。請重新載入，並確認已登入。', 'Unable to load orders. Reload and check that you are signed in.');
    }
  }

  window.openMerchantOrderReview = () => {
    page.hidden = false;
    load();
  };
})();
