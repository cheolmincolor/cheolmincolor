package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tandem/internal/engine"
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
	os.WriteFile(filepath.Join(src, "clip.mov"), bytes.Repeat([]byte("tandem"), 50000), 0o644)

	if code, out := c.do("GET", "/api/job", nil, nil); code != 200 || out["status"] != "idle" {
		t.Fatalf("initial state: %d %v", code, out)
	}
	if code, out := c.do("POST", "/api/job", map[string]any{"sources": []string{src}, "destinations": []string{src}}, nil); code != http.StatusBadRequest || !strings.Contains(out["error"].(string), "원본") {
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
	if err != nil || len(got) != 300000 {
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
