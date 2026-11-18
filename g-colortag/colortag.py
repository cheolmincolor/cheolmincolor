#!/usr/bin/env python3
# Copyright (c) 2026 GRAYZONE. All rights reserved.
"""Rec.709 색 태그(NCLC) 변환기 — 1-1-1 ↔ 1-2-1 (재인코딩 없음)

태그 = 원색(primaries)-전달특성(transfer)-행렬(matrix)
  1-1-1 : 일반 Rec709 (맥 퀵타임에서는 밝고 옅게 보일 수 있음)
  1-2-1 : 맥 퀵타임에서 정확하게 보이는 Rec709 = 1-2-1 태그 + 감마 2.4 표시(gama 아톰, MOV 전용)
          실제 맥(macOS 26) 측정: 1-2-1 만으로는 퀵타임 밝기가 1-1-1 과 같고, gama 2.4 가 있어야
          감마 2.4 모니터와 같은 밝기로 보인다. 그래서 1-2-1 로 저장할 땐 항상 MOV 로 저장한다.
  두 파일의 픽셀 밝기는 같다. 태그만 바꿔 플레이어 문제를 해결한다.

사용법:
  python3 colortag.py show 영상.mov ...            현재 태그 보기
  python3 colortag.py 1-2-1 영상.mov ...           변환 → 영상_1-2-1.mov 로 저장
  python3 colortag.py 1-1-1 영상.mov ... --overwrite   원본에 바로 덮어쓰기
"""
import os
import re
import struct
import subprocess
import sys
import tempfile
import threading

# 영상 스트림 안의 색 정보까지 바꾸는 ffmpeg 비트스트림 필터 (코덱 FourCC 기준)
H264 = {"avc1", "avc3"}
HEVC = {"hvc1", "hev1"}
PRORES = {"apco", "apcs", "apcn", "apch", "ap4h", "ap4x"}
CONTAINERS = {"moov", "trak", "mdia", "minf", "stbl"}
MAC_TAG, MAC_GAMMA = (1, 2, 1), 2.4  # 맥 퀵타임용: 1-2-1 + gama 2.4


def needs_gama(tag):
    return tuple(tag) == MAC_TAG


# ---------------- 읽기: colr 아톰 직접 파싱 ----------------
def _boxes(f, start, end):
    """[start, end) 구간의 박스들을 (type, 본문시작, 박스끝) 으로 순회."""
    pos = start
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
        yield typ.decode("latin-1"), pos + hdr, pos + size
        pos += size


def read_tracks(path):
    """영상 트랙별 [{codec, colr, tag:(p,t,m) 또는 None}] 반환. (MOV/MP4)"""
    tracks = []
    with open(path, "rb") as f:
        f.seek(0, 2)
        size = f.tell()

        handler = [None]  # 현재 트랙 종류 ('vide' = 영상)

        def walk(start, end, parent=""):
            for typ, body, box_end in _boxes(f, start, end):
                if typ == "trak":
                    handler[0] = None
                if typ in CONTAINERS:
                    walk(body, box_end, typ)
                elif typ == "hdlr" and parent == "mdia":  # MOV의 minf/hdlr(데이터 참조)는 무시
                    f.seek(body + 8)
                    handler[0] = f.read(4).decode("latin-1")
                elif typ == "stsd" and handler[0] == "vide":
                    f.seek(body + 4)
                    count = struct.unpack(">I", f.read(4))[0]
                    for i, (codec, ebody, eend) in enumerate(_boxes(f, body + 8, box_end)):
                        if i >= count:
                            break
                        _sample_entry(f, codec, ebody, eend)

        def _sample_entry(f, codec, ebody, eend):
            info = {"codec": codec, "colr": None, "tag": None, "offset": None, "gamma": None}
            # 영상 샘플 엔트리 고정 필드 78바이트 뒤에 자식 박스들
            for typ, body, _ in _boxes(f, ebody + 78, eend):
                if typ == "colr":
                    f.seek(body)
                    kind = f.read(4).decode("latin-1")
                    if kind in ("nclc", "nclx"):
                        info["colr"] = kind
                        info["tag"] = struct.unpack(">HHH", f.read(6))
                        info["offset"] = body + 4
                elif typ == "gama":  # 감마 표시 (16.16 고정소수)
                    f.seek(body)
                    info["gamma"] = round(struct.unpack(">I", f.read(4))[0] / 65536, 3)
            tracks.append(info)

        walk(0, size)
    return tracks


def tag_str(tag):
    return "-".join(map(str, tag)) if tag else "없음"


# ---------------- 쓰기: ffmpeg 리먹스 (스트림 복사) ----------------
def convert(src, dst, tag, faststart=False, progress=None):
    """tag=(p,t,m). 컨테이너 colr 아톰 + 스트림 내부 색 정보 모두 변경."""
    p, t, m = tag
    tracks = read_tracks(src)
    if not tracks:
        raise ValueError("영상 트랙을 찾지 못했습니다 (MOV/MP4만 지원)")
    gama = needs_gama(tag)
    if gama and not dst.lower().endswith(".mov"):
        raise ValueError("1-2-1(맥 퀵타임용)은 MOV 로만 저장할 수 있습니다")
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", src, "-map", "0", "-c", "copy",
           "-map_metadata", "0", "-movflags", "+write_colr+write_gama" if gama else "+write_colr"]
    if gama:
        cmd += ["-mov_gamma", str(MAC_GAMMA)]
    for i, tr in enumerate(tracks):
        c = tr["codec"]
        if c in H264:
            bsf = f"h264_metadata=colour_primaries={p}:transfer_characteristics={t}:matrix_coefficients={m}"
        elif c in HEVC:
            bsf = f"hevc_metadata=colour_primaries={p}:transfer_characteristics={t}:matrix_coefficients={m}"
        elif c in PRORES:
            bsf = f"prores_metadata=color_primaries={p}:color_trc={t}:colorspace={m}"
        else:
            bsf = None
        if bsf:
            cmd += [f"-bsf:v:{i}", bsf]
        cmd += [f"-color_primaries:v:{i}", str(p), f"-color_trc:v:{i}", str(t), f"-colorspace:v:{i}", str(m),
                f"-tag:v:{i}", c]  # hvc1 등 원래 FourCC 유지 (맥 호환)
    if faststart:
        i = cmd.index("-movflags") + 1
        cmd[i] += "+faststart"
    cmd.append(dst)
    run_ffmpeg(cmd, progress, read_duration(src) if progress else None)
    return cmd


def run_ffmpeg(cmd, progress=None, duration=None):
    """ffmpeg 실행. progress(0~1) 콜백이 있으면 진행률을 알려줌."""
    if not progress or not duration:
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip() or "ffmpeg 실패")
        return
    cmd = cmd[:1] + ["-progress", "pipe:1", "-nostats"] + cmd[1:]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    err = []
    t = threading.Thread(target=lambda: err.append(p.stderr.read()))  # 막힘 방지
    t.start()
    for line in p.stdout:
        if line.startswith("out_time_us="):
            v = line.split("=", 1)[1].strip()
            if v.isdigit():
                progress(min(1.0, int(v) / 1e6 / duration))
    p.wait()
    t.join()
    if p.returncode != 0:
        raise RuntimeError((err[0] if err else "").strip() or "ffmpeg 실패")


def read_duration(path):
    """moov/mvhd 에서 길이(초). 못 읽으면 0."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            for typ, body, end in _boxes(f, 0, size):
                if typ != "moov":
                    continue
                for t2, b2, _ in _boxes(f, body, end):
                    if t2 == "mvhd":
                        f.seek(b2)
                        ver = f.read(1)[0]
                        f.seek(b2 + (20 if ver == 1 else 12))
                        if ver == 1:
                            scale, dur = struct.unpack(">IQ", f.read(12))
                        else:
                            scale, dur = struct.unpack(">II", f.read(8))
                        return dur / scale if scale else 0.0
    except (OSError, struct.error, IndexError):
        pass
    return 0.0


def output_path(src, tag):
    """1-2-1(맥 퀵타임용)은 감마 표시가 MOV 에만 들어가므로 항상 .mov"""
    """영상_1-2-1 → 영상_1-1-1 처럼 꼬리를 바꿔 달고, 원본·기존 파일과 겹치지 않는 이름."""
    base, ext = os.path.splitext(src)
    if needs_gama(tag):
        ext = ".mov"
    base = re.sub(r"_\d+-\d+-\d+$", "", base)
    dst, n = f"{base}_{tag_str(tag)}{ext}", 2
    while os.path.exists(dst) or os.path.abspath(dst) == os.path.abspath(src):
        dst, n = f"{base}_{tag_str(tag)} ({n}){ext}", n + 1
    return dst


def convert_file(src, tag, overwrite=False, progress=None):
    base, ext = os.path.splitext(src)
    if overwrite:
        fd, tmp = tempfile.mkstemp(suffix=ext, dir=os.path.dirname(os.path.abspath(src)))
        os.close(fd)
        try:
            convert(src, tmp, tag, progress=progress)
            os.replace(tmp, src)
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
        return src
    dst = output_path(src, tag)
    convert(src, dst, tag, progress=progress)
    return dst


def parse_tag(s):
    p, t, m = (int(x) for x in s.split("-"))
    return p, t, m


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 1
    cmd, files = argv[1], [a for a in argv[2:] if not a.startswith("--")]
    overwrite = "--overwrite" in argv
    if cmd == "show":
        for f in files:
            tr = read_tracks(f)
            print(f"{f}: " + (", ".join(f"{x['codec']} {tag_str(x['tag'])}" for x in tr) or "영상 트랙 없음"))
        return 0
    tag = parse_tag(cmd)
    for f in files:
        out = convert_file(f, tag, overwrite)
        print(f"{f} → {out}  [{', '.join(tag_str(x['tag']) for x in read_tracks(out))}]")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
