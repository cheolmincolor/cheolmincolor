# Copyright (c) 2026 GRAYZONE. All rights reserved.
"""진단: 퀵타임(AVFoundation)이 영상 파일에서 받는 색 정보를 통째로 출력.

- 포맷 설명 확장값 전체 (SampleDescriptionExtensionAtoms 안의 colr 원본 바이트 포함)
- 컨테이너 colr 과 ProRes 프레임 헤더 값을 일부러 다르게 만든 파일로, 퀵타임이 어느 쪽을 읽는지 확인
사용: <앱>/Contents/MacOS/G-Retag-python -I -B test/mac_tag_dump.py <G-Retag.app> <출력 폴더>
"""
import os
import subprocess
import sys

APPDIR, OUT = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
RES = os.path.join(APPDIR, "Contents", "Resources")
sys.path[:0] = [RES, os.path.join(RES, "site")]
os.environ["PATH"] = os.path.join(RES, "bin") + ":/usr/bin:/bin:/usr/sbin"
os.makedirs(OUT, exist_ok=True)
import AVFoundation as AV  # noqa: E402
import CoreMedia as CM  # noqa: E402
from Foundation import NSURL  # noqa: E402

import colortag as ct  # noqa: E402

SRC = "nullsrc=s=1280x720:d=1:r=24,geq=lum='16+55*floor(X/256)':cb=128:cr=128,format=yuv422p10le"


def ff(*a):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *a], check=True)


def header(path):
    data = open(path, "rb").read()
    i = data.find(b"icpf")
    if i < 0:
        return "-"
    h = data[i + 4:i + 24]
    return f"creator={h[4:8].decode('latin-1')} 원색={h[14]} 전송={h[15]} 행렬={h[16]}"


def dump(path):
    asset = AV.AVURLAsset.URLAssetWithURL_options_(NSURL.fileURLWithPath_(path), None)
    fd = asset.tracksWithMediaType_(AV.AVMediaTypeVideo)[0].formatDescriptions()[0]
    e = CM.CMFormatDescriptionGetExtensions(fd) or {}
    print(f"■ {os.path.basename(path)}\n   컨테이너 {ct.describe(path)} | ProRes 헤더 {header(path)}")
    print("   모든 키:", sorted(str(k) for k in e.keys()))
    for k in sorted(e.keys()):
        v = e[k]
        if k == "SampleDescriptionExtensionAtoms":
            print("   SampleDescriptionExtensionAtoms:", {kk: bytes(vv).hex() if hasattr(vv, "bytes") or isinstance(vv, (bytes, bytearray)) else str(vv) for kk, vv in v.items()})
        elif k.startswith("CVImageBuffer") or k in ("FormatName", "Depth", "BitsPerComponent", "FullRangeVideo"):
            print(f"   {k} = {v}")
    print(f"   앱 판정: ({__import__('qtplayer').quicktime_code(path)})")


def prores(path, p, t, m):
    ff("-f", "lavfi", "-i", SRC, "-c:v", "prores_ks", "-profile:v", "1",
       "-color_primaries", str(p), "-color_trc", str(t), "-colorspace", str(m), path)


def retag(src, dst, colr, head):
    """컨테이너 colr 과 ProRes 헤더를 따로 지정."""
    (p, t, m), (hp, ht, hm) = colr, head
    try:
        _retag(src, dst, p, t, m, hp, ht, hm)
    except Exception as ex:
        print("만들기 실패", os.path.basename(dst), ex)


def _retag(src, dst, p, t, m, hp, ht, hm):
    ff("-i", src, "-c", "copy", "-bsf:v", f"prores_metadata=color_primaries={hp}:color_trc={ht}:colorspace={hm}",
       "-color_primaries", str(p), "-color_trc", str(t), "-colorspace", str(m), "-movflags", "+write_colr", dst)


j = lambda n: os.path.join(OUT, n)  # noqa: E731
prores(j("a_111.mov"), 1, 1, 1)
r = subprocess.run(["avconvert", "-s", j("a_111.mov"), "-o", j("b_apple_lt.mov"), "-p", "PresetAppleProRes422LPCM", "--replace"],
                   capture_output=True, text=True)
retag(j("a_111.mov"), j("c_colr121_head121.mov"), (1, 2, 1), (1, 2, 1))   # 지금 앱이 만드는 것
retag(j("a_111.mov"), j("d_colr121_head111.mov"), (1, 2, 1), (1, 1, 1))   # 컨테이너만 1-2-1
retag(j("a_111.mov"), j("e_colr111_head121.mov"), (1, 1, 1), (1, 2, 1))   # 헤더만 1-2-1
retag(j("a_111.mov"), j("f_colr616_head111.mov"), (6, 1, 6), (1, 1, 1))   # 어느 쪽을 읽는지 구분용
retag(j("a_111.mov"), j("g_colr111_head616.mov"), (1, 1, 1), (6, 1, 6))
retag(j("a_111.mov"), j("h_colr121_head101.mov"), (1, 2, 1), (1, 0, 1))   # 헤더 전송 0(알 수 없음)
retag(j("a_111.mov"), j("i_colr101_head101.mov"), (1, 0, 1), (1, 0, 1))
def patch_colr(src, dst, kind, vals, full=None):
    """colr 아톰을 바이트 단위로 바꿔 씀 (같은 길이일 때만: nclc 18B ↔ nclx 19B 는 길이가 달라 별도 처리)."""
    import shutil, struct
    shutil.copy(src, dst)
    data = bytearray(open(dst, "rb").read())
    i = data.find(b"colrnclc")
    if kind == "nclc":
        data[i + 8:i + 14] = struct.pack(">HHH", *vals)
    open(dst, "wb").write(bytes(data))


for nm, head in (("m_nocolr_head121.mov", (1, 2, 1)), ("n_nocolr_head111.mov", (1, 1, 1)), ("o_nocolr_head222.mov", (2, 2, 2))):
    try:  # 컨테이너 colr 없이 ProRes 헤더만
        ff("-i", j("a_111.mov"), "-c", "copy", "-bsf:v", "prores_metadata=color_primaries=%d:color_trc=%d:colorspace=%d" % head,
           "-movflags", "-write_colr", j(nm))
    except Exception as ex:
        print("만들기 실패", nm, ex)
for t in (0, 3, 255):
    patch_colr(j("c_colr121_head121.mov"), j(f"k_colr1{t}1_patched.mov"), "nclc", (1, t, 1))
try:  # MP4 식 nclx (전체 범위 표시 포함) 를 MOV 에
    ff("-i", j("a_111.mov"), "-c", "copy", "-color_primaries", "1", "-color_trc", "2", "-colorspace", "1",
       "-movflags", "+write_colr", "-f", "mp4", j("l_mp4_nclx121.mp4"))
except Exception as ex:
    print("nclx 만들기 실패", ex)
if os.path.exists(j("b_apple_lt.mov")):
    ct.convert_file(j("b_apple_lt.mov"), (1, 2, 1))  # 애플 ProRes → 앱 변환
for n in sorted(os.listdir(OUT)):
    if n.endswith(".mov"):
        try:
            dump(j(n))
        except Exception as ex:
            print("■", n, "읽기 실패", ex)
