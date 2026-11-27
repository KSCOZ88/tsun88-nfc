'use strict';

const {PNG} = require('pngjs');

function readPrintImage(bytes) {
  if (bytes.length < 33) throw new Error('Invalid print image header');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  // The production export is 1416 × 1660, and older exports are shorter.
  // Cap the decoded image before inflating uploaded PNG data.
  if (!width || !height || width > 1800 || height > 1800) throw new Error('Invalid print image dimensions');
  return PNG.sync.read(bytes);
}

function sideHeight(image, width) {
  return Math.max(1, Math.round(image.height * width / image.width));
}

function copySide(image, target, x, width) {
  if (image.width === width) {
    PNG.bitblt(image, target, 0, 0, image.width, image.height, x, 0);
    return;
  }

  // A source may have been reduced to fit the attachment budget. Match the
  // panel widths without blending print colours or adding a background.
  const height = sideHeight(image, width);
  for (let y = 0; y < height; y++) {
    const sourceRow = Math.floor(y * image.height / height) * image.width;
    const targetRow = y * target.width + x;
    for (let column = 0; column < width; column++) {
      const sourceIndex = sourceRow + Math.floor(column * image.width / width);
      target.data.writeUInt32LE(image.data.readUInt32LE(sourceIndex * 4), (targetRow + column) * 4);
    }
  }
}

function combinePrintSides(frontBytes, backBytes) {
  const front = readPrintImage(frontBytes);
  const back = readPrintImage(backBytes);
  const width = Math.max(front.width, back.width);
  const gap = Math.max(1, Math.round(width * 0.05));
  const height = Math.max(sideHeight(front, width), sideHeight(back, width));
  if (height > 2000) throw new Error('Invalid print panel proportions');
  const combined = new PNG({width: width * 2 + gap, height, fill: true});
  copySide(front, combined, 0, width);
  copySide(back, combined, width + gap, width);

  return PNG.sync.write(combined, {deflateLevel: 9});
}

module.exports = {combinePrintSides};
