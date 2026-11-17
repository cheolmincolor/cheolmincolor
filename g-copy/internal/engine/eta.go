package engine

import (
	"math"
	"time"
)

// estimator turns progress into a remaining time that does not jump around.
//
// Every file is listed and compared before copying starts, so the total
// amount of work is known exactly. What varies is the speed: large clips
// stream fast, image sequences and read-back passes go in bursts, and a NAS
// slows down when someone else uses it. So the estimate is based on the
// average speed of the whole run so far, nudged by the last half minute,
// and, until the run has gone on long enough to judge, on the speed of the
// previous backup to the same destinations.
//
// The predicted finish time is what is shown, and it only moves when the
// prediction has drifted noticeably; in between, the remaining time simply
// counts down.
type estimator struct {
	hint float64 // bytes of work per second in an earlier run; 0 if unknown

	start     time.Time
	startWork int64
	samples   []etaSample // the last recentWindow of progress
	shown     time.Time   // the finish time currently shown
}

type etaSample struct {
	t    time.Time
	work int64
}

const (
	recentWindow = 30 * time.Second
	trustAfter   = 20 * time.Second // measured speed fully replaces the hint
	firstGuess   = 8 * time.Second  // no estimate before this without a hint…
	firstShare   = 0.02             // …unless this much of the work is done
	settling     = 30 * time.Second // until then, larger swings are tolerated
)

func (e *estimator) begin(now time.Time, work int64) {
	e.start, e.startWork = now, work
	e.samples = []etaSample{{now, work}}
	e.shown = time.Time{}
}

// update records progress and returns the remaining time and finish time
// to show. A zero finish means "still estimating".
func (e *estimator) update(now time.Time, work, total int64) (remaining time.Duration, finish time.Time) {
	if e.start.IsZero() {
		return 0, time.Time{}
	}
	left := total - work
	if left <= 0 {
		return 0, now
	}
	e.samples = append(e.samples, etaSample{now, work})
	for len(e.samples) > 2 && now.Sub(e.samples[1].t) >= recentWindow {
		e.samples = e.samples[1:]
	}

	elapsed := now.Sub(e.start)
	done := work - e.startWork
	var measured float64
	if elapsed > 0 && done > 0 {
		measured = float64(done) / elapsed.Seconds()
		if old := e.samples[0]; now.Sub(old.t) >= 5*time.Second && work > old.work {
			recent := float64(work-old.work) / now.Sub(old.t).Seconds()
			measured = 0.7*measured + 0.3*recent
		}
	}

	rate := measured
	if e.hint > 0 {
		w := math.Min(1, elapsed.Seconds()/trustAfter.Seconds())
		if measured == 0 {
			w = 0
		}
		rate = (1-w)*e.hint + w*measured
	} else if elapsed < firstGuess && float64(done) < firstShare*float64(total-e.startWork) {
		return 0, time.Time{} // too early to say anything honest
	}
	if rate <= 0 {
		return 0, time.Time{}
	}

	predicted := now.Add(time.Duration(float64(left) / rate * float64(time.Second)))
	if e.shown.IsZero() {
		e.shown = predicted
	} else {
		share := 0.05
		if elapsed < settling {
			share = 0.10 // little data yet: hold still unless clearly wrong
		}
		tolerance := time.Duration(math.Max(float64(10*time.Second), share*float64(predicted.Sub(now))))
		if d := predicted.Sub(e.shown); d > tolerance || d < -tolerance {
			e.shown = predicted
		}
	}
	if !e.shown.After(now) {
		// Running late but still inside the tolerance: never show 0 or a
		// time in the past while work remains.
		e.shown = predicted
	}
	return e.shown.Sub(now), e.shown
}
