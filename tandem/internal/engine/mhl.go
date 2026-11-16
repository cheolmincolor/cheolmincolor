package engine

import (
	"bufio"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"time"
)

// mhlEntry is one verified file in a Media Hash List.
type mhlEntry struct {
	rel      string // slash separated, relative to the report's folder
	size     int64
	modTime  time.Time
	sum      []byte
	hashedAt time.Time
}

func xmlText(s string) string {
	var b []byte
	w := &sliceWriter{&b}
	_ = xml.EscapeText(w, []byte(s))
	return string(b)
}

type sliceWriter struct{ b *[]byte }

func (w *sliceWriter) Write(p []byte) (int, error) { *w.b = append(*w.b, p...); return len(p), nil }

// writeMHL writes a Media Hash List (v1.1) next to the copied files, so the
// backup can be re-verified later with any MHL-aware tool.
func writeMHL(path, algo string, started, finished time.Time, entries []mhlEntry) error {
	sort.Slice(entries, func(i, k int) bool { return entries[i].rel < entries[k].rel })

	tag := "xxhash64be"
	if algo == "md5" {
		tag = "md5"
	}
	host, _ := os.Hostname()
	uname := ""
	if u, err := user.Current(); err == nil {
		uname = u.Username
	}
	const ts = "2006-01-02T15:04:05Z"

	tmp := path + partialSuffix
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(f, 1<<20)
	fmt.Fprint(w, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<hashlist version=\"1.1\">\n")
	fmt.Fprintf(w, "  <creatorinfo>\n    <username>%s</username>\n    <hostname>%s</hostname>\n    <tool>Tandem %s</tool>\n    <startdate>%s</startdate>\n    <finishdate>%s</finishdate>\n  </creatorinfo>\n",
		xmlText(uname), xmlText(host), Version, started.UTC().Format(ts), finished.UTC().Format(ts))
	for _, e := range entries {
		fmt.Fprintf(w, "  <hash>\n    <file>%s</file>\n    <size>%d</size>\n    <lastmodificationdate>%s</lastmodificationdate>\n    <%s>%s</%s>\n    <hashdate>%s</hashdate>\n  </hash>\n",
			xmlText(e.rel), e.size, e.modTime.UTC().Format(ts), tag, hex.EncodeToString(e.sum), tag, e.hashedAt.UTC().Format(ts))
	}
	fmt.Fprint(w, "</hashlist>\n")
	if err := w.Flush(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	// Full sync: on macOS this also flushes the drive's own write cache.
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

func mhlName(dir, srcName string, started time.Time) string {
	return filepath.Join(dir, fmt.Sprintf("%s_%s.mhl", srcName, started.Format("2006-01-02_150405")))
}
