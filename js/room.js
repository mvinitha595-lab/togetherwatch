// TogetherWatch v8
// ✅ Mobile camera stays on (iOS + Android fix)
// ✅ Fullscreen call UI with both faces
// ✅ Incoming call modal with Accept/Decline
// ✅ Both-end call termination
// ✅ Message/reaction/call sounds + vibration
// ✅ Browser notifications
// ✅ All previous features

import { db } from "./firebase-config.js";
import {
  ref, set, onValue, push, update, get, onDisconnect, remove
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ── Identity ──────────────────────────────────────────────
const params       = new URLSearchParams(window.location.search);
const ROOM         = params.get("room") || sessionStorage.getItem("tw_room");
const MY_NAME      = sessionStorage.getItem("tw_name")    || "You";
const PARTNER_NAME = sessionStorage.getItem("tw_partner") || "Partner";
const COUPLE_NAME  = sessionStorage.getItem("tw_couple")  || "";
const DISTANCE     = sessionStorage.getItem("tw_distance")|| "";
const AVATAR_YOU   = sessionStorage.getItem("tw_avatar_you")     || "";
const AVATAR_PAR   = sessionStorage.getItem("tw_avatar_partner") || "";
const MY_ID        = MY_NAME + "_" + Math.random().toString(36).slice(2,8);

// ── State ──────────────────────────────────────────────────
let video          = null;
let isSyncing      = false;
let callActive     = false;
let callType       = null;
let localStream    = null;
let pc             = null;
let isMuted        = false;
let isCamOff       = false;
let whisperMode    = false;
let sleepMode      = false;
let selectedFile   = null;
let typingTimer    = null;
let lastSeenAt     = 0;
let cachedMsgs     = [];
let pendingOffer   = null;    // stores incoming offer until accepted
let ringTimer      = null;
const rcounts      = {};

// Detect iOS Safari
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

// ── Firebase refs ──────────────────────────────────────────
const roomRef     = ref(db, `rooms/${ROOM}`);
const chatRef     = ref(db, `rooms/${ROOM}/messages`);
const playRef     = ref(db, `rooms/${ROOM}/playState`);
const reactRef    = ref(db, `rooms/${ROOM}/reactions`);
const presRef     = ref(db, `rooms/${ROOM}/presence/${MY_ID}`);
const moodRef     = ref(db, `rooms/${ROOM}/moods/${MY_ID}`);
const sigRef      = ref(db, `rooms/${ROOM}/signals`);
const typingRef   = ref(db, `rooms/${ROOM}/typing/${MY_ID}`);
const seenRef     = ref(db, `rooms/${ROOM}/seen/${MY_ID}`);
const callCtrlRef = ref(db, `rooms/${ROOM}/callControl`);

// ── BOOT ───────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  if (!ROOM) { window.location.href = "../index.html"; return; }
  sessionStorage.setItem("tw_room", ROOM);
  video = document.getElementById("main-video");

  document.getElementById("room-code").textContent         = ROOM;
  document.getElementById("hdr-name-you").textContent      = MY_NAME;
  document.getElementById("hdr-name-partner").textContent  = PARTNER_NAME;
  document.getElementById("typing-name").textContent       = PARTNER_NAME;
  document.getElementById("call-remote-name").textContent  = PARTNER_NAME;
  document.getElementById("self-label").textContent        = MY_NAME;
  document.getElementById("par-mood-lbl").textContent      = PARTNER_NAME + " feels:";
  document.getElementById("incoming-caller-name").textContent = PARTNER_NAME;

  setAvatarEl("hdr-avatar-you",     AVATAR_YOU);
  setAvatarEl("hdr-avatar-partner", AVATAR_PAR);
  setAvatarEl("call-remote-avatar", AVATAR_PAR);
  setAvatarEl("incoming-avatar",    AVATAR_PAR);

  if (DISTANCE) {
    document.getElementById("dist-badge").style.display = "flex";
    document.getElementById("dist-text").textContent = DISTANCE;
  }

  fillProfileTab();

  set(presRef, { name: MY_NAME, joinedAt: Date.now() });
  onDisconnect(presRef).remove();
  onDisconnect(typingRef).remove();

  listenPresence();
  listenPlayState();
  listenVideoUrl();
  listenMoods();
  listenTyping();
  listenSeen();

  // Notification-enhanced listeners
  setTimeout(() => {
    listenMessagesWithSound();
    listenReactionsWithSound();
    listenSignalsWithNotif();
    listenCallControl();
  }, 150);

  video.addEventListener("play",       pushPlay);
  video.addEventListener("pause",      pushPlay);
  video.addEventListener("seeked",     pushPlay);
  video.addEventListener("timeupdate", updateProgress);
  video.addEventListener("ended", () => { document.getElementById("pp-btn").textContent = "▶"; });

  document.getElementById("vol-slider").addEventListener("input", e => {
    video.volume = parseFloat(e.target.value);
  });

  // Ask notification permission on first tap
  document.addEventListener("click", () => {
    askNotifPermission();
    AC.resume().catch(()=>{});
  }, { once: true });

  // iOS: handle app going to background — keep stream alive
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pagehide", handlePageHide);

  renderHistory();
});

// ── AVATAR ─────────────────────────────────────────────────
function setAvatarEl(id, src) {
  const el = document.getElementById(id); if (!el) return;
  if (src && src.startsWith("data:")) el.innerHTML = `<img src="${src}" alt="av" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"/>`;
  else el.textContent = src || "😊";
}

// ── iOS / Android background fix ───────────────────────────
function handleVisibilityChange() {
  if (document.hidden) {
    // App went to background — keep stream alive on iOS
    if (localStream) {
      localStream.getTracks().forEach(t => {
        // Don't stop tracks, just note they may need restart
        t._wasEnabled = t.enabled;
      });
    }
  } else {
    // App came back to foreground — check if tracks are still live
    if (localStream && callActive) {
      localStream.getTracks().forEach(async t => {
        if (t.readyState === "ended") {
          // Track died while in background — restart stream
          toast("Reconnecting camera... 🔄");
          await restartMediaStream();
        } else {
          // Restore enabled state
          if (t._wasEnabled !== undefined) t.enabled = t._wasEnabled;
        }
      });
    }
  }
}

function handlePageHide() {
  // iOS fires pagehide instead of unload
  // Don't stop tracks here — just let them be
}

async function restartMediaStream() {
  if (!callActive || !pc) return;
  try {
    const constraints = getConstraints(callType);
    const newStream = await getMedia(constraints);
    if (!newStream) return;

    // Replace tracks in peer connection
    const senders = pc.getSenders();
    newStream.getTracks().forEach(newTrack => {
      const sender = senders.find(s => s.track && s.track.kind === newTrack.kind);
      if (sender) sender.replaceTrack(newTrack);
    });

    // Stop old tracks
    localStream.getTracks().forEach(t => t.stop());
    localStream = newStream;

    // Update local video preview
    const lv = document.getElementById("call-local-video");
    if (lv) lv.srcObject = localStream;

    toast("Camera reconnected ✓");
  } catch(e) {
    toast("Could not restart camera: " + e.message);
  }
}

// ── PRESENCE ───────────────────────────────────────────────
function listenPresence() {
  onValue(ref(db, `rooms/${ROOM}/presence`), snap => {
    const others = Object.entries(snap.val()||{}).filter(([id]) => id !== MY_ID);
    document.getElementById("partner-dot").className = others.length > 0 ? "c-dot on" : "c-dot off";
  });
}

// ── SOURCE TABS ────────────────────────────────────────────
window.setSrcTab = function(tab) {
  ["url","upload","history"].forEach(t => {
    document.getElementById("sp-"+t).style.display = t === tab ? "block" : "none";
    document.getElementById("st-"+t).classList.toggle("active", t === tab);
  });
  if (tab === "history") renderHistory();
};

// ── VIDEO URL ──────────────────────────────────────────────
function toStream(url) {
  const dm = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (dm) return `https://drive.google.com/uc?export=download&id=${dm[1]}&confirm=t`;
  if (url.includes("dropbox.com"))
    return url.replace("www.dropbox.com","dl.dropboxusercontent.com").replace("?dl=0","").replace("&dl=0","");
  if (url.includes("1drv.ms") || url.includes("onedrive.live.com"))
    return url.replace("redir?","download?").replace("embed?","download?");
  return url;
}
function extractTitle(url) {
  try { return decodeURIComponent(url.split("/").pop().split("?")[0]).substring(0,40) || "Video"; } catch { return "Video"; }
}

window.loadUrl = function() {
  let raw = document.getElementById("video-url").value.trim();
  if (!raw) { toast("Paste a video URL first!"); return; }
  if (raw.includes("youtube.com") || raw.includes("youtu.be")) { errToast("YouTube blocks external players. Upload to Google Drive instead."); return; }
  if (raw.includes("netflix.com") || raw.includes("primevideo.com") || raw.includes("hotstar.com")) { errToast("Streaming services block external players."); return; }
  const url = toStream(raw);
  if (url !== raw) { document.getElementById("video-url").value = url; toast("Link converted ✓"); }
  update(roomRef, { videoUrl:url, videoLoadedBy:MY_NAME, videoTitle:extractTitle(url) });
  applyVideo(url, extractTitle(url));
};

function listenVideoUrl() {
  onValue(ref(db,`rooms/${ROOM}/videoUrl`), snap => {
    const url = snap.val(); if (!url) return;
    if (video.getAttribute("data-src") === url) return;
    get(ref(db,`rooms/${ROOM}/videoLoadedBy`)).then(s => {
      if (s.val() === MY_NAME) return;
      get(ref(db,`rooms/${ROOM}/videoTitle`)).then(t => {
        applyVideo(url, t.val()||"Video");
        toast(PARTNER_NAME + " loaded a video 🎬");
      });
    });
  });
}

function applyVideo(url, title) {
  video.pause(); video.removeAttribute("src"); video.load();
  video.src = url; video.setAttribute("data-src", url);
  video.onerror = () => errToast("Video failed. Try Google Drive ('Anyone with the link' sharing).");
  video.oncanplay = () => toast("✓ Video ready! Press ▶ 🎬");
  video.style.display = "block"; video.classList.add("active");
  document.getElementById("ph").style.display = "none";
  document.getElementById("ctrl-bar").style.display = "flex";
  document.getElementById("vol-row").style.display = "flex";
  document.getElementById("sync-row").style.display = "flex";
  toast("Loading video...");
  addHistory(url, title || extractTitle(url));
}

// ── HISTORY ────────────────────────────────────────────────
function getHistory() { try { return JSON.parse(localStorage.getItem("tw_history")||"[]"); } catch { return []; } }
function addHistory(url, title) {
  let h = getHistory().filter(i => i.url !== url);
  h.unshift({ url, title, at: Date.now() });
  localStorage.setItem("tw_history", JSON.stringify(h.slice(0,10)));
}
function renderHistory() {
  const list = document.getElementById("history-list"); if (!list) return;
  const h = getHistory();
  list.innerHTML = "";
  if (!h.length) { list.innerHTML='<p style="font-size:12px;color:var(--muted)">No history yet</p>'; return; }
  h.forEach((item, i) => {
    const div = document.createElement("div"); div.className = "history-item";
    div.innerHTML = `<span class="history-icon">🎬</span><span class="history-name">${esc(item.title)}</span><button class="history-del" onclick="event.stopPropagation();delHistory(${i})">✕</button>`;
    div.addEventListener("click", () => { applyVideo(item.url, item.title); update(roomRef, {videoUrl:item.url, videoLoadedBy:MY_NAME, videoTitle:item.title}); });
    list.appendChild(div);
  });
}
window.delHistory = function(i) {
  const h = getHistory(); h.splice(i,1); localStorage.setItem("tw_history", JSON.stringify(h)); renderHistory();
};

// ── FILE UPLOAD ────────────────────────────────────────────
window.onFileChosen = function(e) {
  const f = e.target.files[0]; if (!f) return;
  selectedFile = f;
  document.getElementById("upload-name").textContent = "📽 " + f.name;
  document.getElementById("upload-bar").style.display = "flex";
};
window.onDrop = function(e) {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith("video/")) { selectedFile = f; document.getElementById("upload-name").textContent = "📽 " + f.name; document.getElementById("upload-bar").style.display = "flex"; }
};
window.loadFile = function() {
  if (!selectedFile) { toast("Pick a video file first!"); return; }
  const url = URL.createObjectURL(selectedFile);
  applyVideo(url, selectedFile.name);
  video.setAttribute("data-src","local:"+selectedFile.name);
  update(roomRef, {videoUrl:"",videoLoadedBy:MY_NAME,videoHint:MY_NAME+" loaded: "+selectedFile.name});
  toast("Loaded! Partner must load the same file 🎬");
};

// ── PLAYBACK SYNC ──────────────────────────────────────────
function pushPlay() {
  if (isSyncing || !video.src) return;
  update(playRef, {playing:!video.paused,currentTime:video.currentTime,updatedAt:Date.now(),by:MY_ID});
}
function listenPlayState() {
  onValue(playRef, snap => {
    const s = snap.val(); if (!s || s.by===MY_ID || !video || !video.src) return;
    isSyncing = true;
    const drift = Math.abs(video.currentTime - s.currentTime);
    if (drift > 2) video.currentTime = s.currentTime;
    if (s.playing && video.paused)   video.play().catch(()=>{});
    if (!s.playing && !video.paused) video.pause();
    setTimeout(() => { isSyncing = false; }, 600);
    document.getElementById("sync-dot").style.color = drift <= 2 ? "#4ade80" : "#f0c060";
    document.getElementById("sync-label").textContent = drift <= 2 ? "● In sync with "+PARTNER_NAME+" ✓" : "● Resyncing...";
  });
}
function updateProgress() {
  if (!video.duration) return;
  document.getElementById("prog-fill").style.width = (video.currentTime/video.duration*100)+"%";
  const f = t => `${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,"0")}`;
  document.getElementById("time-lbl").textContent = f(video.currentTime)+" / "+f(video.duration);
  document.getElementById("pp-btn").textContent = video.paused ? "▶" : "⏸";
  if (whisperMode && !video.paused) video.volume = 0.2;
}
window.togglePlay = () => { if (!video.src) { toast("Load a video first!"); return; } video.paused ? video.play() : video.pause(); };
window.skip = s => { if (!video.src) return; video.currentTime = Math.max(0,Math.min(video.duration||0,video.currentTime+s)); };
window.seekTo = e => { if (!video.duration) return; video.currentTime = (e.offsetX/e.currentTarget.offsetWidth)*video.duration; };
window.setVolume = v => { if (video) video.volume = parseFloat(v); };
window.toggleWhisper = function() {
  whisperMode = !whisperMode;
  const btn = document.getElementById("whisper-btn");
  btn.classList.toggle("active", whisperMode);
  btn.textContent = whisperMode ? "🤫 ON" : "🤫 Whisper";
  if (!whisperMode && video) video.volume = parseFloat(document.getElementById("vol-slider").value);
  toast(whisperMode ? "Whisper Mode ON 🤫" : "Whisper Mode OFF");
};
window.toggleSleep = function() {
  sleepMode = !sleepMode;
  document.getElementById("sleep-overlay").classList.toggle("on", sleepMode);
  document.getElementById("sleep-btn").classList.toggle("active", sleepMode);
  document.getElementById("sleep-btn").textContent = sleepMode ? "☀️ Wake Up" : "🌙 Sleep Together Mode";
  if (video) video.volume = sleepMode ? 0.15 : parseFloat(document.getElementById("vol-slider").value);
  toast(sleepMode ? "Sleep Mode 🌙 Sweet dreams 💕" : "Good morning! ☀️");
};

// ── REACTIONS ──────────────────────────────────────────────
const BIG   = ["😂","😭","🔥","🤯","😱"];
const HARTS = ["❤️","💕","🥰"];
const EI    = ["❤️","😂","😱","😭","🔥","👏","🥰","💕","🤣","😴","🤯","✨"];
const jtReact = Date.now();

window.react = function(emoji, btn) {
  push(reactRef, {emoji, by:MY_NAME, at:Date.now()});
  doReact(emoji);
};
function doReact(emoji) {
  rcounts[emoji] = (rcounts[emoji]||0)+1;
  const i = EI.indexOf(emoji);
  if (i >= 0) {
    const el = document.getElementById("rc-"+i);
    if (el) { const n=rcounts[emoji]; if(n>1){el.textContent=n;el.classList.add("on");}else el.classList.remove("on"); }
  }
  const big = BIG.includes(emoji) && rcounts[emoji] >= 2;
  spawnEmoji(emoji, big);
  if (HARTS.includes(emoji)) for (let i=0;i<Math.min(rcounts[emoji]+1,6);i++) setTimeout(()=>spawnHeart(),i*140);
}
function spawnEmoji(emoji, big) {
  const el = document.createElement("div");
  el.className = "fe" + (big ? " big" : "");
  el.textContent = emoji;
  el.style.cssText = `font-size:${big?64:36}px;left:${30+Math.random()*(window.innerWidth-80)}px;bottom:155px;`;
  document.getElementById("float-con").appendChild(el);
  setTimeout(() => el.remove(), big ? 3300 : 2900);
}
function spawnHeart() {
  const el = document.createElement("div"); el.className = "fh"; el.textContent = "❤️";
  el.style.cssText = `left:${30+Math.random()*(window.innerWidth-80)}px;bottom:${95+Math.random()*70}px;--drift:${(Math.random()-.5)*110}px;font-size:${15+Math.random()*15}px;`;
  document.getElementById("float-con").appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// ── MOOD ───────────────────────────────────────────────────
window.setMood = function(btn, mood) {
  document.querySelectorAll(".mood-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  set(moodRef, {name:MY_NAME,mood,at:Date.now()});
  toast("Mood shared 💕");
};
function listenMoods() {
  onValue(ref(db,`rooms/${ROOM}/moods`), snap => {
    const others = Object.entries(snap.val()||{}).filter(([id])=>id!==MY_ID).map(([,v])=>v);
    if (others.length > 0) {
      document.getElementById("par-mood").style.display = "flex";
      document.getElementById("par-mood-val").textContent = others[0].mood;
    }
  });
}

// ── CHAT ───────────────────────────────────────────────────
window.sendMsg = function() {
  const inp = document.getElementById("chat-in"), t = inp.value.trim(); if (!t) return;
  push(chatRef, {name:MY_NAME,text:t,localAt:Date.now()});
  inp.value = ""; remove(typingRef); clearTimeout(typingTimer);
  if (whisperMode && video && !video.paused) video.volume = parseFloat(document.getElementById("vol-slider").value);
};
window.chatEmoji = e => push(chatRef, {name:MY_NAME,text:e,localAt:Date.now(),eo:true});
window.onTyping = function() {
  set(typingRef, {name:MY_NAME,at:Date.now()});
  clearTimeout(typingTimer); typingTimer = setTimeout(() => remove(typingRef), 3000);
  if (whisperMode && video && !video.paused) video.volume = 0.2;
};
function listenTyping() {
  onValue(ref(db,`rooms/${ROOM}/typing`), snap => {
    const others = Object.entries(snap.val()||{}).filter(([id])=>id!==MY_ID);
    document.getElementById("typing-ind").classList.toggle("show", others.length > 0);
  });
}
function listenSeen() {
  onValue(ref(db,`rooms/${ROOM}/seen`), snap => {
    const others = Object.entries(snap.val()||{}).filter(([id])=>id!==MY_ID);
    if (others.length > 0) lastSeenAt = others[0][1].at || 0;
    renderMsgs();
  });
}
function markSeen() { set(seenRef, {name:MY_NAME,at:Date.now()}); }

function listenMessagesWithSound() {
  const joinT = Date.now();
  onValue(chatRef, snap => {
    const msgs = Object.values(snap.val()||{});
    msgs.forEach(msg => {
      if (msg.localAt && msg.localAt > joinT && msg.name !== MY_NAME) {
        playMsgSound();
        showNotif("💬 "+PARTNER_NAME, msg.eo ? msg.text : msg.text, "💬");
        if (navigator.vibrate) navigator.vibrate(80);
      }
    });
    cachedMsgs = msgs;
    renderMsgs();
    if (!document.getElementById("tab-chat").classList.contains("active"))
      document.getElementById("chat-badge").style.display = "inline";
  });
}

function renderMsgs() {
  const list = document.getElementById("msg-list"); list.innerHTML = "";
  let lastDate = "";
  cachedMsgs.forEach(msg => {
    const mine = msg.name === MY_NAME;
    const md = msg.localAt ? new Date(msg.localAt).toDateString() : "";
    if (md && md !== lastDate) {
      lastDate = md;
      const sep = document.createElement("div"); sep.className = "date-sep";
      sep.textContent = md === new Date().toDateString() ? "Today" : md;
      list.appendChild(sep);
    }
    const div = document.createElement("div"); div.className = "message "+(mine?"mine":"theirs");
    const time = msg.localAt ? fmtTime(msg.localAt) : "";
    const seen = mine && msg.localAt && lastSeenAt > msg.localAt;
    const seenHtml = mine ? `<span class="msg-seen ${seen?"s":"u"}">${seen?"✔✔":"✔"}</span>` : "";
    div.innerHTML = `
      <span class="msg-name">${esc(msg.name)} ${mine?"💙":"💛"}</span>
      <div class="bubble${msg.eo?" eo":""}">${esc(msg.text)}</div>
      <div class="msg-meta"><span class="msg-time">${time}</span>${seenHtml}</div>`;
    list.appendChild(div);
  });
  const w = document.querySelector(".chat-wrap"); if (w) w.scrollTop = w.scrollHeight;
}

// ── TABS ───────────────────────────────────────────────────
window.switchTab = function(name, el) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  document.getElementById("tab-"+name).classList.add("active"); el.classList.add("active");
  if (name === "chat") { document.getElementById("chat-badge").style.display="none"; markSeen(); setTimeout(()=>{const w=document.querySelector(".chat-wrap");if(w)w.scrollTop=w.scrollHeight;},50); }
  if (name === "profile") fillProfileTab();
};
window.copyCode = () => navigator.clipboard.writeText(ROOM).then(()=>toast("Copied! Send to "+PARTNER_NAME+" 💕")).catch(()=>toast("Room: "+ROOM));

// ── PROFILE ────────────────────────────────────────────────
function fillProfileTab() {
  document.getElementById("prof-couple-name").textContent = COUPLE_NAME||"Your Couple Name 💕";
  document.getElementById("prof-name-you").textContent    = MY_NAME;
  document.getElementById("prof-name-partner").textContent= PARTNER_NAME;
  setAvatarEl("prof-av-you",     AVATAR_YOU);
  setAvatarEl("prof-av-partner", AVATAR_PAR);
  document.getElementById("edit-couple").value  = COUPLE_NAME;
  document.getElementById("edit-myname").value  = MY_NAME;
  document.getElementById("edit-partner").value = PARTNER_NAME;
  document.getElementById("edit-dist").value    = DISTANCE;
  if (DISTANCE) { document.getElementById("prof-dist").style.display="flex"; document.getElementById("prof-km").textContent=DISTANCE; }
  const jd = localStorage.getItem("tw_joined");
  if (jd) {
    document.getElementById("edit-joined").value = jd;
    const d=new Date(jd),now=new Date(),days=Math.floor((now-d)/(1000*60*60*24));
    document.getElementById("prof-since").textContent = "Together since "+d.toLocaleDateString("en-IN",{day:"numeric",month:"long",year:"numeric"})+" · "+days+" days 💕";
  }
}
window.pickAvatar2 = who => document.getElementById("prof-av-"+who+"-file").click();
window.loadProfileAvatar = function(who, e) {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = ev => {
    const d = ev.target.result;
    localStorage.setItem("tw_avatar_"+who, d);
    sessionStorage.setItem("tw_avatar_"+who, d);
    setAvatarEl("prof-av-"+who, d);
    setAvatarEl("hdr-avatar-"+who, d);
    toast("Photo updated 💕");
  };
  r.readAsDataURL(f);
};
window.saveProfile = function() {
  const cn=document.getElementById("edit-couple").value.trim();
  const dist=document.getElementById("edit-dist").value.trim();
  const jd=document.getElementById("edit-joined").value;
  sessionStorage.setItem("tw_couple",cn); sessionStorage.setItem("tw_distance",dist);
  if (jd) localStorage.setItem("tw_joined",jd);
  document.getElementById("prof-couple-name").textContent = cn||"Your Couple Name 💕";
  if (dist) { document.getElementById("prof-dist").style.display="flex"; document.getElementById("prof-km").textContent=dist; document.getElementById("dist-badge").style.display="flex"; document.getElementById("dist-text").textContent=dist; }
  fillProfileTab(); toast("Saved! 💕");
};

// ══════════════════════════════════════════════════════════
//  WebRTC CALL — Mobile-fixed version
// ══════════════════════════════════════════════════════════
const ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
  ]
};

// Mobile-friendly media constraints
function getConstraints(type) {
  if (type === "video") {
    return {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 44100,
      },
      video: isIOS ? {
        // iOS Safari works better with these specific constraints
        facingMode: "user",
        width:  { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 24, max: 30 },
      } : {
        facingMode: "user",
        width:  { ideal: 1280 },
        height: { ideal: 720 },
      }
    };
  }
  return {
    audio: { echoCancellation: true, noiseSuppression: true }
  };
}

// Safe getUserMedia with fallback for iOS
async function getMedia(constraints) {
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch(e) {
    if (e.name === "OverconstrainedError" || e.name === "ConstraintNotSatisfiedError") {
      // Retry with simpler constraints
      toast("Retrying with simpler camera settings...");
      return await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: constraints.video ? { facingMode: "user" } : false
      });
    }
    throw e;
  }
}

// Show the fullscreen call screen
function showCallScreen(withVideo) {
  const screen = document.getElementById("call-screen");
  screen.classList.add("active");
  // Show/hide camera button based on call type
  document.getElementById("cs-cam-btn").style.display = withVideo ? "flex" : "none";
  document.getElementById("call-self-wrap").style.display = withVideo ? "block" : "none";
}

function hideCallScreen() {
  document.getElementById("call-screen").classList.remove("active");
}

function setCallStatus(txt) {
  document.getElementById("call-status-overlay").textContent = txt;
  document.getElementById("call-status-tab").textContent = txt;
  document.getElementById("call-remote-status").textContent = txt;
}

async function buildPC(stream) {
  pc = new RTCPeerConnection(ICE);
  stream.getTracks().forEach(t => {
    pc.addTrack(t, stream);
    // Monitor if track ends (mobile background kill)
    t.addEventListener("ended", async () => {
      if (callActive) {
        toast("Camera interrupted — reconnecting...");
        setTimeout(() => restartMediaStream(), 1000);
      }
    });
  });

  pc.ontrack = e => {
    const remoteVideo = document.getElementById("call-remote-video");
    if (remoteVideo.srcObject !== e.streams[0]) {
      remoteVideo.srcObject = e.streams[0];
      // Hide placeholder, show video
      document.getElementById("call-remote-ph").style.display = "none";
      // iOS Safari needs explicit play
      remoteVideo.play().catch(() => {});
    }
  };

  pc.onicecandidate = async e => {
    if (!e.candidate) return;
    const pid = await getPid();
    if (pid) push(sigRef, {type:"ice-candidate",candidate:e.candidate.toJSON(),from:MY_ID,to:pid});
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === "connected") {
      setCallStatus("✓ Connected with " + PARTNER_NAME + " 💕");
      playCallConnected();
    } else if (s === "disconnected") {
      setCallStatus("Reconnecting...");
      toast("Connection interrupted — trying to reconnect...");
    } else if (s === "failed") {
      setCallStatus("Connection failed");
      hangUp();
    }
  };

  // Handle ICE restart on mobile network change
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "failed") {
      pc.restartIce();
    }
  };
}

async function getPid() {
  const s = await get(ref(db,`rooms/${ROOM}/presence`));
  return Object.keys(s.val()||{}).filter(id=>id!==MY_ID)[0] || null;
}

// ── INCOMING CALL ──────────────────────────────────────────
function listenSignalsWithNotif() {
  onValue(sigRef, async snap => {
    const data = snap.val() || {};
    for (const [id, sig] of Object.entries(data)) {
      if (sig.to !== MY_ID) continue;

      if (sig.type === "offer" && !pc) {
        // Store offer and show incoming modal
        pendingOffer = sig;
        showIncomingCall(sig);
      } else if (sig.type === "answer" && pc) {
        stopRingtone();
        playCallConnected();
        await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp)).catch(console.error);
        // Remote answered — hide placeholder
        document.getElementById("call-remote-ph").style.display = "none";
        setCallStatus("✓ Connected with " + PARTNER_NAME + " 💕");
      } else if (sig.type === "ice-candidate" && pc) {
        await pc.addIceCandidate(new RTCIceCandidate(sig.candidate)).catch(()=>{});
      }
      remove(ref(db, `rooms/${ROOM}/signals/${id}`));
    }
  });
}

function showIncomingCall(sig) {
  startRingtone();
  document.getElementById("incoming-modal").classList.add("show");
  document.getElementById("incoming-type").textContent =
    sig.callType === "video" ? "📹 Incoming Video Call" : "🎙️ Incoming Voice Call";
  showNotif(
    "📞 " + PARTNER_NAME + " is calling!",
    (sig.callType==="video"?"Video":"Voice") + " call — tap to answer 💕",
    sig.callType==="video"?"📹":"🎙️"
  );
  if (navigator.vibrate) navigator.vibrate([500,200,500,200,500,200,500,200,500]);
}

window.acceptCall = async function() {
  if (!pendingOffer) return;
  document.getElementById("incoming-modal").classList.remove("show");
  stopRingtone();
  if (navigator.vibrate) navigator.vibrate(0);

  const sig = pendingOffer; pendingOffer = null;
  const constraints = getConstraints(sig.callType);

  try {
    localStream = await getMedia(constraints);
  } catch(e) {
    toast("Cannot access mic/camera: " + e.message);
    return;
  }

  const lv = document.getElementById("call-local-video");
  lv.srcObject = localStream;

  showCallScreen(sig.callType === "video");
  setCallStatus("Connecting...");
  await buildPC(localStream);

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    push(sigRef, {type:"answer",sdp:pc.localDescription.toJSON(),from:MY_ID,to:sig.from});
  } catch(e) {
    toast("Connection error: " + e.message);
    endCall();
    return;
  }

  callActive = true; callType = sig.callType;
  updateCallUI();
  toast("✓ Call connected! 💕");
};

window.declineCall = function() {
  document.getElementById("incoming-modal").classList.remove("show");
  stopRingtone();
  if (navigator.vibrate) navigator.vibrate(0);
  pendingOffer = null;
  // Tell caller we declined
  set(callCtrlRef, {action:"declined", by:MY_ID, at:Date.now()});
  setTimeout(() => set(callCtrlRef, null), 2000);
  toast("Call declined");
};

// ── OUTGOING CALL ──────────────────────────────────────────
window.startVoice = async () => { if (callActive) hangUp(); else await initiateCall("voice"); };
window.startVideo = async () => { if (callActive) hangUp(); else await initiateCall("video"); };

// Keep old names working
window.toggleVoice = window.startVoice;
window.toggleVideo = window.startVideo;

async function initiateCall(type) {
  const pid = await getPid();
  if (!pid) { toast(PARTNER_NAME+" is not in the room yet! 💕"); return; }

  const constraints = getConstraints(type);
  try {
    localStream = await getMedia(constraints);
  } catch(e) {
    toast("Cannot access mic/camera: " + e.message);
    return;
  }

  const lv = document.getElementById("call-local-video");
  lv.srcObject = localStream;

  showCallScreen(type === "video");
  setCallStatus("Calling " + PARTNER_NAME + "... 📞");
  await buildPC(localStream);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  push(sigRef, {type:"offer",sdp:pc.localDescription.toJSON(),callType:type,from:MY_ID,to:pid});

  // Notify partner
  set(callCtrlRef, {action:"ringing",by:MY_ID,to:pid,callType:type,at:Date.now()});

  callActive = true; callType = type;
  updateCallUI();
  toast("Calling " + PARTNER_NAME + "... 📞");
}

// ── CALL CONTROL (both-end end) ────────────────────────────
function listenCallControl() {
  onValue(callCtrlRef, snap => {
    const data = snap.val();
    if (!data) return;

    if (data.action === "end" && data.by !== MY_ID && callActive) {
      toast(PARTNER_NAME + " ended the call 💔");
      playCallEnded();
      endCall();
    }
    if (data.action === "declined" && data.by !== MY_ID && callActive) {
      toast(PARTNER_NAME + " declined the call 💔");
      playCallEnded();
      endCall();
    }
    if (data.action === "ringing" && data.to === MY_ID && !callActive && !pendingOffer) {
      // Extra notification if signal didn't arrive yet
      showNotif("📞 " + PARTNER_NAME + " is calling!", "Tap to open the app and answer! 💕", "📞");
    }
  });
}

// ── HANG UP ────────────────────────────────────────────────
window.hangUp = function() {
  set(callCtrlRef, {action:"end",by:MY_ID,at:Date.now()});
  setTimeout(() => set(callCtrlRef,null), 2000);
  stopRingtone();
  playCallEnded();
  endCall();
};

function endCall() {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (pc) { pc.close(); pc = null; }
  localStream = null; callActive = false; callType = null; isMuted = false; isCamOff = false;

  // Reset videos
  const lv = document.getElementById("call-local-video");
  const rv = document.getElementById("call-remote-video");
  if (lv) lv.srcObject = null;
  if (rv) rv.srcObject = null;

  // Show placeholder again
  document.getElementById("call-remote-ph").style.display = "flex";
  setCallStatus("Call ended. Miss them already? 💕");

  // Hide call screen
  hideCallScreen();

  // Reset call tab buttons
  updateCallUI();
  document.getElementById("cs-mute-btn").textContent = "🎙️";
  document.getElementById("cs-mute-btn").classList.remove("on");
}

function updateCallUI() {
  const vb = document.getElementById("voice-btn"), vd = document.getElementById("video-btn");
  if (callActive) {
    vb.querySelector("span:last-child").textContent = callType==="voice" ? "End Call" : "Voice Call";
    vd.querySelector("span:last-child").textContent = callType==="video" ? "End Call" : "Video Call";
    if (callType==="voice") vb.classList.add("active");
    if (callType==="video") vd.classList.add("active");
  } else {
    vb.className="c-btn"; vd.className="c-btn";
    vb.querySelector("span:last-child").textContent = "Voice Call";
    vd.querySelector("span:last-child").textContent = "Video Call";
  }
}

// ── MUTE / CAM / PTT ──────────────────────────────────────
window.toggleMute = function() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  const btn = document.getElementById("cs-mute-btn");
  btn.textContent = isMuted ? "🔇" : "🎙️";
  btn.classList.toggle("on", isMuted);
  toast(isMuted ? "Muted 🔇" : "Unmuted 🎙️");
};

window.toggleCam = function() {
  if (!localStream) return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
  const btn = document.getElementById("cs-cam-btn");
  btn.textContent = isCamOff ? "📵" : "📷";
  btn.classList.toggle("on", isCamOff);
};

window.toggleCallSpeaker = function() {
  // On mobile, toggle speaker vs earpiece
  const remoteVideo = document.getElementById("call-remote-video");
  if (remoteVideo && remoteVideo.srcObject) {
    // This is a browser limitation — speaker switching needs native app
    toast("Speaker control needs the native app. Use volume buttons 🔊");
  }
};

// Push-to-talk
window.pttStart = function(e) {
  if (e) e.preventDefault();
  if (!localStream) return;
  localStream.getAudioTracks().forEach(t => t.enabled = true);
  document.getElementById("cs-ptt-btn").classList.add("on");
  if (whisperMode && video && !video.paused) video.volume = 0.15;
};
window.pttEnd = function(e) {
  if (e) e.preventDefault();
  if (!localStream) return;
  localStream.getAudioTracks().forEach(t => t.enabled = false);
  document.getElementById("cs-ptt-btn").classList.remove("on");
  if (whisperMode && video) video.volume = parseFloat(document.getElementById("vol-slider").value);
};

// ══════════════════════════════════════════════════════════
//  AUDIO NOTIFICATIONS
// ══════════════════════════════════════════════════════════
const AC = new (window.AudioContext || window.webkitAudioContext)();

function playBeep(freq=440, dur=0.12, vol=0.3, type="sine", delay=0) {
  try {
    const o=AC.createOscillator(), g=AC.createGain();
    o.connect(g); g.connect(AC.destination);
    o.frequency.value=freq; o.type=type;
    const t=AC.currentTime+delay;
    g.gain.setValueAtTime(0,t);
    g.gain.linearRampToValueAtTime(vol,t+0.01);
    g.gain.linearRampToValueAtTime(0,t+dur);
    o.start(t); o.stop(t+dur+0.02);
  } catch(e){}
}

function playMsgSound()      { playBeep(880,0.08,0.18); setTimeout(()=>playBeep(1100,0.08,0.13),100); }
function playReactSound()    { playBeep(660,0.07,0.15); }
function playCallConnected() { stopRingtone(); playBeep(660,0.12,0.3); playBeep(880,0.18,0.3,undefined,0.15); }
function playCallEnded()     { playBeep(600,0.12,0.25); playBeep(450,0.18,0.2,undefined,0.14); }

function startRingtone() {
  stopRingtone();
  function ring() { playBeep(830,0.15,0.35); playBeep(830,0.15,0.35,undefined,0.25); playBeep(1050,0.2,0.35,undefined,0.5); }
  ring();
  ringTimer = setInterval(ring, 1400);
  if (navigator.vibrate) navigator.vibrate([400,150,400,150,400,200,400,150,400]);
}
function stopRingtone() {
  if (ringTimer) { clearInterval(ringTimer); ringTimer=null; }
  if (navigator.vibrate) navigator.vibrate(0);
}

function listenReactionsWithSound() {
  onValue(reactRef, snap => {
    Object.values(snap.val()||{}).forEach(item => {
      if (item.at > jtReact && item.by !== MY_NAME) { doReact(item.emoji); playReactSound(); if(navigator.vibrate)navigator.vibrate(50); }
    });
  });
}

// ── BROWSER NOTIFICATIONS ───────────────────────────────────
async function askNotifPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") await Notification.requestPermission();
}
function showNotif(title, body, icon="💕") {
  if (Notification.permission !== "granted" || document.hasFocus()) return;
  try {
    const n = new Notification(title, {
      body, tag:"tw-notif", renotify:true,
      icon:`data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>${icon}</text></svg>`
    });
    n.onclick = () => { window.focus(); n.close(); };
    setTimeout(()=>n.close(), 5000);
  } catch(e){}
}

// ── UTILS ──────────────────────────────────────────────────
function fmtTime(ts) { const d=new Date(ts); return`${d.getHours()}:${String(d.getMinutes()).padStart(2,"0")}`; }
function esc(s) { if(!s)return""; return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
window.toast = function(m) {
  const t=document.getElementById("toast");
  t.style.background=""; t.style.borderColor="";
  t.textContent=m; t.classList.add("show"); clearTimeout(t._t);
  t._t=setTimeout(()=>t.classList.remove("show"),3000);
};
function errToast(m) {
  const t=document.getElementById("toast");
  t.style.background="rgba(80,8,8,0.97)"; t.style.borderColor="#f87171";
  t.textContent="❌ "+m; t.classList.add("show"); clearTimeout(t._t);
  t._t=setTimeout(()=>{ t.classList.remove("show"); t.style.background=""; t.style.borderColor=""; },8000);
}
