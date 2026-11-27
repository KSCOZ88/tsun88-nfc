#!/usr/bin/env python3
"""Share the storefront's board colours and profile URLs with the public NFC page."""
import re
from pathlib import Path

storefront_file = Path("index.html")
storefront = storefront_file.read_text(encoding="utf-8")
profile = Path("lucky88.html")
page = profile.read_text(encoding="utf-8")


def replace_once(source, before, after):
    if after in source:
        return source
    if source.count(before) != 1:
        raise SystemExit(f"Expected one profile theme anchor: {before}")
    return source.replace(before, after, 1)


storefront = replace_once(
    storefront,
    '<script id="tsun88-profile-theme">',
    '<script src="/assets/tsun-profile-url.js"></script>\n<script id="tsun88-profile-theme">',
)
storefront = replace_once(
    storefront,
    'background:linear-gradient(to bottom,var(--pet-primary) 0%,var(--pet-primary) 50%,var(--pet-accent) 50%,var(--pet-accent) 100%);color:var(--pet-hero-ink);border-bottom:0;',
    'background:linear-gradient(to bottom,var(--pet-accent) 0 34px,var(--pet-primary) 34px calc(100% - 42px),var(--pet-accent) calc(100% - 42px) 100%);color:var(--pet-hero-ink);padding-top:48px;padding-bottom:66px;border-bottom:0;',
)
storefront = replace_once(
    storefront,
    ' .hero .tags{color:var(--pet-accent-ink);text-shadow:none;}',
    ' .hero .tags{color:var(--pet-hero-ink);text-shadow:none;}',
)
storefront = replace_once(
    storefront,
    'function publicUrl(page,slug,variant){',
    'function publicUrl(page,slug,variant,petName,ownerName){',
)
storefront = replace_once(
    storefront,
    "    url.searchParams.set('p',String(slug));",
    "    const path=global.TsunProfileUrl?.namedPath(slug,petName,ownerName);\n    if(path)url.pathname=path;else url.searchParams.set('p',String(slug));",
)
storefront = replace_once(
    storefront,
    'TsunProfileTheme.publicUrl(NFC_PUBLIC_PAGE,data.public_slug,variant)',
    'TsunProfileTheme.publicUrl(NFC_PUBLIC_PAGE,data.public_slug,variant,order.petName,order.ownerName)',
)
storefront_file.write_text(storefront, encoding="utf-8")

theme = []
for tag, name in (("style", "tsun88-profile-theme-styles"), ("script", "tsun88-profile-theme")):
    matches = re.findall(fr'<{tag} id="{name}">[\s\S]*?</{tag}>', storefront)
    if len(matches) != 1:
        raise SystemExit(f"Expected one storefront {name}, found {len(matches)}")
    theme.extend(matches)

theme_markup = "\n".join(theme)
if theme_markup not in page:
    page = replace_once(page, "</head>", theme_markup + "\n</head>")
    profile.write_text(page, encoding="utf-8")
