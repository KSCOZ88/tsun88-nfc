'use strict';

// District Council names used by the Digital Policy Office Address Lookup Service.
const districts = [
  ['Central and Western', '中西'], ['Eastern', '東', '东'], ['Islands', '離島', '离岛'],
  ['Kowloon City', '九龍城', '九龙城'], ['Kwai Tsing', '葵青'], ['Kwun Tong', '觀塘', '观塘'],
  ['North', '北'], ['Sai Kung', '西貢', '西贡'], ['Sha Tin', '沙田'],
  ['Sham Shui Po', '深水埗'], ['Southern', '南'], ['Tai Po', '大埔'], ['Tsuen Wan', '荃灣', '荃湾'],
  ['Tuen Mun', '屯門', '屯门'], ['Wan Chai', '灣仔', '湾仔'],
  ['Wong Tai Sin', '黃大仙', '黄大仙'], ['Yau Tsim Mong', '油尖旺'], ['Yuen Long', '元朗']
];

const canonicalDistricts = new Map(districts.map(([name]) => [name.toLowerCase(), name + ' District']));
const districtTranslations = new Map(districts.flatMap(([name, ...aliases]) =>
  aliases.map(alias => [alias, name + ' District'])));
const chineseDistricts = [...districtTranslations.keys()];
const englishDistrict = /\b(?:central (?:and|&) western|eastern|islands|kowloon city|kwai tsing|kwun tong|north|sai kung|sha tin|sham shui po|southern|tai po|tsuen wan|tuen mun|wan chai|wong tai sin|yau tsim mong|yuen long) district\b(?=\s*(?:$|[,，;；\r\n]|Hong\s*Kong\b|HKSAR\b|香港))/i;
const chineseDistrict = new RegExp('(' + chineseDistricts.join('|') + ')[區区](?!醫院|医院|警署|警察|大會堂|大会堂|政府合署|法院|消防)', 'u');
const leadingHongKong = new RegExp(
  '^(?:(?:Hong\\s*Kong|HKSAR)(?=$|[,，;；\\r\\n]|\\s+\\d)|' +
  '(?:中國|中国)?香港(?:特別行政區|特别行政区)?(?=$|[,，;；\\s]|九龍|九龙|新界|港島|港岛|中環|中环|上環|上环|' +
  '西環|西环|金鐘|金钟|銅鑼灣|铜锣湾|旺角|尖沙咀|灣仔|湾仔|(?:' + chineseDistricts.join('|') + ')[區区]))[,，;；\\s]*', 'iu');
const trailingHongKong = /(?:^|[,，\s]+)(?:Hong\s*Kong|HKSAR|(?:中國|中国)?香港(?:特別行政區|特别行政区)?)[。.]?$/iu;
const trimAddressSeparators = /^[,，\s;；]+|[,，\s;；]+$/gu;

const englishStreet = /\b(\d+[a-z]?(?:[-–]\d+[a-z]?)?)\s+([a-z][a-z0-9 .’'\-]{0,75}?\b(?:boulevard|avenue|terrace|crescent|street|parade|drive|road|lane|place|court|close|walk|path|rise|way|blvd|ave|rd|st|ln|dr|pl|ct)(?:\s+(?:central|east|west|north|south))?)\b/i;
const chineseStreet = /([\p{Script=Han}]{1,45}?(?:大道[東南西北中东]?|[道街路][東南西北中东]?|巷|徑|径|里|圍|围))\s*(\d+[a-z]?(?:[-–]\d+[a-z]?)?)\s*[號号]/iu;
const buildingName = /^(?:[\p{L}\p{N}][\p{L}\p{N}'’ .&-]{1,75}\s+(?:building|centre|center|tower|house|court|mansion|arcade|plaza|estate|garden|gardens|residences|offices)|[\p{Script=Han}]{2,35}(?:大廈|大厦|中心|廣場|广场|商場|商场|花園|花园|屋苑|屋邨|山莊|山庄))$/iu;
const foreignAddress = /\b(?:united kingdom|england|scotland|wales|northern ireland|united states|usa|australia|canada|singapore|taiwan|taipei|taichung|tainan|shenzhen|guangzhou|macau|macao)\b|台灣|臺灣|台湾|台北|臺北|台中|臺中|台南|臺南|深圳|廣州|广州|澳門|澳门/iu;

function key(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[’']/g, '')
    .replace(/[.]/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeDistrict(name) {
  return canonicalDistricts.get(key(name).replace(/\s*&\s*/g, ' and ').replace(/ district$/, ''));
}

function hongKongAddressParts(value) {
  const address = value.normalize('NFKC').trim();
  const english = address.match(englishDistrict);
  const chinese = address.match(chineseDistrict);
  const hasCountry = leadingHongKong.test(address) || trailingHongKong.test(address);
  if (!hasCountry && (!english && !chinese || foreignAddress.test(address))) return null;

  const district = english ? normalizeDistrict(english[0]) : districtTranslations.get(chinese?.[1]);
  let street = address.replace(trimAddressSeparators, '').replace(leadingHongKong, '').replace(trailingHongKong, '');
  if (english) street = street.replace(english[0], '');
  if (chinese) street = street.replace(chinese[0], '');
  street = street.replace(trimAddressSeparators, '');
  return {street, district, country: 'Hong Kong'};
}

function streetKey(value) {
  return key(value).replace(/\b(ave|rd|st|ln|dr|pl|ct|blvd)\b/g, suffix =>
    ({ave:'avenue', rd:'road', st:'street', ln:'lane', dr:'drive', pl:'place', ct:'court', blvd:'boulevard'})[suffix]);
}

function candidate(address) {
  const en = address.match(englishStreet);
  if (en) return {number: en[1], street: en[2], query: en[0]};
  const zh = address.match(chineseStreet);
  if (zh) return {number: zh[2], street: zh[1], chinese: true, query: zh[0]};
  const building = address.split(/[,，;；\r\n]+/).map(part => part.trim()).find(part => buildingName.test(part));
  return building ? {building, query: building} : null;
}

function numberMatches(number, from, to) {
  const n = key(number).replace('–', '-');
  const first = key(from);
  const last = key(to);
  if (!first) return false;
  if (n === first && (!last || first === last)) return true;
  if (last && n === first + '-' + last) return true;
  if (![n, first, last].every(value => /^\d+$/.test(value))) return false;
  const [value, start, end] = [n, first, last].map(Number);
  return value >= start && value <= end && (start % 2 !== end % 2 || value % 2 === start % 2);
}

function matchPremises(premises, input) {
  const en = premises?.EngPremisesAddress;
  const zh = premises?.ChiPremisesAddress;
  if (input.building) {
    return [en?.BuildingName, zh?.BuildingName, en?.EngEstate?.EstateName, zh?.ChiEstate?.EstateName]
      .some(value => value && key(value) === key(input.building));
  }
  const address = input.chinese ? zh : en;
  const street = input.chinese ? address?.ChiStreet : address?.EngStreet;
  if (!street?.StreetName || !numberMatches(input.number, street.BuildingNoFrom, street.BuildingNoTo)) return false;
  if (!input.chinese) {
    const given = streetKey(input.street);
    const official = streetKey(street.StreetName);
    return given === official || given === official + ' ' + key(street.LocationName);
  }

  // Chinese addresses commonly concatenate the region, district, and street.
  const prefixes = ['', key(address.Region), key(street.LocationName), key(address.ChiDistrict?.DcDistrict)];
  const official = key(street.StreetName);
  const given = key(input.street);
  return prefixes.some(first => prefixes.some(second => given === first + second + official));
}

async function completeHongKongAddress(order, request = globalThis.fetch) {
  const address = order.shipAddress?.trim();
  if (!address) return order;
  const normalized = address.normalize('NFKC');
  if (englishDistrict.test(normalized) || chineseDistrict.test(normalized) || foreignAddress.test(normalized)) return order;

  const input = candidate(normalized);
  const needsReview = {...order, shippingDistrictUnverified: true};
  if (!input) return needsReview;
  try {
    const url = new URL('https://www.als.gov.hk/lookup');
    url.searchParams.set('q', input.query);
    url.searchParams.set('n', '30');
    const response = await request(url, {headers: {Accept: 'application/json', 'Accept-Language': 'en, zh-Hant'},
      signal: AbortSignal.timeout(4000)});
    if (!response.ok) return needsReview;
    const data = await response.json();
    const results = data.SuggestedAddress ?? data.AddressLookupResult?.SuggestedAddress;
    const verified = new Set();
    for (const result of Array.isArray(results) ? results : []) {
      const premises = result.Address?.PremisesAddress;
      if (!matchPremises(premises, input)) continue;
      // Missing or unrecognised district data for an exact match makes it ambiguous.
      verified.add(normalizeDistrict(premises.EngPremisesAddress?.EngDistrict?.DcDistrict));
    }
    if (verified.size !== 1 || verified.has(undefined)) return needsReview;

    const district = verified.values().next().value;
    const body = hongKongAddressParts(address)?.street ?? address;
    return {...order, shipAddress: [body, district, 'Hong Kong'].filter(Boolean).join('\n')};
  } catch {
    return needsReview;
  }
}

module.exports = {completeHongKongAddress, hongKongAddressParts};
