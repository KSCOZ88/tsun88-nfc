#!/usr/bin/env python3
"""Update storefront colour tabs, charm choices, and the NFC and delivery forms."""
import re
from pathlib import Path

page = Path("index.html")
source = page.read_text(encoding="utf-8")


def replace(before, after):
    global source
    if source.count(before) != 1:
        raise SystemExit(f"Unexpected customization anchor: {before[:120]}")
    source = source.replace(before, after, 1)


def section(start, end):
    first = source.index(start)
    return source[first:source.index(end, first)]


replace(
    "  const seriesOrder=['松苔绿系列','雾岩灰系列','元气橘系列','蜜桃粉系列','莓果红系列','奶霜白系列','蜜糖黄系列'];",
    """  const seriesColours=Object.fromEntries(['green1','red1','white1','grey1','orange1','pink1','yellow1']
    .map(key=>[baseVariants[key].series,TsunProfileTheme.paletteFor(key).primary]));
  const seriesOrder=Object.keys(seriesColours);""",
)
replace(
    '${series.replace(\'系列\',\'\')}</button>',
    '<i class="base-colour-dot" style="--base-colour:${seriesColours[series]}" aria-hidden="true"></i><span>${series.replace(\'系列\',\'\')}</span></button>',
)

old_charms = section("// The sample strip previews an accessory;", "const decorRenderKeys")
old_renderer = old_charms[old_charms.index("function renderFrontSlotPage"):]
status = old_renderer[old_renderer.index("  const frontDecorCount"):old_renderer.index("  host.innerHTML")]
front_note = old_renderer[old_renderer.index("${pageTitle}"):old_renderer.index("${frontDecorStatus}")]
i = old_renderer.index("  host.querySelectorAll('[data-decor-color]')")
colour_events = old_renderer[i:]
replace(
    old_charms,
    """function charmSlotChoices(pos,item,side){
  const empty='<span class="charm-empty-icon" aria-hidden="true"></span>';
  const choices=[['','留空（不放配饰）',empty],...accessories.map(({key,label})=>[
    key,label,decorAssetIcon(key,key===item?.key?(item.color||'yellow'):'yellow')
  ])];
  return `<div class="charm-slot-choices" role="group" aria-labelledby="charm-place-${side}-${pos.slot}">${choices.map(([key,label,icon])=>
    `<button type="button" class="charm-choice" data-charm-slot="${pos.slot}" data-charm-key="${key}" aria-label="${escapeHtml(label)}" aria-pressed="${(item?.key||'')===key}">${icon}</button>`
  ).join('')}</div>`;
}
function renderFrontSlotPage(host,side='front'){
  const pageTitle=side==='front'?'<h3 class="front-slot-page-title">正面配饰</h3>':'';
  const noteTitle='六个小位置，装下它的六份可爱';
  const noteText='六个小位置分别住进六款小装饰，按顺序给每个位置挑一款，想留白也可以，让可爱刚刚好。';
"""
    + status
    + """  host.innerHTML=`<div class="front-slot-shell">"""
    + front_note
    + """${frontDecorStatus}<div class="front-slot-price-note"><span>本面总配色最多 4 种。</span><b>统一 ${money(DECOR_UNIT_PRICE)} / 个</b></div>${side==='back'?'<fieldset id="backAccessoriesFields" aria-label="背面配饰位置选择" disabled>':''}<div class="front-slot-grid">${slotsForSide(side).map(pos=>{
    const item=frontItemBySlot(pos.slot,side);
    return `<div class="front-slot-card ${item?'filled':''}">
      <div class="front-slot-head"><span class="front-slot-number">${pos.slot}</span><span class="front-slot-place" id="charm-place-${side}-${pos.slot}">${pos.label}</span></div>
      ${charmSlotChoices(pos,item,side)}${decorColorChoices(item,pos,side)}
    </div>`;
  }).join('')}</div>${side==='back'?'</fieldset>':''}</div>`;
  host.querySelectorAll('[data-charm-slot]').forEach(button=>button.addEventListener('click',()=>{
    if(button.getAttribute('aria-pressed')==='true')return;
    const {charmSlot,charmKey}=button.dataset;
    const restoreFocus=document.activeElement===button;
    if(charmKey)window.tsunAccessorySound?.play();
    setFrontSlot(Number(charmSlot),charmKey,side);
    if(restoreFocus)host.querySelector(`[data-charm-slot="${charmSlot}"][data-charm-key="${charmKey}"]`)?.focus({preventScroll:true});
  }));
"""
    + colour_events,
)

phone_box = section('<section class="phone-confirmation-box"', '          <fieldset class="contact-font-picker">')
check = phone_box[phone_box.index(' <label class="phone-confirm-check"'):phone_box.index('</section>')]
replace(phone_box, '            <div class="inline-phone-confirm">\n' + check.replace('phonePrintWarning ', '') + '            </div>\n')
sync_summary = section("  const info=currentOwnerPhoneStatus();\n  const number=", "}\nfunction validatePhoneConfirmation")
replace(sync_summary, "")

message = re.search(r'<div class="field wide"><label for="nfcOwnerMessage">[^\n]+</div>', source).group()
replace("        " + message + "\n", "")
replace('<div class="nfc-fields">        <div class="field wide"><div class="nfc-photo-heading">', '<div class="nfc-fields">\n        ' + message + '\n        <div class="field wide"><div class="nfc-photo-heading">')
replace("location:'',ownerMessage:'',diet:", "location:'',ownerMessage:'If you find my dog，Please contact me！',diet:")
for old, new in (
    ('备用联系人（必填）', '备用联系人（选填）'),
    ('备用联系电话（必填）', '备用联系电话（选填）'),
    ('Backup contact (required)', 'Backup contact (optional)'),
    ('Backup phone number (required)', 'Backup phone number (optional)'),
    ('備用聯繫人（必填）', '備用聯繫人（選填）'),
    ('備用聯繫電話（必填）', '備用聯繫電話（選填）'),
):
    if old not in source:
        raise SystemExit(f"Missing backup contact label: {old}")
    source = source.replace(old, new)
replace(
    "function nfcProfileMissing(profile){return [['nfcBreed','宠物品种',profile?.breed],['nfcBackupOwnerName','备用联系人',profile?.backupOwnerName],['nfcBackupPhone','备用联系电话',profile?.backupPhone]].filter(([, ,v])=>!String(v||'').trim());}",
    "function nfcProfileMissing(profile){return String(profile?.breed||'').trim()?[]:[['nfcBreed','宠物品种']];}",
)
replace(
    """,
    {name:'备用联系人',value:state.nfcProfile.backupOwnerName,el:document.getElementById('nfcBackupOwnerName')},
    {name:'备用联系电话',value:state.nfcProfile.backupPhone,el:document.getElementById('nfcBackupPhone')}""",
    "",
)
replace(section("  const addressIssue=shippingAddressIssue(state.shipAddress);", "  const button=document.getElementById('submitPostPaymentNfc');"), "")
address_hint = re.search(r'(?<=id="shippingAddressHint">)[^<]+', source).group()
new_hint = "请填写快递员能找到的地址，可按平时的写法输入。"
for anchor, translation in (
    ('"详细地址（必填）":"Full address (required)"', 'Enter the address as you normally write it so the courier can find it.'),
    ('"详细地址（必填）":"詳細地址（必填）"', '請填寫快遞員能找到的地址，可按平時的寫法輸入。'),
):
    replace(anchor, f'{anchor},"{new_hint}":"{translation}"')
# Keep the shared merchant builder's address guidance available in its own flow.
replace(
    'id="shippingAddressHint">' + address_hint,
    'id="shippingAddressHint">' + new_hint,
)
replace(
    "  const smartAddress=document.getElementById('smartAddress');",
    """  if(MERCHANT_ORDER_MODE)document.getElementById('shippingAddressHint').textContent=ADDRESS_HINT;
  const smartAddress=document.getElementById('smartAddress');""".replace("ADDRESS_HINT", repr(address_hint)),
)
replace('<div id="nfcDraftCard"><div class="nfc-draft-photo">', '<div id="nfcDraftCard"><div class="nfc-draft-portrait-area"><div class="nfc-draft-photo">')
replace('id="nfcDraftSelectedAvatar" alt=""></span></div><h3', 'id="nfcDraftSelectedAvatar" alt=""></span></div></div><h3')
replace(
    """      img.portraitCandidate=candidate;
      const {left,top,width,height,factor}=fitPortraitAboveBand(candidate,rows,band);
      // Leave the approved CSS pose in place when its silhouette already fits.
      if(factor===1)return;""",
    """      const westie=img.classList.contains('board-dog-westie');
      if(westie){
        candidate.left-=candidate.width*.025;
        candidate.top-=candidate.height*.025;
        candidate.width*=1.05;
        candidate.height*=1.05;
      }
      img.portraitCandidate=candidate;
      const {left,top,width,height,factor}=fitPortraitAboveBand(candidate,rows,band);
      // Leave the approved CSS pose in place when its silhouette already fits.
      if(factor===1&&!westie)return;""",
)

replace(
    '<style id="tsun-localized-uploads-R80">',
    """<style id="tsun-customization-flow">
.base-color-tab{display:inline-flex;align-items:center;justify-content:center;gap:6px}
.base-colour-dot{flex:none;width:11px;height:11px;border-radius:50%;border:1px solid #526d7e66;background:var(--base-colour)}
.front-slot-shell .front-slot-grid{grid-template-columns:repeat(auto-fit,minmax(min(100%,174px),1fr))}
#backAccessoriesFields{min-inline-size:0}
.charm-slot-choices{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}
.front-slot-card .charm-choice{display:grid;place-items:center;min-width:0;min-height:44px;padding:4px;border:1px solid #d6e4ea;border-radius:10px;background:#fff;color:#637e8b}
.front-slot-card .charm-choice[aria-pressed="true"]{border-color:#397b95;box-shadow:inset 0 0 0 1px #397b95;background:#e6f4fa;color:#24485a}
.charm-choice:focus-visible{outline:2px solid #397b95;outline-offset:2px}
.charm-choice .decor-icon{width:30px;height:30px;padding:2px;border:0;background:transparent}
.charm-empty-icon{display:grid;place-items:center;width:21px;height:21px;border:1.5px solid currentColor;border-radius:50%}
.charm-empty-icon::after{content:"";width:13px;border-top:1.5px solid currentColor;transform:rotate(-45deg)}
.inline-phone-confirm .phone-confirm-check{margin-top:4px}
#nfcDraftCard{background:var(--pet-accent);padding:0 0 22px}
#nfcDraftCard .nfc-draft-portrait-area{background:var(--pet-primary);padding:25px 16px 16px}
#nfcDraftCard .nfc-draft-photo{margin:0 auto;border-color:var(--pet-primary);background:var(--pet-primary)}
#nfcDraftCard #nfcDraftFallback{background:transparent}
#nfcDraftCard h3,#nfcDraftCard p{margin-inline:16px}
#nfcDraftCard p:empty{display:none}
@media(max-width:760px){
 #customize .mobile-builder-nav .base-color-tab{gap:3px}
 .base-colour-dot{width:8px;height:8px}
 .front-slot-shell .front-slot-grid{grid-template-columns:minmax(0,1fr)}
 .charm-slot-choices{grid-template-columns:repeat(4,minmax(0,1fr))}
 #nfcDraftCard .nfc-draft-portrait-area{padding-block:20px 14px}
}
</style>
<style id="tsun-localized-uploads-R80">""",
)
page.write_text(source, encoding="utf-8")
