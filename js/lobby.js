import { db } from "./firebase-config.js";
import { ref, set, get } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

function generateCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from({length:6}, () => chars[Math.floor(Math.random()*chars.length)]).join("");
}
function getMyName()      { return document.getElementById("my-name").value.trim() || "You"; }
function getPartnerName() { return document.getElementById("partner-name-input").value.trim() || "Partner"; }

function setStatus(msg, color="rgba(255,255,255,0.45)") {
  const el = document.getElementById("lobby-status");
  if (el) { el.textContent = msg; el.style.color = color; }
}
function setLoading(v) {
  ["create-btn","join-btn"].forEach(id => { const b = document.getElementById(id); if(b) b.disabled = v; });
}

window.createRoom = async function() {
  const code = generateCode();
  const myName = getMyName();
  const partnerName = getPartnerName();
  setLoading(true); setStatus("Creating room...");
  try {
    await set(ref(db, `rooms/${code}`), {
      createdAt: Date.now(), host: myName,
      videoUrl: "", playState: { playing: false, currentTime: 0, updatedAt: Date.now() },
    });
  } catch(e) {
    setLoading(false);
    setStatus("❌ " + e.message, "#f87171");
    alert("Firebase error: " + e.message + "\n\nCheck firebase-config.js has the correct databaseURL.");
    return;
  }
  sessionStorage.setItem("tw_room", code);
  sessionStorage.setItem("tw_name", myName);
  sessionStorage.setItem("tw_partner", partnerName);
  sessionStorage.setItem("tw_role", "host");
  setStatus("✓ Room created! Entering...", "#4ade80");
  window.location.href = `pages/room.html?room=${code}`;
};

window.joinRoom = async function() {
  const raw = document.getElementById("join-code").value.trim().toUpperCase();
  if (!raw || raw.length < 4) { setStatus("Enter a valid room code!", "#fbbf24"); return; }
  const myName = getMyName();
  const partnerName = getPartnerName();
  setLoading(true); setStatus("Looking for room " + raw + "...");
  try {
    const snap = await get(ref(db, `rooms/${raw}`));
    if (!snap.exists()) { setLoading(false); setStatus("❌ Room not found! Check the code 💕", "#f87171"); return; }
  } catch(e) {
    setLoading(false);
    setStatus("❌ " + e.message, "#f87171");
    alert("Firebase error: " + e.message);
    return;
  }
  sessionStorage.setItem("tw_room", raw);
  sessionStorage.setItem("tw_name", myName);
  sessionStorage.setItem("tw_partner", partnerName);
  sessionStorage.setItem("tw_role", "guest");
  setStatus("✓ Room found! Entering...", "#4ade80");
  window.location.href = `pages/room.html?room=${raw}`;
};
