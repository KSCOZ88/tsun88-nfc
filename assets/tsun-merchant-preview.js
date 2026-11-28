'use strict';

(function () {
  const route = window.location.pathname.replace(/\/$/, '');
  if (route === '') {
    const wordmark = document.getElementById('tsunJourneyHome');
    let taps = 0;
    let firstTapAt = 0;
    wordmark?.addEventListener('click', event => {
      const now = performance.now();
      if (!taps || now - firstTapAt > 3000) {
        firstTapAt = now;
        taps = 0;
      }
      taps += 1;
      if (taps !== 5) return;
      taps = 0;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.location.assign('/merchant');
    }, {capture: true});
    return;
  }
  if (route !== '/merchant' && route !== '/merchant/orders') return;
  const isOrders = route === '/merchant/orders';

  const localeKey = 'tsun88.merchant.locale';
  try {
    const preferred = localStorage.getItem(localeKey);
    if (preferred === 'en' || preferred === 'zh-Hant') window.TsunI18n.setLocale(preferred);
  } catch {}
  window.addEventListener('tsun-language-change', event => {
    try { localStorage.setItem(localeKey, event.detail.locale); } catch {}
  });


  const byId = id => document.getElementById(id);
  const local = (zh, en) => document.documentElement.lang.toLowerCase().startsWith('zh') ? zh : en;
  const checkout = byId('checkout');
  const shipping = byId('postPaymentShippingForm');
  const email = byId('customerEmailField');
  const summary = checkout.querySelector('.payment-checkout');
  const endpoint = '/api/order-email?merchantPreview=1';
  const dialog = document.createElement('dialog');
  let submissionId;
  let lastPayload;
  let receipt;
  let signedIn = false;
  let previewMode = false;
  let invalidField;
  const fieldError = document.createElement('p');
  fieldError.id = 'merchantFieldError';
  fieldError.setAttribute('role', 'alert');
  fieldError.style.color = '#9b2424';

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

  const checkoutForm = document.createElement('div');
  checkoutForm.id = 'merchantCheckoutForm';
  const actions = summary.querySelector('.action-row');
  actions.classList.add('merchant-edit-actions');
  const submitButton = document.createElement('button');
  submitButton.type = 'button';
  submitButton.className = 'primary';
  submitButton.id = 'merchantSubmit';
  const status = document.createElement('p');
  status.id = 'merchantPreviewStatus';
  status.setAttribute('role', 'status');
  const formActions = document.createElement('div');
  formActions.className = 'merchant-form-actions';
  formActions.append(actions, submitButton);
  checkoutForm.append(email, shipping, status, formActions);

  const receiptPanel = document.createElement('section');
  receiptPanel.id = 'merchantPreviewReceipt';
  receiptPanel.hidden = true;
  receiptPanel.innerHTML = `<p id="merchantReceiptStatus" role="status"></p>
    <dl class="merchant-order-reference">
      <dt id="merchantReferenceLabel"></dt>
      <dd id="merchantSavedReference" translate="no"></dd>
    </dl>
    <div class="merchant-receipt-profiles">
      <h3 id="merchantProfilesHeading"></h3>
      <ul id="merchantProfileLinks"></ul>
    </div>
    <div class="merchant-receipt-actions">
      <a id="merchantReceiptReview" class="primary"></a>
      <button type="button" class="secondary" id="merchantNewOrder"></button>
    </div>`;
  summary.append(checkoutForm, receiptPanel);

  const logout = document.createElement('button');
  logout.type = 'button';
  logout.id = 'merchantSignOut';
  const orderList = document.createElement('a');
  orderList.href = '/merchant/orders';
  const merchantNav = document.createElement('div');
  merchantNav.className = 'merchant-nav';
  merchantNav.hidden = true;
  merchantNav.append(orderList, logout);
  const topNav = document.querySelector('.topbar nav');
  const homeLink = document.createElement('a');
  homeLink.href = '/';
  homeLink.className = 'merchant-home-link';
  homeLink.translate = false;
  topNav.querySelector('button[data-go="home"]').replaceWith(homeLink);
  const nameBackLink = homeLink.cloneNode();
  nameBackLink.className = 'secondary merchant-name-back';
  byId('name').querySelector('button[data-go="home"]').replaceWith(nameBackLink);
  topNav.append(merchantNav);

  const receiptLink = byId('merchantReceiptReview');
  const checkoutTitle = checkout.querySelector('.section-title h2');
  const checkoutSubtitle = checkout.querySelector('.section-title p');
  checkoutTitle.translate = checkoutSubtitle.translate = false;

  function labels() {
    const profileSteps = byId('petProfile')?.querySelector('.section-title p');
    if (profileSteps) {
      profileSteps.setAttribute('translate', 'no');
      profileSteps.textContent = local('正反面預覽 → NFC 檔案 → 配送資料', 'Front & back preview → NFC profile → Delivery details');
    }
    checkoutTitle.textContent = receipt ? local('訂單已完成', 'Order complete') : local('確認商家訂單', 'Confirm merchant order');
    checkoutSubtitle.hidden = Boolean(receipt);
    checkoutSubtitle.textContent = local(
      previewMode ? '預覽測試。請填寫配送資料後提交，無需付款。' : '請填寫配送資料後提交，無需付款。',
      previewMode ? 'Preview test. Enter delivery details and submit without payment.' : 'Enter delivery details and submit without payment.');
    byId('customerEmailHelp').textContent = local('客戶電郵會隨訂單保存。', 'The customer email is saved with the order.');
    byId('merchantLoginTitle').textContent = local('8TSUN8 商家登入', '8TSUN8 merchant sign-in');
    byId('merchantLoginHelp').textContent = previewMode
      ? local('請使用預覽存取金鑰。測試時請填寫虛構資料。', 'Use the preview access key and enter fictional test details.')
      : local('請使用商家存取金鑰。', 'Use your merchant access key.');
    byId('merchantAccessLabel').textContent = local('商家存取金鑰', 'Merchant access key');
    byId('merchantSignIn').textContent = local('登入', 'Sign in');
    byId('merchantSubmit').textContent = previewMode ? local('提交測試訂單', 'Submit test order') : local('提交訂單', 'Submit order');
    byId('merchantNewOrder').textContent = previewMode ? local('建立下一筆測試訂單', 'Start another test order') : local('建立下一筆訂單', 'Start another order');
    homeLink.textContent = local('網站首頁', 'Storefront');
    nameBackLink.textContent = local('返回網站首頁', 'Back to storefront');
    logout.textContent = local('商家登出', 'Merchant sign out');
    orderList.textContent = local('訂單後台', 'Order dashboard');
    receiptLink.textContent = local('查看訂單詳情', 'View order details');
    byId('merchantReferenceLabel').textContent = local('訂單編號', 'Order number');
    byId('merchantProfilesHeading').textContent = local('NFC 寵物檔案', 'NFC pet profiles');
    if (receipt) {
      const mail = receipt.notificationStatus === 'sent'
        ? local('商家郵件已寄出。', 'Merchant email sent.')
        : receipt.notificationStatus === 'captured'
          ? local('商家測試郵件已記錄。', 'Merchant test email captured.')
          : local('商家郵件待發送。', 'Merchant email pending.');
      byId('merchantReceiptStatus').textContent = local(
        previewMode ? '測試訂單、正反面及檔案已保存，已加入預覽隊列。' : '訂單、正反面及檔案已保存，已加入生產隊列。',
        previewMode ? 'Test order, tag images, and profiles saved. Preview job queued.' : 'Order, tag images, and profiles saved. Production job queued.') + ' ' + mail;
    }
  }

  async function request(body) {
    const response = await fetch(endpoint, body ? {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    } : {});
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error), {status: response.status, code: result.error});
    return result;
  }

  function lock(available = true) {
    signedIn = false;
    document.documentElement.dataset.merchantPreview = 'locked';
    if (isOrders) byId('merchantOrderReview').hidden = true;
    if (!dialog.open) dialog.showModal();
    byId('merchantSignIn').disabled = !available;
    if (!available) byId('merchantLoginStatus').textContent = local(
      '商家預覽目前未啟用。', 'Merchant preview is currently unavailable.');
  }

  function unlock() {
    signedIn = true;
    document.documentElement.dataset.merchantPreview = 'active';
    merchantNav.hidden = false;
    dialog.close();
    if (isOrders) window.openMerchantOrderReview();
    else if (byId('home').classList.contains('active')) go('name');
  }

  byId('merchantLoginForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = byId('merchantSignIn');
    const input = byId('merchantAccessKey');
    button.disabled = true;
    byId('merchantLoginStatus').textContent = '';
    try {
      const result = await request({action: 'login', key: input.value});
      previewMode = result.preview !== false;
      labels();
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
    clearFieldError();
    submissionId = undefined;
    lastPayload = undefined;
    receipt = undefined;
    receiptPanel.hidden = true;
    checkoutForm.hidden = false;
    status.textContent = '';
    submitButton.disabled = false;
    labels();
  }

  byId('merchantNewOrder').addEventListener('click', () => {
    resetCheckout();
    resetHomeCustomization();
    go('name');
    byId('firstName').focus({preventScroll: true});
  });

  topNav.addEventListener('click', event => {
    if (!receipt || !event.target.closest('button[data-go="name"]')) return;
    resetCheckout();
    resetHomeCustomization();
  }, {capture: true});

  function clearFieldError() {
    if (!invalidField) return;
    invalidField.removeAttribute('aria-invalid');
    const descriptions = (invalidField.getAttribute('aria-describedby') || '').split(' ')
      .filter(id => id && id !== fieldError.id).join(' ');
    if (descriptions) invalidField.setAttribute('aria-describedby', descriptions);
    else invalidField.removeAttribute('aria-describedby');
    invalidField = undefined;
    fieldError.remove();
  }

  function showFieldError(field, message) {
    clearFieldError();
    invalidField = field;
    field.setAttribute('aria-invalid', 'true');
    const descriptions = field.getAttribute('aria-describedby');
    field.setAttribute('aria-describedby', descriptions ? descriptions + ' ' + fieldError.id : fieldError.id);
    fieldError.textContent = message;
    field.after(fieldError);
    field.focus();
    field.scrollIntoView({block: 'center'});
  }

  function deliveryPhoneError() {
    return local('請輸入有效的配送電話，至少要有 8 位數字。', 'Enter a valid delivery phone number with at least 8 digits.');
  }

  function shippingDetails() {
    clearFieldError();
    const fields = {name: byId('shipName'), phone: byId('shipPhone'), address: byId('shipAddress')};
    const name = fields.name.value.trim();
    const phone = fields.phone.value.trim();
    const address = fields.address.value.trim();
    if (!name || name.length > 120) {
      showFieldError(fields.name, local('請填寫收件人姓名（最多 120 個字元）。', 'Enter the recipient name (up to 120 characters).'));
      return null;
    }
    if (!/^\+?[\d ()-]{8,24}$/.test(phone) || phone.replace(/\D/g, '').length < 8) {
      showFieldError(fields.phone, deliveryPhoneError());
      return null;
    }
    const addressIssue = shippingAddressIssue(address);
    if (!address || address.length > 1000 || addressIssue) {
      const message = !address || address.length > 1000
        ? local('請填寫完整配送地址（最多 1,000 個字元）。', 'Enter the full delivery address (up to 1,000 characters).')
        : local('請補充樓層和室號，或註明整層、店舖等實際配送位置。', 'Add a floor and flat number, or specify the exact delivery location.');
      showFieldError(fields.address, message);
      return null;
    }
    return {name, phone, address};
  }

  const printSides = ['front', 'back', 'dog'];

  async function printPngData(blob) {
    // Match the server's per-image budget for a single email with up to 20 tags.
    if (blob.size <= 300000) return blobToDataUrl(blob);
    const url = URL.createObjectURL(blob);
    try {
      const image = await loadExportImage(url);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      let scale = 0.85;
      do {
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        blob = await canvasBlob(canvas);
        scale *= 0.85;
      } while (blob.size > 300000);
      return blobToDataUrl(blob);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function prepareReviewUploads(order, alreadySaved = new Set()) {
    const tags = order.items.map((_, index) => index + 1);
    const missingReviews = tags.filter(tag => !['front', 'back'].every(side => alreadySaved.has(tag + ':' + side)));
    const missingPrints = tags.filter(tag => !printSides.every(side => alreadySaved.has(tag + ':print_' + side)));
    const uploads = [];
    if (missingReviews.length) {
      const previews = await prepareEmailPreviews(order);
      for (const tagNumber of missingReviews) {
        uploads.push({action: 'save-review-images', orderId: order.id, tagNumber,
          previews: previews.slice((tagNumber - 1) * 2, tagNumber * 2)});
      }
    }
    if (missingPrints.length) {
      const files = await prepareProductionFiles(order);
      for (const tagNumber of missingPrints) {
        const key = 'tag' + String(tagNumber).padStart(2, '0') + '_';
        const previews = await Promise.all(printSides.map(async side => ({
          data: await printPngData(files[key + side].blob)
        })));
        uploads.push({action: 'save-print-images', orderId: order.id, tagNumber, previews});
      }
    }
    return uploads;
  }

  async function uploadReviewImages(uploads) {
    for (const upload of uploads) await request(upload);
  }

  window.saveMerchantOrderPreviewImages = async (order, alreadySaved) => {
    await uploadReviewImages(await prepareReviewUploads(order, alreadySaved));
  };

  async function submit() {
    if (!signedIn || receipt || !currentOrder || !ensureCheckoutProfiles() ||
        !validateOrderPhoneConfirmations(currentOrder.items) || !validateCustomerEmail()) return;
    status.textContent = '';
    const shippingData = shippingDetails();
    if (!shippingData) return;
    submitButton.disabled = true;
    status.textContent = previewMode ? local('正在保存測試訂單…', 'Saving test order…') : local('正在保存訂單…', 'Saving order…');
    let stage = 'render';
    try {
      const language = window.TsunI18n?.locale === 'zh-Hant' ? 'zh-Hant' : 'en';
      const order = {
        customerEmail: state.customerEmail,
        shipping: shippingData,
        language,
        items: currentOrder.items.map(item => {
          const {nfcProfile, phoneConfirmation, ...design} = item;
          const profile = petProfilePayload({...item, language});
          delete profile.order_id;
          return {...design, profile};
        })
      };
      const payload = JSON.stringify(order);
      if (lastPayload && lastPayload !== payload) {
        status.textContent = local('資料已變更。請先恢復上次送出的資料，再重試。', 'Details changed. Restore the last submitted details before retrying.');
        return;
      }
      if (!submissionId) submissionId = (previewMode ? 'TEST-M-' : 'M-') + crypto.randomUUID().replaceAll('-', '');
      const reviewOrder = {id: submissionId, items: currentOrder.items};
      // Build the pictures first so a renderer failure never creates a partial order.
      const uploads = await prepareReviewUploads(reviewOrder);
      lastPayload = payload;
      stage = 'save';
      await request({action: 'submit', review: true, order: {...order, id: submissionId}});
      stage = 'upload';
      await uploadReviewImages(uploads);
      stage = 'finish';
      const saved = await request({action: 'finish-review', orderId: submissionId});
      receipt = saved;
      byId('merchantSavedReference').textContent = saved.id;
      receiptLink.href = '/merchant/orders?order=' + encodeURIComponent(saved.id);
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
      checkoutForm.hidden = true;
      receiptPanel.hidden = false;
      labels();
      checkoutTitle.tabIndex = -1;
      checkoutTitle.focus({preventScroll: true});
      window.scrollTo({top: 0, behavior: 'instant'});
    } catch (error) {
      if (!lastPayload) submissionId = undefined;
      if (error.status === 401) lock();
      if (error.status === 422 || error.status === 413) {
        if (stage === 'save') {
          lastPayload = undefined;
          submissionId = undefined;
        }
        if (error.code === 'invalid_shipping_phone') {
          status.textContent = '';
          showFieldError(byId('shipPhone'), deliveryPhoneError());
        } else if (error.code === 'invalid_print_image' || error.code === 'invalid_review_image') {
          status.textContent = local('未能保存透明印製圖片，請重試。', 'The transparent print images could not be saved. Please retry.');
        } else if (error.code === 'invalid_photo_data' || error.status === 413) {
          status.textContent = local('請返回寵物檔案，換用較小的 PNG、JPG 或 WebP 照片後再試。', 'Return to the pet profile and try a smaller PNG, JPG, or WebP photo.');
        } else {
          status.textContent = local('請檢查配送資料及寵物檔案的必填欄位。', 'Check the required delivery and pet profile fields.');
        }
      } else if (stage === 'finish') {
        status.textContent = local('訂單和圖片已保存，最後處理未完成。請再按提交以繼續處理同一筆訂單。', 'The order and images are saved. Submit again to finish the same order.');
      } else if (stage === 'upload') {
        status.textContent = local('訂單已保存，圖片未全部上傳。請再按提交以上傳剩餘圖片。', 'The order is saved. Submit again to finish uploading the images.');
      } else if (stage === 'render') {
        status.textContent = local('未能生成製作圖片，訂單尚未提交。請重試。', 'The print images could not be generated. Try submitting again.');
      } else {
        status.textContent = local('提交暫時失敗。請保留資料並重試。', 'Submission temporarily failed. Keep your details and retry.');
      }
    } finally {
      submitButton.disabled = false;
    }
  }

  shipping.addEventListener('input', event => {
    if (event.target === invalidField) clearFieldError();
  });
  submitButton.addEventListener('click', submit);
  new MutationObserver(labels).observe(document.documentElement, {attributes: true, attributeFilter: ['lang']});
  labels();
  lock();
  request().then(result => {
    previewMode = result.preview !== false;
    labels();
    if (result.authenticated) unlock();
  }).catch(error => {
    if (error.code === 'not_available') {
      lock(false);
      return;
    }
    byId('merchantLoginStatus').textContent = local(
      '暫時無法確認登入狀態，請重試登入。', 'Unable to check sign-in status. Please try signing in.');
  });
})();
