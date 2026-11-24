package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gcopy/internal/engine"
)

type client struct {
	t    *testing.T
	base string
	http *http.Client
}

func newClient(t *testing.T, base string) *client {
	jar, _ := cookiejar.New(nil)
	return &client{t: t, base: base, http: &http.Client{Jar: jar}}
}

func (c *client) do(method, path string, body any, hdr map[string]string) (int, map[string]any) {
	c.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.base+path, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range hdr {
		if k == "Host" {
			req.Host = v
		} else {
			req.Header.Set(k, v)
		}
	}
	res, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func setup(t *testing.T) (*Server, *httptest.Server, *client) {
	t.Helper()
	s := New(t.TempDir(), nil)
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(func() { s.CancelRunning(); ts.Close() })
	c := newClient(t, ts.URL)
	if code, _ := c.do("GET", "/?token="+s.Token(), nil, nil); code != http.StatusOK {
		t.Fatalf("launch URL: status %d", code)
	}
	return s, ts, c
}

func TestOnlyTheLaunchedBrowserMayUseTheAPI(t *testing.T) {
	s, ts, c := setup(t)

	if code, _ := c.do("GET", "/api/volumes", nil, nil); code != http.StatusOK {
		t.Errorf("with session: status %d, want 200", code)
	}
	stranger := newClient(t, ts.URL)
	if code, _ := stranger.do("GET", "/api/volumes", nil, nil); code != http.StatusUnauthorized {
		t.Errorf("without session: status %d, want 401", code)
	}
	if code, _ := stranger.do("GET", "/?token=guess", nil, nil); code != http.StatusForbidden {
		t.Errorf("wrong token: status %d, want 403", code)
	}
	// Another website reaching us through its own host name (DNS rebinding).
	if code, _ := c.do("GET", "/api/volumes", nil, map[string]string{"Host": "evil.example"}); code != http.StatusForbidden {
		t.Errorf("foreign host name: status %d, want 403", code)
	}
	// Another website's page posting with the user's cookie.
	body := map[string]any{"parent": t.TempDir(), "name": "x"}
	if code, _ := c.do("POST", "/api/mkdir", body, map[string]string{"Origin": "http://evil.example"}); code != http.StatusForbidden {
		t.Errorf("foreign origin: status %d, want 403", code)
	}
	// A plain HTML form cannot send JSON; refuse anything else.
	req, _ := http.NewRequest("POST", ts.URL+"/api/job/cancel", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "text/plain")
	req.AddCookie(&http.Cookie{Name: cookieName, Value: s.Token()})
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnsupportedMediaType {
		t.Errorf("non-JSON post: status %d, want 415", res.StatusCode)
	}
}

func TestBrowseAndMkdir(t *testing.T) {
	_, _, c := setup(t)
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "B_folder"), 0o755)
	os.MkdirAll(filepath.Join(root, "a_folder"), 0o755)
	os.MkdirAll(filepath.Join(root, ".hidden"), 0o755)
	os.MkdirAll(filepath.Join(root, engine.ReplacedDirName), 0o755)
	os.WriteFile(filepath.Join(root, "clip.mov"), []byte("x"), 0o644)

	code, out := c.do("GET", "/api/browse?path="+root, nil, nil)
	if code != http.StatusOK {
		t.Fatalf("browse: %d %v", code, out)
	}
	var names []string
	for _, d := range out["dirs"].([]any) {
		names = append(names, d.(map[string]any)["name"].(string))
	}
	if strings.Join(names, ",") != "a_folder,B_folder" || out["files"].(float64) != 1 {
		t.Errorf("listing: dirs %v files %v", names, out["files"])
	}
	if code, _ := c.do("GET", "/api/browse?path=relative/path", nil, nil); code != http.StatusBadRequest {
		t.Errorf("relative path: status %d, want 400", code)
	}
	if code, _ := c.do("GET", "/api/browse?path="+filepath.Join(root, "nope"), nil, nil); code != http.StatusNotFound {
		t.Errorf("missing folder: status %d, want 404", code)
	}

	code, out = c.do("POST", "/api/mkdir", map[string]any{"parent": root, "name": "2026_영화"}, nil)
	if code != http.StatusOK || out["path"] != filepath.Join(root, "2026_영화") {
		t.Fatalf("mkdir: %d %v", code, out)
	}
	if code, _ := c.do("POST", "/api/mkdir", map[string]any{"parent": root, "name": "2026_영화"}, nil); code != http.StatusConflict {
		t.Errorf("mkdir twice: status %d, want 409", code)
	}
	for _, bad := range []string{"", "..", "a/b", `a\b`, "  "} {
		if code, _ := c.do("POST", "/api/mkdir", map[string]any{"parent": root, "name": bad}, nil); code != http.StatusBadRequest {
			t.Errorf("mkdir %q: status %d, want 400", bad, code)
		}
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(root), "b")); err == nil {
		t.Error("mkdir escaped the chosen folder")
	}
}

func TestJobThroughTheAPIAndHistory(t *testing.T) {
	_, _, c := setup(t)
	tmp := t.TempDir()
	src, dst := filepath.Join(tmp, "A001"), filepath.Join(tmp, "NAS")
	os.MkdirAll(src, 0o755)
	os.MkdirAll(dst, 0o755)
	os.WriteFile(filepath.Join(src, "clip.mov"), bytes.Repeat([]byte("gcopy"), 50000), 0o644)

	if code, out := c.do("GET", "/api/job", nil, nil); code != 200 || out["status"] != "idle" {
		t.Fatalf("initial state: %d %v", code, out)
	}
	if code, out := c.do("POST", "/api/job", map[string]any{"sources": []string{src}, "destinations": []string{src}}, nil); code != http.StatusBadRequest || !strings.Contains(out["error"].(string), "source") {
		t.Errorf("unsafe request: %d %v", code, out)
	}
	code, out := c.do("POST", "/api/job", map[string]any{"sources": []string{src}, "destinations": []string{dst}, "subfolder": true}, nil)
	if code != http.StatusOK {
		t.Fatalf("start: %d %v", code, out)
	}
	deadline := time.Now().Add(10 * time.Second)
	for out["status"] != "done" {
		if time.Now().After(deadline) {
			t.Fatalf("job did not finish: %v", out)
		}
		time.Sleep(20 * time.Millisecond)
		_, out = c.do("GET", "/api/job", nil, nil)
	}
	got, err := os.ReadFile(filepath.Join(dst, "A001", "clip.mov"))
	if err != nil || len(got) != 250000 {
		t.Errorf("copied file: %v, %d bytes", err, len(got))
	}

	// The finished job is kept until dismissed, and is in the history.
	if _, out := c.do("GET", "/api/job", nil, nil); out["status"] != "done" {
		t.Errorf("finished job not kept: %v", out["status"])
	}
	c.do("POST", "/api/job/dismiss", map[string]any{}, nil)
	if _, out := c.do("GET", "/api/job", nil, nil); out["status"] != "idle" {
		t.Errorf("after dismiss: %v", out["status"])
	}
	_, out = c.do("GET", "/api/history", nil, nil)
	h := out["history"].([]any)
	if len(h) != 1 || h[0].(map[string]any)["filesCopied"].(float64) != 1 {
		t.Errorf("history: %v", h)
	}
}

func TestSettingsAreKeptByTheEngine(t *testing.T) {
	s, _, c := setup(t)
	if code, out := c.do("GET", "/api/settings", nil, nil); code != 200 || len(out) != 0 {
		t.Fatalf("first read: %d %v", code, out)
	}
	want := map[string]any{"dests": []any{"/Volumes/NAS/Project"}, "opts": map[string]any{"algo": "md5"}}
	if code, _ := c.do("POST", "/api/settings", want, nil); code != 200 {
		t.Fatalf("save: %d", code)
	}
	// A new window (new session, as after restarting the app) reads them back.
	again := newClient(t, c.base)
	again.do("GET", "/?token="+s.Token(), nil, nil)
	_, got := again.do("GET", "/api/settings", nil, nil)
	if got["dests"].([]any)[0] != "/Volumes/NAS/Project" || got["opts"].(map[string]any)["algo"] != "md5" {
		t.Errorf("read back: %v", got)
	}
	req, _ := http.NewRequest("POST", c.base+"/api/settings", strings.NewReader(`["not an object"]`))
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Errorf("non-object settings: status %d, want 400", res.StatusCode)
	}
}

func TestLoopbackHost(t *testing.T) {
	for host, want := range map[string]bool{
		"127.0.0.1:47800": true, "localhost:47800": true, "[::1]:47800": true, "127.0.0.1": true,
		"evil.example:47800": false, "127.0.0.1.evil.example:47800": false, "": false, "192.168.0.10:47800": false,
	} {
		if got := loopbackHost(host); got != want {
			t.Errorf("loopbackHost(%q) = %v, want %v", host, got, want)
		}
	}
}

// The screen offers one checksum and a switch for verification. Requests
// and saved schedules from earlier versions (MD5) are brought in line.
func TestOptionsAreBroughtToWhatTheScreenOffers(t *testing.T) {
	s, _, c := setup(t)
	tmp := t.TempDir()
	src, dst := filepath.Join(tmp, "A001"), filepath.Join(tmp, "NAS")
	os.MkdirAll(src, 0o755)
	os.MkdirAll(dst, 0o755)
	os.WriteFile(filepath.Join(src, "clip.mov"), bytes.Repeat([]byte("x"), 1000), 0o644)
	wait := func() map[string]any {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for {
			_, out := c.do("GET", "/api/job", nil, nil)
			if out["status"] == "done" || out["status"] == "failed" {
				return out
			}
			if time.Now().After(deadline) {
				t.Fatalf("job did not finish: %v", out)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	// MD5 asked for (an old window, an old script): xxHash64 is used.
	c.do("POST", "/api/job", map[string]any{"sources": []string{src}, "destinations": []string{dst}, "subfolder": true, "algo": "md5"}, nil)
	out := wait()
	if o := out["options"].(map[string]any); o["algo"] != "xxh64" {
		t.Errorf("algo %v", o["algo"])
	}
	data, _ := os.ReadFile(out["dests"].([]any)[0].(map[string]any)["reports"].([]any)[0].(string))
	if !strings.Contains(string(data), "<xxhash64be>") || strings.Contains(string(data), "<md5>") {
		t.Errorf("report: %s", data)
	}
	c.do("POST", "/api/job/dismiss", map[string]any{}, nil)

	// Verification off: "re-check earlier copies" is switched off with it, and no report is written.
	dst2 := filepath.Join(tmp, "DAS")
	os.MkdirAll(dst2, 0o755)
	c.do("POST", "/api/job", map[string]any{"sources": []string{src}, "destinations": []string{dst2}, "subfolder": true, "noVerify": true, "reverify": true}, nil)
	out = wait()
	o := out["options"].(map[string]any)
	if o["noVerify"] != true || o["reverify"] != false || len(out["dests"].([]any)[0].(map[string]any)["reports"].([]any)) != 0 {
		t.Errorf("options %v, dests %v", o, out["dests"])
	}
	if got, _ := os.ReadFile(filepath.Join(dst2, "A001", "clip.mov")); len(got) != 1000 {
		t.Errorf("copy: %d bytes", len(got))
	}
	c.do("POST", "/api/job/dismiss", map[string]any{}, nil)

	// A schedule saved with MD5 by an earlier version loads as xxHash64.
	old := `[{"id":"abc","name":"old","options":{"sources":["` + src + `"],"destinations":["` + dst + `"],"algo":"md5","subfolder":true,"reverify":true,"mirror":false},"when":{"kind":"daily","time":"02:07"},"enabled":true,"created":"2026-11-01T00:00:00Z"}]`
	os.WriteFile(s.schedulesPath(), []byte(old), 0o644)
	s.sched.mu.Lock()
	s.loadSchedules()
	s.sched.mu.Unlock()
	_, out = c.do("GET", "/api/schedules", nil, nil)
	sc := out["schedules"].([]any)[0].(map[string]any)
	if so := sc["options"].(map[string]any); so["algo"] != "xxh64" || so["reverify"] != true || sc["when"].(map[string]any)["time"] != "02:07" {
		t.Errorf("loaded schedule: %v", sc)
	}
}

func TestFolderSize(t *testing.T) {
	_, _, c := setup(t)
	src := filepath.Join(t.TempDir(), "A001")
	os.MkdirAll(filepath.Join(src, "CLIPS"), 0o755)
	os.MkdirAll(filepath.Join(src, ".Spotlight-V100"), 0o755)
	os.WriteFile(filepath.Join(src, "CLIPS", "a.mov"), make([]byte, 3000), 0o644)
	os.WriteFile(filepath.Join(src, "b.mov"), make([]byte, 500), 0o644)
	os.WriteFile(filepath.Join(src, ".DS_Store"), make([]byte, 99), 0o644)            // not part of a backup
	os.WriteFile(filepath.Join(src, ".Spotlight-V100", "x"), make([]byte, 99), 0o644) // nor this
	code, out := c.do("GET", "/api/size?path="+url.QueryEscape(src), nil, nil)
	if code != 200 || out["bytes"].(float64) != 3500 || out["files"].(float64) != 2 {
		t.Errorf("size: %d %v", code, out)
	}
	if code, _ := c.do("GET", "/api/size?path=relative", nil, nil); code != http.StatusBadRequest {
		t.Errorf("relative path: %d", code)
	}
}

// Backups added while one is running wait their turn and start by
// themselves; the running one can be paused and resumed.
func TestQueueAndPause(t *testing.T) {
	_, _, c := setup(t)
	tmp := t.TempDir()
	mk := func(name string, size int) string {
		p := filepath.Join(tmp, name)
		os.MkdirAll(p, 0o755)
		os.WriteFile(filepath.Join(p, "clip.mov"), bytes.Repeat([]byte{byte(len(name))}, size), 0o644)
		return p
	}
	a, b2, c3, gone := mk("A001", 120<<20), mk("A002", 1000), mk("A003", 2000), mk("A004", 500)
	dst := filepath.Join(tmp, "NAS")
	os.MkdirAll(dst, 0o755)
	opt := func(src string) map[string]any {
		return map[string]any{"sources": []string{src}, "destinations": []string{dst}, "subfolder": true}
	}

	if code, _ := c.do("POST", "/api/job/pause", map[string]any{}, nil); code != http.StatusConflict {
		t.Errorf("pause with nothing running: %d", code)
	}
	if code, out := c.do("POST", "/api/job", opt(a), nil); code != 200 {
		t.Fatalf("start: %d %v", code, out)
	}
	// pause as soon as it copies
	deadline := time.Now().Add(10 * time.Second)
	for {
		code, out := c.do("POST", "/api/job/pause", map[string]any{}, nil)
		if code == 200 && out["paused"] == true {
			break
		}
		if _, j := c.do("GET", "/api/job", nil, nil); j["status"] == "done" || time.Now().After(deadline) {
			t.Fatalf("could not pause the first backup: %d %v", code, j["status"])
		}
		time.Sleep(2 * time.Millisecond)
	}
	// a second start is still refused; the queue takes it
	if code, _ := c.do("POST", "/api/job", opt(b2), nil); code != http.StatusConflict {
		t.Errorf("second start while one runs: %d", code)
	}
	for _, src := range []string{b2, c3, gone} {
		if code, out := c.do("POST", "/api/queue", opt(src), nil); code != 200 {
			t.Fatalf("queue %s: %d %v", src, code, out)
		}
	}
	if code, _ := c.do("POST", "/api/queue", map[string]any{"sources": []string{a}, "destinations": []string{a}}, nil); code != http.StatusBadRequest {
		t.Errorf("an unsafe backup was queued: %d", code)
	}
	_, out := c.do("GET", "/api/queue", nil, nil)
	q := out["queue"].([]any)
	names := func(q []any) string {
		var n []string
		for _, it := range q {
			n = append(n, it.(map[string]any)["name"].(string))
		}
		return strings.Join(n, " | ")
	}
	if names(q) != "A002 → NAS | A003 → NAS | A004 → NAS" {
		t.Fatalf("queue: %s", names(q))
	}
	// A003 first
	_, out = c.do("POST", "/api/queue/"+q[1].(map[string]any)["id"].(string)+"/up", map[string]any{}, nil)
	if got := names(out["queue"].([]any)); got != "A003 → NAS | A002 → NAS | A004 → NAS" {
		t.Errorf("after moving up: %s", got)
	}
	// the disk of the last one goes away before its turn
	os.RemoveAll(gone)
	// still paused: nothing else has started
	time.Sleep(300 * time.Millisecond)
	if _, j := c.do("GET", "/api/job", nil, nil); j["paused"] != true || j["status"] != "copying" {
		t.Fatalf("while paused: %v %v", j["status"], j["paused"])
	}
	if code, j := c.do("POST", "/api/job/resume", map[string]any{}, nil); code != 200 || j["paused"] != false {
		t.Fatalf("resume: %d %v", code, j["paused"])
	}
	// all three run, in order, one at a time
	deadline = time.Now().Add(30 * time.Second)
	var h []any
	for {
		_, out = c.do("GET", "/api/history", nil, nil)
		h = out["history"].([]any)
		_, qv := c.do("GET", "/api/queue", nil, nil)
		if q := qv["queue"].([]any); len(h) == 3 && len(q) == 1 && q[0].(map[string]any)["error"] != nil {
			break // all three ran, and the fourth had its turn
		}
		if time.Now().After(deadline) {
			t.Fatalf("queue did not run: %d runs, queue %v", len(h), qv)
		}
		time.Sleep(20 * time.Millisecond)
	}
	var order []string
	for i := len(h) - 1; i >= 0; i-- { // history is newest first
		j := h[i].(map[string]any)
		o := j["options"].(map[string]any)
		order = append(order, filepath.Base(o["sources"].([]any)[0].(string))+":"+j["status"].(string)+":"+fmt.Sprint(o["queued"] == true)+":"+fmt.Sprint(o["label"]))
	}
	want := "A001:done:false:<nil> A003:done:true:A003 → NAS A002:done:true:A002 → NAS"
	if strings.Join(order, " ") != want {
		t.Errorf("runs: %s\nwant: %s", strings.Join(order, " "), want)
	}
	for _, n := range []string{"A001", "A002", "A003"} {
		if _, err := os.Stat(filepath.Join(dst, n, "clip.mov")); err != nil {
			t.Errorf("%s was not backed up: %v", n, err)
		}
	}
	// the one whose disk is gone stays listed with the reason, and can be removed
	_, out = c.do("GET", "/api/queue", nil, nil)
	left := out["queue"].([]any)[0].(map[string]any)
	if left["name"] != "A004 → NAS" || !strings.Contains(left["error"].(string), "not found") {
		t.Errorf("left in the queue: %v", left)
	}
	_, out = c.do("POST", "/api/queue/"+left["id"].(string)+"/delete", map[string]any{}, nil)
	if len(out["queue"].([]any)) != 0 {
		t.Errorf("after removing: %v", out["queue"])
	}
}
