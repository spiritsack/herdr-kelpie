// The Herdr board: tasks on a kanban board, worked on by a team of preconfigured
// agents that hand tasks on to each other. One mod, several views:
//   (no view)       the board itself (a window from mod.open, or a tab pane)
//   view: "task"    one task: new (no id), or its details and actions
//   view: "team"    the team editor
//   view: "machine" a machine's last hour, gate, slots and settings
//   view: "cardmenu" a card's right-click menu
import { View, div } from "gpui-kit";
import { props } from "herdr";
import { Board } from "./board.js";
import { within, loadStates, statesReady } from "./state.js";
import { TaskView } from "./task.js";
import { TeamsView } from "./team.js";
import { EnvView } from "./env.js";
import { MachineView } from "./machine.js";
import { CardMenu } from "./cardmenu.js";

const VIEWS = { task: TaskView, team: TeamsView, teams: TeamsView, env: EnvView, machine: MachineView, cardmenu: CardMenu };

export default class Main extends View {
  init(p, cx) {
    // The engine states, kept in this view's memory: read again when a seq moved.
    // A view is made once they are read, so it opens on the real teams and tasks.
    const start = (cx, later) => {
      if (this.inner) return;
      const Inner = VIEWS[props()?.view] ?? Board;
      this.inner = new Inner(p);
      this.inner.init?.(p, cx);
      if (later) cx.notify();
    };
    const load = (cx) => cx.spawn(async (cx) => {
      if (this.loading) return;
      this.loading = true;
      let changed = false;
      try { changed = await loadStates(); } catch {}
      this.loading = false;
      if (!this.inner && (statesReady() || Date.now() - this.born > 5000)) start(cx, true);
      else if (changed) cx.notify();
    });
    this.born = Date.now();
    if (statesReady()) start(cx);
    // The first load from a timer: one spawned straight from init never finishes
    // in a dialog (seen with Herdr 0.1.10), and its busy flag would block the rest.
    cx.timer.after(30, load);
    cx.timer.every(1000, load);
  }
  render(cx) {
    if (!this.inner) return div().size_full();
    // A render changes nothing: the live lists, tasks and team are read once for it.
    return within(() => this.inner.render(cx), true, this.inner.ctx?.() ?? null);
  }
  close(cx) {
    return this.inner?.close?.(cx);
  }
}
