'use strict';

const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const test = require('node:test');
const {runInNewContext} = require('node:vm');

test('public profile renders the same board palettes as the checkout', () => {
  const page = readFileSync('lucky88.html', 'utf-8');
  const storefront = readFileSync('index.html', 'utf-8');
  const shared = storefront.match(/<script id="tsun88-profile-theme">([\s\S]*?)<\/script>/)[0];
  assert.ok(page.includes(shared));
  assert.match(page, /:root\[data-pet-palette\] \.hero\{background:linear-gradient/);
  const window = {};
  runInNewContext(shared.slice(shared.indexOf('>') + 1, shared.lastIndexOf('</script>')), {window});
  const theme = window.TsunProfileTheme;
  const applySource = page.slice(page.indexOf('function applyProfile(data)'), page.indexOf('  const language = data.profile_language')) + '}';
  const check = (search, saved, expected) => {
    const colors = {};
    const element = {dataset: {}, style: {setProperty(name, value) { colors[name] = value; }}};
    runInNewContext(applySource + '; applyProfile(saved);', {
      window, saved, profileParams: new URLSearchParams(search), document: {documentElement: element}
    });
    assert.equal(element.dataset.petPalette, expected);
    const palette = theme.paletteFor(expected);
    assert.equal(colors['--pet-primary'], palette?.primary);
    assert.equal(colors['--pet-accent'], palette?.accent);
  };
  check('p=TEST&base=green2', {}, 'green2');
  assert.equal(theme.paletteFor('green2').primary, '#16ae67');
  assert.equal(theme.paletteFor('green2').accent, '#e83328');
  for (const family of ['green', 'grey', 'orange', 'pink', 'red', 'white', 'yellow']) {
    for (let i = 1; i <= 7; i++) check('b=' + family + i, {}, family + i);
  }
  check('base=green-blue', {}, 'green1');
  check('b=invalid&base=white3', {}, 'white3');
  check('b=white3', {base_variant:'green2'}, 'green2');
  check('b=rgb(0,0,0)', {}, undefined);
});
