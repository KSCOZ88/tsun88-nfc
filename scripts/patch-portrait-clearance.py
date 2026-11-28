#!/usr/bin/env python3
"""Apply the existing name-band clearance to both storefront layouts."""
from pathlib import Path

page = Path("index.html")
source = page.read_text(encoding="utf-8")
start = source.index("const portraitMobileMedia=matchMedia(")
end = source.index("// One measured-name layout", start)
section = source[start:end]


def replace(old, new):
    global section
    if section.count(old) != 1:
        raise SystemExit("Portrait clearance anchor changed")
    section = section.replace(old, new, 1)


if "if(factor===1)return;" not in section:
    replace("if(!target.isConnected||!portraitMobileMedia.matches)", "if(!target.isConnected)")
    replace(
        """  if(!portraitMobileMedia.matches){
    portraitClearanceObserver.unobserve(board);
    clearMobilePortraitFit(img);
    fitLegacyPetPortrait(img);
    const task=img.decode().then(()=>{
      if(img.isConnected&&portraitClearanceJobs.get(img)===ticket&&!portraitMobileMedia.matches)fitLegacyPetPortrait(img);
    }).catch(()=>{});
    img.portraitFitPromise=task;return task;
  }
""",
        "",
    )
    replace(
        """      if(!img.isConnected||portraitClearanceJobs.get(img)!==ticket||!portraitMobileMedia.matches)return;
      const band=await nameBandGeometry(bg);
      if(!img.isConnected||portraitClearanceJobs.get(img)!==ticket||!portraitMobileMedia.matches)return;""",
        """      if(!img.isConnected||portraitClearanceJobs.get(img)!==ticket)return;
      const band=await nameBandGeometry(bg);
      if(!img.isConnected||portraitClearanceJobs.get(img)!==ticket)return;""",
    )
    replace(
        "      const {left,top,width,height,factor}=fitPortraitAboveBand(candidate,rows,band);",
        """      const {left,top,width,height,factor}=fitPortraitAboveBand(candidate,rows,band);
      // Leave the approved CSS pose in place when its silhouette already fits.
      if(factor===1)return;""",
    )
    section = section.replace("clearMobilePortraitFit", "clearPortraitClearance")
    section = section.replace("Mobile portrait clearance:", "Portrait clearance:")

source = source[:start] + section + source[end:]
source = source.replace(
    "// R71: desktop uses the unchanged R68 placement; only narrow screens fit above the band.",
    "// Preserve the approved breed placement unless a visible pixel comes too close to the name band.",
)
page.write_text(source, encoding="utf-8")
