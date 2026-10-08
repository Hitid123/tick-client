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
	for _, s := range desktopSessions(dir, now, "cd") {
		got[s.ID] = s
	}
	// A finished turn no longer lingers: the strip goes as the turn ends.
	if len(got) != 1 || !got["desk"].Working {
		t.Fatalf("want only desk, working, got %+v", got)
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

func TestSegmentsCountCharactersAndTakeTheCodeOnce(t *testing.T) {
	// Twenty characters of Cyrillic are forty bytes; still a name.
	segs := segments(Creative{Text: "Яндекс Облако для дев: GPU · YA10", Promo: "YA10"})
	if segs[1].Kind != segName || segs[1].Text != "Яндекс Облако для дев" {
		t.Fatalf("a Cyrillic name within 24 characters is a name, got %+v", segs[1])
	}
	// The code in the middle: body, code, body, and the code only once.
	segs = segments(Creative{Text: "Use TS30 today", Promo: "TS30"})
	if len(segs) != 4 || segs[2].Kind != segPromo || segs[3].Text != " today" {
		t.Fatalf("got %+v", segs)
	}
}

func TestAccentFallsBackToAmber(t *testing.T) {
	if accentColor("green", true) != 0x3DD68C || accentColor("green", false) != 0x1A7044 {
		t.Fatal("green has its own dark and light shades")
	}
	if accentColor("chartreuse", true) != 0xFFB000 || accentColor("", false) != 0x8F5600 {
		t.Fatal("an unknown or missing colour is amber")
	}
}

func TestCurrentCreativeCarriesTheAccent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "current.json")
	os.WriteFile(path, []byte(`{"text":"Acme: x","accent":"teal","expires_at":9e15}`), 0o644)
	if c := currentCreative(path, 0); c == nil || c.Accent != "teal" {
		t.Fatalf("got %+v", c)
	}
}

func TestPlacementStaysInTheRow(t *testing.T) {
	dir := t.TempDir()
	p := pathsFrom(dir)
	write(t, p.Config, map[string]any{"desktop": map[string]any{"dy": 500, "dx": -40}})
	s := loadSettings(p, hosts[0])
	if s.DY != 32 {
		t.Fatalf("dy must be clamped to the row, got %v", s.DY)
	}
	if s.DX != -40 {
		t.Fatalf("config dx is the starting point, got %v", s.DX)
	}
	if err := os.MkdirAll(p.State, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := savePlacement(p, hosts[0], 77.4); err != nil {
		t.Fatal(err)
	}
	if s := loadSettings(p, hosts[0]); s.DX != 77 {
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

func TestHostsAreKnownByTheirFileName(t *testing.T) {
	for exe, tag := range map[string]string{"claude.exe": "cd", "codex.exe": "xd", "cursor.exe": "cu", "windsurf.exe": "dv"} {
		if h := hostByExe(exe); h == nil || h.Tag != tag {
			t.Fatalf("%s should be %s, got %+v", exe, tag, h)
		}
	}
	if hostByExe("chrome.exe") != nil {
		t.Fatal("a browser is not a host")
	}
}

func TestEachHostKeepsItsOwnPlace(t *testing.T) {
	p := pathsFrom(t.TempDir())
	os.MkdirAll(p.State, 0o755)
	write(t, p.Config, map[string]any{"desktop": map[string]any{"dx": 10, "cursor": map[string]any{"dy": 20}}})
	cursor := *hostByExe("cursor.exe")
	if s := loadSettings(p, cursor); s.DY != 20 || s.DX != 0 {
		t.Fatalf("Cursor reads its own key, got %+v", s)
	}
	if s := loadSettings(p, hosts[0]); s.DX != 10 || s.DY != 18.5 {
		t.Fatalf("Claude keeps the top level, got %+v", s)
	}
	if err := savePlacement(p, cursor, -96); err != nil {
		t.Fatal(err)
	}
	if loadSettings(p, cursor).DX != -96 || loadSettings(p, hosts[0]).DX != 10 {
		t.Fatal("a drag over Cursor must not move the strip over Claude")
	}
}

func TestCodexOnWindowsTakesItsCliTaggedTurns(t *testing.T) {
	dir := t.TempDir()
	now := 1_000_000_000.0
	write(t, filepath.Join(dir, "app.json"), map[string]any{"ts": now - 1000, "ev": "UserPromptSubmit", "ag": "cx"})
	write(t, filepath.Join(dir, "claude.json"), map[string]any{"ts": now - 1000, "ev": "UserPromptSubmit", "ag": "cd"})
	codex := *hostByExe("codex.exe")
	got := desktopSessions(dir, now, append([]string{codex.Tag}, codex.Also...)...)
	if len(got) != 1 || got[0].ID != "app" {
		t.Fatalf("the Codex window takes the cx turn and nothing else, got %+v", got)
	}
}

func TestASessionAnEditorCountsIsNotCountedTwice(t *testing.T) {
	p := pathsFrom(t.TempDir())
	now := 1_000_000_000.0
	write(t, filepath.Join(p.State, "claims", "s1.json"), map[string]any{"owner": "vscode", "hb": now - 3000})
	write(t, filepath.Join(p.State, "claims", "s2.json"), map[string]any{"owner": "vscode", "hb": now - 60000})
	if !claimedElsewhere(p, "s1", now) || claimedElsewhere(p, "s2", now) || claimedElsewhere(p, "s3", now) {
		t.Fatal("a fresh claim counts as elsewhere; a stale or missing one does not")
	}
}
