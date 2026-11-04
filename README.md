<p align="center"><img src="kelpie.png" width="160" alt="Kelpie"></p>

# Kelpie

Kelpie is a software factory for coding agents in the [Herdr](https://herdr.dev) app. It is a kanban board where teams of agents plan, build, review and test your work. Each repository or worktree folder gets a board with five columns: Backlog, To do, In progress, Review, Done. A team of agents works the tasks. Each member has a name, a role, a brief and a program: any coding agent that Herdr can start. The members hand each task on to the next. If a card says it needs you, you step in.

![Board](screenshots/board.png)

## Screenshots

| | |
|---|---|
| ![The board](screenshots/board.png) | ![The settings menu](screenshots/settings-menu.png) |
| The board: a task that needs you (with Unblock ↗), one waiting for its dependencies, one working on its own branch, and a Codex reviewer | The settings menu: Autopilot, Pick up, Worktrees, Tabs, the run limit, the board's team, and the Teams and Machine windows |
| ![A task](screenshots/task.png) | ![Teams with a Codex member](screenshots/teams.png) |
| A task: its description, pull requests, dependencies, runs and history | The Teams window: a Codex member with its model, and a secret that is set |
| ![The Machine window](screenshots/machine.png) | |
| The Machine window: the last hour's load, memory and swap, the load gate, browser slots and the machine's settings | |

## Install

1. Copy the `mods/board/` folder into `~/.config/herdr-app/mods/`.
2. Open the board:
   - as a window: `herdr-app do mod.open --name board`, or
   - as a tab in a space: `herdr-app do tab.new --name Board --space <space id> --mod board --props '{"space":"<space id>"}'`.
3. The first time a board opens, it installs a small engine on this Mac, and on every Mac that Herdr is connected to. The engine starts the agents. A new engine comes with a "Starter" team: a Planner, a Builder and a Reviewer. Edit them, or make your own teams in "Teams…" in the board's menu.

You need macOS, Node, git and a coding agent's command-line program on each Mac that runs agents.

It runs on Linux too, with a systemd user instance and `secret-tool` for secrets: see [LINUX.md](LINUX.md).

## What it installs and does

Read this before you install it:

- **A background service on each Mac.** It installs a launchd user agent, `dev.herdr.board`, which runs `mods/board/engine/engine.mjs` with Node. The service keeps the board working while Herdr is closed. Its files are in `~/.config/herdr-app/board` on this Mac and in `~/.herdr/board` on other Macs.
- **Agents and commands, here and on other machines.** It starts the members' agents on every Mac that Herdr is connected to, through herdr-core. It also runs `git`, `gh` (to show each task's pull requests), `hc`, `security`, `launchctl` and `ps` there.
- **Git worktrees and branches.** Each task gets its own worktree, under `~/.herdr/worktrees/<repo>/`, on a branch named `board/…`. It never deletes a worktree that has changes.
- **Secrets in the macOS Keychain.** A member's secrets are kept in the Keychain of its machine, under the service `herdr-board`. Agents get them as environment variables. The values never go into the board's files.
- **Chrome cleanup.** After an agent writes its result, the engine closes the Chrome that agent started, and only that one. Idle agent sessions are closed once their task has sat in Review or Done for 30 minutes (a Machine setting; 0 = never). A member's earlier session on a task closes as soon as that member finishes a later run, so only the newest one stays to ask.
- **Lower priority and a limit on heavy jobs.** Agents run under `nice -n 10`. Browser and e2e suites run through the bundled `board-heavy` script, one at a time per machine by default. While a machine is short of memory or far over its cores, the board starts no new agents there.
- **The `herdr-board` skill for any agent.** It installs the skill in `~/.agents/skills/herdr-board/` on each Mac, where Codex and other agents look, and links Claude's `~/.claude/skills/herdr-board` to it. Agents outside the board use it to add or check tasks.
- **No network calls of its own.** The board itself only talks to your machines. The agents it starts use their own network as usual.

## Using it

- Add a task with "+ Task", give it a member, and drag it into In progress. That member starts. Members hand the task on until one reports it done, and it lands in Review.
- **Pick up** (in the menu) lets members with room take To do tasks by themselves.
- **Depends on** (in a task's form) picks other tasks of the same board. The task starts, by hand, by a hand-off or by Pick up, only when every one is in Review or Done; until then its card says what it waits for, and it starts by itself once they are.
- **Tasks at once** (in Teams) sets how many tasks a member works on at the same time. It counts per board.
- **Unblock in tab ↗** (on a card that needs you, and in its task dialog) opens a tab with Claude in the space of the task's own worktree (a new one if none is open), or in the task's space for a task without a worktree. It writes `UNBLOCK.md` into the task folder first: why the task needs you, the waiting question, the description, the team, every run and hand-off, and the notes to read. The session talks it through with you and acts on the board only after you agree.
- **Pull requests** in a task's dialog lists every GitHub PR its agents linked (in the description, the hand-offs or the results), with its title and whether it is a draft, open, merged or closed. A click opens it. It needs `gh` signed in on the Mac with the app.
- **Board setup and notes…** sets a command for each new worktree, for example `npm ci`. It also holds notes for every agent's brief, and your standing answers to questions that agents ask often.

`mods/board/README.md` describes how it is built, and `RECIPE.md` describes how to build it from scratch.

## Agent programs

A member can run any program in Herdr's programs table that has a `run` command (`programs.json`). The board adds `--model` when the member names a model, and passes the first message as the last argument. Claude Code and Codex are the programs that are tested, and they get the extra flags below.

A member runs `claude` or `codex`. Both get the task folder as a second writable folder (`--add-dir`). Codex members also run with `--sandbox workspace-write --ask-for-approval never` and network on inside the sandbox, because Codex otherwise starts read-only and refuses the task folder. A member's own "Extra arguments" that set a sandbox or approval policy win.

Codex asks once per repository whether to trust it; the answer covers all later worktrees of that repository. For Codex agents to use MCP tools (a browser, CI) without stopping, give those servers `default_tools_approval_mode = "approve"` in `~/.codex/config.toml`.

## Heavy jobs

Browser and e2e suites can overload a machine. The board guards it in three ways:

- **Low priority.** Every agent and everything it starts runs under `nice -n 10`, so the machine keeps answering ssh and the network.
- **Browser slots.** Agents run suites through `"$BOARD_HEAVY"` (the board's `board-heavy`), which waits for one of the machine's slots (default 1) and runs the suite at low priority. Each board's "Browsers per test run" (`$BOARD_WORKERS`, default 4) caps how many browsers one run opens; it is not how many agents work at once (that is each member's "Tasks at once").
- **The load gate.** Under memory pressure, or a load over 1.5 × the cores, the board starts nothing new on that machine until it calms down. Running work goes on, and the header says "busy".

**Machine…** in the board's menu shows one machine's last hour (load per core, memory pressure and swap, with the gate's limits and the times it was closed), the gate and the browser slots right now, and its settings: agent priority, browser slots, the load, memory and swap gates, and the run limit. "Browsers per test run" stays per board in "Board setup and notes…".

## License

MIT, see [LICENSE](LICENSE).

## The name

Kelpie is named after the Australian working dog that herds a large flock on its own with few commands. The breed is named after the kelpie of Scottish folklore, a spirit that changes its shape. Inside Herdr, the panel is still called Board.
