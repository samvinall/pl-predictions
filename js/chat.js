// ---------------------------------------------------------------------------
// Group chat. A single message room (the `messages` collection) with a live
// Firestore listener so posts appear in real time -- the one place the app
// uses onSnapshot rather than a one-shot read. Everything is HTML-escaped on
// render, so message text can never inject markup.
// ---------------------------------------------------------------------------
import { ADMIN_EMAIL } from "./config.js";
import {
  db, collection, query, orderBy, limit, onSnapshot, addDoc, deleteDoc, doc, serverTimestamp,
} from "./firebase.js";
import { store } from "./store.js";

const MAX_LEN = 1000;
const esc = s => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Wire the Chat tab: subscribe to the live message feed and hook up sending.
// Re-runnable -- drops any previous subscription first (see also teardownChat).
export function setupChat() {
  const list = document.getElementById("chat-list");
  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send");
  if (!list || !input || !sendBtn) return;

  store.markChatSeen = markChatSeen;   // let tabs.js clear the badge when Chat opens

  teardownChat();
  const q = query(collection(db, "messages"), orderBy("createdAt", "desc"), limit(100));
  store.chatUnsub = onSnapshot(
    q,
    snap => {
      const msgs = snap.docs.map(d => ({ id: d.id, ...d.data() })).reverse();
      renderMessages(list, msgs);
      // Newest message time (a pending serverTimestamp reads as null -> skip).
      store.chatLatestMs = msgs.reduce((mx, m) => {
        const t = m.createdAt && m.createdAt.toDate ? m.createdAt.toDate().getTime() : 0;
        return t > mx ? t : mx;
      }, 0);
      // First ever load: baseline "seen" to now so old history isn't flagged.
      if (lastSeenMs() === 0) setLastSeen(store.chatLatestMs || Date.now());
      // If they're looking at Chat, it's seen live; otherwise badge if new.
      if (chatTabActive()) markChatSeen();
      else refreshChatBadge();
    },
    err => { list.innerHTML = `<p class="empty">Couldn't load chat: ${esc(err.message)}</p>`; }
  );

  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    input.style.height = "";
    input.focus();
    try {
      await addDoc(collection(db, "messages"), {
        uid: store.currentUser.uid,
        name: store.currentUser.displayName,
        email: store.currentUser.email,
        text: text.slice(0, MAX_LEN),
        createdAt: serverTimestamp(),
      });
    } catch (e) {
      input.value = text;   // restore so nothing's lost on a failed send
      alert(`Couldn't send message: ${e.message}`);
    }
  };
  sendBtn.onclick = send;
  // Enter sends; Shift+Enter makes a new line.
  input.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  // Delete (own messages, or any if admin) via event delegation.
  list.onclick = async (ev) => {
    const btn = ev.target.closest("button[data-del]");
    if (!btn) return;
    try {
      await deleteDoc(doc(db, "messages", btn.getAttribute("data-del")));
    } catch (e) {
      alert(`Couldn't delete: ${e.message}`);
    }
  };
}

// Stop the live listener (on sign-out) so it doesn't keep running / double up.
export function teardownChat() {
  if (store.chatUnsub) { store.chatUnsub(); store.chatUnsub = null; }
}

// --- Unread badge (per-device, localStorage) --------------------------------
const LAST_SEEN_KEY = "chatLastSeenMs";
const chatBtn = () => document.querySelector('[data-tab="chat"]');
const chatTabActive = () => { const b = chatBtn(); return !!b && b.classList.contains("active"); };
function lastSeenMs() {
  try { return parseInt(localStorage.getItem(LAST_SEEN_KEY) || "0", 10) || 0; }
  catch (e) { return 0; }
}
function setLastSeen(ms) {
  try { localStorage.setItem(LAST_SEEN_KEY, String(ms)); } catch (e) { /* ignore */ }
}
// Show the gold dot on the Chat tab when there are messages newer than what
// this device last saw, and Chat isn't the open tab.
function refreshChatBadge() {
  const b = chatBtn();
  if (b) b.classList.toggle("attention", store.chatLatestMs > lastSeenMs() && !chatTabActive());
}
// Mark the chat as read up to the newest message and drop the dot. Called from
// the listener (when Chat is the active tab) and from tabs.js when Chat opens.
function markChatSeen() {
  setLastSeen(store.chatLatestMs || Date.now());
  const b = chatBtn();
  if (b) b.classList.remove("attention");
}

function renderMessages(list, msgs) {
  if (!msgs.length) {
    list.innerHTML = `<p class="empty">No messages yet — say hello 👋</p>`;
    return;
  }
  const meUid = store.currentUser?.uid;
  const isAdmin = store.currentUser?.email === ADMIN_EMAIL;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;

  list.innerHTML = msgs.map(m => {
    const name = store.names[m.uid] || m.name || "?";
    const when = m.createdAt && m.createdAt.toDate
      ? m.createdAt.toDate().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "sending…";
    const mine = m.uid === meUid;
    const del = (mine || isAdmin)
      ? `<button class="chat-del" data-del="${esc(m.id)}" title="Delete message" aria-label="Delete message">×</button>`
      : "";
    return `<div class="chat-msg${mine ? " chat-mine" : ""}">`
      + `<div class="chat-meta"><strong>${esc(name)}</strong> <span>${esc(when)}</span>${del}</div>`
      + `<div class="chat-text">${esc(m.text)}</div></div>`;
  }).join("");

  // Keep the newest message in view, but don't yank the user down if they've
  // scrolled up to read history.
  if (nearBottom) list.scrollTop = list.scrollHeight;
}
