// TICK desktop satellite, Windows: everything that is not drawing.
//
// The same rules as the macOS satellite (client/desktop/macos/Satellite.swift)
// and the editor extension (client/vscode/src/core.js), kept in a file with no
// Windows calls so the tests run on any machine. win.go draws; this decides.
//
// What it reads: the hook's activity marks (tag `cd`, the desktop app), the
// creative the daemon picked, and its own settings. What it writes: ticks into
// the same ticks.ndjson the terminal and the editor append to, and where the
// person dragged the strip. Never anything from inside Claude's window.

package main

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

// The editor's PANEL_DEFAULTS and the Mac satellite's, same numbers on purpose.
const (
	tickMs        = 3000.0
	maxTurnMs     = 10 * 60 * 1000.0
	lingerMs      = 0.0 // gone as the turn ends: the owner, 08.10
	ticksMaxBytes = 2 * 1024 * 1024
	settleMs      = 220.0
	freshMs       = 2000.0
)

type Paths struct {
	Home, State, Activity, Current, Ticks, PidFile, Config, Placement, Daemon, NodePath string
}

// The apps the strip is drawn over, as on the Mac. Each runs our hook through
// its own agent and tags the note with its own name (hook.mjs); a session is
// drawn over the app it runs in, only while that app is in front. Matched by
// the process's file name, never by a window title.
//
// dy is the strip's midline above the window's bottom edge, in 96-dpi pixels:
// the empty row under each app's message box. Cursor's was measured on the
// Mac; the same app draws the same row on Windows.
type Host struct {
	Tag, Name   string
	Exes        []string
	DY          float64
	Placement   string
	ConfigKey   string // "desktop": {"<key>": {"dx", "dy"}}; "" for Claude, which owns the top level
}

var hosts = []Host{
	{Tag: "cd", Name: "Claude", Exes: []string{"claude.exe"}, DY: 18.5, Placement: "desktop-placement.json"},
	{Tag: "xd", Name: "Codex", Exes: []string{"codex.exe"}, DY: 18.5, Placement: "desktop-placement-codex.json", ConfigKey: "codex"},
	{Tag: "cu", Name: "Cursor", Exes: []string{"cursor.exe"}, DY: 15.5, Placement: "desktop-placement-cursor.json", ConfigKey: "cursor"},
	{Tag: "dv", Name: "Devin", Exes: []string{"devin.exe", "windsurf.exe"}, DY: 18.5, Placement: "desktop-placement-devin.json", ConfigKey: "devin"},
}

// The host whose process this is, or nil.
func hostByExe(exe string) *Host {
	for i := range hosts {
		for _, e := range hosts[i].Exes {
			if e == exe {
				return &hosts[i]
			}
		}
	}
	return nil
}

func pathsFrom(home string) Paths {
	state := filepath.Join(home, "state")
	return Paths{
		Home:      home,
		State:     state,
		Activity:  filepath.Join(state, "activity"),
		Current:   filepath.Join(state, "current.json"),
		Ticks:     filepath.Join(state, "ticks.ndjson"),
		PidFile:   filepath.Join(state, "daemon.pid"),
		Config:    filepath.Join(home, "config.json"),
		Placement: filepath.Join(state, "desktop-placement.json"),
		Daemon:    filepath.Join(home, "daemon.mjs"),
		NodePath:  filepath.Join(home, "node-path.txt"),
	}
}

func tickHome() string {
	if h := os.Getenv("TICK_HOME"); h != "" {
		return h
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".tick")
}

func readJSON(path string) map[string]any {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var out map[string]any
	if json.Unmarshal(data, &out) != nil {
		return nil
	}
	return out
}

func num(m map[string]any, key string) (float64, bool) {
	v, ok := m[key].(float64)
	return v, ok
}

func str(m map[string]any, key string) string {
	v, _ := m[key].(string)
	return v
}

// ------------------------------------------------------------------ sessions

type Session struct {
	ID        string
	TS        float64
	Working   bool
	Lingering bool
}

var sessionID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// Desktop sessions only: a terminal or editor session has its own line, and
// counting it here as well would bill one display twice.
func desktopSessions(dir string, now float64, tag string) []Session {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []Session
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		id := strings.TrimSuffix(name, ".json")
		if !sessionID.MatchString(id) {
			continue
		}
		m := readJSON(filepath.Join(dir, name))
		ts, ok := num(m, "ts")
		if m == nil || !ok || str(m, "ag") != tag {
			continue
		}
		ev := str(m, "ev")
		working := ev == "UserPromptSubmit" && now-ts <= maxTurnMs
		lingering := ev == "Stop" && now-ts <= lingerMs
		if working || lingering {
			out = append(out, Session{ID: id, TS: ts, Working: working, Lingering: lingering})
		}
	}
	return out
}

// One strip on one screen is one display, however many desktop sessions are
// busy behind it: a working session before one that just finished, then the
// one that moved last.
func pickSession(sessions []Session) *Session {
	var best *Session
	for i := range sessions {
		s := &sessions[i]
		if best == nil ||
			(s.Working && !best.Working) ||
			(s.Working == best.Working && s.TS > best.TS) {
			best = s
		}
	}
	return best
}

// ------------------------------------------------------------------ creative

type Creative struct {
	ID, Text, Promo, Accent, ClickURL string
	ShownAt                           float64
}

// Only our own http(s) links, and never with a quote or a control character:
// the same check statusline.sh and the editor make before printing a link.
var safeLink = regexp.MustCompile(`^https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$`)

func safeURL(s string) string {
	if safeLink.MatchString(s) {
		return s
	}
	return ""
}

func currentCreative(path string, now float64) *Creative {
	m := readJSON(path)
	text := str(m, "text")
	if m == nil || text == "" {
		return nil
	}
	if exp, ok := num(m, "expires_at"); ok && exp < now {
		return nil
	}
	shown, _ := num(m, "shown_at")
	return &Creative{ID: str(m, "creative_id"), Text: text, Promo: str(m, "promo_code"),
		Accent: str(m, "accent"), ClickURL: safeURL(str(m, "click_url")), ShownAt: shown}
}

// Segment kinds, coloured by the palette in win.go.
const (
	segQuiet = iota // the "Ad" label
	segName         // the advertiser's name
	segBody         // the offer
	segPromo        // the promo code
)

type Segment struct {
	Text string
	Kind int
}

// A quiet "Ad", then the offer: the advertiser's name and the promo code in
// colour. The name is what comes before the colon in "Linear: issue
// tracking…", if there is a colon early enough to be one: 24 characters,
// counted as characters, so a Cyrillic name is not cut at twelve. The code is
// its first occurrence after the name, as in the terminal and on the Mac; the
// server keeps a code to one occurrence.
func segments(c Creative) []Segment {
	out := []Segment{{"Ad", segQuiet}}
	rest := c.Text
	if i := strings.Index(rest, ":"); i > 0 && utf8.RuneCountInString(rest[:i]) <= 24 {
		out = append(out, Segment{rest[:i], segName})
		rest = rest[i:]
	}
	i := -1
	if c.Promo != "" {
		i = strings.Index(rest, c.Promo)
	}
	if i < 0 {
		return append(out, Segment{rest, segBody})
	}
	if i > 0 {
		out = append(out, Segment{rest[:i], segBody})
	}
	out = append(out, Segment{c.Promo, segPromo})
	if tail := rest[i+len(c.Promo):]; tail != "" {
		out = append(out, Segment{tail, segBody})
	}
	return out
}

// The advertiser's colour on a dark or a light strip. Each name has a shade
// for each, every pair above 6:1 on its surface. The table is
// server/lib/creative.ts; a name not in it is amber.
var accents = map[string][2]uint32{
	"amber": {0xFFB000, 0x8F5600}, "green": {0x3DD68C, 0x1A7044}, "teal": {0x33D6C9, 0x0D6E66},
	"blue": {0x62AEFF, 0x1F5FBF}, "violet": {0xB794FF, 0x6A3FC2}, "pink": {0xFF85BE, 0xA8235F},
	"coral": {0xFF7466, 0xB42318},
}

func accentColor(name string, dark bool) uint32 {
	pair, ok := accents[name]
	if !ok {
		pair = accents["amber"]
	}
	if dark {
		return pair[0]
	}
	return pair[1]
}

// ------------------------------------------------------------------ settings

// Height is ours: the row under Claude's message box. Sideways is the
// person's, within that row, remembered from the last drag. Nothing here can
// take the strip out of the row: dy is clamped whatever the file says.
type Settings struct {
	Enabled bool
	DX, DY  float64
}


func loadSettings(p Paths, h Host) Settings {
	s := Settings{Enabled: true, DY: h.DY}
	if d, ok := readJSON(p.Config)["desktop"].(map[string]any); ok {
		if v, ok := d["enabled"].(bool); ok {
			s.Enabled = v
		}
		own := d
		if h.ConfigKey != "" {
			own, _ = d[h.ConfigKey].(map[string]any)
		}
		if v, ok := num(own, "dx"); ok {
			s.DX = v
		}
		if v, ok := num(own, "dy"); ok {
			s.DY = math.Min(math.Max(v, 12), 32)
		}
	}
	if v, ok := num(readJSON(filepath.Join(p.State, h.Placement)), "dx"); ok {
		s.DX = v
	}
	return s
}

func savePlacement(p Paths, h Host, dx float64) error {
	file := filepath.Join(p.State, h.Placement)
	data, _ := json.Marshal(map[string]float64{"dx": math.Round(dx)})
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

// Where the strip goes, in the window's own pixels: centred on the window plus
// the person's offset, clamped so every point stays inside the window with a
// little air at each end. Returns the left edge and the offset that actually
// applied, which is what a drop should remember.
func placeX(winLeft, winRight, width, dx, margin float64) (left, applied float64) {
	mid := (winLeft + winRight) / 2
	want := mid - width/2 + dx
	left = math.Min(math.Max(want, winLeft+margin), winRight-margin-width)
	return left, left + width/2 - mid
}

// ------------------------------------------------------------------ counting

// One session's counter, as in core.js advance(). Elapsed time is clamped so a
// closed lid does not arrive as two hours of model work.
type Counter struct {
	APIms, DurMs, LastTick float64
}

func advance(prev Counter, working bool, now float64) Counter {
	elapsed := 0.0
	if prev.LastTick > 0 {
		elapsed = math.Max(0, math.Min(now-prev.LastTick, tickMs*2))
	}
	next := Counter{APIms: prev.APIms, DurMs: prev.DurMs + elapsed, LastTick: now}
	if working {
		next.APIms += elapsed
	}
	return next
}

// `dsk:` keeps these in their own stream, like the editor's `vsc:`. The daemon
// salts and hashes the id before anything leaves the machine. Hooks carry no
// model id, and the transcript is never opened to find one.
func tickLine(sessionID, cid string, c Counter, now float64) string {
	data, _ := json.Marshal(map[string]any{
		"ts": now, "sid": "dsk:" + sessionID, "cid": cid,
		"api_ms": c.APIms, "dur_ms": c.DurMs, "model": nil,
	})
	return string(data)
}

func appendTick(p Paths, line string) {
	if _, err := os.Stat(p.State); err != nil {
		return
	}
	if info, err := os.Stat(p.Ticks); err == nil && info.Size() > ticksMaxBytes {
		_ = os.WriteFile(p.Ticks, nil, 0o644)
	}
	f, err := os.OpenFile(p.Ticks, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(line + "\n")
}

// ------------------------------------------------------------------ fully visible

type Rect struct{ L, T, R, B float64 }

func (r Rect) contains(o Rect) bool {
	return o.L >= r.L-0.5 && o.T >= r.T-0.5 && o.R <= r.R+0.5 && o.B <= r.B+0.5
}

// Countable only if every point of the strip is inside Claude's window and on
// a display. Hidden, covered or dragged away, it earns nothing.
func fullyVisible(strip, window, monitor Rect) bool {
	return window.contains(strip) && monitor.contains(strip)
}

// Whether the TICK plugin draws the line inside the Claude app, so the strip
// should not: enabled in Claude Code's own settings, which holds from the
// first instant of a turn, or its "I am here" signal fresh. See the Mac side.
func modDrawsInClaude(p Paths, claudeSettings string, now float64) bool {
	if enabled, ok := readJSON(claudeSettings)["enabledPlugins"].(map[string]any); ok {
		for k, v := range enabled {
			if strings.HasPrefix(k, "tick@") && v == true {
				return true
			}
		}
	}
	if ts, ok := num(readJSON(filepath.Join(p.State, "mod-desktop.json")), "ts"); ok && now-ts < 10000 {
		return true
	}
	return false
}
