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

// testDiskKey, set by a test, decides which disk each source is on.
var testDiskKey func(path string) string

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
	actCheck                  // same size, different date: compare the content
)

func (a action) active() bool {
	return a == actCopy || a == actReplace || a == actReverify || a == actCheck
}

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
		strings.HasSuffix(name, partialSuffix) ||
		strings.HasSuffix(name, journalSuffix)
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
		return "", nil, fmt.Errorf("%s path is empty", role)
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", nil, fmt.Errorf("%s path is not valid: %s", role, p)
	}
	if r, err := filepath.EvalSymlinks(abs); err == nil {
		abs = r
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return "", nil, missingError{fmt.Sprintf("%s folder not found: %s. Check that its disk or NAS is connected.", role, p)}
	}
	if !fi.IsDir() {
		return "", nil, fmt.Errorf("%s is not a folder: %s. Choose a folder instead.", role, p)
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
	if o.NoVerify {
		o.Reverify = false // re-checking earlier copies is verification too
	}
	if len(o.Sources) == 0 {
		return errors.New("Choose at least one source")
	}
	if len(o.Destinations) == 0 {
		return errors.New("Choose at least one destination")
	}
	if len(o.Sources) > 1 {
		o.Subfolder = true // several sources can only be kept apart in folders
	}

	srcInfos := make([]os.FileInfo, len(o.Sources))
	seen := map[string]string{}
	for i, s := range o.Sources {
		p, fi, err := resolveDir(s, "Source")
		if err != nil {
			return err
		}
		name := sourceName(p)
		if o.Subfolder {
			if other, dup := seen[strings.ToLower(name)]; dup {
				return fmt.Errorf("Two sources have the same name (%s, %s) — they would go into the same folder on the destination, so back them up one at a time", other, s)
			}
			seen[strings.ToLower(name)] = s
		}
		j.srcRoots = append(j.srcRoots, p)
		j.srcNames = append(j.srcNames, name)
		srcInfos[i] = fi
	}

	var destInfos []os.FileInfo
	for _, d := range o.Destinations {
		p, fi, err := resolveDir(d, "Destination")
		if err != nil {
			return err
		}
		for _, other := range destInfos {
			if os.SameFile(fi, other) {
				return fmt.Errorf("The same destination is selected twice: %s. Remove one of them.", d)
			}
		}
		dr := &destRun{path: p, shown: d, entries: make([][]mhlEntry, len(j.srcRoots)), network: isNetworkFS(p)}
		for s := range j.srcRoots {
			base := p
			if o.Subfolder {
				base = filepath.Join(p, j.srcNames[s])
			}
			if sameOrInside(base, srcInfos[s]) {
				return fmt.Errorf("%s is the source %s itself or inside it, so the backup would copy into itself. Choose a folder on another disk.", filepath.Base(p), j.srcNames[s])
			}
			dr.bases = append(dr.bases, base)
		}
		destInfos = append(destInfos, fi)
		j.dests = append(j.dests, dr)
	}
	// Only now, with every selection known to be sane, touch the destinations.
	for i, dr := range j.dests {
		if err := checkWritable(dr.path); err != nil {
			return fmt.Errorf("Cannot write to %s (%s). Check that the disk is not read-only and that you may write to this folder.", filepath.Base(o.Destinations[i]), osMsg(err))
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
				j.addError(j.showSrc(s, rel), "", "Cannot read: "+osMsg(err))
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
				j.addError(j.showSrc(s, rel), "", "Cannot read: "+osMsg(err))
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

	workers := fileWorkers
	for _, dr := range j.dests {
		if dr.network {
			workers = netFileWorkers
		}
		dr.folds = probeFolding(dr.path)
	}
	// one lane per source disk; sources on the same disk share one, as
	// reading two places of one hard disk at once makes it seek
	j.srcLane = make([]int, len(j.srcRoots))
	laneOf := map[string]int{}
	for s, root := range j.srcRoots {
		key := diskKey(root)
		if testDiskKey != nil {
			key = testDiskKey(root)
		}
		l, ok := laneOf[key]
		if !ok { // "" (unknown) is one shared lane
			l = len(j.lanes)
			j.lanes = append(j.lanes, newSlots(workers))
			laneOf[key] = l
		}
		j.srcLane[s] = l
	}
	// read-back: two big files per lane can be checked while the next copies
	j.verifySlots = newSlots(workers * (1 + len(j.lanes)))

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
		j.blockCollisions(d)
	}

	var total int64
	for i := range j.files {
		f := &j.files[i]
		active, reads := int64(0), int64(0)
		for d, dr := range j.dests {
			switch a := j.acts[i*nd+d]; a {
			case actCopy, actReplace:
				dr.need += f.size
				dr.workTotal.Add(j.destWorkFor(a, f.size)) // written, then read back
				reads += boolInt(j.readsBack(a))
				active++
			case actReverify, actCheck:
				dr.workTotal.Add(f.size) // read back only
				reads++
				active++
			case actNone:
				dr.skipped.Add(1)
			case actBlocked:
				dr.failed.Add(1)
			}
		}
		if active > 0 {
			total += f.size * (1 + reads) // one source read + one read-back per verified destination
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
			return fmt.Errorf("%s needs %s but has %s free. Free up space on it or choose another destination.",
				filepath.Base(dr.shown), humanBytes(dr.need), humanBytes(free))
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
		j.addError(j.showSrc(f.src, f.rel), dr.shown, "Cannot check the destination: "+osMsg(err))
		return actBlocked
	case !fi.Mode().IsRegular():
		j.addError(j.showSrc(f.src, f.rel), dr.shown, "Not copied: the destination has a folder or link with this name")
		return actBlocked
	}
	diff := fi.ModTime().Sub(f.modTime)
	if diff < 0 {
		diff = -diff
	}
	switch {
	case fi.Size() != f.size:
		return actReplace
	case diff <= mtimeTolerance:
		if j.opts.Reverify {
			return actReverify
		}
		return actNone
	default:
		// Same size, other date: often the same file whose date was not
		// kept (some NAS and exFAT volumes, a copy made by another tool).
		// Compare the content before copying it all again.
		return actCheck
	}
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
// separately) and, for the common causes, in plain words.
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
	plain := ""
	switch {
	case isNoSpace(err):
		plain = "The disk is full"
	case errors.Is(err, fs.ErrPermission):
		plain = "Permission denied"
	case errors.Is(err, fs.ErrNotExist):
		plain = "File or folder not found — the disk may have been disconnected"
	case errors.Is(err, syscall.EIO):
		plain = "I/O error — possibly a problem with the disk or cable"
	case errors.Is(err, syscall.EROFS):
		plain = "The volume is read-only"
	case errors.Is(err, syscall.ENAMETOOLONG):
		plain = "The file name or path is too long"
	}
	if plain == "" {
		return inner.Error()
	}
	return plain + " (" + inner.Error() + ")"
}

func boolInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
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
