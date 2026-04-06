// =============================================
//  room.js — TogetherWatch v5
//  ✅ Seen status  ✅ Typing indicator
//  ✅ Reaction counters  ✅ Floating hearts
//  ✅ Couple identity  ✅ Online/offline status
// =============================================

import { db } from "./firebase-config.js";
import {
  ref, set, onValue, push, update, get, onDisconnect, remove
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const params      = new URLSearchParams(window.location.search);
const ROOM        = params.get("room") || sessionStorage.getItem("tw_room");
const MY_NAME     = sessionStorage.getItem("tw_name")    || "You";
const PARTNER_NAME= sessionStorage.getItem("tw_partner") || "Partner";
const MY_ID       = MY_NAME + "_" + Math.random().toString(36).slice(2, 8);

let video          = null;
let isSyncing      = false;
let callActive     = false;
let callType       = null;
let localStream    = null;
let peerConnection = null;
let selectedFile   = null;
let typingTimer    = null;

// Reaction counters (local)
const reactCounts  = {};

// Firebase refs
const roomRef     = ref(db, `rooms/${ROOM}`);
const chatRef     = ref(db, `rooms/${ROOM}/messages`);
const playRef     = ref(db, `rooms/${ROOM}/playState`);
const reactRef    = ref(db, `rooms/${ROOM}/reactions`);
const presenceRef = ref(db, `rooms/${ROOM}/presence/${MY_ID}`);
const moodRef     = ref(db, `rooms/${ROOM}/moods/${MY_ID}`);
const signalRef   = ref(db, `rooms/${ROOM}/signals`);
const typingRef   = ref(db, `rooms/${ROOM}/typing/${MY_ID}`);
const seenRef     = ref(db, `rooms/${ROOM}/seen/${MY_ID}`);

// =============================================
//  BOOT
// =============================================
document.addEventListener("DOMContentLoaded", () => {
  if (!ROOM) { window.location.href = "../index.html"; return; }
  sessionStorage.setItem("tw_room", ROOM);

  video = document.getElementById("main-video");

  // Show room code & couple names
  document.getElementById("header-room-code").textContent = ROOM;
  document.getElementById("my-chip-name").textContent     = MY_NAME;
  document.getElementById("partner-chip-name").textContent = PARTNER_NAME;
  document.getElementById("typing-name").textContent      = PARTNER_NAME;
  document.getElementById("partner-video-label").textContent = PARTNER_NAME;

  // Presence
  set(presenceRef, { name: MY_NAME, joinedAt: Date.now() });
  onDisconnect(presenceRef).remove();
  onDisconnect(typingRef).remove();

  // All listeners
  listenForPartner();
  listenForPlayState();
  listenForVideoUrl();
  listenForMessages();
  listenForReactions();
  listenForMoods();
  listenForSignals();
  listenForTyping();

  // Video events
  video.addEventListener("play",       pushPlayState);
  video.addEventListener("pause",      pushPlayState);
  video.addEventListener("seeked",     pushPlayState);
  video.addEventListener("timeupdate", updateProgressUI);
  video.addEventListener("ended", () => {
    document.getElementById("play-pause-btn").textContent = "▶";
  });

  // Mark messages as seen when chat tab is active
  document.addEventListener("visibilitychange", markSeen);
});

// =============================================
//  PRESENCE & COUPLE STATUS
// =============================================
function listenForPartner() {
  onValue(ref(db, `rooms/${ROOM}/presence`), (snap) => {
    const data   = snap.val() || {};
    const others = Object.entries(data).filter(([id]) => id !== MY_ID);
    const dot    = document.getElementById("partner-dot");
    if (others.length > 0) {
      dot.className = "id-dot online";
    } else {
      dot.className = "id-dot offline";
    }
  });
}

// =============================================
//  TYPING INDICATOR
// =============================================
window.onChatKeydown = function(e) {
  if (e.key === "Enter") sendChatMessage();
};

window.onTyping = function() {
  // Push typing status
  set(typingRef, { name: MY_NAME, at: Date.now() });
  // Clear after 3s of no typing
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => remove(typingRef), 3000);
};

function listenForTyping() {
  onValue(ref(db, `rooms/${ROOM}/typing`), (snap) => {
    const data = snap.val() || {};
    const others = Object.entries(data).filter(([id]) => id !== MY_ID);
    const indicator = document.getElementById("typing-indicator");
    if (others.length > 0) {
      indicator.classList.add("show");
    } else {
      indicator.classList.remove("show");
    }
  });
}

// =============================================
//  SEEN STATUS
// =============================================
function markSeen() {
  set(seenRef, { name: MY_NAME, at: Date.now() });
}

// =============================================
//  SOURCE TAB SWITCH
// =============================================
window.switchSourceTab = function(tab) {
  document.getElementById("src-panel-url").style.display    = tab === "url"    ? "block" : "none";
  document.getElementById("src-panel-upload").style.display = tab === "upload" ? "block" : "none";
  document.getElementById("src-tab-url").classList.toggle("active",    tab === "url");
  document.getElementById("src-tab-upload").classList.toggle("active", tab === "upload");
};

// =============================================
//  VIDEO — URL
// =============================================
function toStreamableUrl(url) {
  const driveMatch = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (driveMatch) return `https://drive.google.com/uc?export=download&id=${driveMatch[1]}&confirm=t`;
  if (url.includes("dropbox.com"))
    return url.replace("www.dropbox.com","dl.dropboxusercontent.com").replace("?dl=0","").replace("&dl=0","");
  if (url.includes("1drv.ms") || url.includes("onedrive.live.com"))
    return url.replace("redir?","download?").replace("embed?","download?");
  return url;
}

window.loadVideoFromUrl = function() {
  let raw = document.getElementById("video-url-input").value.trim();
  if (!raw) { showToast("Paste a video URL first!"); return; }
  if (raw.includes("youtube.com") || raw.includes("youtu.be")) {
    showErrorToast("YouTube blocks external players. Upload to Google Drive instead."); return;
  }
  if (raw.includes("netflix.com") || raw.includes("primevideo.com") || raw.includes("hotstar.com")) {
    showErrorToast("Streaming services block external players. Upload your own video to Google Drive."); return;
  }
  const streamUrl = toStreamableUrl(raw);
  if (streamUrl !== raw) { document.getElementById("video-url-input").value = streamUrl; showToast("Link converted ✓"); }
  update(roomRef, { videoUrl: streamUrl, videoLoadedBy: MY_NAME });
  applyVideo(streamUrl);
};

function listenForVideoUrl() {
  onValue(ref(db, `rooms/${ROOM}/videoUrl`), (snap) => {
    const url = snap.val();
    if (!url) return;
    if (video.getAttribute("data-src") === url) return;
    get(ref(db, `rooms/${ROOM}/videoLoadedBy`)).then((s) => {
      if (s.val() === MY_NAME) return;
      applyVideo(url);
      showToast(PARTNER_NAME + " loaded a video — loading for you too 🎬");
    });
  });
}

function applyVideo(url) {
  video.pause();
  video.removeAttribute("src");
  video.load();
  video.src = url;
  video.setAttribute("data-src", url);
  video.onerror = () => showErrorToast("Video failed to load. Try Google Drive (Anyone with link) or Dropbox.");
  video.oncanplay = () => showToast("✓ Video ready! Press ▶ to play 🎬");
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
window.onFileSelected = function(e) {
  const file = e.target.files[0]; if (!file) return;
  selectedFile = file;
  document.getElementById("upload-filename").textContent = "📽 " + file.name;
  document.getElementById("upload-info").style.display = "flex";
};
window.onDragOver = function(e) { e.preventDefault(); };
window.onFileDrop = function(e) {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith("video/")) {
    selectedFile = file;
    document.getElementById("upload-filename").textContent = "📽 " + file.name;
    document.getElementById("upload-info").style.display = "flex";
  }
};
window.loadVideoFromFile = function() {
  if (!selectedFile) { showToast("Pick a video file first!"); return; }
  const blobUrl = URL.createObjectURL(selectedFile);
  applyVideo(blobUrl);
  video.setAttribute("data-src", "local:" + selectedFile.name);
  update(roomRef, { videoUrl:"", videoLoadedBy:MY_NAME, videoHint: MY_NAME + " loaded: " + selectedFile.name });
  showToast("Loaded! Press play 🎬 — partner must load the same file");
};

// =============================================
//  PLAYBACK SYNC
// =============================================
function pushPlayState() {
  if (isSyncing || !video.src) return;
  update(playRef, { playing:!video.paused, currentTime:video.currentTime, updatedAt:Date.now(), by:MY_ID });
}

function listenForPlayState() {
  onValue(playRef, (snap) => {
    const state = snap.val();
    if (!state || state.by === MY_ID || !video || !video.src) return;
    isSyncing = true;
    const drift = Math.abs(video.currentTime - state.currentTime);
    if (drift > 2) video.currentTime = state.currentTime;
    if (state.playing && video.paused)  video.play().catch(()=>{});
    if (!state.playing && !video.paused) video.pause();
    setTimeout(() => { isSyncing = false; }, 600);
    const dot   = document.getElementById("sync-dot");
    const label = document.getElementById("sync-label");
    dot.style.color     = drift <= 2 ? "#4ade80" : "#f0c060";
    label.textContent   = drift <= 2 ? "● In sync with partner ✓" : "● Resyncing...";
  });
}

function updateProgressUI() {
  if (!video.duration) return;
  document.getElementById("progress-fill").style.width = (video.currentTime/video.duration*100)+"%";
  const fmt = t => `${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,"0")}`;
  document.getElementById("time-label").textContent = fmt(video.currentTime)+" / "+fmt(video.duration);
  document.getElementById("play-pause-btn").textContent = video.paused ? "▶" : "⏸";
}

window.togglePlay = function() {
  if (!video.src) { showToast("Load a video first!"); return; }
  video.paused ? video.play() : video.pause();
};
window.skip = function(s) {
  if (!video.src) return;
  video.currentTime = Math.max(0, Math.min(video.duration||0, video.currentTime+s));
};
window.seekTo = function(e) {
  if (!video.duration) return;
  video.currentTime = (e.offsetX/e.currentTarget.offsetWidth)*video.duration;
};

// =============================================
//  REACTIONS with counters + floating hearts
// =============================================
const BIG_EMOJIS = ["😂","😭","🔥","🤯","😱"];
const HEART_EMOJIS = ["❤️","💕","🥰","😘"];
const reactionJoinTime = Date.now();

window.sendReaction = function(emoji, btn) {
  push(reactRef, { emoji, by: MY_NAME, at: Date.now() });
  triggerReaction(emoji, true);
};

function triggerReaction(emoji, isMe) {
  // Update counter
  if (!reactCounts[emoji]) reactCounts[emoji] = 0;
  reactCounts[emoji]++;
  updateReactCount(emoji);

  // Floating emoji
  const count = reactCounts[emoji];
  const isBig = BIG_EMOJIS.includes(emoji) && count >= 2;
  spawnEmoji(emoji, isBig);

  // Extra floating hearts for heart emojis
  if (HEART_EMOJIS.includes(emoji)) {
    for (let i = 0; i < Math.min(count + 1, 5); i++) {
      setTimeout(() => spawnHeart(), i * 150);
    }
  }
}

function updateReactCount(emoji) {
  const map = {
    "❤️":"heart","😂":"laugh","😱":"shock","😭":"cry",
    "🔥":"fire","👏":"clap","🥰":"love","💕":"hearts",
    "🤣":"rofl","😴":"sleep","🤯":"mind","✨":"spark"
  };
  const key = map[emoji];
  if (!key) return;
  const el = document.getElementById("cnt-" + key);
  if (!el) return;
  const n = reactCounts[emoji] || 0;
  if (n > 1) { el.textContent = n; el.classList.add("show"); }
  else        { el.classList.remove("show"); }
}

function listenForReactions() {
  onValue(reactRef, (snap) => {
    const data = snap.val() || {};
    Object.values(data).forEach((item) => {
      if (item.at > reactionJoinTime && item.by !== MY_NAME) {
        triggerReaction(item.emoji, false);
      }
    });
  });
}

function spawnEmoji(emoji, big) {
  const el = document.createElement("div");
  el.className = "float-emoji" + (big ? " big" : "");
  el.textContent = emoji;
  el.style.cssText = `left:${30+Math.random()*(window.innerWidth-80)}px;bottom:160px;`;
  document.getElementById("float-container").appendChild(el);
  setTimeout(() => el.remove(), big ? 3300 : 2900);
}

function spawnHeart() {
  const el = document.createElement("div");
  el.className = "float-heart";
  el.textContent = "❤️";
  const drift = (Math.random()-0.5)*120;
  el.style.cssText = `left:${30+Math.random()*(window.innerWidth-80)}px;bottom:${100+Math.random()*80}px;--drift:${drift}px;font-size:${16+Math.random()*16}px;`;
  document.getElementById("float-container").appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// =============================================
//  MOOD
// =============================================
window.setMood = function(btn, mood) {
  document.querySelectorAll(".mood-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  set(moodRef, { name:MY_NAME, mood, at:Date.now() });
  showToast("Mood shared 💕");
};
function listenForMoods() {
  onValue(ref(db, `rooms/${ROOM}/moods`), (snap) => {
    const others = Object.entries(snap.val()||{}).filter(([id]) => id!==MY_ID).map(([,v])=>v);
    if (others.length > 0) {
      document.getElementById("partner-mood-row").style.display = "flex";
      document.getElementById("partner-mood-label").textContent = PARTNER_NAME + " feels:";
      document.getElementById("partner-mood-value").textContent = others[0].mood;
    }
  });
}

// =============================================
//  CHAT — with seen status + timestamps
// =============================================
let lastSeenAt = 0;

window.sendChatMessage = function() {
  const input = document.getElementById("chat-input");
  const text  = input.value.trim();
  if (!text) return;
  push(chatRef, { name:MY_NAME, text, localAt:Date.now() });
  input.value = "";
  remove(typingRef); // stop typing indicator when sent
  clearTimeout(typingTimer);
};
window.sendChatEmoji = function(emoji) {
  push(chatRef, { name:MY_NAME, text:emoji, localAt:Date.now(), emojiOnly:true });
};

// Track when partner last saw messages
onValue(seenRef, () => {});
onValue(ref(db, `rooms/${ROOM}/seen`), (snap) => {
  const data = snap.val() || {};
  const others = Object.entries(data).filter(([id]) => id !== MY_ID);
  if (others.length > 0) lastSeenAt = others[0][1].at || 0;
  renderMessages(); // re-render to update seen ticks
});

let cachedMessages = [];
function listenForMessages() {
  onValue(chatRef, (snap) => {
    cachedMessages = Object.values(snap.val() || {});
    renderMessages();
    // Mark as seen if chat is active
    if (document.getElementById("tab-chat").classList.contains("active")) markSeen();
    else document.getElementById("chat-badge").style.display = "inline";
  });
}

function renderMessages() {
  const list = document.getElementById("messages-list");
  list.innerHTML = "";
  let lastDate = "";

  cachedMessages.forEach((msg) => {
    const mine = msg.name === MY_NAME;
    const msgDate = msg.localAt ? new Date(msg.localAt).toDateString() : "";

    // Date separator
    if (msgDate && msgDate !== lastDate) {
      lastDate = msgDate;
      const sep = document.createElement("div");
      sep.className = "date-sep";
      sep.textContent = msgDate === new Date().toDateString() ? "Today" : msgDate;
      list.appendChild(sep);
    }

    const div = document.createElement("div");
    div.className = `message ${mine ? "mine" : "theirs"}`;

    const time     = msg.localAt ? formatTime(msg.localAt) : "";
    const isSeen   = mine && msg.localAt && lastSeenAt > msg.localAt;
    const seenHtml = mine
      ? `<span class="msg-seen ${isSeen ? "seen" : "unseen"}">${isSeen ? "✔✔" : "✔"}</span>`
      : "";

    div.innerHTML = `
      <span class="msg-name">${esc(msg.name)} ${mine ? "💙" : "💛"}</span>
      <div class="msg-bubble${msg.emojiOnly ? " emoji-only" : ""}">${esc(msg.text)}</div>
      <div class="msg-meta">
        <span class="msg-time">${time}</span>
        ${seenHtml}
      </div>
    `;
    list.appendChild(div);
  });

  const w = document.querySelector(".chat-wrapper");
  if (w) w.scrollTop = w.scrollHeight;
}

// =============================================
//  TABS
// =============================================
window.switchTab = function(name, el) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  document.getElementById("tab-"+name).classList.add("active");
  el.classList.add("active");
  if (name === "chat") {
    document.getElementById("chat-badge").style.display = "none";
    markSeen();
    setTimeout(() => { const w=document.querySelector(".chat-wrapper"); if(w) w.scrollTop=w.scrollHeight; }, 50);
  }
};

window.copyRoomCode = function() {
  navigator.clipboard.writeText(ROOM)
    .then(() => showToast("Room code copied! Send it to "+PARTNER_NAME+" 💕"))
    .catch(() => showToast("Room: "+ROOM));
};

// =============================================
//  WebRTC CALL
// =============================================
const ICE = { iceServers:[{urls:"stun:stun.l.google.com:19302"},{urls:"stun:stun1.l.google.com:19302"}] };

function listenForSignals() {
  onValue(signalRef, async (snap) => {
    const data = snap.val() || {};
    for (const [id, sig] of Object.entries(data)) {
      if (sig.to !== MY_ID) continue;
      if      (sig.type==="offer"         && !peerConnection) await handleOffer(sig);
      else if (sig.type==="answer"        && peerConnection)  await peerConnection.setRemoteDescription(new RTCSessionDescription(sig.sdp)).catch(console.error);
      else if (sig.type==="ice-candidate" && peerConnection)  await peerConnection.addIceCandidate(new RTCIceCandidate(sig.candidate)).catch(()=>{});
      remove(ref(db, `rooms/${ROOM}/signals/${id}`));
    }
  });
}
async function getPartnerId() {
  const snap = await get(ref(db, `rooms/${ROOM}/presence`));
  return Object.keys(snap.val()||{}).filter(id=>id!==MY_ID)[0] || null;
}
async function buildPeer(stream) {
  peerConnection = new RTCPeerConnection(ICE);
  stream.getTracks().forEach(t => peerConnection.addTrack(t, stream));
  peerConnection.ontrack = e => {
    const rv = document.getElementById("remote-video");
    if (rv.srcObject !== e.streams[0]) { rv.srcObject=e.streams[0]; document.getElementById("remote-video-wrap").style.display="block"; }
  };
  peerConnection.onicecandidate = async e => {
    if (!e.candidate) return;
    const pid = await getPartnerId();
    if (pid) push(signalRef, {type:"ice-candidate",candidate:e.candidate.toJSON(),from:MY_ID,to:pid});
  };
  peerConnection.onconnectionstatechange = () => {
    const s=peerConnection.connectionState, el=document.getElementById("call-status");
    if (s==="connected") { el.textContent="✓ Connected with "+PARTNER_NAME+" 💕"; el.className="call-status connected"; }
    else if (s==="disconnected"||s==="failed") { el.textContent="Call ended."; el.className="call-status"; endCall(); }
  };
}
async function handleOffer(sig) {
  const c = sig.callType==="video" ? {audio:true,video:true} : {audio:true};
  try { localStream=await navigator.mediaDevices.getUserMedia(c); } catch { showToast("Could not access mic/camera."); return; }
  showLocalPreview(sig.callType==="video");
  await buildPeer(localStream);
  await peerConnection.setRemoteDescription(new RTCSessionDescription(sig.sdp));
  const answer=await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  push(signalRef, {type:"answer",sdp:peerConnection.localDescription.toJSON(),from:MY_ID,to:sig.from});
  callActive=true; callType=sig.callType; updateCallUI(); showToast("Call connected with "+PARTNER_NAME+" 💕");
}
window.toggleVoiceCall = async function() { callActive ? endCall() : await initiateCall("voice"); };
window.toggleVideoCall = async function() { callActive ? endCall() : await initiateCall("video"); };
async function initiateCall(type) {
  const pid=await getPartnerId();
  if (!pid) { showToast(PARTNER_NAME+" is not in the room yet!"); return; }
  const c = type==="video" ? {audio:true,video:true} : {audio:true};
  try { localStream=await navigator.mediaDevices.getUserMedia(c); } catch { showToast("Could not access mic/camera."); return; }
  showLocalPreview(type==="video");
  await buildPeer(localStream);
  const offer=await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  push(signalRef, {type:"offer",sdp:peerConnection.localDescription.toJSON(),callType:type,from:MY_ID,to:pid});
  callActive=true; callType=type; updateCallUI();
  document.getElementById("call-status").textContent="Calling "+PARTNER_NAME+"... 📞";
}
function showLocalPreview(v) {
  document.getElementById("local-video").srcObject=localStream;
  if (v) document.getElementById("local-video-wrap").style.display="block";
}
function updateCallUI() {
  const vb=document.getElementById("voice-btn"), vd=document.getElementById("video-btn");
  if (callActive) {
    vb.querySelector("span:last-child").textContent=callType==="voice"?"End Call":"Voice Call";
    vd.querySelector("span:last-child").textContent=callType==="video"?"End Call":"Video Call";
    if (callType==="voice") vb.classList.add("active");
    if (callType==="video") vd.classList.add("active");
  } else {
    vb.className="call-btn"; vd.className="call-btn";
    vb.querySelector("span:last-child").textContent="Voice Call";
    vd.querySelector("span:last-child").textContent="Video Call";
  }
}
function endCall() {
  if (localStream) localStream.getTracks().forEach(t=>t.stop());
  if (peerConnection) { peerConnection.close(); peerConnection=null; }
  localStream=null; callActive=false; callType=null;
  ["local-video-wrap","remote-video-wrap"].forEach(id=>document.getElementById(id).style.display="none");
  document.getElementById("local-video").srcObject=null;
  document.getElementById("remote-video").srcObject=null;
  document.getElementById("call-status").textContent="Call ended. Miss them already? 💕";
  document.getElementById("call-status").className="call-status";
  updateCallUI();
}

// =============================================
//  UTILS
// =============================================
function formatTime(ts) {
  const d=new Date(ts);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2,"0")}`;
}
function esc(str) {
  if (!str) return "";
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
window.showToast = function(msg) {
  const t=document.getElementById("toast");
  t.style.background=""; t.style.borderColor="";
  t.textContent=msg; t.classList.add("show");
  clearTimeout(t._timer);
  t._timer=setTimeout(()=>t.classList.remove("show"), 3000);
};
function showErrorToast(msg) {
  const t=document.getElementById("toast");
  t.style.background="rgba(80,10,10,0.97)"; t.style.borderColor="#e8637a";
  t.textContent="❌ "+msg; t.classList.add("show");
  clearTimeout(t._timer);
  t._timer=setTimeout(()=>{ t.classList.remove("show"); t.style.background=""; t.style.borderColor=""; }, 8000);
}
