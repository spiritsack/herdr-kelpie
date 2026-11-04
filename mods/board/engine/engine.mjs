// The Herdr board engine: one per machine, run by launchd. It keeps that
// machine's boards, its team library and their tasks, starts team members
// through this machine's herdr-core, reads the results they write and hands
// tasks on. The Herdr app's board mod is only a screen: it reads state.json and
// sends every change as a request to inbox/.
//
//   node engine.mjs --home <board home> [--hc <path>] [--machine <name>] [--once]
//   node engine.mjs --home <board home> --dry-run <import.json>   what an import would do; writes nothing
//
// A board belongs to one checkout: a repository's top folder (a worktree is a
// checkout of its own), or a plain folder. Its id comes from that folder, so it
// stays when a space closes and opens again. Worktrees the board makes for a
// task never become boards. Each board uses one team from this machine's
// library; members are kept by value in their team.
//
// <board home> (~/.herdr/board, or ~/.config/herdr-app/board on the Mac that
// runs Herdr) holds:
//   tasks.json boards.json teams.json settings.json   only this engine writes them
//   state.json, seq                      everything, for the screen; seq changes with it
//   board.json                           a summary for agents (see README.md there)
//   inbox/  done/ failed/ .claimed/      requests and their answers
//   tasks/<id>/                          brief.md, result.<run>.json, notes, files/
//   engine/                              this program and its VERSION
//   engine.log                           what it did (rotated at 1 MB)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import crypto from "node:crypto";
import * as PF from "./platform.mjs"; // what differs on Linux (LINUX.md)

export const PROTOCOL = 2;

// ---- arguments ----

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const k = a.slice(2);
    const v = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : true;
    args[k] = v;
  }
}
const HOME = path.resolve(String(args.home ?? path.join(os.homedir(), ".herdr/board")));
const HC = String(args.hc ?? process.env.HERDR_HC ?? "hc");
const MACHINE = args.machine ? String(args.machine) : null; // for people only
const PASS_MS = Number(args.pass ?? 2000);
const DRY = Boolean(args["dry-run"]);
const VERSION = (() => { try { return fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "VERSION"), "utf8").trim(); } catch { return "dev"; } })();

const P = (...x) => path.join(HOME, ...x);
const TASKS_DIR = P("tasks");
const WT_ROOT = path.join(os.homedir(), ".herdr/worktrees");

// ---- log ----

function log(...msg) {
  const line = `${new Date().toISOString()} ${msg.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join(" ")}\n`;
  if (DRY) return;
  try {
    const f = P("engine.log");
    try { if (fs.statSync(f).size > 1_000_000) fs.renameSync(f, f + ".1"); } catch {}
    fs.appendFileSync(f, line);
  } catch {}
  if (process.stdout.isTTY) process.stdout.write(line);
}

// ---- one engine per home ----

// A lock folder with our pid. A lock whose pid is gone is taken over.
function lock() {
  const dir = P("engine.lock");
  for (let i = 0; i < 2; i++) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "pid"), String(process.pid));
      const free = () => { try { if (fs.readFileSync(path.join(dir, "pid"), "utf8") === String(process.pid)) fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
      process.on("exit", free);
      for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => process.exit(0));
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let pid = 0;
      try { pid = Number(fs.readFileSync(path.join(dir, "pid"), "utf8")); } catch {}
      let alive = false;
      if (pid) { try { process.kill(pid, 0); alive = true; } catch (err) { alive = err.code === "EPERM"; } }
      if (alive) return false;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return false;
}

// ---- files ----

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; } };
function writeAtomic(f, text) {
  if (DRY) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = path.join(path.dirname(f), `.${path.basename(f)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, f);
}

// ---- programs ----

function run(cmd, argv, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, argv, { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout ?? 60000, cwd: opts.cwd }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? err?.message ?? "") });
    });
  });
}

// The person's login shell: agents start inside it (as Herdr starts them), so
// they get the same PATH, and it stays after they exit.
const SHELL = (() => { try { return os.userInfo().shell || process.env.SHELL || "/bin/zsh"; } catch { return process.env.SHELL || "/bin/zsh"; } })();
// pre: shell code run before the agent (its secrets); after: once it exits.
const FISH = SHELL.split("/").pop() === "fish";
// A herdr-core started from inside a Claude session hands that session's
// environment to every terminal; an agent started under it thinks it is that
// session's child (no transcript, its messaging socket). Agents start clean.
export const LEAKED_ENV = ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_SESSION_ID", "CLAUDE_EFFORT", "CLAUDE_PID"];
// The agent and all it starts run at a lower priority (settings.niceness), so a
// busy machine still answers ssh, Tailscale and Herdr.
export const niced = (argv, n) => (Number(n) > 0 ? ["/usr/bin/nice", "-n", String(Math.min(19, Math.floor(Number(n)))), ...argv] : argv);
function wrapped(argv, pre = "", after = "") {
  if (FISH) return niced([SHELL, "-lic", `set -e ${LEAKED_ENV.join(" ")} 2>/dev/null; ${pre}$argv; ${after}exec fish -li`, ...argv], settings.niceness);
  return niced([SHELL, "-lic", `unset ${LEAKED_ENV.join(" ")}; ${pre}"$@"; ${after}exec "$0" -li`, SHELL, ...argv], settings.niceness);
}
const found = {};
async function installed(cmd) {
  if (found[cmd] && Date.now() - found[cmd].at < 60000) return found[cmd].ok;
  const r = await run(SHELL, ["-lic", 'command -v "$1"', SHELL, cmd], { timeout: 20000 });
  const ok = r.code === 0 && r.stdout.trim() !== "";
  found[cmd] = { ok, at: Date.now() };
  return ok;
}
const runOf = (program) => settings.programs?.[program]?.run ?? [program];

// ---- secrets ----
//
// A member's secrets: names on the member (secrets: ["GITHUB_TOKEN"]), values
// in the macOS Keychain of this machine (service herdr-board, account
// <team id>/<member id>/<NAME>). Values never go into the board's files, its
// state or a command line. The Keychain opens only in the person's login
// session, where this engine runs (launchd); herdr-core, which starts the
// agents, may run outside it (started over ssh). So the engine hands values
// over itself, on a socket only this user can open:
//   - a start gives the agent's shell a one-time token (two minutes); the shell
//     trades it for the values (`engine.mjs --secret get <token>`), which come
//     back through a pipe and are exported before the agent starts;
//   - the screen sets, checks and deletes values through the same socket, the
//     value on standard input (`hc exec -i ... --secret set <account>`).
export const SECRET_SERVICE = "herdr-board";
export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const ACCOUNT = /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}\/[A-Z_][A-Z0-9_]{0,63}$/;
export const secretAccount = (teamId, memberId, name) => `${teamId}/${memberId}/${name}`;
// macOS caps socket paths near 104 bytes: a long home gets a short one in ~/.herdr/run.
const SOCK = () => {
  const own = P("secrets.sock");
  if (Buffer.byteLength(own) < PF.SOCK_MAX) return own; // Linux: 108 bytes
  const dir = path.join(os.homedir(), ".herdr", "run");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${crypto.createHash("sha1").update(HOME).digest("hex").slice(0, 12)}.sock`);
};
const ENGINE_FILE = fileURLToPath(import.meta.url);

function security(argv, input = null) {
  return new Promise((resolve) => {
    let out = ""; let err = "";
    const p = spawn("security", argv, { stdio: ["pipe", "pipe", "pipe"] });
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", (e) => resolve({ code: 1, out, err: String(e?.message ?? e) }));
    p.on("close", (code) => resolve({ code: code ?? 1, out, err }));
    p.stdin.end(input ?? "");
  });
}
// `security find-generic-password -g` prints the value on stderr: quoted, or
// as hex (0x...) when it is not plain ASCII.
export function decodePassword(stderr) {
  const line = String(stderr).split("\n").find((l) => l.startsWith("password:"));
  if (line === undefined) return null;
  const rest = line.slice("password:".length).trim();
  if (rest === "") return "";
  if (rest.startsWith("0x")) return Buffer.from(rest.slice(2).split(/\s/)[0], "hex").toString("utf8");
  if (rest.startsWith('"') && rest.endsWith('"')) return rest.slice(1, -1);
  return null;
}
// One `security -i` command: the value on standard input, never in argv.
export const securityLine = (account, value) =>
  `add-generic-password -U -s ${SECRET_SERVICE} -a "${account}" -w "${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n`;
const checkAccount = (a) => { if (!ACCOUNT.test(String(a ?? ""))) throw new Error("Bad secret account."); return String(a); };
async function secretGet(account) {
  if (PF.LINUX) return PF.secretGet(SECRET_SERVICE, checkAccount(account)); // Linux: secret-tool
  const r = await security(["find-generic-password", "-s", SECRET_SERVICE, "-a", checkAccount(account), "-g"]);
  return r.code === 0 ? decodePassword(r.err) : null;
}
async function secretHas(account) {
  if (PF.LINUX) return PF.secretHas(SECRET_SERVICE, checkAccount(account)); // Linux: secret-tool
  return (await security(["find-generic-password", "-s", SECRET_SERVICE, "-a", checkAccount(account)])).code === 0;
}
async function secretSet(account, value) {
  value = String(value ?? "");
  if (!value) throw new Error("The value is empty.");
  if (/[\r\n]/.test(value)) throw new Error("A secret must be one line.");
  if (PF.LINUX) return PF.secretSet(SECRET_SERVICE, checkAccount(account), value); // Linux: secret-tool
  const r = await security(["-i"], securityLine(checkAccount(account), value));
  if (/-60008|-25308|Unable to obtain authorization|User interaction is not allowed/i.test(r.err))
    throw new Error(`This Mac's screen is locked, and macOS stores new Keychain entries only while someone is signed in at it. Unlock it (at the machine or over Screen Sharing), then set the secret again. Stored secrets keep working while it is locked.`);
  if (r.code !== 0 || /returned -?\d+|error/i.test(r.err)) throw new Error(`The Keychain refused it: ${r.err.trim().split("\n").pop()}`);
}
async function secretDelete(account) {
  if (PF.LINUX) return PF.secretDelete(SECRET_SERVICE, checkAccount(account)); // Linux: secret-tool
  await security(["delete-generic-password", "-s", SECRET_SERVICE, "-a", checkAccount(account)]);
}
// Values of members that are gone, or names a member no longer has.
function dropSecrets(teamId, before, after) {
  for (const m of before ?? []) {
    const keep = new Set(after?.find((x) => x.id === m.id)?.secrets ?? []);
    for (const n of m.secrets ?? []) if (!keep.has(n)) secretDelete(secretAccount(teamId, m.id, n)).catch(() => {});
  }
}

const tokens = new Map(); // one-time: token -> { accounts: { NAME: account }, until }
function secretToken(teamId, m) {
  const names = (m.secrets ?? []).filter((n) => SECRET_NAME.test(n));
  if (!names.length || !teamId) return null;
  const now = Date.now();
  for (const [k, v] of tokens) if (v.until < now) tokens.delete(k);
  const token = crypto.randomBytes(24).toString("hex");
  tokens.set(token, { accounts: Object.fromEntries(names.map((n) => [n, secretAccount(teamId, m.id, n)])), until: now + 120000 });
  return { token, names };
}
const q1 = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// Shell code that exports the member's secrets before the agent starts, and
// what clears them from the shell that stays after it.
function secretShell(t, m) {
  const tk = secretToken(boardOf(t)?.team, m);
  if (!tk) return { pre: "", after: "" };
  const cmd = [process.execPath, ENGINE_FILE, "--home", HOME, "--secret", "get", tk.token].map(q1).join(" ");
  if (FISH) return { pre: `eval (${cmd} | string collect); `, after: `set -e ${tk.names.join(" ")}; ` };
  return { pre: `eval "$(${cmd})"; `, after: `unset ${tk.names.join(" ")}; ` };
}

const SECRET_OPS = {
  async get(req) {
    const tk = tokens.get(String(req.token ?? ""));
    tokens.delete(String(req.token ?? ""));
    if (!tk || tk.until < Date.now()) throw new Error("This start's secrets expired. Restart the run.");
    const env = {}; const missing = [];
    for (const [name, account] of Object.entries(tk.accounts)) {
      const v = await secretGet(account);
      if (v == null) missing.push(name); else env[name] = v;
    }
    return { env, missing };
  },
  async status(req) {
    const set = {};
    for (const a of (req.accounts ?? []).slice(0, 200)) set[a] = await secretHas(a).catch(() => false);
    return { set };
  },
  async set(req) { await secretSet(req.account, req.value); return { ok: true }; },
  async delete(req) { await secretDelete(req.account); return { ok: true }; },
};
function serveSecrets() {
  try { fs.unlinkSync(SOCK()); } catch {}
  const srv = net.createServer((c) => {
    let buf = "";
    c.on("error", () => {});
    c.on("data", (d) => {
      buf += d;
      if (buf.length > 1 << 20) return c.destroy();
      const i = buf.indexOf("\n");
      if (i < 0) return;
      let req;
      try { req = JSON.parse(buf.slice(0, i)); } catch { return c.end(JSON.stringify({ error: "Bad request." }) + "\n"); }
      const op = SECRET_OPS[req?.op];
      (op ? op(req) : Promise.reject(new Error("Unknown op.")))
        .then((res) => c.end(JSON.stringify(res) + "\n"))
        .catch((e) => c.end(JSON.stringify({ error: String(e?.message ?? e) }) + "\n"));
    });
  });
  const mask = process.umask(0o077); // the socket is born 0600
  srv.listen(SOCK(), () => { process.umask(mask); try { fs.chmodSync(SOCK(), 0o600); } catch {} });
  srv.on("error", (e) => { process.umask(mask); log("secrets socket:", e.message); });
}
// The client side, run as `node engine.mjs --home <home> --secret <op> [arg]`.
async function secretClient() {
  const op = String(args.secret);
  const rest = process.argv.slice(process.argv.indexOf("--secret") + 2);
  let req;
  if (op === "get") req = { op, token: rest[0] };
  else if (op === "set") req = { op, account: rest[0], value: await new Promise((r) => { let v = ""; process.stdin.on("data", (d) => { v += d; }); process.stdin.on("end", () => r(v)); }) };
  else if (op === "status") req = { op, accounts: rest };
  else if (op === "delete") req = { op, account: rest[0] };
  else { console.error("--secret get|set|status|delete"); process.exit(2); }
  const res = await new Promise((resolve) => {
    const c = net.createConnection(SOCK());
    let buf = "";
    c.on("data", (d) => { buf += d; });
    c.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve({ error: "No answer from the board engine." }); } });
    c.on("error", (e) => resolve({ error: `The board engine is not running: ${e.message}` }));
    c.write(JSON.stringify(req) + "\n");
  });
  if (res.error) { console.error(`herdr board: ${res.error}`); process.exit(1); }
  if (op === "get") {
    const fish = FISH;
    for (const [k, v] of Object.entries(res.env ?? {})) {
      if (!SECRET_NAME.test(k)) continue;
      process.stdout.write(fish ? `set -gx ${k} '${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}';\n` : `export ${k}=${q1(v)};\n`);
    }
    for (const k of res.missing ?? []) console.error(`herdr board: secret ${k} is not set on this machine.`);
  } else process.stdout.write(JSON.stringify(res) + "\n");
}

// ---- herdr-core: one connection, JSON-RPC over `hc connect` ----

class Core {
  constructor() { this.p = null; this.pend = new Map(); this.n = 0; this.buf = ""; }
  start() {
    this.p = spawn(HC, ["connect"], { stdio: ["pipe", "pipe", "pipe"] });
    this.p.stdout.on("data", (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        const f = this.pend.get(m.id);
        if (f) { this.pend.delete(m.id); f(m); }
      }
    });
    this.p.stderr.on("data", () => {});
    this.p.on("exit", () => { for (const f of this.pend.values()) f({ error: { message: "hc connect ended" } }); this.pend.clear(); this.p = null; });
    this.p.stdin.on("error", () => {});
    this.p.on("error", (e) => log("hc connect:", e.message));
    return this.call("hello", {});
  }
  async call(method, params = {}) {
    if (!this.p) { this.starting = this.start(); }
    if (this.starting && method !== "hello") { const s = this.starting; await s; if (this.starting === s) this.starting = null; }
    return new Promise((resolve, reject) => {
      const id = ++this.n;
      const timer = setTimeout(() => { this.pend.delete(id); reject(new Error(`${method}: no answer`)); try { this.p?.kill?.(); } catch {} }, 15000);
      this.pend.set(id, (m) => { clearTimeout(timer); m.error ? reject(new Error(m.error.message ?? "core error")) : resolve(m.result); });
      this.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
}
const core = new Core();

// The live world, read once per pass: this machine's terminals, its Herdr
// spaces, and the board each space shows.
let world = { terminals: [], spaces: [], spaceBoards: {}, ok: false };
// The board each space showed: { <space id>: <board id> }. A space keeps it
// while it is open, wherever its first terminal goes later (an agent in the
// space that moves into a task's worktree must not take the board away).
let pins = {};
async function look() {
  try {
    const list = await core.call("terminal.list", {});
    const terminals = (list.terminals ?? []).filter((k) => !k.address.includes("/"))
      .map((k) => ({ address: k.address, state: k.state, status: statusOf(k.status), msg: msgOf(k.status), kind: kindOf(k.status), statusAt: k.status_ms ?? null, cwd: k.foreground?.cwd ?? k.cwd ?? null, pid: k.foreground?.pid ?? null, labels: k.labels ?? {} }));
    let spaces = world.spaces;
    let fresh = false;
    try {
      const doc = await core.call("doc.get", { name: "herdr-app" });
      spaces = (doc?.value?.spaces ?? []).map((s) => ({ id: s.id, name: s.name || "", folder: s.folder ?? null, tabs: (s.tabs ?? []).map((t) => ({ id: t.id, terminals: termsOf(t.root) })) }));
      fresh = true;
    } catch {}
    world = { ...world, terminals, spaces, ok: true };
    world.spaceBoards = await mapSpaces();
    pinSpaces(fresh);
  } catch (e) {
    world = { ...world, ok: false };
    log("core:", e.message);
  }
}
// Older cores report a status word, newer ones { app, state }.
const statusOf = (s) => (s == null ? null : typeof s === "object" ? (s.state ?? null) : String(s));
const field = (s, f) => (s && typeof s === "object" && typeof s[f] === "string" ? s[f] : null);
const msgOf = (s) => field(s, "msg");
const kindOf = (s) => field(s, "kind");

// Claude Code at a usage limit. `state` is the core's status word, `msg`
// its message, `kind` its kind (permission, question, auth or null),
// `screen` the last lines of the terminal (bottom last).
// Returns null (not at a limit), or { until, auto }:
//   until: the reset time as Claude prints it ("10pm"), or null
//   auto:  true when Claude continues by itself, false when it stopped
const LIMIT_LINES = 15;
const LIMIT_SENTENCE = /usage limit reached|hit your\b.*\blimit|limit resets|limit will reset/i;
const CONTINUES = /continuing\s+automatic/i;
const CANCELLED = /automatic continue cancelled/i;
export function limitOf(state, msg, kind, screen) {
  if (state !== "blocked" && state !== "error") return null;
  if (typeof kind === "string" && kind) return null;
  let lines = String(screen ?? "").split("\n").filter((l) => l.trim()).slice(-LIMIT_LINES);
  // Claude prints a ⏺ line for every step: a limit line above later work is stale.
  const marks = lines.filter((l) => /^\s*[⏺●]/.test(l));
  if (marks.length) {
    const last = marks[marks.length - 1];
    if (!LIMIT_SENTENCE.test(last) && !CONTINUES.test(last) && !CANCELLED.test(last)) lines = [];
  }
  const text = [...(msg ? [msg] : []), ...lines];
  if (!text.some((l) => LIMIT_SENTENCE.test(l))) return null;
  let at = -1;
  text.forEach((l, i) => { if (CONTINUES.test(l)) at = i; });
  const auto = at >= 0 && !text.slice(at + 1).some((l) => CANCELLED.test(l));
  const first = (re) => { for (const l of text) { const m = l.match(re)?.[1]?.trim(); if (m) return m; } return null; };
  const until = first(/continuing\s+automatically\s+at\s+([^·(…\n]+)/i) ?? first(/\b(?:resets|reset at)\s+([^·(…\n]+)/i);
  return { until, auto };
}
function termsOf(node) {
  if (!node) return [];
  if (node.content?.terminal) return [node.content.terminal];
  return (node.children ?? []).flatMap(termsOf);
}

const term = (addr) => world.terminals.find((k) => k.address === addr) ?? null;
const isLive = (r) => Boolean(r?.terminal) && term(r.terminal)?.state === "live";
// In a Herdr pane: Herdr's labels (a tab run, or a background run kept as a tab).
const inPane = (r) => Boolean(term(r?.terminal)?.labels?.["herdr.tab"]);
function runStatus(r) {
  const k = term(r?.terminal);
  if (!k || k.state !== "live") return null;
  if (holding(r)) return "working";
  if ((k.status === "blocked" || k.status === "error") && r.limit?.auto) return "limited";
  return k.status === "error" ? "blocked" : (k.status ?? "idle");
}
// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  if (!s) return null;
  for (const t of s.tabs) for (const a of t.terminals) { const c = term(a)?.cwd; if (c) return c; }
  return s.folder ?? null;
}
const spaceById = (id) => world.spaces.find((s) => s.id === id) ?? null;
const clean = (p) => (typeof p === "string" ? p.trim().replace(/\/+$/, "") : "");

// ---- boards: one per checkout ----

// A folder's checkout: the repository top (a worktree's own top) and its branch,
// or the folder itself outside git. Asked of git once a minute per folder.
const checkouts = new Map();
async function checkoutOf(folder) {
  folder = clean(folder);
  const c = checkouts.get(folder);
  if (c && Date.now() - c.at < 60000) return c;
  const top = await git(folder, ["rev-parse", "--show-toplevel"]);
  const branch = top.ok ? (await git(folder, ["rev-parse", "--abbrev-ref", "HEAD"])).out : null;
  const out = { top: top.ok ? top.out : folder, git: top.ok, branch: branch || null, at: Date.now() };
  checkouts.set(folder, out);
  return out;
}
export const boardIdOf = (top) => `b${hash(clean(top))}`;
// A worktree this board made for a task: never a board of its own.
function taskOfWorktree(co) {
  const t = tasks.find((x) => x.worktree?.path && (co.top === x.worktree.path || co.top.startsWith(x.worktree.path + "/")));
  if (t) return t;
  return co.top.startsWith(WT_ROOT + "/") && (co.branch ?? "").startsWith("board/") ? { id: null } : null;
}
// Every open space: the board it shows ({ board, folder }), or the task whose worktree it is.
async function mapSpaces() {
  const out = {};
  for (const s of world.spaces) {
    const f = place(s);
    if (!f) continue;
    const co = await checkoutOf(f);
    const tw = taskOfWorktree(co);
    const pin = boardById(pins[s.id]);
    out[s.id] = pin ? { folder: pin.folder, board: pin.id }
      : tw ? { folder: co.top, taskWorktree: true, task: tw.id, board: tw.board ?? null } : { folder: co.top, board: boardIdOf(co.top) };
  }
  return out;
}
// A space that shows a board that exists keeps it. Pins of closed spaces go,
// only when the space list was read just now (not a stale one after a failed read).
function pinSpaces(fresh) {
  for (const [id, v] of Object.entries(world.spaceBoards)) if (!v.taskWorktree && !pins[id] && boardById(v.board)) pins[id] = v.board;
  if (!fresh) return;
  const open = new Set(world.spaces.map((s) => s.id));
  for (const id of Object.keys(pins)) if (!open.has(id)) delete pins[id];
}
const boardOfSpace = (sid) => (world.spaceBoards[sid]?.taskWorktree ? null : world.spaceBoards[sid]?.board ?? null);
// A board shows where an open space shows it.
const shown = (t) => Object.entries(world.spaceBoards).some(([, v]) => !v.taskWorktree && v.board === t.board);
const spaceOfBoard = (bid, prefer) => (prefer && boardOfSpace(prefer) === bid ? spaceById(prefer) : world.spaces.find((s) => boardOfSpace(s.id) === bid)) ?? null;

// ---- state ----

export const COLUMNS = [
  { id: "backlog", name: "Backlog" }, { id: "todo", name: "To do" }, { id: "doing", name: "In progress" },
  { id: "review", name: "Review" }, { id: "done", name: "Done" },
];
// niceness: every agent runs under `nice -n <n>` (0: off). heavySlots: browser
// suites at once on this machine (board-heavy). gate*: the load gate's limits.
// gateSwap is off (0) by default: macOS grows swap on demand and keeps it, so a
// high used share is normal; memory pressure is the kernel's own verdict.
const DEFAULT_SETTINGS = { autopilot: true, maxRuns: 20, openTabs: false, programs: {}, niceness: 10, heavySlots: 1, gatePressure: 2, gateSwap: 0, gateLoad: 1.5, cleanupDone: 30 };

// The run limit counts finished runs only: a run that ended with a hand-off or
// a result. A stopped, failed or restarted run is not a loop.
export const countedRuns = (t) => (t?.runs ?? []).filter((r) => r.result).length;
// A loop: the same two members handed the task back and forth LOOP times in a
// row (three full rounds). Two planned review rounds take four hand-offs.
export const LOOP = 6;
export function loopOf(t) {
  const offs = (t?.runs ?? []).filter((r) => r.result).map((r) => (r.result.action === "handoff" ? [r.member, r.result.to] : null));
  let n = 0; let pair = null;
  for (let i = offs.length - 1; i >= 0; i--) {
    const h = offs[i];
    if (!h || h[0] === h[1]) break;
    const key = [...h].sort().join("\n");
    if (pair && key !== pair) break;
    pair = key; n++;
  }
  return n >= LOOP ? pair.split("\n") : null;
}
// Per-board defaults. envNotes go into every brief of the board; setup runs in
// each new task worktree before its agent starts; standing holds the person's
// standing answers.
export const DEFAULT_ENV_NOTES = [
  "- Other agents work on this machine at the same time. Never run broad `pkill` or `killall`: stop only processes you started, by their PID.",
  "- Use your own dev-server port. For a browser, use `agent-browser` (the board gives each run its own) or your own browser tools, never a Chrome that another run uses.",
  "- The shell is zsh: quote globs (`--include='*.tsx'`) and avoid a bare `=word`.",
  "- Before you write your result, run `agent-browser close` if you used it, and close the pages that you opened through your browser tools. The board also closes your browsers after your result.",
  "- Never open links, files or artifacts in a desktop app on this machine (Safari, Preview, `open <url>`). Use only your own Chrome through the browser tools.",
  "- Run any browser, e2e or Playwright suite through `\"$BOARD_HEAVY\"` (the board's `board-heavy`) with `--workers=$BOARD_WORKERS` (the board's \"Browsers per test run\": how many browsers one run may open at once), for example `\"$BOARD_HEAVY\" npm run test:acceptance -- --workers=$BOARD_WORKERS`. It waits for this machine's browser slot, so suites never run side by side, and runs at low priority.",
].map((l) => PF.envNote(l, SHELL)).join("\n"); // Linux: the shell and opener of this machine
const DEFAULT_BOARD = { pickup: false, worktrees: true, setup: "", envNotes: DEFAULT_ENV_NOTES, standing: "", workers: 4 };

let tasks = [];
let boards = [];   // { id, folder, team, settings: { pickup, worktrees }, created }
let teams = [];    // { id, name, members: [{ id, name, role, program, model, args, brief, color, capacity, handoffs }] }
let settings = { ...DEFAULT_SETTINGS };
let events = [];   // toasts for the screen: { id, at, level, title, body, terminal, sound }
let applied = [];  // the last requests applied, by file name, for the screen's pending writes
let dirty = false;

// The team a brand-new engine starts with: no teams.json and no team.json.
// An engine from before team libraries kept one team (team.json): it becomes
// "Default". An engine that has teams.json never comes here.
const FINISH = "When your part is done, write the result file the brief names (its How to finish section), then stop. Before that, close every Chrome you opened. Work only in the folder this run starts in: the task's own worktree. Never switch branches in the board's main checkout. If you cannot go on, or you need a decision only the person can make, report blocked with your question and wait in this terminal.";
export const STARTER_TEAM = {
  id: "starter", name: "Starter",
  members: [
    { id: "planner", name: "Ana", role: "Planner", program: "claude", model: "", color: "ansi4", capacity: 1, handoffs: ["builder"], secrets: [], args: [],
      brief: `## Planner\n\nYou plan. Read the task and explore the repository. Write a short plan to \`PLAN.md\` in the task workspace: the files to change, the approach, the risks and how to check the result. Do not change project files. Then hand off to the Builder. If the task is unclear or risky, report blocked and ask the person.\n\n${FINISH}` },
    { id: "builder", name: "Bo", role: "Builder", program: "claude", model: "", color: "ansi2", capacity: 1, handoffs: ["reviewer"], secrets: [], args: [],
      brief: `## Builder\n\nYou build. Follow \`PLAN.md\` in the task workspace when there is one. Make the change, keep it small, and run the relevant tests and checks. Commit on the task's branch. Write what changed and how you checked it to \`CHANGES.md\` in the task workspace, then hand off to the Reviewer. When the Reviewer sends the task back, fix exactly what \`REVIEW.md\` lists.\n\n${FINISH}` },
    { id: "reviewer", name: "Cy", role: "Reviewer", program: "claude", model: "", color: "ansi5", capacity: 1, handoffs: ["builder"], secrets: [], args: [],
      brief: `## Reviewer\n\nYou review. Read the change (\`git diff\` against the branch it started from, and the files \`CHANGES.md\` names) against the task. Look for bugs, missed cases and anything the task asked for that is not there. Do not change project files. Write your findings to \`REVIEW.md\` in the task workspace. If something must change, hand off to the Builder with the list in your summary. Otherwise report done.\n\n${FINISH}` },
  ],
};
export function initialTeams(legacy) {
  if (Array.isArray(legacy) && legacy.length) return [{ id: "default", name: "Default", members: legacy }];
  return [structuredClone(STARTER_TEAM)];
}

function load() {
  tasks = readJson(P("tasks.json"), []);
  boards = readJson(P("boards.json"), []);
  teams = readJson(P("teams.json"), null);
  // An engine from before team libraries kept one team: it becomes "Default".
  if (!teams) { teams = initialTeams(readJson(P("team.json"), null)); dirty = true; }
  settings = { ...DEFAULT_SETTINGS, ...readJson(P("settings.json"), {}) };
  // The old default of 8 counted every run, stopped ones too: it becomes 20.
  if (!settings.runLimitV2) { if (settings.maxRuns === 8) settings.maxRuns = 20; settings.runLimitV2 = true; dirty = true; }
  const st = readJson(P("state.json"), {});
  events = st.events ?? [];
  applied = st.applied ?? [];
  limitGate = st.limitGate ?? null;
  // A closed load gate stays closed across a restart, until two calm checks.
  loadGate = st.loadGate ? { ...st.loadGate, calm: 0 } : null;
  // An engine from before pins: the spaces that showed a board then keep it.
  pins = st.pins ?? Object.fromEntries(Object.entries(st.spaces ?? {}).filter(([, v]) => !v.taskWorktree && boardById(v.board)).map(([id, v]) => [id, v.board]));
  for (const t of tasks) if (!t.board && t.folder) { t.board = ensureBoard(t.folder).id; dirty = true; }
}

const uid = (prefix) => prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
const task = (id) => tasks.find((t) => t.id === id) ?? null;
const boardById = (id) => boards.find((b) => b.id === id) ?? null;
const teamById = (id) => teams.find((x) => x.id === id) ?? null;
const teamByRef = (ref) => teamById(ref) ?? teams.find((x) => x.name.toLowerCase() === String(ref ?? "").trim().toLowerCase()) ?? null;
// The board of a checkout folder; made (with the first team) when it is new.
function ensureBoard(top) {
  top = clean(top);
  const id = boardIdOf(top);
  let b = boardById(id);
  if (!b) {
    b = { id, folder: top, team: teams[0]?.id ?? null, settings: { ...DEFAULT_BOARD }, created: Date.now() };
    boards = [...boards, b];
    dirty = true;
  }
  return b;
}
const boardOf = (t) => boardById(typeof t === "string" ? t : t?.board);
const boardSet = (t) => ({ ...DEFAULT_BOARD, ...(boardOf(t)?.settings ?? {}) });
const teamOf = (t) => teamById(boardOf(t)?.team);
const membersOf = (t) => teamOf(t)?.members ?? [];
// A member of the task's (or board's) team, by id or name.
function member(ref, t) {
  if (!ref) return null;
  const key = String(ref).trim().toLowerCase();
  return membersOf(t).find((m) => m.id === key || m.name.toLowerCase() === key || `${m.name} (${m.role})`.toLowerCase() === key) ?? null;
}
function updateTask(id, patch) {
  tasks = tasks.map((t) => {
    if (t.id !== id) return t;
    const next = typeof patch === "function" ? patch(t) : { ...t, ...patch, updated: Date.now() };
    // When the task entered Done: the session cleanup counts from there.
    // Review and Done: when the task entered them (the session cleanup counts from there).
    const rest = (c) => c === "review" || c === "done";
    if (rest(next.column) && !rest(t.column)) next.restAt = Date.now();
    if (!rest(next.column) && next.restAt) next.restAt = null;
    if (next.column === "done" && t.column !== "done") return { ...next, doneAt: Date.now() };
    if (next.column !== "done" && next.doneAt) return { ...next, doneAt: null };
    return next;
  });
  dirty = true;
}
const hist = (t, text, memberId = null) => [...(t.history ?? []), { at: Date.now(), member: memberId, text }];
const activeRun = (t) => [...(t.runs ?? [])].reverse().find((r) => !r.ended && !r.result) ?? null;
// Room counts per board: a member's tasks on that board only.
const capacityOf = (m) => Math.max(1, Math.floor(Number(m?.capacity) || 1));
const busyCount = (board, id) => tasks.filter((t) => t.board === board && activeRun(t)?.member === id).length;
const hasRoom = (m, board) => Boolean(m) && busyCount(board, m.id) < capacityOf(m);
const taskDir = (t) => t.dir ?? path.join(TASKS_DIR, t.id);
const resultFile = (t, r) => `${taskDir(t)}/result.${r.id}.json`;
const workFolder = (t) => t.worktree?.path ?? boardOf(t)?.folder ?? t.folder ?? null;

function event(level, title, body, extra = {}) {
  events = [...events, { id: uid("e"), at: Date.now(), level, title, body: String(body ?? "").slice(0, 300), ...extra }].slice(-100);
  dirty = true;
}

// ---- worktrees ----

const slugOf = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
async function git(cwd, argv) {
  const r = await run("git", ["-C", cwd, ...argv]);
  return { ok: r.code === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}
async function repoOf(folder) {
  const top = await git(folder, ["rev-parse", "--show-toplevel"]);
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!top.ok || !common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  return { top: top.out, main, name: main.split("/").pop() };
}
// What a new task branches from: the repository's default branch, fresh from
// origin, not whatever the board's checkout has now (another task may have
// switched it). Without a remote: the checkout's HEAD.
async function baseRef(top) {
  if (!(await git(top, ["remote", "get-url", "origin"])).ok) return "HEAD";
  let head = (await git(top, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).out;
  const fetched = (await run("git", ["-C", top, "fetch", "--quiet", "origin"], { timeout: 120000 })).code === 0;
  if (!head) for (const b of ["origin/main", "origin/master"]) if ((await git(top, ["rev-parse", "--verify", "--quiet", b])).ok) { head = b; break; }
  if (!head) return "HEAD";
  if (!fetched) log("fetch failed in", top, "; branching from the last fetched", head);
  return head;
}
const branchOf = async (folder) => (await git(folder, ["rev-parse", "--abbrev-ref", "HEAD"])).out || null;
const taskBranch = (t) => `board/${slugOf(t.title) || "task"}-${t.id.slice(-5)}`;
// A task with exactly one dependency builds on that task's work: it branches
// from the dependency's branch, not from the default branch (else its PR
// carries the dependency's commits and newer default-branch ones twice).
// The branch name: the one its worktree has, else the name the engine gives it.
export function depBranchOf(t, all) {
  const ids = t?.dependsOn ?? [];
  if (ids.length !== 1) return null;
  const d = all.find((x) => x.id === ids[0] && x.board === t.board);
  return d ? (d.worktree?.branch ?? taskBranch(d)) : null;
}
// The ref a dependent task branches from: the dependency's pushed branch, or
// its local one when that is ahead of (or without) the pushed one; null when
// neither exists.
export async function depRef(top, branch) {
  const has = async (ref) => (await git(top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).ok;
  const remote = (await git(top, ["remote", "get-url", "origin"])).ok;
  if (remote) await run("git", ["-C", top, "fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { timeout: 120000 });
  const pushed = remote && await has(`refs/remotes/origin/${branch}`) ? `origin/${branch}` : null;
  const local = await has(`refs/heads/${branch}`) ? branch : null;
  if (pushed && local) {
    const same = (await git(top, ["rev-parse", pushed])).out === (await git(top, ["rev-parse", local])).out;
    const ahead = !same && (await git(top, ["merge-base", "--is-ancestor", pushed, local])).ok;
    return ahead ? local : pushed;
  }
  return pushed ?? local;
}

// The task's worktree: the one it has, or a new one for a task's first run.
// null: it works in the board's folder (setting off, not git, or it already ran there).
async function worktreeFor(t, folder) {
  if (t.worktree?.path) {
    if (fs.existsSync(t.worktree.path)) return t.worktree;
    throw new Error(`The task's worktree ${t.worktree.path} is gone. Restore it, or remove it in the task to work in the board's folder.`);
  }
  if (!boardSet(t).worktrees || !folder || (t.runs ?? []).length) return null;
  const repo = await repoOf(folder);
  if (!repo) return null;
  const branch = taskBranch(t);
  const wpath = `${WT_ROOT}/${repo.name}/${branch.replace(/\//g, "-")}`;
  const exists = (await git(repo.top, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
  const dep = exists ? null : depBranchOf(t, tasks);
  const fromDep = dep ? await depRef(repo.top, dep) : null;
  if (dep && !fromDep) log("dependency branch", dep, "not found in", repo.top, "; branching from the default branch");
  const base = exists ? branch : fromDep ?? await baseRef(repo.top);
  const r = await git(repo.top, exists ? ["worktree", "add", wpath, branch] : ["worktree", "add", "--no-track", "-b", branch, wpath, base]);
  if (!r.ok) throw new Error(`Could not make a worktree for the task: ${r.err || "git worktree add failed"}`);
  return { path: wpath, branch, base, repo: repo.top, fresh: !exists };
}
async function removeWorktree(t) {
  const wt = t.worktree;
  if (!wt?.path) return;
  if (activeRun(t)) throw new Error("Someone is working in it: stop the run first.");
  const r = await git(wt.repo ?? wt.path, ["worktree", "remove", wt.path]);
  if (!r.ok && !/is not a working tree|does not exist/.test(r.err)) throw new Error(r.err || "git worktree remove failed.");
  updateTask(t.id, (cur) => ({ ...cur, worktree: null, updated: Date.now(), history: hist(cur, `Worktree removed (branch ${wt.branch} kept)`) }));
}

// ---- the brief ----

const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
function firstSentence(text) {
  const lines = String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => !l.startsWith("#")) ?? lines[0] ?? "";
  return line.replace(/^(#+|[-*>]|\d+\.)\s*/, "").replace(/\*\*|`/g, "").replace(/(^|\s)_+|_+(?=[\s.,;:!?)]|$)/g, "$1").split(/(?<=\.)\s/)[0];
}
function composeBrief(t, m, dir, folder, result) {
  const can = (m.handoffs ?? []).map((id) => member(id, t)).filter(Boolean);
  const names = can.map((x) => `${x.name} (${x.role})`);
  const lines = [];
  lines.push(`# You are ${m.name}, the ${m.role}`, "", String(m.brief ?? "").trim(), "");
  lines.push("# The team", "");
  for (const x of membersOf(t)) lines.push(`- ${x.name}, ${x.role}${x.id === m.id ? " (you)" : ""}: ${firstSentence(x.brief)}`);
  lines.push("", can.length ? `You may hand off to: ${names.join(", ")}.` : "You cannot hand off to anyone: finish the task or report blocked.", "");
  lines.push(`# Task: ${t.title}`, "", (t.description || "(no description)").trim(), "");
  if (t.attachments?.length) {
    lines.push("# Attachments", "", "Files the person attached to this task. Read them. Images and PDFs can be viewed.", "");
    for (const a of t.attachments) lines.push(`- ${dir}/files/${a.name} (${fmtSize(a.size ?? 0)})`);
    lines.push("");
  }
  const secretNames = (m.secrets ?? []).filter((n) => SECRET_NAME.test(n));
  if (secretNames.length) {
    lines.push("# Secrets", "", `You have these secrets as environment variables: ${secretNames.map((n) => `\`$${n}\``).join(", ")}. Use them only as variables in commands, for example \`curl -H "Authorization: Bearer $${secretNames[0]}" ...\`. Never print, echo or log their values, and never write them into files, commits, notes, results or messages. If one is empty, it is not set on this machine: report blocked and ask the person.`, "");
  }
  lines.push(`Repository or folder to work in: ${folder ?? "(the folder this terminal starts in)"}`);
  if (t.worktree?.path) {
    lines.push(`This is a git worktree of its own for this task, on branch \`${t.worktree.branch}\`${t.worktree.base ? `, made from \`${t.worktree.base}\`` : ""}. Other tasks run at the same time in other worktrees: work only here, and do not switch branches. It is a fresh checkout: install dependencies first if the build or tests need them. The main checkout is ${t.worktree.repo}; do not change files there.`);
  }
  lines.push(`Task workspace for notes, plans and results: ${dir}`, "");
  const bs = boardSet(t);
  if (String(bs.envNotes ?? "").trim()) lines.push("# This machine and its other agents", "", String(bs.envNotes).trim(), "");
  if (String(bs.standing ?? "").trim()) lines.push("# Decisions the person already made", "", "Do not ask the person about these again; follow them.", "", String(bs.standing).trim(), "");
  if (t.history?.length) {
    lines.push("# History", "");
    for (const h of t.history.slice(-12)) lines.push(`- ${when(h.at)} ${h.text}`);
    lines.push("");
  }
  lines.push("# How to finish (required)", "");
  lines.push(`When your part is done, or you cannot continue, write the file ${result} with exactly this shape, then stop:`, "");
  lines.push("```json", `{"action": "handoff", "to": "${can[0]?.name ?? "Name"}", "summary": "What you did, where your notes are, and what the next person must do."}`, "```", "");
  lines.push("`action` is one of:", "");
  lines.push(`- "handoff": pass the task to a team member named in "to"${can.length ? ` (one of: ${can.map((x) => x.name).join(", ")})` : ""}.`);
  lines.push('- "done": the whole task is finished and ready for the person to review.');
  lines.push('- "blocked": you need the person. Put your question in "summary" and wait in this terminal for their answer; after it, continue and write the same file again.');
  lines.push("");
  lines.push(`Write longer notes (plans, findings) as markdown files in ${dir} and name them in "summary". Do not start other agents. Stay in this terminal after writing the result: the person may ask you follow-up questions here.`);
  lines.push("", "If you hit a usage limit, stop and wait for it to reset; do not hand off unfinished work. A check that runs for a long time may run in the background: wait for it and read its result before you hand off.");
  return lines.join("\n") + "\n";
}
const kickoff = (m, dir, result) =>
  `You are ${m.name}, the ${m.role} on a small team that the Herdr board coordinates. Read ${dir}/brief.md now and follow it exactly: it has the task, the team, the history and how to finish (write ${result}). Start right away.`;

// ---- starting a member ----

// Codex runs a board agent read-only unless told otherwise, and then refuses
// the task folder and every write. A board agent works alone: it may write in
// its worktree and the task folder, uses the network (npm, gh), and never stops
// to ask (a command the sandbox blocks fails, and the agent says so). A member's
// own Extra arguments that set a sandbox or approval policy win.
export function codexDefaults(m, base = []) {
  const codex = m?.program === "codex" || /(^|\/)codex$/.test(base[0] ?? "");
  if (!codex) return [];
  const own = (m.args ?? []).join(" ");
  if (/(^|\s)(-s|--sandbox|-a|--ask-for-approval|--full-auto|--dangerously-bypass-approvals-and-sandbox)(\s|=|$)/.test(own)) return [];
  return ["--sandbox", "workspace-write", "--ask-for-approval", "never", "-c", "sandbox_workspace_write.network_access=true"];
}
async function argvFor(m, dir) {
  const base = runOf(m.program);
  if (!(await installed(base[0]))) throw new Error(`${settings.programs?.[m.program]?.name ?? m.program} is not installed on ${MACHINE ?? "this machine"}. Install it here, or give ${m.name} another program in Teams.`);
  // Claude and Codex both get the task folder as a second writable folder, so
  // reading the brief and writing notes and the result there asks nothing.
  const addDir = ["claude", "codex"].includes(m.program) || /(^|\/)(claude|codex)$/.test(base[0]);
  // A Codex member in the board's sandbox also writes board-heavy's slots
  // (<home>/heavy): without it, a browser suite through "$BOARD_HEAVY" cannot start.
  const cdx = codexDefaults(m, base);
  const heavy = path.join(HOME, "heavy");
  if (cdx.length) fs.mkdirSync(heavy, { recursive: true });
  return [...base, ...(m.model ? ["--model", m.model] : []), ...cdx, ...(cdx.length ? ["--add-dir", heavy] : []), ...(dir && addDir ? ["--add-dir", dir] : []), ...(m.args ?? [])];
}

// queued: a start by the engine itself (a pickup or a waiting hand-off).
// ---- dependencies ----
//
// A task's dependsOn: ids of tasks on the same board. It may start (by hand,
// by a hand-off or by pick-up) only when every one is in Review or Done. A task
// that is gone counts as done.
const DEP_DONE = new Set(["review", "done"]);
export const blockedBy = (t, all) => (t?.dependsOn ?? [])
  .map((id) => all.find((x) => x.id === id))
  .filter((d) => d && !DEP_DONE.has(d.column));
const colName = (c) => COLUMNS.find((x) => x.id === c)?.name ?? c;
export function depsText(blockers) {
  if (!blockers.length) return null;
  if (blockers.length === 1) return `Waits for "${blockers[0].title}" (${colName(blockers[0].column)})`;
  return `Waits for ${blockers.length} tasks: ${blockers.map((d) => `"${d.title}" (${colName(d.column)})`).join(", ")}`;
}
// Would `deps` on task `id` close a loop (some dependency, through its own
// dependencies, depends on `id`)?
export function wouldCycle(id, deps, all) {
  const seen = new Set();
  const stack = [...deps];
  while (stack.length) {
    const d = stack.pop();
    if (d === id) return true;
    if (seen.has(d)) continue;
    seen.add(d);
    stack.push(...(all.find((x) => x.id === d)?.dependsOn ?? []));
  }
  return false;
}
// Ids (or exact titles, for agents' requests) to ids on the task's board.
function depIds(t, list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error("dependsOn is a list of task ids or titles.");
  const out = [];
  for (const ref of list) {
    const key = String(ref ?? "").trim();
    if (!key) continue;
    const d = tasks.find((x) => x.id === key) ?? tasks.filter((x) => x.board === t.board && x.title === key)[0];
    if (!d) continue; // gone: counts as done, so it is dropped
    if (d.board !== t.board) throw new Error(`"${d.title}" is on another board: a task can depend only on tasks of its own board.`);
    if (d.id === t.id) throw new Error("A task cannot depend on itself.");
    if (!out.includes(d.id)) out.push(d.id);
  }
  if (t.id && wouldCycle(t.id, out, tasks)) throw new Error("That would make a loop: one of those tasks already waits for this one.");
  return out;
}
// A task whose dependencies were open and are now all done: say so once.
function depsWatch() {
  for (const t of tasks) {
    if (!t.dependsOn?.length) { if (t.depsWaiting) updateTask(t.id, (cur) => ({ ...cur, depsWaiting: false })); continue; }
    const open = blockedBy(t, tasks).length > 0;
    if (open && !t.depsWaiting) updateTask(t.id, (cur) => ({ ...cur, depsWaiting: true }));
    if (!open && t.depsWaiting) {
      updateTask(t.id, (cur) => ({ ...cur, depsWaiting: false, history: hist(cur, "Its dependencies are in Review or Done: it can start") }));
      event("info", `${t.title}: dependencies done`, "It can start now.");
    }
  }
}

async function launch(t, memberId, { queued = false } = {}) {
  const deps = depsText(blockedBy(t, tasks));
  if (deps) throw Object.assign(new Error(deps), { wait: true, deps: true });
  if (queued && startGate()) throw Object.assign(new Error(startGate()), { wait: true, limit: true });
  const b = boardOf(t);
  if (!b) throw new Error("The task has no board.");
  const m = member(memberId ?? t.assignee, t);
  if (!m) throw new Error(t.assignee ? "Its assignee is not in this board's team: assign someone." : "Assign a team member first.");
  if (activeRun(t)) throw new Error(`${member(activeRun(t).member, t)?.name ?? "Someone"} is already on it.`);
  if (countedRuns(t) >= settings.maxRuns) throw new Error(`${settings.maxRuns} finished runs already: raise the run limit in the board's menu, or restart the task.`);
  const space = spaceOfBoard(b.id, t.space);
  const folder = b.folder;
  if (!fs.existsSync(folder)) throw new Error(`The board's folder ${folder} is gone.`);
  const wt = await worktreeFor(t, folder);
  const workIn = wt?.path ?? folder;
  // A new task without a worktree waits for a folder another task of its board
  // works in. A task that already ran there keeps going there.
  if (queued && !wt && !(t.runs ?? []).length) {
    const other = tasks.find((x) => x.id !== t.id && x.board === t.board && activeRun(x) && workFolder(x) === workIn);
    if (other) throw Object.assign(new Error(`Waits for "${other.title}", which works in the same folder.`), { wait: true });
  }
  const dir = taskDir(t);
  if (!DRY) fs.mkdirSync(dir, { recursive: true });
  const runId = uid("r");
  const result = `${dir}/result.${runId}.json`;
  const argv = await argvFor(m, dir);
  // --add-dir takes several folders: "--" ends them, or the first message counts as one.
  const claude = argv.includes("--add-dir");
  writeAtomic(path.join(dir, "brief.md"), composeBrief({ ...t, worktree: wt ?? t.worktree }, m, dir, workIn, result));
  const first = kickoff(m, dir, result);
  const name = `${t.title} · ${m.name}`;
  const labels = { "board.task": t.id, "board.run": runId, where: `${space?.name || path.basename(folder)} / ${name}` };
  let tab = null;
  // Tabs: Herdr shows a terminal that carries its space and tab labels; a tab id
  // it does not know becomes a new tab in that space.
  if (settings.openTabs && space) { tab = uid("tb"); Object.assign(labels, { "herdr.space": space.id, "herdr.tab": tab }); }
  if (DRY) throw new Error("dry run");
  const sec = secretShell(t, m);
  // What board-heavy and the test runners need: the slot script on PATH, this
  // run's ids, and the board's worker cap (E2E_WORKERS too: some e2e configs read it).
  const workers = Math.max(1, Math.floor(Number(boardSet(t).workers) || 4));
  const env = { BOARD_HOME: HOME, BOARD_HEAVY: path.join(HOME, "bin", "board-heavy"), BOARD_HEAVY_SLOTS: String(Math.max(1, Math.floor(Number(settings.heavySlots) || 1))),
    BOARD_TASK: t.id, BOARD_RUN: runId, BOARD_WORKERS: String(workers), PLAYWRIGHT_WORKERS: String(workers), PW_WORKERS: String(workers), E2E_WORKERS: String(workers),
    ...browserEnv(t.id, runId) };
  const envPre = FISH
    ? `${Object.entries(env).map(([k, v]) => `set -gx ${k} ${q1(v)};`).join(" ")} set -gx PATH ${q1(path.join(HOME, "bin"))} $PATH; `
    : `export ${Object.entries(env).map(([k, v]) => `${k}=${q1(v)}`).join(" ")} PATH=${q1(path.join(HOME, "bin"))}:"$PATH"; `;
  sec.pre = envPre + sec.pre;
  // A new worktree runs the board's setup first, in the agent's terminal, its
  // output and exit code in the task folder; the agent starts either way.
  const setup = wt?.fresh && String(boardSet(t).setup ?? "").trim();
  if (setup) {
    try { fs.rmSync(path.join(dir, "setup.exit"), { force: true }); } catch {}
    sec.pre = `{ eval ${q1(setup)}; } > ${q1(path.join(dir, "setup.log"))} 2>&1; printf %s $? > ${q1(path.join(dir, "setup.exit"))}; ${sec.pre}`;
  }
  const rootBranch = await branchOf(folder);
  const r = await run(HC, ["run", "--bg", "--json", "--no-parent", ...(tab ? ["--keep"] : []), "--cwd", workIn,
    ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]), "--", ...wrapped([...argv, ...(claude ? ["--"] : []), first], sec.pre, sec.after)]);
  let out;
  try { out = JSON.parse(r.stdout.trim()); } catch { throw new Error((r.stderr || r.stdout || "hc did not answer").trim()); }
  if (r.code !== 0 || !out?.address) throw new Error((out?.error || r.stderr || "hc run failed").trim());
  const entry = { id: runId, member: m.id, terminal: out.address, tab, space: space?.id ?? null, background: !tab, started: Date.now(), ended: null, result: null, exit: null, rootBranch, ...(setup ? { setup: "running" } : {}) };
  updateTask(t.id, (cur) => ({
    ...cur, assignee: m.id, column: "doing", attention: null, queued: false, updated: Date.now(),
    space: space?.id ?? cur.space ?? null, folder, dir, worktree: wt ? { path: wt.path, branch: wt.branch, base: wt.base, repo: wt.repo } : cur.worktree ?? null, wait: null,
    runs: [...(cur.runs ?? []), entry],
    history: hist(cur, `${m.name} (${m.role}) started`, m.id),
  }));
  log("started", m.name, "on", t.id, out.address);
  return entry;
}

function killRun(r) {
  if (!r?.terminal || r.terminal.includes("/")) return;
  run(HC, ["kill", r.terminal]).then(() => (inPane(r) ? null : run(HC, ["rm", r.terminal]))).catch(() => {});
}
function endRun(taskId, runId, how) {
  const t = task(taskId);
  const r = t?.runs?.find((x) => x.id === runId);
  if (!r) return;
  if (how === "stopped") killRun(r);
  updateTask(taskId, (cur) => ({ ...cur, updated: Date.now(), runs: cur.runs.map((x) => (x.id === runId ? { ...x, ended: x.ended ?? Date.now(), exit: how } : x)) }));
}

// ---- results, hand-offs and checks ----

function collect() {
  const found = [];
  for (const t of tasks) {
    const r = activeRun(t);
    if (!r) continue;
    let text;
    try { text = fs.readFileSync(resultFile(t, r), "utf8"); } catch { continue; }
    let res;
    try { res = JSON.parse(text); } catch { continue; }
    if (res && typeof res === "object") found.push({ task: t.id, run: r.id, res });
  }
  return found;
}

function applyResult(taskId, runId, res) {
  const t = task(taskId);
  const r = t?.runs?.find((x) => x.id === runId);
  if (!t || !r || r.result || r.ended) return null;
  const who = member(r.member, t) ?? { id: r.member, name: "Someone", role: "" };
  const action = ["handoff", "done", "blocked"].includes(res.action) ? res.action : "done";
  const to = action === "handoff" ? member(res.to, t) : null;
  const summary = String(res.summary ?? "").trim() || "(no summary)";
  let patch;
  if (action === "blocked") {
    if (r.blocked === summary) return null;
    const runs = t.runs.map((x) => (x.id === runId ? { ...x, blocked: summary, blockPaused: false, blockAnswered: false } : x));
    patch = { runs, attention: `${who.name} needs you: ${summary}`, history: hist(t, `${who.name} is blocked: ${summary}`, who.id) };
  } else {
    const runs = t.runs.map((x) => (x.id === runId ? { ...x, result: { action, to: to?.id ?? res.to ?? null, summary }, ended: Date.now(), exit: "result" } : x));
    if (action === "handoff" && !to) patch = { runs, attention: `${who.name} handed off to "${res.to}", who is not on the team`, history: hist(t, `${who.name} tried to hand off to "${res.to}": ${summary}`, who.id) };
    else if (action === "handoff") patch = { runs, assignee: to.id, column: "doing", attention: null, history: hist(t, `${who.name} → ${to.name}: ${summary}`, who.id) };
    else patch = { runs, column: "review", attention: null, history: hist(t, `${who.name} finished: ${summary}`, who.id) };
  }
  updateTask(taskId, { ...patch, updated: Date.now() });
  return { action, who, to, summary };
}

function archiveResult(t, r, tag) {
  const from = resultFile(t, r);
  try { fs.renameSync(from, from.replace(/\.json$/, `.${tag}.${Date.now()}.json`)); } catch {}
}

async function results() {
  for (const f of collect()) {
    const t = task(f.task);
    const r = t?.runs?.find((x) => x.id === f.run);
    const done = applyResult(f.task, f.run, f.res);
    if (!done) continue;
    archiveResult(t, r, done.action);
    const after = task(f.task);
    if (done.action === "handoff" && done.to) {
      event("info", `${done.who.name} → ${done.to.name}`, `${after.title}: ${done.summary}`);
      const loop = loopOf(after);
      if (loop) {
        const [a, b] = loop.map((id) => member(id, after)?.name ?? id);
        updateTask(after.id, { attention: `${a} and ${b} handed this back and forth ${LOOP} times in a row. Read the notes, then press Start to let ${done.to.name} go on, or change the task.` });
        event("warning", `${after.title}: a loop?`, `${a} and ${b} handed it back and forth ${LOOP} times.`);
      } else if (settings.autopilot && after.autopilot !== false && blockedBy(after, tasks).length) {
        updateTask(after.id, (cur) => ({ ...cur, queued: true, history: hist(cur, `${depsText(blockedBy(cur, tasks))} before ${done.to.name} starts`, done.to.id) }));
      } else if (settings.autopilot && after.autopilot !== false && startGate()) {
        updateTask(after.id, (cur) => ({ ...cur, queued: true, wait: startGate(), history: hist(cur, `${startGate()} before ${done.to.name} starts`, done.to.id) }));
      } else if (settings.autopilot && after.autopilot !== false) {
        if (!hasRoom(done.to, after.board)) {
          const on = tasks.find((x) => x.board === after.board && activeRun(x)?.member === done.to.id);
          updateTask(after.id, (cur) => ({ ...cur, queued: true, history: hist(cur, `Waits for ${done.to.name}, who works on "${on?.title ?? "another task"}"`, done.to.id) }));
        }
        else {
          try { await launch(task(after.id), done.to.id); }
          catch (e) { updateTask(after.id, { attention: `Could not start ${done.to.name}: ${e.message ?? e}` }); }
        }
      }
    } else if (done.action === "done") {
      event("success", `${after.title}: ready for review`, done.summary);
    } else if (done.action === "blocked") {
      const rr = after.runs.find((x) => x.id === f.run);
      if (rr?.background && !inPane(rr)) event("warning", `${done.who.name} needs you`, `${after.title}: ${done.summary}`, { terminal: rr.terminal, sound: "blocked" });
    }
  }
}

// Runs whose terminal is gone end; one that ended without a result needs the person.
function reconcile() {
  if (!world.ok || !world.terminals.length) return;
  const now = Date.now();
  for (const t of tasks) {
    const r = activeRun(t);
    if (!r || !r.terminal || r.terminal.includes("/") || isLive(r) || now - r.started < 20000) continue;
    const who = member(r.member, t)?.name ?? "The agent";
    updateTask(t.id, (cur) => ({
      ...cur, updated: now,
      runs: cur.runs.map((x) => (x.id === r.id ? { ...x, ended: now, exit: "gone" } : x)),
      attention: `${who} ended without writing a result`,
      history: hist(cur, `${who} ended without a result`, r.member),
    }));
  }
}

// Claude Code at a usage limit, from the core's report and, when the message
// does not say, the screen: read once per new report, every pass during a short
// hold (the limit line can come after the status), and once a minute while
// Claude waits. A run that waits by itself is "limited", not "needs you".
const LIMIT_HOLD_MS = 5000;
const LIMIT_REREAD_MS = 60000;
export const holding = (r) => Boolean(r?.limitHold);

// The machine at a usage limit: no new starts (hand-offs, pickups, waiting
// starts) until its reset, plus a margin. Set from any run's limit; kept in
// state.json across restarts. until: a time like "10pm" or "10:30pm".
const LIMIT_MARGIN_MS = 5 * 60000;
let limitGate = null; // { until (ms), text, seen (ms) }
export function resetAt(text, seen = Date.now()) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(String(text ?? ""));
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if ((m[3] ?? "").toLowerCase() === "pm") h += 12;
  if (!m[3] && Number(m[1]) === 12) h = 12;
  if (!m[3] && Number(m[1]) < 12 && Number(m[1]) !== 0) h = Number(m[1]);
  const d = new Date(seen);
  d.setHours(h, Number(m[2] ?? 0), 0, 0);
  // A reset earlier than an hour before it was seen is tomorrow's.
  if (d.getTime() < seen - 3600000) d.setDate(d.getDate() + 1);
  return d.getTime();
}
function updateLimitGate() {
  const now = Date.now();
  for (const t of tasks) {
    const r = activeRun(t);
    if (!r?.limit) continue;
    const until = resetAt(r.limit.until, now) ?? now + 3600000;
    if (!limitGate || until > limitGate.until || limitGate.until < now) { limitGate = { until, text: r.limit.until ?? "the reset", seen: now }; dirty = true; }
  }
  if (limitGate && now > limitGate.until + LIMIT_MARGIN_MS) { limitGate = null; dirty = true; }
}
export const limitWait = () => (limitGate && Date.now() < limitGate.until + LIMIT_MARGIN_MS ? `Waits for the usage limit to reset at ${limitGate.text}` : null);
// ---- the load gate ----
//
// A machine that is out of memory or far over its cores gets no new starts
// (hand-offs, pick-ups, waiting starts) until it is calm for two checks in a
// row. Running work is never touched; a manual Start still works.
let loadGate = null; // { why: "memory" | "swap" | "load", since, calm, detail }
let lastLoadCheck = 0;
// The machine's numbers, as `sysctl -n kern.memorystatus_vm_pressure_level vm.swapusage vm.loadavg hw.ncpu` prints them.
export function parseLoad(text) {
  const lines = String(text).split("\n").map((x) => x.trim()).filter(Boolean);
  const num = (x) => { const m = /([\d.]+)M/.exec(x ?? ""); return m ? Number(m[1]) : null; };
  const sw = lines.find((l) => l.includes("total ="));
  const avg = lines.find((l) => l.startsWith("{"));
  const ints = lines.filter((l) => /^\d+$/.test(l)).map(Number);
  return {
    pressure: ints[0] ?? null,
    ncpu: ints[1] ?? null,
    swapTotal: sw ? num(sw.split("total =")[1]) : null,
    swapUsed: sw ? num(sw.split("used =")[1]) : null,
    load1: avg ? Number(avg.replace(/[{}]/g, "").trim().split(/\s+/)[0]) : null,
  };
}
// Why the machine is too busy for new starts, or null.
export function loadVerdict(n, s) {
  // 0 turns a rule off.
  if ((s.gatePressure ?? 2) > 0 && n.pressure != null && n.pressure >= (s.gatePressure ?? 2)) return { why: "memory", detail: n.pressure >= 4 ? "memory pressure critical" : "memory pressure warning" };
  if (s.gateSwap > 0 && n.swapTotal > 0 && n.swapUsed / n.swapTotal > s.gateSwap) return { why: "swap", detail: `swap ${Math.round((100 * n.swapUsed) / n.swapTotal)}% used` };
  if ((s.gateLoad ?? 1.5) > 0 && n.ncpu > 0 && n.load1 > (s.gateLoad ?? 1.5) * n.ncpu) return { why: "load", detail: `load ${n.load1.toFixed(1)} on ${n.ncpu} cores` };
  return null;
}
// ---- the machine's last hour (the Machine window) ----
//
// One sample per load check (about every 10 s): load per core (×100), memory
// pressure level, swap used %, the gate closed or not, busy browser slots. The
// last hour lives in machine.json, written apart from state.json so a sample
// never wakes the board's poller; the Machine window reads it while open.
const SAMPLES = 360;
let samples = null; // { t: [], load: [], pressure: [], swap: [], gate: [], busy: [] }
export function pushSample(buf, x, max = SAMPLES) {
  const b = buf ?? { t: [], load: [], pressure: [], swap: [], gate: [], busy: [] };
  for (const k of Object.keys(b)) { b[k].push(x[k] ?? null); if (b[k].length > max) b[k].splice(0, b[k].length - max); }
  return b;
}
function loadSamples() {
  if (samples) return samples;
  const old = readJson(P("machine.json"), null)?.samples;
  const fresh = old && Array.isArray(old.t) && old.t.length && Date.now() - old.t[old.t.length - 1] < 3600000;
  return (samples = fresh ? old : null);
}
function writeMachine(n) {
  const { held, waiting } = heavyState();
  const title = (id) => task(id)?.title ?? null;
  const out = {
    at: Date.now(), machine: MACHINE ?? os.hostname(), ncpu: n.ncpu,
    now: { load1: n.load1, pressure: n.pressure, swapUsed: n.swapUsed, swapTotal: n.swapTotal },
    settings: { niceness: settings.niceness, heavySlots: settings.heavySlots, gateLoad: settings.gateLoad, gatePressure: settings.gatePressure, gateSwap: settings.gateSwap, maxRuns: settings.maxRuns },
    gate: loadGate, limitGate,
    slots: held.map((h) => ({ slot: h.slot, task: h.task, title: title(h.task), run: h.run, since: h.start ? h.start * (h.start < 1e12 ? 1000 : 1) : null })),
    waiting: [
      ...waiting.map((w) => ({ task: w.task, title: title(w.task), why: "slot" })),
      ...tasks.filter((t) => t.wait && GATE_WAIT.test(t.wait)).map((t) => ({ task: t.id, title: t.title, why: "gate", text: t.wait })),
    ],
    samples,
  };
  try { writeAtomic(P("machine.json"), JSON.stringify(out)); } catch {}
}
async function checkLoad() {
  if (Date.now() - lastLoadCheck < 10000) return;
  lastLoadCheck = Date.now();
  // Linux: /proc (platform.mjs); macOS: these sysctl keys.
  const r = PF.LINUX ? null : await run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level", "vm.swapusage", "vm.loadavg", "hw.ncpu"], { timeout: 5000 });
  if (r && r.code !== 0 && !r.stdout) return;
  const n = r ? parseLoad(r.stdout) : PF.linuxLoad();
  if (!n) return;
  const v = loadVerdict(n, settings);
  if (v) {
    if (!loadGate || loadGate.why !== v.why || loadGate.calm) { if (!loadGate) log("load gate on:", v.detail); loadGate = { why: v.why, detail: v.detail, since: loadGate?.since ?? Date.now(), calm: 0 }; dirty = true; }
    else if (loadGate.detail !== v.detail) { loadGate = { ...loadGate, detail: v.detail }; dirty = true; }
  } else if (loadGate) {
    const calm = (loadGate.calm ?? 0) + 1;
    if (calm >= 2) { log("load gate off"); loadGate = null; } else loadGate = { ...loadGate, calm };
    dirty = true;
  }
  samples = pushSample(loadSamples(), {
    t: Date.now(),
    load: n.ncpu > 0 && n.load1 != null ? Math.round((100 * n.load1) / n.ncpu) : null,
    pressure: n.pressure,
    swap: n.swapTotal > 0 ? Math.round((100 * n.swapUsed) / n.swapTotal) : 0,
    gate: loadGate ? 1 : 0,
    busy: heavyState().held.length,
  });
  writeMachine(n);
}
export const loadWait = () => (loadGate ? `Waits: ${MACHINE ?? os.hostname()} is busy (${loadGate.why})` : null);
// Why the engine starts nothing new right now (usage limit, then load), or null.
const startGate = () => limitWait() ?? loadWait();
const GATE_WAIT = /^Waits: .* is busy \(|^Waits for the usage limit/;
// A gate that opened leaves no stale note on cards; a slot wait shows who holds the slot.
function gateWaits() {
  const g = startGate();
  for (const t of tasks) if (t.wait && GATE_WAIT.test(t.wait) && t.wait !== g && !activeRun(t)) updateTask(t.id, (cur) => ({ ...cur, wait: g && cur.queued ? g : null }));
}

// ---- browser slots (board-heavy) ----
//
// board-heavy takes one of the machine's slots (symlinks heavy/slot-N whose
// target is "<pid>:<task>:<run>:<start>"), and while it waits it leaves
// heavy/wait-<pid> with the same text. The engine shows that on the card.
const HEAVY = () => P("heavy");
export function heavyState(dir = HEAVY(), alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }) {
  const held = []; const waiting = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { held, waiting }; }
  const parse = (x) => { const [pid, task, run, start] = String(x).trim().split(":"); return { pid: Number(pid), task: task || null, run: run || null, start: Number(start) || null }; };
  for (const n of names) {
    try {
      if (/^slot-\d+$/.test(n)) { const o = parse(fs.readlinkSync(path.join(dir, n))); if (alive(o.pid)) held.push({ slot: n, ...o }); }
      else if (/^wait-\d+$/.test(n)) { const o = parse(fs.readFileSync(path.join(dir, n), "utf8")); if (alive(o.pid)) waiting.push(o); }
    } catch {}
  }
  return { held, waiting };
}
function heavyWaits() {
  const { held, waiting } = heavyState();
  const name = (id) => task(id)?.title ?? "another job";
  const text = (x) => `Waits for a browser slot (held by ${held.length ? held.map((h) => (h.task ? `"${name(h.task)}"` : "another job")).join(", ") : "another job"})`;
  const want = new Map(waiting.filter((w) => w.task).map((w) => [w.task, text(w)]));
  for (const t of tasks) {
    const cur = t.slotWait ?? null;
    const next = want.get(t.id) ?? null;
    if (cur !== next) updateTask(t.id, (x) => ({ ...x, slotWait: next }));
  }
}

const LIMIT_FIELDS = ["limit", "limitKey", "limitHold", "limitReadAt", "limitSeen"];
async function limits() {
  if (!world.ok) return;
  const now = Date.now();
  for (const t0 of tasks) {
    const r = activeRun(t0);
    if (!r || !isLive(r)) continue;
    const k = term(r.terminal);
    const who = member(r.member, t0)?.name ?? "The agent";
    const clear = { limitKey: null, limitHold: null, limitReadAt: null };
    let patch;
    let line = null;
    if (k.status === "working") patch = { ...clear, limit: null };
    // Claude stopped at the limit (Escape, or no auto-continue).
    else if (k.status === "idle" || k.status === "done") patch = { ...clear, limit: r.limit ? { ...r.limit, auto: false } : null };
    else if (k.status !== "blocked" && k.status !== "error") patch = { ...clear, limit: null };
    else {
      const prevKey = r.limitKey ?? null;
      const key = `${k.status}|${k.msg ?? ""}|${k.statusAt ?? ""}`;
      const fresh = key !== prevKey;
      if (fresh) log("status", r.terminal, k.status, k.kind, k.msg);
      let lim = limitOf(k.status, k.msg, k.kind, "");
      const holdOn = !fresh && r.limitHold != null && now - r.limitHold < LIMIT_HOLD_MS;
      const reread = !fresh && Boolean(r.limit?.auto) && now - (r.limitReadAt ?? 0) >= LIMIT_REREAD_MS;
      // A new report reads the screen unless its message already says Claude continues, and when.
      const read = k.kind == null && ((fresh && !(lim?.auto && lim?.until)) || (lim == null && holdOn) || reread);
      let readAt = fresh ? now : (r.limitReadAt ?? null);
      let readOk = false;
      if (read) {
        try {
          const got = await core.call("terminal.read", { terminal: r.terminal });
          lim = limitOf(k.status, k.msg, k.kind, got?.text ?? "");
          readAt = now;
          readOk = true;
        } catch (e) { log("limit read:", r.terminal, e?.message ?? e); }
      }
      let hold = fresh ? ((lim || k.kind) ? null : now) : (r.limitHold ?? null);
      if (hold != null && (lim || now - hold >= LIMIT_HOLD_MS)) hold = null;
      // The same report without a new read: the message alone knows less than
      // the last classification, which may have seen the screen.
      const limit = fresh || readOk ? (lim ?? (fresh ? null : (r.limit ?? null))) : (r.limit ?? lim);
      let limitSeen = r.limitSeen ?? false;
      if (limit?.auto && !limitSeen) {
        limitSeen = true;
        line = `${who} hit the usage limit; Claude continues at ${limit.until ?? "the reset"}`;
      }
      patch = { limit, limitKey: key, limitHold: hold, limitReadAt: readAt, limitSeen };
    }
    const changed = LIMIT_FIELDS.some((f) => f in patch && JSON.stringify(patch[f] ?? null) !== JSON.stringify(r[f] ?? null));
    if (!changed && !line) continue;
    tasks = tasks.map((t) => (t.id !== t0.id ? t : {
      ...t,
      runs: t.runs.map((x) => (x.id === r.id ? { ...x, ...patch } : x)),
      ...(line ? { history: hist(t, line, r.member) } : {}),
    }));
    dirty = true;
  }
}

// An agent that waits for the person in its terminal says so on its card,
// until it works again; a background one also toasts once. One that stopped
// at a usage limit says so instead.
const WAITS = (who) => `${who} is waiting for you in its terminal (a question or a permission). Peek to answer.`;
const STOPPED_HEAD = (who) => `${who} hit the usage limit and stopped.`;
const STOPPED = (who, until) => `${STOPPED_HEAD(who)} Peek, then run /rate-limit-options so it continues by itself${until ? ` at ${until}` : ""}.`;
// A question the agent asked with a "blocked" result, answered in its terminal
// (Peek) instead of through the board: once the agent has stopped after asking
// and then works again, the question is answered. Returns the run's new flags.
export function blockStep(r, st) {
  if (!r?.blocked || r.blockAnswered) return null;
  if (st === "idle" || st === "done" || st === "blocked") return r.blockPaused ? null : { blockPaused: true };
  if (st === "working" && r.blockPaused) return { blockAnswered: true };
  return null;
}

function alert() {
  for (const t of tasks) {
    const r = activeRun(t);
    if (!r || holding(r)) continue;
    const st = runStatus(r);
    const who = member(r.member, t)?.name ?? "The agent";
    const stopped = Boolean(r.limit && !r.limit.auto);
    // Its own notes: matched by their start, since the reset time can change.
    const mine = !t.attention || t.attention === WAITS(who) || t.attention.startsWith(STOPPED_HEAD(who));
    let next = t;
    if (mine) {
      let note = t.attention ?? null;
      if (stopped && (st === "blocked" || st === "idle" || st === "done")) note = STOPPED(who, r.limit.until);
      else if (st === "blocked" && !r.limit) note = WAITS(who);
      else if (st && st !== "blocked") note = null;
      if (note !== (t.attention ?? null)) next = { ...next, attention: note };
    }
    const step = blockStep(r, st);
    if (step) {
      next = { ...next, runs: next.runs.map((x) => (x.id === r.id ? { ...x, ...step } : x)) };
      if (step.blockAnswered && next.attention === `${who} needs you: ${r.blocked}`)
        next = { ...next, attention: null, updated: Date.now(), history: hist(next, `${who} continued after your answer in its terminal`, r.member) };
    }
    const akey = stopped ? "stopped" : st;
    if (r.background && !inPane(r) && st && akey !== r.alerted) {
      if (akey === "stopped") event("warning", `${who} stopped at the usage limit`, `${t.title}: peek, then run /rate-limit-options`, { terminal: r.terminal, sound: "blocked" });
      else if (akey === "blocked") event("warning", `${who} needs you`, t.title, { terminal: r.terminal, sound: "blocked" });
      else if (akey === "limited") event("info", `${who} hit the usage limit`, `${t.title}: continues at ${r.limit?.until ?? "the reset"}`, { terminal: r.terminal });
      next = { ...next, runs: next.runs.map((x) => (x.id === r.id ? { ...x, alerted: akey } : x)) };
    }
    if (next !== t) { tasks = tasks.map((x) => (x.id === t.id ? next : x)); dirty = true; }
  }
}

const QUIET_START = 60000;
const QUIET_STOP = 30000;
// Claude Code runs each Bash command as a child shell that sources one of its
// shell snapshots; one still running (a test suite, a Monitor) means the agent
// waits for its own work, not for the person.
export function busyBelow(pid, rows) {
  if (!pid) return false;
  const kids = new Map();
  for (const x of rows) { if (!kids.has(x.ppid)) kids.set(x.ppid, []); kids.get(x.ppid).push(x); }
  const stack = [...(kids.get(pid) ?? [])];
  while (stack.length) {
    const x = stack.pop();
    if (/\.claude\/shell-snapshots\/snapshot-/.test(x.command)) return true;
    stack.push(...(kids.get(x.pid) ?? []));
  }
  return false;
}
// Chrome's main processes in an agent's process tree (the browser tools start
// Chrome as a child of their server, which is a child of the agent). Helpers
// and renderers end with their main process.
export function chromesBelow(pid, rows) {
  if (!pid) return [];
  const kids = new Map();
  for (const x of rows) { if (!kids.has(x.ppid)) kids.set(x.ppid, []); kids.get(x.ppid).push(x); }
  const out = [];
  const stack = [...(kids.get(pid) ?? [])];
  while (stack.length) {
    const x = stack.pop();
    // Linux: also the Linux Chrome paths (platform.mjs).
    if ((/\/(Google Chrome|Chromium|Google Chrome for Testing)\.app\/Contents\/MacOS\/[^/]+$|\/chrome-headless-shell(\s|$)/.test(x.command.split(" --")[0]) || PF.isLinuxChromeMain(x.command)) && !/--type=/.test(x.command)) out.push(x.pid);
    else stack.push(...(kids.get(x.pid) ?? []));
  }
  return out;
}
export const psRows = (text) => String(text).split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
let procs = null; // ps rows, read at most once per pass, only when a stall is near
async function procRows() {
  if (procs) return procs;
  const r = await run("ps", ["-axo", "pid=,ppid=,command="], { timeout: 10000 });
  procs = r.code === 0 ? psRows(r.stdout) : [];
  return procs;
}
// agent-browser: each run gets its own session and namespace, so one agent's
// `close --all` stays inside its run, and an idle daemon ends by itself. The
// daemon starts outside the agent's process tree (setsid); the pid files under
// <root>/namespaces/<run>/run/ name it.
export const AB_ROOT = path.join(os.homedir(), ".agent-browser");
export const browserEnv = (taskId, runId) => ({ AGENT_BROWSER_SESSION: `${taskId}-${runId}`, AGENT_BROWSER_NAMESPACE: runId, AGENT_BROWSER_IDLE_TIMEOUT_MS: "600000" });
export function abDaemons(runId, root = AB_ROOT) {
  const dir = path.join(root, "namespaces", String(runId).toLowerCase(), "run");
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".pid")); } catch { return []; }
  return names.map((n) => Number(fs.readFileSync(path.join(dir, n), "utf8").trim())).filter((pid) => pid > 1);
}
// What to stop for a run's daemons: each pid only while it still is an
// agent-browser process (a pid file can outlive its daemon), and the Chrome below it.
export function abTargets(pids, rows) {
  const out = [];
  for (const pid of pids) {
    const row = rows.find((x) => x.pid === pid);
    if (!row || !/agent-browser/.test(row.command.split(" ")[0])) continue;
    out.push(pid, ...chromesBelow(pid, rows));
  }
  return out;
}
// A run that wrote its result does not need its browser any more: close the
// Chrome in that agent's own process tree (never one of the person's or of
// another agent). The agent's tools start a new one if it needs it again.
const closedChromes = new Set();
let lastClose = 0;
async function closeBrowsers() {
  if (Date.now() - lastClose < 10000) return; // ps at most every 10 s
  lastClose = Date.now();
  const done = tasks.flatMap((t) => (t.runs ?? []).filter((r) => r.result && isLive(r)));
  // agent-browser outlives its agent: a run with a result, or one that ended.
  const ab = tasks.flatMap((t) => (t.runs ?? []).filter((r) => r.result || r.ended)).map((r) => [r, abDaemons(r.id)]).filter(([, pids]) => pids.length);
  if (!done.length && !ab.length) return;
  const rows = await procRows();
  for (const [r, pids] of ab) {
    for (const pid of abTargets(pids, rows)) {
      if (closedChromes.has(pid)) continue;
      closedChromes.add(pid);
      try { process.kill(pid, "SIGTERM"); log("closed agent-browser", pid, "of run", r.id, "(run finished)"); } catch {}
    }
  }
  for (const r of done) {
    for (const pid of chromesBelow(term(r.terminal)?.pid, rows)) {
      if (closedChromes.has(pid)) continue;
      closedChromes.add(pid);
      try { process.kill(pid, "SIGTERM"); log("closed Chrome", pid, "of", r.terminal, "(run finished)"); } catch {}
    }
  }
}
async function stalls() {
  procs = null;
  const now = Date.now();
  for (const t of tasks) {
    const r = activeRun(t);
    if (!r || !isLive(r)) continue;
    // A stopped usage limit has its note from alert(); the hold decides soon.
    if ((r.limit && !r.limit.auto) || holding(r)) continue;
    const st = term(r.terminal)?.status != null ? runStatus(r) : null;
    const who = member(r.member, t)?.name ?? "The agent";
    let stall = null;
    if (!st && now - r.started > QUIET_START) stall = `${who} has not started: it may be waiting on a question in its terminal. Peek, answer it, then Nudge.`;
    const stopped = st === "done" || st === "idle";
    let since = stopped ? (r.stoppedAt ?? now) : null;
    if (stopped && now - since > QUIET_STOP) stall = `${who} stopped without writing a result. Peek at what it said, then answer it or Nudge.`;
    // Its own command still runs: it waits for that, not for the person.
    if (stall && busyBelow(term(r.terminal)?.pid, await procRows())) { stall = null; if (stopped) since = now; }
    const patch = {};
    if ((r.stoppedAt ?? null) !== since) patch.stoppedAt = since;
    if ((r.stall ?? null) !== stall) patch.stall = stall;
    if (!Object.keys(patch).length) continue;
    const runs = t.runs.map((x) => (x.id === r.id ? { ...x, ...patch } : x));
    let next;
    if (!("stall" in patch)) next = { ...t, runs };
    else {
      const mine = !t.attention || t.attention === r.stall;
      if (stall && mine) {
        event("warning", `${t.title}: ${who} is stuck`, stall, { terminal: r.terminal });
        next = { ...t, runs, attention: stall, updated: now, history: hist(t, stall, r.member) };
      } else next = { ...t, runs, attention: mine ? null : t.attention, updated: now };
    }
    tasks = tasks.map((x) => (x.id === t.id ? next : x));
    dirty = true;
  }
}

// What pickUp() would do with each waiting task, without doing it.
// { task, member, why } for a start; skips say why not.
function pickPlan() {
  if (!settings.autopilot) return [];
  const waiting = tasks.filter((t) => t.column === "doing" && t.queued && !activeRun(t) && !t.attention && t.autopilot !== false)
    .sort((a, b) => (a.updated ?? 0) - (b.updated ?? 0));
  const ready = tasks.filter((t) => t.column === "todo" && boardSet(t).pickup && !activeRun(t) && !t.attention && t.autopilot !== false)
    .sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
  const free = (t) => !blockedBy(t, tasks).length; // dependencies first
  return [...waiting.filter(free).map((t) => ({ t, why: "waiting hand-off" })), ...ready.filter(free).map((t) => ({ t, why: "pick up from To do" }))];
}
// Waiting work for members with room: hand-offs that wait first, then (on
// boards with Pick up) To do tasks, oldest first.
async function pickUp() {
  const started = new Set(); // a member starts at most once per board in a pass
  for (const { t } of pickPlan()) {
    const m = t.assignee ? member(t.assignee, t) : membersOf(t)[0];
    if (!m || started.has(`${m.id}\n${t.board}`) || !hasRoom(m, t.board) || !shown(t)) continue;
    const cur = task(t.id);
    if (!cur || activeRun(cur) || cur.attention) continue;
    try {
      await launch(cur, m.id, { queued: true });
      started.add(`${m.id}\n${t.board}`);
      if (t.column === "todo") updateTask(t.id, (x) => ({ ...x, history: hist(x, `${m.name} picked it up from To do`, m.id) }));
    } catch (e) {
      if (!e?.wait) updateTask(t.id, { attention: `Could not start ${m.name}: ${e.message ?? e}` });
      else if (e.limit && cur.column === "doing" && cur.wait !== e.message) updateTask(t.id, { wait: e.message });
    }
  }
}

// An In progress task with an assignee, no run, no note and not waiting is a
// hand-off that never started (an engine restart, a move by hand): it waits
// for its member like any hand-off.
export const stranded = (t, active = activeRun(t)) => t.column === "doing" && Boolean(t.assignee) && !active && !t.attention && !t.queued && t.autopilot !== false;
function strandedHandoffs() {
  for (const t of tasks) {
    if (!stranded(t)) continue;
    const name = member(t.assignee, t)?.name ?? "its member";
    const deps = depsText(blockedBy(t, tasks));
    updateTask(t.id, (cur) => ({ ...cur, queued: true, history: hist(cur, deps ? `${deps} before ${name} starts` : `Waits for ${name} to start (a hand-off that had not started)`, cur.assignee) }));
  }
}

// Sessions of finished runs that sit idle: closed after IDLE_CLOSE_MS. Never a
// run in a pane the person kept, never one that works or waits for the person.
const IDLE_CLOSE_MS = 15 * 60000;
// A finished run's idle session closes when the same member finished a later
// run of the task (only each member's last session stays to ask), or when the
// task has sat in Review or Done for `doneMinutes` (machine setting
// cleanupDone, default 30; 0 = never).
export function closable(t, r, k, now = Date.now(), doneMinutes = 30) {
  if (!r?.result || r.closed || !k || k.state !== "live") return false;
  if (k.labels?.["herdr.tab"]) return false;
  if (k.status !== "idle" && k.status !== "done") return false;
  if (!(r.idleAt != null && now - r.idleAt > IDLE_CLOSE_MS)) return false;
  const runs = t.runs ?? [];
  const later = runs.slice(runs.findIndex((x) => x.id === r.id) + 1).some((x) => x.member === r.member && x.result);
  if (later) return true;
  if (!(doneMinutes > 0) || (t.column !== "review" && t.column !== "done")) return false;
  const since = (t.column === "done" ? t.doneAt : null) ?? t.restAt ?? t.updated ?? now;
  return now - since >= doneMinutes * 60000;
}
function closeIdle() {
  if (!world.ok) return;
  const now = Date.now();
  for (const t of tasks) {
    for (const r of t.runs ?? []) {
      if (!r.result || r.closed || !r.terminal || r.terminal.includes("/")) continue;
      const k = term(r.terminal);
      const idle = k && k.state === "live" && (k.status === "idle" || k.status === "done");
      const idleAt = idle ? (r.idleAt ?? now) : null;
      if ((r.idleAt ?? null) !== idleAt) updateTask(t.id, (cur) => ({ ...cur, runs: cur.runs.map((x) => (x.id === r.id ? { ...x, idleAt } : x)) }));
      if (!closable(t, { ...r, idleAt }, k, now, Number(settings.cleanupDone ?? 30))) continue;
      killRun(r);
      const name = member(r.member, t)?.name ?? "An agent";
      updateTask(t.id, (cur) => ({ ...cur, runs: cur.runs.map((x) => (x.id === r.id ? { ...x, closed: now } : x)), history: hist(cur, `Closed ${name}'s idle session (finished ${Math.round((now - (r.ended ?? now)) / 60000)} min earlier)`, r.member) }));
      log("closed idle", r.terminal, "of", t.id);
    }
  }
}

// ---- pull requests ----

// The task's pull requests, for its card: t.prs = [{ number, url, state, draft }].
// The PRs of its worktree's branch, else the PR links in its description and
// its agents' summaries. Asked of gh in the background, every few minutes.
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g;
export function prLinksOf(t) {
  const text = [t.description ?? "", ...(t.runs ?? []).map((r) => r.result?.summary ?? "")].join("\n");
  const seen = new Map();
  for (const m of text.matchAll(PR_URL)) if (!seen.has(m[1])) seen.set(m[1], m[0]);
  return [...seen].map(([n, url]) => ({ number: Number(n), url }));
}
const prChecked = new Map();
let prBusy = false;
async function pullRequests() {
  if (prBusy) return;
  prBusy = true;
  try {
    const now = Date.now();
    for (const t of tasks) {
      const every = t.column === "done" ? 30 * 60000 : 3 * 60000;
      if (now - (prChecked.get(t.id) ?? 0) < every) continue;
      prChecked.set(t.id, now);
      const cwd = [t.worktree?.path, t.worktree?.repo, boardOf(t)?.folder, t.folder].find((f) => f && fs.existsSync(f));
      if (!cwd) continue;
      const fields = "number,url,state,isDraft";
      let prs = null;
      if (t.worktree?.branch) {
        const r = await run("gh", ["pr", "list", "--head", t.worktree.branch, "--state", "all", "--json", fields], { cwd, timeout: 20000 });
        if (r.code !== 0) continue;
        try { prs = JSON.parse(r.stdout); } catch { continue; }
      }
      if (!prs?.length) {
        prs = [];
        for (const l of prLinksOf(task(t.id) ?? t).slice(0, 4)) {
          const r = await run("gh", ["pr", "view", l.url, "--json", fields], { cwd, timeout: 20000 });
          try { prs.push(r.code === 0 ? JSON.parse(r.stdout) : { ...l, state: null }); } catch { prs.push({ ...l, state: null }); }
        }
      }
      const next = prs.map((p) => ({ number: p.number, url: p.url, state: p.state ?? null, draft: Boolean(p.isDraft) })).sort((a, b) => a.number - b.number);
      const cur = task(t.id);
      if (cur && JSON.stringify(cur.prs ?? []) !== JSON.stringify(next)) updateTask(t.id, (x) => ({ ...x, prs: next }));
    }
  } finally {
    prBusy = false;
  }
}

// Setup in a new worktree: its exit code on the card when it failed.
function setups() {
  for (const t of tasks) {
    const r = activeRun(t) ?? (t.runs ?? []).at(-1);
    if (r?.setup !== "running") continue;
    let code = null;
    try { code = fs.readFileSync(path.join(t.dir ?? taskDir(t), "setup.exit"), "utf8").trim(); } catch { continue; }
    const ok = code === "0";
    updateTask(t.id, (cur) => ({
      ...cur, runs: cur.runs.map((x) => (x.id === r.id ? { ...x, setup: ok ? "ok" : `failed ${code}` } : x)),
      ...(ok ? {} : { warn: `The board's setup failed (exit ${code}) in the new worktree; the agent started anyway. See setup.log in the task folder.` }),
      history: hist(cur, ok ? "Setup ran in the new worktree" : `Setup failed (exit ${code})`, null),
    }));
  }
}

// The board's own checkout switched branch while a run worked: new task
// worktrees no longer branch from it, but the card says so once.
let rootSeen = 0;
async function rootBranches() {
  if (Date.now() - rootSeen < 30000) return;
  rootSeen = Date.now();
  const now = {};
  for (const t of tasks) {
    const r = activeRun(t);
    if (!r?.rootBranch || r.rootChanged || !t.folder) continue;
    now[t.folder] ??= await branchOf(t.folder);
    const cur = now[t.folder];
    if (!cur || cur === r.rootBranch) continue;
    const text = `The board's checkout ${t.folder} switched from ${r.rootBranch} to ${cur} during this run. Check which task did it before other work starts there.`;
    updateTask(t.id, (x) => ({ ...x, warn: text, runs: x.runs.map((y) => (y.id === r.id ? { ...y, rootChanged: cur } : y)), history: hist(x, text, null) }));
  }
}

// A board's team changed: tasks whose assignee is not in it need the person.
function flagStrangers(boardId) {
  for (const t of tasks) {
    if (t.board !== boardId || !t.assignee || member(t.assignee, t) || activeRun(t)) continue;
    if (["done", "review"].includes(t.column)) continue;
    updateTask(t.id, (cur) => ({ ...cur, attention: `Assign someone: the assignee is not in the team "${teamOf(cur)?.name ?? "?"}".`, queued: false }));
  }
}

// ---- requests ----

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
const columnOf = (c) => {
  if (c == null) return null;
  const key = String(c).toLowerCase().trim();
  const col = COLUMNS.find((x) => x.id === key || x.name.toLowerCase() === key);
  if (!col) throw new Error(`Unknown column "${c}". Use one of: ${COLUMNS.map((x) => x.id).join(", ")}.`);
  return col.id;
};
const who = (name, t) => {
  if (name == null || name === "") return null;
  const m = member(name, t);
  if (!m) throw new Error(`No member "${name}" in this board's team (${teamOf(t)?.name ?? "none"}): ${membersOf(t).map((x) => x.name).join(", ") || "it is empty"}.`);
  return m;
};
function own(id) {
  const t = task(String(id ?? ""));
  if (!t) throw new Error(`No task "${id}". board.json lists the tasks.`);
  return t;
}
function ownTeam(ref) {
  const tm = teamByRef(ref);
  if (!tm) throw new Error(`No team "${ref}". Teams: ${teams.map((x) => x.name).join(", ") || "none"}.`);
  return tm;
}
// A name not taken in `taken`: "Bo" → "Bo 2".
function freeName(name, taken) {
  const lower = new Set([...taken].map((x) => x.toLowerCase()));
  let n = name;
  for (let i = 2; lower.has(n.toLowerCase()); i++) n = `${name} ${i}`;
  return n;
}
// A member as a value: only its own fields, with hand-offs kept to ids in `ids`.
const MEMBER_FIELDS = ["id", "name", "role", "program", "model", "args", "brief", "color", "capacity", "handoffs", "secrets"];
function cleanMember(m, ids) {
  const out = {};
  for (const k of MEMBER_FIELDS) if (m[k] !== undefined) out[k] = m[k];
  out.name = String(out.name ?? "").trim() || "Agent";
  out.role = String(out.role ?? "").trim() || "Agent";
  out.capacity = capacityOf(out);
  out.args = Array.isArray(out.args) ? out.args.map(String) : [];
  out.handoffs = (out.handoffs ?? []).filter((id) => !ids || ids.has(id));
  out.secrets = [...new Set((Array.isArray(out.secrets) ? out.secrets : []).map((n) => String(n).trim().toUpperCase()).filter((n) => SECRET_NAME.test(n)))];
  return out;
}
function cleanTeam(members) {
  if (!Array.isArray(members)) throw new Error("members must be a list.");
  const ids = new Set(members.map((m) => m.id).filter(Boolean));
  const names = new Set();
  return members.map((m) => {
    const c = cleanMember({ ...m, id: m.id || uid("m") }, ids);
    if (names.has(c.name.toLowerCase())) throw new Error(`Two members are called ${c.name}: hand-offs go by name.`);
    names.add(c.name.toLowerCase());
    return c;
  });
}
// Which programs of a team this machine lacks, and what may not carry over.
async function teamCheck(members, other = true) {
  const warnings = [];
  for (const m of members) {
    const base = runOf(m.program);
    if (!(await installed(base[0]))) warnings.push(`${m.name}: ${m.program} is not installed on ${MACHINE ?? "this machine"}.`);
    if (other && m.model) warnings.push(`${m.name}: model "${m.model}" must be available to ${m.program} here.`);
    if (other && m.args?.length) warnings.push(`${m.name}: arguments "${m.args.join(" ")}" must work with ${m.program} here.`);
  }
  return warnings;
}

// The board a request means: by id, by a space, or by a folder (the checkout that holds it).
async function boardFor(req) {
  if (req.board) { const b = boardById(req.board) ?? boards.find((x) => x.folder === clean(req.board)); if (b) return b; }
  if (req.space && boardOfSpace(req.space)) return ensureBoard(world.spaceBoards[req.space].folder);
  const folder = clean(req.folder ?? req.board);
  if (!folder.startsWith("/")) throw new Error("Name the board by folder: the absolute path of the repository (or worktree) on this machine.");
  if (!fs.existsSync(folder)) throw new Error(`No folder ${folder} on this machine.`);
  const co = await checkoutOf(folder);
  const tw = taskOfWorktree(co);
  if (tw) throw new Error(`${co.top} is a worktree the board made for a task${tw.id ? ` (${tw.id})` : ""}, not a board. Use the board of its repository.`);
  return ensureBoard(co.top);
}

// Starts the assignee of a task in "doing", only where a person can watch.
async function startIfAsked(id) {
  const t = task(id);
  if (!t || t.column !== "doing" || !t.assignee || activeRun(t)) return { started: false };
  const deps = depsText(blockedBy(t, tasks));
  if (deps) { updateTask(t.id, (cur) => ({ ...cur, queued: true })); return { started: false, warning: `${deps}: it starts when they are in Review or Done.` }; }
  if (!settings.autopilot) return { started: false, warning: "Autopilot is off: nobody started. The person starts it on the board." };
  if (!shown(t)) {
    updateTask(t.id, { column: "todo" });
    return { started: false, warning: "No open Herdr space shows this board, so nobody started and it went to To do. Open a space on its folder, then move it to doing." };
  }
  await launch(t);
  return { started: true };
}

// Fields the screen may change on a task.
const EDITABLE = ["title", "description", "assignee", "column", "attention", "autopilot", "attachments", "queued", "dependsOn"];

const OPS = {
  async create(req, source, from) {
    const seen = tasks.find((t) => t.source === source || (req.id && t.id === req.id));
    if (seen) return { id: seen.id, board: boardOf(seen)?.folder, column: seen.column, started: Boolean(activeRun(seen)), repeated: true, ...(shown(seen) ? {} : { warning: "No open Herdr space shows this board yet: open one on its folder." }) };
    const title = typeof req.title === "string" ? req.title.trim() : "";
    if (!title) throw new Error("A task needs a title.");
    const b = await boardFor(req);
    const stub = { board: b.id };
    const m = who(req.assignee, stub);
    const column = columnOf(req.column) ?? "todo";
    if (column === "doing" && !m) throw new Error('A task that starts in "doing" needs an assignee.');
    const id = typeof req.id === "string" && /^k[a-z0-9]{6,}$/.test(req.id) ? req.id : uid("k");
    const s = spaceOfBoard(b.id, req.space);
    const dependsOn = depIds({ id, board: b.id }, req.dependsOn);
    tasks = [...tasks, {
      id, board: b.id, title, description: typeof req.description === "string" ? req.description : "",
      column: column === "doing" ? "todo" : column, assignee: m?.id ?? null,
      space: s?.id ?? null, folder: b.folder, dir: null,
      runs: [], history: [{ at: Date.now(), text: `Added by ${from}` }], attention: null,
      autopilot: req.autopilot !== false, attachments: Array.isArray(req.attachments) ? req.attachments : [],
      created: Date.now(), updated: Date.now(), source, dependsOn,
    }];
    dirty = true;
    let start = { started: false };
    if (column === "doing") {
      updateTask(id, { column: "doing" });
      try { start = await startIfAsked(id); }
      catch (e) { updateTask(id, { attention: `Could not start ${m.name}: ${e?.message ?? e}` }); return { id, board: b.folder, started: false, warning: String(e?.message ?? e) }; }
    }
    const warning = start.warning ?? (shown(task(id)) ? null : `No open Herdr space on ${b.folder} yet: the task shows on that board once one opens.`);
    return { id, board: b.folder, team: teamOf(stub)?.name ?? null, column: task(id).column, space: s?.name || null, started: start.started, ...(warning ? { warning } : {}) };
  },
  async note(req, _s, from) {
    const t = own(req.id);
    const text = typeof req.text === "string" ? req.text.trim() : "";
    if (!text) throw new Error("A note needs text.");
    updateTask(t.id, (cur) => ({ ...cur, updated: Date.now(), history: hist(cur, req.raw ? text : `Note from ${from}: ${text}`) }));
    return { id: t.id };
  },
  async assign(req, _s, from) {
    const t = own(req.id);
    const m = who(req.assignee, t);
    if (!m) throw new Error("assign needs an assignee.");
    const flagged = t.attention && /^Assign someone/.test(t.attention);
    updateTask(t.id, (cur) => ({ ...cur, assignee: m.id, ...(flagged ? { attention: null } : {}), updated: Date.now(), history: hist(cur, `${from} assigned ${m.name}`) }));
    return { id: t.id, assignee: m.name };
  },
  async move(req, _s, from) {
    const t = own(req.id);
    const column = columnOf(req.column);
    if (!column) throw new Error("move needs a column.");
    updateTask(t.id, (cur) => ({ ...cur, column, queued: column === "doing" ? cur.queued : false, updated: Date.now(), history: hist(cur, `${from} moved it to ${COLUMNS.find((c) => c.id === column).name}`) }));
    let start = { started: false };
    try { start = await startIfAsked(t.id); }
    catch (e) { updateTask(t.id, { attention: `Could not start: ${e?.message ?? e}` }); return { id: t.id, column, started: false, warning: String(e?.message ?? e) }; }
    return { id: t.id, column: task(t.id).column, started: start.started, ...(start.warning ? { warning: start.warning } : {}) };
  },
  // ---- the screen's task ops ----
  async update(req) {
    const t = own(req.id);
    const patch = {};
    for (const k of EDITABLE) if (req.patch && k in req.patch) patch[k] = req.patch[k];
    if ("column" in patch) patch.column = columnOf(patch.column);
    if ("dependsOn" in patch) patch.dependsOn = depIds(t, patch.dependsOn);
    if ("assignee" in patch && patch.assignee) {
      const m = member(patch.assignee, t);
      if (!m) throw new Error(`No member "${patch.assignee}" in this board's team.`);
      patch.assignee = m.id;
      if (t.attention && /^Assign someone/.test(t.attention) && !("attention" in patch)) patch.attention = null;
    }
    updateTask(t.id, patch);
    // Moved into doing by an edit: blocked by its dependencies, it waits.
    if (patch.column === "doing" && blockedBy(task(t.id), tasks).length && !activeRun(task(t.id))) updateTask(t.id, (cur) => ({ ...cur, queued: true }));
    return { id: t.id, ...(blockedBy(task(t.id), tasks).length ? { waiting: depsText(blockedBy(task(t.id), tasks)) } : {}) };
  },
  async remove(req) {
    const t = task(String(req.id ?? ""));
    if (!t) return { id: req.id, gone: true };
    for (const r of t.runs ?? []) if (isLive(r)) killRun(r);
    tasks = tasks.filter((x) => x.id !== t.id);
    dirty = true;
    if (/^k[a-z0-9]+$/.test(t.id)) fs.rmSync(path.join(TASKS_DIR, t.id), { recursive: true, force: true });
    return { id: t.id };
  },
  async start(req) {
    const t = own(req.id);
    if (req.restart) { const r = activeRun(t); if (r) endRun(t.id, r.id, "stopped"); }
    const e = await launch(task(t.id), req.member ?? null);
    const busy = loadWait();
    if (busy) updateTask(t.id, (cur) => ({ ...cur, history: hist(cur, `Started by hand while ${MACHINE ?? os.hostname()} is busy (${loadGate.detail})`) }));
    return { id: t.id, terminal: e.terminal, ...(busy ? { warning: `${MACHINE ?? "This machine"} is busy (${loadGate.detail}).` } : {}) };
  },
  async stop(req) {
    const t = own(req.id);
    endRun(t.id, req.run ?? activeRun(t)?.id, req.how ?? "stopped");
    return { id: t.id };
  },
  async nudge(req) {
    const t = own(req.id);
    const r = activeRun(t);
    const m = member(r?.member, t);
    if (!r || !m) throw new Error("Nobody is on it.");
    const s = await run(HC, ["send", r.terminal, kickoff(m, taskDir(t), resultFile(t, r))]);
    if (s.code !== 0) throw new Error((s.stderr || "hc send failed").trim());
    return { id: t.id };
  },
  async reply(req) {
    const t = own(req.id);
    const r = activeRun(t);
    const text = String(req.text ?? "").trim();
    if (!r || !text) throw new Error("Nobody to answer, or no text.");
    const s = await run(HC, ["send", r.terminal, text]);
    if (s.code !== 0) throw new Error((s.stderr || "hc send failed").trim());
    updateTask(t.id, (cur) => ({ ...cur, attention: null, history: hist(cur, `You: ${text}`) }));
    return { id: t.id };
  },
  // Ends the background terminals of runs that ended; the screen closes their tabs.
  async tidy(req) {
    const t = own(req.id);
    const ids = new Set();
    for (const r of t.runs ?? []) {
      if (!r.ended || r.closed) continue;
      ids.add(r.id);
      if (isLive(r) && !inPane(r)) killRun(r);
    }
    updateTask(t.id, (cur) => ({ ...cur, runs: cur.runs.map((r) => (ids.has(r.id) ? { ...r, tab: null, closed: true } : r)) }));
    return { id: t.id };
  },
  async "remove-worktree"(req) {
    await removeWorktree(own(req.id));
    return { id: req.id };
  },
  // ---- boards ----
  // Makes the board of a folder if needed, and sets its team or settings.
  async "board-set"(req) {
    const b = await boardFor(req);
    let next = { ...b };
    if (req.team !== undefined) next.team = ownTeam(req.team).id;
    if (req.settings) next.settings = { ...DEFAULT_BOARD, ...b.settings, ...req.settings };
    boards = boards.map((x) => (x.id === b.id ? next : x));
    dirty = true;
    if (next.team !== b.team) flagStrangers(b.id);
    return { board: b.id, folder: b.folder, team: teamById(next.team)?.name ?? null, settings: next.settings };
  },
  // Forgets a board that has no tasks (its folder may be gone). Its team stays.
  async "board-remove"(req) {
    const b = await boardFor(req);
    const left = tasks.filter((t) => t.board === b.id).length;
    if (left) throw new Error(`The board still has ${left} task${left === 1 ? "" : "s"}: remove them first.`);
    boards = boards.filter((x) => x.id !== b.id);
    dirty = true;
    return { board: b.id, folder: b.folder, removed: true };
  },
  "set-settings": async (req) => {
    if (!req.settings || typeof req.settings !== "object") throw new Error("set-settings needs settings.");
    settings = { ...settings, ...req.settings };
    dirty = true;
    return { settings };
  },
  // ---- the team library ----
  async "team-create"(req) {
    const name = freeName(String(req.name ?? "").trim() || "Team", teams.map((x) => x.name));
    const t = { id: uid("tm"), name, members: cleanTeam(req.members ?? []) };
    teams = [...teams, t];
    dirty = true;
    return { team: t.id, name };
  },
  async "team-rename"(req) {
    const t = ownTeam(req.team);
    const name = String(req.name ?? "").trim();
    if (!name) throw new Error("A team needs a name.");
    if (teams.some((x) => x.id !== t.id && x.name.toLowerCase() === name.toLowerCase())) throw new Error(`Another team is called ${name}.`);
    teams = teams.map((x) => (x.id === t.id ? { ...x, name } : x));
    dirty = true;
    return { team: t.id, name };
  },
  async "team-duplicate"(req) {
    const t = ownTeam(req.team);
    const name = freeName(String(req.name ?? "").trim() || `${t.name} copy`, teams.map((x) => x.name));
    const copy = { id: uid("tm"), name, members: structuredClone(t.members) };
    teams = [...teams, copy];
    dirty = true;
    return { team: copy.id, name };
  },
  async "team-delete"(req) {
    const t = ownTeam(req.team);
    const using = boards.filter((b) => b.team === t.id);
    if (using.length) throw new Error(`${using.length} board${using.length === 1 ? "" : "s"} use${using.length === 1 ? "s" : ""} ${t.name}: ${using.map((b) => b.folder).join(", ")}. Give them another team first.`);
    teams = teams.filter((x) => x.id !== t.id);
    dirty = true;
    dropSecrets(t.id, t.members, []);
    return { team: t.id };
  },
  async "team-set-members"(req) {
    const t = ownTeam(req.team);
    const members = cleanTeam(req.members);
    dropSecrets(t.id, t.members, members);
    teams = teams.map((x) => (x.id === t.id ? { ...x, members } : x));
    dirty = true;
    for (const b of boards.filter((x) => x.team === t.id)) flagStrangers(b.id);
    return { team: t.id, members: members.length, warnings: await teamCheck(members, false) };
  },
  // A copy of a member into a team: from another team here ({from: {team, member}}),
  // or a value from elsewhere ({member: {...}}). Renamed when the name is taken.
  async "team-copy-member"(req) {
    const t = ownTeam(req.team);
    let src = req.member;
    if (req.from) {
      const ft = ownTeam(req.from.team);
      src = ft.members.find((m) => m.id === req.from.member || m.name.toLowerCase() === String(req.from.member ?? "").toLowerCase());
      if (!src) throw new Error(`No member "${req.from.member}" in ${ft.name}.`);
    }
    if (!src || typeof src !== "object") throw new Error("team-copy-member needs from: {team, member} or member.");
    const copy = cleanMember({ ...structuredClone(src), id: uid("m"), name: freeName(src.name, t.members.map((m) => m.name)) }, new Set(t.members.map((m) => m.id)));
    teams = teams.map((x) => (x.id === t.id ? { ...x, members: [...x.members, copy] } : x));
    dirty = true;
    return { team: t.id, member: copy.id, name: copy.name, warnings: await teamCheck([copy], !req.from) };
  },
  // A team from another machine, by value. Never overwrites: a taken name is renamed.
  async "team-import"(req) {
    const src = req.team;
    if (!src || typeof src !== "object" || !Array.isArray(src.members)) throw new Error("team-import needs team: {name, members}.");
    const name = freeName(String(src.name ?? "").trim() || "Team", teams.map((x) => x.name));
    const members = cleanTeam(structuredClone(src.members));
    const t = { id: uid("tm"), name, members };
    teams = [...teams, t];
    dirty = true;
    return { team: t.id, name, renamed: name !== src.name, warnings: await teamCheck(members) };
  },
  // Moves a board in from elsewhere (the old mod), keeping ids, runs and history.
  // Each task joins the board of its folder's checkout; teams come by value.
  async import(req) {
    const list = Array.isArray(req.tasks) ? req.tasks : [];
    if (Array.isArray(req.teams)) for (const tm of req.teams) if (!teamById(tm.id)) teams = [...teams, { id: tm.id ?? uid("tm"), name: freeName(tm.name ?? "Team", teams.map((x) => x.name)), members: cleanTeam(tm.members ?? []) }];
    const team = req.team ? teamByRef(req.team) : null;
    const placed = [];
    for (const t of list) {
      const folder = clean(t.folder);
      let b = null;
      if (folder && fs.existsSync(folder)) { const co = await checkoutOf(folder); b = ensureBoard(co.top); }
      else if (folder) b = ensureBoard(folder);
      if (b && team && !b.team) boards = boards.map((x) => (x.id === b.id ? { ...x, team: team.id } : x));
      if (b && req.board_settings) boards = boards.map((x) => (x.id === b.id ? { ...x, settings: { ...DEFAULT_BOARD, ...x.settings, ...req.board_settings } } : x));
      placed.push({ ...t, board: b?.id ?? null });
    }
    const ids = new Set(placed.map((t) => t.id));
    tasks = [...tasks.filter((t) => !ids.has(t.id)), ...placed];
    if (req.settings) settings = { ...settings, ...req.settings };
    dirty = true;
    return { tasks: placed.length, boards: [...new Set(placed.map((t) => t.board))].length };
  },
};

// Claims each request (a move into .claimed/, so it is read once), applies it
// and answers in done/ or failed/. Dot files are writes in progress.
async function drain() {
  const box = P("inbox");
  for (const d of ["", ".claimed", "done", "failed"]) fs.mkdirSync(path.join(box, d), { recursive: true });
  for (const f of fs.readdirSync(box)) {
    if (!f.endsWith(".json") || f.startsWith(".")) continue;
    try { fs.renameSync(path.join(box, f), path.join(box, ".claimed", f)); } catch {}
  }
  const claimed = fs.readdirSync(path.join(box, ".claimed")).filter((f) => f.endsWith(".json")).sort();
  for (const name of claimed) {
    const file = path.join(box, ".claimed", name);
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    let req;
    try { req = JSON.parse(text); } catch {
      let age = 99;
      try { age = (Date.now() - fs.statSync(file).mtimeMs) / 1000; } catch {}
      if (age < 10) { try { fs.renameSync(file, path.join(box, name)); } catch {} continue; }
      answer(name, "failed", { ok: false, error: "Not valid JSON.", request: text });
      continue;
    }
    let out;
    try {
      if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("A request is one JSON object.");
      if (req.protocol && req.protocol > PROTOCOL) throw new Error(`This engine speaks protocol ${PROTOCOL}; the request needs ${req.protocol}. The engine updates the next time Herdr connects.`);
      const op = req.op ?? "create";
      if (!OPS[op]) throw new Error(`Unknown op "${op}". Use one of: ${Object.keys(OPS).join(", ")}.`);
      const from = typeof req.from === "string" && req.from.trim() ? req.from.trim() : "an outside agent";
      out = { ok: true, ...(await OPS[op](req, `${MACHINE ?? ""}:${name}:${hash(text)}`, from)) };
    } catch (e) { out = { ok: false, error: String(e?.message ?? e) }; }
    answer(name, out.ok ? "done" : "failed", { ...out, request: req, at: new Date().toISOString() });
    applied = [...applied, name].slice(-200);
    dirty = true;
    if (!out.ok) log("request failed", name, out.error);
  }
  for (const d of ["done", "failed"]) {
    for (const f of fs.readdirSync(path.join(box, d))) {
      const fp = path.join(box, d, f);
      try { if (Date.now() - fs.statSync(fp).mtimeMs > 86400000) fs.unlinkSync(fp); } catch {}
    }
  }
}
function answer(name, box, body) {
  writeAtomic(P("inbox", box, name), JSON.stringify(body, null, 2) + "\n");
  try { fs.unlinkSync(P("inbox", ".claimed", name)); } catch {}
}

// ---- what the screen and the agents read ----

let lastLive = "";
let lastSummary = "";
let summaryAt = 0;
function live() {
  const out = {};
  for (const t of tasks) for (const r of t.runs ?? []) {
    if (!r.terminal || r.terminal in out) continue;
    if (r === activeRun(t) || isLive(r)) out[r.terminal] = { status: runStatus(r), live: isLive(r), pane: inPane(r), reported: term(r.terminal)?.status != null, limit: r.limit ?? null };
  }
  return out;
}
function save() {
  const liveNow = live();
  const liveText = JSON.stringify([liveNow, world.spaceBoards, pins]);
  if (!dirty && liveText === lastLive) return;
  if (dirty) {
    writeAtomic(P("tasks.json"), JSON.stringify(tasks));
    writeAtomic(P("boards.json"), JSON.stringify(boards, null, 2));
    writeAtomic(P("teams.json"), JSON.stringify(teams, null, 2));
    writeAtomic(P("settings.json"), JSON.stringify(settings, null, 2));
  }
  const seq = Date.now();
  writeAtomic(P("state.json"), JSON.stringify({ protocol: PROTOCOL, version: VERSION, machine: MACHINE, home: HOME, secretClient: { node: process.execPath, engine: ENGINE_FILE }, limitGate, loadGate, boardDefaults: DEFAULT_BOARD, seq, tasks, boards, teams, settings, spaces: world.spaceBoards, pins, live: liveNow, events, applied }));
  writeAtomic(P("seq"), String(seq));
  dirty = false;
  lastLive = liveText;
  summary();
}
// board.json: what agents outside the board read (the skill and README.md).
function summary() {
  const memberView = (m, t) => ({ name: m.name, role: m.role, program: m.program, model: m.model || null, tasks_at_once: capacityOf(m), hands_off_to: (m.handoffs ?? []).map((id) => member(id, t)?.name).filter(Boolean) });
  const body = {
    machine: MACHINE ?? os.hostname(), protocol: PROTOCOL, engine: VERSION, inbox: P("inbox"),
    columns: COLUMNS.map((c) => c.id), autopilot: settings.autopilot,
    boards: boards.map((b) => ({ folder: b.folder, team: teamById(b.team)?.name ?? null, pick_up: { ...DEFAULT_BOARD, ...b.settings }.pickup, worktrees: { ...DEFAULT_BOARD, ...b.settings }.worktrees, open: shown({ board: b.id }), members: (teamById(b.team)?.members ?? []).map((m) => memberView(m, b.id)) })),
    teams: teams.map((tm) => ({ name: tm.name, members: tm.members.map((m) => m.name) })),
    // The first team's members, for readers from before boards.
    team: (teams[0]?.members ?? []).map((m) => ({ name: m.name, role: m.role, program: m.program, model: m.model || null })),
    tasks: tasks.map((t) => {
      const r = activeRun(t);
      return {
        id: t.id, title: t.title, board: boardOf(t)?.folder ?? null, team: teamOf(t)?.name ?? null, column: t.column, assignee: member(t.assignee, t)?.name ?? null,
        working: r ? (runStatus(r) ?? "starting") : null, limit: r?.limit ?? null, attention: t.attention ?? null,
        folder: boardOf(t)?.folder ?? t.folder ?? null, worktree: t.worktree ? { path: t.worktree.path, branch: t.worktree.branch } : null,
        task_folder: t.dir ? taskDir(t) : null,
        recent: (t.history ?? []).slice(-2).map((h) => String(h.text).slice(0, 300)),
        depends_on: (t.dependsOn ?? []).map((id) => { const d = task(id); return d ? { id, title: d.title, column: d.column } : null; }).filter(Boolean),
        waits_for: depsText(blockedBy(t, tasks)),
        updated: new Date(t.updated ?? t.created).toISOString(),
      };
    }),
  };
  const stable = JSON.stringify({ ...body, tasks: body.tasks.map((t) => ({ ...t, updated: undefined })) });
  if (stable === lastSummary && Date.now() - summaryAt < 300000) return;
  writeAtomic(P("board.json"), JSON.stringify(body, null, 2) + "\n");
  lastSummary = stable;
  summaryAt = Date.now();
}

// ---- dry run ----

// What an import would do, against the live world, without writing or starting
// anything: per task, its board and team, and whether a pass would start,
// queue, flag or leave it.
async function dryRun(file) {
  const req = readJson(file, null);
  if (!req) throw new Error(`Cannot read ${file}`);
  await look();
  const before = new Map(tasks.map((t) => [t.id, t]));
  await OPS.import(req);
  world.spaceBoards = await mapSpaces();
  const out = [];
  const now = Date.now();
  // What a pass would start, in the order pickUp() takes the tasks.
  const decided = new Map();
  const room = new Map();
  const started = new Set();
  for (const { t, why } of pickPlan()) {
    const m = t.assignee ? member(t.assignee, t) : membersOf(t)[0];
    const key = `${t.board}:${m?.id}`;
    const used = room.get(key) ?? busyCount(t.board, m?.id);
    if (!m) decided.set(t.id, "would flag: no member");
    else if (!shown(t)) decided.set(t.id, `would wait (${why}): no open space shows its board`);
    else if (startGate()) decided.set(t.id, `would wait (${why}): ${startGate()}`);
    else if (started.has(key) || used >= capacityOf(m)) decided.set(t.id, `would wait (${why}): ${m.name} is busy`);
    else { decided.set(t.id, `WOULD START ${m.name} (${why})`); room.set(key, used + 1); started.add(key); }
  }
  for (const t of tasks.filter((x) => !before.has(x.id) || req.tasks?.some((y) => y.id === x.id))) {
    const r = activeRun(t);
    let what = "leave alone";
    if (r) {
      if (r.terminal?.includes("/")) what = `RUN ADDRESS NOT LOCAL (${r.terminal})`;
      else if (isLive(r)) what = `keep running: ${r.terminal} (${runStatus(r)})`;
      else if (now - r.started >= 20000) what = `FLAG: its terminal ${r.terminal} is gone ("ended without writing a result")`;
      else what = `starting: ${r.terminal}`;
    } else if (decided.has(t.id)) {
      what = decided.get(t.id);
    } else if (t.column === "doing" && t.assignee && !t.queued && !t.attention) {
      what = `waits for the person: in progress with ${member(t.assignee, t)?.name ?? "?"} and no run (press Start)`;
    } else if (t.assignee && !member(t.assignee, t)) what = "FLAG: assignee not in the board's team";
    out.push({ id: t.id, title: t.title.slice(0, 60), column: t.column, board: boardOf(t)?.folder ?? null, team: teamOf(t)?.name ?? null, shown: shown(t), queued: Boolean(t.queued), attention: t.attention ? t.attention.slice(0, 80) : null, what });
  }
  return { autopilot: settings.autopilot, boards: boards.map((b) => ({ folder: b.folder, team: teamById(b.team)?.name, settings: b.settings })), tasks: out };
}

// ---- the loop ----

let busy = false;
let again = false;
async function pass() {
  if (busy) { again = true; return; }
  busy = true;
  try {
    do {
      again = false;
      await look();
      await drain();
      await checkLoad(); // before results: a hand-off start must see a closed gate
      await results();
      reconcile();
      await limits();
      updateLimitGate();
      gateWaits();
      heavyWaits();
      alert();
      await stalls();
      await closeBrowsers();
      setups();
      await rootBranches();
      strandedHandoffs();
      depsWatch();
      await pickUp();
      pullRequests().then(() => { if (dirty) save(); }).catch((e) => log("prs:", e?.message ?? String(e)));
      closeIdle();
      save();
    } while (again);
  } catch (e) {
    log("pass:", e?.stack ?? String(e));
  }
  busy = false;
}

// What the space pins change, against the live world, without writing anything:
// per space, its board without pins and with them. --move <space>=<folder>
// pretends that space's first terminal is in that folder now.
async function drySpaces() {
  await look();
  if (typeof args.move === "string") {
    const [sid, folder] = args.move.split("=");
    const s = spaceById(sid);
    if (!s) throw new Error(`No space ${sid}`);
    world.spaces = world.spaces.map((x) => (x === s ? { ...x, tabs: [{ id: "moved", terminals: ["moved"] }, ...x.tabs] } : x));
    world.terminals = [...world.terminals, { address: "moved", state: "live", cwd: folder, labels: {} }];
    world.spaceBoards = await mapSpaces();
  }
  const kept = pins;
  pins = {};
  const before = await mapSpaces();
  pins = kept;
  const shownBy = (m) => [...new Set(Object.values(m).filter((v) => !v.taskWorktree).map((v) => v.board))].sort();
  return {
    spaces: world.spaces.map((s) => ({ space: s.id, name: s.name, before: before[s.id] ?? null, after: world.spaceBoards[s.id] ?? null, pin: pins[s.id] ?? null })),
    shownBefore: shownBy(before), shownAfter: shownBy(world.spaceBoards),
    tasksWhoseBoardShowChanges: tasks.filter((t) => shownBy(before).includes(t.board) !== shownBy(world.spaceBoards).includes(t.board)).map((t) => `${t.id} ${t.column} ${t.title}`),
  };
}

async function main() {
  if (args["dry-spaces"]) {
    load();
    try { console.log(JSON.stringify(await drySpaces(), null, 2)); }
    catch (e) { console.error(e.message); process.exitCode = 1; }
    core.p?.kill?.();
    process.exit();
  }
  if (DRY) {
    load();
    try { console.log(JSON.stringify(await dryRun(String(args["dry-run"])), null, 2)); }
    catch (e) { console.error(e.message); process.exitCode = 1; }
    core.p?.kill?.();
    process.exit();
  }
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  if (!lock()) { log("another engine runs on", HOME); process.exit(0); }
  serveSecrets();
  load();
  if (!fs.existsSync(P("settings.json"))) dirty = true;
  log("engine", VERSION, "protocol", PROTOCOL, "on", HOME, "hc", HC, "shell", SHELL, "node", process.version);
  fs.mkdirSync(P("inbox"), { recursive: true });
  // A request or a result makes a pass at once; the timer catches the rest.
  let soon = null;
  const kick = () => { clearTimeout(soon); soon = setTimeout(pass, 150); };
  try { fs.watch(P("inbox"), kick); } catch {}
  try { fs.watch(TASKS_DIR, { recursive: true }, (_e, f) => { if (f && /result\.[^/]*\.json$/.test(f)) kick(); }); } catch {}
  await pass();
  if (args.once) process.exit(0);
  setInterval(pass, PASS_MS);
}

// Run as a program, not when a test imports it. Both sides resolve links, as
// node does for import.meta.url.
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) (args.secret ? secretClient() : main());

