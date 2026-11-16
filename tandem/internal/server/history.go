package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"tandem/internal/engine"
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

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	historyMu.Lock()
	h := s.loadHistory()
	historyMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"history": h})
}
