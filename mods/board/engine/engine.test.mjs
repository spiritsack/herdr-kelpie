// node --test mods/board/engine/engine.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { limitOf } from "./engine.mjs";

const LIMIT = [
  "⎿  You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit · your session limit resets 10pm (Europe/Berlin)",
  "⏺ Usage limit reached · continuing automatically at 10pm · esc to cancel",
].join("\n");
const CANCELLED = `${LIMIT}\n⏺ Automatic continue cancelled · /rate-limit-options to re-arm`;
const STALE = [
  LIMIT,
  "⏺ Bash(npm test)",
  "  ⎿  Running…",
  "╭───────────────────────────────────────╮",
  "│ Bash command                          │",
  "│   npm test                            │",
  "│ Do you want to proceed?               │",
  "│ ❯ 1. Yes                              │",
  "╰───────────────────────────────────────╯",
].join("\n");

test("a limit in the message, continuing automatically", () => {
  assert.deepEqual(limitOf("blocked", "Usage limit reached · continuing automatically at 10pm · esc to cancel", null, ""), { until: "10pm", auto: true });
});

test("a limit on the screen, state error", () => {
  assert.deepEqual(limitOf("error", null, null, LIMIT), { until: "10pm", auto: true });
});

test("a cancelled automatic continue stops", () => {
  assert.deepEqual(limitOf("blocked", null, null, CANCELLED), { until: "10pm", auto: false });
});

test("a limit without auto-continue, time from resets", () => {
  assert.deepEqual(limitOf("blocked", null, null, "⎿  You've hit your limit · resets 3pm (Europe/Berlin)"), { until: "3pm", auto: false });
});

test("only blocked or error can be a limit", () => {
  assert.equal(limitOf("working", "Usage limit reached · continuing automatically at 10pm", null, ""), null);
});

test("a permission prompt is not a limit", () => {
  assert.equal(limitOf("blocked", "Do you want to proceed?", null, "Allow Bash(npm test)? (y/n)"), null);
});

test("only the last 15 lines count", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  lines[1] = "We talked about the usage limit reached earlier, and your limit resets tomorrow.";
  lines[39] = "Allow Bash(npm test)? (y/n)";
  assert.equal(limitOf("blocked", null, null, lines.join("\n")), null);
});

test("idle or no state is never a limit", () => {
  assert.equal(limitOf("idle", null, null, ""), null);
  assert.equal(limitOf(null, null, null, ""), null);
});

test("a cut message keeps auto, without a time", () => {
  assert.deepEqual(limitOf("blocked", "Usage limit reached · continuing automatica…", null, ""), { until: null, auto: true });
});

test("a cut message takes the time from the screen", () => {
  assert.deepEqual(limitOf("blocked", "Usage limit reached · continuing automatica…", null, LIMIT), { until: "10pm", auto: true });
});

test("a kind means the program asked something", () => {
  assert.equal(limitOf("blocked", "Usage limit reached · continuing automatically at 10pm", "permission", ""), null);
});

test("a limit line above later work is stale", () => {
  assert.equal(limitOf("blocked", null, null, STALE), null);
});

test("the message still wins over a stale screen", () => {
  assert.deepEqual(limitOf("blocked", "Usage limit reached · continuing automatically at 10pm", null, STALE), { until: "10pm", auto: true });
});

import { countedRuns, loopOf } from "./engine.mjs";
const off = (from, to) => ({ member: from, result: { action: "handoff", to } });

test("stopped runs do not count toward the run limit", () => {
  assert.equal(countedRuns({ runs: [{ member: "a", exit: "stopped" }, off("a", "b"), { member: "b" }] }), 1);
});

test("two grill rounds are not a loop", () => {
  assert.equal(loopOf({ runs: [off("ana", "greg"), off("greg", "ana"), off("ana", "greg"), off("greg", "ana"), off("ana", "bo"), off("bo", "cy")] }), null);
  assert.equal(loopOf({ runs: [off("ana", "greg"), off("greg", "ana"), off("ana", "greg"), off("greg", "ana")] }), null);
});

test("six hand-offs between the same two members are a loop", () => {
  const runs = [off("x", "y"), off("bo", "cy"), off("cy", "bo"), off("bo", "cy"), off("cy", "bo"), off("bo", "cy"), off("cy", "bo")];
  assert.deepEqual(loopOf({ runs }).sort(), ["bo", "cy"]);
  assert.equal(loopOf({ runs: runs.slice(0, -1) }), null);
});

test("a stopped run between hand-offs does not break or make a loop", () => {
  const runs = [off("bo", "cy"), off("cy", "bo"), { member: "bo", exit: "stopped" }, off("bo", "cy"), off("cy", "bo"), off("bo", "cy"), off("cy", "bo")];
  assert.deepEqual(loopOf({ runs }).sort(), ["bo", "cy"]);
});

import { decodePassword, securityLine } from "./engine.mjs";

test("Keychain values decode: quoted, hex and empty", () => {
  assert.equal(decodePassword('password: "plain-123"\n'), "plain-123");
  assert.equal(decodePassword('password: "a "q" \\ b"'), 'a "q" \\ b');
  assert.equal(decodePassword(`password: 0x${Buffer.from("ünï x").toString("hex").toUpperCase()}  "\\303\\274n\\303\\257 x"`), "ünï x");
  assert.equal(decodePassword("password: \n"), "");
  assert.equal(decodePassword("security: not found"), null);
});

test("a security -i line escapes quotes and backslashes", () => {
  assert.equal(securityLine("tm/m1/A", 'x"y\\z'), 'add-generic-password -U -s herdr-board -a "tm/m1/A" -w "x\\"y\\\\z"\n');
});

import { stranded, closable, busyBelow, psRows, resetAt } from "./engine.mjs";

test("a doing task with an assignee, no run, no note and not waiting is stranded", () => {
  assert.equal(stranded({ column: "doing", assignee: "cy", runs: [] }, null), true);
  assert.equal(stranded({ column: "doing", assignee: "cy", queued: true }, null), false);
  assert.equal(stranded({ column: "doing", assignee: "cy", attention: "x" }, null), false);
  assert.equal(stranded({ column: "todo", assignee: "cy" }, null), false);
  assert.equal(stranded({ column: "doing", assignee: "cy" }, { id: "r" }), false);
  assert.equal(stranded({ column: "doing", assignee: "cy", autopilot: false }, null), false);
});

test("idle sessions close after the task sat in Review or Done for a while", () => {
  const now = 10_000_000;
  const r = { id: "r1", result: { action: "done" }, idleAt: now - 16 * 60000 };
  const k = { state: "live", status: "idle", labels: {} };
  const done = { column: "done", doneAt: now - 31 * 60000, runs: [r] };
  assert.equal(closable(done, r, k, now), true);
  assert.equal(closable({ ...done, doneAt: now - 10 * 60000 }, r, k, now), false);
  assert.equal(closable({ column: "review", restAt: now - 31 * 60000, runs: [r] }, r, k, now), true);
  assert.equal(closable({ column: "review", restAt: now - 10 * 60000, runs: [r] }, r, k, now), false);
  assert.equal(closable({ column: "doing", runs: [r, { id: "r2" }] }, r, k, now), false);
  assert.equal(closable(done, r, k, now, 0), false);
  assert.equal(closable(done, { ...r, idleAt: now - 5 * 60000 }, k, now), false);
  assert.equal(closable(done, r, { ...k, status: "working" }, now), false);
  assert.equal(closable(done, r, { ...k, labels: { "herdr.tab": "tb1" } }, now), false);
});

test("a running Claude Bash command below the agent counts as busy", () => {
  const rows = psRows([
    "  100     1 /bin/zsh -lic x",
    "  200   100 claude --model x",
    "  300   200 node /path/to/mcp-server",
    "  400   200 /bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'npm test'",
    "  500   400 node vitest",
  ].join("\n"));
  assert.equal(busyBelow(200, rows), true);
  assert.equal(busyBelow(200, rows.filter((x) => x.pid !== 400 && x.pid !== 500)), false);
  assert.equal(busyBelow(null, rows), false);
});

test("a reset time is today, or tomorrow when it already passed", () => {
  const seen = new Date(2026, 9, 31, 19, 16).getTime();
  assert.equal(new Date(resetAt("10pm", seen)).getHours(), 22);
  assert.equal(new Date(resetAt("10pm", seen)).getDate(), 31);
  assert.equal(new Date(resetAt("1am", new Date(2026, 9, 31, 23, 0).getTime())).getDate(), 1);
  assert.equal(new Date(resetAt("10:30pm", seen)).getMinutes(), 30);
  assert.equal(resetAt("soon", seen), null);
});

import { chromesBelow } from "./engine.mjs";

test("chromesBelow finds the agent's Chrome main process only", () => {
  const C = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const rows = [
    { pid: 10, ppid: 1, command: "claude --model x" },
    { pid: 11, ppid: 10, command: "npm exec chrome-devtools-mcp@latest" },
    { pid: 12, ppid: 11, command: "chrome-devtools-mcp" },
    { pid: 13, ppid: 12, command: `${C} --user-data-dir=/x --remote-debugging-pipe` },
    { pid: 14, ppid: 13, command: "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer" },
    { pid: 20, ppid: 1, command: `${C}` },                       // the person's Chrome
    { pid: 30, ppid: 1, command: "claude" },
    { pid: 31, ppid: 30, command: `${C} --user-data-dir=/y` },    // another agent's
  ];
  assert.deepEqual(chromesBelow(10, rows), [13]);
  assert.deepEqual(chromesBelow(99, rows), []);
});

import { initialTeams, STARTER_TEAM } from "./engine.mjs";

test("only an engine without any teams file gets the starter team", () => {
  // load() calls initialTeams only when teams.json is missing; team.json decides the rest.
  assert.deepEqual(initialTeams(null).map((t) => t.name), ["Starter"]);
  assert.deepEqual(initialTeams([]).map((t) => t.name), ["Starter"]);
  const legacy = [{ id: "planner", name: "Ana" }];
  assert.deepEqual(initialTeams(legacy), [{ id: "default", name: "Default", members: legacy }]);
  const s = initialTeams(null)[0];
  assert.deepEqual(s.members.map((m) => [m.role, m.handoffs]), [["Planner", ["builder"]], ["Builder", ["reviewer"]], ["Reviewer", ["builder"]]]);
  assert.ok(s.members.every((m) => m.program === "claude" && m.model === "" && m.capacity === 1));
  assert.notEqual(s, STARTER_TEAM); // a copy: STARTER_TEAM never changes
});

import { parseLoad, loadVerdict, heavyState, niced } from "./engine.mjs";
import fsx from "node:fs";
import osx from "node:os";
import pathx from "node:path";

const SYSCTL = "1\ntotal = 6144.00M  used = 4465.31M  free = 1678.69M  (encrypted)\n{ 10.62 12.82 13.29 }\n12\n";
const LIMITS = { gatePressure: 2, gateSwap: 0.85, gateLoad: 1.5 };

test("parseLoad reads sysctl's numbers", () => {
  assert.deepEqual(parseLoad(SYSCTL), { pressure: 1, ncpu: 12, swapTotal: 6144, swapUsed: 4465.31, load1: 10.62 });
});

test("the load gate: calm, memory, swap, load", () => {
  assert.equal(loadVerdict(parseLoad(SYSCTL), LIMITS), null);
  assert.equal(loadVerdict({ ...parseLoad(SYSCTL), pressure: 2 }, LIMITS).why, "memory");
  assert.equal(loadVerdict({ ...parseLoad(SYSCTL), pressure: 4 }, LIMITS).detail, "memory pressure critical");
  assert.equal(loadVerdict({ ...parseLoad(SYSCTL), swapUsed: 5600 }, LIMITS).why, "swap");
  assert.equal(loadVerdict({ ...parseLoad(SYSCTL), swapUsed: 5600 }, { ...LIMITS, gateSwap: 0 }), null);
  assert.equal(loadVerdict({ ...parseLoad(SYSCTL), load1: 19 }, LIMITS).why, "load");
  assert.equal(loadVerdict({ ...parseLoad(SYSCTL), load1: 17.9 }, LIMITS), null);
});

test("heavyState: live holders and waiters only", () => {
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "heavy-"));
  fsx.symlinkSync("111:ka:r1:5", pathx.join(dir, "slot-1"));
  fsx.symlinkSync("999:kdead:r2:5", pathx.join(dir, "slot-2"));
  fsx.writeFileSync(pathx.join(dir, "wait-222"), "222:kb:r3:6\n");
  fsx.writeFileSync(pathx.join(dir, "wait-998"), "998:kgone:r4:6\n");
  const live = new Set([111, 222]);
  const st = heavyState(dir, (pid) => live.has(pid));
  assert.deepEqual(st.held.map((h) => h.task), ["ka"]);
  assert.deepEqual(st.waiting.map((w) => w.task), ["kb"]);
  fsx.rmSync(dir, { recursive: true, force: true });
});

test("niced wraps argv, and 0 means off", () => {
  assert.deepEqual(niced(["zsh", "-lic", "x"], 10), ["/usr/bin/nice", "-n", "10", "zsh", "-lic", "x"]);
  assert.deepEqual(niced(["zsh"], 0), ["zsh"]);
  assert.deepEqual(niced(["zsh"], 40), ["/usr/bin/nice", "-n", "19", "zsh"]);
});

import { pushSample } from "./engine.mjs";

test("a gate rule set to 0 is off", () => {
  const busy = { pressure: 4, ncpu: 4, load1: 40, swapUsed: 90, swapTotal: 100 };
  assert.equal(loadVerdict(busy, { gatePressure: 0, gateLoad: 0, gateSwap: 0 }), null);
  assert.equal(loadVerdict(busy, { gatePressure: 4, gateLoad: 0, gateSwap: 0 }).why, "memory");
  assert.equal(loadVerdict({ ...busy, pressure: 1 }, { gatePressure: 2, gateLoad: 1.5, gateSwap: 0 }).why, "load");
  assert.equal(loadVerdict({ ...busy, pressure: 1, load1: 1 }, { gatePressure: 2, gateLoad: 1.5, gateSwap: 0.85 }).why, "swap");
});

test("the machine samples keep the last hour", () => {
  let b = null;
  for (let i = 0; i < 400; i++) b = pushSample(b, { t: i, load: i, pressure: 1, swap: 0, gate: 0, busy: 0 });
  assert.equal(b.t.length, 360);
  assert.equal(b.t[0], 40);
  assert.equal(b.load.at(-1), 399);
});

import { blockStep } from "./engine.mjs";

test("a question answered in the terminal: stopped after asking, then working again", () => {
  const r = { blocked: "Pick A or B?" };
  assert.equal(blockStep(r, "working"), null);              // still writing the result: not yet
  assert.deepEqual(blockStep(r, "idle"), { blockPaused: true });
  const paused = { ...r, blockPaused: true };
  assert.equal(blockStep(paused, "idle"), null);
  assert.deepEqual(blockStep(paused, "working"), { blockAnswered: true });
  assert.equal(blockStep({ ...paused, blockAnswered: true }, "working"), null);
  assert.equal(blockStep({}, "working"), null);              // no question asked
});

import { blockedBy, depsText, wouldCycle } from "./engine.mjs";

test("blockedBy: dependencies count as done in Review or Done; gone ones count as done", () => {
  const all = [
    { id: "a", title: "API", column: "doing" },
    { id: "b", title: "Schema", column: "review" },
    { id: "c", title: "Docs", column: "done" },
    { id: "d", title: "UI", column: "todo" },
  ];
  assert.deepEqual(blockedBy({ dependsOn: ["a", "b", "c", "gone"] }, all).map((x) => x.id), ["a"]);
  assert.deepEqual(blockedBy({ dependsOn: ["b", "c"] }, all), []);
  assert.deepEqual(blockedBy({}, all), []);
  assert.deepEqual(blockedBy({ dependsOn: ["a", "d"] }, all).map((x) => x.id), ["a", "d"]);
});

test("depsText says what a task waits for", () => {
  assert.equal(depsText([]), null);
  assert.equal(depsText([{ title: "API", column: "doing" }]), 'Waits for "API" (In progress)');
  assert.equal(depsText([{ title: "API", column: "doing" }, { title: "UI", column: "todo" }]), 'Waits for 2 tasks: "API" (In progress), "UI" (To do)');
});

test("wouldCycle finds loops through dependencies, also indirect ones", () => {
  const all = [{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["c"] }, { id: "c", dependsOn: [] }, { id: "x", dependsOn: ["x2"] }];
  assert.equal(wouldCycle("c", ["a"], all), true);   // c -> a -> b -> c
  assert.equal(wouldCycle("a", ["c"], all), false);
  assert.equal(wouldCycle("c", ["x"], all), false);  // a dependency that is gone ends the walk
  assert.equal(wouldCycle("a", ["a"], all), true);
});

import { codexDefaults } from "./engine.mjs";
test("codex members run with a writable sandbox unless their own args say otherwise", () => {
  assert.deepEqual(codexDefaults({ program: "codex" }), ["--sandbox", "workspace-write", "--ask-for-approval", "never", "-c", "sandbox_workspace_write.network_access=true"]);
  assert.deepEqual(codexDefaults({ program: "codex", args: ["--sandbox", "read-only"] }), []);
  assert.deepEqual(codexDefaults({ program: "codex", args: ["--full-auto"] }), []);
  assert.deepEqual(codexDefaults({ program: "claude" }), []);
});

import { browserEnv, abDaemons, abTargets } from "./engine.mjs";
test("agent-browser: each run gets its own session and namespace", () => {
  assert.deepEqual(browserEnv("t1", "rabc"), { AGENT_BROWSER_SESSION: "t1-rabc", AGENT_BROWSER_NAMESPACE: "rabc", AGENT_BROWSER_IDLE_TIMEOUT_MS: "600000" });
});
test("agent-browser: a run's daemons come from its namespace's pid files only", () => {
  const root = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "ab-"));
  for (const [ns, name, pid] of [["rone", "t1-rOne", "101"], ["rone", "t1-rOne-b", "102\n"], ["rtwo", "t2-rtwo", "201"]]) {
    fsx.mkdirSync(pathx.join(root, "namespaces", ns, "run"), { recursive: true });
    fsx.writeFileSync(pathx.join(root, "namespaces", ns, "run", `${name}.pid`), pid);
  }
  fsx.writeFileSync(pathx.join(root, "namespaces", "rone", "run", "t1-rOne.sock"), "");
  assert.deepEqual(abDaemons("rOne", root).sort(), [101, 102]);
  assert.deepEqual(abDaemons("rthree", root), []);
  fsx.rmSync(root, { recursive: true });
});
test("agent-browser: stop a daemon and its Chrome, never a reused pid or someone else's Chrome", () => {
  const AB = "/opt/homebrew/lib/node_modules/agent-browser/bin/agent-browser-darwin-arm64";
  const CFT = "/Users/u/.agent-browser/browsers/chrome-156/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  const rows = psRows([
    `101 1 ${AB}`, `111 101 ${CFT} --remote-debugging-port=0 --user-data-dir=/tmp/agent-browser-chrome-x`, `112 111 ${CFT.replace("MacOS/Google Chrome for Testing", "Helpers/x")} --type=renderer`,
    `201 1 ${AB}`, `211 201 ${CFT} --remote-debugging-port=0`,
    `102 1 /bin/zsh`,  // pid file left over, pid now someone else's
    `300 1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/u/.herdr/board/chrome-github`,
  ].join("\n"));
  assert.deepEqual(abTargets([101, 102, 999], rows), [101, 111]);
});

test("a member's earlier idle session closes once the member finished a later run", () => {
  const now = 10_000_000;
  const k = { state: "live", status: "done", labels: {} };
  const r1 = { id: "r1", member: "bo", result: { action: "handoff" }, idleAt: now - 16 * 60000 };
  const r2 = { id: "r2", member: "cy", result: { action: "handoff" }, idleAt: now - 16 * 60000 };
  const r3 = { id: "r3", member: "bo", result: { action: "handoff" }, idleAt: now - 16 * 60000 };
  const t = { column: "doing", runs: [r1, r2, r3] };
  assert.equal(closable(t, r1, k, now), true);
  assert.equal(closable(t, r2, k, now), false);
  assert.equal(closable(t, r3, k, now), false);
  assert.equal(closable({ ...t, runs: [r1, r2, { ...r3, result: null }] }, r1, k, now), false);
  assert.equal(closable(t, { ...r1, idleAt: now - 5 * 60000 }, k, now), false);
  assert.equal(closable(t, r1, { ...k, status: "working" }, now), false);
});

import { prLinksOf } from "./engine.mjs";
test("PR links come from the description and the summaries, once each", () => {
  const t = { description: "See https://github.com/o/r/pull/12 and https://github.com/o/r/pull/12.", runs: [{ result: { summary: "Opened https://github.com/o/r/pull/30" } }, { result: null }] };
  assert.deepEqual(prLinksOf(t), [{ number: 12, url: "https://github.com/o/r/pull/12" }, { number: 30, url: "https://github.com/o/r/pull/30" }]);
});

import { depBranchOf, depRef } from "./engine.mjs";
import { execFileSync } from "node:child_process";

test("one dependency: branch from its branch; none or several: default branch", () => {
  const a = { id: "t-aaaaa11111", board: "b1", title: "Foundation work", worktree: { branch: "board/foundation-11111" } };
  const b = { id: "t-bbbbb22222", board: "b1", title: "No worktree yet!" };
  const other = { id: "t-ccccc33333", board: "b2", title: "Elsewhere" };
  const all = [a, b, other];
  assert.equal(depBranchOf({ board: "b1", dependsOn: [a.id] }, all), "board/foundation-11111");
  assert.equal(depBranchOf({ board: "b1", dependsOn: [b.id] }, all), "board/no-worktree-yet-22222");
  assert.equal(depBranchOf({ board: "b1", dependsOn: [] }, all), null);
  assert.equal(depBranchOf({ board: "b1" }, all), null);
  assert.equal(depBranchOf({ board: "b1", dependsOn: [a.id, b.id] }, all), null);
  assert.equal(depBranchOf({ board: "b1", dependsOn: [other.id] }, all), null);
  assert.equal(depBranchOf({ board: "b1", dependsOn: ["gone"] }, all), null);
});

test("depRef prefers the pushed branch, the local one when ahead, null when missing", async () => {
  const tmp = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "deps-"));
  const g = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { stdio: "pipe" }).toString().trim();
  try {
    const origin = pathx.join(tmp, "origin.git"), repo = pathx.join(tmp, "repo");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    g(repo, "commit", "-q", "--allow-empty", "-m", "root");
    g(repo, "remote", "add", "origin", origin);
    g(repo, "push", "-q", "origin", "main");
    assert.equal(await depRef(repo, "board/dep-1"), null);
    g(repo, "branch", "board/dep-1");
    assert.equal(await depRef(repo, "board/dep-1"), "board/dep-1");
    g(repo, "push", "-q", "origin", "board/dep-1");
    assert.equal(await depRef(repo, "board/dep-1"), "origin/board/dep-1");
    g(repo, "checkout", "-q", "board/dep-1");
    g(repo, "commit", "-q", "--allow-empty", "-m", "unpushed");
    assert.equal(await depRef(repo, "board/dep-1"), "board/dep-1");
    // pushed only (local branch gone), and pushed ahead of a stale local one
    g(repo, "push", "-q", "origin", "board/dep-1");
    g(repo, "checkout", "-q", "main");
    g(repo, "branch", "-q", "-f", "board/dep-1", "main");
    assert.equal(await depRef(repo, "board/dep-1"), "origin/board/dep-1");
    g(repo, "branch", "-q", "-D", "board/dep-1");
    g(repo, "update-ref", "-d", "refs/remotes/origin/board/dep-1");
    assert.equal(await depRef(repo, "board/dep-1"), "origin/board/dep-1");
  } finally { fsx.rmSync(tmp, { recursive: true, force: true }); }
});
