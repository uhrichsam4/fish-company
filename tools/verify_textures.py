#!/usr/bin/env python3
"""
Verify every path referenced in src/data/textureManifest.js actually exists on
disk, is non-empty, and opens as a valid image. Also checks the overall size
budget for public/assets/{textures,hdri}.

This parses the *shipped* manifest file (not the generator that produced it),
so it catches drift from a manual edit too. Run directly:

    python3 tools/verify_textures.py
"""
import re
import sys
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parent.parent
PIL_UNSUPPORTED_EXT = {".hdr"}  # Radiance HDR: no PIL plugin; validated by magic header instead
MANIFEST = REPO / "src/data/textureManifest.js"
PUBLIC = REPO / "public"
TEX_DIR = PUBLIC / "assets/textures"
HDRI_DIR = PUBLIC / "assets/hdri"

STRING_RE = re.compile(r"""['"](assets/[^'"]+)['"]""")


def paths_in_manifest():
    text = MANIFEST.read_text()
    return sorted(set(STRING_RE.findall(text)))


def human(n):
    for unit in ("B", "KB", "MB"):
        if n < 1024 or unit == "MB":
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}MB"


def main():
    if not MANIFEST.exists():
        print(f"FAIL: manifest not found at {MANIFEST}")
        return 1

    paths = paths_in_manifest()
    print(f"Checking {len(paths)} paths referenced in {MANIFEST.relative_to(REPO)}\n")

    missing = []
    empty = []
    corrupt = []
    ok = []

    for rel in paths:
        p = PUBLIC / rel
        if not p.exists():
            missing.append(rel)
            continue
        size = p.stat().st_size
        if size == 0:
            empty.append(rel)
            continue
        if p.suffix.lower() in PIL_UNSUPPORTED_EXT:
            # Pillow has no Radiance HDR plugin; validate via the format's own
            # magic header instead ("#?RADIANCE" / "#?RGBE" first line).
            try:
                head = p.open("rb").read(11)
                if not (head.startswith(b"#?RADIANCE") or head.startswith(b"#?RGBE")):
                    raise ValueError(f"missing Radiance HDR magic header, got {head!r}")
            except Exception as e:
                corrupt.append((rel, str(e)))
                continue
            ok.append((rel, size))
            continue
        try:
            with Image.open(p) as im:
                im.verify()
        except Exception as e:
            corrupt.append((rel, str(e)))
            continue
        ok.append((rel, size))

    for rel in missing:
        print(f"  MISSING   {rel}")
    for rel in empty:
        print(f"  EMPTY     {rel}")
    for rel, err in corrupt:
        print(f"  CORRUPT   {rel}  ({err})")

    print(f"\nOK: {len(ok)}/{len(paths)}")
    if missing or empty or corrupt:
        print(f"FAILURES: {len(missing)} missing, {len(empty)} empty, {len(corrupt)} corrupt")

    # Cross-check: every file actually on disk under textures/ + hdri/ should
    # also be reachable from the manifest (nothing orphaned/forgotten), except
    # CREDITS.md and the .hdr companions (SKY_HDRI is checked above too, so
    # this really is just a sanity net).
    on_disk = set()
    for base in (TEX_DIR, HDRI_DIR):
        for p in base.rglob("*"):
            if p.is_file() and p.name != "CREDITS.md":
                on_disk.add(str(p.relative_to(PUBLIC)))
    referenced = set(paths)
    orphaned = sorted(on_disk - referenced)
    if orphaned:
        print(f"\nOn disk but NOT referenced by the manifest ({len(orphaned)}):")
        for rel in orphaned:
            print(f"  orphan    {rel}")

    # Size budget report
    print("\n--- size budget ---")
    tex_total = sum(p.stat().st_size for p in TEX_DIR.rglob("*") if p.is_file())
    hdri_total = sum(p.stat().st_size for p in HDRI_DIR.rglob("*") if p.is_file())
    print(f"  textures/  {human(tex_total)}  (budget ~20MB)")
    print(f"  hdri/      {human(hdri_total)}")
    print(f"  total      {human(tex_total + hdri_total)}")

    big_hdrs = [p for p in HDRI_DIR.glob("*.hdr") if p.stat().st_size > 3 * 1024 * 1024]
    if big_hdrs:
        print("\n  .hdr files over the 3MB keep-it cutoff:")
        for p in big_hdrs:
            print(f"    {p.name}: {human(p.stat().st_size)}")

    failed = bool(missing or empty or corrupt)
    print(f"\n{'FAIL' if failed else 'PASS'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
