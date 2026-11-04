// The board engine's Linux layer: the pieces that differ per OS. On macOS the
// engine runs its own code (Keychain, sysctl); on Linux it calls in here
// instead, at the spots in engine.mjs marked "Linux". See LINUX.md at the top
// of the repository.
//
// No dependencies, like engine.mjs: the board copies both files into
// <board home>/engine/ on each machine.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const LINUX = os.platform() === "linux";

// Unix socket paths: macOS caps them near 104 bytes (the engine keeps under 100),
// Linux at 108 including the terminating NUL.
export const SOCK_MAX = LINUX ? 107 : 100;

// ---- secrets: libsecret's secret-tool ----
//
// One item per secret, in the session's Secret Service (gnome-keyring,
// or KeePassXC or KWallet with their Secret Service on):
// attributes service=<service> account=<team id>/<member id>/<NAME>, label
// "herdr-board <account>". The value goes over standard input, never argv.
export function secretToolArgs(op, service, account) {
  const attrs = ["service", String(service), "account", String(account)];
  if (op === "store") return ["store", `--label=herdr-board ${account}`, ...attrs];
  if (op === "lookup" || op === "clear") return [op, ...attrs];
  throw new Error(`secret-tool: unknown op ${op}`);
}

function secretTool(argv, input = null) {
  return new Promise((resolve) => {
    let out = ""; let err = "";
    let p;
    try { p = spawn("secret-tool", argv, { stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { resolve({ code: 1, out, err: String(e?.message ?? e) }); return; }
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.stdin.on("error", () => {});
    p.on("error", (e) => resolve({ code: 1, out, err: String(e?.message ?? e) }));
    p.on("close", (code) => resolve({ code: code ?? 1, out, err }));
    p.stdin.end(input ?? "");
  });
}

// What a failed secret-tool call means, for the person.
export function secretError(err) {
  const e = String(err ?? "").trim();
  if (/ENOENT/.test(e)) return "secret-tool is not installed on this machine: install libsecret's tools (the libsecret or libsecret-tools package).";
  if (/org\.freedesktop\.secrets|was not provided by any|Cannot autolaunch|no secret service/i.test(e))
    return "No Secret Service runs in this session: start gnome-keyring (or KeePassXC with its Secret Service on), then set the secret again.";
  if (/locked|dismissed|cancel/i.test(e))
    return "The keyring is locked. Unlock it (sign in to the desktop), then set the secret again. Stored secrets read again once it is unlocked.";
  return `The keyring refused it: ${e.split("\n").pop() || "secret-tool failed"}`;
}

// The value, or null when there is none (or the keyring cannot be read).
// secret-tool adds a newline only on a terminal; a secret is one line, so a
// trailing one is never part of it.
export async function secretGet(service, account) {
  const r = await secretTool(secretToolArgs("lookup", service, account));
  return r.code === 0 ? r.out.replace(/\r?\n$/, "") : null;
}
export async function secretHas(service, account) {
  return (await secretTool(secretToolArgs("lookup", service, account))).code === 0;
}
export async function secretSet(service, account, value) {
  const r = await secretTool(secretToolArgs("store", service, account), String(value));
  if (r.code !== 0) throw new Error(secretError(r.err));
}
export async function secretDelete(service, account) {
  await secretTool(secretToolArgs("clear", service, account));
}

// ---- the load gate's numbers: /proc instead of darwin's sysctl keys ----
//
// The same shape as engine.mjs's parseLoad(): { pressure, ncpu, swapTotal,
// swapUsed, load1 }, swap in MB. `pressure` uses the darwin levels that the
// gate's settings name (1 normal, 2 warning, 4 critical). Linux has no such
// level, so it comes from PSI (/proc/pressure/memory: the share of the last
// 10 s that tasks stalled on memory) and from MemAvailable. Tune here.
export const PSI_WARN = { some: 10, full: 2 }; // % of the last 10 s
export const PSI_CRIT = { some: 40, full: 10 };
export const AVAIL_WARN = 0.05; // MemAvailable / MemTotal
export const AVAIL_CRIT = 0.02;

const mb = (kb) => Math.round((kb / 1024) * 100) / 100;
export function parseLinuxLoad(loadavg, psi, meminfo, ncpu) {
  const tok = String(loadavg ?? "").trim().split(/\s+/)[0];
  const first = tok ? Number(tok) : NaN;
  const kb = (key) => { const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(String(meminfo ?? "")); return m ? Number(m[1]) : null; };
  const avg10 = (kind) => { const m = new RegExp(`^${kind}\\s.*?\\bavg10=([\\d.]+)`, "m").exec(String(psi ?? "")); return m ? Number(m[1]) : null; };
  const some = avg10("some");
  const full = avg10("full");
  const total = kb("MemTotal");
  const avail = kb("MemAvailable");
  const share = total > 0 && avail != null ? avail / total : null;
  let pressure = some == null && full == null && share == null ? null : 1;
  if (pressure != null) {
    if ((some ?? 0) >= PSI_WARN.some || (full ?? 0) >= PSI_WARN.full || (share != null && share < AVAIL_WARN)) pressure = 2;
    if ((some ?? 0) >= PSI_CRIT.some || (full ?? 0) >= PSI_CRIT.full || (share != null && share < AVAIL_CRIT)) pressure = 4;
  }
  const swapTotal = kb("SwapTotal");
  const swapFree = kb("SwapFree");
  return {
    pressure,
    ncpu: Number(ncpu) > 0 ? Number(ncpu) : null,
    swapTotal: swapTotal == null ? null : mb(swapTotal),
    swapUsed: swapTotal == null || swapFree == null ? null : mb(swapTotal - swapFree),
    load1: Number.isFinite(first) ? first : null,
  };
}

const readProc = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
// This machine's numbers now, or null when /proc cannot be read.
export function linuxLoad() {
  const loadavg = readProc("/proc/loadavg");
  if (loadavg == null) return null;
  const ncpu = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return parseLinuxLoad(loadavg, readProc("/proc/pressure/memory"), readProc("/proc/meminfo"), ncpu);
}

// ---- Chrome's main process on Linux ----
//
// By the program path before the first " --": /opt/google/chrome/chrome,
// /usr/lib/chromium/chromium, Playwright's and Chrome for Testing's
// chrome-linux64/chrome, chrome-headless-shell. Helpers and renderers carry
// --type=, which the engine's caller already skips.
const LINUX_CHROME = /(?:^|\/)(?:chrome|chromium|chromium-browser|google-chrome(?:-stable|-beta|-unstable)?|chrome-headless-shell)$/;
export const isLinuxChromeMain = (command) => LINUX_CHROME.test(String(command ?? "").split(" --")[0].trim());

// ---- the board's default brief notes ----
//
// Upstream writes them for macOS with zsh. On Linux the shell line names the
// person's own login shell, and the desktop-app line names Linux's opener.
// Lines it does not know stay as they are.
export function envNote(line, shell, linux = LINUX) {
  if (!linux) return line;
  const name = path.basename(String(shell || "sh"));
  if (/^- The shell is zsh\b/.test(line)) return name === "zsh" ? line : `- The shell is ${name}.`;
  return line.replace("(Safari, Preview, `open <url>`)", "(the desktop browser, an image viewer, `xdg-open <url>`)");
}
