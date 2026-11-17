// G-Copy backs up drives to NAS/DAS storage and verifies every file.
//
// It runs a small local server and shows its interface in the browser.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"gcopy/internal/engine"
	"gcopy/internal/server"
)

func main() {
	port := flag.Int("port", 47800, "port (tries the next one if busy)")
	noOpen := flag.Bool("no-open", false, "do not open the browser")
	volumes := flag.String("volumes", "", "extra folders whose sub-folders are listed as disks (comma separated, e.g. /mnt/nas)")
	desktop := flag.Bool("desktop", false, "run as the desktop app's engine (exits when the app closes)")
	flag.Parse()
	if *desktop {
		*noOpen = true
		*port = 0 // any free port; the app window is told the address
		// If the app window dies, our output pipe breaks. Without this, the
		// next line we print would kill us before we could clean up.
		signal.Ignore(syscall.SIGPIPE)
	}

	configDir := os.Getenv("GCOPY_CONFIG_DIR")
	if configDir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			base = os.TempDir()
		}
		configDir = filepath.Join(base, "G-Copy")
	}
	var extra []string
	for _, v := range strings.Split(*volumes, ",") {
		if v = strings.TrimSpace(v); v != "" {
			extra = append(extra, v)
		}
	}

	// Loopback only: the app is never reachable from the network.
	var ln net.Listener
	var err error
	for p := *port; p < *port+20; p++ {
		if ln, err = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p)); err == nil {
			break
		}
	}
	if ln == nil {
		fmt.Fprintln(os.Stderr, "Cannot open a port:", err)
		os.Exit(1)
	}

	srv := server.New(configDir, extra)
	stopScheduler := make(chan struct{})
	go srv.RunScheduler(stopScheduler)
	url := fmt.Sprintf("http://%s/?token=%s", ln.Addr(), srv.Token())
	httpSrv := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}

	fmt.Printf("G-Copy %s\n\n  Open: %s\n  Quit: Ctrl+C (or close this window)\n\n", engine.Version, url)
	if !*noOpen {
		openBrowser(url)
	}

	stop := make(chan struct{}, 2)
	go func() {
		sig := make(chan os.Signal, 1)
		// SIGHUP: the terminal window was closed.
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
		<-sig
		stop <- struct{}{}
	}()
	if *desktop {
		// The app window holds our stdin open. When it closes it, or dies,
		// we clean up and leave too, so no engine is ever left running
		// unseen. (Windows has no signal for this; a closed pipe works
		// everywhere.)
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			stop <- struct{}{}
		}()
	}
	go func() {
		<-stop
		close(stopScheduler)
		srv.CancelRunning() // first of all: removes unfinished temporary files
		fmt.Println("\nCleaning up the copy in progress and quitting.")
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(ctx)
	}()

	if err := httpSrv.Serve(ln); err != nil && err != http.ErrServerClosed {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err == nil {
		go func() { _ = cmd.Wait() }()
	}
}
