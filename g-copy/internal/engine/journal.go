package engine

// Reports that survive a crash.
//
// The report (MHL) is written when a run ends. If the app is killed, the
// Mac loses power or a cable is pulled before that, the files verified so
// far would be in no report, and the next run would skip them because
// they are already there. So, while copying, every verified file is also
// appended to a small hidden journal next to where the report will go.
// A finished run removes it. The next run to that destination finds a
// leftover journal and turns it into the report that was missing.

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var errNoExclRename = errors.New("rename without replacing is not supported here")

type journalHead struct {
	Tool    string    `json:"tool"`
	Version string    `json:"version"`
	Algo    string    `json:"algo"`
	Source  string    `json:"source"`
	Started time.Time `json:"started"`
}

type journalLine struct {
	File   string    `json:"file"`
	Size   int64     `json:"size"`
	Mod    time.Time `json:"mod"`
	Hash   string    `json:"hash"`
	Hashed time.Time `json:"hashed"`
}

type journal struct {
	mu     sync.Mutex
	path   string
	f      *os.File
	w      *bufio.Writer
	unsync bool // written since the last flush to the disk
	broken bool
}

func journalName(base, srcName string, started time.Time) string {
	return filepath.Join(base, "."+srcName+"_"+started.Format("2006-01-02_150405")+journalSuffix)
}

func openJournal(path string, head journalHead) (*journal, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return nil, err
	}
	jr := &journal{path: path, f: f, w: bufio.NewWriterSize(f, 64<<10)}
	b, _ := json.Marshal(head)
	jr.w.Write(append(b, '\n'))
	jr.w.Flush()
	return jr, nil
}

// add appends one verified file. It reaches the operating system at once
// (so it survives the app being killed) and the disk within a few seconds
// (journalLoop), which covers a power cut.
func (jr *journal) add(e mhlEntry) {
	if jr == nil {
		return
	}
	b, _ := json.Marshal(journalLine{File: e.rel, Size: e.size, Mod: e.modTime, Hash: hex.EncodeToString(e.sum), Hashed: e.hashedAt})
	jr.mu.Lock()
	defer jr.mu.Unlock()
	if jr.broken {
		return
	}
	jr.w.Write(append(b, '\n'))
	if jr.w.Flush() != nil {
		jr.broken = true
	}
	jr.unsync = true
}

func (jr *journal) sync() {
	if jr == nil {
		return
	}
	jr.mu.Lock()
	defer jr.mu.Unlock()
	if jr.unsync && !jr.broken {
		_ = flushFile(jr.f, false)
		jr.unsync = false
	}
}

// close flushes and closes the journal, keeping the file.
func (jr *journal) close() {
	if jr == nil {
		return
	}
	jr.mu.Lock()
	defer jr.mu.Unlock()
	if jr.f != nil {
		jr.w.Flush()
		jr.f.Close()
		jr.f = nil
		jr.broken = true
	}
}

// discard closes and removes the journal: its report has been written.
func (jr *journal) discard() {
	if jr == nil {
		return
	}
	jr.close()
	os.Remove(jr.path)
}

// record notes one verified file on a destination, for its report.
func (j *Job) record(dr *destRun, s int, e mhlEntry) {
	dr.mu.Lock()
	dr.entries[s] = append(dr.entries[s], e)
	if dr.journals == nil {
		dr.journals = make([]*journal, len(dr.bases))
	}
	jr := dr.journals[s]
	if jr == nil {
		var err error
		jr, err = openJournal(journalName(dr.bases[s], j.srcNames[s], j.started), journalHead{
			Tool: "G-Copy", Version: Version, Algo: j.opts.Algo, Source: j.srcNames[s], Started: j.started,
		})
		if err != nil {
			jr = &journal{broken: true} // reports still work; only crash recovery is lost
		}
		dr.journals[s] = jr
	}
	dr.mu.Unlock()
	jr.add(e)
}

func (j *Job) journalLoop(stop <-chan struct{}) {
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			for _, dr := range j.dests {
				dr.mu.Lock()
				jrs := append([]*journal(nil), dr.journals...)
				dr.mu.Unlock()
				for _, jr := range jrs {
					jr.sync()
				}
			}
		}
	}
}

// recoverJournals turns journals left by an interrupted run into reports.
func (j *Job) recoverJournals() {
	for _, dr := range j.dests {
		seen := map[string]bool{}
		for _, base := range dr.bases {
			if seen[base] {
				continue
			}
			seen[base] = true
			entries, err := os.ReadDir(base)
			if err != nil {
				continue // first backup there
			}
			for _, e := range entries {
				if e.Type().IsRegular() && strings.HasSuffix(e.Name(), journalSuffix) {
					j.recoverJournal(dr, base, filepath.Join(base, e.Name()))
				}
			}
		}
	}
}

func (j *Job) recoverJournal(dr *destRun, base, path string) {
	fi, err := os.Stat(path)
	if err != nil {
		return
	}
	f, err := os.Open(path)
	if err != nil {
		return
	}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	var head journalHead
	var list []mhlEntry
	for n := 0; sc.Scan(); n++ {
		if n == 0 {
			if json.Unmarshal(sc.Bytes(), &head) != nil || head.Tool != "G-Copy" {
				f.Close()
				return // not ours: leave it alone
			}
			continue
		}
		var l journalLine
		if json.Unmarshal(sc.Bytes(), &l) != nil {
			break // a line cut short by the crash: the rest is lost anyway
		}
		sum, err := hex.DecodeString(l.Hash)
		if err != nil {
			break
		}
		// Only files that are still there as they were verified.
		st, err := os.Lstat(filepath.Join(base, filepath.FromSlash(l.File)))
		if err != nil || !st.Mode().IsRegular() || st.Size() != l.Size {
			continue
		}
		list = append(list, mhlEntry{rel: l.File, size: l.Size, modTime: l.Mod, sum: sum, hashedAt: l.Hashed})
	}
	f.Close()
	if head.Tool == "" {
		os.Remove(path) // empty: the crash came before anything was verified
		return
	}
	mhl := mhlName(base, head.Source, head.Started)
	if _, err := os.Stat(mhl); err == nil || len(list) == 0 {
		os.Remove(path) // the report was written after all, or nothing to report
		return
	}
	algo, _ := NormalizeAlgo(head.Algo)
	if err := writeMHL(mhl, algo, head.Started, fi.ModTime(), list); err != nil {
		j.warnOnce("journal:"+path, fmt.Sprintf("%s: an earlier run was interrupted, and its report could not be recovered (%s).", dr.shown, osMsg(err)))
		return
	}
	os.Remove(path)
	j.warnOnce("journal:"+path, fmt.Sprintf("%s: an earlier run was interrupted before it wrote its report. The report for the %d files it had verified was recovered: %s", dr.shown, len(list), filepath.Base(mhl)))
}
