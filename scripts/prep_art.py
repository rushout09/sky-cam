"""Turn the generated art in art/ into web assets in assets/.

Figures (figure-*.png, painted on black) get a real alpha channel: the solid figure is kept
opaque and the black background becomes transparent, with the glow kept as translucent light.
Skies (sky-*.png) are resized and compressed. Usage: python3 scripts/prep_art.py
"""
import glob, os
import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.join(os.path.dirname(__file__), "..")
OUT = os.path.join(ROOT, "assets")

def cut_out_black(im):
    a = np.asarray(im.convert("RGB")).astype(np.float32)
    mx = a.max(axis=2)
    solid = mx > 100
    solid = ndimage.binary_closing(solid, structure=np.ones((3, 3)), iterations=2)
    # fill only small holes (dark hair, shadows inside the figure), not the big gaps between the arms
    holes, n = ndimage.label(ndimage.binary_fill_holes(solid) & ~solid)
    if n:
        sizes = ndimage.sum(np.ones_like(mx), holes, range(1, n + 1))
        small = np.isin(holes, 1 + np.flatnonzero(sizes < mx.size * 0.0015))
        solid |= small
    solid = ndimage.binary_opening(solid, structure=np.ones((3, 3)), iterations=3)  # drop thin rays
    core = ndimage.gaussian_filter(ndimage.binary_erosion(solid, iterations=2).astype(np.float32), 1.5)
    glow = np.clip(mx / 255 * 1.4, 0, 1)
    alpha = np.maximum(core, glow)
    rgb = np.where(alpha[..., None] > 0.02, np.clip(a / np.maximum(alpha[..., None], 1e-3), 0, 255), 0)
    rgb = np.where(core[..., None] > 0.5, a, rgb)          # keep the figure's own colours untouched
    return Image.fromarray(np.dstack([rgb, alpha * 255]).astype(np.uint8), "RGBA")

def main():
    os.makedirs(OUT, exist_ok=True)
    for path in sorted(glob.glob(os.path.join(ROOT, "art", "*.png"))):
        name = os.path.splitext(os.path.basename(path))[0]
        im = Image.open(path)
        if name.startswith("figure-"):
            im = cut_out_black(im)
            im.thumbnail((1000, 1000 * 2))
            im.save(os.path.join(OUT, name + ".webp"), quality=82, method=6)
        else:
            im = im.convert("RGB")
            im.thumbnail((1080, 1920 * 2))
            im.save(os.path.join(OUT, name + ".webp"), quality=84, method=6)
        im.convert("RGB").resize((90, int(90 * im.height / im.width))).save(
            os.path.join(OUT, name + "-thumb.jpg"), quality=78)
        print(name, os.path.getsize(os.path.join(OUT, name + ".webp")) // 1024, "KB")

if __name__ == "__main__":
    main()
