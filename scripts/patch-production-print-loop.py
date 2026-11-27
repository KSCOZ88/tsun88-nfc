#!/usr/bin/env python3
"""Restore the hanging loop in both production PNG layers."""
from pathlib import Path

index = Path("index.html")
page = index.read_text(encoding="utf-8")


def replace(old, new):
    global page
    if new in page:
        return
    if page.count(old) != 1:
        raise SystemExit(f"Print loop export anchor missing or ambiguous: {old}")
    page = page.replace(old, new, 1)


replace(
    """    context.putImageData(pixels,0,0);
    return canvas.toDataURL('image/png');
  })();
  productionBoardCache""",
    """    context.putImageData(pixels,0,0);
    return {src:canvas.toDataURL('image/png'),band:'rgb('+band.join(',')+')'};
  })();
  productionBoardCache""",
)
replace(
    """  const ink=side==='back'?currentBackInk():currentNameInk(),base=escapeHtml(await productionBoardSource()),decor=productionDecorSvg(side);let content='';""",
    """  const ink=side==='back'?currentBackInk():currentNameInk(),base=await productionBoardSource(),decor=productionDecorSvg(side);let content='';""",
)
replace(
    '''  const svgMarkup=`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="350" height="399" viewBox="0 0 350 399"><image href="${base}" x="0" y="0" width="350" height="399" preserveAspectRatio="xMidYMid meet"/>${content}</svg>`;''',
    '''  // The source was cut through the crown of its hanging loop. Fit the crown
  // to the surviving rim in the original 350 by 399 design coordinates.
  const loopCrown=`<defs>
    <clipPath id="print-board-body"><rect x="0" y="8.5" width="350" height="390.5"/></clipPath>
    <clipPath id="print-loop-crown"><rect x="0" y="-6" width="350" height="14.5"/></clipPath>
  </defs>
  <ellipse cx="177.254" cy="34.100" rx="34.302" ry="34.288" fill="${base.band}" clip-path="url(#print-loop-crown)"/>`;
  const svgMarkup=`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="350" height="411" viewBox="0 -6 350 411">${loopCrown}<image href="${escapeHtml(base.src)}" x="0" y="0" width="350" height="399" preserveAspectRatio="xMidYMid meet" clip-path="url(#print-board-body)"/>${content}</svg>`;''',
)
replace(
    """  const url='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(fittedSvg),img=await loadExportImage(url),canvas=document.createElement('canvas');canvas.width=1416;canvas.height=1612;const context=canvas.getContext('2d');context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';context.drawImage(img,8,8,1400,1596);return canvasBlob(canvas);""",
    """  const url='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(fittedSvg),img=await loadExportImage(url),canvas=document.createElement('canvas');
  // Keep the exact same 4x design scale on both sides, adding only clear space.
  canvas.width=1416;canvas.height=1660;
  const context=canvas.getContext('2d');context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';
  context.drawImage(img,8,8,1400,1644);return canvasBlob(canvas);""",
)

index.write_text(page, encoding="utf-8")
