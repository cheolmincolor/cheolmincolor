package engine

// Names that a destination cannot keep apart.
//
// Most Mac volumes and NAS shares ignore upper/lower case ("Clip.mov" and
// "clip.mov" are one file), and Mac volumes also ignore how accented and
// Korean letters are composed (NFC or NFD). A source on a volume that does
// tell them apart (a Linux NAS, a case-sensitive disk) can hold two such
// files side by side. Copied to an ordinary volume, one would silently
// replace the other. Both are reported instead.

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/text/unicode/norm"
)

type nameFolding struct {
	caseless bool // "A" and "a" are the same name
	formless bool // composed and decomposed letters are the same name
}

func (n nameFolding) any() bool { return n.caseless || n.formless }

func (n nameFolding) key(rel string) string {
	if n.formless {
		rel = norm.NFC.String(rel)
	}
	if n.caseless {
		rel = strings.ToLower(rel)
	}
	return rel
}

// testFolding, when set by a test, replaces probing the volume.
var testFolding func(dir string) nameFolding

// probeFolding finds out how the volume holding dir compares names, by
// creating one empty file and looking it up under other spellings.
func probeFolding(dir string) nameFolding {
	if testFolding != nil {
		return testFolding(dir)
	}
	rnd := make([]byte, 6)
	_, _ = rand.Read(rnd)
	name := ".gcopy-Probe-" + hex.EncodeToString(rnd) + "-é" + partialSuffix // é, composed
	p := filepath.Join(dir, name)
	f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return nameFolding{}
	}
	f.Close()
	defer os.Remove(p)
	_, e1 := os.Lstat(filepath.Join(dir, strings.Replace(name, "Probe", "probe", 1)))
	_, e2 := os.Lstat(filepath.Join(dir, norm.NFD.String(name)))
	return nameFolding{caseless: e1 == nil, formless: e2 == nil}
}

// blockCollisions marks files that would land on the same name on
// destination d as not copyable there, and says why.
func (j *Job) blockCollisions(d int) {
	dr := j.dests[d]
	if !dr.folds.any() {
		return
	}
	nd := len(j.dests)
	type key struct {
		src  int
		name string
	}
	first := map[key]int{}
	var groups map[int][]int // first index -> the others
	for i := range j.files {
		f := &j.files[i]
		k := key{f.src, dr.folds.key(f.rel)}
		if o, dup := first[k]; dup {
			if groups == nil {
				groups = map[int][]int{}
			}
			groups[o] = append(groups[o], i)
			continue
		}
		first[k] = i
	}
	what := "upper/lower case"
	switch {
	case dr.folds.caseless && dr.folds.formless:
		what = "upper/lower case or in how letters are composed (Unicode form)"
	case dr.folds.formless:
		what = "in how letters are composed (Unicode form)"
	}
	for o, others := range groups {
		all := append([]int{o}, others...)
		for _, i := range all {
			var names []string
			for _, k := range all {
				if k != i {
					names = append(names, j.showSrc(j.files[k].src, j.files[k].rel))
				}
			}
			j.acts[i*nd+d] = actBlocked
			j.addError(j.showSrc(j.files[i].src, j.files[i].rel), dr.shown, fmt.Sprintf(
				"Not copied: the source also has %s, a name that differs only in %s. This destination treats them as the same name and cannot keep both — rename one of them.",
				strings.Join(names, ", "), what))
		}
	}
}
