# Plan — Custom display names

**Status:** planned, not started. Small front-end + one new collection + a
rules addition.

Let players show a chosen name instead of their Google account name, with the
admin able to override any name.

## Decisions (from Q&A)
- **Self-service:** each user sets their own display name. ✅
- **Admin override:** the admin can also set/fix any player's name. ✅

## Storage

- New `profiles/{uid}` doc — `{ uid, email, name }`. One per player.
- Names are resolved at **render time** from `profiles`, not from the `name`
  baked into each pick. That way a name change applies **everywhere**
  (sheet, league table, history, This Week) including past gameweeks, instead
  of only affecting future picks. Picks still store `name` as a harmless
  fallback for anyone without a profile.

## Firestore rules

```
match /profiles/{uid} {
  allow read: if isAllowed();
  allow write: if (isAllowed() && request.auth.uid == uid) || isAdmin();
}
```
Owner can edit their own; admin can edit anyone's.

## Front-end

- **Name resolution:** in `loadEverything`, fetch `profiles` once and build a
  `uid -> name` map on `store` (e.g. `store.names`). Rendering that currently
  shows `p.name` uses `store.names[p.uid] || p.name` instead. Touches
  `renderSheet`, `renderLeaderboard`, `renderHistory`, `renderThisWeek`, and
  the `whoami` line.
- **Self-service editor:** a small "Display name" field (e.g. on the This Week
  tab, or a lightweight profile row in the status bar) that writes
  `profiles/{uid}.name` and reloads. Defaults to the Google `displayName`.
- **Admin override:** in the Admin tab, list the players (from `profiles` +
  seen pick uids) with an editable name field each; saving writes
  `profiles/{uid}.name` (admin may write any uid).

## Validation / edge cases

- Trim + length-cap the name (e.g. 1–24 chars); reject empty.
- Uniqueness not enforced (two people can share a name) — keep it simple.
- A user with no profile falls back to their pick's stored `name`, then to the
  Google `displayName`.

## Sequencing

1. Rules: add the `profiles/{uid}` match.
2. `loadEverything`: fetch profiles → `store.names`; swap `p.name` lookups to
   use it across the render functions.
3. Self-service name field + save.
4. Admin-tab name overrides.
