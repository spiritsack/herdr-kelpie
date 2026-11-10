// The kanban board: columns of task cards, dragged between them, each card
// showing who is on it and what their agent is doing right now.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Popover } from "gpui-base";
import { theme, props, openOverlay, closeOverlay, run, focused, notify } from "herdr";
import { depsOpen, depsLine, DEP_DONE, unblockInTab, COLUMNS, MOD, tasks, tasksOf, team, member, column, activeRun, liveStatus, runLimit, updateTask, launch, boardSettings, setBoardSettings, setBoardTeam, boardOfSpace, teamsOf, stateOf, outdated, lead, poll, ensureEngine, served, request, programTable, uid, programs, knownNow, ago, spaces, busyOn, openFile } from "./state.js";
import { button, tiny, memberChip, programIcon, statusGlyph, STATUS_WORDS, colorOf, dot } from "./ui.js";
import { noteOf, plain, clip } from "./note.js";
import { limitLine } from "./limit.js";

const CARD_W = 250;

// Why a handed-off task waits: what its member works on now, on this board.
const waitText = (t, m) => {
  const on = m ? busyOn(m.id, t) : [];
  return on.length ? `Waits for ${m.name}, who works on "${on[0].title}"` : `Waits for ${m?.name ?? "the next member"}: starts on the next pass`;
};

export class Board extends View {
  init(_props, cx) {
    this.me = uid("c");
    this.menu = Boolean(props()?.menu); // props { menu: true } opens the settings menu at once
    this.press = null;   // a card pressed: { id, x, y }
    this.drag = null;    // the task id being dragged
    this.pointer = null; // where, in the root's px
    this.over = null;    // the column under the pointer
    this.errors = {};    // task id -> last start error
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => { await programs(); cx.notify(); });
    // The engines do the work; one copy of the screen reads them (poll), and
    // now and then makes sure each machine runs the bundled engine.
    cx.timer.every(2000, (cx) => { cx.spawn(async () => this.tick()); });
    cx.timer.every(30000, (cx) => cx.notify());
    cx.spawn(async () => this.tick());
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (await lead(this.me)) {
        if (!this.checked || Date.now() - this.checked > 60000) { this.checked = Date.now(); await this.engines(); }
        await poll();
      }
    } catch (e) { console.log("board: " + (e?.message ?? e)); }
    this.ticking = false;
  }

  // Each machine runs the bundled engine, and knows how to start each program.
  async engines() {
    const table = programTable();
    for (const machine of served()) {
      try {
        const did = await ensureEngine(machine);
        if (did === "installed" || did === "updated") notify({ title: `Board engine ${did}`, body: machine ?? "this Mac", level: "info", timeout: 5000 });
        const st = stateOf(machine);
        if (st && Object.keys(table).length && JSON.stringify(st.settings?.programs ?? {}) !== JSON.stringify(table)) await request(machine, { op: "set-settings", settings: { programs: table } });
      } catch (e) {
        if (this.engineError !== String(e?.message ?? e)) { this.engineError = String(e?.message ?? e); notify({ title: "Board engine", body: this.engineError.slice(0, 200), level: "error", timeout: 10000 }); }
      }
    }
  }

  // What render's team() and member() mean here: this board's team.
  ctx() {
    const b = boardOfSpace(this.space());
    return b ? { machine: b.machine, board: b.id } : null;
  }

  // A session in a tab, with the task's whole story, to work out what it needs.
  unblock(t, cx) {
    delete this.errors[t.id];
    this.press = null; this.drag = null; this.pointer = null;
    cx.spawn(async (cx) => {
      try { await unblockInTab(t); }
      catch (e) { this.errors[t.id] = String(e?.message ?? e); }
      cx.notify();
    });
  }

  start(t, cx) {
    delete this.errors[t.id];
    this.press = null; this.drag = null; this.pointer = null;
    cx.spawn(async (cx) => {
      const had = this.handle.is_focused();
      try { await launch(t); }
      catch (e) { this.errors[t.id] = String(e?.message ?? e); }
      if (had) this.handle.focus();
      cx.notify();
    });
  }

  move(id, col, cx) {
    const t = tasks().find((x) => x.id === id);
    if (!t || t.column === col) return;
    const moved = updateTask(id, { column: col });
    cx.spawn(async (cx) => {
      try { await moved; } catch (e) { this.errors[id] = String(e?.message ?? e); cx.notify(); return; }
      if (col === "doing" && t.assignee && !activeRun(t)) this.start({ ...t, column: col }, cx);
    });
  }

  // The space this board belongs to: given when docked as a tab, else the shown one.
  space() {
    const id = props()?.space ?? focused()?.space;
    return spaces().find((s) => s.id === id) ?? spaces().find((s) => s.active) ?? null;
  }

  openTask(id) {
    openOverlay({ mod: MOD, kind: "dialog", width: 700, height: 740, props: { view: "task", id } });
  }

  newTask() {
    openOverlay({ mod: MOD, kind: "dialog", width: 660, height: 720, props: { view: "task", space: this.space()?.id ?? null } });
  }

  // ---- drawing ----

  card(t, ghost = false) {
    const tm = theme();
    const m = member(t.assignee);
    const run = activeRun(t);
    const status = run ? liveStatus(t) : null;
    const space = spaces().find((s) => s.id === t.space);
    const err = this.errors[t.id];
    const prog = knownNow().find((p) => p.key === m?.program);
    const canStart = Boolean(m) && !run && t.column !== "done" && !depsOpen(t).length;
    return v_flex().id(ghost ? `ghost-${t.id}` : `card-${t.id}`).w_full().p(10).gap(7).rounded(8).flex_none()
      .bg(tm.surface).border_1().border_color(t.attention ? tm.blocked : this.drag === t.id && !ghost ? tm.accent : tm.border)
      .when(this.drag === t.id && !ghost, (el) => el.opacity(0.35))
      .when(ghost, (el) => el.shadow_md().opacity(0.92))
      .when(!ghost, (el) => el.cursor_pointer().hover((s) => s.border_color(tm.accent))
        .on_mouse_down("left", (e) => { this.press = { id: t.id, x: e.position.x, y: e.position.y }; })
        .on_click(() => { if (!this.drag) this.openTask(t.id); }))
      .child(h_flex().items_start().gap(8)
        .child(div().flex_1().min_w(0).text_size(12.5).font_medium().text_color(tm.foreground).child(t.title || "Untitled"))
        .when(Boolean(status), (el) => el.child(h_flex().flex_none().items_center().gap(5).text_size(10.5).text_color(status === "blocked" ? tm.blocked : tm.dim)
          .child(STATUS_WORDS[status] ?? status).child(statusGlyph(status))))
        .when(Boolean(run) && !status, (el) => el.child(div().flex_none().text_size(10.5).text_color(tm.dim).child("no status yet"))))
      .child(h_flex().items_center().gap(6)
        .child(memberChip(m, { short: true }))
        .when(Boolean(prog), (el) => el.child(programIcon(prog, 12)))
        .when(Boolean(m?.model), (el) => el.child(div().text_size(10.5).text_color(tm.dim).truncate().child(m.model)))
        .child(div().flex_1())
        .when(Boolean(space), (el) => el.child(div().text_size(10.5).text_color(tm.dim).truncate().max_w(90).child(space.name))))
      .when(!run && !DEP_DONE.has(t.column) && Boolean(depsLine(t)), (el) => el.child(div().text_size(11).text_color(tm.dim).child(depsLine(t))))
      .when(Boolean(t.queued && !run && t.column === "doing" && !depsLine(t)), (el) => el.child(div().text_size(11).text_color(tm.dim).child(t.wait || waitText(t, m))))
      .when(Boolean(t.warn), (el) => el.child(div().text_size(11).text_color(tm.done ?? tm.dim).child(t.warn)))
      .when(status === "limited", (el) => el.child(div().text_size(11).text_color(tm.muted).child(limitLine(runLimit(run)))))
      .when(Boolean(t.slotWait && run), (el) => el.child(div().text_size(11).text_color(tm.dim).child(t.slotWait)))
      .when(Boolean(t.worktree?.branch), (el) => el.child(div().text_size(10.5).text_color(tm.dim).truncate().child(`⎇ ${t.worktree.branch}`)))
      .when(Boolean(t.attention), (el) => {
        const n = noteOf(t);
        return el.child(v_flex().gap(2)
          .child(div().text_size(11).font_medium().text_color(tm.blocked).child(n.head ?? "Needs you"))
          .child(div().text_size(11).text_color(tm.muted).child(clip(plain(n.body), 160))));
      })
      .when(Boolean(err), (el) => el.child(div().text_size(11).text_color(tm.blocked).child(err)))
      .child(h_flex().items_center().gap(6).text_size(10.5).text_color(tm.dim)
        .child(div().child(`${t.runs?.length ?? 0} run${(t.runs?.length ?? 0) === 1 ? "" : "s"}`))
        .when((t.attachments?.length ?? 0) > 0, (el) => el.child(div().child(`📎 ${t.attachments.length}`)))
        .child(div().child("·"))
        .child(div().child(ago(t.updated ?? t.created)))
        .child(div().flex_1())
        .when((t.prs?.length ?? 0) > 0, (el) => el.child(this.prChips(t, ghost)))
        .when(Boolean(t.attention) && !ghost, (el) => el.child(tiny(`unblock-${t.id}`, "Unblock ↗", (_e, cx) => this.unblock(t, cx))))
        .when(canStart && !ghost, (el) => el.child(tiny(`start-${t.id}`, "▶ Start", (_e, cx) => this.start(t, cx)))));
  }

  // The task's pull requests: a GitHub mark and their numbers, colored by state.
  // A click opens the PR in the browser on this Mac.
  prChips(t, ghost) {
    const tm = theme();
    const color = (p) => (p.state === "MERGED" ? tm.ansi5 : p.state === "CLOSED" ? tm.dim : p.draft ? tm.muted : tm.working ?? tm.foreground);
    const word = (p) => (p.state === "MERGED" ? "merged" : p.state === "CLOSED" ? "closed" : p.draft ? "draft" : p.state === "OPEN" ? "open" : "");
    return h_flex().items_center().gap(4).flex_none()
      .child(svg("mods/board/github.svg").size(11).text_color(tm.muted))
      .children(t.prs.map((p) => div().id(`pr-${t.id}-${p.number}`).text_color(color(p))
        .when(p.state === "CLOSED", (el) => el.line_through())
        .when(!ghost, (el) => el.cursor_pointer().hover((s) => s.underline())
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); if (p.url) openFile(p.url).catch(() => {}); }))
        .tooltip(`#${p.number} ${word(p)}`.trim())
        .child(`#${p.number}`)));
  }

  columnView(col, list) {
    const tm = theme();
    const over = this.drag && this.over === col.id;
    return v_flex().id(`col-${col.id}`).flex_1().min_w(170).h_full().rounded(10).p(6).gap(6)
      .bg(over ? tm.selected : tm.chrome).border_1().border_color(over ? tm.accent : tm.border)
      .on_hover((h, cx) => {
        if (h) this.over = col.id; else if (this.over === col.id) this.over = null;
        if (this.drag) cx.notify();
      })
      .child(h_flex().items_center().px(6).pt(4).pb(2).gap(6)
        .child(div().text_size(12).font_semibold().text_color(tm.foreground).child(col.name))
        .child(div().text_size(11).text_color(tm.dim).child(String(list.length)))
        .child(div().flex_1())
        .when(col.id === "todo" || col.id === "backlog", (el) => el.child(div().id(`add-${col.id}`).text_size(14).text_color(tm.dim).cursor_pointer().px(4).rounded(5).hover((s) => s.bg(tm.hover).text_color(tm.foreground)).on_click(() => this.newTask()).child("+"))))
      .child(v_flex().id(`col-list-${col.id}`).flex_1().min_h(0).gap(6).overflow_y_scrollbar()
        .children(list.map((t) => this.card(t)))
        .when(list.length === 0, (el) => el.child(div().p(10).text_size(11.5).text_color(tm.dim).text_center().child(over ? "drop here" : "—"))));
  }

  // The board's switches, in one menu: the button says whether Autopilot runs.
  // The run limit (every board on this machine): finished runs a task may have
  // before the board stops it and asks. Stopped runs do not count.
  limitRow(s, set) {
    const tm = theme();
    const n = Number(s.maxRuns) || 20;
    const step = (id, text, to) => div().id(id).w(22).h(22).flex().items_center().justify_center().rounded(5).cursor_pointer()
      .border_1().border_color(tm.input).text_size(13).text_color(tm.foreground).hover((st) => st.bg(tm.hover))
      .on_click((_e, cx) => { set({ maxRuns: Math.min(99, Math.max(2, to)) }); cx.notify(); }).child(text);
    return h_flex().items_center().gap(10).px(10).py(8)
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(12).text_color(tm.foreground).child(`Run limit: ${n}`))
        .child(div().text_size(10.5).text_color(tm.dim).child("Finished runs per task before the board asks you (this machine)")))
      .child(step("limit-down", "−", n - 1))
      .child(step("limit-up", "+", n + 1));
  }

  settingsMenu(s) {
    const tm = theme();
    const row = (id, on, name, hint, flip) => h_flex().id(id).items_center().gap(10).px(10).py(8).rounded(6).cursor_pointer()
      .hover((st) => st.bg(tm.hover)).on_click((_e, cx) => { flip(); cx.notify(); })
      .child(div().flex_none().w(30).h(16).rounded_full().p(2).bg(on ? tm.accent : tm.input)
        .child(div().w(12).h(12).rounded_full().bg(tm.background).when(on, (el) => el.ml_auto())))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(12).text_color(tm.foreground).child(name))
        .child(div().text_size(10.5).text_color(tm.dim).child(hint)));
    const trigger = h_flex().id("settings-trigger").h(28).px(10).gap(7).items_center().rounded(7).flex_none().cursor_pointer()
      .border_1().border_color(tm.input).bg(this.menu ? tm.hover : tm.raised).hover((st) => st.bg(tm.hover))
      .child(dot(s.autopilot ? tm.working : tm.dim, 7))
      .child(div().text_size(12).font_medium().text_color(tm.foreground).child(s.autopilot ? "Autopilot on" : "Autopilot off"))
      .child(div().text_size(10).text_color(tm.dim).child("▾"));
    const space = this.space();
    const set = (patch) => setBoardSettings(space, patch).catch((e) => notify({ title: "Board settings", body: String(e?.message ?? e).slice(0, 200), level: "error", timeout: 8000 }));
    const b = boardOfSpace(space);
    const teams = b ? teamsOf(b.machine) : [];
    const current = b?.record?.team ?? teams[0]?.id ?? null;
    const content = v_flex().w(310).p(5).mt(4).gap(1).rounded(8).bg(tm.popover).border_1().border_color(tm.border).shadow_md()
      .child(row("autopilot", s.autopilot, "Autopilot", s.autopilot ? "Hand-offs start the next agent (every board on this machine)" : "Hand-offs wait for you", () => set({ autopilot: !s.autopilot })))
      .child(row("pickup", s.pickup, "Pick up", s.pickup ? "Members with room take tasks from To do" : "To do waits for you", () => set({ pickup: !s.pickup })))
      .child(row("worktrees", s.worktrees, "Worktrees", s.worktrees ? "Each new task works on its own branch" : "Tasks share the board's folder", () => set({ worktrees: !s.worktrees })))
      .child(row("open-tabs", s.openTabs, "Tabs", s.openTabs ? "Each run opens a tab" : "Runs stay in the background", () => set({ openTabs: !s.openTabs })))
      .child(this.limitRow(s, set))
      .child(div().h(1).bg(tm.border).my(4))
      .child(div().px(10).pt(2).pb(4).text_size(10.5).font_semibold().text_color(tm.dim).child("TEAM"))
      .children(teams.map((t) => h_flex().id(`team-${t.id}`).items_center().gap(8).px(10).py(6).rounded(6).cursor_pointer()
        .hover((st) => st.bg(tm.hover))
        .on_click((_e, cx) => { setBoardTeam(space, t.id).catch((e) => notify({ title: "Team", body: String(e?.message ?? e).slice(0, 200), level: "error", timeout: 8000 })); this.menu = false; cx.notify(); })
        .child(div().w(12).text_size(11).text_color(tm.accent).child(t.id === current ? "✓" : ""))
        .child(div().flex_1().text_size(12).text_color(tm.foreground).child(t.name))
        .child(div().text_size(10.5).text_color(tm.dim).child(t.members.map((m) => m.name).join(", ")))))
      .child(h_flex().id("env-open").items_center().px(10).py(6).rounded(6).cursor_pointer().hover((st) => st.bg(tm.hover))
        .on_click((_e, cx) => { this.menu = false; cx.notify(); openOverlay({ mod: MOD, kind: "dialog", width: 720, height: 640, props: { view: "env", space: this.space()?.id ?? null } }); })
        .child(div().text_size(12).text_color(tm.muted).child("Board setup and notes…")))
      .child(h_flex().id("teams-open").items_center().px(10).py(6).rounded(6).cursor_pointer().hover((st) => st.bg(tm.hover))
        .on_click((_e, cx) => { this.menu = false; cx.notify(); this.openTeams(); })
        .child(div().text_size(12).text_color(tm.muted).child("Teams…")))
      .child(h_flex().id("machine-open").items_center().px(10).py(6).rounded(6).cursor_pointer().hover((st) => st.bg(tm.hover))
        .on_click((_e, cx) => { this.menu = false; cx.notify(); openOverlay({ mod: MOD, kind: "dialog", width: 860, height: 700, props: { view: "machine", machine: b?.machine ?? this.space()?.machine ?? null } }); })
        .child(div().text_size(12).text_color(tm.muted).child("Machine…")));
    return Popover.new("board-settings").anchor("top_right").open(Boolean(this.menu))
      .on_open_change((open, cx) => { this.menu = open; cx.notify(); })
      .trigger(trigger).content(content);
  }

  openTeams(memberId) {
    const b = boardOfSpace(this.space());
    openOverlay({ mod: MOD, kind: "dialog", width: 980, height: 660, props: { view: "teams", machine: b?.machine ?? this.space()?.machine ?? null, team: b?.record?.team ?? null, id: memberId ?? null } });
  }

  header() {
    const tm = theme();
    const s = boardSettings(this.space());
    const space = this.space();
    const all = tasksOf(space);
    const working = all.filter((t) => liveStatus(t) === "working").length;
    const needs = all.filter((t) => t.attention || liveStatus(t) === "blocked").length;
    const limited = all.filter((t) => liveStatus(t) === "limited").length;
    const gate = stateOf(boardOfSpace(space)?.machine ?? space?.machine ?? null)?.loadGate ?? null;
    const overlay = props()?.overlay;
    return h_flex().items_center().gap(10).px(14).h(46).flex_none().border_b(1).border_color(tm.border)
      .child(div().text_size(15).font_semibold().text_color(tm.foreground).child("Board"))
      .child(div().text_size(12.5).text_color(tm.muted).truncate().max_w(220).child(space?.name ?? "no space"))
      .when(Boolean(boardOfSpace(space)?.record), (el) => el.child(div().text_size(11.5).text_color(tm.dim).child(`team ${teamsOf(boardOfSpace(space).machine).find((t) => t.id === boardOfSpace(space).record.team)?.name ?? "none"}`)))
      .child(div().text_size(11.5).text_color(tm.dim).child(`${all.length} task${all.length === 1 ? "" : "s"}`))
      .when(working > 0, (el) => el.child(h_flex().items_center().gap(5).text_size(11.5).text_color(tm.working).child(svg(`mods/${MOD}/spinner.svg`).size(11).text_color(tm.working).spin(900)).child(`${working} working`)))
      .when(needs > 0, (el) => el.child(h_flex().items_center().gap(5).text_size(11.5).text_color(tm.blocked).child(dot(tm.blocked, 8)).child(`${needs} need${needs === 1 ? "s" : ""} you`)))
      .when(Boolean(gate), (el) => el.child(h_flex().id("busy-gate").items_center().gap(5).text_size(11.5).text_color(tm.blocked)
        .child(dot(tm.blocked, 8)).child(`busy (${gate.why}): no new starts`)))
      .when(limited > 0, (el) => el.child(h_flex().items_center().gap(5).text_size(11.5).text_color(tm.muted).child(statusGlyph("limited", 8)).child(`${limited} at usage limit`)))
      .child(div().flex_1())
      .child(this.settingsMenu(s))
      .child(div().w(1).h(20).bg(tm.border).mx(4))
      .child(h_flex().items_center().gap(4).children(team().map((m) => memberChip(m, { short: true, id: `hm-${m.id}`, action: () => this.openTeams(m.id) }))))
      .child(button("new-task", "+ Task", () => this.newTask(), { primary: true }))
      .when(Boolean(overlay), (el) => el
        .child(button("dock", "Dock as tab", () => { if (space) run("tab.new", { name: "Board", space: space.id, mod: MOD, props: { space: space.id } }); closeOverlay(overlay); }, { disabled: !space }))
        .child(div().id("close").w(26).h(26).rounded(6).items_center().justify_center().flex().text_size(14).text_color(tm.dim).cursor_pointer()
          .hover((s) => s.bg(tm.hover).text_color(tm.foreground)).on_click(() => closeOverlay(overlay)).child("✕")));
  }

  render() {
    const tm = theme();
    const space = this.space();
    const all = tasksOf(space);
    const byCol = Object.fromEntries(COLUMNS.map((c) => [c.id, all.filter((t) => (column(t.column).id) === c.id).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))]));
    const dragged = this.drag ? all.find((t) => t.id === this.drag) : null;
    return v_flex().id("board-root").size_full().relative().bg(tm.canvas).text_color(tm.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape" && props()?.overlay) { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .on_mouse_move((e, cx) => {
        if (!this.press) return;
        if (!this.drag && Math.hypot(e.position.x - this.press.x, e.position.y - this.press.y) > 6) this.drag = this.press.id;
        if (this.drag) { this.pointer = e.local_position; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.drag && this.over) this.move(this.drag, this.over, cx);
        if (this.drag || this.press) cx.notify();
        this.press = null; this.drag = null; this.pointer = null;
      })
      .child(this.header())
      .child(h_flex().id("columns").flex_1().min_h(0).p(12).gap(10)
        .children(COLUMNS.map((c) => this.columnView(c, byCol[c.id]))))
      .when(Boolean(dragged && this.pointer), (el) => el.child(
        div().absolute().left(this.pointer.x - CARD_W / 2).top(this.pointer.y - 18).w(CARD_W).child(this.card(dragged, true))))
      .when(all.length === 0, (el) => el.child(
        div().absolute().inset_0().flex().items_center().justify_center().child(
          v_flex().items_center().gap(8).p(20).rounded(10).bg(tm.surface).border_1().border_color(tm.border)
            .child(div().text_size(14).font_semibold().child(this.emptyTitle(space)))
            .child(div().text_size(12).text_color(tm.muted).text_center().child(this.emptyText(space)))
            .when(Boolean(boardOfSpace(space) && !boardOfSpace(space).taskWorktree), (el) => el.child(button("first-task", "+ New task", () => this.newTask(), { primary: true }))))));
  }

  // Why a board is empty: no space, an engine that has not answered, a task's worktree, or no tasks yet.
  emptyTitle(space) {
    const b = boardOfSpace(space);
    if (!space) return "No space";
    if (outdated(space.machine ?? null)) return `Updating the board engine on ${space.machine ?? "this Mac"}`;
    if (!stateOf(space.machine ?? null) || !b) return "Waiting for the board engine";
    if (b.taskWorktree) return "This is a task's worktree";
    return `No tasks in ${space.name} yet`;
  }
  emptyText(space) {
    const b = boardOfSpace(space);
    if (!space) return "Open a space first: a board belongs to one checkout.";
    if (outdated(space.machine ?? null)) return "The board installs its new engine there. Changes wait until it runs.";
    if (!stateOf(space.machine ?? null) || !b) return `The board engine on ${space.machine ?? "this Mac"} has not answered yet. It starts by itself; if this stays, see engine.log in its board folder.`;
    if (b.taskWorktree) return "The board made this worktree for one task. Its tasks are on the board of the repository.";
    return "Add a task, assign it to a team member and drop it into In progress.\nThey hand it on to each other; you watch and step in here.";
  }
}
