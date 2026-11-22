'use strict';

(function () {
  if (!window.location.pathname.match(/^\/merchant\/?$/)) return;

  const byId = id => document.getElementById(id);
  const local = (zh, en) => document.documentElement.lang.toLowerCase().startsWith('zh') ? zh : en;
  const checkout = byId('checkout');
  const shipping = byId('postPaymentShippingForm');
  const email = byId('customerEmailField');
  const summary = checkout.querySelector('.payment-checkout');
  const dialog = document.createElement('dialog');
  let submissionId;
  let lastPayload;
  let receipt;
  let signedIn = false;

  dialog.id = 'merchantLogin';
  dialog.setAttribute('aria-labelledby', 'merchantLoginTitle');
  dialog.innerHTML = `<form id="merchantLoginForm">
    <h2 id="merchantLoginTitle"></h2><p id="merchantLoginHelp"></p>
    <label for="merchantAccessKey" id="merchantAccessLabel"></label>
    <input id="merchantAccessKey" type="password" autocomplete="current-password" required maxlength="64">
    <button type="submit" class="primary" id="merchantSignIn"></button>
    <p id="merchantLoginStatus" role="status"></p>
  </form>`;
  document.body.append(dialog);
  dialog.addEventListener('cancel', event => event.preventDefault());

  const controls = document.createElement('div');
  controls.innerHTML = `<div class="action-row"><button type="button" class="primary" id="merchantSubmit"></button></div>
    <p id="merchantPreviewStatus" role="status"></p>
    <div id="merchantPreviewReceipt" hidden>
      <p id="merchantSavedReference" translate="no"></p><ul id="merchantProfileLinks"></ul>
      <button type="button" class="secondary" id="merchantNewOrder"></button>
    </div>`;
  const actions = summary.querySelector('.action-row');
  actions.before(shipping, controls);
  const logout = document.createElement('button');
  logout.type = 'button';
  logout.id = 'merchantSignOut';
  logout.hidden = true;
  document.querySelector('.topbar nav').append(logout);

  function labels() {
    checkout.querySelector('.section-title h2').textContent = local('確認商家訂單', 'Confirm merchant order');
    checkout.querySelector('.section-title p').textContent = local(
      '預覽測試。請填寫配送資料後提交，無需付款。', 'Preview test. Enter delivery details and submit without payment.');
    byId('customerEmailHelp').textContent = local('客戶電郵會隨訂單保存。', 'The customer email is saved with the order.');
    byId('merchantLoginTitle').textContent = local('8TSUN8 商家登入', '8TSUN8 merchant sign-in');
    byId('merchantLoginHelp').textContent = local('請使用預覽存取金鑰。測試時請填寫虛構資料。', 'Use the preview access key and enter fictional test details.');
    byId('merchantAccessLabel').textContent = local('商家存取金鑰', 'Merchant access key');
    byId('merchantSignIn').textContent = local('登入', 'Sign in');
    byId('merchantSubmit').textContent = local('提交測試訂單', 'Submit test order');
    byId('merchantNewOrder').textContent = local('建立下一筆測試訂單', 'Start another test order');
    logout.textContent = local('商家登出', 'Merchant sign out');
    if (receipt) byId('merchantPreviewStatus').textContent = local(
      '測試訂單及檔案已保存，已加入預覽隊列。商家郵件已記錄。', 'Test order and profiles saved, preview job queued, and merchant email captured.');
  }

  async function request(body) {
    const response = await fetch('/api/merchant-order', body ? {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    } : {});
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error), {status: response.status});
    return result;
  }

  function lock(available = true) {
    signedIn = false;
    document.documentElement.dataset.merchantPreview = 'locked';
    if (!dialog.open) dialog.showModal();
    byId('merchantSignIn').disabled = !available;
    if (!available) byId('merchantLoginStatus').textContent = local(
      '商家預覽目前未啟用。', 'Merchant preview is currently unavailable.');
  }

  function unlock() {
    signedIn = true;
    document.documentElement.dataset.merchantPreview = 'active';
    logout.hidden = false;
    dialog.close();
  }

  byId('merchantLoginForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = byId('merchantSignIn');
    const input = byId('merchantAccessKey');
    button.disabled = true;
    byId('merchantLoginStatus').textContent = '';
    try {
      await request({action: 'login', key: input.value});
      unlock();
    } catch (error) {
      byId('merchantLoginStatus').textContent = error.status === 401
        ? local('商家金鑰不正確。', 'Incorrect merchant access key.')
        : local('登入暫時失敗，請重試。', 'Sign-in temporarily failed. Please retry.');
    } finally {
      input.value = '';
      button.disabled = false;
    }
  });

  logout.addEventListener('click', async () => {
    try {
      await request({action: 'logout'});
      location.replace('/merchant');
    } catch {
      toast(local('登出暫時失敗，請重試。', 'Sign-out temporarily failed. Please retry.'));
    }
  });

  function resetCheckout() {
    submissionId = undefined;
    lastPayload = undefined;
    receipt = undefined;
    byId('merchantPreviewReceipt').hidden = true;
    byId('merchantPreviewStatus').textContent = '';
    byId('merchantSubmit').disabled = false;
    byId('merchantSubmit').parentElement.hidden = false;
    actions.hidden = shipping.hidden = email.hidden = false;
  }

  byId('merchantNewOrder').addEventListener('click', () => {
    resetCheckout();
    go('home');
    for (const id of ['customerEmail', 'smartAddress', 'shipName', 'shipPhone', 'shipAddress']) byId(id).value = '';
  });

  function shippingDetails() {
    const fields = {name: byId('shipName'), phone: byId('shipPhone'), address: byId('shipAddress')};
    for (const field of Object.values(fields)) {
      if (!field.value.trim()) {
        field.focus();
        toast(local('請填寫完整配送資料。', 'Enter all delivery details.'));
        return null;
      }
    }
    const addressIssue = shippingAddressIssue(fields.address.value);
    if (addressIssue) {
      fields.address.focus();
      toast(addressIssue, 7000);
      return null;
    }
    return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value.trim()]));
  }

  async function submit() {
    if (!signedIn || receipt || !currentOrder || !ensureCheckoutProfiles() ||
        !validateOrderPhoneConfirmations(currentOrder.items) || !validateCustomerEmail()) return;
    const shippingData = shippingDetails();
    if (!shippingData) return;
    const button = byId('merchantSubmit');
    const status = byId('merchantPreviewStatus');
    button.disabled = true;
    status.textContent = local('正在保存測試訂單…', 'Saving test order…');
    try {
      const order = {
        customerEmail: state.customerEmail,
        shipping: shippingData,
        language: window.TsunI18n?.locale,
        items: currentOrder.items.map(item => {
          const {nfcProfile, phoneConfirmation, ...design} = item;
          const profile = petProfilePayload(item);
          delete profile.order_id;
          return {...design, profile};
        })
      };
      const payload = JSON.stringify(order);
      if (lastPayload && lastPayload !== payload) {
        status.textContent = local('資料已變更。請先恢復上次送出的資料，再重試。', 'Details changed. Restore the last submitted details before retrying.');
        return;
      }
      if (!submissionId) submissionId = 'TEST-M-' + crypto.randomUUID().replaceAll('-', '');
      lastPayload = payload;
      const saved = await request({action: 'submit', order: {...order, id: submissionId}});
      receipt = saved;
      byId('merchantSavedReference').textContent = saved.id;
      const links = saved.profiles.map(profile => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.target = '_blank';
        a.rel = 'noopener';
        a.href = profile.url;
        a.textContent = profile.name;
        li.append(a);
        return li;
      });
      byId('merchantProfileLinks').replaceChildren(...links);
      byId('merchantPreviewReceipt').hidden = false;
      button.parentElement.hidden = shipping.hidden = email.hidden = actions.hidden = true;
      labels();
    } catch (error) {
      if (error.status === 401) lock();
      if (error.status === 422) {
        lastPayload = undefined;
        status.textContent = local('有欄位未填妥或照片過大，請檢查後重試。', 'Check the order fields and photo size, then try again.');
      } else {
        status.textContent = local('提交暫時失敗。請保留資料並重試。', 'Submission temporarily failed. Keep your details and retry.');
      }
    } finally {
      button.disabled = false;
    }
  }

  byId('merchantSubmit').addEventListener('click', submit);
  new MutationObserver(labels).observe(document.documentElement, {attributes: true, attributeFilter: ['lang']});
  labels();
  lock();
  request().then(result => {
    if (result.authenticated) unlock();
  }).catch(() => lock(false));
})();
