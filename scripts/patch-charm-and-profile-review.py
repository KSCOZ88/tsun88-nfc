#!/usr/bin/env python3
"""Use one charm colour per side and confirm profiles in the checkout flow."""
import re
from pathlib import Path

page = Path("index.html")
source = page.read_text(encoding="utf-8")


def replace(before, after):
    global source
    if source.count(before) != 1:
        raise SystemExit(f"Unexpected charm or review anchor: {before[:115]}")
    source = source.replace(before, after, 1)


def replace_section(start, end, updated):
    first = source.index(start)
    replace(source[first:source.index(end, first)], updated)


replace(
    """      const westie=img.classList.contains('board-dog-westie');
      if(westie){
        candidate.left-=candidate.width*.025;
        candidate.top-=candidate.height*.025;
        candidate.width*=1.05;
        candidate.height*=1.05;
      }""",
    """      const portraitScale=img.classList.contains('board-dog-westie') ? 1.16 :
        img.classList.contains('board-dog-beagle') ? .88 : 1;
      if(portraitScale!==1){
        candidate.left-=candidate.width*(portraitScale-1)/2;
        candidate.top-=candidate.height*(portraitScale-1)/2;
        candidate.width*=portraitScale;
        candidate.height*=portraitScale;
      }""",
)
replace('if(factor===1&&!westie)return;', 'if(factor===1&&portraitScale===1)return;')

replace_section(
    'function validDecorColour(', 'function decorPrintColours(',
    """function validDecorColour(color){
  return color==='band'||Object.hasOwn(DECOR_COLORS,color)||Object.hasOwn(DECOR_BAND_LABELS,color);
}
function decorColourTone(color,variant=state.baseVariant){
  if(Object.hasOwn(DECOR_BAND_LABELS,color))return {label:DECOR_BAND_LABELS[color],hex:color};
  const colours=decorColourPalette(variant);
  return colours[color]||colours.yellow;
}
function decorColourOptions(variant=state.baseVariant){
  const {primary,accent}=decorBoardPalette(variant);
  const colours=['#f5ca24','#e886b4','#e83328','#f39820','#16ae67','#26a7e1','#dcdddd','#ffffff'];
  return colours.filter(hex=>hex!==primary&&hex!==accent);
}
function sideDecorColour(side){
  const options=decorColourOptions(),chosen=state.decorSideColours[side];
  if(options.includes(chosen))return chosen;
  const colours=new Set(state.decorItems[side].map(item=>decorColourTone(item.color).hex));
  if(!colours.size)return options[0];
  return colours.size===1?options.find(hex=>colours.has(hex)):'';
}
function applySideDecorColour(side,color){
  state.decorSideColours[side]=color;
  for(const item of state.decorItems[side])item.color=color;
}
""",
)
replace_section('function canSetDecorColour(', 'function decorColourLimitMessage(', '')
replace_section(
    'function chooseBaseVariant(', 'function validateDecorColourLimit(',
    """function chooseBaseVariant(variant){
  if(!baseVariants[variant])return false;
  const options=decorColourOptions(variant),replacements=[];
  for(const side of ['front','back']){
    const chosen=state.decorSideColours[side];
    if(chosen){
      if(!options.includes(chosen))replacements.push(side);
    }else if(decorPrintColours(state.decorItems[side],variant).size>4){
      toast('换成这款底板后，'+decorColourLimitMessage(side),7000);return false;
    }
  }
  state.baseVariant=variant;
  for(const side of replacements)applySideDecorColour(side,options[0]);
  renderAll();return true;
}
""",
)
replace(
    """  if(existing){existing.key=key;existing.color=existing.color||'yellow';existing.x=pos.x;existing.y=pos.y;existing.slot=pos.slot;state.selectedDecorId=existing.id;}
  else{const item={id:'d'+(decorSeq++),key,color:defaultDecorColour(side),side,slot:pos.slot,x:pos.x,y:pos.y};state.decorItems[side].push(item);state.selectedDecorId=item.id;}""",
    """  const color=sideDecorColour(side)||decorColourOptions()[0];
  if(existing){existing.key=key;state.selectedDecorId=existing.id;}
  else{
    const item={id:'d'+(decorSeq++),key,color,side,slot:pos.slot,x:pos.x,y:pos.y};
    state.decorItems[side].push(item);state.selectedDecorId=item.id;
  }
  applySideDecorColour(side,color);""",
)
replace_section('function setDecorColor(', 'const orderEmailPreviews=', '')
replace(
    "nfcProfile:{...EMPTY_NFC_PROFILE},decorItems:{front:[],back:[]}",
    "nfcProfile:{...EMPTY_NFC_PROFILE},decorSideColours:{front:'',back:''},decorItems:{front:[],back:[]}",
)
replace(
    "selectedBreedColor:state.selectedBreedColor||'',decorItems:cloneDecorItems(state.decorItems)",
    "selectedBreedColor:state.selectedBreedColor||'',decorSideColours:{...state.decorSideColours},decorItems:cloneDecorItems(state.decorItems)",
)
replace(
    'state.decorItems=cloneDecorItems(design.decorItems);state.selectedDecorId=null;',
    "state.decorItems=cloneDecorItems(design.decorItems);state.decorSideColours={front:'',back:'',...design.decorSideColours};state.selectedDecorId=null;",
)
replace(
    "state.decorItems={front:[],back:[]};state.selectedDecorId=null;state.activeAccessoryKey='star';",
    "state.decorItems={front:[],back:[]};state.decorSideColours={front:'',back:''};state.selectedDecorId=null;state.activeAccessoryKey='star';",
)

replace_section(
    'function decorColorChoices(', 'function renderFrontSlotPage(',
    """function decorColorChoices(side,colour){
  return `<div class="side-charm-colours"><b id="charm-colour-${side}">本面配饰颜色</b>
    <div class="decor-color-row" role="group" aria-labelledby="charm-colour-${side}">${decorColourOptions().map(hex=>
      `<button type="button" class="decor-color-btn" data-decor-color="${hex}" aria-pressed="${colour===hex}"><i style="background:${hex}" aria-hidden="true"></i>${DECOR_BAND_LABELS[hex]}</button>`
    ).join('')}</div>
  </div>`;
}
function charmSlotChoices(pos,item,side,colour){
  return `<div class="charm-slot-choices" role="group" aria-labelledby="charm-place-${side}-${pos.slot}">${accessories.map(({key,label})=>{
    const selected=item?.key===key;
    return `<button type="button" class="charm-choice" data-charm-slot="${pos.slot}" data-charm-key="${key}" aria-label="${escapeHtml(label)}" aria-pressed="${selected}">${decorAssetIcon(key,selected?item.color:colour)}</button>`;
  }).join('')}</div>`;
}
""",
)
replace(
    "function renderFrontSlotPage(host,side='front'){\n",
    "function renderFrontSlotPage(host,side='front'){\n  const colour=sideDecorColour(side);\n",
)
replace("""<span>本面总配色最多 4 种。</span><b>统一 ${money(DECOR_UNIT_PRICE)} / 个</b></div>${side==='back'?'<fieldset id="backAccessoriesFields" aria-label="背面配饰位置选择" disabled>':''}<div class="front-slot-grid">""",
        """<span>再点一次已选图案即可取消。</span><b>统一 ${money(DECOR_UNIT_PRICE)} / 个</b></div>${side==='back'?'<fieldset id="backAccessoriesFields" aria-label="背面配饰位置选择" disabled>':''}${decorColorChoices(side,colour)}<div class="front-slot-grid">""")
replace('${charmSlotChoices(pos,item,side)}${decorColorChoices(item,pos,side)}', '${charmSlotChoices(pos,item,side,colour||decorColourOptions()[0])}')
replace(
    """    if(button.getAttribute('aria-pressed')==='true')return;
    const {charmSlot,charmKey}=button.dataset;
    const restoreFocus=document.activeElement===button;
    if(charmKey)window.tsunAccessorySound?.play();
    setFrontSlot(Number(charmSlot),charmKey,side);""",
    """    const selected=button.getAttribute('aria-pressed')==='true';
    const {charmSlot,charmKey}=button.dataset;
    const restoreFocus=document.activeElement===button;
    if(!selected)window.tsunAccessorySound?.play();
    setFrontSlot(Number(charmSlot),selected?'':charmKey,side);""",
)
replace(
    """  host.querySelectorAll('[data-decor-color]').forEach(btn=>btn.addEventListener('click',()=>{if(btn.getAttribute('aria-disabled')!=='true')window.tsunAccessorySound?.play();setDecorColor(Number(btn.dataset.colorSlot),btn.dataset.decorColor,btn.dataset.colorSide);}));""",
    """  host.querySelectorAll('[data-decor-color]').forEach(button=>button.addEventListener('click',()=>{
    const color=button.dataset.decorColor;
    if(button.getAttribute('aria-pressed')==='true')return;
    const restoreFocus=document.activeElement===button;
    applySideDecorColour(side,color);
    renderAll();
    if(restoreFocus)host.querySelector(`[data-decor-color="${color}"]`)?.focus({preventScroll:true});
  }));""",
)
replace(
    'const key=JSON.stringify([side,state.baseVariant,state.decorItems[side]]);',
    'const key=JSON.stringify([side,state.baseVariant,state.decorSideColours[side],state.decorItems[side]]);',
)
for anchor, label, hint in (
    ('"背面配饰位置选择":"Back charm positions"', 'Charm colour for this side', 'Tap a selected charm again to remove it.'),
    ('"背面配饰位置选择":"背面配飾位置選擇"', '本面配飾顏色', '再點一次已選圖案即可取消。'),
):
    replace(anchor, f'{anchor},"本面配饰颜色":"{label}","再点一次已选图案即可取消。":"{hint}"')

replace(
    'id="nfcContinueBtn">下一步：付款</button>',
    'id="nfcContinueBtn" translate="no">下一步</button>',
)
preview_action = re.search(r'<div id="nfcPreviewAction"[^\n]*?</div>(?=</aside>)', source).group()
replace(preview_action, "")
replace(' <div id="nfcPreviewBottomSlot"></div>\n', '')
replace_section('<script id="tsun-profile-preview-location-R78">', '<script id="tsun-localized-file-inputs-R80">', '')
replace(
    '<div id="orderDocumentContent" role="region" aria-label="宠物档案"></div></dialog>',
    """<div id="orderDocumentContent" role="region" aria-label="宠物档案"></div>
  <footer id="nfcReviewActions" hidden>
    <button type="button" class="secondary" id="nfcReviewEdit" translate="no">返回修改</button>
    <button type="button" class="primary" id="nfcReviewConfirm" translate="no">确认档案</button>
  </footer>
</dialog>""",
)
replace_section(
    'function hasViewedNfcPreview(', 'function nfcDraftOrder(',
    """function hasConfirmedNfcPreview(design=state){return nfcPreviewReviewed.has(nfcPreviewSignature(design));}
let activeNfcReview=null;
function syncNfcReviewLabels(){
  const en=TsunI18n.locale==='en';
  document.getElementById('nfcContinueBtn').textContent=en?'Next':'下一步';
  const edit=document.getElementById('nfcReviewEdit'),confirm=document.getElementById('nfcReviewConfirm');
  if(edit)edit.textContent=en?'Back to edit':'返回修改';
  if(confirm)confirm.textContent=en?'Confirm & continue':'確認並繼續';
}
function requestNfcPreview(){
  const dialog=document.getElementById('orderDocumentDialog');
  activeNfcReview=nfcPreviewSignature();
  document.getElementById('nfcReviewActions').hidden=false;
  dialog.dataset.nfcReview='true';
  openChineseProfile(nfcDraftOrder());
  document.getElementById('orderDocumentContent').scrollTop=0;
  document.getElementById('nfcReviewEdit').focus({preventScroll:true});
}
function resetNfcReview(){
  activeNfcReview=null;
  const dialog=document.getElementById('orderDocumentDialog');
  delete dialog.dataset.nfcReview;
  document.getElementById('nfcReviewActions').hidden=true;
}
function closeNfcReview(){
  const dialog=document.getElementById('orderDocumentDialog');
  resetNfcReview();
  if(dialog.open)dialog.close();
}

""",
)
replace('renderNfcSelectedPortrait();syncNfcPreviewGate();', 'renderNfcSelectedPortrait();')
replace(
    """  document.getElementById('nfcContinueBtn').textContent=nfcEditingPaidOrder?'保存并返回配送资料':'下一步：付款';""",
    """  syncNfcReviewLabels();""",
)
replace(
    """async function finishNfcDraft(){
  const button=document.getElementById('nfcContinueBtn');button.disabled=true;""",
    """async function finishNfcDraft(confirmed=false){
  const button=document.getElementById('nfcContinueBtn');
  const confirm=document.getElementById('nfcReviewConfirm');
  if(button.disabled)return;
  button.disabled=true;confirm.disabled=true;""",
)
replace(
    """    if(!hasViewedNfcPreview()){requestNfcPreview();return;}
    if(nfcEditingPaidOrder&&currentOrder){""",
    """    if(!confirmed||!hasConfirmedNfcPreview()){requestNfcPreview();return;}
    if(nfcEditingPaidOrder&&currentOrder){
      closeNfcReview();""",
)
replace(
    "if(missing>=0){currentCartIndex=missing;applyTagDesign(cartDesigns[missing]);hydrateNfcInputs();validateNfcProfile();return;}",
    "if(missing>=0){closeNfcReview();currentCartIndex=missing;applyTagDesign(cartDesigns[missing]);hydrateNfcInputs();validateNfcProfile();return;}",
)
replace('cartDesigns.findIndex(item=>!hasViewedNfcPreview(item))', 'cartDesigns.findIndex(item=>!hasConfirmedNfcPreview(item))')
replace(
    """    if(unreviewed>=0){currentCartIndex=unreviewed;applyTagDesign(cartDesigns[unreviewed]);hydrateNfcInputs();requestNfcPreview();return;}
    if(!validateOrderPhoneConfirmations(cartDesigns))return;""",
    """    if(unreviewed>=0){currentCartIndex=unreviewed;applyTagDesign(cartDesigns[unreviewed]);hydrateNfcInputs();requestNfcPreview();return;}
    closeNfcReview();
    if(!validateOrderPhoneConfirmations(cartDesigns))return;""",
)
replace('finally{button.disabled=false;syncNfcPreviewGate();}', 'finally{button.disabled=false;confirm.disabled=false;}')
replace(
    """  document.getElementById('nfcContinueBtn').addEventListener('click',finishNfcDraft);""",
    """  document.getElementById('nfcContinueBtn').addEventListener('click',()=>finishNfcDraft());""",
)
replace(
    'function bindNfcDraftFlow(){',
    """function bindNfcReviewDialog(){
  const next=document.getElementById('nfcContinueBtn'),dialog=document.getElementById('orderDocumentDialog');
  syncNfcReviewLabels();
  document.getElementById('nfcReviewEdit').addEventListener('click',()=>{
    closeNfcReview();next.focus({preventScroll:true});
  });
  document.getElementById('nfcReviewConfirm').addEventListener('click',()=>{
    if(!dialog.open||activeNfcReview===null||next.disabled)return;
    if(activeNfcReview!==nfcPreviewSignature()){requestNfcPreview();return;}
    nfcPreviewReviewed.add(activeNfcReview);
    finishNfcDraft(true);
  });
  dialog.addEventListener('close',()=>{
    if(dialog.open||activeNfcReview===null)return;
    resetNfcReview();next.focus({preventScroll:true});
  });
}
function bindNfcDraftFlow(){""",
)
replace(
    '<script id="tsun88-home-first-startup">',
    '<script>bindNfcReviewDialog();</script>\n<script id="tsun88-home-first-startup">',
)
replace_section(
    """  document.querySelectorAll('[data-nfc-draft-preview]').forEach""",
    """  document.getElementById('postPaymentNfcForm').addEventListener('input'""",
    "",
)
replace(
    "window.addEventListener('tsun-language-change',()=>{renderNfcDraftCard();});",
    "window.addEventListener('tsun-language-change',()=>{syncNfcReviewLabels();renderNfcDraftCard();});",
)
replace('<style id="tsun-customization-flow">', """<style id="tsun-charm-and-profile-review">
.side-charm-colours{display:flex;flex-direction:column;gap:8px;color:#31586c;margin-bottom:12px}
.side-charm-colours .decor-color-row{margin:0}
.side-charm-colours .decor-color-btn{min-height:44px}
.side-charm-colours .decor-color-btn[aria-pressed="true"]{border-color:#85c8e6;background:#e7f5fc;color:#24485a;box-shadow:inset 0 0 0 1px #85c8e6}
.side-charm-colours .decor-color-btn i{border:1px solid #526d7e55}
#orderDocumentDialog[open][data-nfc-review]{display:flex;flex-direction:column}
#orderDocumentDialog[data-nfc-review] .document-toolbar{flex:0 0 auto}
#orderDocumentDialog[data-nfc-review] #orderDocumentContent{flex:1;min-height:0;height:auto}
#nfcReviewActions{display:flex;justify-content:space-between;position:relative;z-index:2;gap:10px;padding:12px 18px calc(12px + env(safe-area-inset-bottom));border-top:1px solid #dceaf1;background:#fff}
#nfcReviewActions[hidden]{display:none}
#nfcReviewActions button{min-height:44px}
@media(max-width:480px){
 #nfcReviewActions{padding-inline:10px}
 #nfcReviewActions button{padding-inline:10px;flex:1}
}
</style>
<style id="tsun-customization-flow">""")
source = re.sub(r'^\.charm-empty-icon[^\n]*\n', '', source, flags=re.MULTILINE)
replace('.charm-slot-choices{grid-template-columns:repeat(4,minmax(0,1fr))}', '.charm-slot-choices{grid-template-columns:repeat(3,minmax(0,1fr))}')

page.write_text(source, encoding="utf-8")
