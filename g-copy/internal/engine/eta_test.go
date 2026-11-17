package engine

import (
	"math"
	"testing"
	"time"
)

const mb = 1 << 20

// simulate feeds the estimator one sample every half second at the speeds
// rate(t) gives (bytes/s), and reports how often the shown finish moved and
// how far the first estimate was from the real end.
type simResult struct {
	changes    int           // times the shown finish time moved
	lateMoves  int           // …of which after the first minute
	firstAt    time.Duration // when the first estimate appeared
	firstError time.Duration // |first shown finish − real finish|
	maxJump    time.Duration // the biggest single move of the shown finish
}

func simulate(total int64, hint float64, rate func(t time.Duration) float64) simResult {
	t0 := time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC)
	var e estimator
	e.hint = hint
	e.begin(t0, 0)
	var work float64
	var res simResult
	var first, last time.Time
	step := 500 * time.Millisecond
	for el := step; work < float64(total); el += step {
		work += rate(el) * step.Seconds()
		w := int64(math.Min(work, float64(total)))
		_, fin := e.update(t0.Add(el), w, total)
		if fin.IsZero() || w >= total {
			continue
		}
		if first.IsZero() {
			first, res.firstAt = fin, el
		}
		_ = first
		if !last.IsZero() && !fin.Equal(last) {
			res.changes++
			if el > time.Minute && fin.Sub(last).Abs() > 5*time.Second { // ignore last-second rounding
				res.lateMoves++
			}
			if j := fin.Sub(last); j.Abs() > res.maxJump {
				res.maxJump = j.Abs()
			}
		}
		last = fin
	}
	return res
}

func realEnd(total int64, rate func(t time.Duration) float64) time.Duration {
	var work float64
	step := 500 * time.Millisecond
	el := time.Duration(0)
	for work < float64(total) {
		el += step
		work += rate(el) * step.Seconds()
	}
	return el
}

// Speed that swings between 100 and 400 MB/s every couple of seconds, like
// big clips alternating with image sequences: the shown finish must hold
// still, not jump with every swing.
func TestRemainingTimeIgnoresSpeedSwings(t *testing.T) {
	swing := func(t time.Duration) float64 {
		if int(t.Seconds())/2%2 == 0 {
			return 400 * mb
		}
		return 100 * mb
	}
	total := int64(250 * 1000 * mb) // about 17 minutes at the 250 MB/s average
	r := simulate(total, 0, swing)
	end := realEnd(total, swing)
	t.Logf("first estimate after %v; shown finish moved %d times, %d after the first minute (largest move %v); run took %v", r.firstAt, r.changes, r.lateMoves, r.maxJump, end)
	if r.lateMoves > 2 {
		t.Errorf("after the first minute the shown finish still moved %d times in a %v run", r.lateMoves, end)
	}
	// Compare with the old method: the instantaneous speed predicts the end
	// anywhere between the two extremes, a 4x range.
	if r.changes > 6 {
		t.Errorf("the shown finish moved %d times in all", r.changes)
	}
	if r.firstAt > 9*time.Second {
		t.Errorf("first estimate only after %v", r.firstAt)
	}
}

// The estimate converges on the real finish.
func TestRemainingTimeIsAccurate(t *testing.T) {
	steady := func(time.Duration) float64 { return 200 * mb }
	total := int64(200 * 600 * mb) // 10 minutes
	t0 := time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC)
	var e estimator
	e.begin(t0, 0)
	var fin time.Time
	for el := 500 * time.Millisecond; el <= 60*time.Second; el += 500 * time.Millisecond {
		_, fin = e.update(t0.Add(el), int64(steady(0)*el.Seconds()), total)
	}
	want := t0.Add(10 * time.Minute)
	if d := fin.Sub(want).Abs(); d > 15*time.Second {
		t.Errorf("after a minute the finish is off by %v (shown %v, real %v)", d, fin.Format("15:04:05"), want.Format("15:04:05"))
	}
}

// With the speed of the previous backup, an estimate is there at once;
// without it, nothing is shown until there is something to go on.
func TestFirstEstimate(t *testing.T) {
	t0 := time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC)
	total := int64(100 * 1000 * mb)

	var withHint estimator
	withHint.hint = 100 * mb
	withHint.begin(t0, 0)
	left, fin := withHint.update(t0.Add(500*time.Millisecond), 10*mb, total)
	if fin.IsZero() || left < 990*time.Second || left > 1030*time.Second { // ~1000 s at the earlier speed
		t.Errorf("with the last run's speed: %v left", left)
	}

	var without estimator
	without.begin(t0, 0)
	if _, fin := without.update(t0.Add(500*time.Millisecond), 10*mb, total); !fin.IsZero() {
		t.Error("an estimate was shown after half a second with nothing to go on")
	}
	if _, fin := without.update(t0.Add(4*time.Second), 400*mb, total); !fin.IsZero() {
		t.Error("an estimate was shown after 4 seconds with nothing earlier to go on")
	}
	if _, fin := without.update(t0.Add(9*time.Second), 900*mb, total); fin.IsZero() {
		t.Error("still no estimate after 9 seconds")
	}
}

// A real slowdown (the NAS gets busy) does move the finish, within a
// reasonable time, and the remaining time never reaches 0 while work is left.
func TestRemainingTimeFollowsARealSlowdown(t *testing.T) {
	t0 := time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC)
	total := int64(300 * 1000 * mb)
	var e estimator
	e.begin(t0, 0)
	var work float64
	var before, after time.Time
	for el := 500 * time.Millisecond; el <= 6*time.Minute; el += 500 * time.Millisecond {
		speed := 300.0 * mb
		if el > 2*time.Minute {
			speed = 100 * mb // a third of the speed from minute 2
		}
		work += speed * 0.5
		left, fin := e.update(t0.Add(el), int64(work), total)
		if fin.IsZero() {
			continue // still estimating
		}
		if left <= 0 {
			t.Fatalf("remaining time reached 0 at %v with work left", el)
		}
		if el == 2*time.Minute {
			before = fin
		}
		after = fin
	}
	if !after.After(before.Add(5 * time.Minute)) {
		t.Errorf("after a lasting slowdown the finish moved only from %v to %v", before.Format("15:04:05"), after.Format("15:04:05"))
	}
}
