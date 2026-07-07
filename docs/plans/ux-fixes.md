# Plan — UX fixes

**Status:** planned, not started. Front-end only — no Firebase, security-rule,
or data-model changes.

## Decisions (from Q&A)

- **Table counting:** a pick counts toward the league table as soon as *its
  own* result is recorded (per-pick), not when the whole gameweek finishes.
- **Layout:** tabs on **all devices** — `Pick · Table · History · Rules`
  (+ `Admin` when signed in as admin).
- **Rules:** an in-app **Rules tab**; chip descriptions rendered from
  `CHIPS` (config) so they can't drift from the actual game.
- **Fixtures:** shown on the **Pick tab**, near the pick controls (so they're
  visible where you make your pick) — not a separate tab.

## Item by item

### 1 & 2 — League table should only reflect scored picks

- **Problem:** the new **Chips** column increments for *any* pick carrying a
  chip, including the current unscored gameweek. And because current-gameweek
  picks are only visible to their owner before the deadline (security rules),
  the table is skewed asymmetrically — you see your own in-progress chip, but
  not others'. (Points/played are already ~0 for unscored picks; chips are the
  visible leak.)
- **Fix:** in `renderLeaderboard` (`js/render.js`), only count a chip in the
  **Chips** column when the pick produced a *real* result — i.e. gate
  `t.chips.push(...)` on `didPlay` (win/draw/loss). Points, played, won,
  chipPts and bonusPts already resolve to 0 / don't increment for unscored
  picks, and form still shows `F` for a forfeit. So this single gate makes the
  Chips column exclude **both** the current unscored gameweek *and* forfeited
  weeks — covering "chips only after scored" and "forfeit chip doesn't count"
  at once. Isolated to one function; `scoring.js` untouched.
- **Forfeit chip isn't consumed either.** "Doesn't count" should also mean the
  chip is re-playable (mirroring how a forfeited team is freed, not wasted). In
  `renderChipRow`, exclude forfeited gameweeks from the `spentThisHalf` calc so
  the chip isn't locked as "used GWx". This needs forfeit info in the chip row:
  compute a "chips spent this half, excluding forfeited weeks" view in
  `loadEverything` (where results are available) and read it in `renderChipRow`.

### 5 — Tabs instead of one big scroll (the structural base)

- Add a tab bar; each section becomes a tab panel:
  `Pick` · `Table` · `History` · `Rules` (+ `Admin`, admin-only).
- **Fixtures live inside the Pick tab** (see item 3).
- **Desktop:** keep tabs, and inside the Pick tab keep the existing two-column
  `.layout` (pick controls + fixtures rail on the right).
- **Mobile:** single column; on the Pick tab fixtures stack right by the pick
  controls (the existing responsive grid already collapses the rail under the
  main column — which now sits on the Pick tab).
- **Implementation:** small vanilla tab controller (new `js/tabs.js`, or folded
  into `app.js`): clicking a tab toggles an `.active` class on the matching
  panel + button. `role="tablist"/tab/tabpanel` + arrow-key nav for
  accessibility. Render functions are unchanged — they still target the same
  element IDs, which now live inside panels.
- **History tab:** hidden until there's any history (today `history-card`
  self-hides when empty); the tab button hides too until data exists.
- **Admin tab:** the two admin cards move into an Admin tab, shown only to the
  admin.
- **Files:** `index.html` (nav + wrap sections in panels), `styles.css` (tab
  bar + active states), `js/tabs.js` (controller), `js/app.js` (init on boot).

### 3 — Fixtures near the pick

- Folded into the Pick tab (above/beside the pick controls), satisfying
  "visible near where the person makes their pick." No separate Fixtures tab.
- Purely a placement/markup change once tabs exist; `renderFixtures` is
  unchanged.

### 4 — Rules tab

- New Rules tab with hand-written house rules (picking, no-repeat until GW20,
  unique-pick bonus, scoring, forfeits, double gameweeks) sourced from
  `docs/SETUP.md`.
- The **chips section is generated from `CHIPS`** (config) via a small
  `renderRules()` (reusing the `chip-desc` styling), so it always matches the
  live chip set and descriptions.
- **Files:** `index.html` (Rules panel skeleton + prose), `js/render.js` or a
  new `js/rules.js` (`renderRules()` from `CHIPS`).

## Sequencing

1. **Tabs shell** — panels + nav + controller + styles (structural base).
2. **Fixtures into the Pick tab**; verify responsive placement.
3. **Rules tab** — prose + chips generated from `CHIPS`.
4. **League-table scored-only fix** — the `renderLeaderboard` gate.
5. **Admin tab** — move the admin cards.

## Verification

- Headless-Chrome smoke (module graph loads clean, sign-in gate renders), as
  used for the modularisation.
- Manual: click through tabs; check fixtures sit by the pick on a phone width;
  confirm setting a chip on the *open* (unscored) gameweek does **not** bump
  the Chips column or points until that pick has a result.

## Open questions / defaults

- **History tab** hidden until there's history — default yes.
- **Chip on a forfeited week** — **does not count** (Chips column *and* not
  consumed from the once-per-half allowance). Decided.
- **Remember last-open tab** across reloads (sessionStorage) — default no;
  always open on Pick.
