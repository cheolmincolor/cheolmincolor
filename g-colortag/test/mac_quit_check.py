# Copyright (c) 2026 GRAYZONE. All rights reserved.
"""실제 맥에서: 앱을 켜고 메인 화면이 뜬 1초 뒤에 끄면, 얼마 만에 완전히 끝나는지.

사용자가 ⌘Q 를 누를 때와 같은 종료 요청(NSRunningApplication.terminate)을 보내고
  창이 사라질 때까지 / 앱 프로세스가 끝날 때까지
걸린 시간을 잰다. '확인' 대상 앱은 3초 안에 끝나야 통과, '비교' 대상은 기록만 한다.

사용: <앱>/Contents/MacOS/G-Retag-python -I -B test/mac_quit_check.py 확인:<G-Retag.app> [비교:<예전 G-Retag.app>] ...
"""
import os
import subprocess
import sys
import time

APP0 = os.path.abspath(sys.argv[1].split(":", 1)[1])
sys.path[:0] = [os.path.join(APP0, "Contents", "Resources", "site")]
import AppKit  # noqa: E402
import Quartz  # noqa: E402


def running(app):
    """macOS 가 아는 '실행 중인 앱' 가운데 이 경로의 G-Retag (이름 검색이 아니라 번들 경로로 정확히)."""
    want = os.path.realpath(app)
    for ra in AppKit.NSRunningApplication.runningApplicationsWithBundleIdentifier_("local.colortag") or []:
        url = ra.bundleURL()
        if url is not None and os.path.realpath(str(url.path())) == want and not ra.isTerminated():
            return ra
    return None


LOG = os.path.expanduser("~/Library/Logs/G-Retag.log")


def main_window(pid):
    for w in Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID) or []:
        if w.get("kCGWindowOwnerPID") == pid and w.get("kCGWindowLayer") == 0 and w["kCGWindowBounds"]["Width"] >= 1000:
            return w
    return None


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    r = subprocess.run(["/bin/ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
    return not r.stdout.strip().startswith("Z")


def run(app, rounds=3):
    out = []
    for n in range(rounds):
        subprocess.run(["pkill", "-f", "Contents/Resources/app.py"], capture_output=True)
        time.sleep(1.5)
        open(LOG, "w").close()
        t0 = time.time()
        subprocess.run(["open", "-n", app], check=True)
        ra = pid = win = None
        while time.time() - t0 < 60 and not win:
            ra = ra or running(app)
            pid = ra.processIdentifier() if ra else None
            win = pid and main_window(pid)
            time.sleep(0.05)
        if not win:
            out.append((None, None, "메인 화면이 60초 안에 뜨지 않음 · 기록: " + open(LOG).read()[-400:].replace("\n", " | ")))
            continue
        shown = time.time() - t0
        time.sleep(1.0)  # 화면이 뜬 직후에 끄기
        tq = time.time()
        cmd = subprocess.run(["/bin/ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        ok = bool(ra.terminate())
        t_win = t_exit = None
        while time.time() - tq < 40:
            now = time.time() - tq
            if t_win is None and not main_window(pid):
                t_win = now
            if not alive(pid):
                t_exit = now
                break
            time.sleep(0.05)
        if t_exit is None:
            subprocess.run(["kill", "-9", str(pid)], capture_output=True)
        logtxt = " | ".join(x.strip() for x in open(LOG).read().splitlines() if x.strip())[-500:]
        out.append((t_win, t_exit, f"켠 뒤 {shown:.1f}초에 메인 화면, 종료 요청 {'전달' if ok else '실패'}, "
                                   f"프로세스 {pid} {os.path.basename(cmd.split()[-1]) if cmd else '?'}\n        기록: {logtxt}"))
    return out


bad = 0
for arg in sys.argv[1:]:
    kind, app = arg.split(":", 1)
    app = os.path.abspath(app)
    ver = subprocess.run(["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleShortVersionString",
                          os.path.join(app, "Contents", "Info.plist")], capture_output=True, text=True).stdout.strip()
    print(f"■ {kind} 대상 v{ver}", flush=True)
    for i, (tw, te, note) in enumerate(run(app), 1):
        good = te is not None and te <= 3.0
        if kind == "확인":
            bad += not good
        fmt = lambda x: "40초 넘음" if x is None else f"{x:.2f}초"  # noqa: E731
        mark = ("✅" if good else "❌") if kind == "확인" else "·"
        print(f"   {mark} {i}회: 창이 사라지기까지 {fmt(tw)}, 앱이 완전히 끝나기까지 {fmt(te)} ({note})", flush=True)
subprocess.run(["pkill", "-f", "Contents/Resources/app.py"], capture_output=True)
print("결과:", "모두 3초 안에 종료 ✅" if not bad else f"{bad}회 늦게 종료 ❌")
sys.exit(1 if bad else 0)
