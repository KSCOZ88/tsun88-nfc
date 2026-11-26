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
  const heading = element('h1', local('商家訂單', 'Merchant orders'));
  const nav = element('nav');
  nav.append(link('/merchant', local('建立免付款訂單', 'Create a no-payment order')));
  if (orderId) nav.append(link('/merchant/orders', local('全部訂單', 'All orders')));
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

  function showList(orders) {
    if (!orders.length) {
      content.replaceChildren(element('p', local('暫無訂單。', 'No orders yet.')));
      return;
    }
    const table = element('table');
    const header = table.createTHead().insertRow();
    for (const title of [local('訂單號', 'Order'), local('寵物', 'Pet'), local('來源', 'Source'), local('生產狀態', 'Queue status')]) {
      header.append(element('th', title));
    }
    const body = table.createTBody();
    for (const order of orders) {
      const row = body.insertRow();
      row.insertCell().append(link(orderUrl(order.id), order.id));
      row.insertCell().textContent = order.pet_name || '—';
      row.insertCell().textContent = providerName(order.provider);
      row.insertCell().textContent = queueStatus(order.queue_status);
    }
    content.replaceChildren(table);
  }

  function showDetail(order) {
    heading.textContent = order.pet_name || local('訂單詳情', 'Order details');
    const info = element('p', order.id + ' · ' + providerName(order.provider) + ' · ' + queueStatus(order.queue_status));
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
    if (order.provider === 'merchant' && order.items.length && haveImages.size !== order.items.length * 2) {
      const button = element('button', local('從已保存設計生成正反面', 'Generate images from saved design'));
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
    const blocks = [info, profiles, tags];
    if (order.provider === 'merchant' && ['pending', 'sending'].includes(order.notification_status)
        && order.items.length && haveImages.size === order.items.length * 2) {
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
    status.textContent = local('正在讀取訂單…', 'Loading orders…');
    try {
      if (orderId) showDetail(await request('&review=' + encodeURIComponent(orderId)));
      else showList((await request('&reviews=1')).orders);
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
