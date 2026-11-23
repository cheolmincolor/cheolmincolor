# Copyright (c) 2026 GRAYZONE. All rights reserved.
"""실험용: 원본 영상을 복사하지 않고 '태그만 다른 모습'을 재생하기 위한 참조 파일(reference movie) 만들기.

참조 파일은 영상 데이터 없이 머리 정보(moov)만 가진 아주 작은 MOV 다.
  - 원본의 moov 를 그대로 가져오고
  - 영상 트랙의 색 표시(colr, gama)만 원하는 태그로 바꾸고
  - 모든 트랙의 데이터 위치(dref)를 '원본 파일'로 돌린다. 샘플 위치(stco)는 원본 파일 기준 그대로다.
원본 해상도·소리 그대로, 만드는 데 걸리는 시간은 moov 를 읽고 쓰는 시간뿐이다.

주의: 영상 스트림 안의 색 정보(ProRes 프레임 머리, H.264 VUI)는 바뀌지 않는다. 실제 저장본과 똑같이 보이는지는
실제 맥에서 확인해야 한다 (test/probe_refmovie.py).

사용: python3 refmovie.py 원본.mov 출력.mov 1-2-1
"""
import os
import struct
import sys
from urllib.parse import quote

CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"dinf", b"stbl"}
MAC_TAG, MAC_GAMMA = (1, 2, 1), 2.4


def _children(buf):
    """buf 안의 박스들을 (type, 본문) 으로."""
    pos, out = 0, []
    while pos + 8 <= len(buf):
        size, typ = struct.unpack(">I4s", buf[pos:pos + 8])
        hdr = 8
        if size == 1:
            size = struct.unpack(">Q", buf[pos + 8:pos + 16])[0]
            hdr = 16
        elif size == 0:
            size = len(buf) - pos
        if size < hdr or pos + size > len(buf) or typ == b"\0\0\0\0":  # 끝의 0 채움(MOV 샘플 설명 끝 표시)은 건너뜀
            break
        out.append((typ, buf[pos + hdr:pos + size]))
        pos += size
    return out


def _box(typ, body):
    return struct.pack(">I4s", len(body) + 8, typ) + body


def _find_moov(path):
    with open(path, "rb") as f:
        f.seek(0, 2)
        end = f.tell()
        pos = 0
        while pos + 8 <= end:
            f.seek(pos)
            size, typ = struct.unpack(">I4s", f.read(8))
            hdr = 8
            if size == 1:
                size = struct.unpack(">Q", f.read(8))[0]
                hdr = 16
            elif size == 0:
                size = end - pos
            if size < hdr:
                break
            if typ == b"moov":
                f.seek(pos + hdr)
                return f.read(size - hdr)
            pos += size
    raise ValueError("moov 를 찾지 못했습니다")


def _patch_video_entry(entry, tag):
    """영상 샘플 설명 하나: colr/gama 를 지우고 새로 넣음. 나머지 아톰은 그대로."""
    fixed, kids = entry[:78], _children(entry[78:])
    tail = b"".join(_box(t, b) for t, b in kids if t not in (b"colr", b"gama"))
    extra = b""
    if tuple(tag) == MAC_TAG:  # 저장본과 같은 순서: gama, colr
        extra += _box(b"gama", struct.pack(">I", int(round(MAC_GAMMA * 65536))))
    extra += _box(b"colr", b"nclc" + struct.pack(">HHH", *tag))
    # ffmpeg 저장본은 코덱 설정(avcC 등) 뒤에 gama·colr 를 두므로 같은 자리에: 기존 아톰들 뒤, 끝의 0 채움 앞
    return fixed + tail + extra


def _rebuild(buf, tag, url, state):
    out = b""
    for typ, body in _children(buf):
        if typ == b"trak":
            state = {"hdlr": None}
        if typ in CONTAINERS:
            body = _rebuild(body, tag, url, state)
        elif typ == b"hdlr" and state.get("hdlr") is None and len(body) >= 12 and body[4:8] in (b"mhlr", b"\0\0\0\0"):
            state["hdlr"] = body[8:12]  # mdia/hdlr: 트랙 종류 (MOV 의 minf/hdlr 는 'dhlr' 라 제외)
        elif typ == b"stsd" and state.get("hdlr") == b"vide":
            head, entries = body[:8], _children(body[8:])
            body = head + b"".join(_box(t, _patch_video_entry(b, tag)) for t, b in entries)
        elif typ == b"dref" and url is not None:
            # 데이터 위치를 원본 파일로: 'url ' 항목 (flags 0 = 다른 파일에 있음)
            entry = _box(b"url ", b"\0\0\0\0" + url.encode() + b"\0")
            body = b"\0\0\0\0" + struct.pack(">I", 1) + entry
        out += _box(typ, body)
    return out


def make_reference(src, dst, tag, moov_from=None, keep_dref=False):
    """moov_from: moov 를 다른 파일(애플이 쓴 참조 머리 파일)에서 가져올 때. keep_dref: 그 파일의 데이터 위치를 그대로 둘 때."""
    src = os.path.abspath(src)
    moov = _find_moov(moov_from or src)
    url = None if keep_dref else "file://" + quote(src)
    new = _rebuild(moov, tag, url, {"hdlr": None})
    with open(dst, "wb") as f:
        f.write(_box(b"ftyp", b"qt  " + struct.pack(">I", 0x200) + b"qt  "))
        f.write(_box(b"moov", new))
    return dst


if __name__ == "__main__":
    make_reference(sys.argv[1], sys.argv[2], tuple(int(x) for x in sys.argv[3].split("-")))
    print(sys.argv[2], os.path.getsize(sys.argv[2]), "bytes")
