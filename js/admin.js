// ---------------------------------------------------------------------------
// Admin-only panels: the manual result override, and the guest-list (allowlist)
// manager. Only wired up when the signed-in account is the admin (see app.js).
// ---------------------------------------------------------------------------
import { TEAMS } from "./config.js";
import { db, doc, getDoc, setDoc } from "./firebase.js";
import { store } from "./store.js";

export function setupAdminPanel() {
  const teamSelect = document.getElementById("admin-team");
  teamSelect.innerHTML = TEAMS.map(t => `<option value="${t}">${t}</option>`).join("");

  document.getElementById("admin-submit").onclick = async () => {
    const msg = document.getElementById("admin-msg");
    const gw = parseInt(document.getElementById("admin-gw").value, 10);
    const team = teamSelect.value;
    const result = document.getElementById("admin-result").value;
    const append = document.getElementById("admin-append").checked;
    const goalsRaw = document.getElementById("admin-goals").value;
    const concededRaw = document.getElementById("admin-conceded").value;
    // Goals for/against this team in this fixture -- needed for the
    // Goalfest (for) and Scorecard (both) chips. Optional: blank -> 0.
    const goal = goalsRaw === "" ? 0 : parseInt(goalsRaw, 10);
    const conceded = concededRaw === "" ? 0 : parseInt(concededRaw, 10);

    if (!gw) {
      msg.textContent = "Enter a gameweek number.";
      msg.className = "msg error";
      return;
    }

    const docId = `gw${gw}_${team.replace(/\s+/g, "_")}`;
    try {
      let resultsArr = [result];
      let goalsArr = [goal];
      let concededArr = [conceded];
      if (append) {
        const existing = await getDoc(doc(db, "results", docId));
        if (existing.exists() && existing.data().source === "manual") {
          resultsArr = [...(existing.data().results || []), result];
          goalsArr = [...(existing.data().goals || []), goal];
          concededArr = [...(existing.data().conceded || []), conceded];
        }
        // if it doesn't exist yet, or was API-sourced, "append" just
        // starts a fresh manual array with this one entry
      }
      // source: "manual" marks this so pull_results.py will never
      // silently overwrite it on a later automated run.
      await setDoc(doc(db, "results", docId), {
        gameweek: gw, team, results: resultsArr, goals: goalsArr, conceded: concededArr, source: "manual",
      });
      msg.textContent = `Saved: GW${gw} ${team} → [${resultsArr.join(", ")}] ${goalsArr.join("/")}–${concededArr.join("/")}`;
      msg.className = "msg ok";
      document.getElementById("admin-gw").value = "";
      document.getElementById("admin-goals").value = "";
      document.getElementById("admin-conceded").value = "";
      document.getElementById("admin-append").checked = false;
      await store.reload();
    } catch (e) {
      msg.textContent = `Couldn't save: ${e.message}`;
      msg.className = "msg error";
    }
  };
}

export function renderAdminRecent(resultsDocs) {
  const el = document.getElementById("admin-recent");
  if (!el) return;
  const manual = resultsDocs.filter(r => r.source === "manual");
  if (manual.length === 0) {
    el.innerHTML = `<p class="empty">No manual overrides yet.</p>`;
    return;
  }
  el.innerHTML = manual
    .sort((a, b) => b.gameweek - a.gameweek)
    .map(r => `<div class="pick-tile"><span class="mono" style="font-size:0.78rem;">GW${r.gameweek} — ${r.team} — [${(r.results || []).join(", ")}]</span></div>`)
    .join("");
}

// Admin-only: manage config/allowlist. Emails are stored lower-cased so
// matching against the signed-in Google email is consistent. The admin's
// own email is always allowed by the rules even if it isn't in the list.
export async function loadAllowlist() {
  const snap = await getDoc(doc(db, "config", "allowlist"));
  const emails = (snap.exists() && snap.data().emails) || [];
  // Dedupe + lower-case defensively, and keep it sorted for display.
  return [...new Set(emails.map(e => (e || "").toLowerCase()))].sort();
}

export function setupAccessPanel() {
  const input = document.getElementById("allow-email");
  const msg = document.getElementById("allow-msg");

  const save = async (emails) => {
    await setDoc(doc(db, "config", "allowlist"), { emails }, { merge: true });
  };

  document.getElementById("allow-add").onclick = async () => {
    const email = input.value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      msg.textContent = "Enter a valid email address.";
      msg.className = "msg error";
      return;
    }
    try {
      const emails = await loadAllowlist();
      if (emails.includes(email)) {
        msg.textContent = `${email} is already on the list.`;
        msg.className = "msg";
      } else {
        emails.push(email);
        await save(emails.sort());
        msg.textContent = `Added ${email}.`;
        msg.className = "msg ok";
        input.value = "";
      }
      renderAllowlist(await loadAllowlist());
    } catch (e) {
      msg.textContent = `Couldn't save: ${e.message}`;
      msg.className = "msg error";
    }
  };

  // Remove buttons are wired up via event delegation in renderAllowlist.
  document.getElementById("allow-list").onclick = async (ev) => {
    const btn = ev.target.closest("button[data-remove]");
    if (!btn) return;
    const email = btn.getAttribute("data-remove");
    try {
      const emails = (await loadAllowlist()).filter(e => e !== email);
      await save(emails);
      msg.textContent = `Removed ${email}.`;
      msg.className = "msg ok";
      renderAllowlist(emails);
    } catch (e) {
      msg.textContent = `Couldn't save: ${e.message}`;
      msg.className = "msg error";
    }
  };

  loadAllowlist().then(renderAllowlist).catch(() => {});
}

// Admin-only: override any player's display name. Writes profiles/{uid}
// (admin may write any uid per the rules). Blank name = they fall back to
// their own / Google name.
export function renderAdminNames(players) {
  const el = document.getElementById("admin-names-list");
  if (!el) return;
  if (!players || players.length === 0) {
    el.innerHTML = `<p class="empty">No players yet — names can be set once people have signed in or picked.</p>`;
    return;
  }
  el.innerHTML = players
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    .map(p => `<div class="pick-tile" style="display:flex; align-items:center; gap:0.5rem; justify-content:space-between;">
      <span class="mono" style="font-size:0.72rem; flex:1; min-width:8rem; overflow:hidden; text-overflow:ellipsis;">${p.email || p.uid}</span>
      <input type="text" maxlength="24" value="${(p.name || "").replace(/"/g, "&quot;")}" data-uid="${p.uid}" data-email="${p.email || ""}" style="padding:0.35rem; font-family:'JetBrains Mono',monospace; width:9rem;" />
      <button class="ghost" data-save="${p.uid}" style="padding:0.2rem 0.6rem; font-size:0.75rem;">Save</button>
    </div>`).join("");

  el.onclick = async (ev) => {
    const btn = ev.target.closest("button[data-save]");
    if (!btn) return;
    const uid = btn.getAttribute("data-save");
    const input = el.querySelector(`input[data-uid="${uid}"]`);
    try {
      await setDoc(doc(db, "profiles", uid), {
        uid, email: input.getAttribute("data-email") || "", name: input.value.trim(),
      }, { merge: true });
      await store.reload();
    } catch (e) {
      alert(`Couldn't save name: ${e.message}`);
    }
  };
}

// Admin-only: set the season-predictions lock date, and (at season end) the
// correct Golden Boot + champion. `players` powers the Golden Boot picker.
function toLocalInput(d) {
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function setupSeasonAdmin(players, season, results) {
  const msg = document.getElementById("admin-season-msg");
  const champSel = document.getElementById("admin-champion");
  const dInput = document.getElementById("admin-season-deadline");
  const gbInput = document.getElementById("admin-gb");
  const dl = document.getElementById("admin-players-datalist");
  const byLabel = new Map();
  (players || []).forEach(p => byLabel.set(`${p.name} (${p.team})`, p));

  if (champSel && champSel.options.length === 0) {
    champSel.innerHTML = `<option value="">— none —</option>` + TEAMS.map(t => `<option value="${t}">${t}</option>`).join("");
  }
  if (dl) {
    dl.innerHTML = (players || []).map(p => `<option value="${`${p.name} (${p.team})`.replace(/"/g, "&quot;")}"></option>`).join("");
  }
  if (dInput && season && season.predictionsDeadline && season.predictionsDeadline.toDate) {
    dInput.value = toLocalInput(season.predictionsDeadline.toDate());
  }
  if (gbInput && results && results.goldenBootName) {
    const p = (players || []).find(x => x.id === results.goldenBootId);
    gbInput.value = p ? `${p.name} (${p.team})` : results.goldenBootName;
  }
  if (champSel && results && results.champion) champSel.value = results.champion;

  const dSave = document.getElementById("admin-season-deadline-save");
  if (dSave) dSave.onclick = async () => {
    if (!dInput.value) { msg.textContent = "Pick a date & time."; msg.className = "msg error"; return; }
    try {
      await setDoc(doc(db, "config", "season"), { predictionsDeadline: new Date(dInput.value) }, { merge: true });
      msg.textContent = `Lock set to ${new Date(dInput.value).toLocaleString()}.`;
      msg.className = "msg ok";
      await store.reload();
    } catch (e) { msg.textContent = `Couldn't save: ${e.message}`; msg.className = "msg error"; }
  };

  const rSave = document.getElementById("admin-season-results-save");
  if (rSave) rSave.onclick = async () => {
    const data = {};
    const gbVal = gbInput.value.trim();
    if (gbVal) {
      const p = byLabel.get(gbVal);
      if (!p) { msg.textContent = "Pick the Golden Boot player from the list."; msg.className = "msg error"; return; }
      data.goldenBootId = p.id; data.goldenBootName = p.name;
    }
    if (champSel.value) data.champion = champSel.value;
    try {
      await setDoc(doc(db, "config", "season_results"), data);
      msg.textContent = "Season results saved.";
      msg.className = "msg ok";
      await store.reload();
    } catch (e) { msg.textContent = `Couldn't save: ${e.message}`; msg.className = "msg error"; }
  };
}

function renderAllowlist(emails) {
  const el = document.getElementById("allow-list");
  if (!el) return;
  if (!emails || emails.length === 0) {
    el.innerHTML = `<p class="empty">No one added yet — only you can get in.</p>`;
    return;
  }
  el.innerHTML = emails
    .map(e => `<div class="pick-tile" style="display:flex; align-items:center; justify-content:space-between; gap:0.6rem;">
      <span class="mono" style="font-size:0.78rem;">${e}</span>
      <button class="ghost" data-remove="${e}" style="padding:0.2rem 0.6rem; font-size:0.75rem;">Remove</button>
    </div>`)
    .join("");
}
