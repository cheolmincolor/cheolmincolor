package server

// Scheduled runs.
//
// A schedule is a saved backup (sources, destinations, options) plus a
// repeat rule. While the engine runs, a loop checks every few seconds for
// schedules that are due and runs them one at a time, after any backup
// already running. A run that was missed because G-Copy was closed or the
// Mac was asleep is made up once, as soon as possible; several missed runs
// of the same schedule count as one.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"gcopy/internal/engine"
)

const tickEvery = 10 * time.Second

// When says how often a schedule repeats.
type When struct {
	Kind  string `json:"kind"`            // "daily", "weekly" or "hours"
	Time  string `json:"time,omitempty"`  // "HH:MM", local time (daily, weekly)
	Days  []int  `json:"days,omitempty"`  // weekly: 0 = Sunday … 6 = Saturday
	Hours int    `json:"hours,omitempty"` // hours: every so many hours
}

// LastRun is how the most recent run of a schedule went.
type LastRun struct {
	At      time.Time `json:"at"`
	Status  string    `json:"status"` // done, failed, cancelled, skipped
	Message string    `json:"message,omitempty"`
	JobID   string    `json:"jobId,omitempty"`
	Copied  int64     `json:"copied"`
	Failed  int64     `json:"failed"`
	Removed int64     `json:"removed"`
}

// Schedule is one saved, repeating backup.
type Schedule struct {
	ID      string         `json:"id"`
	Name    string         `json:"name"`
	Options engine.Options `json:"options"`
	When    When           `json:"when"`
	Enabled bool           `json:"enabled"`
	Created time.Time      `json:"created"`
	NextRun *time.Time     `json:"nextRun,omitempty"` // nil while disabled
	Last    *LastRun       `json:"last,omitempty"`
}

type scheduler struct {
	mu      sync.Mutex
	list    []*Schedule
	queue   []string          // schedule ids waiting for their turn
	running string            // schedule id of the job now running, if any
	byJob   map[string]string // job id -> schedule id
}

// ── repeat rules ─────────────────────────────────────────────────────────

var hourChoices = map[int]bool{1: true, 2: true, 3: true, 4: true, 6: true, 8: true, 12: true, 24: true}

func parseClock(s string) (h, m int, err error) {
	parts := strings.Split(s, ":")
	if len(parts) == 2 && len(parts[0]) == 2 && len(parts[1]) == 2 {
		h, e1 := strconv.Atoi(parts[0])
		m, e2 := strconv.Atoi(parts[1])
		if e1 == nil && e2 == nil && h >= 0 && h < 24 && m >= 0 && m < 60 {
			return h, m, nil
		}
	}
	return 0, 0, fmt.Errorf("Enter a time between 00:00 and 23:59: %q", s)
}

func (w *When) validate() error {
	switch w.Kind {
	case "daily":
		w.Days, w.Hours = nil, 0
		_, _, err := parseClock(w.Time)
		return err
	case "weekly":
		w.Hours = 0
		if _, _, err := parseClock(w.Time); err != nil {
			return err
		}
		seen := map[int]bool{}
		var days []int
		for _, d := range w.Days {
			if d < 0 || d > 6 {
				return fmt.Errorf("Invalid day of the week: %d", d)
			}
			if !seen[d] {
				seen[d] = true
				days = append(days, d)
			}
		}
		if len(days) == 0 {
			return errors.New("Choose at least one day")
		}
		sort.Ints(days)
		w.Days = days
		return nil
	case "hours":
		w.Time, w.Days = "", nil
		if !hourChoices[w.Hours] {
			return errors.New("Choose an interval of 1, 2, 3, 4, 6, 8, 12 or 24 hours")
		}
		return nil
	}
	return fmt.Errorf("Invalid repeat type: %q", w.Kind)
}

// next returns the first time after t at which the rule fires.
func (w When) next(t time.Time) time.Time {
	if w.Kind == "hours" {
		return t.Add(time.Duration(w.Hours) * time.Hour).Truncate(time.Minute)
	}
	h, m, _ := parseClock(w.Time)
	for i := 0; i <= 7; i++ {
		// time.Date normalises day overflow and handles daylight saving.
		c := time.Date(t.Year(), t.Month(), t.Day()+i, h, m, 0, 0, t.Location())
		if !c.After(t) {
			continue
		}
		if w.Kind == "daily" {
			return c
		}
		for _, d := range w.Days {
			if int(c.Weekday()) == d {
				return c
			}
		}
	}
	return t.Add(24 * time.Hour) // unreachable for a validated rule
}

// ── storage ──────────────────────────────────────────────────────────────

func (s *Server) schedulesPath() string { return filepath.Join(s.configDir, "schedules.json") }

func (s *Server) loadSchedules() {
	s.sched.byJob = map[string]string{}
	data, err := os.ReadFile(s.schedulesPath())
	if err != nil {
		return
	}
	var list []*Schedule
	if json.Unmarshal(data, &list) == nil {
		s.sched.list = list
	}
}

// saveSchedules writes the list; the caller holds s.sched.mu.
func (s *Server) saveSchedules() error {
	data, err := json.MarshalIndent(s.sched.list, "", " ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.configDir, 0o755); err != nil {
		return err
	}
	tmp := s.schedulesPath() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.schedulesPath())
}

func (s *Server) findSchedule(id string) *Schedule {
	for _, sc := range s.sched.list {
		if sc.ID == id {
			return sc
		}
	}
	return nil
}

// ── the loop ─────────────────────────────────────────────────────────────

// RunScheduler checks for due schedules until stop is closed.
func (s *Server) RunScheduler(stop <-chan struct{}) {
	s.tick(s.now())
	t := time.NewTicker(tickEvery)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			s.tick(s.now())
		}
	}
}

// tick queues every schedule that is due at now and starts the next one if
// nothing is running.
func (s *Server) tick(now time.Time) {
	s.sched.mu.Lock()
	changed := false
	for _, sc := range s.sched.list {
		if !sc.Enabled || sc.NextRun == nil || sc.NextRun.After(now) {
			continue
		}
		next := sc.When.next(now) // missed runs collapse into this one
		sc.NextRun = &next
		changed = true
		s.enqueueLocked(sc.ID)
	}
	if changed {
		_ = s.saveSchedules()
	}
	s.sched.mu.Unlock()
	s.startQueued()
}

func (s *Server) enqueueLocked(id string) {
	if s.sched.running == id {
		return
	}
	for _, q := range s.sched.queue {
		if q == id {
			return
		}
	}
	s.sched.queue = append(s.sched.queue, id)
}

// startQueued starts the first queued schedule if no backup is running.
func (s *Server) startQueued() {
	for {
		s.mu.Lock()
		if s.closing || (s.job != nil && !s.job.Snapshot().Status.Finished()) {
			s.mu.Unlock()
			return // its end calls us again
		}
		s.sched.mu.Lock()
		if len(s.sched.queue) == 0 {
			s.sched.mu.Unlock()
			s.mu.Unlock()
			return
		}
		id := s.sched.queue[0]
		s.sched.queue = s.sched.queue[1:]
		sc := s.findSchedule(id)
		if sc == nil {
			s.sched.mu.Unlock()
			s.mu.Unlock()
			continue // deleted while waiting
		}
		opts := sc.Options
		opts.Label, opts.Unattended = sc.Name, true
		opts.HintSpeed = s.speedHint(opts.Destinations)
		j, err := engine.Start(opts, s.jobFinished)
		if err != nil {
			status := "failed"
			if engine.IsMissing(err) {
				status = "skipped" // the disk is just not connected right now
			}
			sc.Last = &LastRun{At: s.now(), Status: status, Message: err.Error()}
			_ = s.saveSchedules()
			s.sched.mu.Unlock()
			s.mu.Unlock()
			continue
		}
		s.job = j
		s.sched.running = id
		s.sched.byJob[j.ID()] = id
		s.sched.mu.Unlock()
		s.mu.Unlock()
		return
	}
}

// jobFinished is called by the engine at the end of every run.
func (s *Server) jobFinished(st engine.State) {
	s.appendHistory(st)
	s.sched.mu.Lock()
	if id, ok := s.sched.byJob[st.ID]; ok {
		delete(s.sched.byJob, st.ID)
		if s.sched.running == id {
			s.sched.running = ""
		}
		if sc := s.findSchedule(id); sc != nil {
			last := &LastRun{At: s.now(), Status: string(st.Status), Message: st.Message, JobID: st.ID, Copied: st.FilesCopied, Failed: st.FilesFailed}
			for _, d := range st.Dests {
				last.Removed += d.Removed
			}
			if last.Message == "" && st.ErrorCount > 0 {
				last.Message = fmt.Sprintf("%d problem(s)", st.ErrorCount)
			}
			sc.Last = last
			_ = s.saveSchedules()
		}
	}
	s.sched.mu.Unlock()
	// The run is still marked as running until the engine returns from
	// this call; start the next one just after.
	go func() { time.Sleep(50 * time.Millisecond); s.startQueued() }()
}

// ── API ──────────────────────────────────────────────────────────────────

type scheduleView struct {
	*Schedule
	Queued  bool `json:"queued"`
	Running bool `json:"running"`
}

func (s *Server) scheduleList() map[string]any {
	s.sched.mu.Lock()
	defer s.sched.mu.Unlock()
	queued := map[string]bool{}
	for _, q := range s.sched.queue {
		queued[q] = true
	}
	out := []scheduleView{}
	for _, sc := range s.sched.list {
		out = append(out, scheduleView{Schedule: sc, Queued: queued[sc.ID], Running: s.sched.running == sc.ID})
	}
	return map[string]any{"schedules": out}
}

func (s *Server) handleSchedules(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.scheduleList())
}

type scheduleInput struct {
	Name    *string         `json:"name"`
	Options *engine.Options `json:"options"`
	When    *When           `json:"when"`
	Enabled *bool           `json:"enabled"`
}

func cleanName(n string) (string, error) {
	n = strings.TrimSpace(n)
	if n == "" {
		return "", errors.New("Enter a name")
	}
	if len([]rune(n)) > 60 {
		return "", errors.New("Keep the name within 60 characters")
	}
	return n, nil
}

func (s *Server) handleScheduleCreate(w http.ResponseWriter, r *http.Request) {
	var in scheduleInput
	if !readJSON(w, r, &in) {
		return
	}
	if in.Name == nil || in.Options == nil || in.When == nil {
		writeErr(w, http.StatusBadRequest, "A name, backup settings and a repeat rule are required")
		return
	}
	name, err := cleanName(*in.Name)
	if err == nil {
		err = in.When.validate()
	}
	opts := *in.Options
	opts.Label, opts.Unattended = "", false
	if err == nil {
		err = engine.Check(opts) // the same checks as a manual start
	}
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	now := s.now()
	next := in.When.next(now)
	sc := &Schedule{ID: hex.EncodeToString(b), Name: name, Options: opts, When: *in.When, Enabled: true, Created: now, NextRun: &next}
	if in.Enabled != nil && !*in.Enabled {
		sc.Enabled, sc.NextRun = false, nil
	}
	s.sched.mu.Lock()
	s.sched.list = append(s.sched.list, sc)
	err = s.saveSchedules()
	s.sched.mu.Unlock()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Cannot save the schedule: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, sc)
}

func (s *Server) handleScheduleUpdate(w http.ResponseWriter, r *http.Request) {
	var in scheduleInput
	if !readJSON(w, r, &in) {
		return
	}
	s.sched.mu.Lock()
	defer s.sched.mu.Unlock()
	sc := s.findSchedule(r.PathValue("id"))
	if sc == nil {
		writeErr(w, http.StatusNotFound, "Schedule not found")
		return
	}
	upd := *sc
	if in.Name != nil {
		n, err := cleanName(*in.Name)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		upd.Name = n
	}
	if in.When != nil {
		if err := in.When.validate(); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		upd.When = *in.When
	}
	if in.Enabled != nil {
		upd.Enabled = *in.Enabled
	}
	if in.When != nil || in.Enabled != nil {
		upd.NextRun = nil
		if upd.Enabled {
			next := upd.When.next(s.now())
			upd.NextRun = &next
		}
	}
	*sc = upd
	if err := s.saveSchedules(); err != nil {
		writeErr(w, http.StatusInternalServerError, "Cannot save the schedule: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, sc)
}

func (s *Server) handleScheduleDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.sched.mu.Lock()
	defer s.sched.mu.Unlock()
	for i, sc := range s.sched.list {
		if sc.ID == id {
			s.sched.list = append(s.sched.list[:i], s.sched.list[i+1:]...)
			q := s.sched.queue[:0]
			for _, x := range s.sched.queue {
				if x != id {
					q = append(q, x)
				}
			}
			s.sched.queue = q
			_ = s.saveSchedules()
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return
		}
	}
	writeErr(w, http.StatusNotFound, "Schedule not found")
}

// handleScheduleRun runs a schedule now (after any backup that is running).
func (s *Server) handleScheduleRun(w http.ResponseWriter, r *http.Request) {
	s.sched.mu.Lock()
	sc := s.findSchedule(r.PathValue("id"))
	if sc != nil {
		s.enqueueLocked(sc.ID)
	}
	s.sched.mu.Unlock()
	if sc == nil {
		writeErr(w, http.StatusNotFound, "Schedule not found")
		return
	}
	s.startQueued()
	writeJSON(w, http.StatusOK, s.scheduleList())
}
