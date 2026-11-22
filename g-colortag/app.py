#!/usr/bin/env python3
# Copyright (c) 2026 GRAYZONE. All rights reserved.
"""G-Retag for QuickTime — 영상의 Rec709 색 태그를 다시 붙이는 맥용 앱. (예전 이름 G-ColorTag)

  Rec709 1-1-1  General           : 일반 Rec709
  Rec709 1-2-1  For Mac QuickTime : 맥 퀵타임에서 정확하게 보이는 Rec709 (1-2-1 + 감마 2.4 표시, MOV)
  두 파일의 픽셀 밝기는 같고, 플레이어(맥 퀵타임)에서 밝기가 다르게 보이는 문제를 해결하기 위한 것.

화면은 HTML(web/index.html)이고, 맥에서는 WKWebView 창(pywebview)으로 띄운다.
미리보기 영상은 맥 자체 영상 엔진(WebKit/AVFoundation)이 재생하므로 태그 차이가 그대로 보인다.

실행:  python3 app.py            창으로 실행
       python3 app.py --serve    창 없이 서버만 (테스트용, 주소를 출력)
"""
import json
import os
import plistlib
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "site"))  # 앱에 포함된 pywebview / PyObjC
sys.path.insert(0, HERE)
import colortag as ct  # noqa: E402
import updater  # noqa: E402
import qtplayer  # noqa: E402

APP_NAME = "G-Retag"
APP_SUBTITLE = "for QuickTime"
APP_VERSION = "3.9.0"


def build_year():
    """저작권 연도: 코드에 적지 않고 빌드 날짜에서 읽음 (번들의 GZBuildDate, 번들 밖에서는 이 파일의 날짜)."""
    try:
        import plistlib as _pl
        with open(os.path.join(HERE, "..", "Info.plist"), "rb") as f:
            return str(_pl.load(f)["GZBuildDate"])[:4]
    except Exception:
        return time.strftime("%Y", time.localtime(os.path.getmtime(__file__)))


COPYRIGHT = f"© {build_year()} GRAY ZONE. All rights reserved."
TAGS = {"mac": (1, 2, 1), "std": (1, 1, 1)}
SEG = 10.0          # 미리보기 구간 길이(초)
PREVIEW_H = 720     # 미리보기 최대 세로 해상도
MAX_PENDING = 4     # 대기 중인 미리보기 작업 최대 개수
INDEX = os.path.join(HERE, "web", "index.html")
VIDEO_EXT = (".mov", ".mp4", ".m4v")
PREFS = os.path.expanduser(os.environ.get("GCT_PREFS", "~/Library/Application Support/G-Retag/prefs.json"))


def load_prefs():
    try:
        with open(PREFS, encoding="utf-8") as f:
            p = json.load(f)
        return p if isinstance(p, dict) else {}
    except Exception:
        return {}


def save_prefs(p):
    try:
        os.makedirs(os.path.dirname(PREFS), exist_ok=True)
        tmp = PREFS + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(p, f, ensure_ascii=False)
        os.replace(tmp, PREFS)
    except Exception as e:
        log("prefs save failed:", e)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


class ApiError(Exception):
    pass


def expand_paths(paths, limit=500):
    """파일은 그대로, 폴더는 안의 MOV·MP4 를 찾아 넣음 (숨김 파일 제외)."""
    out = []
    for p in paths:
        p = os.path.abspath(os.path.expanduser(str(p)))
        if os.path.isdir(p):
            for d, dirs, files in os.walk(p):
                dirs[:] = sorted(x for x in dirs if not x.startswith("."))
                out += [os.path.join(d, f) for f in sorted(files)
                        if f.lower().endswith(VIDEO_EXT) and not f.startswith(".")]
                if len(out) >= limit:
                    break
        else:
            out.append(p)
    return out[:limit]


def on_drop(event):
    """창에 끌어다 놓은 파일·폴더 (pywebview 가 실제 경로를 알려줌)."""
    files = (event.get("dataTransfer") or {}).get("files") or []
    paths = [f.get("pywebviewFullPath") for f in files if f.get("pywebviewFullPath")]
    if paths:
        CORE.add_paths(paths)


def register_dnd():
    try:
        from webview.dom import DOMEventHandler
        WINDOW.dom.document.events.drop += DOMEventHandler(on_drop, True, True)
        CORE.dnd = True
    except Exception:
        log("drag and drop off:", traceback.format_exc())


class AppError(RuntimeError):
    """이 앱이 직접 쓴, 사용자에게 그대로 보여 줄 우리말 문구."""


def friendly(e, doing):
    """ffmpeg 등의 영어 오류 원문 대신, 원인과 할 일을 우리말로. 원문은 기록 파일에만 남김.

    파일 이름·경로에 한글이 있어도 원문이 새어 나가지 않게, 원문 패턴을 먼저 본다.
    그대로 보여 주는 것은 이 앱이 직접 쓴 문구(AppError, colortag 의 ValueError)뿐이다.
    """
    raw = str(e).strip()
    low = raw.lower()
    if isinstance(e, FileNotFoundError) or "no such file" in low:
        return "파일을 찾을 수 없어요. 옮기거나 지우지 않았는지, 외장 디스크가 연결되어 있는지 확인해 주세요."
    if isinstance(e, PermissionError) or "permission denied" in low or "read-only" in low or "operation not permitted" in low:
        return "이 폴더에는 저장할 수 없어요. 폴더의 쓰기 권한을 확인하거나 영상을 다른 폴더로 옮겨 주세요."
    if "no space left" in low:
        return "저장할 공간이 부족해요. 디스크를 비운 뒤 다시 저장해 주세요."
    if isinstance(e, (AppError, ValueError)) and re.search(r"[가-힣]", raw):
        return raw.splitlines()[-1][:160]
    if doing == "save":
        return "저장하지 못했어요. 파일이 깨졌거나 복사가 덜 끝났을 수 있어요. 계속되면 기록 파일을 보내 주세요."
    return "영상을 읽지 못했어요. 파일이 깨졌거나 복사가 덜 끝났을 수 있어요."


def check_709(tag):
    """Rec.709 계열인지. (변환해도 되는 영상인지)"""
    if tag is None:
        return True, ""
    p, t, m = tag
    if p in (1, 2) and m in (1, 2) and t not in (16, 18):
        return True, ""
    return False, "HDR 등 다른 방식의 영상이라 저장에서 제외됩니다"


# ---------------------------------------------------------------- 미리보기
class Previews:
    """구간(SEG초)별로 1-1-1(std)과 1-2-1(mac) 미리보기 한 쌍을 만든다.

    1) 원본 구간을 720p H.264 로 한 번 인코딩하면서 1-1-1 태그를 붙이고
    2) 그 파일을 스트림 복사로 1-2-1 로만 바꾼다 → 두 파일은 픽셀이 완전히 같고 태그만 다르다.
    """

    def __init__(self, root, files):
        self.root, self.files = root, files
        self.jobs, self.pending = {}, []
        self.cv = threading.Condition()
        threading.Thread(target=self._worker, daemon=True).start()

    def request(self, fid, seg):
        key = f"{fid}_{seg}"
        with self.cv:
            job = self.jobs.get(key)
            if job is None:
                job = self.jobs[key] = {"state": "queued", "fid": fid, "seg": seg}
            if job["state"] == "queued":  # 최근 요청을 먼저 처리
                if key in self.pending:
                    self.pending.remove(key)
                self.pending.append(key)
                while len(self.pending) > MAX_PENDING:  # 오래된 대기 작업은 버림 (다시 요청하면 재등록)
                    self.jobs.pop(self.pending.pop(0), None)
                self.cv.notify()
            return self.public(key, job)

    def public(self, key, job):
        out = {"state": job["state"]}
        if job["state"] == "done":
            out.update(start=job["start"], dur=job["dur"],
                       mac=f"/media/{key}/mac?t={TOKEN}", std=f"/media/{key}/std?t={TOKEN}")
        elif job["state"] == "error":
            out["error"] = job.get("error", "")
        return out

    def path(self, key, which):
        job = self.jobs.get(key)
        if job and job["state"] == "done" and which in ("mac", "std"):
            return job[which]
        return None

    def _worker(self):
        while True:
            with self.cv:
                while not self.pending:
                    self.cv.wait()
                key = self.pending.pop()
                job = self.jobs.get(key)
                if not job:
                    continue
                job["state"] = "running"
            try:
                self._build(key, job)
                job["state"] = "done"
            except Exception as e:  # 미리보기 실패는 화면에 표시
                job["error"] = friendly(e, "preview")
                job["state"] = "error"
                log("preview error", key, e)

    def _build(self, key, job):
        f = self.files.get(job["fid"])
        if not f:
            raise AppError("목록에서 빠진 영상입니다")
        start = job["seg"] * SEG
        dur = SEG if not f["duration"] else max(0.05, min(SEG, f["duration"] - start))
        ext = ".mov"  # 1-2-1 미리보기에 감마 표시(gama)를 넣으려면 MOV 여야 함
        std = os.path.join(self.root, f"{key}_std{ext}")
        mac = os.path.join(self.root, f"{key}_mac{ext}")
        cmd = ["ffmpeg", "-v", "error", "-y", "-ss", f"{start:.3f}", "-i", f["path"], "-t", f"{dur:.3f}",
               "-map", "0:v:0", "-an", "-sn", "-dn",
               "-vf", f"scale=-2:'min({PREVIEW_H},ih)':flags=bicubic,format=yuv420p",
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-g", "12",
               "-color_primaries", "1", "-color_trc", "1", "-colorspace", "1",
               "-movflags", "+write_colr+faststart", std]
        ct.run_ffmpeg(cmd)
        ct.convert(std, mac, TAGS["mac"], faststart=True)  # 픽셀은 그대로, 태그만 1-2-1
        job.update(start=start, dur=dur, std=std, mac=mac)


# ---------------------------------------------------------------- 상태/작업
class Core:
    def __init__(self, root):
        self.lock = threading.RLock()
        self.files, self.order = {}, []
        self.saving, self.save_target, self.save_total = False, None, 0
        self.last_save = {"done": 0, "error": 0, "skipped": 0}   # 방금 끝난 저장 한 번의 결과 (알림용)
        self.previews = Previews(root, self.files)
        self.last_seen = 0.0
        self.added_seq, self.last_added = 0, []
        self.dnd = False
        self.updater = updater.Updater(APP_VERSION, HERE, log)
        self.updater.start()
        self.fullscreen = False
        self.prefs = load_prefs()

    # 목록
    def add_paths(self, paths):
        added = []
        paths = expand_paths(paths)
        with self.lock:
            known = {f["path"] for f in self.files.values()}
            for p in paths:
                p = os.path.abspath(os.path.expanduser(str(p)))
                if p in known or not os.path.isfile(p):
                    continue
                f = {"id": uuid.uuid4().hex[:10], "path": p, "gamma": None, "name": os.path.basename(p), "codec": "", "tag": None,
                     "duration": 0.0, "ok": False, "note": "", "status": "", "result": "", "out": None, "progress": 0, "saved": []}
                try:
                    tr = ct.read_tracks(p)
                except Exception:
                    tr = []
                if tr:
                    f["codec"], f["tag"], f["gamma"] = tr[0]["codec"], tr[0]["tag"], tr[0]["gamma"]
                    f["duration"] = ct.read_duration(p)
                    f["ok"], f["note"] = check_709(f["tag"])
                else:
                    f["note"] = ("영상을 읽지 못했어요. 파일이 깨졌거나 복사가 덜 끝났을 수 있어요."
                                 if p.lower().endswith(VIDEO_EXT) else "MOV · MP4 영상만 열 수 있습니다")
                self.files[f["id"]] = f
                self.order.append(f["id"])
                known.add(p)
                added.append(f["id"])
            if added:
                self.added_seq += 1
                self.last_added = added
        return added

    def remove(self, fid):
        with self.lock:
            if self.saving:
                raise ApiError("저장 중에는 뺄 수 없습니다")
            if fid in self.files:
                del self.files[fid]
                self.order.remove(fid)

    def clear(self):
        with self.lock:
            if self.saving:
                raise ApiError("저장 중에는 비울 수 없습니다")
            self.files.clear()
            self.order.clear()

    def state(self):
        with self.lock:
            files = []
            for fid in self.order:
                f = self.files[fid]
                files.append({k: f[k] for k in ("id", "path", "name", "codec", "duration", "ok", "note", "gamma",
                                                 "status", "result", "progress")}
                             | {"tag": ct.tag_str(f["tag"]) if f["tag"] else "없음", "has_out": bool(f["out"]),
                                "playable": bool(f["codec"])})
            return {"files": files, "saving": self.saving, "save_target": self.save_target,
                    "seg_len": SEG, "ffmpeg": bool(shutil.which("ffmpeg")), "app": APP_NAME, "subtitle": APP_SUBTITLE,
                    "version": APP_VERSION, "update": self.updater.state(),
                    "targets": {w: len(self.targets(w)) for w in TAGS},
                    "save_total": self.save_total, "last_save": dict(self.last_save), "copyright": COPYRIGHT, "native": NV_STATE, "dnd": self.dnd,
                    "added_seq": self.added_seq, "last_added": self.last_added,
                    "skip_intro": bool(self.prefs.get("skip_intro"))}

    # 저장
    def targets(self, which):
        """이 상태로 실제 저장될 영상: 열 수 있고, Rec709 이고, 이미 그 상태가 아니고, 이번에 이미 저장하지 않은 것."""
        tag = TAGS[which]
        out = []
        for fid in self.order:
            f = self.files[fid]
            already = f["tag"] == tag and (not ct.needs_gama(tag) or f.get("gamma") == ct.MAC_GAMMA)
            if f["codec"] and f["ok"] and not already and which not in f["saved"]:
                out.append(fid)
        return out

    def start_save(self, which):
        if which not in TAGS:
            raise ApiError("알 수 없는 태그")
        with self.lock:
            if self.saving:
                raise ApiError("이미 저장 중입니다")
            ids = self.targets(which)  # 저장을 끝낸 영상은 다시 저장하지 않음 (같은 파일이 또 생기지 않게)
            if not ids:
                raise ApiError("저장할 영상이 없습니다")
            self.saving, self.save_target, self.save_total = True, which, len(ids)
            for fid in ids:
                self.files[fid].update(status="queued", result="대기 중", progress=0)
        threading.Thread(target=self._save_worker, args=(ids, which), daemon=True).start()

    def _save_worker(self, ids, which):
        tag = TAGS[which]
        want = ct.tag_str(tag)
        try:
            for fid in ids:
                f = self.files.get(fid)
                if not f:
                    continue
                if not f["ok"]:
                    f.update(status="skipped", result="제외: 지원하지 않는 방식의 영상")
                    continue
                done_already = f["tag"] == tag and (not ct.needs_gama(tag) or f.get("gamma") == ct.MAC_GAMMA)
                if done_already:
                    f.update(status="skipped", result=f"이미 이 상태입니다 ({want})")
                    continue
                f.update(status="working", result="저장 중…", progress=0)

                def prog(x, f=f):
                    f["progress"] = round(x * 100)
                try:
                    out = ct.convert_file(f["path"], tag, progress=prog)
                    got = ct.tag_str(ct.read_tracks(out)[0]["tag"])
                    log("save", os.path.basename(f["path"]), "→", os.path.basename(out),
                        "| 원본:", ct.describe(f["path"]), "| 저장본:", ct.describe(out))
                    if got != want:
                        raise AppError(f"저장한 파일의 태그가 {got}로 확인됐어요. 기록 파일을 보내 주세요")
                    qt = None
                    if sys.platform == "darwin":  # 퀵타임과 같은 방식으로 다시 읽어 확인
                        try:
                            qt = qtplayer.quicktime_code(out)
                        except Exception as e:
                            log("quicktime check failed:", e)
                    log("save check: 파일", got, "| 퀵타임 기준", qt)
                    if qt and qt != want:
                        shown = "태그가 달리지 않음" if "untagged" in qt else f"({qt})"
                        f.update(status="error", out=out, progress=100,
                                 result=f"퀵타임에서 {shown}으로 보임 — 기록 파일을 보내 주세요")
                        continue
                    note = f" · 퀵타임 ({qt}) 확인" if qt else ""
                    f.update(status="done", result=os.path.basename(out) + note, out=out, progress=100)
                    f["saved"].append(which)
                except Exception as e:
                    f.update(status="error", result=friendly(e, "save"))
                    log("save error", f["path"], e)
        finally:
            with self.lock:
                st = [self.files[fid]["status"] for fid in ids if fid in self.files]
                self.last_save = {k: st.count(k) for k in ("done", "error", "skipped")}
                self.saving = False

    def reveal(self, fid):
        f = self.files.get(fid)
        target = f and (f["out"] or f["path"])
        if target and sys.platform == "darwin":
            subprocess.run(["open", "-R", target])

    def pick(self):
        return self.add_paths(pick_dialog())

    def handle(self, name, method, qs, data):
        q = lambda k: (qs.get(k) or [""])[0]  # noqa: E731
        if name == "state":
            return self.state()
        if name == "segment":
            fid, seg = q("id"), int(q("seg") or 0)
            f = self.files.get(fid)
            if not f or not f["codec"]:
                raise ApiError("미리볼 수 없는 영상")
            last = max(0, -(-f["duration"] // SEG) - 1) if f["duration"] else 0  # 마지막 구간 번호
            return self.previews.request(fid, int(min(max(0, seg), last)))
        if name == "launch":
            return launch_state()
        if name == "launch_seen":
            LAUNCH["seen"] = True
            return {"ok": True}
        if name == "launch_ready":  # 런치 화면: 글꼴 로드와 첫 내용 준비가 끝남 → 이제 창을 보임
            show_splash()
            return {"ok": True}
        if name == "launch_quit":   # 런치 화면이 오류로 멈춘 상태에서 클릭·키 입력
            if LAUNCH["error"]:
                threading.Timer(0.1, lambda: os._exit(1)).start()
            return {"ok": bool(LAUNCH["error"])}
        if name == "nv_state":
            if NV is None:
                raise ApiError("네이티브 플레이어 없음")
            if q("peek"):  # 점검용: 이벤트를 꺼내지 않고 상태만
                return {"players": dict(NV.cache), "events": []}
            return NV.snapshot()
        if method != "POST":
            raise ApiError("POST 필요")
        if name == "pick":
            added = self.pick()
            return self.state() | {"added": added}
        if name == "add":
            added = self.add_paths(data.get("paths") or [])
            return self.state() | {"added": added}
        if name == "remove":
            self.remove(data.get("id"))
            return self.state()
        if name == "clear":
            self.clear()
            return self.state()
        if name == "save":
            self.start_save(data.get("tag"))
            return self.state()
        if name == "nv":  # 퀵타임 엔진 플레이어 명령
            if NV is None:
                raise ApiError("네이티브 플레이어 없음")
            cmds = data.get("cmds") or []
            for c in cmds:
                if c.get("op") == "src":
                    c["path"] = media_path(c.get("url"))
            NV.command(cmds)
            return {"ok": True}
        if name == "update_check":
            threading.Thread(target=self.updater.check, args=(True,), daemon=True).start()
            time.sleep(0.2)
            return self.state()
        if name == "update_restart":
            if self.saving:
                raise ApiError("저장이 끝난 뒤 다시 시작해 주세요")
            if not self.updater.apply(relaunch=True):
                raise ApiError("업데이트를 설치할 수 없습니다")
            threading.Timer(0.3, quit_app).start()
            return {"ok": True}
        if name == "prefs":  # 로딩 화면 '다음부터 바로 시작'
            if "skip_intro" in data:
                self.prefs["skip_intro"] = bool(data["skip_intro"])
                save_prefs(self.prefs)
            return self.state()
        if name == "update_page":  # 직접 내려받아야 할 때: 릴리스 페이지 열기
            page = self.updater.state()["page"]
            if sys.platform == "darwin":
                subprocess.run(["open", page])
            return {"ok": True, "page": page}
        if name == "fullscreen":  # 앱 창 자체를 전체화면으로 (창이 있을 때만)
            on = bool(data.get("on"))
            if WINDOW is not None and on != self.fullscreen:
                WINDOW.toggle_fullscreen()
                self.fullscreen = on
            return {"ok": WINDOW is not None}
        if name == "open_qt":  # 저장한 파일을 퀵타임으로 열어 확인
            f = self.files.get(data.get("id"))
            if not f or not f["out"] or not os.path.exists(f["out"]):
                raise ApiError("저장한 파일을 찾을 수 없습니다")
            if sys.platform == "darwin":
                subprocess.run(["open", "-a", "QuickTime Player", f["out"]])
            return {"ok": True}
        if name == "reveal":
            self.reveal(data.get("id"))
            return {"ok": True}
        raise ApiError("알 수 없는 요청")


# ---------------------------------------------------------------- 파일 선택 창
WINDOW = None
SPLASH = None        # GRAYZONE 런치 화면 창 (640×400, 제목 표시줄 없음)
LAUNCH_ZONE = 7      # 이 앱의 존 (웨지에서 외곽선 + 로마 숫자 VII)
LAUNCH_CELLS = 11    # 웨지 칸 수 (존 0 … X)
LAUNCH = {"cells": 0, "status": "시작하는 중", "error": "", "done": False, "seen": False, "shown": False, "t_shown": 0.0}
LAUNCH_HOOK = None   # 점검용: 메인 창으로 넘어가기 직전에 부름


def bundle_version():
    """런치 화면에 표시할 버전: 앱 번들(Info.plist)의 버전 값을 읽음. 번들 밖(개발 실행)에서만 코드 값."""
    try:
        with open(os.path.join(HERE, "..", "Info.plist"), "rb") as f:
            return str(plistlib.load(f)["CFBundleShortVersionString"])
    except Exception:
        return APP_VERSION


def launch_state():
    return {k: LAUNCH[k] for k in ("cells", "status", "error", "done", "seen")} | {
        "version": bundle_version(), "name": f"{APP_NAME} {APP_SUBTITLE}", "zone": LAUNCH_ZONE}


def show_splash():
    """런치 창을 보이게 함. 글꼴이 로드되고 화면 내용이 준비된 뒤에 부름 (빈 창이 먼저 보이지 않게)."""
    if SPLASH is not None and not LAUNCH["t_shown"]:
        LAUNCH["t_shown"] = time.time()
        SPLASH.show()


def launch_sequence():
    """런치 화면의 웨지를 실제 초기화 단계에 맞춰 채운다 (시간만 재는 가짜 진행 없음).

    칸 수는 끝난 단계까지, 상태 문구는 지금 하고 있는 일. 오류가 나면 무엇이 실패했는지 적고 멈춘다.
      1칸  내부 서버 시작 (이 함수가 불릴 때 이미 끝남)
      3칸  앱 안의 ffmpeg 실행 확인
      4칸  설정 불러오기
      7칸  메인 화면 불러오기
      9칸  퀵타임 엔진 미리보기 준비
      11칸 업데이트 확인 (5초 안에 답이 없으면 뒤에서 계속하고 넘어감)
    """
    def stage(cells, status):
        LAUNCH.update(cells=cells, status=status)

    def fail(msg):  # 무엇이 실패했는지 적고 멈춤. 닫을 방법이 없으므로 클릭·키 입력으로 앱을 닫게 함
        LAUNCH["error"] = "실패: " + msg + " · 클릭하거나 키를 누르면 닫힙니다"
        log("launch error:", msg)
        show_splash()

    stage(1, "앱 안의 ffmpeg 확인 중")
    try:
        ok = subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=20).returncode == 0
    except Exception:
        ok = False
    if not ok:
        return fail("앱 안의 ffmpeg를 실행할 수 없습니다. 앱을 다시 설치해 주세요")
    stage(3, "설정 불러오는 중")
    CORE.prefs = load_prefs()
    stage(4, "메인 화면 불러오는 중")
    if not WINDOW.events.loaded.wait(40):
        return fail("메인 화면을 불러오지 못했습니다")
    stage(7, "퀵타임 엔진 미리보기 준비 중")
    while NV_STATE == "pending":
        time.sleep(0.05)
    if sys.platform == "darwin" and NV_STATE != "on":
        return fail("퀵타임 엔진 미리보기를 켜지 못했습니다")
    stage(9, "업데이트 확인 중")
    t = time.time()
    while CORE.updater.state()["status"] in ("idle", "checking") and time.time() - t < 5:
        time.sleep(0.05)
    stage(LAUNCH_CELLS, "준비 완료")
    LAUNCH["done"] = True
    t = time.time()
    while not LAUNCH["seen"] and time.time() - t < 3:   # 11칸이 다 찬 화면이 실제로 그려질 때까지
        time.sleep(0.02)
    show_splash()
    while time.time() - LAUNCH["t_shown"] < 1.0:  # 아주 빨리 끝나도 최소 1초는 보여 줌
        time.sleep(0.02)
    time.sleep(0.2)
    if LAUNCH_HOOK:
        LAUNCH_HOOK()
    WINDOW.show()
    SPLASH.destroy()
    LAUNCH["shown"] = True
NV = None            # 퀵타임 엔진(AVFoundation) 플레이어
NV_STATE = "off"     # off | pending | on


def media_path(url):
    """화면이 쓰는 미리보기 주소(/media/<key>/<mac|std>) → 파일 경로."""
    m = re.match(r"/media/([0-9a-f]+_\d+)/(mac|std)", str(url or ""))
    return CORE.previews.path(m.group(1), m.group(2)) if m else None


def init_native():
    """창이 뜬 뒤 메인 스레드에서: 웹 화면 아래에 퀵타임 엔진 플레이어를 깐다."""
    global NV, NV_STATE
    try:
        from webview.platforms.cocoa import BrowserView
        wv = BrowserView.instances[WINDOW.uid].webview
        NV = qtplayer.AVBackend(wv, media_path)
        NV_STATE = "on"
        log("native player on")
    except Exception:
        NV_STATE = "off"
        log("native player off:", traceback.format_exc())


def pick_dialog():
    types = ("영상 (*.mov;*.mp4;*.m4v)",)
    if WINDOW is not None:
        import webview
        kind = getattr(getattr(webview, "FileDialog", None), "OPEN", None)
        if kind is None:
            kind = getattr(webview, "OPEN_DIALOG", 10)
        res = WINDOW.create_file_dialog(kind, allow_multiple=True, file_types=types)
        return list(res or [])
    if sys.platform == "darwin":  # 창 없이 실행된 경우(사파리 모드)
        script = ('set fs to choose file with prompt "영상 선택" of type {"public.movie"} '
                  'with multiple selections allowed\n'
                  'set out to ""\nrepeat with f in fs\nset out to out & POSIX path of f & linefeed\nend repeat\n'
                  'return out')
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
        return [x for x in r.stdout.splitlines() if x.strip()]
    return []


# ---------------------------------------------------------------- HTTP 서버
TOKEN = secrets.token_urlsafe(18)
STATIC = {"/appicon.png": (os.path.join(HERE, "web", "appicon.png"), "image/png"),  # 앱 아이콘(AppIcon.icns)에서 꺼낸 그림
          "/fonts/Pretendard.woff2": (os.path.join(HERE, "web", "fonts", "Pretendard.woff2"), "font/woff2"),
          "/fonts/Manrope.woff2": (os.path.join(HERE, "web", "fonts", "Manrope.woff2"), "font/woff2")}
CORE = None
HOSTS = set()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = APP_NAME

    def log_message(self, *a):
        pass

    def do_GET(self):
        self._route("GET")

    def do_HEAD(self):
        self._route("HEAD")

    def do_POST(self):
        self._route("POST")

    def _route(self, method):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        tok = self.headers.get("X-Token") or (qs.get("t") or [""])[0]
        static = STATIC.get(u.path)  # 런치 화면의 글꼴·아이콘 (비밀 아님: 토큰 없이, 이 앱 주소로만)
        if static and self.headers.get("Host", "") in HOSTS and method in ("GET", "HEAD"):
            if not os.path.exists(static[0]):
                return self._send(404, b"not found", "text/plain")
            return self._file(static[0], static[1], method)
        if self.headers.get("Host", "") not in HOSTS or not secrets.compare_digest(tok, TOKEN):
            return self._send(403, b"forbidden", "text/plain")
        CORE.last_seen = time.time()
        try:
            if u.path == "/launch":
                return self._file(os.path.join(HERE, "web", "launch.html"), "text/html; charset=utf-8", method)
            if u.path == "/":
                return self._file(INDEX, "text/html; charset=utf-8", method)
            m = re.fullmatch(r"/media/([0-9a-f]+_\d+)/(mac|std)", u.path)
            if m:
                p = CORE.previews.path(m.group(1), m.group(2))
                if not p:
                    return self._send(404, b"not ready", "text/plain")
                return self._file(p, "video/mp4" if p.endswith(".mp4") else "video/quicktime", method)
            if u.path.startswith("/api/"):
                data = {}
                if method == "POST":
                    n = int(self.headers.get("Content-Length") or 0)
                    data = json.loads(self.rfile.read(n) or b"{}") if n else {}
                res = CORE.handle(u.path[5:], method, qs, data)
                return self._send(200, json.dumps(res, ensure_ascii=False).encode(), "application/json")
            return self._send(404, b"not found", "text/plain")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except ApiError as e:
            self._send(400, json.dumps({"error": str(e)}, ensure_ascii=False).encode(), "application/json")
        except Exception as e:
            log("server error", traceback.format_exc())
            self._send(500, json.dumps({"error": str(e)}, ensure_ascii=False).encode(), "application/json")

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _file(self, path, ctype, method):
        """Range 요청 지원 (WebKit 영상 재생에 필요)."""
        size = os.path.getsize(path)
        start, end, code = 0, size - 1, 200
        rng = self.headers.get("Range")
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip()) if rng else None
        if m and (m.group(1) or m.group(2)):
            a, b = m.groups()
            if a == "":
                start = max(0, size - int(b))
            else:
                start = int(a)
                end = min(int(b), size - 1) if b else size - 1
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            code = 206
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "no-store")
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if method == "HEAD":
            return
        with open(path, "rb") as fh:
            fh.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = fh.read(min(256 * 1024, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)


def start_server(root, port=0):
    global CORE
    CORE = Core(root)
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    port = srv.server_address[1]
    HOSTS.update({f"127.0.0.1:{port}", f"localhost:{port}"})
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{port}/?t={TOKEN}"


# ---------------------------------------------------------------- 창
def run_window(url):
    global WINDOW, SPLASH
    try:
        import webview
    except Exception as e:
        log("pywebview 사용 불가:", e)
        return False
    if sys.platform == "darwin":
        try:  # 제목 표시줄·파일 선택 창도 어두운 모드로
            import AppKit
            AppKit.NSApplication.sharedApplication().setAppearance_(
                AppKit.NSAppearance.appearanceNamed_(AppKit.NSAppearanceNameDarkAqua))
        except Exception as e:
            log("dark appearance 실패:", e)
    global NV_STATE
    if sys.platform == "darwin":
        NV_STATE = "pending"  # 창이 뜨면 켬. 화면은 그때까지 기다림
    # 메인 창은 숨긴 채 불러오고, 그동안 런치 화면(640×400, 제목 표시줄 없음, 크기 고정, 화면 중앙)을 보여 줌
    WINDOW = webview.create_window(f"{APP_NAME} {APP_SUBTITLE}", url, width=1240, height=820, min_size=(1020, 700),
                                   background_color="#121212", text_select=False, hidden=True)
    SPLASH = webview.create_window(f"{APP_NAME} {APP_SUBTITLE}", url.replace("/?t=", "/launch?t="), width=640, height=400,
                                   resizable=False, frameless=True, easy_drag=True, background_color="#121212",
                                   text_select=False, hidden=True)
    # 숨긴 채 만들고, 화면이 글꼴 로드까지 끝냈다고 알리면 보임 (알림이 없으면 불러온 뒤 3초에 보임)
    SPLASH.events.loaded += lambda: threading.Timer(3, show_splash).start()
    threading.Thread(target=launch_sequence, daemon=True).start()
    WINDOW.events.loaded += lambda: register_dnd() if not CORE.dnd else None
    if sys.platform == "darwin":
        def on_loaded():
            if NV_STATE == "pending":
                try:
                    from PyObjCTools import AppHelper
                    AppHelper.callAfter(init_native)
                except Exception:
                    globals()["NV_STATE"] = "off"
        WINDOW.events.loaded += on_loaded

        def give_up():  # 15초 안에 못 켜면 웹 플레이어로 (화면이 멈추지 않게)
            if NV_STATE == "pending":
                globals()["NV_STATE"] = "off"
                log("native player timeout")
        threading.Timer(15, give_up).start()
    webview.start()
    return True


def quit_app():
    if WINDOW is not None:
        WINDOW.destroy()
    else:
        os._exit(0)


def run_browser_fallback(url):
    """pywebview 를 못 쓰는 경우: 사파리로 열고, 페이지가 닫히면 종료."""
    if sys.platform == "darwin":
        subprocess.run(["open", "-a", "Safari", url])
    else:
        import webbrowser
        webbrowser.open(url)
    t0 = time.time()
    while True:
        time.sleep(2)
        idle = time.time() - (CORE.last_seen or t0)
        if idle > (300 if CORE.last_seen else 120) and not CORE.saving:
            return


def main(argv):
    root = tempfile.mkdtemp(prefix="gretag-")
    try:
        srv, url = start_server(root, int(os.environ.get("GCT_PORT", "0")))
        if os.environ.get("GCT_NATIVE_SIM") == "1":  # 테스트: 가짜 네이티브 플레이어
            global NV, NV_STATE
            NV = qtplayer.SimBackend(media_path, ct.read_duration)
            NV_STATE = "on"
        if "--serve" in argv:
            print(url, flush=True)
            while True:
                time.sleep(3600)
        if not run_window(url):
            run_browser_fallback(url)
        CORE.updater.apply(relaunch=False)  # 받아 둔 새 버전이 있으면 끌 때 교체
        srv.shutdown()
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main(sys.argv)
