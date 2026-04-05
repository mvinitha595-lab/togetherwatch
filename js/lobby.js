// =============================================
//  lobby.js — Create & Join Rooms
//  Fixed: proper module import, status feedback,
//         loading states, error handling
// =============================================

import { db } from "./firebase-config.js";
import {
  ref, set, get
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

function generateCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join("");
}

function getMyName() {
  const n = document.getElementById("my-name").value.trim();
  return n || "You";
}

function setStatus(msg, color = "rgba(255,255,255,0.5)") {
  const el = document.getElementById("lobby-status");
  if (el) { el.textContent = msg; el.style.color = color; }
}

function setLoading(loading) {
  const cb = document.getElementById("create-btn");
  const jb = document.getElementById("join-btn");
  if (cb) cb.disabled = loading;
  if (jb) jb.disabled = loading;
}

// ---- CREATE ROOM ----
window.createRoom = async function () {
  const code = generateCode();
  const name = getMyName();

  setLoading(true);
  setStatus("Creating room...");

  try {
    await set(ref(db, `rooms/${code}`), {
      createdAt: Date.now(),
      host:      name,
      videoUrl:  "",
      playState: { playing: false, currentTime: 0, updatedAt: Date.now() },
    });
  } catch (e) {
    setLoading(false);
    setStatus("❌ " + e.message, "#f87171");
    console.error("Firebase error:", e);
    alert(
      "Could not connect to Firebase.\n\n" +
      "Make sure you have:\n" +
      "1. Added databaseURL in firebase-config.js\n" +
      "2. Enabled Realtime Database (test mode)\n" +
      "3. Enabled Anonymous Auth\n\n" +
      "Error: " + e.message
    );
    return;
  }

  sessionStorage.setItem("tw_room", code);
  sessionStorage.setItem("tw_name", name);
  sessionStorage.setItem("tw_role", "host");

  setStatus("✓ Room created! Entering...", "#4ade80");
  window.location.href = `pages/room.html?room=${code}`;
};

// ---- JOIN ROOM ----
window.joinRoom = async function () {
  const raw = document.getElementById("join-code").value.trim().toUpperCase();

  if (!raw || raw.length < 4) {
    setStatus("Please enter a valid room code!", "#fbbf24");
    document.getElementById("join-code").focus();
    return;
  }

  const name = getMyName();

  setLoading(true);
  setStatus("Looking for room " + raw + "...");

  try {
    const snap = await get(ref(db, `rooms/${raw}`));
    if (!snap.exists()) {
      setLoading(false);
      setStatus("❌ Room not found! Check the code with your partner 💕", "#f87171");
      return;
    }
  } catch (e) {
    setLoading(false);
    setStatus("❌ " + e.message, "#f87171");
    console.error("Firebase error:", e);
    alert(
      "Could not connect to Firebase.\n\n" +
      "Make sure you have:\n" +
      "1. Added databaseURL in firebase-config.js\n" +
      "2. Enabled Realtime Database (test mode)\n" +
      "3. Enabled Anonymous Auth\n\n" +
      "Error: " + e.message
    );
    return;
  }

  sessionStorage.setItem("tw_room", raw);
  sessionStorage.setItem("tw_name", name);
  sessionStorage.setItem("tw_role", "guest");

  setStatus("✓ Room found! Entering...", "#4ade80");
  window.location.href = `pages/room.html?room=${raw}`;
};
