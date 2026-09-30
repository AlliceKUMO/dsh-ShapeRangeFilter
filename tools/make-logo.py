"""Generate the plugin logo (128x128 PNG) without external assets.

The mark is a square inside a dashed ring: the square is what Eagle's
native filter matches, the ring is the tolerance this plugin adds.

Usage: python make-logo.py <output.png>
"""
import math
import sys

from PIL import Image, ImageDraw

SIZE = 128
BG = (91, 140, 255, 255)      # accent blue, matches the plugin UI
INK = (255, 255, 255, 255)
RING = (214, 228, 255, 255)


def rounded_background(img):
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=28, fill=255)
    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def dashed_ring(draw, cx, cy, radius, width, dash_deg=9, gap_deg=7):
    angle = 0.0
    while angle < 360:
        draw.arc(
            [cx - radius, cy - radius, cx + radius, cy + radius],
            start=angle, end=angle + dash_deg, fill=RING, width=width,
        )
        angle += dash_deg + gap_deg


def main():
    dest = sys.argv[1] if len(sys.argv) > 1 else "logo.png"
    img = Image.new("RGBA", (SIZE, SIZE), BG)
    draw = ImageDraw.Draw(img)

    # Inner square: the exact-match shape native Eagle can find.
    draw.rectangle([40, 40, 88, 88], outline=INK, width=7)

    # Dashed ring: the tolerance band this plugin can search.
    dashed_ring(draw, SIZE / 2, SIZE / 2, 49, 3)

    rounded_background(img).save(dest, "PNG")
    print(f"wrote {dest}")


if __name__ == "__main__":
    main()
