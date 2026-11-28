(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.TsunOrderEmail=factory();
})(typeof globalThis==='object'?globalThis:this,function(){
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeUrl=value=>{try{const u=new URL(value);return u.protocol==='https:'?u.href:'';}catch{return '';}};
  const copy={
    'zh-Hant':{
      titles:{payment_received:'付款成功，專屬狗牌即將啟程',order_completed:'資料已收齊，萌寵檔案來啦',in_production:'你的專屬狗牌正在製作中',shipped:'你的狗牌已經寄出！'},
      intros:{
        payment_received:n=>`謝謝你為 ${n} 選擇 8TSUN8！我們已收到你的付款。請繼續填寫送貨資料和寵物檔案，資料齊全後便會開始製作。`,
        order_completed:n=>`${n} 的訂單資料已經收齊，我們會按照確認的設計安排製作。萌寵檔案也準備好啦，點擊下方連結即可查看。`,
        in_production:n=>`${n} 的專屬狗牌正在用心製作中。每一份小小的守護，都值得我們認真完成。`,
        shipped:n=>`${n} 的狗牌已經寄出，正向你飛奔而來！願它陪伴寶貝安心探索，也多一個回家的方法。`
      },
      order:'訂單編號',payment:'付款方式',tag:'狗牌',decor:'裝飾',paid:'實付金額',pet:'寵物',base:'底板',profile:'看看我們的萌寵檔案',profilePending:'完成送貨資料和寵物檔案後，我們會再發送檔案連結。',carrier:'快遞公司',tracking:'追蹤編號',greeting:'如果有任何問題，直接回覆這封電郵即可，我們會盡快為你解答。訂單後續進度也會透過這個電郵通知你。',signoff:'我們會把這份小小的守護認真做好，讓它早日來到你和寶貝身邊。',merchantTitle:'新訂單已付款，資料已收齊',customer:'客戶電郵',shipName:'收件人',phone:'聯絡電話',address:'送貨地址',nfc:'NFC 寵物檔案',production:'請將檔案連結寫入 NFC；生產圖片請查看附件。',subject:'8TSUN8｜'
    },
    en:{
      titles:{payment_received:'Payment received — your pet tag is on its way',order_completed:'Order details received — your pet profile is ready',in_production:'Your 8TSUN8 pet tag is being made',shipped:'Your 8TSUN8 pet tag has shipped'},
      intros:{
        payment_received:n=>`Thank you for choosing 8TSUN8 for ${n}! Your payment has been received. Please complete the shipping details and pet profile so we can begin production.`,
        order_completed:n=>`We have received all the details for ${n}'s order and will make the tag according to your confirmed design. Your pet profile is ready to view below.`,
        in_production:n=>`${n}'s custom pet tag is now being carefully made. Every little detail deserves our attention.`,
        shipped:n=>`${n}'s pet tag is on its way! We hope it helps your best friend explore with confidence and find their way home.`
      },
      order:'Order number',payment:'Payment method',tag:'Pet tag',decor:'Decorations',paid:'Total paid',pet:'Pet',base:'Tag design',profile:'View your pet profile',profilePending:'We will email your pet profile link once the shipping details and pet profile are complete.',carrier:'Carrier',tracking:'Tracking number',greeting:'If you have any questions, simply reply to this email and we will be happy to help. We will also send order updates to this address.',signoff:'We will take good care of every detail and get this little piece of protection to you and your pet soon.',merchantTitle:'New paid order — details received',customer:'Customer email',shipName:'Recipient',phone:'Phone',address:'Shipping address',nfc:'NFC pet profile',production:'Please write the profile link to the NFC tag. Production artwork is attached.',subject:'8TSUN8 | '
    }
  };
  function language(order){return order?.language==='zh-Hant'||order?.locale==='zh-HK'?'zh-Hant':'en';}
  function totals(order){
    const items=Array.isArray(order.items)&&order.items.length?order.items:[order];
    const quantity=items.length;
    const decorCount=items.reduce((total,item)=>total+['front','back'].reduce((sum,side)=>sum+(item.decorItems?.[side]?.length||0),0),0);
    return {items,quantity,decorCount,total:quantity*299+decorCount*3};
  }
  function render(order,stage='payment_received',previews=[]){
    const lang=language(order),t=copy[lang];
    if(!t.titles[stage])throw new Error('Unknown order email stage');
    const {items,quantity,decorCount,total}=totals(order);
    const name=escape(order.petName||items[0].petName||(lang==='en'?'your pet':'你的寶貝'));
    const url=safeUrl(order.cloudProfile?.publicUrl);
    const designs=previews.map((p,index)=>{
      const img=String(p.src||'');
      if(!new RegExp('^data:image/png;base64,[A-Za-z0-9+/=]+$').test(img)&&!/^cid:[A-Za-z0-9_-]+$/.test(img))return '';
      return `<td style="width:50%;padding:8px;text-align:center;vertical-align:top"><img alt="${escape(p.label||t.tag)}" src="${escape(img)}" width="220" style="max-width:100%;height:auto;border-radius:16px;background:#f7fbfd"><div style="font-size:13px;color:#607c88">${escape(p.label||t.tag+' '+(index+1))}</div></td>`;
    });
    const pictures=designs.map((html,i)=>i%2===0?'<tr>'+html+(designs[i+1]||'<td></td>')+'</tr>':'').join('');
    const rows=items.map((item,i)=>`<tr><td style="padding:8px 0">${t.pet} ${i+1} · ${escape(item.petName||order.petName||(lang==='en'?'Pet':'寵物'))}</td><td style="text-align:right">${escape(item.baseLabel||order.baseLabel||t.base)}</td></tr>`).join('');
    const profile=url?`<div style="padding:18px;background:#f0faf4;border-radius:14px;margin:20px 0"><b>${t.profile}</b><p style="word-break:break-all"><a href="${escape(url)}" style="color:#26735a">${escape(url)}</a></p></div>`:`<p style="color:#607c88">${t.profilePending}</p>`;
    const shipping=stage==='shipped'?`<p>${t.carrier}: ${escape(order.shippingCarrier)}<br>${t.tracking}: ${escape(order.trackingNumber)}</p>`:'';
    const subject=`${t.subject}${t.titles[stage]} | ${String(order.id||'').replace(/[\\r\\n]/g,'')}`;
    const closing=stage==='shipped'?t.signoff:t.signoff;
    const html=`<!doctype html><html lang="${lang==='en'?'en':'zh-HK'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f5fafc;font-family:Arial,'PingFang TC','Microsoft JhengHei',sans-serif;color:#244452;line-height:1.8"><div style="max-width:620px;margin:24px auto;background:#fff;border:1px solid #dcecf2;border-radius:24px;overflow:hidden"><div style="padding:24px 28px;background:#e4f4fc"><b style="font-size:24px;letter-spacing:3px">8TSUN8</b><div>${lang==='en'?'A little more protection for your best friend':'給狗狗多一個回家的辦法'}</div></div><div style="padding:28px"><h1 style="font-size:24px;line-height:1.5">${t.titles[stage]}</h1><p>${t.intros[stage](name)}</p><div style="background:#f7fbfd;padding:16px;border-radius:14px">${t.order}: ${escape(order.id)}<br>${t.payment}: ${escape(order.payMethod||'Stripe')}<br>${t.tag} ${quantity} × HK$299 + ${t.decor} ${decorCount} × HK$3<br><b>${t.paid}: HK$${total.toFixed(2)}</b></div><table style="width:100%;border-collapse:collapse;margin:16px 0">${rows}</table><table role="presentation" style="width:100%;border-collapse:collapse">${pictures}</table>${profile}${shipping}<p>${closing}</p><p>Best regards,<br><b>8TSUN8</b></p><p style="padding-top:16px;border-top:1px solid #e1edf2;color:#607c88">${t.greeting}</p></div></div></body></html>`;
    const textBody=[t.titles[stage],t.order+': '+order.id,t.tag+' '+quantity+', '+t.decor+' '+decorCount+', '+t.paid+': HK$'+total.toFixed(2),url?t.profile+': '+url:t.profilePending,stage==='shipped'?t.carrier+': '+order.shippingCarrier+' '+t.tracking+': '+order.trackingNumber:'',closing,'Best regards, 8TSUN8',t.greeting].filter(Boolean).join('\\n');
    return {subject,html,text:textBody,total};
  }
  function merchantReviewLink(orderId, locale) {
    const configured = typeof process === 'undefined' ? '' : safeUrl(process.env.MERCHANT_ORDER_REVIEW_URL);
    const url = new URL(configured || 'https://www.8tsun8.com/merchant/orders');
    url.searchParams.set('order', orderId);
    const label = locale === 'en' ? 'Open tag images and NFC profile in merchant dashboard' : '在商家後台查看正反面及 NFC 檔案';
    return `<p><a href="${escape(url.href)}">${label}</a></p>`;
  }
  function renderMerchant(order,attachments=[]){
    const lang=language(order),t=copy[lang],{quantity}=totals(order),url=safeUrl(order.cloudProfile?.publicUrl);
    const shippingAddress=escape(order.shipAddress).replace(/\r?\n/g,'<br>');
    const subject=`${t.subject}${t.merchantTitle} | ${String(order.id||'').replace(/[\\r\\n]/g,'')}`;
    const html=`<!doctype html><html lang="${lang==='en'?'en':'zh-HK'}"><head><meta charset="utf-8"></head><body style="font-family:Arial,'PingFang TC','Microsoft JhengHei',sans-serif;line-height:1.7;color:#244452"><h2>${t.merchantTitle}</h2><p>${t.order}: ${escape(order.id)}<br>${t.tag}: ${quantity}<br>${t.customer}: ${escape(order.customerEmail)}<br>${t.shipName}: ${escape(order.shipName)}<br>${t.phone}: ${escape(order.shipPhone)}<br>${t.address}: ${shippingAddress}</p><p>${t.nfc}: ${url?`<a href="${escape(url)}">${escape(url)}</a>`:'-'}</p>${merchantReviewLink(order.id, lang)}<p>${t.production}</p></body></html>`;
    return {subject,html,attachments};
  }
  return {render,renderMerchant,merchantReviewLink,escape,safeUrl,language};
});
