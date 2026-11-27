'use strict';

const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const PDFDocument = require('pdfkit');
const background = readFileSync(join(__dirname, 'print-assets/address-vintage.jpg'));
const script = readFileSync(join(__dirname, '../node_modules/@fontsource/pinyon-script/files/pinyon-script-latin-400-normal.woff'));
const latin = /^[\x20-\xff‘’“”–—]+$/;
let hantFont;

const mm = 72 / 25.4;
const labelWidth = 88 * mm;
const labelHeight = labelWidth * 788 / 1390;
const ink = '#1F3D26';
const left = 13.818;
const contentWidth = 164;
const addressLineOffsets = [68.374, 87.038, 104.804, 123.109];
const shippingLabelPrintTip = '<p>收件地址 PDF 請用 A4 橫向、100% 實際大小列印。</p>';

function addressLines(value) {
  const lines = value.split(/[\r\n]+/).map(line => line.trim()).filter(Boolean);
  return lines.length === 1 ? lines[0].split(/(?<=[,，])\s*/).filter(Boolean) : lines;
}

function wrap(doc, lines, size) {
  const rows = [];
  const segmenter = new Intl.Segmenter('zh-Hant', {granularity: 'word'});
  for (const text of lines) {
    const font = latin.test(text) ? 'Script' : 'Hant';
    doc.font(font).fontSize(size);
    let row = '';
    const add = part => { rows.push({text: part, font}); };
    for (const {segment} of segmenter.segment(text)) {
      if (doc.widthOfString(row + segment) <= contentWidth) {
        row += row.length || segment.trim() ? segment : '';
        continue;
      }
      if (row.trim()) add(row.trim());
      row = segment.trimStart();
      if (doc.widthOfString(row) <= contentWidth) continue;
      let chunk = '';
      for (const glyph of row) {
        if (doc.widthOfString(chunk + glyph) > contentWidth) {
          add(chunk);
          chunk = '';
        }
        chunk += glyph;
      }
      row = chunk;
    }
    if (row.trim()) add(row.trim());
  }
  return rows;
}

function drawLabel(doc, artwork, rows, slot, index, total, size) {
  const col = slot % 3;
  const row = Math.floor(slot / 3);
  const x = 12.5 * mm + col * (labelWidth + 4 * mm);
  const y = 69.926 + row * 157.005;
  doc.image(artwork, x, y, {width: labelWidth, height: labelHeight});
  rows.forEach(({text, font}, i) => {
    doc.fillColor(ink).font(font).fontSize(size).text(text, x + left, y + addressLineOffsets[i],
      {lineBreak: false, baseline: 'alphabetic'});
  });
  if (total > 1) {
    doc.fillColor(ink).font('Times-Roman').fontSize(7)
      .text((index + 1) + ' / ' + total, x + 216, y + 65, {lineBreak: false});
  }
}

async function shippingLabelAttachment(order, {threeAcross = false} = {}) {
  const name = typeof order?.shipName === 'string' ? order.shipName.trim() : '';
  const address = typeof order?.shipAddress === 'string' ? order.shipAddress.trim() : '';
  if (!name || name.length > 120 || !address || address.length > 1000) return null;

  const lines = [name, ...addressLines(address)].map(line => line.replace(/\s+/g, ' '));
  const doc = new PDFDocument({
    size: 'A4', layout: 'landscape', margin: 0, autoFirstPage: false,
    displayTitle: true, info: {Title: '8TSUN8 Shipping Address', Creator: '8TSUN8'}
  });
  doc.registerFont('Script', script);
  if (lines.some(text => !latin.test(text))) {
    hantFont ??= readFileSync(join(__dirname, '../node_modules/@embedpdf/fonts-tc/fonts/NotoSansHant-Regular.otf'));
    doc.registerFont('Hant', hantFont);
  }
  const pdf = new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const variants = [12, 11, 10, 9];
  const perLabel = addressLineOffsets.length;
  let layout;
  for (const size of variants) {
    const rows = wrap(doc, lines, size);
    layout = {rows, size};
    if (rows.length <= perLabel) break;
  }
  const {rows, size} = layout;
  const artwork = doc.openImage(background);
  const total = Math.ceil(rows.length / perLabel);
  const copies = threeAcross ? 3 : 1;
  for (let i = 0; i < total; i++) {
    const slot = (i * copies) % 9;
    if (slot === 0) doc.addPage();
    const section = rows.slice(i * perLabel, (i + 1) * perLabel);
    for (let copy = 0; copy < copies; copy++) {
      drawLabel(doc, artwork, section, slot + copy, i, total, size);
    }
  }

  doc.end();
  return {
    filename: '8TSUN8-收件地址.pdf',
    content: (await pdf).toString('base64'),
    content_type: 'application/pdf'
  };
}

module.exports = {shippingLabelAttachment, shippingLabelPrintTip};
