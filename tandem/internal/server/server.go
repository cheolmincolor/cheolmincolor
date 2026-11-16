// Package server exposes the backup engine to the browser UI over a
// loopback-only HTTP API.
package server

import (
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"

	"tandem/internal/engine"
)

//go:embed web
var webFS embed.FS

const cookieName = "tandem_session"

// Server holds the single running (or last finished) job.
type Server struct {
	token       string
	configDir   string
	extraVolDir []string

	mu  sync.Mutex
	job *engine.Job
}

// New creates a server. configDir is where the history is kept;
// extraVolumeDirs are folders whose sub-folders are listed as disks.
func New(configDir string, extraVolumeDirs []string) *Server {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return &Server{token: hex.EncodeToString(b), configDir: configDir, extraVolDir: extraVolumeDirs}
}

// Token is the secret the browser must present; it is part of the URL the
// app opens at launch.
func (s *Server) Token() string { return s.token }

// CancelRunning stops the current job, if any, and waits for it to clean up.
func (s *Server) CancelRunning() {
	s.mu.Lock()
	j := s.job
	s.mu.Unlock()
	if j != nil {
		j.Cancel()
		j.Wait()
	}
}

// Handler returns the HTTP handler for the app.
func (s *Server) Handler() http.Handler {
	static, _ := fs.Sub(webFS, "web")
	files := http.FileServer(http.FS(static))

	api := http.NewServeMux()
	api.HandleFunc("GET /api/volumes", s.handleVolumes)
	api.HandleFunc("GET /api/browse", s.handleBrowse)
	api.HandleFunc("POST /api/mkdir", s.handleMkdir)
	api.HandleFunc("GET /api/job", s.handleJobGet)
	api.HandleFunc("POST /api/job", s.handleJobStart)
	api.HandleFunc("POST /api/job/cancel", s.handleJobCancel)
	api.HandleFunc("POST /api/job/dismiss", s.handleJobDismiss)
	api.HandleFunc("GET /api/history", s.handleHistory)
	api.HandleFunc("POST /api/reveal", s.handleReveal)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Only answer requests addressed to this machine by its loopback
		// name. This stops other websites from reaching the app through a
		// DNS name that they point at 127.0.0.1.
		if !loopbackHost(r.Host) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")

		if r.URL.Path == "/" {
			if t := r.URL.Query().Get("token"); t != "" {
				if !s.validToken(t) {
					http.Error(w, "이 주소는 더 이상 유효하지 않습니다. Tandem을 실행한 창에 표시된 주소로 접속하세요.", http.StatusForbidden)
					return
				}
				http.SetCookie(w, &http.Cookie{Name: cookieName, Value: t, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
				http.Redirect(w, r, "/", http.StatusSeeOther)
				return
			}
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			c, err := r.Cookie(cookieName)
			if err != nil || !s.validToken(c.Value) {
				writeErr(w, http.StatusUnauthorized, "세션이 만료되었습니다. Tandem을 실행한 창에 표시된 주소로 다시 접속하세요.")
				return
			}
			if r.Method != http.MethodGet {
				// State-changing calls must come from the app's own page.
				if o := r.Header.Get("Origin"); o != "" && o != "http://"+r.Host {
					writeErr(w, http.StatusForbidden, "forbidden")
					return
				}
				if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
					writeErr(w, http.StatusUnsupportedMediaType, "application/json required")
					return
				}
			}
			w.Header().Set("Cache-Control", "no-store")
			api.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'")
		files.ServeHTTP(w, r)
	})
}

func (s *Server) validToken(t string) bool {
	return subtle.ConstantTimeCompare([]byte(t), []byte(s.token)) == 1
}

func loopbackHost(hostport string) bool {
	host := hostport
	if i := strings.LastIndex(hostport, ":"); i >= 0 && !strings.HasSuffix(hostport, "]") {
		host = hostport[:i]
	}
	return host == "127.0.0.1" || host == "localhost" || host == "[::1]"
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "요청을 읽을 수 없습니다")
		return false
	}
	return true
}

// ── disks and folders ──────────────────────────────────────────────────

// Volume is a mounted disk or share offered in the picker.
type Volume struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Kind  string `json:"kind"` // "external", "system", "home"
	Free  int64  `json:"free"`
	Total int64  `json:"total"`
}

func (s *Server) volumes() []Volume {
	vols := listVolumes()
	for _, dir := range s.extraVolDir {
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			p := filepath.Join(dir, e.Name())
			if fi, err := os.Stat(p); err == nil && fi.IsDir() && !strings.HasPrefix(e.Name(), ".") {
				vols = append(vols, Volume{Name: e.Name(), Path: p, Kind: "external"})
			}
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		vols = append(vols, Volume{Name: "홈 폴더", Path: home, Kind: "home"})
	}
	seen := map[string]bool{}
	out := vols[:0]
	for _, v := range vols {
		if seen[v.Path] {
			continue
		}
		seen[v.Path] = true
		if free, total, err := engine.DiskUsage(v.Path); err == nil {
			v.Free, v.Total = free, total
		}
		out = append(out, v)
	}
	rank := map[string]int{"external": 0, "system": 1, "home": 2}
	sort.SliceStable(out, func(a, b int) bool {
		if rank[out[a].Kind] != rank[out[b].Kind] {
			return rank[out[a].Kind] < rank[out[b].Kind]
		}
		return strings.ToLower(out[a].Name) < strings.ToLower(out[b].Name)
	})
	return out
}

func (s *Server) handleVolumes(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"volumes": s.volumes()})
}

type dirEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

func (s *Server) handleBrowse(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if p == "" || !filepath.IsAbs(p) {
		writeErr(w, http.StatusBadRequest, "전체 경로를 입력하세요 (예: /Volumes/NAS/Project)")
		return
	}
	p = filepath.Clean(p)
	fi, err := os.Stat(p)
	if err != nil || !fi.IsDir() {
		writeErr(w, http.StatusNotFound, "폴더를 찾을 수 없습니다: "+p)
		return
	}
	entries, err := os.ReadDir(p)
	if err != nil {
		writeErr(w, http.StatusForbidden, "폴더를 열 수 없습니다 (권한 없음): "+p)
		return
	}
	dirs := []dirEntry{}
	files := 0
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") || engine.IsJunk(name) || name == engine.ReplacedDirName {
			continue
		}
		full := filepath.Join(p, name)
		isDir := e.IsDir()
		if e.Type()&fs.ModeSymlink != 0 {
			if t, err := os.Stat(full); err == nil {
				isDir = t.IsDir()
			}
		}
		if isDir {
			dirs = append(dirs, dirEntry{Name: name, Path: full})
		} else {
			files++
		}
	}
	sort.Slice(dirs, func(a, b int) bool { return strings.ToLower(dirs[a].Name) < strings.ToLower(dirs[b].Name) })

	parent := filepath.Dir(p)
	if parent == p {
		parent = ""
	}
	name := filepath.Base(p)
	if parent == "" {
		name = p
	}
	resp := map[string]any{"path": p, "name": name, "parent": parent, "dirs": dirs, "files": files}
	if free, total, err := engine.DiskUsage(p); err == nil {
		resp["free"], resp["total"] = free, total
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleMkdir(w http.ResponseWriter, r *http.Request) {
	var req struct{ Parent, Name string }
	if !readJSON(w, r, &req) {
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\:`) || !filepath.IsAbs(req.Parent) {
		writeErr(w, http.StatusBadRequest, "폴더 이름에 / \\ : 는 쓸 수 없습니다")
		return
	}
	p := filepath.Join(filepath.Clean(req.Parent), name)
	if err := os.Mkdir(p, 0o755); err != nil {
		if errors.Is(err, fs.ErrExist) {
			writeErr(w, http.StatusConflict, "같은 이름의 폴더가 이미 있습니다")
		} else {
			writeErr(w, http.StatusForbidden, "폴더를 만들 수 없습니다: "+err.Error())
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": p})
}

// ── job ────────────────────────────────────────────────────────────────

func (s *Server) handleJobGet(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	j := s.job
	s.mu.Unlock()
	if j == nil {
		writeJSON(w, http.StatusOK, map[string]string{"status": "idle"})
		return
	}
	writeJSON(w, http.StatusOK, j.Snapshot())
}

func (s *Server) handleJobStart(w http.ResponseWriter, r *http.Request) {
	var opts engine.Options
	if !readJSON(w, r, &opts) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.job != nil && !s.job.Snapshot().Status.Finished() {
		writeErr(w, http.StatusConflict, "이미 백업이 진행 중입니다")
		return
	}
	j, err := engine.Start(opts, s.appendHistory)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.job = j
	writeJSON(w, http.StatusOK, j.Snapshot())
}

func (s *Server) handleJobCancel(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	j := s.job
	s.mu.Unlock()
	if j != nil {
		j.Cancel()
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleJobDismiss clears a finished job so the start screen is shown again.
func (s *Server) handleJobDismiss(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.job != nil && !s.job.Snapshot().Status.Finished() {
		writeErr(w, http.StatusConflict, "백업이 아직 진행 중입니다")
		return
	}
	s.job = nil
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleReveal opens a folder in the system file manager.
func (s *Server) handleReveal(w http.ResponseWriter, r *http.Request) {
	var req struct{ Path string }
	if !readJSON(w, r, &req) {
		return
	}
	fi, err := os.Stat(req.Path)
	if err != nil || !fi.IsDir() || !filepath.IsAbs(req.Path) {
		writeErr(w, http.StatusNotFound, "폴더를 찾을 수 없습니다")
		return
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", "--", req.Path)
	case "windows":
		cmd = exec.Command("explorer", req.Path)
	default:
		cmd = exec.Command("xdg-open", req.Path)
	}
	if err := cmd.Start(); err != nil {
		writeErr(w, http.StatusInternalServerError, "폴더를 열 수 없습니다: "+req.Path)
		return
	}
	go func() { _ = cmd.Wait() }()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
