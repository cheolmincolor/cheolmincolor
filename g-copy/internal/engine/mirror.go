package engine

// Sync (mirror) mode: files that are on a destination but no longer in the
// source are taken out of the backup, so the destination matches the source.
//
// Nothing is deleted. Such files are moved, inside the same destination, to
// _G-Copy_Removed/<date>/, after the user has seen the list and agreed.

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/text/unicode/norm"
)

// extraFile is a file found on a destination that the source does not have.
type extraFile struct {
	src  int    // which source's folder it was found in
	rel  string // relative to that folder, OS separators
	size int64
}

// pathKey is how two paths are compared when deciding whether a file on a
// destination still exists in the source. Case and Unicode form are
// ignored: macOS writes Korean names decomposed (NFD), most NAS shares
// store them composed (NFC), and both are usually case-insensitive. A name
// that differs only in those ways is treated as the same file and kept.
func pathKey(rel string) string {
	return strings.ToLower(norm.NFC.String(filepath.ToSlash(rel)))
}

// findExtras lists, for every destination, what sync mode would move aside.
// It runs after compare, before anything is written.
func (j *Job) findExtras() error {
	for _, dr := range j.dests {
		dr.extras = nil
		dr.pruneDirs = nil
		for s, base := range dr.bases {
			if j.srcUnreadable[s] {
				continue // see run(): never sync against an incomplete listing
			}
			if fi, err := os.Stat(base); err != nil || !fi.IsDir() {
				continue // first backup there: nothing to compare against
			}
			if err := j.walkExtras(dr, s, base); err != nil {
				return err
			}
		}
		sort.Slice(dr.extras, func(a, b int) bool {
			if dr.extras[a].src != dr.extras[b].src {
				return dr.extras[a].src < dr.extras[b].src
			}
			return dr.extras[a].rel < dr.extras[b].rel
		})
		for _, e := range dr.extras {
			dr.removeBytes += e.size
		}
	}
	return nil
}

func (j *Job) walkExtras(dr *destRun, s int, base string) error {
	keep := j.srcKeys[s]
	ownDirs := map[string]bool{
		filepath.Join(dr.path, ReplacedDirName): true,
		filepath.Join(dr.path, RemovedDirName):  true,
	}
	return filepath.WalkDir(base, func(p string, d fs.DirEntry, err error) error {
		if cerr := j.ctx.Err(); cerr != nil {
			return cerr
		}
		rel, _ := filepath.Rel(base, p)
		if err != nil {
			// Not fatal: what cannot be read is simply not moved.
			j.addError(j.showSrc(s, rel), dr.shown, "동기화하려고 대상 폴더를 읽을 수 없습니다: "+osMsg(err))
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if p == base {
			return nil
		}
		name := d.Name()
		if d.IsDir() {
			if ownDirs[p] || IsJunk(name) {
				return filepath.SkipDir // our own folders, and OS folders such as .Trashes
			}
			if !keep[pathKey(rel)] {
				dr.pruneDirs = append(dr.pruneDirs, dirRef{src: s, rel: rel})
			}
			return nil
		}
		if IsJunk(name) || !d.Type().IsRegular() {
			return nil // .DS_Store and the like, links: left alone
		}
		if filepath.Dir(rel) == "." && strings.EqualFold(filepath.Ext(name), ".mhl") && !keep[pathKey(rel)] {
			return nil // a G-Copy report from an earlier run
		}
		if keep[pathKey(rel)] {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		dr.extras = append(dr.extras, extraFile{src: s, rel: rel, size: info.Size()})
		return nil
	})
}

// hasExtras reports whether any destination has something to move aside.
func (j *Job) hasExtras() bool {
	for _, dr := range j.dests {
		if len(dr.extras) > 0 {
			return true
		}
	}
	return false
}

// removeExtras moves the listed files to _G-Copy_Removed/<date>/ on their
// own destination, keeping their folder structure, then removes folders
// that the source no longer has and that are now empty.
func (j *Job) removeExtras() {
	for _, dr := range j.dests {
		if len(dr.extras) == 0 {
			continue
		}
		if dr.dead.Load() {
			j.warnOnce("mirror-dead:"+dr.path, dr.shown+": 이 대상은 백업 중에 중단되어 동기화 정리를 하지 않았습니다.")
			continue
		}
		into := filepath.Join(dr.path, RemovedDirName, j.stamp)
		for _, e := range dr.extras {
			if j.ctx.Err() != nil {
				return
			}
			from := filepath.Join(dr.bases[e.src], e.rel)
			rel, err := filepath.Rel(dr.path, from)
			if err != nil {
				continue
			}
			to := filepath.Join(into, rel)
			if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
				j.addError(j.showSrc(e.src, e.rel), dr.shown, "동기화: 보관 폴더를 만들 수 없습니다: "+osMsg(err))
				continue
			}
			if err := os.Rename(from, to); err != nil {
				if errors.Is(err, fs.ErrNotExist) {
					continue // already gone
				}
				j.addError(j.showSrc(e.src, e.rel), dr.shown, "동기화: 파일을 옮길 수 없습니다 (지우지 않고 그대로 두었습니다): "+osMsg(err))
				continue
			}
			dr.removed.Add(1)
		}
		j.pruneDirs(dr)
	}
}

// pruneDirs removes folders the source does not have, deepest first, but
// only when they are empty apart from OS housekeeping files.
func (j *Job) pruneDirs(dr *destRun) {
	dirs := append([]dirRef(nil), dr.pruneDirs...)
	sort.Slice(dirs, func(a, b int) bool {
		return strings.Count(dirs[a].rel, string(filepath.Separator)) > strings.Count(dirs[b].rel, string(filepath.Separator))
	})
	for _, d := range dirs {
		p := filepath.Join(dr.bases[d.src], d.rel)
		entries, err := os.ReadDir(p)
		if err != nil {
			continue
		}
		onlyJunk := true
		for _, e := range entries {
			if !IsJunk(e.Name()) || !e.Type().IsRegular() {
				onlyJunk = false
				break
			}
		}
		if !onlyJunk {
			continue
		}
		for _, e := range entries {
			_ = os.Remove(filepath.Join(p, e.Name()))
		}
		_ = os.Remove(p) // fails, harmlessly, if something appeared meanwhile
	}
}

// Confirm answers the question the job asks before syncing: move the
// listed files aside (true) or leave them where they are (false).
func (j *Job) Confirm(remove bool) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.status != StatusConfirming || j.mirror != MirrorPending {
		return errors.New("지금은 확인할 내용이 없습니다")
	}
	if remove {
		j.mirror = MirrorApproved
	} else {
		j.mirror = MirrorDeclined
	}
	j.confirmCh <- remove // buffered: never blocks
	return nil
}
