#!/usr/bin/env python3
"""Use the storefront's board palette for the public NFC page, too."""
import re
from pathlib import Path

storefront = Path("index.html").read_text(encoding="utf-8")
profile = Path("lucky88.html")
page = profile.read_text(encoding="utf-8")

theme = []
for tag, name in (("style", "tsun88-profile-theme-styles"), ("script", "tsun88-profile-theme")):
    matches = re.findall(fr'<{tag} id="{name}">[\s\S]*?</{tag}>', storefront)
    if len(matches) != 1:
        raise SystemExit(f"Expected one storefront {name}, found {len(matches)}")
    theme.extend(matches)

theme_markup = "\n".join(theme)
if theme_markup not in page:
    page, count = re.subn(r"(?=</head>)", lambda _: theme_markup + "\n", page)
    if count != 1:
        raise SystemExit("Expected one profile head")
    profile.write_text(page, encoding="utf-8")
