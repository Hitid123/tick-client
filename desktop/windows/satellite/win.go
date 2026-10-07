//go:build windows

// TICK desktop satellite, Windows: the drawing half. logic.go decides.
//
// A borderless, always-on-top tool window laid over the empty row under the
// Claude desktop app's message box, shown while a desktop session is working
// and Claude is the app in front. The same behaviour as on the Mac: it steps
// out of the way while Claude's window moves and comes back once it stops; it
// never takes focus; a click opens the advertiser through our redirect; a drag
// moves it sideways within the row.
//
// What it uses: the outer frame of Claude's window and which window is in
// front, which Windows gives any program, and the system's light or dark
// setting. Nothing inside Claude's window: no UI Automation, no screen capture.
//
// Plain Win32 through syscall, no dependencies, so the whole program is the two
// files next to this one.

package main

import (
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")
	dwmapi   = syscall.NewLazyDLL("dwmapi.dll")
	advapi32 = syscall.NewLazyDLL("advapi32.dll")

	pRegisterClassExW              = user32.NewProc("RegisterClassExW")
	pCreateWindowExW               = user32.NewProc("CreateWindowExW")
	pDefWindowProcW                = user32.NewProc("DefWindowProcW")
	pGetMessageW                   = user32.NewProc("GetMessageW")
	pTranslateMessage              = user32.NewProc("TranslateMessage")
	pDispatchMessageW              = user32.NewProc("DispatchMessageW")
	pSetTimer                      = user32.NewProc("SetTimer")
	pShowWindow                    = user32.NewProc("ShowWindow")
	pSetWindowPos                  = user32.NewProc("SetWindowPos")
	pIsWindowVisible               = user32.NewProc("IsWindowVisible")
	pIsIconic                      = user32.NewProc("IsIconic")
	pEnumWindows                   = user32.NewProc("EnumWindows")
	pGetWindowThreadProcessId      = user32.NewProc("GetWindowThreadProcessId")
	pGetForegroundWindow           = user32.NewProc("GetForegroundWindow")
	pGetClassNameW                 = user32.NewProc("GetClassNameW")
	pGetWindowRect                 = user32.NewProc("GetWindowRect")
	pGetDpiForWindow               = user32.NewProc("GetDpiForWindow")
	pSetProcessDpiAwarenessContext = user32.NewProc("SetProcessDpiAwarenessContext")
	pSetLayeredWindowAttributes    = user32.NewProc("SetLayeredWindowAttributes")
	pSetWindowRgn                  = user32.NewProc("SetWindowRgn")
	pBeginPaint                    = user32.NewProc("BeginPaint")
	pEndPaint                      = user32.NewProc("EndPaint")
	pInvalidateRect                = user32.NewProc("InvalidateRect")
	pFillRect                      = user32.NewProc("FillRect")
	pSetCapture                    = user32.NewProc("SetCapture")
	pReleaseCapture                = user32.NewProc("ReleaseCapture")
	pGetCursorPos                  = user32.NewProc("GetCursorPos")
	pSetCursor                     = user32.NewProc("SetCursor")
	pLoadCursorW                   = user32.NewProc("LoadCursorW")
	pMonitorFromWindow             = user32.NewProc("MonitorFromWindow")
	pGetMonitorInfoW               = user32.NewProc("GetMonitorInfoW")

	pCreateFontW           = gdi32.NewProc("CreateFontW")
	pSelectObject          = gdi32.NewProc("SelectObject")
	pDeleteObject          = gdi32.NewProc("DeleteObject")
	pSetTextColor          = gdi32.NewProc("SetTextColor")
	pSetBkMode             = gdi32.NewProc("SetBkMode")
	pTextOutW              = gdi32.NewProc("TextOutW")
	pGetTextExtentPoint32W = gdi32.NewProc("GetTextExtentPoint32W")
	pCreateSolidBrush      = gdi32.NewProc("CreateSolidBrush")
	pCreateRoundRectRgn    = gdi32.NewProc("CreateRoundRectRgn")
	pFrameRgn              = gdi32.NewProc("FrameRgn")
	pCreateCompatibleDC    = gdi32.NewProc("CreateCompatibleDC")
	pDeleteDC              = gdi32.NewProc("DeleteDC")

	pOpenProcess                = kernel32.NewProc("OpenProcess")
	pQueryFullProcessImageNameW = kernel32.NewProc("QueryFullProcessImageNameW")
	pGetExitCodeProcess         = kernel32.NewProc("GetExitCodeProcess")
	pCloseHandle                = kernel32.NewProc("CloseHandle")
	pCreateMutexW               = kernel32.NewProc("CreateMutexW")
	pGetModuleHandleW           = kernel32.NewProc("GetModuleHandleW")

	pShellExecuteW = shell32.NewProc("ShellExecuteW")

	pDwmGetWindowAttribute = dwmapi.NewProc("DwmGetWindowAttribute")

	pRegGetValueW = advapi32.NewProc("RegGetValueW")
)

const (
	wsPopup           = 0x80000000
	wsExLayered       = 0x00080000
	wsExTopmost       = 0x00000008
	wsExToolwindow    = 0x00000080
	wsExNoactivate    = 0x08000000
	wmPaint           = 0x000F
	wmTimer           = 0x0113
	wmSetCursor       = 0x0020
	wmMouseActivate   = 0x0021
	wmMouseMove       = 0x0200
	wmLButtonDown     = 0x0201
	wmLButtonUp       = 0x0202
	maNoActivate      = 3
	swHide            = 0
	swShowNormal      = 1
	swpNoActivate     = 0x0010
	swpShowWindow     = 0x0040
	hwndTopmost       = ^uintptr(0) // (HWND)-1
	lwaAlpha          = 0x2
	transparent       = 1
	idcHand           = 32649
	dwmaExtendedFrame = 9
	monitorNearest    = 2
	processQueryLimit = 0x1000
	stillActive       = 259
	errorAlreadyExist = 183
	createNoWindow    = 0x08000000
	newProcessGroup   = 0x00000200
	hkeyCurrentUser   = 0x80000001
	rrfRtRegDword     = 0x00000010
)

type point struct{ X, Y int32 }
type rect struct{ L, T, R, B int32 }
type msg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      point
	_       uint32
}
type paintStruct struct {
	Hdc       uintptr
	Erase     int32
	Paint     rect
	Restore   int32
	IncUpdate int32
	Reserved  [32]byte
}
type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   uintptr
	Icon       uintptr
	Cursor     uintptr
	Background uintptr
	MenuName   *uint16
	ClassName  *uint16
	IconSm     uintptr
}
type monitorInfo struct {
	Size    uint32
	Monitor rect
	Work    rect
	Flags   uint32
}

func u16(s string) *uint16 { p, _ := syscall.UTF16PtrFromString(s); return p }
func nowMs() float64       { return float64(time.Now().UnixMilli()) }

// COLORREF is 0x00BBGGRR.
func rgb(hex uint32) uintptr {
	r, g, b := (hex>>16)&0xff, (hex>>8)&0xff, hex&0xff
	return uintptr(b<<16 | g<<8 | r)
}

// The brand guide's tokens, both sides of it, as on the Mac.
type palette struct{ surface, border, quiet, bright, settled, accent uint32 }

var (
	darkPal  = palette{0x191817, 0x332F2B, 0x8A8782, 0xF0EEE9, 0xA8A49E, 0xFFB000}
	lightPal = palette{0xFFFFFF, 0xD6D2CB, 0x8A8782, 0x191817, 0x5C5955, 0x8F5600}
)

// ------------------------------------------------------------------ state

var (
	paths      = pathsFrom(tickHome())
	hwnd       uintptr
	shown      bool
	alpha      = 0
	creative   *Creative
	pal        = darkPal
	scale      = 1.0
	stripW     int32
	stripH     int32
	lastWin    *rect
	settledAt  float64
	counters   = map[string]Counter{}
	lastTick   float64
	themeAt    float64
	dark       = true
	daemonTry  float64
	pressing   bool
	dragging   bool
	pressX     int32
	dragBase   float64
	dragDX     *float64
	appliedDX  float64
	stripRect  Rect
	arrivedAt  float64
	rgnW, rgnH int32
	fonts      = map[int]uintptr{}
	fontsScale float64
)

// ------------------------------------------------------------------ Claude's window

type claudeWin struct {
	hwnd uintptr
	pid  uint32
	r    rect
	dpi  uint32
}

func processName(pid uint32) string {
	h, _, _ := pOpenProcess.Call(processQueryLimit, 0, uintptr(pid))
	if h == 0 {
		return ""
	}
	defer pCloseHandle.Call(h)
	buf := make([]uint16, 1024)
	n := uint32(len(buf))
	if ok, _, _ := pQueryFullProcessImageNameW.Call(h, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&n))); ok == 0 {
		return ""
	}
	return strings.ToLower(filepath.Base(syscall.UTF16ToString(buf[:n])))
}

func className(w uintptr) string {
	buf := make([]uint16, 256)
	n, _, _ := pGetClassNameW.Call(w, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return syscall.UTF16ToString(buf[:n])
}

// The visible frame, without the invisible resize border Windows 10 adds
// around every window, which GetWindowRect would include.
func frameOf(w uintptr) rect {
	var r rect
	if res, _, _ := pDwmGetWindowAttribute.Call(w, dwmaExtendedFrame, uintptr(unsafe.Pointer(&r)), unsafe.Sizeof(r)); res != 0 {
		pGetWindowRect.Call(w, uintptr(unsafe.Pointer(&r)))
	}
	return r
}

// Claude's main window: the largest visible, not minimised, top-level Electron
// window of a process named claude.exe. Matched by process, not by title: the
// title is exactly what we have no business reading.
//
// The callback is made once. Windows callbacks from Go are a fixed pool that is
// never freed, and making one per search — sixteen times a second — runs it
// dry in about two minutes and takes the process down.
var (
	best         *claudeWin
	enumCallback = syscall.NewCallback(enumWindow)
)

func findClaude() *claudeWin {
	best = nil
	pEnumWindows.Call(enumCallback, 0)
	return best
}

func enumWindow(w, _ uintptr) uintptr {
	if v, _, _ := pIsWindowVisible.Call(w); v == 0 {
		return 1
	}
	if m, _, _ := pIsIconic.Call(w); m != 0 {
		return 1
	}
	if className(w) != "Chrome_WidgetWin_1" {
		return 1
	}
	var pid uint32
	pGetWindowThreadProcessId.Call(w, uintptr(unsafe.Pointer(&pid)))
	if processName(pid) != "claude.exe" {
		return 1
	}
	r := frameOf(w)
	if r.R-r.L < 400 || r.B-r.T < 300 {
		return 1
	}
	area := int64(r.R-r.L) * int64(r.B-r.T)
	if best == nil || area > int64(best.r.R-best.r.L)*int64(best.r.B-best.r.T) {
		dpi, _, _ := pGetDpiForWindow.Call(w)
		if dpi == 0 {
			dpi = 96
		}
		best = &claudeWin{hwnd: w, pid: pid, r: r, dpi: uint32(dpi)}
	}
	return 1
}

func foregroundPid() uint32 {
	w, _, _ := pGetForegroundWindow.Call()
	var pid uint32
	pGetWindowThreadProcessId.Call(w, uintptr(unsafe.Pointer(&pid)))
	return pid
}

func monitorOf(w uintptr) Rect {
	m, _, _ := pMonitorFromWindow.Call(w, monitorNearest)
	mi := monitorInfo{Size: uint32(unsafe.Sizeof(monitorInfo{}))}
	pGetMonitorInfoW.Call(m, uintptr(unsafe.Pointer(&mi)))
	return Rect{float64(mi.Monitor.L), float64(mi.Monitor.T), float64(mi.Monitor.R), float64(mi.Monitor.B)}
}

// Apps light or dark, the setting Claude follows by default.
func systemDark() bool {
	var v, size uint32 = 1, 4
	pRegGetValueW.Call(hkeyCurrentUser,
		uintptr(unsafe.Pointer(u16(`Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`))),
		uintptr(unsafe.Pointer(u16("AppsUseLightTheme"))), rrfRtRegDword, 0,
		uintptr(unsafe.Pointer(&v)), uintptr(unsafe.Pointer(&size)))
	return v == 0
}

// ------------------------------------------------------------------ daemon

// The daemon does the network: it fetches creatives and uploads impressions.
// On a machine with only the desktop app nothing else would start it, so the
// satellite does, at most every half minute, without a console window.
func ensureDaemon() {
	now := nowMs()
	if now-daemonTry < 30000 {
		return
	}
	daemonTry = now
	if data, err := os.ReadFile(paths.PidFile); err == nil {
		var pid uint32
		for _, c := range strings.TrimSpace(string(data)) {
			if c < '0' || c > '9' {
				pid = 0
				break
			}
			pid = pid*10 + uint32(c-'0')
		}
		if pid > 0 {
			if h, _, _ := pOpenProcess.Call(processQueryLimit, 0, uintptr(pid)); h != 0 {
				var code uint32
				pGetExitCodeProcess.Call(h, uintptr(unsafe.Pointer(&code)))
				pCloseHandle.Call(h)
				if code == stillActive {
					return
				}
			}
		}
	}
	if _, err := os.Stat(paths.Daemon); err != nil {
		return
	}
	node := "node"
	if data, err := os.ReadFile(paths.NodePath); err == nil && strings.TrimSpace(string(data)) != "" {
		node = strings.TrimSpace(string(data))
	}
	cmd := exec.Command(node, paths.Daemon)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow | newProcessGroup}
	if log, err := os.OpenFile(filepath.Join(paths.State, "daemon.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
		cmd.Stdout, cmd.Stderr = log, log
	}
	if cmd.Start() == nil {
		_ = cmd.Process.Release()
	}
}

// ------------------------------------------------------------------ drawing

func font(kind int) uintptr {
	if fontsScale != scale {
		for _, f := range fonts {
			pDeleteObject.Call(f)
		}
		fonts = map[int]uintptr{}
		fontsScale = scale
	}
	if f, ok := fonts[kind]; ok {
		return f
	}
	size, weight := 12.0, 400
	switch kind {
	case segQuiet:
		size, weight = 10, 600
	case segName:
		weight = 600
	case segPromo:
		weight = 700
	}
	f, _, _ := pCreateFontW.Call(uintptr(-int32(math.Round(size*scale))), 0, 0, 0, uintptr(weight), 0, 0, 0,
		1, 0, 0, 5 /* CLEARTYPE_QUALITY */, 0, uintptr(unsafe.Pointer(u16("Segoe UI"))))
	fonts[kind] = f
	return f
}

func textWidth(dc uintptr, s string, kind int) int32 {
	pSelectObject.Call(dc, font(kind))
	t, _ := syscall.UTF16FromString(s)
	var sz struct{ CX, CY int32 }
	pGetTextExtentPoint32W.Call(dc, uintptr(unsafe.Pointer(&t[0])), uintptr(len(t)-1), uintptr(unsafe.Pointer(&sz)))
	return sz.CX
}

// "Ad" is followed by a wider gap than the words around it, as on the Mac.
func gapAfter(kind int) int32 {
	if kind == segQuiet {
		return int32(math.Round(9 * scale))
	}
	return 0
}

func measure() int32 {
	dc, _, _ := pCreateCompatibleDC.Call(0)
	defer pDeleteDC.Call(dc)
	pad := int32(math.Round(11 * scale))
	w := pad*2 + int32(math.Round(4*scale))
	for _, s := range segments(*creative) {
		w += textWidth(dc, s.Text, s.Kind) + gapAfter(s.Kind)
	}
	return w
}

func colorFor(kind int, fresh bool) uint32 {
	switch kind {
	case segQuiet:
		return pal.quiet
	case segName, segPromo:
		return pal.accent
	}
	if fresh {
		return pal.bright
	}
	return pal.settled
}

func paint(w uintptr) {
	var ps paintStruct
	dc, _, _ := pBeginPaint.Call(w, uintptr(unsafe.Pointer(&ps)))
	defer pEndPaint.Call(w, uintptr(unsafe.Pointer(&ps)))
	if creative == nil {
		return
	}
	bg, _, _ := pCreateSolidBrush.Call(rgb(pal.surface))
	full := rect{0, 0, stripW, stripH}
	pFillRect.Call(dc, uintptr(unsafe.Pointer(&full)), bg)
	pDeleteObject.Call(bg)
	radius := int32(math.Round(7 * scale * 2))
	rgn, _, _ := pCreateRoundRectRgn.Call(0, 0, uintptr(stripW), uintptr(stripH), uintptr(radius), uintptr(radius))
	border, _, _ := pCreateSolidBrush.Call(rgb(pal.border))
	pFrameRgn.Call(dc, rgn, border, 1, 1)
	pDeleteObject.Call(border)
	pDeleteObject.Call(rgn)

	pSetBkMode.Call(dc, transparent)
	fresh := nowMs()-arrivedAt < freshMs
	x := int32(math.Round(11 * scale))
	for _, s := range segments(*creative) {
		pSelectObject.Call(dc, font(s.Kind))
		pSetTextColor.Call(dc, rgb(colorFor(s.Kind, fresh)))
		t, _ := syscall.UTF16FromString(s.Text)
		var sz struct{ CX, CY int32 }
		pGetTextExtentPoint32W.Call(dc, uintptr(unsafe.Pointer(&t[0])), uintptr(len(t)-1), uintptr(unsafe.Pointer(&sz)))
		y := (stripH - sz.CY) / 2
		pTextOutW.Call(dc, uintptr(x), uintptr(y), uintptr(unsafe.Pointer(&t[0])), uintptr(len(t)-1))
		x += sz.CX + gapAfter(s.Kind)
	}
}

func hide() {
	if shown {
		pShowWindow.Call(hwnd, swHide)
		pSetLayeredWindowAttributes.Call(hwnd, 0, 0, lwaAlpha)
		shown = false
		alpha = 0
	}
}

// Off screen counts nothing, and the next stretch starts from zero rather than
// inheriting the gap as elapsed time.
func offscreen() {
	hide()
	lastWin = nil
	counters = map[string]Counter{}
}

func show(c *Creative, cw *claudeWin, s Settings) {
	changed := creative == nil || c.ID != creative.ID || c.Text != creative.Text || c.ShownAt != creative.ShownAt
	if changed || !shown {
		// Bright for two seconds from when the strip arrives, then a step
		// down: the guide's one bit of motion, as on the Mac.
		arrivedAt = nowMs()
	}
	creative = c
	scale = float64(cw.dpi) / 96
	stripH = int32(math.Round(22 * scale))
	w := measure()
	maxW := cw.r.R - cw.r.L - int32(math.Round(40*scale))
	if w > maxW {
		w = maxW
	}
	dx := s.DX
	if dragDX != nil {
		dx = *dragDX
	}
	left, applied := placeX(float64(cw.r.L), float64(cw.r.R), float64(w), dx*scale, 8*scale)
	appliedDX = applied / scale
	top := float64(cw.r.B) - s.DY*scale - float64(stripH)/2
	x, y := int32(math.Round(left)), int32(math.Round(top))
	stripRect = Rect{float64(x), float64(y), float64(x + w), float64(y + stripH)}

	stripW = w
	if w != rgnW || stripH != rgnH {
		rgnW, rgnH = w, stripH
		radius := int32(math.Round(7 * scale * 2))
		rgn, _, _ := pCreateRoundRectRgn.Call(0, 0, uintptr(w+1), uintptr(stripH+1), uintptr(radius), uintptr(radius))
		pSetWindowRgn.Call(hwnd, rgn, 1) // the window owns the region from here
	}
	pSetWindowPos.Call(hwnd, hwndTopmost, uintptr(x), uintptr(y), uintptr(w), uintptr(stripH), swpNoActivate|swpShowWindow)
	if changed || nowMs()-arrivedAt < freshMs+300 {
		pInvalidateRect.Call(hwnd, 0, 1)
	}
	if !shown {
		shown = true
		alpha = 0
	}
	// A short fade in, three steps of the 60 ms timer.
	if alpha < 255 {
		alpha = int(math.Min(255, float64(alpha+90)))
		pSetLayeredWindowAttributes.Call(hwnd, 0, uintptr(alpha), lwaAlpha)
	}
}

// ------------------------------------------------------------------ the loop

func loop() {
	s := loadSettings(paths)
	var sessions []Session
	if s.Enabled {
		sessions = desktopSessions(paths.Activity, nowMs())
	}
	if len(sessions) == 0 {
		offscreen()
		return
	}
	ensureDaemon()

	// Only while Claude itself is in front: an ad floating over some other app
	// would be showing to nobody we can count, and in the way of everything.
	cw := findClaude()
	if cw == nil || foregroundPid() != cw.pid {
		if !pressing {
			offscreen()
		}
		return
	}
	now := nowMs()
	c := currentCreative(paths.Current, now)
	if c == nil {
		offscreen()
		return
	}
	if now-themeAt > 2000 {
		themeAt = now
		dark = systemDark()
	}
	if dark {
		pal = darkPal
	} else {
		pal = lightPal
	}

	// A separate window cannot move in step with another app's, so it steps
	// out of the way while Claude's window moves and returns once it stops.
	if lastWin == nil || *lastWin != cw.r {
		r := cw.r
		lastWin = &r
		settledAt = now
		hide()
		return
	}
	if now-settledAt < settleMs {
		return
	}
	show(c, cw, s)

	if now-lastTick < tickMs {
		return
	}
	lastTick = now
	win := Rect{float64(cw.r.L), float64(cw.r.T), float64(cw.r.R), float64(cw.r.B)}
	if !shown || alpha < 255 || dragDX != nil || c.ID == "" || !fullyVisible(stripRect, win, monitorOf(cw.hwnd)) {
		return
	}
	pick := pickSession(sessions)
	for id := range counters {
		if id != pick.ID {
			delete(counters, id)
		}
	}
	counters[pick.ID] = advance(counters[pick.ID], pick.Working, now)
	appendTick(paths, tickLine(pick.ID, c.ID, counters[pick.ID], now))
}

func cursorX() int32 {
	var p point
	pGetCursorPos.Call(uintptr(unsafe.Pointer(&p)))
	return p.X
}

func wndProc(w uintptr, m uint32, wp, lp uintptr) uintptr {
	switch m {
	case wmTimer:
		loop()
		return 0
	case wmPaint:
		paint(w)
		return 0
	case wmMouseActivate:
		// Clicking the strip must not take focus from Claude.
		return maNoActivate
	case wmSetCursor:
		h, _, _ := pLoadCursorW.Call(0, idcHand)
		pSetCursor.Call(h)
		return 1
	case wmLButtonDown:
		pSetCapture.Call(w)
		pressing, dragging = true, false
		pressX = cursorX()
		dragBase = loadSettings(paths).DX
		return 0
	case wmMouseMove:
		if !pressing {
			return 0
		}
		moved := cursorX() - pressX
		if !dragging && moved > -4 && moved < 4 {
			return 0
		}
		dragging = true
		d := dragBase + float64(moved)/scale
		dragDX = &d
		if cw := findClaude(); cw != nil && creative != nil {
			show(creative, cw, loadSettings(paths))
		}
		return 0
	case wmLButtonUp:
		pReleaseCapture.Call()
		wasDragging := dragging
		pressing, dragging = false, false
		if wasDragging {
			// Where it actually landed after clamping, so a strip pushed
			// against an edge does not remember a position past it.
			_ = savePlacement(paths, appliedDX)
			dragDX = nil
		} else if creative != nil && creative.ClickURL != "" {
			// The server counts the click at the other end of this redirect,
			// exactly as for the terminal's link.
			pShellExecuteW.Call(0, uintptr(unsafe.Pointer(u16("open"))),
				uintptr(unsafe.Pointer(u16(creative.ClickURL))), 0, 0, swShowNormal)
		}
		return 0
	}
	r, _, _ := pDefWindowProcW.Call(w, uintptr(m), wp, lp)
	return r
}

func main() {
	// One satellite per login. A second copy, from a reinstall or a double
	// start, leaves quietly.
	if _, _, err := pCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(u16(`Local\TickSatellite`)))); err == syscall.Errno(errorAlreadyExist) {
		return
	}
	// Per-monitor DPI awareness, so window frames and our strip are in the
	// same real pixels on a scaled display.
	pSetProcessDpiAwarenessContext.Call(^uintptr(3)) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4

	inst, _, _ := pGetModuleHandleW.Call(0)
	cls := u16("TickSatelliteStrip")
	wc := wndClassEx{WndProc: syscall.NewCallback(wndProc), Instance: inst, ClassName: cls}
	wc.Size = uint32(unsafe.Sizeof(wc))
	pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	hwnd, _, _ = pCreateWindowExW.Call(wsExLayered|wsExTopmost|wsExToolwindow|wsExNoactivate,
		uintptr(unsafe.Pointer(cls)), uintptr(unsafe.Pointer(u16("TICK"))), wsPopup,
		0, 0, 10, 10, 0, 0, inst, 0)
	pSetLayeredWindowAttributes.Call(hwnd, 0, 0, lwaAlpha)
	pSetTimer.Call(hwnd, 1, 60, 0)

	var m msg
	for {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			return
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		pDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
}
