package engine

// Speed benchmarks on modelled devices. Run with GCOPY_BENCH=1.
//
// Each device (the card reader, each NAS or DAS) can move only so many
// bytes per second: an I/O of n bytes occupies it for n/bandwidth, and
// I/Os on one device wait for each other. A destination's reads and
// writes share that device, as on a real NAS. This measures how well the
// engine keeps the devices busy, independent of this machine's disks.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type device struct {
	mu   sync.Mutex
	bw   float64 // bytes per second
	busy time.Duration
}

type deviceModel struct {
	mu   sync.Mutex
	devs map[string]*device
	def  map[string]float64 // device key -> bandwidth
}

func (m *deviceModel) hook(dev string, n int) {
	m.mu.Lock()
	d := m.devs[dev]
	if d == nil {
		bw := m.def[dev]
		if bw == 0 && strings.HasPrefix(dev, "src") {
			bw = m.def["src"]
		}
		if bw == 0 {
			bw = m.def["*"]
		}
		d = &device{bw: bw}
		m.devs[dev] = d
	}
	m.mu.Unlock()
	t := time.Duration(float64(n) / d.bw * float64(time.Second))
	d.mu.Lock()
	time.Sleep(t)
	d.busy += t
	d.mu.Unlock()
}

func benchRun(t *testing.T, name string, files []int64, dests int, srcBW, dstBW float64) time.Duration {
	return benchRunN(t, name, 1, files, dests, srcBW, dstBW)
}

// benchRunN backs up nsrc source disks, each holding files.
func benchRunN(t *testing.T, name string, nsrc int, files []int64, dests int, srcBW, dstBW float64) time.Duration {
	tmp := t.TempDir()
	var srcs []string
	for s := 0; s < nsrc; s++ {
		src := filepath.Join(tmp, fmt.Sprintf("A%03d", s+1))
		for i, sz := range files {
			writeFile(t, filepath.Join(src, fmt.Sprintf("f%04d.mov", i)), randBytes(int64(s*1000+i), int(sz)), day)
		}
		srcs = append(srcs, src)
	}
	files = append([]int64(nil), files...)
	for s := 1; s < nsrc; s++ {
		files = append(files, files[:len(files)/s]...)
	}
	var ds []string
	for d := 0; d < dests; d++ {
		p := filepath.Join(tmp, fmt.Sprintf("D%d", d))
		os.MkdirAll(p, 0o755)
		ds = append(ds, p)
	}
	testDiskKey = filepath.Base // every source its own disk
	defer func() { testDiskKey = nil }()
	m := &deviceModel{devs: map[string]*device{}, def: map[string]float64{"src": srcBW, "*": dstBW}}
	testIOHook = m.hook
	defer func() { testIOHook = nil }()
	t0 := time.Now()
	st := runJob(t, Options{Sources: srcs, Destinations: ds, Subfolder: true}, nil)
	el := time.Since(t0)
	if st.Status != StatusDone {
		t.Fatalf("%s: %s %+v", name, st.Status, st.Errors)
	}
	var total int64
	for _, s := range files {
		total += s
	}
	busy := ""
	for k, d := range m.devs {
		if strings.HasPrefix(k, "src") {
			k = "disk" + k[3:]
		} else {
			k = filepath.Base(k)
		}
		busy += fmt.Sprintf(" %s %.0f%%", k, 100*d.busy.Seconds()/el.Seconds())
	}
	t.Logf("BENCH %-34s %6.2f s  (%4.0f MB/s of source data; device busy:%s)", name, el.Seconds(), float64(total)/1e6/el.Seconds(), busy)
	return el
}

func TestBenchCopySpeed(t *testing.T) {
	if os.Getenv("GCOPY_BENCH") == "" {
		t.Skip("set GCOPY_BENCH=1")
	}
	const MB = 1 << 20
	big := []int64{96 * MB, 96 * MB, 96 * MB, 96 * MB, 96 * MB, 96 * MB} // camera clips
	small := make([]int64, 300)                                          // an image sequence
	for i := range small {
		small[i] = 2 * MB
	}
	// card reader 600 MB/s; NAS / DAS 600 MB/s each (reads and writes share it)
	benchRun(t, "clips -> 1 NAS", big, 1, 600e6, 600e6)
	benchRun(t, "clips -> NAS + DAS", big, 2, 600e6, 600e6)
	benchRun(t, "image sequence -> 1 NAS", small, 1, 600e6, 600e6)
	benchRun(t, "clips, fast card -> slow NAS", big, 1, 1500e6, 300e6)
	// two disks into one server
	three := big[:3]
	benchRunN(t, "2 disks (300) -> fast NAS (1000)", 2, three, 1, 300e6, 1000e6)
	benchRunN(t, "2 disks (300) -> 1GbE NAS (110)", 2, three, 1, 300e6, 110e6)
}
