# /// script
# dependencies = ["Pillow"]
# ///
"""Make web copies of the photos in _originals/<event>/ as data/<event>/<name>.jpg
plus data/<event>/thumbs/<name>.jpg. Skips photos that are already converted.
Web copies are upright, sRGB, never enlarged, and have no metadata (no GPS).

Run:  uv run gallery/convert.py   (or: pip install Pillow, then python3 gallery/convert.py)
"""

import io
from pathlib import Path

from PIL import Image, ImageCms, ImageOps

GALLERY = Path(__file__).parent
SRGB = ImageCms.createProfile("sRGB")

for src in sorted(GALLERY.glob("_originals/*/*")):
    if src.suffix.lower() not in (".jpg", ".jpeg", ".png"):
        continue
    full = GALLERY / "data" / src.parent.name / f"{src.stem}.jpg"
    thumb = full.parent / "thumbs" / full.name
    if thumb.exists():
        continue

    img = ImageOps.exif_transpose(Image.open(src))  # rotate sideways phone photos upright
    if "icc_profile" in img.info:  # e.g. iPhone Display P3 -> sRGB
        img = ImageCms.profileToProfile(img, io.BytesIO(img.info["icc_profile"]), SRGB, outputMode="RGB")
    img = img.convert("RGB")

    thumb.parent.mkdir(parents=True, exist_ok=True)
    for out, size, quality in ((full, 2000, 82), (thumb, 800, 76)):
        copy = img.copy()
        copy.thumbnail((size, size))  # shrinks only, never enlarges
        copy.save(out, quality=quality, optimize=True, progressive=True)  # saved without metadata
    print(f"{src.relative_to(GALLERY)} -> {full.relative_to(GALLERY)}")
