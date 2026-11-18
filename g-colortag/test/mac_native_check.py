# Copyright (c) 2026 GRAYZONE. All rights reserved.
"""실제 맥에서: 앱 안의 미리보기가 퀵타임 플레이어와 같은 밝기로 보이는지 확인.

1) 회색 막대 5개(Y=16·71·126·181·236) 영상을 1-1-1 로 만든다.
2) 앱 창을 실제로 띄워 미리보기를 정지 화면으로 둔 뒤, 앱 창을 캡처해 막대 밝기를 잰다.
3) 같은 미리보기 파일(1-1-1 / 1-2-1)을 퀵타임 플레이어로 열어 캡처해 막대 밝기를 잰다.
4) 앱의 1-1-1 ≈ 퀵타임 1-1-1, 앱의 1-2-1 ≈ 퀵타임 1-2-1 이고, 두 태그가 실제로 다르게 보이는지 확인.

사용: <앱>/Contents/MacOS/G-ColorTag-python -I -B test/mac_native_check.py <G-ColorTag.app> <출력 폴더>
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import traceback

APPDIR, OUT = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
RES = os.path.join(APPDIR, "Contents", "Resources")
sys.path[:0] = [RES, os.path.join(RES, "site")]
os.environ["PATH"] = os.path.join(RES, "bin") + ":/usr/bin:/bin:/usr/sbin"
os.makedirs(OUT, exist_ok=True)
import app  # noqa: E402

BARS = [16, 71, 126, 181, 236]
RESULT = {"ok": False, "steps": []}


def step(msg):
    print(msg, flush=True)
    RESULT["steps"].append(msg)


def make_video(path):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                    "nullsrc=s=1280x720:d=6:r=24,geq=lum='16+55*floor(X/256)':cb=128:cr=128,format=yuv420p",
                    "-c:v", "libx264", "-crf", "1", "-pix_fmt", "yuv420p",
                    "-color_primaries", "1", "-color_trc", "1", "-colorspace", "1", "-color_range", "tv", path], check=True)


def bars_in(img, box):
    """img: CGImage, box: (x, y, w, h) 픽셀 → 막대 5개의 평균 밝기(0~255, RGB 평균)."""
    import Quartz
    data = bytes(Quartz.CGDataProviderCopyData(Quartz.CGImageGetDataProvider(img)))
    bpr, bpp = Quartz.CGImageGetBytesPerRow(img), Quartz.CGImageGetBitsPerPixel(img) // 8
    alpha = Quartz.CGImageGetAlphaInfo(img)
    skip = 0 if alpha in (Quartz.kCGImageAlphaPremultipliedFirst, Quartz.kCGImageAlphaFirst,
                          Quartz.kCGImageAlphaNoneSkipFirst) else 3  # 알파 위치 (보통 BGRA → 3)
    order = Quartz.CGImageGetBitmapInfo(img) & Quartz.kCGBitmapByteOrderMask
    if order == Quartz.kCGBitmapByteOrder32Little:  # 메모리상 바이트 순서가 뒤집힘
        skip = 3 - skip if skip in (0, 3) else skip
    x, y, w, h = box
    vals = []
    for i in range(5):
        cx, cy = x + w * (i + 0.5) / 5, y + h * 0.5
        tot = n = 0
        for yy in range(int(cy - h * 0.08), int(cy + h * 0.08)):
            row = yy * bpr
            for xx in range(int(cx - w * 0.04), int(cx + w * 0.04), 2):
                o = row + xx * bpp
                px = data[o:o + bpp]
                tot += sum(px[k] for k in range(4) if k != skip) / 3
                n += 1
        vals.append(round(tot / max(n, 1), 1))
    return vals


def capture_window(number, path):
    """창 번호의 화면을 PNG 로 (그림자 제외)."""
    import Quartz
    img = Quartz.CGWindowListCreateImage(Quartz.CGRectNull, Quartz.kCGWindowListOptionIncludingWindow, number,
                                         Quartz.kCGWindowImageBoundsIgnoreFraming | Quartz.kCGWindowImageBestResolution)
    if img is None:
        raise RuntimeError("창 캡처 실패")
    url = Quartz.CFURLCreateWithFileSystemPath(None, path, Quartz.kCFURLPOSIXPathStyle, False)
    dest = Quartz.CGImageDestinationCreateWithURL(url, "public.png", 1, None)
    Quartz.CGImageDestinationAddImage(dest, img, None)
    Quartz.CGImageDestinationFinalize(dest)
    return img


def qt_capture(movie, name):
    """퀵타임 플레이어로 열어 창을 캡처하고 막대 밝기를 잼."""
    import Quartz
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
    if not win:
        raise RuntimeError("퀵타임 창을 찾지 못함")
    time.sleep(3)  # 첫 프레임이 그려지고 제목 막대가 사라질 시간
    path = os.path.join(OUT, f"qt_{name}.png")
    img = capture_window(win["kCGWindowNumber"], path)
    vals = bars_in(img, (0, 0, Quartz.CGImageGetWidth(img), Quartz.CGImageGetHeight(img)))  # 퀵타임 창 = 영상 크기, 가운데 줄에서 잼
    subprocess.run(["osascript", "-e", 'tell application "QuickTime Player" to close every document saving no'])
    time.sleep(1)
    return vals


def test():
    try:
        while app.WINDOW is None:
            time.sleep(0.1)
        app.WINDOW.events.loaded.wait(60)
        for _ in range(100):
            if app.NV_STATE != "pending":
                break
            time.sleep(0.2)
        step(f"네이티브 플레이어: {app.NV_STATE}")
        if app.NV_STATE != "on":
            raise RuntimeError("퀵타임 엔진 플레이어가 켜지지 않음")
        vdir = tempfile.mkdtemp()
        movie = os.path.join(vdir, "bars.mov")
        make_video(movie)
        app.CORE.add_paths([movie])
        js = app.WINDOW.evaluate_js
        for _ in range(120):
            if js("!document.querySelector('#playBtn').disabled"):
                break
            time.sleep(0.5)
        step("미리보기 준비: " + str(js("!document.querySelector('#playBtn').disabled")))
        js("document.querySelector('#playBtn').click()")
        time.sleep(1.5)
        js("document.querySelector('#playBtn').click()")  # 정지 (두 화면 같은 프레임)
        time.sleep(2)
        dbg = json.loads(js("JSON.stringify(GCT.player.debug())"))
        a = dbg["decks"][dbg["active"]]
        step(f"정지 위치: 1-2-1 {a['mac']['t']:.3f}s / 1-1-1 {a['std']['t']:.3f}s")
        rects = json.loads(js("JSON.stringify(['std','mac'].map(t => { const r = document.querySelector('.screen[data-tag=\"' + t + '\"]').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }))"))

        import Quartz
        from webview.platforms.cocoa import BrowserView
        nswin = BrowserView.instances[app.WINDOW.uid].window
        frame = nswin.frame()
        content = nswin.contentRectForFrameRect_(frame)
        path = os.path.join(OUT, "app.png")
        img = capture_window(nswin.windowNumber(), path)
        scale = Quartz.CGImageGetWidth(img) / frame.size.width
        top = (frame.size.height - content.size.height) * scale  # 제목 막대 높이
        app_vals = {}
        for tag, (x, y, w, h) in zip(("std", "mac"), rects):
            app_vals[tag] = bars_in(img, (x * scale, top + y * scale, w * scale, h * scale))
        step(f"앱 1-1-1 막대 밝기: {app_vals['std']}")
        step(f"앱 1-2-1 막대 밝기: {app_vals['mac']}")

        key = sorted(app.CORE.previews.jobs)[0]
        qt = {}
        for tag in ("std", "mac"):
            try:
                qt[tag] = qt_capture(app.CORE.previews.path(key, tag), tag)
                step(f"퀵타임 {'1-1-1' if tag == 'std' else '1-2-1'} 막대 밝기: {qt[tag]}")
            except Exception as e:
                step(f"퀵타임 캡처 실패 ({tag}): {e}")
        diff_tags = max(abs(x - y) for x, y in zip(app_vals["std"], app_vals["mac"]))
        step(f"앱에서 1-1-1 과 1-2-1 의 최대 밝기 차이: {diff_tags:.1f}")
        RESULT.update(app=app_vals, quicktime=qt, tag_difference=diff_tags)
        checks = [("앱에서 두 태그가 다르게 보임", diff_tags >= 3)]
        if len(qt) == 2:
            for tag in ("std", "mac"):
                d = max(abs(x - y) for x, y in zip(app_vals[tag], qt[tag]))
                RESULT[f"app_vs_qt_{tag}"] = d
                checks.append((f"앱 {tag} ≈ 퀵타임 {tag} (최대 차이 {d:.1f})", d <= 4))
        RESULT["checks"] = checks
        RESULT["ok"] = all(c[1] for c in checks)
        for name, good in checks:
            step(("✅ " if good else "❌ ") + name)
    except Exception:
        step("오류: " + traceback.format_exc())
    finally:
        json.dump(RESULT, open(os.path.join(OUT, "result.json"), "w"), ensure_ascii=False, indent=2)
        app.WINDOW.destroy()


root = tempfile.mkdtemp(prefix="gcolortag-")
srv, url = app.start_server(root)
threading.Thread(target=test, daemon=True).start()
app.run_window(url)
sys.exit(0 if RESULT["ok"] else 1)
