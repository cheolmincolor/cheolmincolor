package engine

import (
	"errors"
	"fmt"
	"hash/fnv"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// srcFile is one regular file found in a source.
type srcFile struct {
	src     int    // index into Job.srcRoots
	rel     string // path relative to the source root, OS separators
	size    int64
	modTime time.Time
	mode    fs.FileMode
}

// action is what has to happen to one file on one destination.
type action uint8

const (
	actNone     action = iota // already up to date
	actCopy                   // not there yet
	actReplace                // there, but size or date differs
	actReverify               // up to date, re-hash requested
	actBlocked                // cannot be written (reported as an error)
)

func (a action) active() bool { return a == actCopy || a == actReplace || a == actReverify }

var junkNames = map[string]bool{
	".DS_Store":                 true,
	".Spotlight-V100":           true,
	".Trashes":                  true,
	".fseventsd":                true,
	".TemporaryItems":           true,
	".DocumentRevisions-V100":   true,
	".apdisk":                   true,
	"System Volume Information": true,
	"$RECYCLE.BIN":              true,
	"Thumbs.db":                 true,
}

// IsJunk reports whether name is an OS housekeeping file that is never
// part of the media and is left out of backups.
func IsJunk(name string) bool {
	return junkNames[name] ||
		strings.HasPrefix(name, "._") ||
		strings.HasPrefix(name, ".Trash-") ||
		strings.HasSuffix(name, partialSuffix)
}

// tempName is the name a file carries while it is copied and verified.
func tempName(name string) string {
	if len(name) > 200 { // stay under the 255-byte name limit
		h := fnv.New64a()
		h.Write([]byte(name))
		name = fmt.Sprintf("%016x", h.Sum64())
	}
	return "." + name + partialSuffix
}

func sourceName(resolved string) string {
	base := filepath.Base(resolved)
	if base == string(filepath.Separator) || base == "." || base == "" {
		if v := strings.TrimSuffix(filepath.VolumeName(resolved), ":"); v != "" {
			return v
		}
		return "Root"
	}
	return base
}

// missingError means a source or destination is not there, usually
// because its disk or share is not connected.
type missingError struct{ msg string }

func (e missingError) Error() string { return e.msg }

// IsMissing reports whether err means a source or destination folder is
// not there (for instance, its disk is not connected).
func IsMissing(err error) bool {
	var m missingError
	return errors.As(err, &m)
}

// Check validates opts the way Start does, without starting anything.
func Check(opts Options) error {
	j := &Job{opts: opts}
	j.opts.Sources = append([]string(nil), opts.Sources...)
	j.opts.Destinations = append([]string(nil), opts.Destinations...)
	return j.prepare()
}

func resolveDir(p, role string) (string, os.FileInfo, error) {
	if strings.TrimSpace(p) == "" {
		return "", nil, fmt.Errorf("%s 경로가 비어 있습니다", role)
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", nil, fmt.Errorf("%s 경로가 올바르지 않습니다: %s", role, p)
	}
	if r, err := filepath.EvalSymlinks(abs); err == nil {
		abs = r
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return "", nil, missingError{fmt.Sprintf("%s 폴더를 찾을 수 없습니다: %s", role, p)}
	}
	if !fi.IsDir() {
		return "", nil, fmt.Errorf("%s 경로가 폴더가 아닙니다: %s", role, p)
	}
	return abs, fi, nil
}

// sameOrInside reports whether path is root itself or lies below it. It
// compares file identities, so it is not fooled by symlinks or by
// case-insensitive volumes.
func sameOrInside(path string, root os.FileInfo) bool {
	for p := path; ; {
		if fi, err := os.Stat(p); err == nil && os.SameFile(fi, root) {
			return true
		}
		parent := filepath.Dir(p)
		if parent == p {
			return false
		}
		p = parent
	}
}

func checkWritable(dir string) error {
	f, err := os.CreateTemp(dir, ".gcopy-write-test-*")
	if err != nil {
		return err
	}
	name := f.Name()
	f.Close()
	return os.Remove(name)
}

// prepare validates the request and resolves all paths. It is fast and runs
// before the job goes to the background, so mistakes are reported at once.
func (j *Job) prepare() error {
	o := &j.opts
	algo, err := NormalizeAlgo(o.Algo)
	if err != nil {
		return err
	}
	o.Algo = algo
	if len(o.Sources) == 0 {
		return errors.New("원본을 하나 이상 선택하세요")
	}
	if len(o.Destinations) == 0 {
		return errors.New("대상을 하나 이상 선택하세요")
	}
	if len(o.Sources) > 1 {
		o.Subfolder = true // several sources can only be kept apart in folders
	}

	srcInfos := make([]os.FileInfo, len(o.Sources))
	seen := map[string]string{}
	for i, s := range o.Sources {
		p, fi, err := resolveDir(s, "원본")
		if err != nil {
			return err
		}
		name := sourceName(p)
		if o.Subfolder {
			if other, dup := seen[strings.ToLower(name)]; dup {
				return fmt.Errorf("이름이 같은 원본이 두 개 있습니다 (%s, %s) — 대상에서 같은 폴더로 합쳐지므로 한 번에 하나씩 백업하세요", other, s)
			}
			seen[strings.ToLower(name)] = s
		}
		j.srcRoots = append(j.srcRoots, p)
		j.srcNames = append(j.srcNames, name)
		srcInfos[i] = fi
	}

	var destInfos []os.FileInfo
	for _, d := range o.Destinations {
		p, fi, err := resolveDir(d, "대상")
		if err != nil {
			return err
		}
		for _, other := range destInfos {
			if os.SameFile(fi, other) {
				return fmt.Errorf("같은 대상이 두 번 선택되었습니다: %s", d)
			}
		}
		dr := &destRun{path: p, shown: d, entries: make([][]mhlEntry, len(j.srcRoots))}
		for s := range j.srcRoots {
			base := p
			if o.Subfolder {
				base = filepath.Join(p, j.srcNames[s])
			}
			if sameOrInside(base, srcInfos[s]) {
				return fmt.Errorf("대상이 원본과 같거나 원본 안에 있습니다: %s → %s", o.Sources[s], d)
			}
			dr.bases = append(dr.bases, base)
		}
		destInfos = append(destInfos, fi)
		j.dests = append(j.dests, dr)
	}
	// Only now, with every selection known to be sane, touch the destinations.
	for i, dr := range j.dests {
		if err := checkWritable(dr.path); err != nil {
			return fmt.Errorf("대상에 쓸 수 없습니다: %s (%s)", o.Destinations[i], osMsg(err))
		}
	}
	return nil
}

// scan walks every source and lists the files to back up.
func (j *Job) scan() error {
	for s, root := range j.srcRoots {
		hasChild := map[string]bool{}
		var dirs []string
		keys := map[string]bool{} // every name the source has, for sync mode
		err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if cerr := j.ctx.Err(); cerr != nil {
				return cerr
			}
			rel, _ := filepath.Rel(root, p)
			if err != nil {
				j.addError(j.showSrc(s, rel), "", "읽을 수 없습니다: "+osMsg(err))
				j.srcUnreadable[s] = true
				if d != nil && d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if p == root {
				return nil
			}
			if IsJunk(d.Name()) {
				j.excluded.Add(1)
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			hasChild[filepath.Dir(rel)] = true
			keys[pathKey(rel)] = true // also links and special files: kept on the destination
			if d.IsDir() {
				dirs = append(dirs, rel)
				return nil
			}
			info, err := d.Info()
			if err != nil {
				j.addError(j.showSrc(s, rel), "", "읽을 수 없습니다: "+osMsg(err))
				j.srcUnreadable[s] = true
				return nil
			}
			if !info.Mode().IsRegular() {
				// Symlinks, sockets, devices: not media, and not safe to follow.
				j.special.Add(1)
				return nil
			}
			j.files = append(j.files, srcFile{src: s, rel: rel, size: info.Size(), modTime: info.ModTime(), mode: info.Mode()})
			j.scanFiles.Add(1)
			j.scanBytes.Add(info.Size())
			return nil
		})
		if err != nil {
			return err
		}
		j.srcKeys = append(j.srcKeys, keys)
		for _, d := range dirs {
			if !hasChild[d] {
				j.emptyDirs = append(j.emptyDirs, dirRef{src: s, rel: d})
			}
		}
	}
	return nil
}

// compare decides, for every file and destination, whether it must be
// copied. This is what makes repeated runs fast: files that are already
// there with the same size and date are not copied again.
func (j *Job) compare() error {
	nd := len(j.dests)
	j.acts = make([]action, len(j.files)*nd)

	for d, dr := range j.dests {
		baseExists := make([]bool, len(dr.bases))
		for s, b := range dr.bases {
			_, err := os.Stat(b)
			baseExists[s] = err == nil
		}
		var next atomic.Int64
		var wg sync.WaitGroup
		for w := 0; w < statWorkers; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for {
					i := int(next.Add(1) - 1)
					if i >= len(j.files) || j.ctx.Err() != nil {
						return
					}
					f := &j.files[i]
					if !baseExists[f.src] {
						j.acts[i*nd+d] = actCopy
						continue
					}
					j.acts[i*nd+d] = j.decide(dr, f)
				}
			}()
		}
		wg.Wait()
		if err := j.ctx.Err(); err != nil {
			return err
		}
	}

	var total int64
	for i := range j.files {
		f := &j.files[i]
		active := int64(0)
		for d, dr := range j.dests {
			switch a := j.acts[i*nd+d]; a {
			case actCopy, actReplace:
				dr.need += f.size
				active++
			case actReverify:
				active++
			case actNone:
				dr.skipped.Add(1)
			case actBlocked:
				dr.failed.Add(1)
			}
		}
		if active > 0 {
			total += f.size * (1 + active) // one source read + one read-back per destination
		}
	}
	j.workTotal.Store(total)

	for _, dr := range j.dests {
		free, _, err := DiskUsage(dr.path)
		if err != nil {
			dr.free = -1 // unknown: some network shares do not report it
			continue
		}
		dr.free = free
		if dr.need > free {
			return fmt.Errorf("대상의 여유 공간이 부족합니다: %s — 필요 %s, 여유 %s",
				dr.shown, humanBytes(dr.need), humanBytes(free))
		}
	}
	return nil
}

func (j *Job) decide(dr *destRun, f *srcFile) action {
	target := filepath.Join(dr.bases[f.src], f.rel)
	fi, err := os.Lstat(target)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return actCopy
	case err != nil:
		j.addError(j.showSrc(f.src, f.rel), dr.shown, "대상을 확인할 수 없습니다: "+osMsg(err))
		return actBlocked
	case !fi.Mode().IsRegular():
		j.addError(j.showSrc(f.src, f.rel), dr.shown, "대상에 같은 이름의 폴더 또는 링크가 있어 복사하지 않았습니다")
		return actBlocked
	}
	diff := fi.ModTime().Sub(f.modTime)
	if diff < 0 {
		diff = -diff
	}
	if fi.Size() == f.size && diff <= mtimeTolerance {
		if j.opts.Reverify {
			return actReverify
		}
		return actNone
	}
	return actReplace
}

// showSrc is the path shown to the user for a source file.
func (j *Job) showSrc(s int, rel string) string {
	if rel == "." || rel == "" {
		return j.srcNames[s]
	}
	return filepath.ToSlash(filepath.Join(j.srcNames[s], rel))
}

func isNoSpace(err error) bool {
	var en syscall.Errno
	if !errors.As(err, &en) {
		return false
	}
	if runtime.GOOS == "windows" {
		return en == 112 || en == 39 // ERROR_DISK_FULL, ERROR_HANDLE_DISK_FULL
	}
	return en == syscall.ENOSPC || en == syscall.EDQUOT
}

// syncUnsupported reports errors that only mean "this kind of volume cannot
// flush on request" (some network shares), which is not a copy failure.
func syncUnsupported(err error) bool {
	return errors.Is(err, syscall.ENOTSUP) || errors.Is(err, syscall.EINVAL) || errors.Is(err, syscall.ENOTTY)
}

// osMsg renders an OS error for the user: without the path (shown
// separately) and, for the common causes, in plain Korean.
func osMsg(err error) string {
	inner := err
	var pe *fs.PathError
	var le *os.LinkError
	var se *os.SyscallError
	switch {
	case errors.As(err, &pe):
		inner = pe.Err
	case errors.As(err, &le):
		inner = le.Err
	case errors.As(err, &se):
		inner = se.Err
	}
	ko := ""
	switch {
	case isNoSpace(err):
		ko = "디스크 공간이 없습니다"
	case errors.Is(err, fs.ErrPermission):
		ko = "권한이 없습니다"
	case errors.Is(err, fs.ErrNotExist):
		ko = "파일이나 폴더를 찾을 수 없습니다. 디스크 연결이 끊겼을 수 있습니다"
	case errors.Is(err, syscall.EIO):
		ko = "입출력 오류입니다. 디스크나 케이블 문제일 수 있습니다"
	case errors.Is(err, syscall.EROFS):
		ko = "읽기 전용 볼륨입니다"
	case errors.Is(err, syscall.ENAMETOOLONG):
		ko = "파일 이름이나 경로가 너무 깁니다"
	}
	if ko == "" {
		return inner.Error()
	}
	return ko + " (" + inner.Error() + ")"
}

func humanBytes(n int64) string {
	const unit = 1000
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := float64(unit), 0
	for v := float64(n) / unit; v >= unit && exp < 4; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/div, "kMGTP"[exp])
}
