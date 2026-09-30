#!/usr/bin/env python3
"""Sync Android launcher icons from the Fern desktop icon.

The generated Android project under src-tauri/gen/android still carries the
stock Tauri robot art (it was scaffolded before the Fern icon landed and was
never re-synced). This script re-renders every launcher slot from
src-tauri/icons/icon.png so the APK/AAB ship the Fern mark:

- mipmap-<density>/ic_launcher.png and ic_launcher_round.png (legacy)
- mipmap-<density>/ic_launcher_foreground.png (adaptive foreground)
- drawable/ic_launcher_background.xml (adaptive background, solid Fern green)
- drawable-v24/ic_launcher_foreground.xml (vector fallback, Fern leaf)
- mipmap-anydpi-v26/ic_launcher{,_round}.xml (adaptive definitions)

Usage: python3 scripts/sync_android_icons.py
Requires: rsvg-convert (only used with --svg; default path uses PIL only).
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "src-tauri/gen/android/app/src/main/res"
SOURCE = ROOT / "src-tauri/icons/icon.png"
BACKGROUND_GREEN = "#477A62"
# Fern leaf from public/fern.svg, scaled 64 -> 108 viewport (x1.6875).
LEAF_PATH = (
    "M33.75,75.94V47.25c0,-16.88 13.5,-25.31 38.81,-23.63v13.5"
    "c-16.88,-1.69 -25.31,3.38 -25.31,13.5h21.94v13.5H47.25v11.81z"
)
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}

BACKGROUND_XML = """<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="{green}"
        android:pathData="M0,0h108v108h-108z" />
</vector>
"""

FOREGROUND_VECTOR_XML = """<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#E4F1E8"
        android:pathData="{leaf}" />
</vector>
"""

ADAPTIVE_XML = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
"""


def render_png(source: Path, size: int, dest: Path) -> None:
    from PIL import Image

    image = Image.open(source).convert("RGBA").resize((size, size), Image.LANCZOS)
    dest.parent.mkdir(parents=True, exist_ok=True)
    image.save(dest)


def main() -> int:
    if not SOURCE.exists():
        print(f"source icon missing: {SOURCE}", file=sys.stderr)
        return 1
    for density, scale in DENSITIES.items():
        legacy = round(48 * scale)
        foreground = round(108 * scale)
        render_png(SOURCE, legacy, RES / f"mipmap-{density}/ic_launcher.png")
        render_png(SOURCE, legacy, RES / f"mipmap-{density}/ic_launcher_round.png")
        render_png(SOURCE, foreground, RES / f"mipmap-{density}/ic_launcher_foreground.png")
    (RES / "drawable/ic_launcher_background.xml").write_text(
        BACKGROUND_XML.format(green=BACKGROUND_GREEN), encoding="utf-8"
    )
    (RES / "drawable-v24/ic_launcher_foreground.xml").write_text(
        FOREGROUND_VECTOR_XML.format(leaf=LEAF_PATH), encoding="utf-8"
    )
    anydpi = RES / "mipmap-anydpi-v26"
    anydpi.mkdir(parents=True, exist_ok=True)
    (anydpi / "ic_launcher.xml").write_text(ADAPTIVE_XML, encoding="utf-8")
    (anydpi / "ic_launcher_round.xml").write_text(ADAPTIVE_XML, encoding="utf-8")
    print(f"synced launcher icons from {SOURCE.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
