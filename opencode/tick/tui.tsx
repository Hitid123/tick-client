/** @jsxImportSource @opentui/solid */
// TICK TUI plugin for OpenCode v2: the sponsored line in the session footer.
//
// One more renderer of the client that is already there, not a second client.
// The daemon still does all the network and all the money; this file reads
// the line it picked (state/current.json), draws it while the turn runs, and
// appends the same three-second ticks every other surface appends:
//
//   - drawn while a turn runs (paid line) or always (own line / balance);
//   - a tick every three seconds while drawn; api_ms grows only while the
//     turn runs, so the daemon's aggregate() counts it as it counts the rest;
//   - exactly one TUI instance counts a session: claims/<id>.json, the same
//     lock the editor extension uses, so a VS Code window beside the TUI
//     shows the line and counts nothing.
//
// What it reads: our own files in ~/.tick, the session id the slot is for,
// and our own activity marks. Never a prompt, a message or a tool call.

import { Plugin } from "@opencode/plugin/tui";
import { createSignal, onCleanup, Show } from "solid-js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import cp from "node:child_process";
import {
  renderView,
  activityOf,
  withinWindow,
  safeSessionId,
  ocSid,
  advance,
} from "./shared.js";

const TICK_MS = 3000;
const POLL_MS = 1000;
const CLAIM_STALE_MS = 15000;
const TICKS_MAX_BYTES = 2 * 1024 * 1024;

const proc = globalThis.process ?? {};
const owner = `${proc.pid ?? 0}-${Math.random().toString(36).slice(2, 10)}`;
const counters = new Map();

function tickHome() {
  try {
    if (proc.env?.TICK_HOME) return proc.env.TICK_HOME;
    return path.join(os.homedir(), ".tick");
  } catch {
    return ".tick";
  }
}

function P() {
  const home = tickHome();
  const state = path.join(home, "state");
  return {
    home,
    state,
    current: path.join(state, "current.json"),
    config: path.join(home, "config.json"),
    balance: path.join(state, "balance.json"),
    activity: path.join(state, "activity"),
    claims: path.join(state, "claims"),
    ticks: path.join(state, "ticks.ndjson"),
    daemon: path.join(home, "daemon.mjs"),
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function installed() {
  try {
    return fs.existsSync(P().state);
  } catch {
    return false;
  }
}

function appendTick(line) {
  try {
    const p = P();
    if (!fs.existsSync(p.state)) return;
    try {
      if (fs.statSync(p.ticks).size > TICKS_MAX_BYTES) fs.writeFileSync(p.ticks, "");
    } catch {
      /* no ticks yet */
    }
    fs.appendFileSync(p.ticks, line + "\n");
  } catch {
    /* a lost tick costs a fraction of a cent */
  }
}

/** Claim a session so exactly one TUI/editor instance counts it. */
function claim(sessionId, now) {
  try {
    const p = P();
    if (!fs.existsSync(p.claims)) fs.mkdirSync(p.claims, { recursive: true });
    const file = path.join(p.claims, `${sessionId}.json`);
    try {
      fs.writeFileSync(file, JSON.stringify({ owner, hb: now }), { flag: "wx" });
      return true;
    } catch {
      /* already claimed */
    }
    let prev = null;
    try {
      prev = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return true;
    }
    if (!prev || typeof prev !== "object") return true;
    if (prev.owner === owner) return true;
    const hb = typeof prev.hb === "number" ? prev.hb : 0;
    if (now - hb <= CLAIM_STALE_MS) return false;
    try {
      fs.writeFileSync(file, JSON.stringify({ owner, hb: now }));
    } catch {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function openUrl(url) {
  try {
    if (!url) return;
    const plat = os.platform();
    const argv =
      plat === "darwin"
        ? ["open", url]
        : plat === "win32"
          ? ["rundll32", "url.dll,FileProtocolHandler", url]
          : ["xdg-open", url];
    const child = cp.spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore", windowsHide: true });
    child.unref?.();
  } catch {
    /* a click that does not open is still a display */
  }
}

function readMark(sessionId) {
  try {
    const sid = safeSessionId(sessionId);
    if (!sid) return null;
    return JSON.parse(fs.readFileSync(path.join(P().activity, `${sid}.json`), "utf8"));
  } catch {
    return null;
  }
}

function TickFooter(props) {
  const context = props.context;
  const sid = () => safeSessionId(props.sessionID);

  const [view, setView] = createSignal({ text: "", cid: null, url: "", promo: "", paid: false });

  const refresh = () => {
    try {
      if (!installed()) {
        setView({ text: "", cid: null, url: "", promo: "", paid: false });
        return;
      }
      const now = Date.now();
      const p = P();
      setView(
        renderView({
          current: readJson(p.current, null),
          config: readJson(p.config, {}),
          balance: readJson(p.balance, null),
          now,
        }),
      );
    } catch {
      /* the footer is a nicety, never a failure */
    }
  };

  const count = () => {
    try {
      const id = sid();
      if (!id || !installed()) return;
      const v = view();
      const now = Date.now();
      if (!v.paid || !v.cid || v.text.length === 0) {
        counters.delete(id);
        return;
      }
      const mark = readMark(id);
      const { working: w, lastWorkTs } = activityOf(mark, now);
      if (!withinWindow(lastWorkTs, now)) {
        counters.delete(id);
        return;
      }
      if (!claim(id, now)) {
        counters.delete(id);
        return;
      }
      const next = advance(counters.get(id), { working: w, now });
      counters.set(id, next);
      appendTick(
        JSON.stringify({
          ts: now,
          sid: ocSid(id),
          cid: v.cid,
          api_ms: next.api_ms,
          dur_ms: next.dur_ms,
          model: null,
        }),
      );
    } catch {
      /* dropped, never doubled */
    }
  };

  refresh();
  const poll = setInterval(refresh, POLL_MS);
  const ticker = setInterval(count, TICK_MS);
  const sidOf = (e) => e?.data?.sessionID ?? e?.properties?.sessionID;
  const stops = [
    context.data.on("session.execution.started", (e) => {
      if (sidOf(e) === sid() || !sidOf(e)) refresh();
    }),
    context.data.on("session.execution.succeeded", (e) => {
      if (sidOf(e) === sid() || !sidOf(e)) refresh();
    }),
    context.data.on("session.execution.failed", (e) => {
      if (sidOf(e) === sid() || !sidOf(e)) refresh();
    }),
    context.data.on("session.execution.interrupted", (e) => {
      if (sidOf(e) === sid() || !sidOf(e)) refresh();
    }),
  ];
  onCleanup(() => {
    clearInterval(poll);
    clearInterval(ticker);
    stops.forEach((s) => {
      try {
        s();
      } catch {}
    });
  });

  return (
    <Show when={view().text.length > 0}>
      <box flexDirection="row">
        <text fg={context.theme.text.muted}>{"▌ Ad  "}</text>
        <text fg={context.theme.text.base} onMouseUp={() => view().url && openUrl(view().url)}>
          {view().text}
        </text>
      </box>
    </Show>
  );
}

const plugin = Plugin.define({
  id: "tick.cli",
  setup(context) {
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "tick.status",
          title: "TICK: Show status",
          group: "TICK",
          palette: true,
          slash: { name: "tick" },
          run: async () => {
            try {
              if (!installed()) {
                context.ui.toast.show({ variant: "info", title: "TICK", message: "TICK is not installed here." });
                return;
              }
              const p = P();
              const now = Date.now();
              const v = renderView({
                current: readJson(p.current, null),
                config: readJson(p.config, {}),
                balance: readJson(p.balance, null),
                now,
              });
              const bal = readJson(p.balance, null);
              const avail = bal && typeof bal.available === "number" ? (bal.available / 1e6).toFixed(2) : "0.00";
              context.ui.toast.show({
                variant: "info",
                title: "TICK",
                message: v.text.length > 0 ? `line: ${v.text} · $${avail} to withdraw` : `nothing sold right now · $${avail} to withdraw`,
                duration: 8000,
              });
            } catch (e) {
              context.ui.toast.show({ variant: "error", title: "TICK", message: String(e?.message ?? e) });
            }
          },
        },
        {
          id: "tick.dashboard",
          title: "TICK: Open dashboard",
          group: "TICK",
          palette: true,
          slash: { name: "tick-dashboard" },
          run: async () => {
            try {
              if (!installed()) {
                context.ui.toast.show({ variant: "info", title: "TICK", message: "TICK is not installed here." });
                return;
              }
              const p = P();
              let nodeBin = "node";
              try {
                nodeBin = fs.readFileSync(path.join(p.home, "node-path.txt"), "utf8").trim() || "node";
              } catch {}
              const out = await new Promise((resolve) => {
                try {
                  const child = cp.spawn(nodeBin, [p.daemon, "--dashboard"], {
                    env: { ...proc.env, TICK_HOME: p.home },
                    windowsHide: true,
                  });
                  let stdout = "";
                  child.stdout?.on("data", (d) => (stdout += d));
                  child.on("error", () => resolve(null));
                  child.on("exit", () => resolve(stdout));
                  setTimeout(() => {
                    try {
                      child.kill();
                    } catch {}
                    resolve(stdout);
                  }, 20000);
                } catch {
                  resolve(null);
                }
              });
              let r = null;
              try {
                r = JSON.parse(String(out ?? "").trim().split("\n").pop() || "{}");
              } catch {
                r = null;
              }
              if (!r) {
                context.ui.toast.show({
                  variant: "error",
                  title: "TICK",
                  message: "Dashboard could not be opened: open https://gettick.dev/dashboard and sign in.",
                });
                return;
              }
              if (!r.opened) {
                await context.ui.dialog.alert({
                  title: "TICK dashboard",
                  message: `No browser could be opened here. Open within five minutes:\n${r.url}`,
                });
                return;
              }
              context.ui.toast.show({
                variant: "success",
                title: "TICK",
                message: r.registered
                  ? "Opened your dashboard, signed in as this computer."
                  : "Opened the dashboard. This computer registers on its first turn.",
              });
            } catch (e) {
              context.ui.toast.show({ variant: "error", title: "TICK", message: String(e?.message ?? e) });
            }
          },
        },
      ],
    }));

    const disposePrompt = context.ui.slot({
      append: "prompt.footer",
      render: (slotProps) => {
        const id = slotProps?.sessionID ?? slotProps?.session_id;
        if (!safeSessionId(id)) return null;
        return <TickFooter context={context} sessionID={id} />;
      },
    });

    const disposeHome = context.ui.slot({
      append: "home.footer.status",
      render: () => {
        try {
          if (!installed()) return null;
          const p = P();
          const v = renderView({
            current: null,
            config: readJson(p.config, {}),
            balance: readJson(p.balance, null),
            now: Date.now(),
          });
          if (v.text.length === 0) return null;
          return <text fg={context.theme.text.muted}>{"▌ " + v.text}</text>;
        } catch {
          return null;
        }
      },
    });

    return () => {
      disposePrompt();
      disposeHome();
    };
  },
});

export default plugin;
