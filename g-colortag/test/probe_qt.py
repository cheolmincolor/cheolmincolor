# Copyright (c) 2026 GRAYZONE. All rights reserved.
"""실험: 퀵타임 플레이어가 태그 방식별로 밝기를 어떻게 보여주는지 실제 맥에서 잰다.

회색 막대 5개(Y=16·71·126·181·236) 영상을 여러 가지 태그로 만들어 퀵타임으로 열고,
창을 캡처해 막대 밝기를 잰다. 결과는 표와 result.json, 캡처 PNG 로 남긴다.
사용: python3 probe_qt.py <출력 폴더>   (ffmpeg, pyobjc-framework-Quartz 필요)
"""
import json
import os
import subprocess
import sys
import time

OUT = os.path.abspath(sys.argv[1])
os.makedirs(OUT, exist_ok=True)
import Quartz  # noqa: E402

SRC = "nullsrc=s=1280x720:d=4:r=24,geq=lum='16+55*floor(X/256)':cb=128:cr=128,format=yuv420p"


def ff(*a):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *a], check=True)


def h264(path, p, t, m, extra=()):
    ff("-f", "lavfi", "-i", SRC, "-c:v", "libx264", "-crf", "1", "-pix_fmt", "yuv420p",
       "-color_primaries", str(p), "-color_trc", str(t), "-colorspace", str(m), *extra, path)


def retag(src, dst, p, t, m, codec="h264", stream=True, extra=()):
    bsf = []
    if stream and codec == "h264":
        bsf = ["-bsf:v", f"h264_metadata=colour_primaries={p}:transfer_characteristics={t}:matrix_coefficients={m}"]
    if stream and codec == "prores":
        bsf = ["-bsf:v", f"prores_metadata=color_primaries={p}:color_trc={t}:colorspace={m}"]
    ff("-i", src, "-c", "copy", *bsf, "-color_primaries", str(p), "-color_trc", str(t), "-colorspace", str(m),
       "-movflags", "+write_colr", *extra, dst)


def capture(number, path):
    img = Quartz.CGWindowListCreateImage(Quartz.CGRectNull, Quartz.kCGWindowListOptionIncludingWindow, number,
                                         Quartz.kCGWindowImageBoundsIgnoreFraming | Quartz.kCGWindowImageBestResolution)
    url = Quartz.CFURLCreateWithFileSystemPath(None, path, Quartz.kCFURLPOSIXPathStyle, False)
    d = Quartz.CGImageDestinationCreateWithURL(url, "public.png", 1, None)
    Quartz.CGImageDestinationAddImage(d, img, None)
    Quartz.CGImageDestinationFinalize(d)
    return img


def bars(img):
    data = bytes(Quartz.CGDataProviderCopyData(Quartz.CGImageGetDataProvider(img)))
    bpr, bpp = Quartz.CGImageGetBytesPerRow(img), Quartz.CGImageGetBitsPerPixel(img) // 8
    w, h = Quartz.CGImageGetWidth(img), Quartz.CGImageGetHeight(img)
    alpha = Quartz.CGImageGetAlphaInfo(img)
    skip = 0 if alpha in (Quartz.kCGImageAlphaPremultipliedFirst, Quartz.kCGImageAlphaFirst, Quartz.kCGImageAlphaNoneSkipFirst) else 3
    if Quartz.CGImageGetBitmapInfo(img) & Quartz.kCGBitmapByteOrderMask == Quartz.kCGBitmapByteOrder32Little:
        skip = 3 - skip
    out = []
    for i in range(5):
        cx, cy = w * (i + 0.5) / 5, h * 0.5
        tot = n = 0
        for yy in range(int(cy - h * 0.06), int(cy + h * 0.06), 2):
            for xx in range(int(cx - w * 0.03), int(cx + w * 0.03), 2):
                o = yy * bpr + xx * bpp
                tot += sum(data[o + k] for k in range(4) if k != skip) / 3
                n += 1
        out.append(round(tot / n, 1))
    return out


def qt(movie, name):
    subprocess.run(["open", "-a", "QuickTime Player", movie], check=True)
    win = None
    for _ in range(60):
        time.sleep(0.5)
        for w in Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID) or []:
            if w.get("kCGWindowOwnerName") == "QuickTime Player" and w.get("kCGWindowLayer") == 0 \
                    and float(w["kCGWindowBounds"]["Width"]) > 300:
                win = w
        if win:
            break
    time.sleep(3)
    vals = bars(capture(win["kCGWindowNumber"], os.path.join(OUT, name + ".png"))) if win else None
    subprocess.run(["killall", "QuickTime Player"], capture_output=True)
    time.sleep(1.5)
    return vals


def fd_info(path):
    """퀵타임 '동영상 속성'이 보여주는 색 정보 = AVFoundation 포맷 설명의 색 확장값."""
    try:
        import AVFoundation as AV
        import CoreMedia as CM
        from Foundation import NSURL
        asset = AV.AVURLAsset.URLAssetWithURL_options_(NSURL.fileURLWithPath_(path), None)
        tr = asset.tracksWithMediaType_(AV.AVMediaTypeVideo)[0]
        ext = CM.CMFormatDescriptionGetExtensions(tr.formatDescriptions()[0]) or {}
        short = lambda v: str(v).replace("ITU_R_", "").replace("_2", "") if v is not None else "-"  # noqa: E731
        return (f"원색={short(ext.get('CVImageBufferColorPrimaries'))} 전송={short(ext.get('CVImageBufferTransferFunction'))} "
                f"행렬={short(ext.get('CVImageBufferYCbCrMatrix'))} 감마={ext.get('CVImageBufferGammaLevel', '-')} "
                f"비트={ext.get('BitsPerComponent', '-')}")
    except Exception as e:
        return f"읽기 실패 {e}"


def tags(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=codec_name,color_primaries,color_transfer,color_space", "-of", "csv=p=0", path],
                       capture_output=True, text=True)
    return r.stdout.strip()


V = os.path.join(OUT, "videos")
os.makedirs(V, exist_ok=True)
j = lambda n: os.path.join(V, n)  # noqa: E731
h264(j("h264_111.mov"), 1, 1, 1)
retag(j("h264_111.mov"), j("h264_121.mov"), 1, 2, 1)                       # 이 앱의 1-2-1 (컨테이너+스트림)
retag(j("h264_111.mov"), j("h264_121_colr_only.mov"), 1, 2, 1, stream=False)  # 컨테이너만
h264(j("h264_222_notag.mov"), 2, 2, 2)                                      # 태그 없음
retag(j("h264_111.mov"), j("h264_121_gama22.mov"), 1, 2, 1, extra=("-movflags", "+write_colr+write_gama", "-mov_gamma", "2.2"))
retag(j("h264_111.mov"), j("h264_121_gama24.mov"), 1, 2, 1, extra=("-movflags", "+write_colr+write_gama", "-mov_gamma", "2.4"))
retag(j("h264_111.mov"), j("h264_1131_srgb.mov"), 1, 13, 1)                # 전달특성 sRGB
retag(j("h264_111.mov"), j("h264_141_g22.mov"), 1, 4, 1)                   # 전달특성 감마 2.2
ff("-f", "lavfi", "-i", SRC, "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le",
   "-color_primaries", "1", "-color_trc", "1", "-colorspace", "1", j("prores_111.mov"))
retag(j("prores_111.mov"), j("prores_121.mov"), 1, 2, 1, codec="prores")
retag(j("prores_111.mov"), j("prores_121_gama24.mov"), 1, 2, 1, codec="prores", extra=("-movflags", "+write_colr+write_gama", "-mov_gamma", "2.4"))
ff("-f", "lavfi", "-i", SRC, "-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuv444p12le",
   "-color_primaries", "1", "-color_trc", "1", "-colorspace", "1", j("prores4444_111.mov"))
retag(j("prores4444_111.mov"), j("prores4444_121.mov"), 1, 2, 1, codec="prores")
retag(j("prores4444_111.mov"), j("prores4444_121_gama24.mov"), 1, 2, 1, codec="prores", extra=("-movflags", "+write_colr+write_gama", "-mov_gamma", "2.4"))
ff("-f", "lavfi", "-i", SRC, "-c:v", "libx264", "-crf", "1", "-pix_fmt", "yuv420p",
   "-color_primaries", "1", "-color_trc", "1", "-colorspace", "1", j("h264_111.mp4"))
retag(j("h264_111.mp4"), j("h264_121.mp4"), 1, 2, 1)

res = {"macos": subprocess.run(["sw_vers", "-productVersion"], capture_output=True, text=True).stdout.strip(), "rows": []}
print(f"macOS {res['macos']}  (기대값 참고: 그대로 표시 0·64·128·191·255 / 1.96→2.2 변환 0·73·139·199·255)")
for name in sorted(os.listdir(V)):
    vals = qt(j(name), name)
    info = fd_info(j(name))
    res["rows"].append({"file": name, "tags": tags(j(name)), "quicktime": vals, "inspector": info})
    print(f"{name:28} 퀵타임 막대 밝기 {vals} | 속성: {info}", flush=True)
json.dump(res, open(os.path.join(OUT, "result.json"), "w"), ensure_ascii=False, indent=2)
