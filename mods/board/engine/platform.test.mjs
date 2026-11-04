// node --test platform.test.mjs: the engine's Linux layer (no keyring, no /proc writes).
import test from "node:test";
import assert from "node:assert/strict";
import { parseLinuxLoad, isLinuxChromeMain, envNote, secretToolArgs, secretError, SOCK_MAX, LINUX, linuxLoad } from "./platform.mjs";

const PSI_CALM = "some avg10=0.00 avg60=0.00 avg300=0.00 total=122130704\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=120704018\n";
const MEMINFO = (availKb, swapFreeKb = 42692652) =>
  `MemTotal:       63398904 kB\nMemFree:         2054052 kB\nMemAvailable:   ${availKb} kB\nSwapTotal:      63397884 kB\nSwapFree:       ${swapFreeKb} kB\n`;

test("parseLinuxLoad reads /proc's numbers in parseLoad's shape (swap in MB)", () => {
  assert.deepEqual(parseLinuxLoad("1.91 1.49 1.43 1/4770 2913060\n", PSI_CALM, MEMINFO(28554624), 32), {
    pressure: 1, ncpu: 32, swapTotal: 61912, swapUsed: 20219.95, load1: 1.91,
  });
});

test("memory pressure from PSI and MemAvailable: 1 normal, 2 warning, 4 critical", () => {
  const psi = (some, full) => `some avg10=${some} avg60=0.00 avg300=0.00 total=1\nfull avg10=${full} avg60=0.00 avg300=0.00 total=1\n`;
  const p = (some, full, avail = 28554624) => parseLinuxLoad("1 1 1 1/1 1", psi(some, full), MEMINFO(avail), 8).pressure;
  assert.equal(p("9.99", "1.99"), 1);
  assert.equal(p("10.00", "0.00"), 2);
  assert.equal(p("0.00", "2.00"), 2);
  assert.equal(p("40.00", "0.00"), 4);
  assert.equal(p("0.00", "10.00"), 4);
  assert.equal(p("0.00", "0.00", 3000000), 2); // under 5% available
  assert.equal(p("0.00", "0.00", 1000000), 4); // under 2% available
});

test("parseLinuxLoad without PSI, swap or a load line", () => {
  const n = parseLinuxLoad("", null, "MemTotal: 100 kB\nMemAvailable: 50 kB\n", 0);
  assert.equal(n.load1, null);
  assert.equal(n.ncpu, null);
  assert.equal(n.swapTotal, null);
  assert.equal(n.swapUsed, null);
  assert.equal(n.pressure, 1); // MemAvailable alone still gives a level
  assert.equal(parseLinuxLoad("2 2 2", null, null, 4).pressure, null);
});

test("Linux numbers fit the gate's rules (load over 1.5 x cores, pressure level)", () => {
  const n = parseLinuxLoad("49.0 1 1", PSI_CALM, MEMINFO(28554624), 32);
  assert.ok(n.load1 > 1.5 * n.ncpu);
  assert.ok(n.pressure < 2);
});

test("linuxLoad reads this machine when it is Linux", { skip: !LINUX }, () => {
  const n = linuxLoad();
  assert.ok(n && n.ncpu > 0 && n.load1 >= 0);
  assert.ok([1, 2, 4, null].includes(n.pressure));
});

test("Linux Chrome main processes, not helpers' paths or other programs", () => {
  for (const c of [
    "/usr/lib/chromium/chromium --user-data-dir=/w/.chrome --remote-debugging-port=9333",
    "/opt/google/chrome/chrome --user-data-dir=/w/p",
    "/home/u/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome --disable-field-trial-config --user-data-dir=/tmp/x",
    "/home/u/.agent-browser/browsers/chrome-156/chrome-linux64/chrome --headless=new",
    "/home/u/.cache/ms-playwright/chromium_headless_shell-1208/chrome-linux/chrome-headless-shell --headless",
    "/usr/bin/google-chrome-stable --user-data-dir=/w/p",
    "chromium --user-data-dir=/w/p",
  ]) assert.ok(isLinuxChromeMain(c), c);
  for (const c of [
    "/bin/bash -lic x",
    "npm exec chrome-devtools-mcp@latest",
    "node /home/u/.npm/_npx/1/node_modules/.bin/chrome-devtools-mcp",
    "/usr/bin/agent-browser chrome",
    "/opt/google/chrome/chrome_crashpad_handler --monitor-self",
    "/usr/bin/brave --user-data-dir=/home/u/.config/BraveSoftware",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/x",
  ]) assert.ok(!isLinuxChromeMain(c), c);
});

test("brief notes: the person's shell and xdg-open on Linux; untouched elsewhere", () => {
  const shell = "- The shell is zsh: quote globs (`--include='*.tsx'`) and avoid a bare `=word`.";
  const open = "- Never open links, files or artifacts in a desktop app on this machine (Safari, Preview, `open <url>`). Use only your own Chrome through the browser tools.";
  const other = "- Use your own dev-server port.";
  assert.equal(envNote(shell, "/usr/bin/bash", true), "- The shell is bash.");
  assert.equal(envNote(shell, "/usr/bin/zsh", true), shell);
  assert.equal(envNote(open, "/usr/bin/bash", true), "- Never open links, files or artifacts in a desktop app on this machine (the desktop browser, an image viewer, `xdg-open <url>`). Use only your own Chrome through the browser tools.");
  assert.equal(envNote(other, "/usr/bin/bash", true), other);
  assert.equal(envNote(shell, "/usr/bin/bash", false), shell);
  assert.equal(envNote(open, "/usr/bin/bash", false), open);
});

test("secret-tool argv never carries the value", () => {
  assert.deepEqual(secretToolArgs("lookup", "herdr-board", "t1/m1/GITHUB_TOKEN"), ["lookup", "service", "herdr-board", "account", "t1/m1/GITHUB_TOKEN"]);
  assert.deepEqual(secretToolArgs("clear", "herdr-board", "t1/m1/X"), ["clear", "service", "herdr-board", "account", "t1/m1/X"]);
  assert.deepEqual(secretToolArgs("store", "herdr-board", "t1/m1/X"), ["store", "--label=herdr-board t1/m1/X", "service", "herdr-board", "account", "t1/m1/X"]);
  assert.throws(() => secretToolArgs("search", "herdr-board", "x"));
});

test("secret-tool failures say what to do", () => {
  assert.match(secretError("spawn secret-tool ENOENT"), /not installed/);
  assert.match(secretError("secret-tool: The name org.freedesktop.secrets was not provided by any .service files"), /No Secret Service/);
  assert.match(secretError("secret-tool: Cannot create an item in a locked collection"), /locked/);
  assert.match(secretError("secret-tool: something else"), /refused it: secret-tool: something else/);
});

test("socket path limit per system", () => {
  assert.equal(SOCK_MAX, LINUX ? 107 : 100);
});
