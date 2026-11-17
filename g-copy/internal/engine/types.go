// Package engine copies source folders to one or more destinations and
// verifies every copied file by reading it back and comparing checksums.
package engine

import "time"

const (
	// Version is written into reports.
	Version = "0.3.0"

	chunkSize       = 4 << 20  // read/write unit
	bigFileSize     = 16 << 20 // files this size or larger are copied one at a time
	fileWorkers     = 4        // small files handled in parallel
	statWorkers     = 16
	mtimeTolerance  = 2 * time.Second // FAT/exFAT/SMB round modification times
	maxErrors       = 200
	deadAfterFails  = 10 // consecutive failed files before a destination is given up
	partialSuffix   = ".gcopy-partial"
	ReplacedDirName = "_G-Copy_Replaced"
	RemovedDirName  = "_G-Copy_Removed"

	maxRemoveList = 300 // file names shown per destination before syncing
)

// Options describes one backup run.
type Options struct {
	Sources      []string `json:"sources"`
	Destinations []string `json:"destinations"`
	Algo         string   `json:"algo"`      // "xxh64" (default) or "md5"
	Subfolder    bool     `json:"subfolder"` // copy into <destination>/<source name>/
	Reverify     bool     `json:"reverify"`  // re-hash files that are already up to date
	Mirror       bool     `json:"mirror"`    // sync: move aside destination files the source no longer has
}

// Status is the lifecycle stage of a job.
type Status string

const (
	StatusScanning   Status = "scanning"
	StatusComparing  Status = "comparing"
	StatusConfirming Status = "confirming" // sync: waiting for the user to approve the list
	StatusCopying    Status = "copying"
	StatusDone       Status = "done"
	StatusFailed     Status = "failed"
	StatusCancelled  Status = "cancelled"
)

// Sync outcomes, reported in State.Mirror.
const (
	MirrorOff      = ""         // sync not requested
	MirrorNothing  = "nothing"  // requested; the destinations had nothing extra
	MirrorPending  = "pending"  // waiting for the user's answer
	MirrorApproved = "approved" // the user agreed; files are moved aside
	MirrorDeclined = "declined" // the user chose to leave them
	MirrorSkipped  = "skipped"  // not done for safety (see Warnings)
)

// Finished reports whether the job has stopped running.
func (s Status) Finished() bool {
	return s == StatusDone || s == StatusFailed || s == StatusCancelled
}

// FileError is one problem found during a run.
type FileError struct {
	Path    string `json:"path"`
	Dest    string `json:"dest,omitempty"`
	Message string `json:"message"`
}

// DestState is the per-destination part of a job snapshot.
type DestState struct {
	Path          string   `json:"path"`
	Free          int64    `json:"free"`
	Need          int64    `json:"need"`
	Copied        int64    `json:"copied"`
	Skipped       int64    `json:"skipped"`
	Reverified    int64    `json:"reverified"`
	Replaced      int64    `json:"replaced"`
	Failed        int64    `json:"failed"`
	Bytes         int64    `json:"bytes"`
	Stopped       bool     `json:"stopped"`
	ToRemove      int64    `json:"toRemove"` // sync: files found that the source no longer has
	ToRemoveBytes int64    `json:"toRemoveBytes"`
	RemoveList    []string `json:"removeList"` // their names (at most maxRemoveList)
	Removed       int64    `json:"removed"`    // moved to _G-Copy_Removed
	Complete      bool     `json:"complete"`   // finished, and holds every file it should
	Reports       []string `json:"reports"`
	Folders       []string `json:"folders"`
}

// State is a point-in-time snapshot of a job, safe to serialise.
type State struct {
	ID            string      `json:"id"`
	Status        Status      `json:"status"`
	Message       string      `json:"message,omitempty"`
	Options       Options     `json:"options"`
	StartedAt     time.Time   `json:"startedAt"`
	EndedAt       *time.Time  `json:"endedAt,omitempty"`
	Seconds       float64     `json:"seconds"`
	ScanFiles     int64       `json:"scanFiles"`
	ScanBytes     int64       `json:"scanBytes"`
	Excluded      int64       `json:"excluded"`
	Special       int64       `json:"special"`
	WorkTotal     int64       `json:"workTotal"`
	WorkDone      int64       `json:"workDone"`
	Speed         float64     `json:"speed"`
	ETA           float64     `json:"eta"`
	FilesCopied   int64       `json:"filesCopied"`
	FilesSkipped  int64       `json:"filesSkipped"`
	FilesVerified int64       `json:"filesVerified"`
	FilesFailed   int64       `json:"filesFailed"`
	BytesCopied   int64       `json:"bytesCopied"`
	ErrorCount    int64       `json:"errorCount"`
	Errors        []FileError `json:"errors"`
	Warnings      []string    `json:"warnings"`
	Mirror        string      `json:"mirror"` // sync outcome; see the Mirror* constants
	Current       []string    `json:"current"`
	Dests         []DestState `json:"dests"`
}
