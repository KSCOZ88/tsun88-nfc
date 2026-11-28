#!/usr/bin/env python3
"""Share the NFC greeting and fit the Westie artwork to the undecorated tag."""
import json
import re
from pathlib import Path

storefront = Path("index.html")
profile = Path("lucky88.html")
source = storefront.read_text(encoding="utf-8")


def replace(before, after):
    global source
    if source.count(before) != 1:
        raise SystemExit(f"Unexpected storefront anchor: {before[:110]}")
    source = source.replace(before, after, 1)


def section(start, end):
    first = source.index(start)
    return source[first:source.index(end, first)]


replace(
    section("function decorColourOptions(", "function sideDecorColour("),
    """const CHARM_COLOURS=['#f5ca24','#e886b4'];
function decorColourOptions(variant=state.baseVariant){
  return CHARM_COLOURS.filter(hex=>hex!==decorBoardPalette(variant).primary);
}
""",
)
replace(
    """    <div class="decor-color-row" role="group" aria-labelledby="charm-colour-${side}">${decorColourOptions().map(hex=>
      `<button type="button" class="decor-color-btn" data-decor-color="${hex}" aria-pressed="${colour===hex}"><i style="background:${hex}" aria-hidden="true"></i>${DECOR_BAND_LABELS[hex]}</button>`
    ).join('')}</div>""",
    """    <div class="decor-color-row" role="group" aria-labelledby="charm-colour-${side}">${CHARM_COLOURS.map(hex=>
      `<button type="button" class="decor-color-btn" data-decor-color="${hex}" aria-pressed="${colour===hex}"${decorColourOptions().includes(hex)?'':' disabled'}><i style="background:${hex}" aria-hidden="true"></i>${DECOR_BAND_LABELS[hex]}</button>`
    ).join('')}</div>""",
)
replace(
    """    const color=button.dataset.decorColor;
    if(button.getAttribute('aria-pressed')==='true')return;""",
    """    const color=button.dataset.decorColor;
    if(button.disabled||button.getAttribute('aria-pressed')==='true')return;""",
)
replace(
    ".side-charm-colours .decor-color-btn{min-height:44px}",
    """.side-charm-colours .decor-color-btn{min-height:44px}
.side-charm-colours .decor-color-btn:disabled{opacity:.45;cursor:default;box-shadow:none}""",
)

replace(
    """      const portraitScale=img.classList.contains('board-dog-westie') ? 1.16 :""",
    """      const westie=img.classList.contains('board-dog-westie');
      const fitWestie=westie&&img.dataset.frontDecor==='0';
      const portraitScale=westie ? 1.16 :""",
)
replace(
    """      img.portraitCandidate=candidate;
      const {left,top,width,height,factor}=fitPortraitAboveBand(candidate,rows,band);""",
    """      const placement=fitWestie ? fitWestieOnTag(candidate,rows,band) : candidate;
      img.portraitCandidate=placement;
      const {left,top,width,height,factor}=fitPortraitAboveBand(placement,rows,band);""",
)
replace(
    "const portraitBottomContours=new WeakMap();",
    """const westieContours=new WeakMap();
function fitWestieOnTag(candidate,rows,band){
  let shape=westieContours.get(rows);
  if(!shape){
    const upper=new Float32Array(512).fill(1),lower=new Float32Array(512);
    for(const row of rows)for(const span of row.spans){
      for(let x=Math.round(span.left*512);x<Math.round(span.right*512);x++){
        upper[x]=Math.min(upper[x],row.y-.5/512);
        lower[x]=row.y+.5/512;
      }
    }
    const first=lower.findIndex(value=>value>0);
    let last=lower.length-1;
    while(last>first&&!lower[last])last--;
    if(first<0||last<=first)return candidate;
    shape={upper,lower,first,last};
    westieContours.set(rows,shape);
  }
  const {upper,lower,first,last}=shape;
  const bodyWidth=(band.right-band.left)/(1-2*NAME_SAFE_MARGIN);
  const target=bodyWidth*.74*512/(last-first+1);
  const tryWidth=width=>{
    const height=width*candidate.height/candidate.width;
    const left=band.cx-(first+last+1)/1024*width;
    let upperLimit=0,lowerLimit=399-height;
    for(let column=first;column<=last;column++){
      if(!lower[column])continue;
      const a=Math.max(0,Math.floor(left+column/512*width));
      const b=Math.min(349,Math.ceil(left+(column+1)/512*width));
      for(let x=a;x<=b;x++){
        if(band.logoBottom[x]>=0)upperLimit=Math.max(upperLimit,band.logoBottom[x]+5-upper[column]*height);
        if(band.top[x]>=0)lowerLimit=Math.min(lowerLimit,band.top[x]-8-lower[column]*height);
      }
    }
    if(upperLimit>lowerLimit)return null;
    return {left,top:(upperLimit+lowerLimit)/2,width,height};
  };
  let fitting=tryWidth(target);
  if(fitting)return fitting;
  let low=0,high=target;
  for(let i=0;i<12;i++){
    const width=(low+high)/2,attempt=tryWidth(width);
    if(attempt){low=width;fitting=attempt;}else{high=width;}
  }
  return fitting||candidate;
}

const portraitBottomContours=new WeakMap();""",
)
replace(
    """  const result={top,end,left:left+margin,right:right-margin,cx:(left+right)/2,cy:(top[175]+end[175])/2,visualCy:weightedY/area};""",
    """  const logoBottom=new Int16Array(W).fill(-1),body=at(175,187);
  for(let x=35;x<315;x++){
    for(let y=133;y>=52;y--){
      const i=at(x,y);
      if(data[i+3]>160&&Math.abs(data[i]-data[body])+Math.abs(data[i+1]-data[body+1])+Math.abs(data[i+2]-data[body+2])>45){
        for(let column=x-2;column<=x+2;column++)logoBottom[column]=Math.max(logoBottom[column],y);
        break;
      }
    }
  }
  const result={top,end,logoBottom,left:left+margin,right:right-margin,cx:(left+right)/2,cy:(top[175]+end[175])/2,visualCy:weightedY/area};""",
)
replace(
    """    await nfcPhotoTask;
    if(!validateNfcProfile())return;
    if(!confirmed||!hasConfirmedNfcPreview()){requestNfcPreview();return;}""",
    """    if(!confirmed){
      // Next is disabled while a photo loads. Open the greeting in the tap handler.
      if(validateNfcProfile())requestNfcPreview();
      return;
    }
    await nfcPhotoTask;
    if(!validateNfcProfile())return;
    if(!hasConfirmedNfcPreview()){requestNfcPreview();return;}""",
)
replace(
    """function mount({root,avatar,petName='',dialog=null,photoUrl=''}){""",
    """function mount({root,avatar,petName='',dialog=null,photoUrl='',language=''}){""",
)
replace(
    """    const pet=String(petName||'').trim()||'狗狗',phrase='I love you';""",
    """    const pet=String(petName||'').trim()||'狗狗',phrase='I love you';
    const en=language==='en',hant=language==='zh-Hant';
    const copy=(english,traditional,simplified=traditional)=>en?english:hant?traditional:simplified;
    const listen=copy('Tap to hear ♡','點我聽一句 ♡','点我听一句 ♡');
    const replay=copy('Listen again ♡','再聽一句 ♡','再听一句 ♡');
    const pause=copy('Pause greeting','暫停問候','暂停问候');""",
)
replace(
    """      box.dataset.playing=String(next==='playing');button.textContent=active?'暂停问候':next==='blocked'?'点我听一句 ♡':'再听一句 ♡';
      button.setAttribute('aria-pressed',String(active));avatar.setAttribute('aria-label',(active?'暂停':'播放')+pet+'的问候');status.textContent=message;
      if(overlay)overlay.querySelector('.tsun-intro-action').textContent=active?'暂停问候':'点我听一句 ♡';""",
    """      box.dataset.playing=String(next==='playing');button.textContent=active?pause:next==='blocked'?listen:replay;
      button.setAttribute('aria-pressed',String(active));
      avatar.setAttribute('aria-label',copy((active?'Pause ':'Play ')+pet+"'s greeting",(active?'暫停':'播放')+pet+'的問候',(active?'暂停':'播放')+pet+'的问候'));
      status.textContent=message;
      if(overlay)overlay.querySelector('.tsun-intro-action').textContent=active?pause:listen;""",
)
replace(
    """      overlay.querySelector('strong').textContent=lyric.textContent;""",
    """      overlay.querySelector('strong').textContent=lyric.textContent;
      overlay.querySelector('.tsun-intro-skip').textContent=copy('View profile ↘','查看檔案 ↘','查看档案 ↘');""",
)
replace("""ui('done','送给最喜欢的你 ♡');""", """ui('done',copy('For my favourite person ♡','送給最喜歡的你 ♡','送给最喜欢的你 ♡'));""")
replace("""ui('ready','轻点头像，再听一次');""", """ui('ready',copy('Tap the portrait to listen again','輕點頭像，再聽一次','轻点头像，再听一次'));""")
replace("""ui('blocked','轻点头像，听我说给你听');""", """ui('blocked');""")
replace(
    """    current=api;play();return api;""",
    """    current=api;
    caption(phrase);ui('blocked');
    play();
    return api;""",
)

# Reuse the storefront greeting but omit the unused name recordings and image
# inference code from the lightweight public profile document.
parts = ["tsun-pet-greeting-styles", "tsun-pet-voice-assets"]
shared = [re.search(fr'<(?:style|script) id="{name}"[\s\S]*?</(?:style|script)>', source).group() for name in parts]
plain = json.loads(shared[1].split(">", 1)[1].removesuffix("</script>"))["plain"]
shared[1] = '<script id="tsun-pet-voice-assets" type="application/json">' + json.dumps({"plain": plain}) + "</script>"
greeting = section("/* A shared, name-free greeting;", "</script>")
shared.append('<script id="tsun-public-greeting-controller">\n' + greeting + "</script>")

public = profile.read_text(encoding="utf-8")
public = public.replace("</head>", "\n".join(shared) + "\n</head>", 1)
before = """  delete document.documentElement.dataset.loadingProfile;
}
async function loadLockedProfile()"""
after = """  delete document.documentElement.dataset.loadingProfile;
  mountProfileGreeting(name,language);
}
function mountProfileGreeting(name,language){
  const root=document.querySelector('.hero');
  window.TsunPetGreeting.mount({root,avatar:root.querySelector('.avatar'),petName:name,language});
}
async function loadLockedProfile()"""
if public.count(before) != 1:
    raise SystemExit("Unexpected public profile greeting anchor")
public = public.replace(before, after, 1)
public = public.replace(
    """    if (namedProfile) showStatus(profileCopy['zh-Hant'].missing);
    return;""",
    """    if (namedProfile) showStatus(profileCopy['zh-Hant'].missing);
    else if(location.pathname!=='/merchant-profile')mountProfileGreeting('Lucky','zh-Hant');
    return;""",
    1,
)
storefront.write_text(source, encoding="utf-8")
profile.write_text(public, encoding="utf-8")
