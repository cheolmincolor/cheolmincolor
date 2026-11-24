package engine

// Previews: what a backup would copy, worked out the way a run does before
// it copies (read the sources, compare with the destinations), without
// copying anything. Used for backups waiting in the queue.

import (
	"context"
	"time"
)

// Preview is what a backup would do if it started now.
type Preview struct {
	Sources  []SourceState `json:"sources"`
	Dests    []PreviewDest `json:"dests"`
	Problems int64         `json:"problems"` // files or folders that could not be read or would be refused
	At       time.Time     `json:"at"`
}

// PreviewDest is one destination of a preview.
type PreviewDest struct {
	Path   string `json:"path"`
	Need   int64  `json:"need"`   // bytes this backup would write there
	Volume string `json:"volume"` // which disk it is on (destinations on one disk share its free space)
}

// PreviewBackup reads the sources and compares them with the destinations.
// It writes nothing to the destinations except the tiny probe file that
// every run uses to learn how the volume compares names.
func PreviewBackup(ctx context.Context, opts Options) (Preview, error) {
	j := &Job{opts: opts, started: time.Now(), current: map[int]string{}, warned: map[string]bool{}}
	j.opts.Sources = append([]string(nil), opts.Sources...)
	j.opts.Destinations = append([]string(nil), opts.Destinations...)
	if err := j.prepare(); err != nil {
		return Preview{}, err
	}
	j.srcUnreadable = make([]bool, len(j.srcRoots))
	j.ctx = ctx
	if err := j.scan(); err != nil {
		return Preview{}, err
	}
	if err := j.compare(); err != nil && ctx.Err() != nil {
		return Preview{}, ctx.Err()
	} else if err != nil && j.srcStats == nil {
		return Preview{}, err
	}
	// A destination that is too small is not an error here: saying so
	// before its turn comes is the point of a preview.
	p := Preview{Sources: j.srcStats, Problems: j.errCount.Load(), At: time.Now()}
	for _, dr := range j.dests {
		p.Dests = append(p.Dests, PreviewDest{Path: dr.shown, Need: dr.need, Volume: VolumeKey(dr.path)})
	}
	return p, nil
}

// VolumeKey names the disk (or server) that holds path, so destinations
// that share free space can be added up. Partitions and APFS volumes of
// one disk count as one, which errs on the side of warning.
func VolumeKey(path string) string {
	if k := diskKey(path); k != "" {
		return k
	}
	return "path:" + path
}
