// A card's right-click menu (a popup at the pointer): talk to the card's champion, or open the card.
import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, props, closeOverlay, openOverlay, notify } from "herdr";
import { MOD, task, championOf } from "./state.js";
import { talkToCard, closeChampion } from "./task.js";

export class CardMenu extends View {
  init() {}
  close() { closeOverlay(props()?.overlay); }
  item(id, text, action, disabled = false) {
    const tm = theme();
    return div().id(id).w_full().px(10).py(6).rounded(6).text_size(12.5)
      .text_color(disabled ? tm.dim : tm.foreground)
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(tm.hover)).on_click((_e, cx) => action(cx)))
      .child(text);
  }
  render() {
    const t = task(props()?.id);
    if (!t) return div().p(10).text_size(12).child("This card is gone.");
    return v_flex().size_full().p(4).gap(2)
      .child(this.item("talk", t.machine ? "Talk to card champion (this machine only)" : "Talk to card champion", (cx) => {
        // Close after the start: a spawn in a closed overlay may never finish.
        cx.spawn(async () => {
          try { await talkToCard(task(t.id)); }
          catch (e) { notify({ title: "Talk to card", body: String(e?.message ?? e).slice(0, 200), level: "error", timeout: 8000 }); }
          this.close();
        });
      }, Boolean(t.machine)))
      .when(Boolean(championOf(t)), (el) => el.child(this.item("close-champion", "Close champion conversation", (cx) => {
        cx.spawn(async () => {
          try { await closeChampion(task(t.id)); }
          catch (e) { notify({ title: "Close champion", body: String(e?.message ?? e).slice(0, 200), level: "error", timeout: 8000 }); }
          this.close();
        });
      })))
      .child(this.item("open", "Open card", () => {
        this.close();
        openOverlay({ mod: MOD, kind: "dialog", width: 700, height: 740, props: { view: "task", id: t.id } });
      }));
  }
}
