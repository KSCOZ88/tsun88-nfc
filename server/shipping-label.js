'use strict';

const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const PDFDocument = require('pdfkit');
const serif = 'Times-Italic';
const script = readFileSync(join(__dirname, '../node_modules/@fontsource/pinyon-script/files/pinyon-script-latin-400-normal.woff'));
const latin = /^[\x20-\xff‘’“”–—]+$/;
let hantFont;

const mm = 72 / 25.4;
const labelWidth = 88 * mm;
const labelHeight = 50.6 * mm;
const ink = '#193B28';
const left = 14;
const contentWidth = 181;
const shippingLabelPrintTip = '<p>收件地址 PDF 請用 A4 橫向、100% 實際大小列印。</p>';

function addressLines(value) {
  const lines = value.split(/[\r\n]+/).map(line => line.trim()).filter(Boolean);
  return lines.length === 1 ? lines[0].split(/(?<=[,，])\s*/).filter(Boolean) : lines;
}

function wrap(doc, lines, size) {
  const rows = [];
  const segmenter = new Intl.Segmenter('zh-Hant', {granularity: 'word'});
  for (const {text, name} of lines) {
    const font = latin.test(text) ? (name ? 'Times-BoldItalic' : serif) : 'Hant';
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

function paw(doc, x, y) {
  doc.save().translate(x, y).fillColor(ink);
  doc.ellipse(-7, -4, 1.9, 3).fill();
  doc.ellipse(-2.5, -7, 2, 3.2).fill();
  doc.ellipse(2.5, -7, 2, 3.2).fill();
  doc.ellipse(7, -4, 1.9, 3).fill();
  doc.path('M -6.7 4 C -5 1 -3 -2 0 -2 C 3 -2 5 1 6.7 4 C 8 7 4.6 9 1.8 7.3 C .7 6.5 -.7 6.5 -1.8 7.3 C -4.6 9 -8 7 -6.7 4 Z').fill();
  doc.restore();
}

function drawLabel(doc, rows, index, total, size) {
  const slot = index % 9;
  const col = slot % 3;
  const row = Math.floor(slot / 3);
  const gap = 11;
  const x = (doc.page.width - labelWidth * 3 - gap * 2) / 2 + col * (labelWidth + gap);
  const y = 29 + row * (labelHeight + gap);
  doc.save().translate(x, y);

  doc.rect(0, 0, labelWidth, labelHeight).fill('#151613');
  doc.rect(3.6, 3.6, labelWidth - 7.2, labelHeight - 7.2).fill('#FFFDF6');
  doc.lineWidth(.55).rect(6.7, 6.7, labelWidth - 13.4, labelHeight - 13.4).stroke(ink);
  doc.lineWidth(.35).rect(8.2, 8.2, labelWidth - 16.4, labelHeight - 16.4).stroke(ink);

  doc.fillColor(ink).font('Script').fontSize(23).text('Please Deliver To:', left, 16, {lineBreak: false});
  doc.font('Times-BoldItalic').fontSize(17).text('8TSUN8', 170, 15, {lineBreak: false});
  doc.font('Times-Roman').fontSize(6.3).text('SMART PET TAG', 177, 34, {lineBreak: false});
  doc.lineWidth(.55).moveTo(left, 45).lineTo(labelWidth - left, 45).stroke(ink);

  doc.save().lineWidth(.75);
  doc.circle(219, 111, 15.5).stroke(ink);
  doc.circle(219, 111, 12.8).stroke(ink);
  paw(doc, 219, 111);
  doc.restore();

  rows.forEach(({text, font}, i) => {
    doc.fillColor(ink).font(font).fontSize(size).text(text, left, 50 + i * (size + 2.8), {lineBreak: false});
  });
  if (total > 1) {
    doc.fillColor(ink).font('Times-Roman').fontSize(7).text((index + 1) + ' / ' + total, 211, 57, {lineBreak: false});
  }
  doc.restore();
}

async function shippingLabelAttachment(order) {
  const name = typeof order?.shipName === 'string' ? order.shipName.trim() : '';
  const address = typeof order?.shipAddress === 'string' ? order.shipAddress.trim() : '';
  if (!name || name.length > 120 || !address || address.length > 1000) return null;

  const lines = [{text: name.replace(/\s+/g, ' '), name: true},
    ...addressLines(address).map(text => ({text: text.replace(/\s+/g, ' ')}))];
  const doc = new PDFDocument({
    size: 'A4', layout: 'landscape', margin: 0, autoFirstPage: false,
    displayTitle: true, info: {Title: '8TSUN8 Shipping Address', Creator: '8TSUN8'}
  });
  doc.registerFont('Script', script);
  if (lines.some(({text}) => !latin.test(text))) {
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
  let layout;
  for (const size of variants) {
    const rows = wrap(doc, lines, size);
    const perLabel = Math.floor(82 / (size + 2.8));
    layout = {rows, perLabel, size};
    if (rows.length <= perLabel) break;
  }
  const {rows, perLabel, size} = layout;
  const total = Math.ceil(rows.length / perLabel);
  for (let i = 0; i < total; i++) {
    if (i % 9 === 0) doc.addPage();
    drawLabel(doc, rows.slice(i * perLabel, (i + 1) * perLabel), i, total, size);
  }

  doc.end();
  return {
    filename: '8TSUN8-收件地址.pdf',
    content: (await pdf).toString('base64'),
    content_type: 'application/pdf'
  };
}

module.exports = {shippingLabelAttachment, shippingLabelPrintTip};
