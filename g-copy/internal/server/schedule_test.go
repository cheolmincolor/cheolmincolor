package server

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var seoul = time.FixedZone("KST", 9*3600)

func at(s string) time.Time {
	t, err := time.ParseInLocation("2006-01-02 15:04", s, seoul)
	if err != nil {
		panic(err)
	}
	return t
}

func TestRepeatRules(t *testing.T) {
	// 2026-11-17 is a Tuesday.
	cases := []struct {
		w     When
		after string
		want  string
	}{
		{When{Kind: "daily", Time: "02:00"}, "2026-11-17 01:00", "2026-11-17 02:00"},
		{When{Kind: "daily", Time: "02:00"}, "2026-11-17 02:00", "2026-11-18 02:00"}, // not the same minute again
		{When{Kind: "daily", Time: "23:30"}, "2026-12-31 23:45", "2027-01-01 23:30"},
		{When{Kind: "weekly", Time: "09:00", Days: []int{1, 5}}, "2026-11-17 10:00", "2026-11-20 09:00"}, // Tue → Fri
		{When{Kind: "weekly", Time: "09:00", Days: []int{1, 5}}, "2026-11-20 09:30", "2026-11-23 09:00"}, // Fri → Mon
		{When{Kind: "weekly", Time: "09:00", Days: []int{2}}, "2026-11-17 08:59", "2026-11-17 09:00"},
		{When{Kind: "weekly", Time: "09:00", Days: []int{2}}, "2026-11-17 09:00", "2026-11-24 09:00"},
		{When{Kind: "hours", Hours: 6}, "2026-11-17 10:20", "2026-11-17 16:20"},
	}
	for _, c := range cases {
		if err := c.w.validate(); err != nil {
			t.Fatalf("%+v: %v", c.w, err)
		}
		got := c.w.next(at(c.after)).Format("2006-01-02 15:04")
		if got != c.want {
			t.Errorf("%+v after %s: %s, want %s", c.w, c.after, got, c.want)
		}
	}
	for _, bad := range []When{
		{Kind: "daily", Time: "24:00"}, {Kind: "daily", Time: "9:00"}, {Kind: "daily"},
		{Kind: "weekly", Time: "09:00"}, {Kind: "weekly", Time: "09:00", Days: []int{7}},
		{Kind: "hours", Hours: 5}, {Kind: "monthly", Time: "09:00"},
	} {
		if err := bad.validate(); err == nil {
			t.Errorf("%+v was accepted", bad)
		}
	}
}

// fixture: a server with a controllable clock and a small card + NAS.
type fixture struct {
	s        *Server
	c        *client
	src, dst string
	mu       sync.Mutex
	clock    time.Time
}

func newFixture(t *testing.T) *fixture {
	f := &fixture{clock: at("2026-11-17 01:00")}
	s, _, c := setup(t)
	s.now = func() time.Time { f.mu.Lock(); defer f.mu.Unlock(); return f.clock }
	f.s, f.c = s, c
	tmp := t.TempDir()
	f.src, f.dst = filepath.Join(tmp, "A001"), filepath.Join(tmp, "NAS")
	os.MkdirAll(f.src, 0o755)
	os.MkdirAll(f.dst, 0o755)
	os.WriteFile(filepath.Join(f.src, "clip.mov"), []byte(strings.Repeat("x", 100000)), 0o644)
	return f
}

func (f *fixture) setClock(s string) { f.mu.Lock(); f.clock = at(s); f.mu.Unlock() }

func (f *fixture) create(t *testing.T, name string, when map[string]any, extra map[string]any) string {
	t.Helper()
	opts := map[string]any{"sources": []string{f.src}, "destinations": []string{f.dst}, "subfolder": true}
	for k, v := range extra {
		opts[k] = v
	}
	code, out := f.c.do("POST", "/api/schedules", map[string]any{"name": name, "options": opts, "when": when}, nil)
	if code != 200 {
		t.Fatalf("create: %d %v", code, out)
	}
	return out["id"].(string)
}

func (f *fixture) schedule(t *testing.T, id string) map[string]any {
	t.Helper()
	_, out := f.c.do("GET", "/api/schedules", nil, nil)
	for _, x := range out["schedules"].([]any) {
		if m := x.(map[string]any); m["id"] == id {
			return m
		}
	}
	t.Fatalf("schedule %s not listed", id)
	return nil
}

func (f *fixture) waitIdle(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		f.s.mu.Lock()
		j := f.s.job
		f.s.mu.Unlock()
		f.s.sched.mu.Lock()
		busy := f.s.sched.running != "" || len(f.s.sched.queue) > 0
		f.s.sched.mu.Unlock()
		if !busy && (j == nil || j.Snapshot().Status.Finished()) {
			time.Sleep(100 * time.Millisecond) // let a queued start happen
			f.s.sched.mu.Lock()
			busy = f.s.sched.running != "" || len(f.s.sched.queue) > 0
			f.s.sched.mu.Unlock()
			if !busy {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("scheduled work did not finish")
}

func TestScheduleRunsWhenDueAndRecordsTheResult(t *testing.T) {
	f := newFixture(t)
	id := f.create(t, "매일 새벽", map[string]any{"kind": "daily", "time": "02:00"}, nil)
	if got := f.schedule(t, id)["nextRun"].(string); !strings.HasPrefix(got, "2026-11-17T02:00:00") {
		t.Fatalf("next run %s", got)
	}

	f.s.tick(f.s.now()) // 01:00: not yet
	if _, err := os.Stat(filepath.Join(f.dst, "A001")); err == nil {
		t.Fatal("ran before its time")
	}
	f.setClock("2026-11-17 02:00")
	f.s.tick(f.s.now())
	f.waitIdle(t)

	if _, err := os.Stat(filepath.Join(f.dst, "A001", "clip.mov")); err != nil {
		t.Fatal("the scheduled backup did not copy the file")
	}
	sc := f.schedule(t, id)
	last := sc["last"].(map[string]any)
	if last["status"] != "done" || last["copied"].(float64) != 1 || !strings.HasPrefix(sc["nextRun"].(string), "2026-11-18T02:00:00") {
		t.Errorf("after the run: last %v, next %v", last, sc["nextRun"])
	}
	// The run is in the history, marked with the schedule's name.
	_, out := f.c.do("GET", "/api/history", nil, nil)
	h := out["history"].([]any)[0].(map[string]any)
	if h["options"].(map[string]any)["label"] != "매일 새벽" {
		t.Errorf("history entry not labelled: %v", h["options"])
	}
}

func TestMissedRunsAreMadeUpOnce(t *testing.T) {
	f := newFixture(t)
	id := f.create(t, "매일", map[string]any{"kind": "daily", "time": "02:00"}, nil)
	f.setClock("2026-11-20 15:00") // G-Copy was closed for three nights
	f.s.tick(f.s.now())
	f.waitIdle(t)
	f.s.tick(f.s.now())
	f.waitIdle(t)
	_, out := f.c.do("GET", "/api/history", nil, nil)
	if n := len(out["history"].([]any)); n != 1 {
		t.Errorf("%d runs, want exactly 1 catch-up run", n)
	}
	if next := f.schedule(t, id)["nextRun"].(string); !strings.HasPrefix(next, "2026-11-21T02:00:00") {
		t.Errorf("next run %s", next)
	}
}

func TestUnpluggedDiskIsSkippedNotFailed(t *testing.T) {
	f := newFixture(t)
	id := f.create(t, "카드", map[string]any{"kind": "hours", "hours": 1}, nil)
	os.RemoveAll(f.src) // the card is not in the reader
	f.setClock("2026-11-17 02:00")
	f.s.tick(f.s.now())
	f.waitIdle(t)
	last := f.schedule(t, id)["last"].(map[string]any)
	if last["status"] != "skipped" || !strings.Contains(last["message"].(string), "not found") {
		t.Errorf("last %v", last)
	}
	_, out := f.c.do("GET", "/api/history", nil, nil)
	if n := len(out["history"].([]any)); n != 0 {
		t.Errorf("a skipped run was put in the history (%d entries)", n)
	}
}

func TestSchedulesWaitForTheirTurn(t *testing.T) {
	f := newFixture(t)
	dst2 := filepath.Join(filepath.Dir(f.dst), "DAS")
	os.MkdirAll(dst2, 0o755)
	a := f.create(t, "NAS", map[string]any{"kind": "daily", "time": "02:00"}, nil)
	b := f.create(t, "DAS", map[string]any{"kind": "daily", "time": "02:00"}, map[string]any{"destinations": []string{dst2}})

	// A person is running a backup when both come due.
	manual := filepath.Join(filepath.Dir(f.dst), "OTHER")
	os.MkdirAll(manual, 0o755)
	code, out := f.c.do("POST", "/api/job", map[string]any{"sources": []string{f.src}, "destinations": []string{manual}, "subfolder": true}, nil)
	if code != 200 {
		t.Fatalf("manual start failed: %v", out)
	}
	f.setClock("2026-11-17 02:00")
	f.s.tick(f.s.now())
	f.waitIdle(t)
	for _, id := range []string{a, b} {
		if last, ok := f.schedule(t, id)["last"].(map[string]any); !ok || last["status"] != "done" {
			t.Errorf("schedule %s: last %v", id, f.schedule(t, id)["last"])
		}
	}
	_, out = f.c.do("GET", "/api/history", nil, nil)
	if n := len(out["history"].([]any)); n != 3 {
		t.Errorf("%d runs, want 3 (manual, then the two schedules one after the other)", n)
	}
}

func TestScheduleAPI(t *testing.T) {
	f := newFixture(t)
	// Mistakes are refused when saving, not at 2 a.m.
	for _, bad := range []map[string]any{
		{"name": "", "options": map[string]any{"sources": []string{f.src}, "destinations": []string{f.dst}}, "when": map[string]any{"kind": "daily", "time": "02:00"}},
		{"name": "x", "options": map[string]any{"sources": []string{f.src}, "destinations": []string{f.src}}, "when": map[string]any{"kind": "daily", "time": "02:00"}},
		{"name": "x", "options": map[string]any{"sources": []string{f.src}, "destinations": []string{f.dst}}, "when": map[string]any{"kind": "weekly", "time": "02:00"}},
	} {
		if code, out := f.c.do("POST", "/api/schedules", bad, nil); code != http.StatusBadRequest {
			t.Errorf("accepted %v: %d %v", bad, code, out)
		}
	}
	id := f.create(t, "주간", map[string]any{"kind": "weekly", "time": "21:00", "days": []int{5}}, map[string]any{"mirror": true})

	// Turning it off clears the next run; on again computes it.
	f.c.do("POST", "/api/schedules/"+id, map[string]any{"enabled": false}, nil)
	if sc := f.schedule(t, id); sc["enabled"] != false || sc["nextRun"] != nil {
		t.Errorf("disabled: %v", sc)
	}
	f.setClock("2026-11-30 12:00") // a disabled schedule never runs
	f.s.tick(f.s.now())
	if _, err := os.Stat(filepath.Join(f.dst, "A001")); err == nil {
		t.Error("a disabled schedule ran")
	}
	code, sc := f.c.do("POST", "/api/schedules/"+id, map[string]any{"enabled": true, "name": "금요일 밤", "when": map[string]any{"kind": "daily", "time": "03:15"}}, nil)
	if code != 200 || sc["name"] != "금요일 밤" || !strings.HasPrefix(sc["nextRun"].(string), "2026-12-01T03:15:00") {
		t.Errorf("update: %d %v", code, sc)
	}
	if opts := sc["options"].(map[string]any); opts["mirror"] != true {
		t.Error("options were lost on update")
	}

	// Run now, then delete.
	code, _ = f.c.do("POST", "/api/schedules/"+id+"/run", map[string]any{}, nil)
	f.waitIdle(t)
	if code != 200 || f.schedule(t, id)["last"].(map[string]any)["status"] != "done" {
		t.Errorf("run now: %d %v", code, f.schedule(t, id)["last"])
	}
	f.c.do("POST", "/api/schedules/"+id+"/delete", map[string]any{}, nil)
	_, out := f.c.do("GET", "/api/schedules", nil, nil)
	if len(out["schedules"].([]any)) != 0 {
		t.Error("delete did not remove it")
	}
	if code, _ := f.c.do("POST", "/api/schedules/nope/run", map[string]any{}, nil); code != http.StatusNotFound {
		t.Errorf("unknown schedule: %d", code)
	}

	// Schedules survive a restart.
	f.create(t, "남는 것", map[string]any{"kind": "hours", "hours": 4}, nil)
	again := New(f.s.configDir, nil)
	if len(again.sched.list) != 1 || again.sched.list[0].Name != "남는 것" {
		t.Errorf("after restart: %+v", again.sched.list)
	}
}

func TestNothingStartsWhileQuitting(t *testing.T) {
	f := newFixture(t)
	f.create(t, "매일", map[string]any{"kind": "daily", "time": "02:00"}, nil)
	f.s.CancelRunning()
	f.setClock("2026-11-17 02:00")
	f.s.tick(f.s.now())
	time.Sleep(200 * time.Millisecond)
	if _, err := os.Stat(filepath.Join(f.dst, "A001")); err == nil {
		t.Error("a scheduled run started while G-Copy was quitting")
	}
}
