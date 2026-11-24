package server

// The queue: backups added while another one is running. They start by
// themselves, one after another, in the order shown. Only one backup runs
// at a time, so two jobs never fight over the same card or NAS.
//
// The queue lives in memory: quitting G-Copy empties it (a backup must
// never start by surprise the next time the app is opened).

import (
	"context"
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
	Held    bool           `json:"held"`            // being edited: it does not start until saved or released

	// Scan: read in the background, so the screen can say before its
	// turn whether the destinations have room for it.
	Scan *QueueScan `json:"scan"`

	gen    int                // changes whenever the backup is edited; a scan of an older version is thrown away
	cancel context.CancelFunc // stops its scan
}

// QueueScan is what a queued backup would copy, and whether it will fit.
type QueueScan struct {
	State   string          `json:"state"` // "waiting", "scanning", "done", "failed"
	Message string          `json:"message,omitempty"`
	Preview *engine.Preview `json:"preview,omitempty"`
	Room    []QueueRoom     `json:"room"` // per destination, worked out when the list is shown
}

// QueueRoom is one destination of a queued backup: what it needs, and
// about how much will be free when its turn comes (after the backups
// running and queued before it have written what they need).
type QueueRoom struct {
	Path       string `json:"path"`
	Need       int64  `json:"need"`
	FreeNow    int64  `json:"freeNow"` // -1 if the disk does not say
	Total      int64  `json:"total"`
	Ahead      int64  `json:"ahead"` // what the backups before it still have to write to that disk
	FreeAtTurn int64  `json:"freeAtTurn"`
	Fits       bool   `json:"fits"`
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
		if it.Error == "" && !it.Held {
			s.queue = append(s.queue[:i:i], s.queue[i+1:]...)
			if it.cancel != nil {
				it.cancel() // its own run reads the source now
			}
			return it
		}
	}
	return nil
}

func (s *Server) queueView() map[string]any {
	s.mu.Lock()
	items := make([]QueueItem, 0, len(s.queue))
	for _, it := range s.queue {
		c := *it
		if it.Scan != nil {
			sc := *it.Scan
			c.Scan = &sc
		}
		items = append(items, c)
	}
	var running *engine.State
	if s.job != nil {
		if st := s.job.Snapshot(); !st.Status.Finished() {
			running = &st
		}
	}
	s.mu.Unlock()

	// Free space now, once per disk; then, in queue order, what each
	// backup will leave for the next.
	type disk struct{ free, total, ahead int64 }
	disks := map[string]*disk{}
	diskOf := func(path, key string) *disk {
		if d := disks[key]; d != nil {
			return d
		}
		d := &disk{free: -1}
		if free, total, err := engine.DiskUsage(path); err == nil {
			d.free, d.total = free, total
		}
		disks[key] = d
		return d
	}
	if running != nil {
		for _, ds := range running.Dests {
			left := ds.Need - ds.Bytes // still to be written by the backup that is running
			if left < 0 || running.Status == engine.StatusScanning || running.Status == engine.StatusComparing {
				left = 0 // not known yet
			}
			diskOf(ds.Path, engine.VolumeKey(ds.Path)).ahead += left
		}
	}
	for i := range items {
		it := &items[i]
		if it.Scan == nil || it.Scan.Preview == nil {
			continue
		}
		it.Scan.Room = []QueueRoom{}
		for _, pd := range it.Scan.Preview.Dests {
			d := diskOf(pd.Path, pd.Volume)
			r := QueueRoom{Path: pd.Path, Need: pd.Need, FreeNow: d.free, Total: d.total, Ahead: d.ahead}
			if d.free >= 0 {
				r.FreeAtTurn = d.free - d.ahead
				r.Fits = r.FreeAtTurn >= pd.Need
			} else {
				r.FreeAtTurn, r.Fits = -1, true // unknown: do not cry wolf
			}
			it.Scan.Room = append(it.Scan.Room, r)
			d.ahead += pd.Need
		}
	}
	return map[string]any{"queue": items}
}

// ── scanning queued backups in the background ───────────────────────────

// kickScans asks the scanner to look at the queue. With all, every backup
// is read again (a backup has finished: what is on the destinations changed).
func (s *Server) kickScans(all bool) {
	s.mu.Lock()
	if all {
		for _, it := range s.queue {
			if it.Scan != nil && it.Scan.State != "scanning" {
				it.Scan.State = "waiting"
			}
		}
	}
	if s.scanKick == nil {
		s.scanKick = make(chan struct{}, 1)
		go s.scanLoop()
	}
	s.mu.Unlock()
	select {
	case s.scanKick <- struct{}{}:
	default:
	}
}

// scanLoop reads the queued backups one at a time, first to last. One at a
// time and only file sizes and dates: it stays out of the copy's way.
func (s *Server) scanLoop() {
	for range s.scanKick {
		for {
			s.mu.Lock()
			if s.closing {
				s.mu.Unlock()
				return
			}
			var it *QueueItem
			for _, q := range s.queue {
				if q.Scan == nil || q.Scan.State == "waiting" {
					it = q
					break
				}
			}
			if it == nil {
				s.mu.Unlock()
				break
			}
			ctx, cancel := context.WithCancel(context.Background())
			it.cancel = cancel
			gen, opts := it.gen, it.Options
			prev := it.Scan
			it.Scan = &QueueScan{State: "scanning"}
			if prev != nil && prev.Preview != nil {
				it.Scan.Preview = prev.Preview // keep showing the last numbers meanwhile
			}
			s.mu.Unlock()

			p, err := engine.PreviewBackup(ctx, opts)
			cancel()

			s.mu.Lock()
			if it.gen == gen && s.inQueueLocked(it) {
				if err != nil {
					it.Scan = &QueueScan{State: "failed", Message: err.Error()}
				} else {
					it.Scan = &QueueScan{State: "done", Preview: &p}
				}
			}
			s.mu.Unlock()
		}
	}
}

func (s *Server) inQueueLocked(it *QueueItem) bool {
	for _, q := range s.queue {
		if q == it {
			return true
		}
	}
	return false
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
	s.kickScans(false)
	writeJSON(w, http.StatusOK, s.queueView())
}

func (s *Server) handleQueueDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.mu.Lock()
	for i, it := range s.queue {
		if it.ID == id {
			s.queue = append(s.queue[:i:i], s.queue[i+1:]...)
			if it.cancel != nil {
				it.cancel()
			}
			break
		}
	}
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, s.queueView())
}

// handleQueueHold keeps a queued backup from starting while it is being
// edited ({"held": true}), or lets it go again ({"held": false}).
func (s *Server) handleQueueHold(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Held bool `json:"held"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	s.mu.Lock()
	it := s.findQueuedLocked(r.PathValue("id"))
	if it != nil {
		it.Held = req.Held
	}
	s.mu.Unlock()
	if it == nil {
		writeErr(w, http.StatusNotFound, "This backup is no longer in the queue: it has started, or was removed.")
		return
	}
	if !req.Held {
		s.startQueued() // it may be its turn already
	}
	writeJSON(w, http.StatusOK, s.queueView())
}

// handleQueueUpdate changes what a queued backup copies, and where to.
func (s *Server) handleQueueUpdate(w http.ResponseWriter, r *http.Request) {
	var opts engine.Options
	if !readJSON(w, r, &opts) {
		return
	}
	opts.Label, opts.Unattended, opts.Queued = "", false, false
	screenOptions(&opts)
	if err := engine.Check(opts); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.mu.Lock()
	it := s.findQueuedLocked(r.PathValue("id"))
	if it != nil {
		it.Options, it.Name, it.Error, it.Held = opts, queueName(opts), "", false
		it.gen++
		if it.cancel != nil {
			it.cancel()
		}
		it.Scan = nil // read it again
	}
	s.mu.Unlock()
	if it == nil {
		writeErr(w, http.StatusNotFound, "This backup is no longer in the queue: it has started, or was removed. Your changes were not saved — use Add to Queue to add them as a new backup.")
		return
	}
	s.startQueued()
	s.kickScans(false)
	writeJSON(w, http.StatusOK, s.queueView())
}

func (s *Server) findQueuedLocked(id string) *QueueItem {
	for _, it := range s.queue {
		if it.ID == id {
			return it
		}
	}
	return nil
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
