// ---------------------------------------------------------------------------
// Minimal tab controller. Toggles `.active` on the tab buttons and their
// matching panels (`#tab-<id>`). Hidden buttons (History/Admin, revealed
// elsewhere) are just skipped. Arrow keys move between tabs.
// ---------------------------------------------------------------------------
import { store } from "./store.js";

export function initTabs() {
  const nav = document.getElementById("tab-nav");
  if (!nav) return;
  const buttons = [...nav.querySelectorAll("[data-tab]")];

  const select = (id) => {
    buttons.forEach(b => {
      const on = b.dataset.tab === id;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll(".tab-panel").forEach(p => {
      p.classList.toggle("active", p.id === `tab-${id}`);
    });
  };

  buttons.forEach(b => { b.onclick = () => select(b.dataset.tab); });

  nav.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const visible = buttons.filter(b => b.style.display !== "none");
    const cur = visible.findIndex(b => b.classList.contains("active"));
    if (cur < 0) return;
    const next = e.key === "ArrowRight"
      ? (cur + 1) % visible.length
      : (cur - 1 + visible.length) % visible.length;
    visible[next].focus();
    select(visible[next].dataset.tab);
    e.preventDefault();
  });

  store.selectTab = select;   // let other modules jump to a tab (e.g. the season nudge)
  select("pick");   // default tab
}
