package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, path string, v any) {
	t.Helper()
	data, _ := json.Marshal(v)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestOnlyDesktopSessionsCount(t *testing.T) {
	dir := t.TempDir()
	now := 1_000_000_000.0
	write(t, filepath.Join(dir, "desk.json"), map[string]any{"ts": now - 5000, "ev": "UserPromptSubmit", "ag": "cd"})
	write(t, filepath.Join(dir, "term.json"), map[string]any{"ts": now - 5000, "ev": "UserPromptSubmit", "ag": "cc"})
	write(t, filepath.Join(dir, "dead.json"), map[string]any{"ts": now - maxTurnMs - 1, "ev": "UserPromptSubmit", "ag": "cd"})
	write(t, filepath.Join(dir, "done.json"), map[string]any{"ts": now - 1000, "ev": "Stop", "ag": "cd"})
	write(t, filepath.Join(dir, "gone.json"), map[string]any{"ts": now - lingerMs - 1, "ev": "Stop", "ag": "cd"})
	write(t, filepath.Join(dir, "bad id!.json"), map[string]any{"ts": now, "ev": "UserPromptSubmit", "ag": "cd"})

	got := map[string]Session{}
	for _, s := range desktopSessions(dir, now) {
		got[s.ID] = s
	}
	if len(got) != 2 || !got["desk"].Working || !got["done"].Lingering {
		t.Fatalf("want desk working and done lingering, got %+v", got)
	}
}

func TestOneStripCountsOnceWorkingFirst(t *testing.T) {
	s := pickSession([]Session{
		{ID: "finished", TS: 300, Lingering: true},
		{ID: "older", TS: 100, Working: true},
		{ID: "newer", TS: 200, Working: true},
	})
	if s == nil || s.ID != "newer" {
		t.Fatalf("want the newest working session, got %+v", s)
	}
}

func TestCreativeExpiryAndLinkCheck(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "current.json")
	write(t, path, map[string]any{"creative_id": "c1", "text": "Linear: x", "expires_at": 2000, "click_url": `https://x.dev/c/a"onclick`})
	if c := currentCreative(path, 1000); c == nil || c.ClickURL != "" {
		t.Fatalf("a quoted link must be dropped, got %+v", c)
	}
	if c := currentCreative(path, 3000); c != nil {
		t.Fatalf("an expired creative must not show, got %+v", c)
	}
}

func TestSegmentsColourNameAndPromo(t *testing.T) {
	segs := segments(Creative{Text: "Linear: issue tracking · LIN20", Promo: "LIN20"})
	var kinds []int
	var text strings.Builder
	for _, s := range segs {
		kinds = append(kinds, s.Kind)
		if s.Kind != segQuiet {
			text.WriteString(s.Text)
		}
	}
	if text.String() != "Linear: issue tracking · LIN20" {
		t.Fatalf("segments must spell the creative exactly, got %q", text.String())
	}
	want := []int{segQuiet, segName, segBody, segPromo}
	if len(kinds) != len(want) {
		t.Fatalf("kinds %v, want %v", kinds, want)
	}
	for i := range want {
		if kinds[i] != want[i] {
			t.Fatalf("kinds %v, want %v", kinds, want)
		}
	}
}

func TestPlacementStaysInTheRow(t *testing.T) {
	dir := t.TempDir()
	p := pathsFrom(dir)
	write(t, p.Config, map[string]any{"desktop": map[string]any{"dy": 500, "dx": -40}})
	s := loadSettings(p)
	if s.DY != 32 {
		t.Fatalf("dy must be clamped to the row, got %v", s.DY)
	}
	if s.DX != -40 {
		t.Fatalf("config dx is the starting point, got %v", s.DX)
	}
	if err := os.MkdirAll(p.State, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := savePlacement(p, 77.4); err != nil {
		t.Fatal(err)
	}
	if s := loadSettings(p); s.DX != 77 {
		t.Fatalf("a drag overrides config, got %v", s.DX)
	}

	left, applied := placeX(0, 1000, 300, 10_000, 8)
	if left != 1000-8-300 || applied != (1000-8-300)+150-500 {
		t.Fatalf("pushed past the edge must stop at it: left %v applied %v", left, applied)
	}
}

func TestAdvanceMatchesTheEditor(t *testing.T) {
	c := advance(Counter{}, true, 10_000)
	if c.APIms != 0 || c.DurMs != 0 {
		t.Fatalf("the first tick has nothing to compare against, got %+v", c)
	}
	c = advance(c, true, 13_000)
	c = advance(c, false, 16_000)
	if c.APIms != 3000 || c.DurMs != 6000 {
		t.Fatalf("api grows only while working, got %+v", c)
	}
	c = advance(c, true, 16_000+3_600_000)
	if c.APIms != 3000+tickMs*2 {
		t.Fatalf("a closed lid must not arrive as an hour of work, got %+v", c)
	}
	var tick map[string]any
	if err := json.Unmarshal([]byte(tickLine("s1", "c1", c, 1791403762725)), &tick); err != nil {
		t.Fatal(err)
	}
	if tick["sid"] != "dsk:s1" || tick["model"] != nil || !strings.Contains(tickLine("s1", "c1", c, 1791403762725), `"ts":1791403762725`) {
		t.Fatalf("tick shape, got %v", tick)
	}
}

func TestOnlyAFullyVisibleStripCounts(t *testing.T) {
	win := Rect{0, 0, 1000, 800}
	mon := Rect{0, 0, 1920, 1080}
	if !fullyVisible(Rect{100, 760, 400, 782}, win, mon) {
		t.Fatal("a strip inside the window on screen counts")
	}
	if fullyVisible(Rect{900, 760, 1200, 782}, win, mon) {
		t.Fatal("a strip hanging out of the window does not")
	}
	if fullyVisible(Rect{100, 1070, 400, 1092}, Rect{0, 300, 1000, 1100}, mon) {
		t.Fatal("a strip off the bottom of the display does not")
	}
}
