// =============================================
//  room.js — Main Room Logic
//  Fixed: module import path, videoUrl listener
//  moved inside DOMContentLoaded, upload support
// =============================================

import { db } from "./firebase-config.js";
import {
  ref, set, onValue, push, serverTimestamp,
  update, get, onDisconnect, remove
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ---- Read room from URL first, fallback to sessionStorage ----
const params  = new URLSearchParams(window.location.search);
const ROOM    = params.get("room") || sessionStorage.getItem("tw_room");
const MY_NAME = sessionStorage.getItem("tw_name") || "You";
const MY_ROLE = sessionStorage.getItem("tw_role")  || "guest";
const MY_ID   = MY_NAME + "_" + Math.random().toString(36).slice(2, 8);

// ---- Mutable state ----
let video          = null;
let isSyncing      = false;
let callActive     = false;
let callType       = null;
let localStream    = null;
let peerConnection = null;
let selectedFile   = null;   // File object for local upload

// ---- Firebase refs (safe to create before DOM ready) ----
const roomRef     = ref(db, `rooms/${ROOM}`);
const chatRef     = ref(db, `rooms/${ROOM}/messages`);
const playRef     = ref(db, `rooms/${ROOM}/playState`);
const reactRef    = ref(db, `rooms/${ROOM}/reactions`);
const presenceRef = ref(db, `rooms/${ROOM}/presence/${MY_ID}`);
const moodRef     = ref(db, `rooms/${ROOM}/moods/${MY_ID}`);
const signalRef   = ref(db, `rooms/${ROOM}/signals`);

// =============================================
//  BOOT — wait for DOM
// =============================================
document.addEventListener("DOMContentLoaded", () => {
  // Redirect if no room
  if (!ROOM) {
    window.location.href = "../index.html";
    return;
  }

  // Save to sessionStorage in case it came from URL
  sessionStorage.setItem("tw_room", ROOM);

  video = document.getElementById("main-video");

  // Display room code in header
  document.getElementById("header-room-code").textContent = ROOM;

  // Announce my presence; clean up on disconnect
  set(presenceRef, { name: MY_NAME, joinedAt: Date.now() });
  onDisconnect(presenceRef).remove();

  // ---- Attach all Firebase listeners HERE, inside DOMContentLoaded ----
  listenForPartner();
  listenForPlayState();
  listenForVideoUrl();   // <-- was incorrectly at module level before
  listenForMessages();
  listenForReactions();
  listenForMoods();
  listenForSignals();

  // Attach video element events
  video.addEventListener("play",        pushPlayState);
  video.addEventListener("pause",       pushPlayState);
  video.addEventListener("seeked",      pushPlayState);
  video.addEventListener("timeupdate",  updateProgressUI);
  video.addEventListener("ended",       () => {
    document.getElementById("play-pause-btn").textContent = "▶";
  });
});

// =============================================
//  PRESENCE / PARTNER STATUS
// =============================================
function listenForPartner() {
  const allPresRef = ref(db, `rooms/${ROOM}/presence`);
  onValue(allPresRef, (snap) => {
    const data   = snap.val() || {};
    const others = Object.entries(data).filter(([id]) => id !== MY_ID);
    const dot    = document.getElementById("partner-dot");
    const label  = document.getElementById("partner-name-display");

    if (others.length > 0) {
      const [, info] = others[0];
      dot.className     = "status-dot online";
      label.textContent = info.name;
    } else {
      dot.className     = "status-dot offline";
      label.textContent = "Waiting...";
    }
  });
}

// =============================================
//  SOURCE TAB SWITCH (URL ↔ Upload)
// =============================================
window.switchSourceTab = function (tab) {
  document.getElementById("src-panel-url").style.display    = tab === "url"    ? "block" : "none";
  document.getElementById("src-panel-upload").style.display = tab === "upload" ? "block" : "none";
  document.getElementById("src-tab-url").classList.toggle("active",    tab === "url");
  document.getElementById("src-tab-upload").classList.toggle("active", tab === "upload");
};

// =============================================
//  VIDEO — URL method
// =============================================
window.loadVideoFromUrl = function () {
  const url = document.getElementById("video-url-input").value.trim();
  if (!url) { showToast("Paste a video URL first!"); return; }

  // Broadcast URL to partner via Firebase
  update(roomRef, { videoUrl: url, videoMode: "url" });
  applyVideoUrl(url);
};

// Listen for URL pushed by either partner
function listenForVideoUrl() {
  onValue(ref(db, `rooms/${ROOM}/videoUrl`), (snap) => {
    const url = snap.val();
    if (!url) return;
    // Only apply if different from what's already loaded (avoid loop)
    if (video.getAttribute("data-loaded-url") !== url) {
      applyVideoUrl(url);
    }
  });
}

function applyVideoUrl(url) {
  video.src = url;
  video.setAttribute("data-loaded-url", url);
  showPlayer();
  showToast("Video loaded! Press play 🎬");
}

// =============================================
//  VIDEO — Upload / local file method
// =============================================
window.onFileSelected = function (e) {
  const file = e.target.files[0];
  if (!file) return;
  selectedFile = file;
  document.getElementById("upload-filename").textContent = "📽 " + file.name;
  document.getElementById("upload-info").style.display = "flex";
};

window.onDragOver = function (e) {
  e.preventDefault();
  document.getElementById("upload-zone").style.borderColor = "var(--rose)";
};

window.onFileDrop = function (e) {
  e.preventDefault();
  document.getElementById("upload-zone").style.borderColor = "";
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith("video/")) {
    selectedFile = file;
    document.getElementById("upload-filename").textContent = "📽 " + file.name;
    document.getElementById("upload-info").style.display = "flex";
    document.getElementById("file-input").files = e.dataTransfer.files;
  }
};

window.loadVideoFromFile = function () {
  if (!selectedFile) { showToast("Pick a video file first!"); return; }

  // Create a local blob URL — plays instantly, no upload needed
  const blobUrl = URL.createObjectURL(selectedFile);
  video.src = blobUrl;
  video.setAttribute("data-loaded-url", "local:" + selectedFile.name);
  showPlayer();
  showToast("Video loaded locally! Press play 🎬 (Partner must load the same file)");

  // Notify partner via Firebase (filename only — no actual upload)
  update(roomRef, {
    videoUrl:  "",
    videoMode: "local",
    videoName: selectedFile.name,
    videoHint: MY_NAME + " loaded: " + selectedFile.name,
  });
};

// Listen for partner's local file notification
onValue || 0; // (listener set up in listenForVideoUrl already covers /videoUrl)
// Watch videoHint separately to alert partner
let lastHint = "";
function listenForVideoHint() {
  onValue(ref(db, `rooms/${ROOM}/videoHint`), (snap) => {
    const hint = snap.val();
    if (hint && hint !== lastHint) {
      lastHint = hint;
      showToast("📁 " + hint + " — upload the same file!");
    }
  });
}

// =============================================
//  SHOW PLAYER (shared helper)
// =============================================
function showPlayer() {
  video.style.display = "block";
  video.classList.add("active");
  document.getElementById("player-placeholder").style.display = "none";
  document.getElementById("controls-bar").style.display       = "flex";
  document.getElementById("sync-row").style.display           = "flex";
}

// =============================================
//  PLAYBACK SYNC
// =============================================
function pushPlayState() {
  if (isSyncing || !video.src) return;
  update(playRef, {
    playing:     !video.paused,
    currentTime: video.currentTime,
    updatedAt:   Date.now(),
    by:          MY_ID,
  });
}

function listenForPlayState() {
  onValue(playRef, (snap) => {
    const state = snap.val();
    if (!state || state.by === MY_ID) return;
    if (!video || !video.src)        return;

    isSyncing = true;

    const drift = Math.abs(video.currentTime - state.currentTime);
    if (drift > 2) video.currentTime = state.currentTime;

    if (state.playing && video.paused)  video.play().catch(() => {});
    if (!state.playing && !video.paused) video.pause();

    setTimeout(() => { isSyncing = false; }, 600);
    updateSyncUI(drift <= 2);
  });
}

function updateSyncUI(inSync) {
  document.getElementById("sync-dot").style.color   = inSync ? "#4ade80" : "#f0c060";
  document.getElementById("sync-label").textContent = inSync ? "In sync with partner ✓" : "Resyncing...";
}

function updateProgressUI() {
  if (!video.duration) return;
  const pct = (video.currentTime / video.duration) * 100;
  document.getElementById("progress-fill").style.width = pct + "%";
  const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  document.getElementById("time-label").textContent =
    fmt(video.currentTime) + " / " + fmt(video.duration);
  document.getElementById("play-pause-btn").textContent = video.paused ? "▶" : "⏸";
}

window.togglePlay = function () {
  if (!video.src) { showToast("Load a video first!"); return; }
  video.paused ? video.play() : video.pause();
};

window.skip = function (s) {
  if (!video.src) return;
  video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + s));
};

window.seekTo = function (e) {
  if (!video.duration) return;
  video.currentTime = (e.offsetX / e.currentTarget.offsetWidth) * video.duration;
};

// =============================================
//  REACTIONS
// =============================================
const reactionJoinTime = Date.now();

window.sendReaction = function (emoji) {
  push(reactRef, { emoji, by: MY_NAME, at: Date.now() });
  spawnEmoji(emoji);
};

function listenForReactions() {
  onValue(reactRef, (snap) => {
    const data = snap.val() || {};
    Object.values(data).forEach((item) => {
      if (item.at > reactionJoinTime && item.by !== MY_NAME) {
        spawnEmoji(item.emoji);
      }
    });
  });
}

function spawnEmoji(emoji) {
  const el = document.createElement("div");
  el.className = "float-emoji";
  el.textContent = emoji;
  el.style.cssText = `left:${30 + Math.random() * (window.innerWidth - 80)}px;bottom:160px;`;
  document.getElementById("float-container").appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// =============================================
//  MOOD
// =============================================
window.setMood = function (btn, mood) {
  document.querySelectorAll(".mood-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  set(moodRef, { name: MY_NAME, mood, at: Date.now() });
  showToast("Mood shared 💕");
};

function listenForMoods() {
  onValue(ref(db, `rooms/${ROOM}/moods`), (snap) => {
    const data   = snap.val() || {};
    const others = Object.entries(data).filter(([id]) => id !== MY_ID).map(([, v]) => v);
    if (others.length > 0) {
      document.getElementById("partner-mood-row").style.display = "flex";
      document.getElementById("partner-mood-value").textContent = others[0].mood;
    }
  });
}

// =============================================
//  CHAT
// =============================================
window.sendChatMessage = function () {
  const input = document.getElementById("chat-input");
  const text  = input.value.trim();
  if (!text) return;
  push(chatRef, { name: MY_NAME, text, localAt: Date.now() });
  input.value = "";
};

window.sendChatEmoji = function (emoji) {
  push(chatRef, { name: MY_NAME, text: emoji, localAt: Date.now(), emojiOnly: true });
};

function listenForMessages() {
  onValue(chatRef, (snap) => {
    const data = snap.val() || {};
    const list = document.getElementById("messages-list");
    list.innerHTML = "";
    Object.values(data).forEach((msg) => {
      const mine = msg.name === MY_NAME;
      const div  = document.createElement("div");
      div.className = `message ${mine ? "mine" : "theirs"}`;
      const time = msg.localAt ? formatTime(msg.localAt) : "";
      div.innerHTML = `
        <span class="msg-name">${esc(msg.name)}</span>
        <div class="msg-bubble${msg.emojiOnly ? " emoji-only" : ""}">${esc(msg.text)}</div>
        <span class="msg-time">${time}</span>
      `;
      list.appendChild(div);
    });
    const wrapper = document.querySelector(".chat-wrapper");
    if (wrapper) wrapper.scrollTop = wrapper.scrollHeight;

    if (!document.getElementById("tab-chat").classList.contains("active")) {
      document.getElementById("chat-badge").style.display = "inline";
    }
  });
}

// =============================================
//  TABS
// =============================================
window.switchTab = function (name, el) {
  document.querySelectorAll(".tab").forEach((t)     => t.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
  document.getElementById("tab-" + name).classList.add("active");
  el.classList.add("active");
  if (name === "chat") {
    document.getElementById("chat-badge").style.display = "none";
    setTimeout(() => {
      const w = document.querySelector(".chat-wrapper");
      if (w) w.scrollTop = w.scrollHeight;
    }, 50);
  }
};

// =============================================
//  COPY ROOM CODE
// =============================================
window.copyRoomCode = function () {
  navigator.clipboard.writeText(ROOM)
    .then(() => showToast("Room code copied! Send it to your partner 💕"))
    .catch(() => showToast("Room: " + ROOM));
};

// =============================================
//  WebRTC — VOICE & VIDEO CALL
// =============================================
const ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

function listenForSignals() {
  onValue(signalRef, async (snap) => {
    const data = snap.val() || {};
    for (const [id, sig] of Object.entries(data)) {
      if (sig.to !== MY_ID) continue;

      if (sig.type === "offer" && !peerConnection) {
        await handleOffer(sig);
      } else if (sig.type === "answer" && peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(sig.sdp)).catch(console.error);
      } else if (sig.type === "ice-candidate" && peerConnection) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(sig.candidate)).catch(() => {});
      }
      remove(ref(db, `rooms/${ROOM}/signals/${id}`));
    }
  });
}

async function getPartnerId() {
  const snap   = await get(ref(db, `rooms/${ROOM}/presence`));
  const others = Object.keys(snap.val() || {}).filter((id) => id !== MY_ID);
  return others[0] || null;
}

async function buildPeer(stream) {
  peerConnection = new RTCPeerConnection(ICE);
  stream.getTracks().forEach((t) => peerConnection.addTrack(t, stream));

  peerConnection.ontrack = (e) => {
    const rv = document.getElementById("remote-video");
    if (rv.srcObject !== e.streams[0]) {
      rv.srcObject = e.streams[0];
      document.getElementById("remote-video-wrap").style.display = "block";
    }
  };

  peerConnection.onicecandidate = async (e) => {
    if (!e.candidate) return;
    const pid = await getPartnerId();
    if (pid) push(signalRef, { type: "ice-candidate", candidate: e.candidate.toJSON(), from: MY_ID, to: pid });
  };

  peerConnection.onconnectionstatechange = () => {
    const s = peerConnection.connectionState;
    const el = document.getElementById("call-status");
    if (s === "connected") {
      el.textContent = "✓ Connected — enjoy your call 💕";
      el.className   = "call-status connected";
    } else if (s === "disconnected" || s === "failed") {
      el.textContent = "Call ended.";
      el.className   = "call-status";
      endCall();
    }
  };
}

async function handleOffer(sig) {
  const constraints = sig.callType === "video" ? { audio: true, video: true } : { audio: true };
  try { localStream = await navigator.mediaDevices.getUserMedia(constraints); }
  catch { showToast("Could not access mic/camera."); return; }

  showLocalPreview(sig.callType === "video");
  await buildPeer(localStream);
  await peerConnection.setRemoteDescription(new RTCSessionDescription(sig.sdp));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  push(signalRef, { type: "answer", sdp: peerConnection.localDescription.toJSON(), from: MY_ID, to: sig.from });

  callActive = true; callType = sig.callType;
  updateCallUI();
  showToast("Call connected 💕");
}

window.toggleVoiceCall = async function () {
  callActive ? endCall() : await initiateCall("voice");
};
window.toggleVideoCall = async function () {
  callActive ? endCall() : await initiateCall("video");
};

async function initiateCall(type) {
  const pid = await getPartnerId();
  if (!pid) { showToast("Partner not in room yet!"); return; }

  const constraints = type === "video" ? { audio: true, video: true } : { audio: true };
  try { localStream = await navigator.mediaDevices.getUserMedia(constraints); }
  catch { showToast("Could not access mic/camera."); return; }

  showLocalPreview(type === "video");
  await buildPeer(localStream);
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  push(signalRef, { type: "offer", sdp: peerConnection.localDescription.toJSON(), callType: type, from: MY_ID, to: pid });

  callActive = true; callType = type;
  updateCallUI();
  document.getElementById("call-status").textContent = "Calling... waiting for partner 📞";
}

function showLocalPreview(withVideo) {
  const lv = document.getElementById("local-video");
  lv.srcObject = localStream;
  if (withVideo) document.getElementById("local-video-wrap").style.display = "block";
}

function updateCallUI() {
  const vb = document.getElementById("voice-btn");
  const vd = document.getElementById("video-btn");
  if (callActive) {
    vb.querySelector("span:last-child").textContent = callType === "voice" ? "End Call" : "Voice Call";
    vd.querySelector("span:last-child").textContent = callType === "video" ? "End Call" : "Video Call";
    if (callType === "voice") vb.classList.add("active");
    if (callType === "video") vd.classList.add("active");
  } else {
    vb.className = "call-btn voice";
    vd.className = "call-btn video";
    vb.querySelector("span:last-child").textContent = "Voice Call";
    vd.querySelector("span:last-child").textContent = "Video Call";
  }
}

function endCall() {
  if (localStream)    localStream.getTracks().forEach((t) => t.stop());
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  localStream = null; callActive = false; callType = null;
  ["local-video-wrap","remote-video-wrap"].forEach((id) => {
    document.getElementById(id).style.display = "none";
  });
  document.getElementById("local-video").srcObject  = null;
  document.getElementById("remote-video").srcObject = null;
  document.getElementById("call-status").textContent = "Call ended. Miss them already? 💕";
  document.getElementById("call-status").className   = "call-status";
  updateCallUI();
}

// =============================================
//  UTILS
// =============================================
function formatTime(ts) {
  const d = new Date(ts);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");
}

window.showToast = function (msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 3000);
};
