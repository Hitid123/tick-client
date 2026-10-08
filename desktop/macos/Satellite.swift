// TICK desktop satellite, macOS.
//
// The Claude desktop app runs our hook but has no status line to draw into, so
// the satellite draws its own: a borderless strip laid over the empty row at
// the bottom of Claude's message box, shown while a desktop session is working.
// Since 08.10 the same for the Codex app, which runs the Codex hook from the
// same config.toml as the Codex CLI (see HOSTS below).
// The owner chose that placement on 07.10 knowing the two costs, written down
// in vault/Решения.md: it can be mistaken for Claude's own interface, and its
// position is inferred, not read.
//
// What it uses, and what it deliberately does not:
//   - the outer frame of Claude's window, which macOS gives any program with no
//     permission at all. Not the window's title, not its contents.
//   - NO Accessibility permission. That would place the strip exactly, and it
//     would also let this program read the conversation. We promise not to.
//   - NO Screen Recording permission, for the same reason.
//   - one setting from Claude's own config.json, userThemeMode, so the strip
//     matches the theme the person chose in Claude. Nothing else from it is
//     used, and nothing from it leaves the machine.
//   - the same files as every other TICK client: activity marks from the hook
//     (tag `cd` for the desktop app), the creative the daemon picked, and the
//     same ticks.ndjson the terminal and the editor append to.
//
// So the strip always says TICK. It is our line laid on top, not a piece of
// Claude, and it should never look like one.
//
// Counting is the editor extension's rule, ported line for line from
// client/vscode/src/core.js `advance()`: a tick every three seconds, api_ms
// grows by wall time only while the model works, and the daemon's unchanged
// aggregate() turns that into impressions. One condition is stricter than in
// the terminal: a tick is written only while the strip is actually on screen,
// which here we can know.
//
// Build: sh client/desktop/macos/build.sh

import AppKit
import CoreGraphics

/// The apps the strip is drawn over. Each runs our hook through its own agent
/// and tags the note with its own name: Claude Code inside the Claude app says
/// `cd`, Codex inside the Codex app says `xd` (hook.mjs tells them apart by the
/// bundle id every app hands to what it starts — checked on the running Codex
/// app-server on 08.10). A session is drawn over the app it is running in and
/// nowhere else, and only while that app is in front.
///
/// dy is where the strip sits, measured up from the bottom of the window to its
/// midline: the empty row under Claude's message box, and the same idea for
/// Codex until a screenshot says otherwise. It is the app's, not the person's.
struct Host {
  let bundle: String; let tag: String; let name: String; let dy: CGFloat; let placement: String
}
let HOSTS = [
  Host(bundle: "com.anthropic.claudefordesktop", tag: "cd", name: "Claude", dy: 18.5,
       placement: "state/desktop-placement.json"),
  Host(bundle: "com.openai.codex", tag: "xd", name: "Codex", dy: 18.5,
       placement: "state/desktop-placement-codex.json"),
  // Cursor 3 opens projects in its agent window, which runs no third-party
  // extension and so has no status bar of ours — checked in its logs on 08.10:
  // only Cursor's own extensions start there. Its agent's hook still reports
  // (`cu`), so on a Mac the strip draws over Cursor as over Codex, whichever of
  // its windows is open. Devin the same, for its agent (`dv`).
  // 15.5: the row under Cursor's composer ("This Mac"), measured on the
  // owner's screenshot of Cursor 3.23 on 08.10 — 30 pt from the window's bottom
  // edge to the composer, the strip centred in it.
  Host(bundle: "com.todesktop.230313mzl4w4u92", tag: "cu", name: "Cursor", dy: 15.5,
       placement: "state/desktop-placement-cursor.json"),
  Host(bundle: "com.exafunction.windsurf", tag: "dv", name: "Devin", dy: 18.5,
       placement: "state/desktop-placement-devin.json"),
]
let CLAUDE = HOSTS[0]
let ENV = ProcessInfo.processInfo.environment
let HOME = ENV["TICK_HOME"] ?? (NSHomeDirectory() as NSString).appendingPathComponent(".tick")
func inHome(_ p: String) -> String { (HOME as NSString).appendingPathComponent(p) }
let STATE = inHome("state")
let ACTIVITY = inHome("state/activity")
let CURRENT = inHome("state/current.json")
let TICKS = inHome("state/ticks.ndjson")
let PIDFILE = inHome("state/daemon.pid")
let CONFIG = inHome("config.json")
let DAEMON = inHome("daemon.mjs")

// The editor's PANEL_DEFAULTS, same numbers on purpose.
let TICK_MS: Double = 3000
let MAX_TURN_MS: Double = 10 * 60 * 1000
let TICKS_MAX_BYTES = 2 * 1024 * 1024
/// How long the strip stays after the turn ends. None: the owner, 08.10, "as
/// soon as it stops, it should go". It used to stay four seconds.
let LINGER_MS: Double = 0

func readJSON(_ path: String) -> [String: Any]? {
  guard let data = FileManager.default.contents(atPath: path) else { return nil }
  return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

func nowMs() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }

// ------------------------------------------------------------------ settings

/// Where the strip sits. Read every cycle, so a change shows up within a second.
///
/// Height is ours, not the person's: the strip lives in the row under Claude's
/// message box, centred between the box and the window's edge, and that row is
/// the same distance from the bottom whatever else is open. dy is that distance.
///
/// Sideways is the person's, within the row. The message box is centred
/// between Claude's left and right panels, so its offset from the window's
/// centre is half the difference of the two — constant while the window is
/// resized, wrong only when a panel opens or closes. The satellite cannot see
/// panels, so the person drags the strip sideways and it remembers (state file,
/// written on drop; config.json "desktop".dx is the starting point).
///
/// Nothing here can take the strip out of that row or off Claude's window: it
/// is clamped, and a strip that is not fully on screen inside the window is not
/// counted. Moving it somewhere nobody looks earns nothing.
struct Settings { var enabled = true; var dx: CGFloat = 0; var dy: CGFloat = 18.5 }

/// config.json "desktop": {"enabled", "dx", "dy"} is Claude's, as it always
/// was; "desktop": {"codex": {"dx", "dy"}} is Codex's. The dragged offset in
/// the host's own placement file wins over both.
func settings(_ host: Host) -> Settings {
  var s = Settings(dy: host.dy)
  if let d = readJSON(CONFIG)?["desktop"] as? [String: Any] {
    if let v = d["enabled"] as? Bool { s.enabled = v }
    let own = host.tag == CLAUDE.tag ? d : (d[host.name.lowercased()] as? [String: Any] ?? [:])
    if let v = own["dx"] as? Double { s.dx = CGFloat(v) }
    // Within the row and nowhere else, whatever is typed into the file.
    if let v = own["dy"] as? Double { s.dy = min(max(CGFloat(v), 12), 32) }
  }
  if let v = readJSON(inHome(host.placement))?["dx"] as? Double { s.dx = CGFloat(v) }
  return s
}

func savePlacement(_ host: Host, dx: CGFloat) {
  let path = inHome(host.placement)
  guard let data = try? JSONSerialization.data(withJSONObject: ["dx": Double(dx.rounded())]) else { return }
  let tmp = path + ".tmp"
  if FileManager.default.createFile(atPath: tmp, contents: data) {
    _ = try? FileManager.default.replaceItemAt(URL(fileURLWithPath: path), withItemAt: URL(fileURLWithPath: tmp))
    if !FileManager.default.fileExists(atPath: path) { try? FileManager.default.moveItem(atPath: tmp, toPath: path) }
  }
}

// ------------------------------------------------------------------- signals

struct Session { let id: String; let ts: Double; let working: Bool; let lingering: Bool }

/// Desktop sessions only: a terminal or editor session has its own line, and
/// counting it here as well would bill one display twice.
func desktopSessions(_ host: Host) -> [Session] {
  let names = (try? FileManager.default.contentsOfDirectory(atPath: ACTIVITY)) ?? []
  let now = nowMs()
  var out: [Session] = []
  for name in names where name.hasSuffix(".json") {
    let id = String(name.dropLast(5))
    guard id.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil,
          let m = readJSON((ACTIVITY as NSString).appendingPathComponent(name)),
          (m["ag"] as? String) == host.tag,
          let ts = m["ts"] as? Double, let ev = m["ev"] as? String else { continue }
    let working = ev == "UserPromptSubmit" && now - ts <= MAX_TURN_MS
    let lingering = ev == "Stop" && now - ts <= LINGER_MS
    if working || lingering { out.append(Session(id: id, ts: ts, working: working, lingering: lingering)) }
  }
  return out
}

struct Creative: Equatable {
  let id: String?; let text: String; let promo: String?; let accent: String?; let shownAt: Double; let clickUrl: URL?
}

/// Only our own http(s) links, and never with a quote or a control character:
/// the same check statusline.sh and the editor make before printing a link.
func safeURL(_ value: Any?) -> URL? {
  guard let s = value as? String,
        s.range(of: "^https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$", options: .regularExpression) != nil else { return nil }
  return URL(string: s)
}

func currentCreative() -> Creative? {
  guard let c = readJSON(CURRENT), let text = c["text"] as? String, !text.isEmpty else { return nil }
  if let exp = c["expires_at"] as? Double, exp < nowMs() { return nil }
  return Creative(id: c["creative_id"] as? String, text: text, promo: c["promo_code"] as? String,
                  accent: c["accent"] as? String,
                  shownAt: c["shown_at"] as? Double ?? 0, clickUrl: safeURL(c["click_url"]))
}

/// The host's main window in Cocoa coordinates, if it is on screen. Matched by
/// process, not by title: the title is exactly what we are not allowed to read.
func hostWindow(_ host: Host) -> NSRect? {
  guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: host.bundle).first else { return nil }
  let pid = Int(app.processIdentifier)
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  var best: CGRect? = nil
  for w in list {
    guard (w[kCGWindowOwnerPID as String] as? Int) == pid,
          (w[kCGWindowLayer as String] as? Int) == 0,
          let b = w[kCGWindowBounds as String] as? [String: Any],
          let r = CGRect(dictionaryRepresentation: b as CFDictionary),
          r.height > 300, r.width > 400 else { continue }
    if best == nil || r.width * r.height > best!.width * best!.height { best = r }
  }
  guard let r = best, let primary = NSScreen.screens.first else { return nil }
  // Window bounds come top-left origin, y down; Cocoa is bottom-left, y up.
  return NSRect(x: r.minX, y: primary.frame.height - r.maxY, width: r.width, height: r.height)
}

// ------------------------------------------------------------------ counting

/// One session's counter, as in core.js advance(). Elapsed time is clamped so a
/// closed lid does not arrive as two hours of model work.
struct Counter { var apiMs: Double = 0; var durMs: Double = 0; var lastTickTs: Double = 0 }

var counters: [String: Counter] = [:]

func appendTick(_ line: String) {
  let fm = FileManager.default
  guard fm.fileExists(atPath: STATE) else { return }
  if let size = (try? fm.attributesOfItem(atPath: TICKS))?[.size] as? Int, size > TICKS_MAX_BYTES {
    fm.createFile(atPath: TICKS, contents: Data())
  }
  if !fm.fileExists(atPath: TICKS) { fm.createFile(atPath: TICKS, contents: Data()) }
  guard let h = FileHandle(forWritingAtPath: TICKS) else { return }
  defer { try? h.close() }
  h.seekToEndOfFile()
  h.write(Data((line + "\n").utf8))
}

func tick(_ s: Session, cid: String, now: Double) {
  let prev = counters[s.id] ?? Counter()
  let raw = prev.lastTickTs > 0 ? now - prev.lastTickTs : 0
  let elapsed = max(0, min(raw, TICK_MS * 2))
  let next = Counter(apiMs: prev.apiMs + (s.working ? elapsed : 0), durMs: prev.durMs + elapsed, lastTickTs: now)
  counters[s.id] = next
  // `dsk:` keeps these in their own stream, like the editor's `vsc:`. The
  // daemon salts and hashes the id before anything leaves the machine. Hooks
  // carry no model id, and we do not open the transcript to find one.
  let obj: [String: Any] = [
    "ts": now, "sid": "dsk:\(s.id)", "cid": cid,
    "api_ms": next.apiMs, "dur_ms": next.durMs, "model": NSNull(),
  ]
  if let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) {
    appendTick(line)
  }
}

// -------------------------------------------------------------------- daemon

var lastDaemonTry: Double = 0

/// The daemon does the network: it fetches creatives and uploads impressions.
/// On a machine with only the desktop app nothing else would start it, so the
/// satellite does, at most every half minute, the same way the editor does.
func ensureDaemon() {
  let now = nowMs()
  if now - lastDaemonTry < 30_000 { return }
  lastDaemonTry = now
  if let s = try? String(contentsOfFile: PIDFILE, encoding: .utf8),
     let pid = Int32(s.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0, kill(pid, 0) == 0 { return }
  guard FileManager.default.fileExists(atPath: DAEMON) else { return }
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
  p.arguments = ["node", DAEMON]
  p.standardInput = FileHandle.nullDevice
  // Appended, as the status line does with >>. A handle opened for writing
  // starts at offset zero and would overwrite the log from the top.
  let log = FileHandle(forWritingAtPath: inHome("state/daemon.log"))
  log?.seekToEndOfFile()
  p.standardOutput = log ?? FileHandle.nullDevice
  p.standardError = log ?? FileHandle.nullDevice
  try? p.run()
}

// ------------------------------------------------------------------ the strip

/// Light or dark, as the person set it in Claude: "light", "dark", or "system"
/// for whatever macOS says. Re-read every couple of seconds, not every frame.
let CLAUDE_CONFIG = (NSHomeDirectory() as NSString).appendingPathComponent("Library/Application Support/Claude/config.json")
var themeReadAt: Double = 0
var claudeTheme = "system"

func darkTheme(_ host: Host) -> Bool {
  // Codex keeps its theme inside its own browser storage, out of reach without
  // reading it; it follows macOS unless told otherwise, and so do we there.
  guard host.tag == CLAUDE.tag else {
    return NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
  }
  let now = nowMs()
  if now - themeReadAt > 2000 {
    themeReadAt = now
    claudeTheme = (readJSON(CLAUDE_CONFIG)?["userThemeMode"] as? String) ?? "system"
  }
  switch claudeTheme {
  case "dark": return true
  case "light": return false
  default: return NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
  }
}

func hex(_ v: UInt32, _ a: CGFloat = 1) -> NSColor {
  NSColor(srgbRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255,
          blue: CGFloat(v & 0xff) / 255, alpha: a)
}

/// The brand guide's tokens, both sides of it. Solid surfaces: the guide
/// rules out glass.
struct Palette {
  let surface, border, quiet, bright, settled: NSColor
  let onDark: Bool
  static let dark = Palette(surface: hex(0x191817), border: hex(0x332F2B), quiet: hex(0x8A8782),
                            bright: hex(0xF0EEE9), settled: hex(0xA8A49E), onDark: true)
  static let light = Palette(surface: hex(0xFFFFFF), border: hex(0xD6D2CB), quiet: hex(0x8A8782),
                             bright: hex(0x191817), settled: hex(0x5C5955), onDark: false)

  /// The advertiser's colour on this surface. Each name has a shade for the
  /// dark strip and a deeper one for the light, because amber on white is
  /// unreadable as a word; every pair clears 6:1 on its surface. The table is
  /// server/lib/creative.ts; a name not in it is amber.
  func accent(_ name: String?) -> NSColor {
    let (d, l) = Palette.accents[name ?? ""] ?? Palette.accents["amber"]!
    return hex(onDark ? d : l)
  }
  static let accents: [String: (UInt32, UInt32)] = [
    "amber": (0xFFB000, 0x8F5600), "green": (0x3DD68C, 0x1A7044), "teal": (0x33D6C9, 0x0D6E66),
    "blue": (0x62AEFF, 0x1F5FBF), "violet": (0xB794FF, 0x6A3FC2), "pink": (0xFF85BE, 0xA8235F),
    "coral": (0xFF7466, 0xB42318),
  ]
}

/// The advertiser's name: what comes before the colon in "Linear: issue
/// tracking…", if there is a colon early enough to be one.
func advertiserRange(_ text: NSString) -> NSRange? {
  let colon = text.range(of: ":")
  guard colon.location != NSNotFound, colon.location > 0 else { return nil }
  // Twenty-four characters, as everywhere else; counted as characters, not
  // UTF-16 units, so an emoji in a name does not cost it two.
  guard text.substring(to: colon.location).count <= 24 else { return nil }
  return NSRange(location: 0, length: colon.location)
}

/// A quiet "Ad", then the offer: the advertiser's name and the promo code in
/// colour, the rest in the guide's two text levels. `fresh` is the first two
/// seconds of a creative on screen, the one bit of motion the guide allows.
///
/// The owner asked on 07.10 for the TICK mark to go and the advertiser's name
/// to be coloured; the guide allows only the promo code. The "Ad" stays: an
/// unlabelled line inside Claude's message box reads as Claude's own text, and
/// advertising has to be recognisable as advertising.
func styled(_ c: Creative, _ pal: Palette, fresh: Bool) -> NSAttributedString {
  let s = NSMutableAttributedString()
  s.append(NSAttributedString(string: "Ad   ", attributes: [
    .font: NSFont.systemFont(ofSize: 10, weight: .semibold), .foregroundColor: pal.quiet, .kern: 0.4,
  ]))
  let text = c.text as NSString
  let body = NSMutableAttributedString(string: c.text, attributes: [
    .font: NSFont.systemFont(ofSize: 12), .foregroundColor: fresh ? pal.bright : pal.settled,
  ])
  let accent = pal.accent(c.accent)
  let name = advertiserRange(text)
  if let name {
    body.addAttributes([.font: NSFont.systemFont(ofSize: 12, weight: .semibold), .foregroundColor: accent], range: name)
  }
  // The first occurrence after the name, as the terminal and the previews do.
  // The server keeps a code to one occurrence, so this is the code itself.
  if let promo = c.promo, !promo.isEmpty {
    let from = name.map { $0.location + $0.length } ?? 0
    let range = text.range(of: promo, options: [], range: NSRange(location: from, length: text.length - from))
    if range.location != NSNotFound {
      body.addAttributes([.font: NSFont.systemFont(ofSize: 12, weight: .bold), .foregroundColor: accent], range: range)
    }
  }
  s.append(body)
  return s
}

/// The clickable, draggable surface. A press that does not travel is a click
/// and opens the advertiser; one that moves more than a few points is a drag,
/// sideways only. First click counts even though Claude, not us, is the active
/// app; the panel never becomes key, so Claude keeps its focus.
final class StripView: NSView {
  var onClick: (() -> Void)?
  var onDrag: ((CGFloat) -> Void)?   // horizontal distance from where the press began
  var onDrop: (() -> Void)?
  private var pressX: CGFloat = 0
  private var dragging = false

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  /// Every press on the strip is the strip's, not the label's. A text field
  /// tracks the mouse itself and swallows the release, so a click on the words
  /// — which is where people click — never arrived as one.
  override func hitTest(_ point: NSPoint) -> NSView? { frame.contains(point) ? self : nil }
  override func mouseDown(with event: NSEvent) {
    pressX = NSEvent.mouseLocation.x
    dragging = false
  }
  override func mouseDragged(with event: NSEvent) {
    let moved = NSEvent.mouseLocation.x - pressX
    if !dragging && abs(moved) < 4 { return }
    if !dragging { dragging = true; NSCursor.closedHand.push() }
    onDrag?(moved)
  }
  override func mouseUp(with event: NSEvent) {
    if dragging { NSCursor.pop(); dragging = false; onDrop?() } else { onClick?() }
  }
  override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
}

final class Strip {
  let panel: NSPanel
  let view = StripView()
  let label = NSTextField(labelWithString: "")
  let height: CGFloat = 22
  let pad: CGFloat = 11
  var creative: Creative?
  /// Where the strip actually landed, relative to the window's centre, after
  /// clamping. What a drop saves, so a strip pushed against an edge does not
  /// remember a position past it.
  var effectiveDX: CGFloat = 0
  var dark = true
  var fresh = false
  var settleWork: DispatchWorkItem?

  init() {
    panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
    panel.isFloatingPanel = true
    panel.level = .floating
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = false
    panel.becomesKeyOnlyIfNeeded = true
    panel.hidesOnDeactivate = false
    panel.animationBehavior = .none
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]

    view.wantsLayer = true
    view.layer?.cornerRadius = 7
    view.layer?.borderWidth = 1
    view.onClick = { [weak self] in
      // The server counts the click at the other end of this redirect, exactly
      // as for the terminal's link. The satellite never reports one itself.
      if let url = self?.creative?.clickUrl { NSWorkspace.shared.open(url) }
    }
    panel.contentView = view
    label.lineBreakMode = .byTruncatingTail
    label.wantsLayer = true
    view.addSubview(label)
  }

  var onScreen: Bool { panel.isVisible && panel.alphaValue > 0.99 }

  /// Countable only if every point of it is inside Claude's window and on a
  /// display. A window dragged mostly off screen takes the strip with it, and
  /// a strip nobody can see is not an impression.
  func fullyVisible(in win: NSRect) -> Bool {
    let f = panel.frame
    guard onScreen, win.insetBy(dx: -0.5, dy: -0.5).contains(f) else { return false }
    return NSScreen.screens.contains { $0.frame.contains(f) }
  }
  var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

  func hide() {
    settleWork?.cancel()
    guard panel.isVisible else { return }
    panel.alphaValue = 0
    panel.orderOut(nil)
  }

  private func paint() {
    guard let c = creative else { return }
    let pal = dark ? Palette.dark : Palette.light
    view.layer?.backgroundColor = pal.surface.cgColor
    view.layer?.borderColor = pal.border.cgColor
    label.attributedStringValue = styled(c, pal, fresh: fresh)
  }

  /// Bright for two seconds, then one step down over 600 ms, once. The same
  /// two states as the terminal and the landing; never a loop.
  private func arrive() {
    settleWork?.cancel()
    fresh = !reduceMotion
    paint()
    guard fresh else { return }
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      let fade = CATransition()
      fade.type = .fade
      fade.duration = 0.6
      self.label.layer?.add(fade, forKey: "settle")
      self.fresh = false
      self.paint()
    }
    settleWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
  }

  func show(_ c: Creative, over win: NSRect, at p: Settings) {
    let isDark = darkTheme(activeHost)
    let appearing = !panel.isVisible
    if c != creative || appearing {
      creative = c
      dark = isDark
      view.toolTip = (c.clickUrl.map { "Sponsored, via TICK. Click opens \($0.host ?? "the advertiser")." } ?? "Sponsored, via TICK.")
        + " Drag sideways to move it along this row."
      arrive()
    } else if isDark != dark {
      dark = isDark
      paint()
    }

    // Symmetric by construction: equal padding both sides, the text centred on
    // the strip's own midline, the strip on the row it sits in. A text field
    // insets its text by a couple of points each side; without that slack the
    // last word is cut, and the last word is usually the promo code.
    let slack: CGFloat = 6
    let textSize = label.attributedStringValue.size()
    let natural = (pad + ceil(textSize.width) + slack + pad).rounded()
    let width = min(natural, win.width - 40).rounded()
    // Sideways within the window and no further, with a little air at each end.
    let margin: CGFloat = 8
    let wanted = win.midX - width / 2 + p.dx
    let x = min(max(wanted, win.minX + margin), win.maxX - margin - width)
    let frame = NSRect(x: x.rounded(), y: (win.minY + p.dy - height / 2).rounded(), width: width, height: height)
    effectiveDX = frame.midX - win.midX
    if panel.frame != frame { panel.setFrame(frame, display: true) }
    let textH = ceil(textSize.height)
    label.frame = NSRect(x: pad, y: ((height - textH) / 2).rounded(), width: width - pad * 2, height: textH)
    view.window?.invalidateCursorRects(for: view)

    if appearing {
      panel.alphaValue = reduceMotion ? 1 : 0
      panel.orderFrontRegardless()
      if !reduceMotion {
        NSAnimationContext.runAnimationGroup { ctx in
          ctx.duration = 0.18
          panel.animator().alphaValue = 1
        }
      }
    }
  }
}

// ------------------------------------------------------------------ the mod

/// Whether the TICK plugin draws the line inside the Claude app, so the strip
/// should not. Mainly: the plugin is enabled in Claude Code's own settings,
/// which holds from the first instant of a turn. Until 08.10 only the mod's
/// "I am here" signal was asked, which was stale between turns: the strip
/// showed itself for seconds at the start of a turn, beside the band. The
/// signal still counts, for a plugin loaded some other way.
let CLAUDE_SETTINGS = ((ENV["CLAUDE_CONFIG_DIR"] ?? (NSHomeDirectory() as NSString).appendingPathComponent(".claude")) as NSString)
  .appendingPathComponent("settings.json")
var pluginCheckedAt: Double = 0
var pluginEnabled = false

func modDrawsInClaude() -> Bool {
  let now = nowMs()
  if now - pluginCheckedAt > 2000 {
    pluginCheckedAt = now
    let enabled = readJSON(CLAUDE_SETTINGS)?["enabledPlugins"] as? [String: Any] ?? [:]
    pluginEnabled = enabled.contains { $0.key.hasPrefix("tick@") && ($0.value as? Bool) == true }
  }
  if pluginEnabled { return true }
  if let ts = readJSON(inHome("state/mod-desktop.json"))?["ts"] as? Double, now - ts < 10_000 { return true }
  return false
}

// -------------------------------------------------------------------- the log

/// Why the strip is or is not on screen, one line per change, in
/// state/satellite.log. "It does not show" has five honest answers — no
/// desktop session is working, Claude is not in front, nothing is sold, the
/// window was not found, or it is showing — and from the outside they all look
/// the same. The Windows satellite has kept this log since 07.10.
let LOG = inHome("state/satellite.log")
var lastNote = ""

func note(_ what: String) {
  guard what != lastNote else { return }
  lastNote = what
  let fm = FileManager.default
  if let size = (try? fm.attributesOfItem(atPath: LOG))?[.size] as? Int, size > 256 * 1024 {
    fm.createFile(atPath: LOG, contents: Data())
  }
  if !fm.fileExists(atPath: LOG) { fm.createFile(atPath: LOG, contents: Data()) }
  guard let h = FileHandle(forWritingAtPath: LOG) else { return }
  defer { try? h.close() }
  h.seekToEndOfFile()
  let stamp = ISO8601DateFormatter().string(from: Date())
  h.write(Data("\(stamp) \(what)\n".utf8))
}

// ------------------------------------------------------------------- the loop

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // no Dock icon, no menu, never frontmost

let strip = Strip()
var lastTick: Double = 0
/// While a drag is in progress, the offset under the person's hand.
var dragBase: CGFloat? = nil
var dragDX: CGFloat? = nil

strip.view.onDrag = { moved in
  if dragBase == nil { dragBase = settings(activeHost).dx }
  dragDX = dragBase! + moved
}
strip.view.onDrop = {
  if dragDX != nil { savePlacement(activeHost, dx: strip.effectiveDX) }
  dragBase = nil
  dragDX = nil
}
var lastFrame: NSRect? = nil
var settledAt: Double = 0
/// How long Claude's window has to stand still before the strip comes back.
/// A separate window cannot move in step with another app's window, so it
/// does not try: it steps out of the way while the window moves and returns
/// once it stops, instead of trailing behind it in jumps.
let SETTLE_MS: Double = 220

/// The host in front, if one of ours is.
func frontHost() -> Host? {
  let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
  return HOSTS.first { $0.bundle == front }
}
/// The host the strip is on, or was last on. Read by the drag handlers and the
/// theme, which have no other way to know.
var activeHost = CLAUDE

func offscreen() {
  strip.hide()
  lastFrame = nil
  // Off screen counts nothing, and the next stretch starts from zero rather
  // than inheriting the gap as elapsed time.
  counters.removeAll()
}

// Switching apps is told to us by the system the moment it happens, so the
// strip leaves with Claude instead of on the next poll.
NSWorkspace.shared.notificationCenter.addObserver(
  forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
) { _ in if frontHost()?.tag != activeHost.tag { offscreen() } }

let timer = Timer(timeInterval: 0.06, repeats: true) { _ in
  // Only over an app of ours that is in front: an ad floating over some other
  // app would be showing to nobody we can count, and in the way of everything.
  guard let host = frontHost() else {
    let busy = HOSTS.contains { !desktopSessions($0).isEmpty }
    note(busy ? "hidden: none of Claude, Codex, Cursor, Devin is the app in front" : "waiting: no session in Claude, Codex, Cursor or Devin is working")
    offscreen(); return
  }
  let cfg = settings(host)
  guard cfg.enabled else { note("off: \"desktop\": {\"enabled\": false} in config.json"); offscreen(); return }
  let sessions = desktopSessions(host)
  guard !sessions.isEmpty else { note("waiting: no session in the \(host.name) app is working"); offscreen(); return }
  // The TICK mod draws the line inside the Claude app itself, above the
  // prompt, and says so every few seconds while it does. Then the strip steps
  // aside: one display, one impression.
  if host.tag == CLAUDE.tag, modDrawsInClaude() {
    note("standing aside: the TICK mod draws the line in the Claude app"); offscreen(); return
  }
  ensureDaemon()
  if host.tag != activeHost.tag { offscreen(); activeHost = host }

  guard let creative = currentCreative() else { note("hidden: no live creative (nothing sold right now, or the daemon is not running)"); offscreen(); return }
  guard let win = hostWindow(host) else { note("hidden: the \(host.name) window was not found on screen"); offscreen(); return }

  let now = nowMs()
  if win != lastFrame {
    lastFrame = win
    settledAt = now
    strip.hide()
    return
  }
  if now - settledAt < SETTLE_MS { return }
  var placed = cfg
  if let dx = dragDX { placed.dx = dx }
  strip.show(creative, over: win, at: placed)

  if now - lastTick < TICK_MS { return }
  lastTick = now
  guard strip.onScreen else { return }  // still fading in: neither shown nor hidden yet
  guard strip.fullyVisible(in: win), dragDX == nil, let cid = creative.id else {
    note("shown over \(host.name), not counted: the strip is not fully inside the window, or is being dragged")
    return
  }
  note("shown over \(host.name) and counted: \(creative.id ?? "?")")
  // One strip on one screen is one display, however many desktop sessions are
  // busy behind it. Count it once: a working session before one that just
  // finished, then the one that moved last. The editor solves the same problem
  // with claims; here there is only ever one strip.
  guard let s = sessions.max(by: { ($0.working ? 1 : 0, $0.ts) < ($1.working ? 1 : 0, $1.ts) }) else { return }
  counters = counters.filter { $0.key == s.id }
  tick(s, cid: cid, now: now)
}
RunLoop.main.add(timer, forMode: .common)
app.run()
