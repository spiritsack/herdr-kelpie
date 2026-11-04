// The board screen's data: a client of the board engines. Each machine runs an
// engine (engine/engine.mjs, a launchd service) that keeps that machine's
// boards, team library and tasks, starts the agents and hands tasks on. This
// mod reads each engine's state.json and sends every change to its inbox/ as a
// request. It also installs and updates the engines (see engine.js here).
//
// Ids: inside an engine everything is local to its machine (t7, sp…). In the
// app, another machine's terminals and spaces are "<machine>/t7". qual() and
// local() are the one place that maps between the two.

import { shared, setShared, spaces as spacesNow, panes as panesNow, machines, exec, appHome, readTextFile, knownAgents, notify, run, focused, window, playSound } from "herdr";
import * as fs from "fs/promises";

export const MOD = "board";
export const PROTOCOL = 2;

// ---- one pass, one read of each list ----

let pass = null;
// fn runs with every live list read once. ctx: the board or team the view
// shows ({ machine, board } or { machine, team }), for team() and member().
export function within(fn, stored = false, ctx = null) {
  if (pass) return fn();
  pass = { stored, ctx };
  try { return fn(); } finally { pass = null; }
}
const once = (key, read) => (pass ? (pass[key] ??= read()) : read());
export const spaces = () => once("spaces", spacesNow);
export const panes = () => once("panes", panesNow);

export const COLUMNS = [
  { id: "backlog", name: "Backlog" },
  { id: "todo", name: "To do" },
  { id: "doing", name: "In progress" },
  { id: "review", name: "Review" },
  { id: "done", name: "Done" },
];
export const column = (id) => COLUMNS.find((c) => c.id === id) ?? COLUMNS[0];
export const PALETTE = ["ansi4", "ansi2", "ansi5", "ansi3", "ansi6", "ansi1", "ansi12", "ansi10"];
export const DEFAULT_TEAM = [];

export const uid = (prefix) => prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
export function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

// ---- ids between the app and an engine ----

const keyOf = (machine) => machine ?? "";
export const qual = (machine, id) => (id == null || !machine || String(id).includes("/") ? id : `${machine}/${id}`);
export const local = (id) => (id == null ? id : String(id).includes("/") ? String(id).split("/").slice(1).join("/") : id);
export const machineOf = (id) => (id && String(id).includes("/") ? String(id).split("/")[0] : null);

// ---- where the engines live ----

// The launchd service that runs the engine on each machine.
export const LABEL = "dev.herdr.board";
const homes = {};
// The board home on a machine: this one's is in the app home.
export async function homeOn(machine) {
  const k = keyOf(machine);
  if (homes[k]) return homes[k];
  if (!machine) return (homes[k] = `${appHome()}/board`);
  const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: machine });
  if (r.code !== 0 || !r.stdout.trim()) throw new Error(`Could not find the home folder on ${machine}.`);
  return (homes[k] = `${r.stdout.trim()}/.herdr/board`);
}
export const homeNow = (machine) => homes[keyOf(machine)] ?? null;

// Machines with a board: this one, and every other one whose layout is ready.
export const served = () => [null, ...machines().filter((m) => m.name && !m.temporary && m.layout === "ready").map((m) => m.name)];

// ---- engine state, as the poller copies it into shared state ----

const KEY_SEQS = "boardx.seqs";      // { "<machine>": seq, "": this one's }: tiny, so a change redraws cheaply
const KEY_PENDING = "boardx.pending"; // requests not yet applied: [{ name, machine, at, kind, ... }]
const KEY_SEEN = "boardx.seen";       // the newest event shown per machine

// Engine states live in each view's memory, not in shared state: a shared value
// is copied whole on every read and every change redraws every mod, and the
// states are hundreds of KB. Shared state carries only each machine's seq; a view
// reads the state file again when its seq moved (this Mac: the engine's own
// state.json; another machine: the copy the poller keeps in board/cache/).
const mem = {}; // "<machine>" -> { seq, st }
const cacheFile = (k) => `${appHome()}/board/cache/${k}.json`;
const stateFile = async (k) => (k ? cacheFile(k) : `${await homeOn(null)}/state.json`);
// Loads what changed; true when something did (the caller redraws).
export async function loadStates() {
  const seqs = shared(KEY_SEQS) ?? {};
  let changed = false;
  for (const [k, seq] of Object.entries(seqs)) {
    if (mem[k]?.seq === seq) continue;
    try { mem[k] = { seq, st: JSON.parse(await readTextFile(await stateFile(k))) }; changed = true; } catch {}
  }
  return changed;
}
// Whether this view has read the engine states at least once.
export const statesReady = () => Object.keys(mem).length > 0;
const states = () => once("states", () => Object.fromEntries(Object.entries(mem).map(([k, v]) => [k, v.st])));
export const stateOf = (machine) => states()[keyOf(machine)] ?? null;
// Machines whose engine is too old for this screen: no writes go there.
export const outdated = (machine) => { const s = stateOf(machine); return Boolean(s) && (s.protocol ?? 1) < PROTOCOL; };

// A machine's tasks, as the app sees them: ids qualified, machine set. Mapped
// once per pass (tasks() is read once per render).
function tasksOn(machine) {
  const st = stateOf(machine);
  if (!st) return [];
  return (st.tasks ?? []).map((t) => ({
    ...t, machine,
    space: qual(machine, t.space),
    runs: (t.runs ?? []).map((r) => ({ ...r, terminal: qual(machine, r.terminal), space: qual(machine, r.space), tab: qual(machine, r.tab) })),
  }));
}

// Changes sent but not yet in a snapshot, applied on top so the screen moves at once.
function overlay(list) {
  const pend = shared(KEY_PENDING) ?? [];
  if (!pend.length) return list;
  let out = list;
  for (const p of pend) {
    const applied = stateOf(p.machine)?.applied ?? [];
    if (applied.includes(p.name) || Date.now() - p.at > 30000) continue;
    if (p.kind === "patch") out = out.map((t) => (t.id === p.id ? { ...t, ...p.patch } : t));
    else if (p.kind === "remove") out = out.filter((t) => t.id !== p.id);
    else if (p.kind === "create" && !out.some((t) => t.id === p.task.id)) out = [...out, { ...p.task, machine: p.machine }];
  }
  return out;
}

export const tasks = () => once("tasks", () => overlay(served().flatMap(tasksOn)));
export const task = (id) => tasks().find((t) => t.id === id) ?? null;

// ---- boards and teams ----

// The board a space shows: { machine, board (record or a new one's id), folder,
// taskWorktree } from its machine's engine; null before the engine answered.
export function boardOfSpace(space) {
  if (!space) return null;
  const machine = space.machine ?? null;
  const st = stateOf(machine);
  const v = st?.spaces?.[local(space.id)];
  if (!v) return null;
  const rec = (st.boards ?? []).find((b) => b.id === v.board) ?? null;
  return { machine, id: v.board, folder: v.folder, record: rec, taskWorktree: Boolean(v.taskWorktree), task: v.task ?? null };
}
export const boardById = (machine, id) => (stateOf(machine)?.boards ?? []).find((b) => b.id === id) ?? null;
export const teamsOf = (machine) => stateOf(machine)?.teams ?? [];
export const teamById = (machine, id) => teamsOf(machine).find((t) => t.id === id) ?? null;
// The team of a board; a board the engine has not made yet gets its first team.
export const teamOfBoard = (machine, boardId) => teamById(machine, boardById(machine, boardId)?.team) ?? (boardById(machine, boardId) ? null : teamsOf(machine)[0] ?? null);

// The team the view in this pass shows.
function ctxTeam(ctx = pass?.ctx) {
  if (!ctx) return null;
  if (ctx.team) return teamById(ctx.machine, ctx.team);
  if (ctx.board) return teamOfBoard(ctx.machine, ctx.board);
  return null;
}
export const team = (ctx) => ctxTeam(ctx)?.members ?? [];
export const member = (ref, ctx) => {
  if (!ref) return null;
  const key = String(ref).trim().toLowerCase();
  return team(ctx).find((m) => m.id === key || m.name.toLowerCase() === key || `${m.name} (${m.role})`.toLowerCase() === key) ?? null;
};
export const capacityOf = (m) => Math.max(1, Math.floor(Number(m?.capacity) || 1));
// The tasks a member works on now, on the board of `t` (room counts per board).
export const busyOn = (id, t) => tasks().filter((x) => (x.machine ?? null) === (t.machine ?? null) && x.board === t.board && activeRun(x)?.member === id);
export const ctxOfTask = (t) => (t ? { machine: t.machine ?? null, board: t.board } : null);

// The tasks a space's board shows.
export function tasksOf(space) {
  const b = boardOfSpace(space);
  if (!b || b.taskWorktree) return [];
  return tasks().filter((t) => (t.machine ?? null) === b.machine && t.board === b.id);
}

// Settings for a board's menu: the machine's (autopilot, tabs) and the board's own.
export function boardSettings(space) {
  const b = boardOfSpace(space);
  const st = stateOf(b?.machine ?? space?.machine ?? null);
  return { autopilot: true, openTabs: false, ...(st?.settings ?? {}), pickup: false, worktrees: true, ...(b?.record?.settings ?? {}) };
}
export function setBoardSettings(space, patch) {
  const b = boardOfSpace(space);
  if (!b) return Promise.reject(new Error("The board's engine has not answered yet."));
  const machineLevel = {};
  const boardLevel = {};
  for (const [k, v] of Object.entries(patch)) (["autopilot", "openTabs", "maxRuns", "heavySlots", "niceness"].includes(k) ? machineLevel : boardLevel)[k] = v;
  const out = [];
  if (Object.keys(machineLevel).length) out.push(request(b.machine, { op: "set-settings", settings: machineLevel }));
  if (Object.keys(boardLevel).length) out.push(request(b.machine, { op: "board-set", folder: b.folder, settings: boardLevel }));
  return Promise.all(out);
}
export const setBoardTeam = (space, teamId) => {
  const b = boardOfSpace(space);
  return request(b.machine, { op: "board-set", folder: b.folder, team: teamId });
};

// ---- requests ----

// Sends one request to a machine's engine. Resolves with its answer (done/ or
// failed/, read back for up to `wait` ms), rejects with a failure's error.
// `pend` puts the change on screen at once.
export function request(machine, body, { pend = null, wait = 20000 } = {}) {
  if (outdated(machine)) return Promise.reject(new Error(`Updating the board engine on ${machine ?? "this Mac"}: try again in a moment.`));
  const name = `${uid("s")}.json`;
  // On screen at once, before anything is sent.
  if (pend) setShared(KEY_PENDING, [...(shared(KEY_PENDING) ?? []).filter((p) => Date.now() - p.at < 30000), { name, machine, at: Date.now(), ...pend }]);
  return send(machine, name, body, wait);
}
async function send(machine, name, body, wait) {
  const home = await homeOn(machine);
  const text = JSON.stringify({ protocol: PROTOCOL, from: "the board", ...body });
  const w = await exec("sh", ["-c", 'mkdir -p "$1/inbox" && printf "%s" "$3" > "$1/inbox/.$2.tmp" && mv -f "$1/inbox/.$2.tmp" "$1/inbox/$2"', "sh", home, name, text], { on: machine });
  if (w.code !== 0) throw new Error(`Could not reach the board engine on ${machine ?? "this Mac"}: ${(w.stderr || w.stdout).trim()}`);
  for (const end = Date.now() + wait; Date.now() < end;) {
    await exec("sleep", ["0.25"]);
    for (const box of ["done", "failed"]) {
      let got = null;
      try { got = await readTextFile(`${home}/inbox/${box}/${name}`, { on: machine }); } catch {}
      if (!got) continue;
      let ans = {};
      try { ans = JSON.parse(got); } catch {}
      if (box === "failed") throw new Error(ans.error ?? "The engine refused it.");
      return ans;
    }
  }
  throw new Error(`The board engine on ${machine ?? "this Mac"} did not answer. Is it running? (launchctl print gui/$UID/${LABEL})`);
}

// ---- task changes ----

const taskMachine = (id) => task(id)?.machine ?? null;
export function updateTask(id, patch) {
  const t = task(id);
  if (!t) return Promise.resolve();
  const p = typeof patch === "function" ? patch(t) : patch;
  const clean = {};
  for (const k of ["title", "description", "assignee", "column", "attention", "autopilot", "attachments", "queued", "dependsOn"]) if (k in p) clean[k] = p[k];
  return request(t.machine ?? null, { op: "update", id, patch: clean }, { pend: { kind: "patch", id, patch: clean } });
}
// A new task on the board of `space`. Returns its id at once.
export function newTask(fields, space) {
  const machine = space?.machine ?? null;
  const id = fields.id ?? uid("k");
  const b = boardOfSpace(space);
  const t = { id, title: fields.title, description: fields.description ?? "", column: fields.column ?? "todo", assignee: fields.assignee ?? null, attachments: fields.attachments ?? [], dependsOn: fields.dependsOn ?? [] };
  const req = request(machine, { op: "create", ...t, space: local(space?.id), folder: b?.folder ?? null },
    { pend: { kind: "create", task: { ...t, board: b?.id, space: space?.id ?? null, runs: [], history: [], created: Date.now(), updated: Date.now() } } });
  return { id, done: req };
}
export const removeTask = (id) => request(taskMachine(id), { op: "remove", id }, { pend: { kind: "remove", id } });
export const removeTaskDir = () => {};
export const launch = (t, memberId) => request(t.machine ?? null, { op: "start", id: t.id, ...(memberId ? { member: memberId } : {}) });
export const restart = (t, memberId) => request(t.machine ?? null, { op: "start", id: t.id, restart: true, ...(memberId ? { member: memberId } : {}) });
export const endRun = (taskId, runId, how) => request(taskMachine(taskId), { op: "stop", id: taskId, run: runId, how });
export const nudge = (t) => request(t.machine ?? null, { op: "nudge", id: t.id });
export const reply = (t, text) => request(t.machine ?? null, { op: "reply", id: t.id, text });
export const removeWorktree = (t) => request(t.machine ?? null, { op: "remove-worktree", id: t.id });

// Closes the tabs of runs that ended; the engine ends their background terminals.
export function tidy(t) {
  for (const r of t.runs ?? []) {
    if (!leftOver(r)) continue;
    const pane = paneOf(r);
    if (pane || r.tab) run("tab.close", { id: pane?.tab ?? r.tab, confirmed: true });
  }
  return request(t.machine ?? null, { op: "tidy", id: t.id });
}

// ---- team library ----

export const setTeamMembers = (machine, teamId, members) => request(machine, { op: "team-set-members", team: teamId, members });
export const teamOp = (machine, body) => request(machine, body);
// A team copied to another machine: read here, imported there by value.
export async function copyTeam(fromMachine, teamId, toMachine) {
  const t = teamById(fromMachine, teamId);
  if (!t) throw new Error("No such team.");
  return request(toMachine, { op: "team-import", team: { name: t.name, members: t.members } });
}

// ---- secrets ----
//
// Names live on the member (secrets: ["GITHUB_TOKEN"]); values only in the
// Keychain of the team's machine, set through that machine's engine. A value
// goes to the engine on standard input, never into a file or shared state.
export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const secretAccount = (teamId, memberId, name) => `${teamId}/${memberId}/${name}`;
function secretClient(machine) {
  const st = stateOf(machine);
  const c = st?.secretClient;
  if (!c?.node || !c?.engine || !st?.home) throw new Error("The board engine there does not support secrets yet: it updates within a minute.");
  return { ...c, home: st.home };
}
// { account: true | false }: whether a value is set (the value never comes back).
export async function secretStatus(machine, accounts) {
  if (!accounts.length) return {};
  const c = secretClient(machine);
  const r = await exec(c.node, [c.engine, "--home", c.home, "--secret", "status", ...accounts], { on: machine });
  if (r.code !== 0) throw new Error((r.stderr || "The engine did not answer.").trim());
  return JSON.parse(r.stdout).set ?? {};
}
export async function secretSet(machine, account, value) {
  if (!value) throw new Error("Paste the value first.");
  if (/[\r\n]/.test(value)) throw new Error("A secret must be one line.");
  const c = secretClient(machine);
  const pipe = machine
    ? 'printf "%s" "$1" | hc exec -i --on "$6" "$2" "$3" --home "$4" --secret set "$5"'
    : 'printf "%s" "$1" | "$2" "$3" --home "$4" --secret set "$5"';
  const r = await exec("sh", ["-c", pipe, "sh", value, c.node, c.engine, c.home, account, machine ?? ""]);
  if (r.code !== 0) throw new Error((r.stderr || "The engine did not answer.").trim().replace(/^herdr board: /, ""));
}

// ---- unblocking a task with an agent session ----

// Writes UNBLOCK.md into the task's folder on its machine (why it needs the
// person, the waiting question, the description, the team, the whole history,
// its notes, how to act on the board) and opens a tab in the task's space with
// an agent that reads it first and works it out with the person.
export async function unblockInTab(t) {
  const machine = t.machine ?? null;
  const space = spacesNow().find((s) => s.id === t.space) ?? null;
  if (!space && !t.worktree?.path) throw new Error("Open the task's space first: the session starts there.");
  const dir = taskDir(t);
  if (!dir) throw new Error("The task has no folder yet.");
  const home = homeNow(machine) ?? (await homeOn(machine));
  const ctx = ctxOfTask(t);
  const mates = team(ctx);
  const nameOf = (id) => member(id, ctx)?.name ?? id ?? "nobody";
  const runs = t.runs ?? [];
  const r = activeRun(t);
  const last = runs[runs.length - 1] ?? null;
  const live = r && isLive(r);
  const when = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "?");
  const b = boardById(machine, t.board);
  let files = [];
  try {
    const ls = await exec("sh", ["-c", 'cd "$1" 2>/dev/null && ls -1p | grep -v / | grep -v -E "^(result\\.|brief\\.md$|UNBLOCK\\.md$|setup\\.log$)"', "sh", dir], { on: machine });
    files = ls.stdout.split("\n").map((x) => x.trim()).filter(Boolean);
  } catch {}
  const L = [];
  L.push(`# Unblock: ${t.title}`, "");
  L.push("The person opened this session from the Herdr board, because this task needs them. Help them understand what is going on and decide. Do not change the board or the code until they agree; then act through the board as shown below.", "");
  L.push("## Why it needs the person", "");
  L.push(t.attention ? `Board note: ${t.attention}` : "There is no board note.");
  if (r?.blocked && !r.blockAnswered) L.push("", `The agent's question (${nameOf(r.member)}, waiting in its terminal):`, "", "> " + String(r.blocked).split("\n").join("\n> "));
  else if (r?.stall) L.push("", `Stall: ${r.stall}`);
  if (r?.limit) L.push("", `Usage limit: until ${r.limit.until ?? "unknown"}.`);
  L.push("");
  L.push("## The task", "");
  L.push(`- Id: ${t.id}, column: ${t.column}, assignee: ${nameOf(t.assignee)}`);
  L.push(`- Board folder (the repository): ${b?.folder ?? t.folder ?? "?"}${machine ? ` on ${machine}` : ""}`);
  if (t.worktree?.path) L.push(`- Its own worktree: ${t.worktree.path} (branch ${t.worktree.branch})`);
  L.push(`- Task folder (briefs, notes, results): ${dir}`, "");
  L.push((t.description || "(no description)").trim(), "");
  L.push("## The team", "");
  for (const m of mates) L.push(`- ${m.name}, ${m.role}${(m.handoffs ?? []).length ? ` (hands off to ${(m.handoffs ?? []).map(nameOf).join(", ")})` : ""}`);
  L.push("");
  L.push("## Runs", "");
  for (const x of runs) L.push(`- ${when(x.started)} ${nameOf(x.member)} in terminal ${local(x.terminal) ?? "?"}: ${x.result ? `${x.result.action}${x.result.to ? ` → ${nameOf(x.result.to)}` : ""}` : x.ended ? `ended (${x.exit ?? "?"})` : "running"}${x.blocked ? " [asked the person]" : ""}`);
  L.push("");
  L.push("## History (oldest first; hand-off summaries say what each member did and wants)", "");
  for (const h of t.history ?? []) L.push(`- ${when(h.at)} ${String(h.text).replace(/\n+/g, " ")}`);
  L.push("");
  L.push("## Read these too", "");
  if (files.length) for (const f of files) L.push(`- ${dir}/${f}`);
  else L.push("- (no notes in the task folder)");
  L.push(`- The last brief the agents got: ${dir}/brief.md`);
  if (last?.terminal) L.push(`- ${live ? "The waiting" : "The last"} agent's screen and history: \`hc read ${local(last.terminal)} --lines 300\`${live ? " (it is still running)" : ""}`);
  L.push("");
  L.push("## Acting on the board (only after the person agrees)", "");
  L.push(`Write one JSON request per action into ${home}/inbox/: write a dot-named temp file there, then rename it to \`<unique name>.json\`. The answer appears in inbox/done/ or inbox/failed/ within seconds. The full guide is ${home}/README.md.`, "");
  if (live) L.push(`- Answer the waiting agent: \`{"op": "reply", "id": "${t.id}", "text": "<the person's answer>"}\` (it types the answer into its terminal and clears the note).`);
  L.push(`- Let a member go on (also after a loop or a stopped run): \`{"op": "start", "id": "${t.id}", "member": "<name>"}\`. Add \`"restart": true\` to end a run that is still going.`);
  L.push(`- Leave a decision for the next member: \`{"op": "note", "id": "${t.id}", "text": "<decision>"}\`, or change the description: \`{"op": "update", "id": "${t.id}", "description": "<markdown>"}\`.`);
  L.push(`- Move the task: \`{"op": "move", "id": "${t.id}", "column": "backlog|todo|doing|review|done"}\`.`);
  L.push("", "Start by summarising in a few lines what happened and what exactly is needed, then ask the person.");
  const w = await exec("sh", ["-c", 'printf "%s" "$2" > "$1/.UNBLOCK.md.tmp" && mv -f "$1/.UNBLOCK.md.tmp" "$1/UNBLOCK.md"', "sh", dir, L.join("\n") + "\n"], { on: machine });
  if (w.code !== 0) throw new Error(`Could not write UNBLOCK.md: ${(w.stderr || "").trim()}`);
  const first = `Read ${dir}/UNBLOCK.md and the files it lists, then help me unblock the board task "${t.title}". Summarise what happened and what is needed, and ask me before you change anything.`;
  const claude = ["claude", "--add-dir", dir, "--", first];
  // On another machine, tab.new starts the program from a plain sh whose PATH
  // lacks the login shell's (Homebrew, nvm): run it in the login shell, which
  // stays open after it, as Herdr does here.
  const argv = machine
    ? ["sh", "-c", 's=${SHELL:-/bin/zsh}; "$s" -lic \'"$@"\' "$s" "$@"; exec "$s" -li', "sh", ...claude]
    : claude;
  const name = `Unblock: ${t.title}`.slice(0, 40);
  // A task with its own worktree: the session goes to that worktree's space
  // (made now if none is open), so the board's space keeps only the board.
  if (t.worktree?.path) {
    const own = taskSpaceOf(t);
    if (own) { run("space.select", { id: own.id }); run("tab.new", { name, space: own.id, folder: t.worktree.path, argv }); }
    else run("space.new", { machine: machine ?? "", folder: t.worktree.path, tab: name, argv });
    return;
  }
  run("tab.new", { name, space: space.id, argv });
}

// The open space of a task's own worktree (the engine maps it), else null.
export function taskSpaceOf(t) {
  const machine = t?.machine ?? null;
  const map = stateOf(machine)?.spaces ?? {};
  const id = Object.keys(map).find((k) => map[k].taskWorktree && map[k].task === t.id);
  return id ? spacesNow().find((s) => s.id === qual(machine, id)) ?? null : null;
}

// ---- dependencies (the engine enforces them; the screen shows them) ----

// The other tasks on the board of `t` (same machine, same board).
export const boardMates = (t) => tasks().filter((x) => x.id !== t?.id && (x.machine ?? null) === (t?.machine ?? null) && x.board === t?.board);
export const DEP_DONE = new Set(["review", "done"]);
// The dependencies of `t` that are not in Review or Done yet (gone ones count as done).
export const depsOpen = (t) => (t?.dependsOn ?? []).map((id) => tasks().find((x) => x.id === id && (x.machine ?? null) === (t.machine ?? null))).filter((d) => d && !DEP_DONE.has(d.column));
export function depsLine(t) {
  const open = depsOpen(t);
  if (!open.length) return null;
  const col = (c) => column(c).name;
  if (open.length === 1) return `Waits for "${open[0].title}" (${col(open[0].column)})`;
  return `Waits for ${open.length} tasks: ${open.map((d) => `"${d.title}" (${col(d.column)})`).join(", ")}`;
}
// Would depending on `depId` make a loop for task `id`?
export function depLoops(id, depId) {
  const seen = new Set();
  const stack = [depId];
  while (stack.length) {
    const d = stack.pop();
    if (d === id) return true;
    if (seen.has(d)) continue;
    seen.add(d);
    stack.push(...(tasks().find((x) => x.id === d)?.dependsOn ?? []));
  }
  return false;
}

// ---- live state of runs ----

const liveOf = (r) => (r?.terminal ? stateOf(machineOf(r.terminal))?.live?.[local(r.terminal)] ?? null : null);
export const activeRun = (t) => [...(t?.runs ?? [])].reverse().find((r) => !r.ended && !r.result) ?? null;
export function runStatus(r) {
  const l = liveOf(r);
  return l?.live ? (l.status ?? "idle") : null;
}
export const isLive = (r) => Boolean(liveOf(r)?.live);
// A run at a usage limit: { until, auto }, or null.
export const runLimit = (r) => liveOf(r)?.limit ?? null;
export const paneOf = (r) => (r?.terminal && panes().find((p) => p.terminal === r.terminal)) || null;
export const leftOver = (r) => Boolean(r.ended) && !r.closed && Boolean(paneOf(r) || r.tab || isLive(r));
export function liveStatus(t) {
  const r = activeRun(t);
  return r ? runStatus(r) : null;
}

// ---- folders ----

export const taskDir = (t) => t?.dir ?? (homeNow(t?.machine ?? null) ? `${homeNow(t?.machine ?? null)}/tasks/${t?.id}` : null);
export const where = (t) => (t?.machine ? `${t.machine}:${taskDir(t) ?? ""}` : taskDir(t) ?? "");
export const ROOT = () => `${homeNow(null) ?? `${appHome()}/board`}/tasks`;
export function place(s) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

// Goes to the run's terminal: its pane, else a tab for it now. A run of a task
// with its own worktree gets its tab in that worktree's space (a new one if
// none is open): Herdr shows a terminal where its space and tab labels say.
export function goTo(r, name, t = null) {
  if (!r) return;
  const pane = paneOf(r);
  if (pane) {
    const s = spaces().find((x) => x.tabs.some((c) => c.id === pane.tab));
    if (s) run("space.select", { id: s.id });
    run("tab.select", { id: pane.tab });
    run("pane.focus", { terminal: r.terminal });
    return;
  }
  if (isLive(r) && t?.worktree?.path) {
    const machine = t.machine ?? null;
    const own = taskSpaceOf(t);
    const sp = own ? local(own.id) : uid("sp");
    const tb = uid("tb");
    (async () => {
      // hc here takes "<machine>/t7" (a remote shell's PATH may lack hc); label ids are that machine's.
      const x = await exec("hc", ["label", r.terminal, `herdr.space=${sp}`, `herdr.tab=${tb}`]);
      if (x.code !== 0) throw new Error((x.stderr || x.stdout || "hc label failed").trim());
      // Herdr shows the labeled terminal on its next look: wait for its tab.
      const shown = () => spacesNow().some((s) => s.id === qual(machine, sp) && s.tabs.some((c) => c.id === qual(machine, tb)));
      for (let i = 0; i < 40 && !shown(); i++) await exec("sleep", ["0.25"]);
      if (!shown()) throw new Error("Herdr did not show the run's terminal yet. It appears in the sidebar when it does.");
      run("space.select", { id: qual(machine, sp) });
      run("tab.select", { id: qual(machine, tb) });
      if (name) run("tab.rename", { id: qual(machine, tb), name });
    })().catch((e) => notify({ title: "Could not open the run in its worktree's space", body: String(e?.message ?? e).slice(0, 200), level: "error", timeout: 8000 }));
    return;
  }
  if (isLive(r)) {
    if (r.space && spaces().some((s) => s.id === r.space)) run("space.select", { id: r.space });
    exec("herdr-app", ["do", "terminal.keep", "--terminal", r.terminal]).then((x) => {
      let out;
      try { out = JSON.parse(x.stdout.trim()); } catch { throw new Error((x.stderr || x.stdout || "herdr-app did not answer").trim()); }
      if (out?.error) throw new Error(out.error);
      if (out?.tab && name) run("tab.rename", { id: out.tab, name });
    }).catch((e) => notify({ title: "Could not open the run as a tab", body: String(e?.message ?? e).slice(0, 200), level: "error", timeout: 8000 }));
    return;
  }
  if (r.space) run("space.select", { id: r.space });
  if (r.tab) run("tab.select", { id: r.tab });
}

// ---- attachments ----
// A task's files live in <board home>/tasks/<id>/files/ on its machine.

export const attachments = (t) => t?.attachments ?? [];
export const isImage = (name) => /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name ?? "");
export const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
export const filesDir = (machine, id) => `${homeNow(machine)}/tasks/${id}/files`;
export const fileOf = (t, a) => `${filesDir(t.machine ?? null, t.id)}/${a.name}`;

function freeName(name, taken) {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  let n = name;
  for (let i = 2; taken.has(n); i++) n = `${stem}-${i}${ext}`;
  return n;
}
async function sshHost(machine) {
  try {
    const out = JSON.parse((await exec("hc", ["machine", "ls", "--json"])).stdout);
    return out.machines?.find((x) => x.name === machine)?.target ?? machine;
  } catch { return machine; }
}
// Copies files from this Mac into a task's folder on its machine. Returns the new entries.
export async function copyIn(machine, id, srcPaths, taken) {
  await homeOn(machine);
  const dir = filesDir(machine, id);
  const out = [];
  for (const src of srcPaths) {
    const base = src.replace(/[\/\\]+$/, "").split(/[\/\\]/).pop();
    if ((await exec("test", ["-d", src])).code === 0) throw new Error(`Folders cannot be attached: ${base}`);
    const name = freeName(base, taken);
    taken.add(name);
    const r = machine
      ? await exec("sh", ["-c", 'h="$1"; d="$2"; ssh -o BatchMode=yes "$h" mkdir -p "$d" && scp -q -o BatchMode=yes "$3" "$h:$d/$4"', "sh", await sshHost(machine), dir, src, name])
      : await exec("sh", ["-c", 'mkdir -p "$1" && cp "$2" "$1/$3"', "sh", dir, src, name]);
    if (r.code !== 0) throw new Error((r.stderr || `Could not copy ${base}`).trim());
    const size = parseInt((await exec("wc", ["-c", src])).stdout, 10) || 0;
    out.push({ name, size, added: Date.now() });
  }
  return out;
}
export async function attach(taskId, srcPaths) {
  const t = task(taskId);
  const entries = await copyIn(t.machine ?? null, taskId, srcPaths, new Set(attachments(t).map((a) => a.name)));
  await updateTask(taskId, { attachments: [...attachments(task(taskId)), ...entries] });
  return entries;
}
export async function detach(taskId, name) {
  const t = task(taskId);
  await updateTask(taskId, { attachments: attachments(t).filter((a) => a.name !== name) });
  exec("rm", ["-f", `${filesDir(t.machine ?? null, taskId)}/${name}`], { on: t.machine ?? null }).catch(() => {});
}

export async function pickFiles() {
  if (window().platform !== "macos") return null;
  const out = `${appHome()}/board/.pick-${uid("p")}`;
  const script = [
    'tell application "System Events" to activate',
    'set fs to choose file with prompt "Attach files" with multiple selections allowed',
    'set out to ""',
    "repeat with f in fs",
    "set out to out & POSIX path of f & linefeed",
    "end repeat",
    "return out",
  ].flatMap((l) => ["-e", l]);
  await exec("sh", ["-c", 'o="$1"; shift; (osascript "$@" >"$o" 2>"$o.err"; echo $? >"$o.done") </dev/null >/dev/null 2>&1 &', "sh", out, ...script]);
  try {
    for (let i = 0; i < 3000 && !(await fs.exists(`${out}.done`)); i++) await exec("sleep", ["0.3"]);
    const code = parseInt((await readTextFile(`${out}.done`)) ?? "1", 10);
    const err = (await readTextFile(`${out}.err`)) ?? "";
    if (code !== 0) {
      if (/cancel/i.test(err) || !err.trim()) return [];
      throw new Error(err.trim());
    }
    return ((await readTextFile(out)) ?? "").split("\n").filter(Boolean);
  } finally {
    exec("rm", ["-f", out, `${out}.err`, `${out}.done`]).catch(() => {});
  }
}
export function openFile(abs) {
  const p = window().platform;
  if (p === "macos") return exec("open", [abs]);
  if (p === "windows") return exec("cmd", ["/c", "start", "", abs]);
  return exec("xdg-open", [abs]);
}

export const ago = (ms) => {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return "now";
  if (d < 3600) return `${Math.round(d / 60)}m`;
  if (d < 86400) return `${Math.round(d / 3600)}h`;
  return `${Math.round(d / 86400)}d`;
};

// ---- programs ----

let known = null;
export async function programs() {
  if (!known) { try { known = await knownAgents(); } catch { known = []; } }
  return known;
}
export const knownNow = () => known ?? [];
// The run commands the engines use for each program (programs.json's `run`).
export const programTable = () => Object.fromEntries(knownNow().filter((p) => p.run).map((p) => [p.key, { name: p.name, run: p.run }]));

// ---- the poller: one copy reads the engines, installs and updates them, toasts ----

const LEADER = () => `${appHome()}/board/screen-leader.json`;
export async function lead(me) {
  let cur = null;
  try { cur = JSON.parse(await fs.readFile(LEADER(), "utf8")); } catch {}
  const now = Date.now();
  if (cur && cur.id !== me && now - cur.at < 9000) return false;
  await fs.writeFile(LEADER(), JSON.stringify({ id: me, at: now })).catch(() => {});
  return true;
}

const seqs = {};
// Reads each engine's seq, and its state.json only when seq moved. One setShared per change.
export async function poll() {
  const fresh = {};
  for (const machine of served()) {
    const k = keyOf(machine);
    try {
      const home = await homeOn(machine);
      const seq = ((await readTextFile(`${home}/seq`, { on: machine })) ?? "").trim();
      if (!seq || seq === seqs[k]) continue;
      const text = await readTextFile(`${home}/state.json`, { on: machine });
      const st = JSON.parse(text);
      if (machine) {
        await fs.mkdir(`${appHome()}/board/cache`, { recursive: true }).catch(() => {});
        await fs.writeFile(cacheFile(k), text);
      }
      seqs[k] = seq;
      fresh[k] = st;
    } catch {}
  }
  if (!Object.keys(fresh).length) return;
  setShared(KEY_SEQS, { ...(shared(KEY_SEQS) ?? {}), ...Object.fromEntries(Object.keys(fresh).map((k) => [k, seqs[k]])) });
  toasts(fresh);
}

// Engine events as toasts, once each: the newest one shown is kept per machine.
function toasts(all) {
  const seen = shared(KEY_SEEN) ?? {};
  const out = { ...seen };
  let any = false;
  for (const [k, st] of Object.entries(all)) {
    const fresh = (st.events ?? []).filter((e) => e.at > (seen[k] ?? 0));
    if (!fresh.length) continue;
    any = true;
    out[k] = Math.max(...fresh.map((e) => e.at));
    // The first look at a machine shows nothing old.
    if (seen[k] === undefined) continue;
    for (const e of fresh.slice(-4)) {
      const terminal = e.terminal ? qual(k || null, e.terminal) : null;
      notify({ title: e.title, body: e.body, level: e.level ?? "info", timeout: 8000, ...(terminal ? { action: { name: "terminal.peek", args: { terminal } } } : {}) });
      if (e.sound) playSound(e.sound);
    }
  }
  if (any) setShared(KEY_SEEN, out);
}

// ---- installing and updating the engines ----

let bundled = null;
async function engineSource() {
  if (!bundled) {
    const text = await fs.readFile(`${appHome()}/mods/${MOD}/engine/engine.mjs`, "utf8");
    const readme = await fs.readFile(`${appHome()}/mods/${MOD}/engine/README.md`, "utf8").catch(() => "");
    const heavy = await fs.readFile(`${appHome()}/mods/${MOD}/engine/board-heavy.sh`, "utf8").catch(() => "");
    const skill = await fs.readFile(`${appHome()}/mods/${MOD}/engine/SKILL.md`, "utf8").catch(() => "");
    // engine.mjs imports platform.mjs (its Linux layer), so it goes along everywhere.
    const platform = await fs.readFile(`${appHome()}/mods/${MOD}/engine/platform.mjs`, "utf8");
    bundled = { text, readme, heavy, skill, platform, version: `${PROTOCOL}-${hash(text + readme + heavy + skill + platform)}` };
  }
  return bundled;
}
// A text in pieces of at most 30000 code points (under 128 KiB of UTF-8 each),
// for arguments: Linux refuses a longer one with "Argument list too long".
export function argPieces(text) {
  const cps = Array.from(String(text));
  const out = [];
  for (let i = 0; i < cps.length; i += 30000) out.push(cps.slice(i, i + 30000).join(""));
  return out.length ? out : [""];
}

const installing = {};
// Puts the bundled engine on a machine when its version differs, and (re)starts
// its launchd service. Returns what it did.
export async function ensureEngine(machine) {
  const k = keyOf(machine);
  if (installing[k]) return "busy";
  installing[k] = true;
  try {
    const home = await homeOn(machine);
    const src = await engineSource();
    // The running engine says its version: current is current.
    if (stateOf(machine)?.version === src.version) return "current";
    // Else read the installed one. A read that fails (the machine dropped for a
    // moment) is not a missing engine: no install on a guess. exec rejects when
    // the machine cannot be reached; cat's own exit code tells missing apart.
    const rv = await exec("sh", ["-c", 'cat "$1/engine/VERSION" 2>/dev/null; echo "::$?"', "sh", home], { on: machine });
    if (rv.code !== 0 || !/::\d+\s*$/.test(rv.stdout)) return "unknown";
    const missing = !/::0\s*$/.test(rv.stdout);
    const have = missing ? "" : rv.stdout.replace(/::\d+\s*$/, "").trim();
    if (have === src.version) return "current";
    const sh = (await exec("sh", ["-c", "echo $SHELL"], { on: machine })).stdout.trim() || "/bin/zsh";
    const paths = (await exec(sh, ["-lic", "command -v node; command -v hc; id -u; echo $HOME"], { on: machine })).stdout.trim().split("\n").map((x) => x.trim()).filter((x) => x.startsWith("/") || /^\d+$/.test(x));
    const [node, hcPath, uidNum, userHome] = paths;
    if (!node || !node.startsWith("/")) throw new Error(`Node is not installed on ${machine ?? "this Mac"}: the board engine needs it.`);
    if (!hcPath?.startsWith("/")) throw new Error(`hc is not on the PATH on ${machine ?? "this Mac"}.`);
    const plistPath = `${userHome}/Library/LaunchAgents/${LABEL}.plist`;
    const pathEnv = [...new Set([node, hcPath].map((p) => p.slice(0, p.lastIndexOf("/"))).concat(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]))].join(":");
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${esc(node)}</string><string>${esc(home)}/engine/engine.mjs</string><string>--home</string><string>${esc(home)}</string><string>--hc</string><string>${esc(hcPath)}</string><string>--machine</string><string>${esc(machine ?? "this Mac")}</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(pathEnv)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Background</string>
<key>StandardErrorPath</key><string>${esc(home)}/engine.err</string><key>StandardOutPath</key><string>/dev/null</string>
</dict></plist>
`;
    // Linux takes at most 128 KiB in one argument (MAX_ARG_STRLEN), and engine.mjs
    // is near that: it goes as pieces, the first as $2 and the rest after ${11}.
    const [first, ...more] = argPieces(src.text);
    // The engine's files, then its service: a running one is replaced (bootout, bootstrap).
    const w = await exec("sh", ["-c", `set -e; mkdir -p "$1/engine" "$1/bin" "$(dirname "$4")"
pieces() { shift 11; printf "%s" "$@"; }
printf "%s" "\${11}" > "$1/engine/.platform.mjs.tmp" && mv -f "$1/engine/.platform.mjs.tmp" "$1/engine/platform.mjs"
{ printf "%s" "$2"; pieces "$@"; } > "$1/engine/.engine.mjs.tmp" && mv -f "$1/engine/.engine.mjs.tmp" "$1/engine/engine.mjs"
printf "%s" "$9" > "$1/bin/.board-heavy.tmp" && chmod 755 "$1/bin/.board-heavy.tmp" && mv -f "$1/bin/.board-heavy.tmp" "$1/bin/board-heavy"
printf "%s" "$5" > "$4.tmp" && mv -f "$4.tmp" "$4"
printf "%s" "$8" > "$1/.README.md.tmp" && mv -f "$1/.README.md.tmp" "$1/README.md"
printf "%s" "$3" > "$1/engine/VERSION"
# The herdr-board skill, for any agent: ~/.agents/skills (Codex and others read it);
# Claude's ~/.claude/skills/herdr-board links there. An old copy holding only the
# skill file becomes the link; anything else there is left alone.
if [ -n "\${10}" ]; then
  S="$HOME/.agents/skills/herdr-board"; mkdir -p "$S"
  printf "%s" "\${10}" > "$S/.SKILL.md.tmp" && mv -f "$S/.SKILL.md.tmp" "$S/SKILL.md"
  C="$HOME/.claude/skills/herdr-board"; mkdir -p "$HOME/.claude/skills"
  if [ -d "$C" ] && [ ! -L "$C" ] && [ "$(ls -A "$C")" = "SKILL.md" ]; then rm -rf "$C"; fi
  [ -e "$C" ] && [ ! -L "$C" ] || ln -sfn "$S" "$C"
fi
launchctl bootout "gui/$6/$7" 2>/dev/null || true
for i in 1 2 3 4 5 6 7 8 9 10; do launchctl bootstrap "gui/$6" "$4" 2>/dev/null && exit 0; sleep 0.5; done
launchctl bootstrap "gui/$6" "$4"`, "sh", home, first, src.version, plistPath, plist, uidNum, LABEL, src.readme, src.heavy,
      // The skill names this machine's board home (here: ~/.config/herdr-app/board).
      src.skill.replaceAll("~/.herdr/board", home.startsWith(`${userHome}/`) ? `~${home.slice(userHome.length)}` : home),
      src.platform, ...more], { on: machine });
    if (w.code !== 0) throw new Error(`Could not install the board engine on ${machine ?? "this Mac"}: ${(w.stderr || w.stdout).trim()}`);
    return have ? "updated" : "installed";
  } finally {
    installing[k] = false;
  }
}
