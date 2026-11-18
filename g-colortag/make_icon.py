#!/usr/bin/env python3
"""앱 아이콘(AppIcon.icns) 생성: 어두운 배경 + RGB 막대 + 감마 곡선. 사용: python3 make_icon.py 출력.icns"""
import io
import struct
import sys

from PIL import Image, ImageDraw


def draw(size=1024):
    s = size / 1024
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([100 * s, 100 * s, 924 * s, 924 * s], radius=185 * s, fill=(28, 30, 38, 255))
    for i, c in enumerate([(235, 72, 72), (70, 200, 110), (70, 130, 240)]):  # R G B 막대
        x = 250 + i * 190
        d.rounded_rectangle([x * s, 300 * s, (x + 140) * s, 760 * s], radius=30 * s, fill=c + (255,))
    pts = [((220 + 584 * t) * s, (790 - 560 * t ** (1 / 2.2)) * s) for t in [i / 60 for i in range(61)]]
    d.line(pts, fill="white", width=int(34 * s), joint="curve")  # 감마 곡선
    return img


def write_icns(path):
    base = draw(1024)
    entries = [(b"ic11", 32), (b"ic12", 64), (b"ic07", 128), (b"ic13", 256),
               (b"ic08", 256), (b"ic14", 512), (b"ic09", 512), (b"ic10", 1024)]
    body = b""
    for typ, px in entries:
        buf = io.BytesIO()
        base.resize((px, px), Image.LANCZOS).save(buf, "PNG")
        body += typ + struct.pack(">I", len(buf.getvalue()) + 8) + buf.getvalue()
    with open(path, "wb") as f:
        f.write(b"icns" + struct.pack(">I", len(body) + 8) + body)


if __name__ == "__main__":
    write_icns(sys.argv[1])
