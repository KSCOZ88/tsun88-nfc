(function (root) {
  'use strict';

  const slugPattern = /^[a-f0-9]{12}$/i;
  const namedPattern = /^\/p\/[^/]+-([a-f0-9]{12})\/?$/i;
  const legacyPaths = new Set(['/lucky88.html', '/merchant-profile']);

  function nameSegment(value) {
    const label = String(value ?? '').normalize('NFKC').toLowerCase().trim()
      .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
      .replace(/^-+|-+$/g, '');
    return [...label].slice(0, 24).join('').replace(/-+$/g, '');
  }

  function namedPath(slug, petName, ownerName) {
    if (typeof slug !== 'string' || !slugPattern.test(slug)) return null;
    const names = [nameSegment(petName) || 'pet', nameSegment(ownerName)].filter(Boolean);
    return '/p/' + encodeURIComponent(names.join('-')) + '-' + slug.toUpperCase();
  }

  function readSlug(url) {
    const named = url.pathname.match(namedPattern);
    const slug = named?.[1] ?? (legacyPaths.has(url.pathname) ? url.searchParams.get('p') : null);
    return slug && slugPattern.test(slug) ? slug.toUpperCase() : null;
  }

  const profileUrl = Object.freeze({namedPath, readSlug});
  if (typeof module !== 'undefined' && module.exports) module.exports = profileUrl;
  else root.TsunProfileUrl = profileUrl;
})(globalThis);
