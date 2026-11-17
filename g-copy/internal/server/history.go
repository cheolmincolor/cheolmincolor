package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"gcopy/internal/engine"
)

const historyMax = 200

var historyMu sync.Mutex

func (s *Server) historyPath() string { return filepath.Join(s.configDir, "history.json") }

func (s *Server) loadHistory() []engine.State {
	data, err := os.ReadFile(s.historyPath())
	if err != nil {
		return []engine.State{}
	}
	var h []engine.State
	if json.Unmarshal(data, &h) != nil {
		return []engine.State{}
	}
	return h
}

// appendHistory records a finished job, newest first.
func (s *Server) appendHistory(st engine.State) {
	historyMu.Lock()
	defer historyMu.Unlock()
	if len(st.Errors) > 20 { // the full list is on screen; keep the log small
		st.Errors = st.Errors[:20]
	}
	st.Current = nil
	h := append([]engine.State{st}, s.loadHistory()...)
	if len(h) > historyMax {
		h = h[:historyMax]
	}
	data, err := json.MarshalIndent(h, "", " ")
	if err != nil {
		return
	}
	if os.MkdirAll(s.configDir, 0o755) != nil {
		return
	}
	tmp := s.historyPath() + ".tmp"
	if os.WriteFile(tmp, data, 0o644) == nil {
		_ = os.Rename(tmp, s.historyPath())
	}
}

// Preferences (last destinations, options, recent folders) are kept by the
// engine, not by the browser: the desktop app's window gets a new address at
// every launch, so anything stored on the browser side would be forgotten.

func (s *Server) settingsPath() string { return filepath.Join(s.configDir, "settings.json") }

func (s *Server) handleSettingsGet(w http.ResponseWriter, r *http.Request) {
	historyMu.Lock()
	data, err := os.ReadFile(s.settingsPath())
	historyMu.Unlock()
	var v map[string]any
	if err != nil || json.Unmarshal(data, &v) != nil || v == nil {
		v = map[string]any{}
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) handleSettingsSet(w http.ResponseWriter, r *http.Request) {
	var v map[string]any
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := json.NewDecoder(r.Body).Decode(&v); err != nil || v == nil {
		writeErr(w, http.StatusBadRequest, "설정을 읽을 수 없습니다")
		return
	}
	data, _ := json.MarshalIndent(v, "", " ")
	historyMu.Lock()
	defer historyMu.Unlock()
	if err := os.MkdirAll(s.configDir, 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, "설정을 저장할 수 없습니다")
		return
	}
	tmp := s.settingsPath() + ".tmp"
	if os.WriteFile(tmp, data, 0o644) != nil || os.Rename(tmp, s.settingsPath()) != nil {
		writeErr(w, http.StatusInternalServerError, "설정을 저장할 수 없습니다")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	historyMu.Lock()
	h := s.loadHistory()
	historyMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"history": h})
}
