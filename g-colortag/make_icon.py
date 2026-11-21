#!/usr/bin/env python3
# Copyright (c) 2026 GRAYZONE. All rights reserved.
"""앱 아이콘(AppIcon.icns) 생성: 어두운 배경 + RGB 막대 + 감마 곡선. 사용: python3 make_icon.py 출력.icns [런치 화면용.png]"""
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


def icns_png(icns, out, typ=b"ic09"):
    """아이콘 파일(.icns) 안에 든 512px 그림을 그대로 꺼냄 → 런치 화면이 Dock·Finder 와 같은 그림을 씀."""
    data = open(icns, "rb").read()
    pos = 8
    while pos < len(data):
        t, n = data[pos:pos + 4], struct.unpack(">I", data[pos + 4:pos + 8])[0]
        if t == typ:
            open(out, "wb").write(data[pos + 8:pos + n])
            return
        pos += n
    raise SystemExit("아이콘에서 그림을 찾지 못함")


if __name__ == "__main__":
    write_icns(sys.argv[1])
    if len(sys.argv) > 2:
        icns_png(sys.argv[1], sys.argv[2])
