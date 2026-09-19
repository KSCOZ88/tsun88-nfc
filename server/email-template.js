(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.TsunOrderEmail=factory();
})(typeof globalThis==='object'?globalThis:this,function(){
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeUrl=value=>{try{const u=new URL(value);return u.protocol==='https:'?u.href:'';}catch{return '';}};
  function render(order,stage='payment_received',previews=[]){
    const titles={payment_received:'付款成功，专属狗牌即将启程',order_completed:'资料已收齐，萌宠档案来啦',in_production:'你的专属狗牌正在制作中',shipped:'你的狗牌正向你飞奔而来'};
    if(!titles[stage])throw new Error('未知订单通知类型');
    const items=Array.isArray(order.items)&&order.items.length?order.items:[order];
    const quantity=items.length;
    const decorCount=items.reduce((total,item)=>total+['front','back'].reduce((sum,side)=>sum+(item.decorItems?.[side]?.length||0),0),0);
    const total=quantity*299+decorCount*3;
    const name=escape(order.petName||items[0].petName||'你家宝贝');
    const url=safeUrl(order.cloudProfile?.publicUrl);
    const intros={
      payment_received:`谢谢你为 ${name} 选择尊八八！我们已收到你的付款。请继续填写快递信息和宠物档案，资料齐全后就会开始制作。`,
      order_completed:`${name} 的订单资料已经收齐，我们会按确认的设计安排制作。萌宠档案也准备好啦，点击下方链接就能查看。`,
      in_production:`${name} 的专属狗牌正在认真制作中。每一份小小的守护，都值得我们用心完成。`,
      shipped:`${name} 的狗牌已经寄出，正向你飞奔而来！愿它陪宝贝安心探索，也多一个回家的办法。`
    };
    const designs=previews.map((p,index)=>{
      const img=String(p.src||'');
      if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(img)&&!/^cid:[\w-]+$/.test(img))return '';
      return `<td style="width:50%;padding:8px;text-align:center;vertical-align:top"><img alt="${escape(p.label||'狗牌效果图')}" src="${escape(img)}" width="220" style="max-width:100%;height:auto;border-radius:16px;background:#f7fbfd"><div style="font-size:13px;color:#607c88">${escape(p.label||('狗牌 '+(index+1)))}</div></td>`;
    });
    const pictures=designs.map((html,i)=>i%2===0?'<tr>'+html+(designs[i+1]||'<td></td>')+'</tr>':'').join('');
    const rows=items.map((item,i)=>`<tr><td style="padding:8px 0">第 ${i+1} 张 · ${escape(item.petName||order.petName||'Lucky')}</td><td style="text-align:right">${escape(item.baseLabel||order.baseLabel||'已选底板')}</td></tr>`).join('');
    const profile=url?`<div style="padding:18px;background:#f0faf4;border-radius:14px;margin:20px 0"><b>来看看咱家的萌宠档案啦</b><p style="word-break:break-all"><a href="${escape(url)}" style="color:#26735a">${escape(url)}</a></p></div>`:'<p style="color:#607c88">完成快递信息和宠物档案后，我们会再发一封邮件，把档案网址送到你的邮箱。</p>';
    const shipping=stage==='shipped'?`<p>快递公司：${escape(order.shippingCarrier)}<br>快递单号：${escape(order.trackingNumber)}</p>`:'';
    const subject=`尊八八｜${titles[stage]}｜${String(order.id||'').replace(/[\r\n]/g,'')}`;
    const closing=stage==='shipped'?'期待这份小小的礼物，早日来到你和宝贝身边。':'我们会把这份小小的守护认真做好，让它早日向你和宝贝飞奔而来。';
    const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f5fafc;font-family:'Microsoft YaHei','PingFang SC',Arial,sans-serif;color:#244452;line-height:1.8"><div style="max-width:620px;margin:24px auto;background:#fff;border:1px solid #dcecf2;border-radius:24px;overflow:hidden"><div style="padding:24px 28px;background:#e4f4fc"><b style="font-size:24px;letter-spacing:3px">8 TSUN 8</b><div>尊八八 · 给狗狗多一个回家的办法</div></div><div style="padding:28px"><h1 style="font-size:24px;line-height:1.5">${titles[stage]}</h1><p>${intros[stage]}</p><div style="background:#f7fbfd;padding:16px;border-radius:14px">订单号：${escape(order.id)}<br>付款方式：${escape(order.payMethod||'在线支付')}<br>狗牌 ${quantity} 张 × HK$299 + 装饰 ${decorCount} 枚 × HK$3<br><b>实付金额：HK$${total.toFixed(2)}</b></div><table style="width:100%;border-collapse:collapse;margin:16px 0">${rows}</table><table role="presentation" style="width:100%;border-collapse:collapse">${pictures}</table>${profile}${shipping}<p>${closing}</p><p>Best regards,<br><b>尊八八 TSUN88</b></p><p style="padding-top:16px;border-top:1px solid #e1edf2;color:#607c88">如果有任何问题，直接回复这封邮件就可以，我们会尽快为你解答。<br>订单后续进度也会通过这个邮箱通知你。</p></div></div></body></html>`;
    const text=`${titles[stage]}\n订单号：${order.id}\n狗牌 ${quantity} 张，装饰 ${decorCount} 枚，实付 HK$${total.toFixed(2)}\n${stage==='payment_received'?'请继续填写快递信息和宠物档案。':''}\n${url?'萌宠档案：'+url:'完成资料后会另发档案网址。'}\n${stage==='shipped'?'快递：'+order.shippingCarrier+' '+order.trackingNumber:''}\n${closing}\nBest regards,\n尊八八 TSUN88\n如果有问题，可以直接回复这封邮件。`;
    return {subject,html,text,total};
  }
  return {render,escape,safeUrl};
});
