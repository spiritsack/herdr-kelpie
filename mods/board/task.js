// One task as a dialog: a form for a new or edited task, else its details,
// history, runs and the actions the person takes on it.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import { theme, spaces, props, closeOverlay, openOverlay, run, exec } from "herdr";
import { boardMates, depsOpen, DEP_DONE, depLoops, MOD, unblockInTab, COLUMNS, tasks, task, team, member, column, activeRun, liveStatus, runStatus, runLimit, updateTask, newTask, removeTask, removeTaskDir, where, launch, restart, endRun, tidy, goTo, paneOf, isLive, leftOver, nudge, reply, place, taskDir, knownNow, programs, ago, uid, attachments, copyIn, attach, detach, filesDir, pickFiles, openFile, removeWorktree, ctxOfTask, boardOfSpace, fileOf, homeNow } from "./state.js";
import { button, tiny, label, field, fileChip, memberChip, programIcon, statusGlyph, STATUS_WORDS, section, chips, titleRow, closeButton, colorOf, dot } from "./ui.js";
import { MarkdownEditor } from "./mdeditor.js";
import { TextBlocks } from "./textblock.js";
import { limitLine } from "./limit.js";

const DROP_HINT = "Drop files onto this dialog to attach them.";

const when = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// Pull requests a task's agents opened: GitHub PR links in its description,
// history and results, with each PR's title and state from `gh` (cached a minute).
const PR_LINK = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
export function prLinks(t) {
  const text = [t?.description ?? "", ...(t?.history ?? []).map((h) => h.text ?? ""),
    ...(t?.runs ?? []).flatMap((r) => [r.result?.summary ?? "", r.blocked ?? ""])].join("\n");
  return [...new Set(text.match(PR_LINK) ?? [])];
}
const prInfo = {}; // url -> { number, title, state, isDraft, at } or { error, at }
async function loadPrs(urls) {
  let changed = false;
  for (const url of urls) {
    if (prInfo[url] && Date.now() - prInfo[url].at < 60000) continue;
    try {
      const r = await exec("gh", ["pr", "view", url, "--json", "number,title,state,isDraft"]);
      prInfo[url] = r.code === 0 ? { ...JSON.parse(r.stdout), at: Date.now() } : { error: (r.stderr || "gh failed").trim().split("\n")[0], at: Date.now() };
    } catch (e) { prInfo[url] = { error: String(e?.message ?? e), at: Date.now() }; }
    changed = true;
  }
  return changed;
}

export class TaskView extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.id = p.id ?? null;
    // The PRs' details: first from a timer (a spawn straight from a dialog's init
    // never finishes), then every minute.
    const prs = (cx) => cx.spawn(async (cx) => {
      if (this.prsLoading) return;
      this.prsLoading = true;
      try { if (await loadPrs(prLinks(task(this.id)))) cx.notify(); } catch {}
      this.prsLoading = false;
    });
    cx.timer.after(60, prs);
    cx.timer.every(60000, prs);
    this.editing = !this.id;
    this.busy = false;
    this.picking = false; // the file picker is open
    this.error = "";
    this.confirmDelete = false;
    this.pick = null; // "assign" | "move" | null
    this.handle = cx.focus_handle();
    this.focusedField = null;
    const t = this.id ? task(this.id) : null;
    this.draft = {
      title: t?.title ?? "", description: t?.description ?? "",
      space: t?.space ?? p.space ?? null, assignee: null, column: t?.column ?? "todo",
    };
    this.draft.assignee = t?.assignee ?? (team(this.ctx())[0]?.id ?? null);
    this.draft.dependsOn = [...(t?.dependsOn ?? [])];
    this.depFilter = InputState.new({ placeholder: "Filter this board's tasks" });
    this.depFilter.on("change", (_e, cx) => cx.notify());
    this.depFilter.on("focus", (_e, cx) => { this.focusedField = "depFilter"; cx.notify(); });
    this.depFilter.on("blur", (_e, cx) => { if (this.focusedField === "depFilter") this.focusedField = null; cx.notify(); });
    // A new task has no id until Save; its files go under the id it will get.
    if (!this.id) { this.pendingId = uid("k"); this.draft.attachments = []; }
    this.hint = "";
    this.title = InputState.new({ value: this.draft.title, placeholder: "What needs doing?" });
    this.title.on("change", (_e, cx) => { this.draft.title = this.title.value(); cx.notify(); });
    this.title.on("submit", (_e, cx) => this.save(false, cx));
    this.title.on("focus", (_e, cx) => { this.focusedField = "title"; cx.notify(); });
    this.title.on("blur", (_e, cx) => { if (this.focusedField === "title") this.focusedField = null; cx.notify(); });
    // Every change goes to the draft at once, so Esc or X loses nothing.
    this.desc = new MarkdownEditor({
      id: "desc", value: this.draft.description, height: 240,
      onChange: (md) => { this.draft.description = md; this.hint = ""; },
      onFocus: (cx) => { this.focusedField = "desc"; cx.notify(); },
      onBlur: (cx) => { if (this.focusedField === "desc") this.focusedField = null; cx.notify(); },
      onPasteOther: (cx) => { this.hint = "To attach a screenshot, save it as a file and drop it here."; cx.notify(); },
    });
    this.text = new TextBlocks(); // the note and description: Copy and Source
    this.answer = InputState.new({ placeholder: "Answer the agent, then Enter" });
    this.answer.on("submit", (_e, cx) => this.sendAnswer(cx));
    this.answer.on("focus", (_e, cx) => { this.focusedField = "answer"; cx.notify(); });
    this.answer.on("blur", (_e, cx) => { if (this.focusedField === "answer") this.focusedField = null; cx.notify(); });
    if (this.editing) { this.title.focus(); cx.timer.after(500, () => this.title.focus()); }
    else { this.handle.focus(); }
    cx.spawn(async (cx) => { await programs(); cx.notify(); });
  }

  // The board this task is on (or will be): what team() and member() mean here.
  ctx() {
    const t = this.id ? task(this.id) : null;
    if (t) return ctxOfTask(t);
    const b = boardOfSpace(this.spaceOf());
    return b ? { machine: b.machine, board: b.id } : null;
  }
  spaceOf() {
    const id = (this.id ? task(this.id)?.space : null) ?? this.draft?.space;
    return spaces().find((s) => s.id === id) ?? null;
  }
  machine() {
    const t = this.id ? task(this.id) : null;
    return t ? t.machine ?? null : this.spaceOf()?.machine ?? null;
  }

  // Called by the buttons and Esc, and by Herdr when the dialog goes: once.
  close() {
    if (this.closed) return;
    this.closed = true;
    this.desc?.release();
    this.text.release();
    // Files dropped on a new task that was never saved; after a copy that still runs.
    const machine = this.machine();
    const drop = () => { if (this.pendingId && !task(this.pendingId) && homeNow(machine)) exec("rm", ["-rf", `${homeNow(machine)}/tasks/${this.pendingId}`], { on: machine }).catch(() => {}); };
    if (this.busy && this.work) this.work.then(drop, drop); else drop();
    closeOverlay(props().overlay);
  }

  // The attachments the form shows: the saved task's, else the draft's.
  files() {
    return this.id ? attachments(task(this.id)) : (this.draft.attachments ?? []);
  }

  addFiles(paths, cx) {
    if (!paths?.length) return;
    if (this.busy) { this.hint = "A copy is still running. Attach these files again when it ends."; cx.notify(); return; }
    this.hint = "";
    this.run(cx, () => this.copyFiles(paths));
  }

  async copyFiles(paths) {
    if (this.id) { await attach(this.id, paths); return; }
    const got = await copyIn(this.machine(), this.pendingId, paths, new Set(this.draft.attachments.map((a) => a.name)));
    this.draft.attachments = [...this.draft.attachments, ...got];
  }

  removeFile(name, cx) {
    if (this.id) { this.run(cx, () => detach(this.id, name)); return; }
    this.draft.attachments = this.draft.attachments.filter((a) => a.name !== name);
    exec("rm", ["-f", `${filesDir(this.machine(), this.pendingId)}/${name}`], { on: this.machine() }).catch(() => {});
    cx.notify();
  }

  // The picker can stay open for minutes, so it does not hold busy: drops still work.
  browse(cx) {
    if (this.picking) return;
    this.picking = true; this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      let paths = [];
      try { paths = await pickFiles(); } catch (e) { this.error = String(e?.message ?? e); }
      this.picking = false;
      if (this.closed) return;
      if (paths === null) this.hint = DROP_HINT;
      else if (paths.length) this.addFiles(paths, cx);
      cx.notify();
    });
  }

  key(e, cx) {
    if (e.key === "escape") {
      if (this.pick) { this.pick = null; cx.notify(); }
      else if (this.busy && this.editing) { /* a copy runs: wait for it */ }
      else if (this.editing && this.id) { this.editing = false; cx.notify(); }
      else this.close();
      cx.stop_propagation();
    }
  }

  save(andStart, cx) {
    const d = this.draft;
    if (this.busy) return; // a copy still runs: its files must be in the task
    if (!d.title.trim()) { this.error = "Give the task a title."; cx.notify(); return; }
    const fields = { title: d.title.trim(), description: d.description, assignee: d.assignee, column: d.column,
      dependsOn: (d.dependsOn ?? []).filter((id) => task(id)) }; // gone ones drop out
    let done;
    if (this.id) done = updateTask(this.id, fields);
    else {
      const sp = this.spaceOf();
      if (!boardOfSpace(sp) || boardOfSpace(sp).taskWorktree) { this.error = "This space has no board to add to."; cx.notify(); return; }
      const made = newTask({ ...fields, id: this.pendingId, attachments: d.attachments ?? [] }, sp);
      this.id = made.id;
      this.pendingId = null;
      done = made.done;
    }
    this.editing = false;
    this.error = "";
    this.desc.setValue(d.description);
    this.run(cx, async () => { await done; this.text.refresh({ desc: task(this.id)?.description ?? "" }); if (andStart) await launch(task(this.id)); });
  }

  run(cx, work) {
    if (this.busy) return;
    this.busy = true; this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      const had = this.handle.is_focused();
      this.work = Promise.resolve().then(work);
      try { await this.work; } catch (e) { this.error = String(e?.message ?? e); }
      if (had) this.handle.focus();
      this.busy = false;
      cx.notify();
    });
  }

  sendAnswer(cx) {
    const text = this.answer.value();
    if (!text.trim()) return;
    this.run(cx, async () => { await reply(task(this.id), text); this.answer.set_value(""); this.text.hide("note"); });
  }

  // ---- the form ----

  form(t, cx) {
    const tm = theme();
    const d = this.draft;
    const members = team().map((m) => ({ id: m.id, label: `${m.name} · ${m.role}`, color: m.color }));
    const chosen = this.spaceOf();
    const board = boardOfSpace(chosen);
    const files = this.files();
    const text = d.description ?? "";
    return v_flex().size_full()
      .child(titleRow(this.id ? "Edit task" : "New task", closeButton("close", () => this.close(), { disabled: this.busy })))
      .child(v_flex().id("task-form").flex_1().min_h(0).overflow_y_scrollbar().pr(4)
      .child(label("Title"))
      .child(field(this.title, this.focusedField === "title"))
      .child(label("Description"))
      .child(this.desc.render(cx, { focused: this.focusedField === "desc" }))
      .child(div().pt(5).text_size(10.5).text_color(this.hint ? tm.foreground : tm.dim).child(this.hint
        || (!text.trim() ? "What, where, how to know it is done. Markdown; the preview shows it rendered." : "cmd-b, cmd-i, cmd-e, cmd-k format the selection. Drop files here to attach them.")))
      .child(label("Attachments"))
      .child(h_flex().flex_wrap().gap(6).items_end()
        .children(files.map((a, i) => fileChip(`att-${i}`, a, { remove: (_e, cx) => this.removeFile(a.name, cx) })))
        .child(tiny("attach", this.busy ? "Copying…" : this.picking ? "Choosing…" : "Attach…", (_e, cx) => this.browse(cx), { disabled: this.busy || this.picking })))
      .child(label("Board (the agents work in its folder)"))
      .child(board || t
        ? h_flex().items_center().gap(8).text_size(12).child(div().text_color(tm.foreground).font_medium().child(chosen?.name ?? "")).child(div().min_w(0).truncate().text_size(11).text_color(tm.dim).child(`${this.machine() ? `${this.machine()}:` : ""}${board?.folder ?? t?.folder ?? ""}`))
        : div().text_size(12).text_color(tm.blocked).child("This board's space is closed. Reopen the project to start the task."))
      .child(label("First on it"))
      .child(chips("as", [...members, { id: "", label: "nobody yet" }], d.assignee ?? "", (id, cx) => { d.assignee = id || null; cx.notify(); }))
      .child(label("Column"))
      .child(chips("co", COLUMNS.filter((c) => c.id !== "doing").map((c) => ({ id: c.id, label: c.name })), d.column, (id, cx) => { d.column = id; cx.notify(); }))
      .child(label("Depends on (it starts only when these are in Review or Done)"))
      .child(this.depPicker({ id: this.id ?? this.pendingId, machine: this.machine(), board: t?.board ?? board?.id })))
      .when(Boolean(this.error), (el) => el.child(div().pt(8).text_size(12).text_color(tm.blocked).child(this.error)))
      .child(h_flex().pt(14).gap(8).justify_end()
        .child(button("cancel", "Cancel", (_e, cx) => { if (this.id) { this.editing = false; cx.notify(); } else this.close(); }, { disabled: this.busy }))
        .child(button("save", "Save", (_e, cx) => this.save(false, cx), { disabled: this.busy }))
        .when(Boolean(d.assignee), (el) => el.child(button("save-start", `Save & start ${member(d.assignee)?.name ?? ""}`, (_e, cx) => this.save(true, cx), { primary: true, disabled: this.busy }))));
  }

  // The tasks this one waits for: picked from the board's other tasks. One that
  // would make a loop (it waits for this task, maybe through others) is not offered.
  depPicker(self) {
    const tm = theme();
    const d = this.draft;
    const mates = boardMates(self);
    const chosen = (d.dependsOn ?? []).map((id) => mates.find((x) => x.id === id)).filter(Boolean);
    const q = (this.depFilter?.value() ?? "").trim().toLowerCase();
    const offer = mates.filter((x) => !d.dependsOn.includes(x.id) && !depLoops(self.id, x.id) && (!q || x.title.toLowerCase().includes(q))).slice(0, 8);
    const colTag = (x) => div().flex_none().text_size(10.5).text_color(DEP_DONE.has(x.column) ? tm.working : tm.dim).child(column(x.column).name);
    return v_flex().gap(6)
      .child(h_flex().flex_wrap().gap(6)
        .children(chosen.map((x) => h_flex().id(`dep-${x.id}`).gap(6).items_center().px(8).py(3).rounded(6).bg(tm.raised).border_1().border_color(tm.border)
          .child(div().text_size(12).text_color(tm.foreground).child(x.title))
          .child(colTag(x))
          .child(div().id(`dep-x-${x.id}`).px(2).text_size(12).text_color(tm.dim).cursor_pointer().hover((st) => st.text_color(tm.foreground))
            .on_click((_e, cx) => { d.dependsOn = d.dependsOn.filter((i) => i !== x.id); cx.notify(); }).child("✕"))))
        .when(!chosen.length, (el) => el.child(div().text_size(12).text_color(tm.dim).child("None: it can start any time."))))
      .when(mates.length > 0, (el) => el
        .child(div().w(280).child(field(this.depFilter, this.focusedField === "depFilter", { h: 28 })))
        .child(v_flex().gap(1).children(offer.map((x) => h_flex().id(`dep-add-${x.id}`).items_center().gap(8).px(6).py(4).rounded(6).cursor_pointer()
          .hover((st) => st.bg(tm.hover))
          .on_click((_e, cx) => { d.dependsOn = [...d.dependsOn, x.id]; cx.notify(); })
          .child(div().text_size(12).text_color(tm.accent).child("+"))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(tm.foreground).child(x.title))
          .child(colTag(x))))))
      .when(!mates.length, (el) => el.child(div().text_size(11).text_color(tm.dim).child("No other tasks on this board yet.")));
  }

  depList(t) {
    const tm = theme();
    return v_flex().gap(2).children((t.dependsOn ?? []).map((id, i) => {
      const x = task(id);
      const ok = !x || DEP_DONE.has(x.column);
      return h_flex().id(`depl-${i}`).items_center().gap(8).px(6).py(4).rounded(6)
        .when(Boolean(x), (el) => el.cursor_pointer().hover((st) => st.bg(tm.hover))
          .on_click(() => openOverlay({ mod: MOD, kind: "dialog", width: 700, height: 740, props: { view: "task", id } })))
        .child(dot(ok ? tm.working : tm.blocked, 7))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(tm.foreground).child(x?.title ?? "(deleted: counts as done)"))
        .child(div().flex_none().text_size(11).text_color(ok ? tm.working : tm.dim).child(x ? column(x.column).name : ""));
    }));
  }

  // ---- the details ----

  runRow(t, r, i) {
    const tm = theme();
    const m = member(r.member);
    const status = r.ended ? null : runStatus(r);
    const pane = paneOf(r);
    const live = isLive(r);
    // A live terminal: running, or ended and waiting for follow-up questions.
    const reach = live && !r.closed;
    const what = r.result
      ? r.result.action === "handoff" ? `→ ${member(r.result.to)?.name ?? r.result.to ?? "?"}` : r.result.action
      : r.ended ? (r.exit ?? "ended") : (STATUS_WORDS[status] ?? "starting");
    return h_flex().items_center().gap(8).h(30).px(8).rounded(6).text_size(11.5).when(i % 2 === 1, (el) => el.bg(tm.surface))
      .child(div().w(18).text_color(tm.dim).child(`#${i + 1}`))
      .child(memberChip(m, { short: true }))
      .child(div().text_color(tm.dim).child(when(r.started)))
      .child(div().flex_1().min_w(0).truncate().text_color(r.result?.action === "blocked" ? tm.blocked : tm.muted).child(what))
      .when(Boolean(r.background) && !pane && reach, (el) => el.child(div().text_size(10.5).text_color(tm.dim).child("background")))
      .when(Boolean(status), (el) => el.child(statusGlyph(status, 10)))
      .when(reach, (el) => el
        .child(tiny(`peek-${r.id}`, "Peek", () => run("terminal.peek", { terminal: r.terminal })))
        .child(tiny(`go-${r.id}`, pane ? "Go to" : "Open as tab", () => { this.close(); goTo(r, `${t.title} · ${m?.name ?? "run"}`, t); })))
      .when(reach && !r.ended, (el) => el
        .child(tiny(`stop-${r.id}`, "Stop", (_e, cx) => this.run(cx, () => endRun(t.id, r.id, "stopped")), { danger: true })))
      .when(!reach && !r.background && Boolean(r.tab) && Boolean(r.ended), (el) => el.child(tiny(`go-${r.id}`, "Open tab", () => { this.close(); goTo(r); })));
  }

  prList(t) {
    const tm = theme();
    const look = { OPEN: ["Open", tm.working], MERGED: ["Merged", tm.accent], CLOSED: ["Closed", tm.dim] };
    return v_flex().gap(2).children(prLinks(t).map((url, i) => {
      const p = prInfo[url];
      const num = url.split("/").pop();
      const [word, color] = p?.isDraft && p.state === "OPEN" ? ["Draft", tm.muted] : look[p?.state] ?? [p?.error ? "?" : "…", tm.dim];
      return h_flex().id(`pr-${i}`).items_center().gap(8).px(6).py(4).rounded(6).cursor_pointer()
        .hover((s) => s.bg(tm.hover))
        .on_click(() => { openFile(url).catch(() => {}); }) // xdg-open on Linux (state.js)
        .child(div().flex_none().text_size(12).font_medium().text_color(tm.accent).child(`#${num}`))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(tm.foreground).child(p?.title ?? url.replace("https://github.com/", "")))
        .child(div().flex_none().text_size(11).text_color(color).child(word));
    }));
  }

  details(t) {
    const tm = theme();
    const m = member(t.assignee);
    const active = activeRun(t);
    const status = active ? runStatus(active) : null;
    const space = spaces().find((s) => s.id === t.space);
    const col = column(t.column);
    const prog = knownNow().find((p) => p.key === m?.program);
    const hist = [...(t.history ?? [])].reverse();
    const blockedNow = status === "blocked" || (active && t.attention);
    const canStart = Boolean(m) && !active && !depsOpen(t).length;
    const needsYou = Boolean(t.attention) || status === "blocked";
    const actions = h_flex().flex_wrap().gap(6).items_center()
      .when(needsYou, (el) => el.child(button("unblock", "Unblock in tab ↗", (_e, cx) => this.run(cx, async () => { await unblockInTab(task(t.id)); this.close(); }), { primary: true, disabled: this.busy })))
      .when(canStart, (el) => el.child(button("start", `▶ Start ${m.name}`, (_e, cx) => this.run(cx, () => launch(task(t.id))), { primary: true, disabled: this.busy })))
      .when(Boolean(active), (el) => el
        .child(button("restart", "↻ Restart", (_e, cx) => this.run(cx, () => restart(task(t.id))), { disabled: this.busy }))
        .child(button("nudge", "Nudge", (_e, cx) => this.run(cx, () => nudge(task(t.id))), { disabled: this.busy })))
      .child(button("assign", `Assign ${this.pick === "assign" ? "▴" : "▾"}`, (_e, cx) => { this.pick = this.pick === "assign" ? null : "assign"; cx.notify(); }))
      .child(button("move", `${col.name} ${this.pick === "move" ? "▴" : "▾"}`, (_e, cx) => { this.pick = this.pick === "move" ? null : "move"; cx.notify(); }))
      .child(button("edit", "Edit", (_e, cx) => { this.editing = true; this.title.set_value(t.title); this.desc.setValue(t.description ?? ""); this.hint = ""; this.draft = { ...this.draft, title: t.title, description: t.description ?? "", space: t.space, assignee: t.assignee, column: t.column, dependsOn: [...(t.dependsOn ?? [])] }; cx.notify(); this.title.focus(); }))
      .when((t.runs ?? []).some(leftOver), (el) => el.child(button("tidy", "Close finished runs", (_e, cx) => this.run(cx, () => tidy(task(t.id))))))
      .child(div().flex_1())
      .child(button("delete", this.confirmDelete ? "Really delete" : "Delete", (_e, cx) => {
        if (!this.confirmDelete) { this.confirmDelete = true; cx.notify(); return; }
        removeTask(t.id).catch(() => {});
        this.close();
      }, { danger: true }));
    const picker = this.pick === "assign"
      ? chips("pa", team().map((x) => ({ id: x.id, label: `${x.name} · ${x.role}`, color: x.color })), t.assignee, (id, cx) => {
          this.pick = null; this.run(cx, () => updateTask(t.id, { assignee: id }));
        })
      : this.pick === "move"
        ? chips("pm", COLUMNS.map((c) => ({ id: c.id, label: c.name })), t.column, (id, cx) => {
            this.pick = null;
            this.run(cx, async () => { await updateTask(t.id, { column: id }); if (id === "doing" && m && !active) await launch(task(t.id)); });
          })
        : null;
    return v_flex().size_full()
      .child(titleRow(t.title, h_flex().items_center().gap(8)
        .when(Boolean(status), (el) => el.child(h_flex().items_center().gap(5).text_size(11).text_color(status === "blocked" ? tm.blocked : tm.dim).child(STATUS_WORDS[status] ?? status).child(statusGlyph(status))))
        .child(closeButton("close", () => this.close()))))
      .child(h_flex().pt(6).items_center().gap(10).text_size(11.5)
        .child(h_flex().items_center().gap(5).px(7).py(2).rounded(5).bg(tm.raised).text_color(tm.muted).child(col.name))
        .child(memberChip(m))
        .when(Boolean(prog), (el) => el.child(h_flex().items_center().gap(4).text_color(tm.dim).child(programIcon(prog, 12)).child(prog.name)))
        .when(Boolean(m?.model), (el) => el.child(div().text_color(tm.dim).child(m.model)))
        .child(div().flex_1())
        .when(Boolean(space), (el) => el.child(div().text_color(tm.dim).truncate().child(`${space.name}`))))
      .when(Boolean(this.error), (el) => el.child(div().mt(8).p(8).rounded(6).bg(tm.surface).text_size(12).text_color(tm.blocked).child(this.error)))
      .when(Boolean(t.attention), (el) => el.child(this.text.noteBox(t)))
      .when(status === "limited", (el) => el.child(div().mt(8).p(8).rounded(6).bg(tm.surface).text_size(12).text_color(tm.muted).child(limitLine(runLimit(active), m?.name))))
      .when(Boolean(blockedNow && active), (el) => el.child(h_flex().mt(6).gap(6).items_center()
        .child(div().flex_1().child(field(this.answer, this.focusedField === "answer", { h: 30 })))
        .child(tiny("answer-go", "Send", (_e, cx) => this.sendAnswer(cx)))
        .child(tiny("answer-peek", "Peek", () => run("terminal.peek", { terminal: active.terminal })))))
      .child(v_flex().id("task-scroll").flex_1().min_h(0).overflow_y_scrollbar().pr(4)
        .child(section("Description", this.text.descTools(t)))
        .child(this.text.descBox(t))
        .when(prLinks(t).length > 0, (el) => el.child(section("Pull requests")).child(this.prList(t)))
        .when((t.dependsOn ?? []).length > 0, (el) => el.child(section("Depends on", depsOpen(t).length ? div().text_size(11).text_color(tm.dim).child("waits until all are in Review or Done") : null)).child(this.depList(t)))
        .when(attachments(t).length > 0, (el) => el
          .child(section("Attachments"))
          .child(h_flex().flex_wrap().gap(6).items_start().children(attachments(t).map((a, i) =>
            fileChip(`att-${i}`, a, t.machine ? {} : { open: () => { openFile(fileOf(t, a)).catch(() => {}); } })))))
        .child(section("Runs", div().text_size(11).text_color(tm.dim).truncate().child(where(t))))
        .when(Boolean(t.worktree?.path), (el) => el.child(h_flex().items_center().gap(8).pb(6).text_size(11.5)
          .child(div().flex_1().min_w(0).truncate().text_color(tm.muted).child(`⎇ ${t.worktree.branch} · ${t.machine ? `${t.machine}:` : ""}${t.worktree.path}`))
          .when(!active, (el) => el.child(tiny("wt-remove", "Remove worktree", (_e, cx) => this.run(cx, () => removeWorktree(task(t.id))))))))
        .children((t.runs ?? []).map((r, i) => this.runRow(t, r, i)))
        .when(!(t.runs ?? []).length, (el) => el.child(div().text_size(12).text_color(tm.dim).child("Nobody has worked on it yet.")))
        .child(section("History"))
        .children(hist.map((h, i) => {
          const who = member(h.member);
          return h_flex().items_start().gap(8).py(4).text_size(11.5)
            .child(div().flex_none().w(36).text_color(tm.dim).child(when(h.at)))
            .child(dot(who ? colorOf(tm, who.color) : tm.dim, 7).mt(5))
            .child(div().flex_1().min_w(0).text_color(tm.muted).child(h.text));
        }))
        .when(!hist.length, (el) => el.child(div().text_size(12).text_color(tm.dim).child("Nothing yet."))))
      .when(Boolean(picker), (el) => el.child(div().pt(10).child(picker)))
      .child(div().pt(12).child(actions));
  }

  render(cx) {
    const tm = theme();
    const t = this.id ? task(this.id) : null;
    const body = this.editing || !t ? this.form(t, cx) : this.details(t);
    return v_flex().id("task-view").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_drop((e, cx) => this.addFiles(e.paths, cx))
      .size_full().p(18).bg(tm.popover).text_color(tm.foreground).text_size(12.5)
      .child(body);
  }
}
