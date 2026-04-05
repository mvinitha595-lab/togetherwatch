// =============================================
//  room.js — TogetherWatch v4
//  Full sync for ALL video sources including
//  Google Drive via CORS proxy
// =============================================

import { db } from "./firebase-config.js";
import {
  ref, set, onValue, push,
  update, get, onDisconnect, remove
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const params  = new URLSearchParams(window.location.search);
const ROOM    = params.get("room") || sessionStorage.getItem("tw_room");
const MY_NAME = sessionStorage.getItem("tw_name") || "You";
const MY_ID   = MY_NAME + "_" + Math.random().toString(36).slice(2, 8);

let video          = null;
let isSyncing      = false;
let callActive     = false;
let callType       = null;
let localStream    = null;
let peerConnection = null;
let selectedFile   = null;

// Firebase refs
const roomRef     = ref(db, `rooms/${ROOM}`);
const chatRef     = ref(db, `rooms/${ROOM}/messages`);
const playRef     = ref(db, `rooms/${ROOM}/playState`);
const reactRef    = ref(db, `rooms/${ROOM}/reactions`);
const presenceRef = ref(db, `rooms/${ROOM}/presence/${MY_ID}`);
const moodRef     = ref(db, `rooms/${ROOM}/moods/${MY_ID}`);
const signalRef   = ref(db, `rooms/${ROOM}/signals`);

// =============================================
//  BOOT
// =============================================
document.addEventListener("DOMContentLoaded", () => {
  if (!ROOM) { window.location.href = "../index.html"; return; }
  sessionStorage.setItem("tw_room", ROOM);

  video = document.getElementById("main-video");
  document.getElementById("header-room-code").textContent = ROOM;

  set(presenceRef, { name: MY_NAME, joinedAt: Date.now() });
  onDisconnect(presenceRef).remove();

  listenForPartner();
  listenForPlayState();
  listenForVideoUrl();
  listenForMessages();
  listenForReactions();
  listenForMoods();
  listenForSignals();

  // Push play/pause/seek events to Firebase so partner syncs
  video.addEventListener("play",       pushPlayState);
  video.addEventListener("pause",      pushPlayState);
  video.addEventListener("seeked",     pushPlayState);
  video.addEventListener("timeupdate", updateProgressUI);
  video.addEventListener("ended", () => {
    document.getElementById("play-pause-btn").textContent = "▶";
  });
});

// =============================================
//  PRESENCE
// =============================================
function listenForPartner() {
  onValue(ref(db, `rooms/${ROOM}/presence`), (snap) => {
    const data   = snap.val() || {};
    const others = Object.entries(data).filter(([id]) => id !== MY_ID);
    const dot    = document.getElementById("partner-dot");
    const label  = document.getElementById("partner-name-display");
    if (others.length > 0) {
      dot.className     = "status-dot online";
      label.textContent = others[0][1].name;
    } else {
      dot.className     = "status-dot offline";
      label.textContent = "Waiting...";
    }
  });
}

// =============================================
//  SOURCE TAB SWITCH
// =============================================
window.switchSourceTab = function (tab) {
  document.getElementById("src-panel-url").style.display    = tab === "url"    ? "block" : "none";
  document.getElementById("src-panel-upload").style.display = tab === "upload" ? "block" : "none";
  document.getElementById("src-tab-url").classList.toggle("active",    tab === "url");
  document.getElementById("src-tab-upload").classList.toggle("active", tab === "upload");
};

// =============================================
//  URL CONVERSION HELPERS
// =============================================

// Convert any sharing URL into a streamable direct URL
function toStreamableUrl(url) {
  // Google Drive: https://drive.google.com/file/d/FILE_ID/view
  const driveMatch = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (driveMatch) {
    const fileId = driveMatch[1];
    // Use a CORS proxy so the browser can stream it directly in <video>
    // This converts to a proxied direct download link
    return `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;
  }

  // Dropbox: change domain and remove dl=0
  if (url.includes("dropbox.com")) {
    return url
      .replace("www.dropbox.com", "dl.dropboxusercontent.com")
      .replace("?dl=0", "").replace("&dl=0", "")
      .replace("?dl=1", "").replace("&dl=1", "");
  }

  // OneDrive
  if (url.includes("1drv.ms") || url.includes("onedrive.live.com")) {
    return url.replace("redir?", "download?").replace("embed?", "download?");
  }

  // Already a direct URL
  return url;
}

// =============================================
//  LOAD VIDEO FROM URL
// =============================================
window.loadVideoFromUrl = function () {
  let raw = document.getElementById("video-url-input").value.trim();
  if (!raw) { showToast("Paste a video URL first!"); return; }

  // Block YouTube
  if (raw.includes("youtube.com") || raw.includes("youtu.be")) {
    showErrorToast("YouTube blocks external players. Upload your movie to Google Drive and share that link instead.");
    return;
  }
  // Block streaming services
  if (raw.includes("netflix.com") || raw.includes("primevideo.com") || raw.includes("hotstar.com")) {
    showErrorToast("Streaming services block external players. Upload your own video to Google Drive instead.");
    return;
  }

  const streamUrl = toStreamableUrl(raw);

  // Show converted URL so user can see it
  if (streamUrl !== raw) {
    document.getElementById("video-url-input").value = streamUrl;
    showToast("Link converted ✓ Loading...");
  }

  // Save to Firebase — partner gets the same URL automatically
  update(roomRef, { videoUrl: streamUrl, videoLoadedBy: MY_NAME });
  applyVideo(streamUrl);
};

// =============================================
//  LISTEN FOR VIDEO URL (partner loaded video)
// =============================================
function listenForVideoUrl() {
  onValue(ref(db, `rooms/${ROOM}/videoUrl`), (snap) => {
    const url = snap.val();
    if (!url) return;
    // Don't re-apply if we already have this URL loaded
    if (video.getAttribute("data-src") === url) return;
    // Don't apply if WE just set it (loadedBy check)
    get(ref(db, `rooms/${ROOM}/videoLoadedBy`)).then((s) => {
      if (s.val() === MY_NAME) return; // we loaded it, already applied
      applyVideo(url);
      showToast("Partner loaded a video — loading for you too 🎬");
    });
  });
}

// =============================================
//  APPLY VIDEO — the core function
// =============================================
function applyVideo(url) {
  // Reset
  video.pause();
  video.removeAttribute("src");
  video.load();

  video.src = url;
  video.setAttribute("data-src", url);

  // Error handler with helpful messages
  video.onerror = function () {
    const isGDrive = url.includes("drive.google.com") || url.includes("uc?export");
    if (isGDrive) {
      showErrorToast(
        "Google Drive blocked the video. " +
        "Fix: Open Google Drive → right-click file → Share → " +
        "change to 'Anyone with the link' → try again."
      );
    } else {
      showErrorToast("Video failed to load. The server may be blocking streaming. Try uploading to Google Drive.");
    }
    // Show placeholder again
    video.style.display = "none";
    document.getElementById("player-placeholder").style.display = "flex";
    document.getElementById("controls-bar").style.display = "none";
    document.getElementById("sync-row").style.display     = "none";
  };

  video.oncanplay = function () {
    showToast("✓ Video ready! Press ▶ to play 🎬");
    document.getElementById("sync-label").textContent = "In sync with partner ✓";
  };

  // Show player
  video.style.display = "block";
  video.classList.add("active");
  document.getElementById("player-placeholder").style.display = "none";
  document.getElementById("controls-bar").style.display       = "flex";
  document.getElementById("sync-row").style.display           = "flex";
  showToast("Loading video...");
}

// =============================================
//  LOCAL FILE UPLOAD
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
  }
};

window.loadVideoFromFile = function () {
  if (!selectedFile) { showToast("Pick a video file first!"); return; }
  const blobUrl = URL.createObjectURL(selectedFile);
  applyVideo(blobUrl);
  video.setAttribute("data-src", "local:" + selectedFile.name);
  // Notify partner which file was loaded
  update(roomRef, {
    videoUrl:      "",
    videoLoadedBy: MY_NAME,
    videoHint:     MY_NAME + " loaded: " + selectedFile.name,
  });
  // Listen for partner's videoHint to show notification
  showToast("Loaded! Press play 🎬 — partner must load the same file");
};

// =============================================
//  PLAYBACK SYNC — the heart of TogetherWatch
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
    if (!state)              return;  // no data yet
    if (state.by === MY_ID)  return;  // we sent this, ignore
    if (!video || !video.src) return; // no video loaded

    isSyncing = true;

    // Sync time if drifted more than 2 seconds
    const drift = Math.abs(video.currentTime - state.currentTime);
    if (drift > 2) {
      video.currentTime = state.currentTime;
    }

    // Sync play/pause state
    if (state.playing && video.paused)  {
      video.play().catch(() => {});
    }
    if (!state.playing && !video.paused) {
      video.pause();
    }

    setTimeout(() => { isSyncing = false; }, 600);
    updateSyncUI(drift <= 2);
  });
}

function updateSyncUI(inSync) {
  const dot   = document.getElementById("sync-dot");
  const label = document.getElementById("sync-label");
  if (dot)   dot.style.color     = inSync ? "#4ade80" : "#f0c060";
  if (label) label.textContent   = inSync ? "● In sync with partner ✓" : "● Resyncing...";
}

function updateProgressUI() {
  if (!video.duration) return;
  const pct = (video.currentTime / video.duration) * 100;
  document.getElementById("progress-fill").style.width = pct + "%";
  const fmt = (t) => `${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,"0")}`;
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
    const others = Object.entries(snap.val() || {})
      .filter(([id]) => id !== MY_ID).map(([, v]) => v);
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
    const list = document.getElementById("messages-list");
    list.innerHTML = "";
    Object.values(snap.val() || {}).forEach((msg) => {
      const mine = msg.name === MY_NAME;
      const div  = document.createElement("div");
      div.className = `message ${mine ? "mine" : "theirs"}`;
      div.innerHTML = `
        <span class="msg-name">${esc(msg.name)}</span>
        <div class="msg-bubble${msg.emojiOnly ? " emoji-only" : ""}">${esc(msg.text)}</div>
        <span class="msg-time">${msg.localAt ? formatTime(msg.localAt) : ""}</span>
      `;
      list.appendChild(div);
    });
    const w = document.querySelector(".chat-wrapper");
    if (w) w.scrollTop = w.scrollHeight;
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

window.copyRoomCode = function () {
  navigator.clipboard.writeText(ROOM)
    .then(() => showToast("Room code copied! 💕"))
    .catch(() => showToast("Room: " + ROOM));
};

// =============================================
//  WebRTC CALL
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
      if      (sig.type === "offer"         && !peerConnection) await handleOffer(sig);
      else if (sig.type === "answer"        && peerConnection)  await peerConnection.setRemoteDescription(new RTCSessionDescription(sig.sdp)).catch(console.error);
      else if (sig.type === "ice-candidate" && peerConnection)  await peerConnection.addIceCandidate(new RTCIceCandidate(sig.candidate)).catch(() => {});
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
    const s  = peerConnection.connectionState;
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
  const c = sig.callType === "video" ? { audio: true, video: true } : { audio: true };
  try { localStream = await navigator.mediaDevices.getUserMedia(c); }
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

window.toggleVoiceCall = async function () { callActive ? endCall() : await initiateCall("voice"); };
window.toggleVideoCall = async function () { callActive ? endCall() : await initiateCall("video"); };

async function initiateCall(type) {
  const pid = await getPartnerId();
  if (!pid) { showToast("Partner not in room yet!"); return; }
  const c = type === "video" ? { audio: true, video: true } : { audio: true };
  try { localStream = await navigator.mediaDevices.getUserMedia(c); }
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
  document.getElementById("local-video").srcObject = localStream;
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
    vb.className = "call-btn voice"; vd.className = "call-btn video";
    vb.querySelector("span:last-child").textContent = "Voice Call";
    vd.querySelector("span:last-child").textContent = "Video Call";
  }
}

function endCall() {
  if (localStream)    localStream.getTracks().forEach((t) => t.stop());
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  localStream = null; callActive = false; callType = null;
  ["local-video-wrap","remote-video-wrap"].forEach((id) =>
    document.getElementById(id).style.display = "none");
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
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2,"0")}`;
}

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

window.showToast = function (msg) {
  const t = document.getElementById("toast");
  t.style.background = ""; t.style.borderColor = "";
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 3000);
};

function showErrorToast(msg) {
  const t = document.getElementById("toast");
  t.style.background  = "rgba(80,10,10,0.97)";
  t.style.borderColor = "#e8637a";
  t.textContent = "❌ " + msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => {
    t.classList.remove("show");
    t.style.background = ""; t.style.borderColor = "";
  }, 8000);
}
