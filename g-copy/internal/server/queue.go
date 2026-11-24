package server

// The queue: backups added while another one is running. They start by
// themselves, one after another, in the order shown. Only one backup runs
// at a time, so two jobs never fight over the same card or NAS.
//
// The queue lives in memory: quitting G-Copy empties it (a backup must
// never start by surprise the next time the app is opened).

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"gcopy/internal/engine"
)

// QueueItem is one backup waiting for its turn.
type QueueItem struct {
	ID      string         `json:"id"`
	Name    string         `json:"name"` // "A002 → NAS", shown in the list and while it runs
	Options engine.Options `json:"options"`
	Added   time.Time      `json:"added"`
	Error   string         `json:"error,omitempty"` // could not start when its turn came; it stays listed
}

func queueName(o engine.Options) string {
	base := func(list []string) string {
		names := make([]string, len(list))
		for i, p := range list {
			names[i] = filepath.Base(p)
		}
		return strings.Join(names, ", ")
	}
	return base(o.Sources) + " → " + base(o.Destinations)
}

// nextQueuedLocked takes the first queued backup that has not failed to
// start. The caller holds s.mu.
func (s *Server) nextQueuedLocked() *QueueItem {
	for i, it := range s.queue {
		if it.Error == "" {
			s.queue = append(s.queue[:i:i], s.queue[i+1:]...)
			return it
		}
	}
	return nil
}

func (s *Server) queueView() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]QueueItem, 0, len(s.queue))
	for _, it := range s.queue {
		out = append(out, *it)
	}
	return map[string]any{"queue": out}
}

func (s *Server) handleQueue(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.queueView())
}

func (s *Server) handleQueueAdd(w http.ResponseWriter, r *http.Request) {
	var opts engine.Options
	if !readJSON(w, r, &opts) {
		return
	}
	opts.Label, opts.Unattended, opts.Queued = "", false, false
	screenOptions(&opts)
	if err := engine.Check(opts); err != nil { // the same checks as a start, now rather than when its turn comes
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	it := &QueueItem{ID: hex.EncodeToString(b), Name: queueName(opts), Options: opts, Added: s.now()}
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		writeErr(w, http.StatusConflict, "G-Copy is quitting")
		return
	}
	if len(s.queue) >= 50 {
		s.mu.Unlock()
		writeErr(w, http.StatusConflict, "The queue is full (50 backups). Wait for some to finish.")
		return
	}
	s.queue = append(s.queue, it)
	s.mu.Unlock()
	s.startQueued() // nothing running: it starts at once
	writeJSON(w, http.StatusOK, s.queueView())
}

func (s *Server) handleQueueDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.mu.Lock()
	for i, it := range s.queue {
		if it.ID == id {
			s.queue = append(s.queue[:i:i], s.queue[i+1:]...)
			break
		}
	}
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, s.queueView())
}

// handleQueueUp moves a queued backup one place earlier.
func (s *Server) handleQueueUp(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.mu.Lock()
	for i, it := range s.queue {
		if it.ID == id && i > 0 {
			s.queue[i-1], s.queue[i] = s.queue[i], s.queue[i-1]
			break
		}
	}
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, s.queueView())
}

// handleJobPause puts the running backup on hold; handleJobResume continues it.
func (s *Server) handleJobPause(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	j := s.job
	s.mu.Unlock()
	if j == nil || !j.Pause() {
		writeErr(w, http.StatusConflict, "There is nothing to pause right now. A backup can be paused while it is copying.")
		return
	}
	writeJSON(w, http.StatusOK, j.Snapshot())
}

func (s *Server) handleJobResume(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	j := s.job
	s.mu.Unlock()
	if j == nil {
		writeErr(w, http.StatusConflict, "There is no backup to resume")
		return
	}
	j.Resume()
	writeJSON(w, http.StatusOK, j.Snapshot())
}
