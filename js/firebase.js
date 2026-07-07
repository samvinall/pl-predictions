// ---------------------------------------------------------------------------
// Firebase bootstrap. Initialises the app once and re-exports the SDK helpers
// the rest of the code uses, so the CDN version is pinned in exactly one place
// and every other module imports Firestore/Auth bits from "./firebase.js".
// ---------------------------------------------------------------------------
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, collection, query, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./config.js";

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const provider = new GoogleAuthProvider();

// Auth helpers
export { signInWithPopup, signOut, onAuthStateChanged };
// Firestore helpers
export { doc, getDoc, setDoc, collection, query, where, getDocs };
