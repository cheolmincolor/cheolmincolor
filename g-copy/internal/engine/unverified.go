package engine

// Copies made with verification turned off are remembered.
//
// A file copied without being read back looks, by size and date, exactly
// like a verified one. So each destination folder keeps a small hidden
// list of them. The next run with verification on reads those files back
// by itself, replaces the ones that differ from the source (the differing
// file is kept, in _G-Copy_Replaced), and takes them off the list. While
// the list has entries, the screen never shows that destination as plainly
// "up to date".

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const unverifiedName = ".gcopy-unverified"

type unvEntry struct {
	File string    `json:"file"` // slash separated, relative to the list's folder
	Size int64     `json:"size"`
	Mod  time.Time `json:"mod"`
}

// unvList is the list of one destination folder (one per source).
type unvList struct {
	mu      sync.Mutex
	path    string
	items   map[string]unvEntry
	changed bool
	app     *os.File // open while entries are being added
}

// loadUnverified reads the list in base, dropping entries whose file is
// gone or no longer the size that was copied.
func loadUnverified(base string) *unvList {
	l := &unvList{path: filepath.Join(base, unverifiedName), items: map[string]unvEntry{}}
	f, err := os.Open(l.path)
	if err != nil {
		return l
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		var e unvEntry
		if json.Unmarshal(sc.Bytes(), &e) != nil || e.File == "" {
			continue // a line cut short by a crash
		}
		st, err := os.Lstat(filepath.Join(base, filepath.FromSlash(e.File)))
		if err != nil || !st.Mode().IsRegular() || st.Size() != e.Size {
			l.changed = true
			continue
		}
		l.items[e.File] = e
	}
	return l
}

func (l *unvList) has(rel string, size int64, mod time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.items[rel]
	if !ok || e.Size != size {
		return false
	}
	d := e.Mod.Sub(mod)
	if d < 0 {
		d = -d
	}
	return d <= mtimeTolerance
}

// add notes a copy that was not verified. It reaches the file at once, so
// the note survives the app being killed.
func (l *unvList) add(e unvEntry) (isNew bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, had := l.items[e.File]
	l.items[e.File] = e
	l.changed = true
	if l.app == nil {
		l.app, _ = os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	}
	if l.app != nil {
		b, _ := json.Marshal(e)
		_, _ = l.app.Write(append(b, '\n'))
	}
	return !had
}

// clear takes a file off the list: it has been read back and matches.
func (l *unvList) clear(rel string) (was bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.items[rel]; !ok {
		return false
	}
	delete(l.items, rel)
	l.changed = true
	return true
}

// save writes the list as it is now; an empty list removes the file.
func (l *unvList) save() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.app != nil {
		_ = flushFile(l.app, false)
		l.app.Close()
		l.app = nil
	}
	if !l.changed {
		return
	}
	if len(l.items) == 0 {
		os.Remove(l.path)
		return
	}
	names := make([]string, 0, len(l.items))
	for n := range l.items {
		names = append(names, n)
	}
	sort.Strings(names)
	tmp := l.path + partialSuffix
	f, err := os.Create(tmp)
	if err != nil {
		return // the appended file stays: nothing is forgotten
	}
	w := bufio.NewWriter(f)
	for _, n := range names {
		b, _ := json.Marshal(l.items[n])
		w.Write(append(b, '\n'))
	}
	if w.Flush() != nil || flushFile(f, false) != nil || f.Close() != nil {
		f.Close()
		os.Remove(tmp)
		return
	}
	_ = os.Rename(tmp, l.path)
}
