/* TSUN88 policy pages share the storefront's language preference. */
(()=>{
 'use strict';
 const params=new URLSearchParams(location.search);
 let saved='en';
 try{saved=localStorage.getItem('tsun88.locale')||'en';}catch(_){}
 const requested=params.get('lang');
 let locale=(requested?requested.startsWith('zh'):saved==='zh-Hant')?'zh-Hant':'en';
 function setLanguage(next,remember){
  locale=next==='zh-Hant'?'zh-Hant':'en';
  const chinese=locale==='zh-Hant';
  document.documentElement.lang=locale;
  for(const panel of document.querySelectorAll('[data-policy-language]'))panel.hidden=panel.dataset.policyLanguage!==locale;
  for(const button of document.querySelectorAll('[data-set-language]'))button.setAttribute('aria-pressed',String(button.dataset.setLanguage===locale));
  const current=document.querySelector('[data-policy-language="'+locale+'"]');
  document.title=current.dataset.title+' | TSUN88';
  document.querySelector('meta[name="description"]').content=current.dataset.description;
  document.querySelector('.ts-policy-home').textContent=chinese?'返回網站 →':'Back to the shop →';
  const skip=document.querySelector('.ts-policy-skip');skip.textContent=chinese?'跳至正文':'Skip to content';skip.href='#content-'+locale;
  document.querySelector('.ts-policy-language').setAttribute('aria-label',chinese?'網站語言':'Website language');
  for(const link of document.querySelectorAll('a[data-policy-link]')){
   const url=new URL(link.getAttribute('href'),location.href);
   url.searchParams.set('lang',locale);
   link.setAttribute('href',url.pathname.split('/').pop()+url.search+url.hash);
  }
  const status=document.querySelector('.ts-policy-announcement');
  if(remember){
   try{localStorage.setItem('tsun88.locale',locale);}catch(_){}
   const url=new URL(location.href);url.searchParams.set('lang',locale);
   try{history.replaceState(null,'',url.href);}catch(_){}
   status.textContent=chinese?'已切換至繁體中文。':'Language changed to English.';
  }
 }
 document.querySelectorAll('[data-set-language]').forEach(button=>button.addEventListener('click',()=>setLanguage(button.dataset.setLanguage,true)));
 setLanguage(locale,false);
})();
