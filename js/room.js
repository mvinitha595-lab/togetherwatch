// TogetherWatch v6 — Full Featured Room
// ✅ Seen status ✅ Typing indicator ✅ Reaction counters
// ✅ Floating hearts ✅ Big screen reactions
// ✅ Couple identity ✅ Online/offline ✅ Floating video bubble
// ✅ Mute/unmute ✅ Push-to-talk ✅ Whisper mode
// ✅ Volume control ✅ Sleep mode ✅ Video history
// ✅ Profile tab ✅ Distance display

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
let pc             = null;      // RTCPeerConnection
let isMuted        = false;
let isCamOff       = false;
let whisperMode    = false;
let sleepMode      = false;
let selectedFile   = null;
let typingTimer    = null;
let lastSeenAt     = 0;
let cachedMsgs     = [];
const rcounts      = {};        // reaction counts per emoji

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

// ── BOOT ───────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  if (!ROOM) { window.location.href = "../index.html"; return; }
  sessionStorage.setItem("tw_room", ROOM);
  video = document.getElementById("main-video");

  // Fill couple identity in header
  document.getElementById("room-code").textContent        = ROOM;
  document.getElementById("hdr-name-you").textContent     = MY_NAME;
  document.getElementById("hdr-name-partner").textContent = PARTNER_NAME;
  document.getElementById("typing-name").textContent      = PARTNER_NAME;
  document.getElementById("bubble-label-you").textContent = MY_NAME;
  document.getElementById("bubble-label-partner").textContent = PARTNER_NAME;
  document.getElementById("par-mood-lbl").textContent     = PARTNER_NAME + " feels:";

  // Avatars in header
  setAvatarEl("hdr-avatar-you",     AVATAR_YOU);
  setAvatarEl("hdr-avatar-partner", AVATAR_PAR);

  // Distance badge
  if (DISTANCE) {
    document.getElementById("dist-badge").style.display = "flex";
    document.getElementById("dist-text").textContent = DISTANCE;
  }

  // Profile tab
  fillProfileTab();

  // Presence
  set(presRef, { name: MY_NAME, joinedAt: Date.now() });
  onDisconnect(presRef).remove();
  onDisconnect(typingRef).remove();

  // Core listeners
  listenPresence();
  listenPlayState();
  listenVideoUrl();
  listenMoods();
  listenTyping();
  listenSeen();
  // Enhanced listeners with notifications (defined at end of file)
  setTimeout(()=>{ if(window.__startNotifListeners) window.__startNotifListeners(); }, 150);

  // Video events → sync
  video.addEventListener("play",       pushPlay);
  video.addEventListener("pause",      pushPlay);
  video.addEventListener("seeked",     pushPlay);
  video.addEventListener("timeupdate", updateProgress);
  video.addEventListener("ended", () => { document.getElementById("pp-btn").textContent = "▶"; });

  // Volume slider
  document.getElementById("vol-slider").addEventListener("input", e => {
    video.volume = parseFloat(e.target.value);
  });

  // Load history
  renderHistory();
});

// ── AVATAR HELPER ──────────────────────────────────────────
function setAvatarEl(id, src) {
  const el = document.getElementById(id); if (!el) return;
  if (src && src.startsWith("data:")) el.innerHTML = `<img src="${src}" alt="avatar"/>`;
  else el.textContent = src || "😊";
}

// ── PRESENCE ───────────────────────────────────────────────
function listenPresence() {
  onValue(ref(db, `rooms/${ROOM}/presence`), snap => {
    const others = Object.entries(snap.val()||{}).filter(([id])=>id!==MY_ID);
    const dot = document.getElementById("partner-dot");
    dot.className = others.length > 0 ? "c-dot on" : "c-dot off";
  });
}

// ── SOURCE TABS ────────────────────────────────────────────
window.setSrcTab = function(tab) {
  ["url","upload","history"].forEach(t => {
    document.getElementById("sp-"+t).style.display = t===tab ? "block":"none";
    document.getElementById("st-"+t).classList.toggle("active", t===tab);
  });
  if (tab==="history") renderHistory();
};

// ── VIDEO: URL ─────────────────────────────────────────────
function toStream(url) {
  const dm = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (dm) return `https://drive.google.com/uc?export=download&id=${dm[1]}&confirm=t`;
  if (url.includes("dropbox.com"))
    return url.replace("www.dropbox.com","dl.dropboxusercontent.com").replace("?dl=0","").replace("&dl=0","");
  if (url.includes("1drv.ms")||url.includes("onedrive.live.com"))
    return url.replace("redir?","download?").replace("embed?","download?");
  return url;
}

window.loadUrl = function() {
  let raw = document.getElementById("video-url").value.trim();
  if (!raw) { toast("Paste a video URL first!"); return; }
  if (raw.includes("youtube.com")||raw.includes("youtu.be")) { errToast("YouTube blocks external players. Upload to Google Drive instead."); return; }
  if (raw.includes("netflix.com")||raw.includes("primevideo.com")||raw.includes("hotstar.com")) { errToast("Streaming services block external players."); return; }
  const url = toStream(raw);
  if (url !== raw) { document.getElementById("video-url").value = url; toast("Link converted ✓"); }
  update(roomRef, { videoUrl:url, videoLoadedBy:MY_NAME, videoTitle:extractTitle(url) });
  applyVideo(url, extractTitle(url));
};

function extractTitle(url) {
  try { return decodeURIComponent(url.split("/").pop().split("?")[0]).substring(0,40) || "Video"; } catch { return "Video"; }
}

function listenVideoUrl() {
  onValue(ref(db,`rooms/${ROOM}/videoUrl`), snap => {
    const url = snap.val(); if (!url) return;
    if (video.getAttribute("data-src")===url) return;
    get(ref(db,`rooms/${ROOM}/videoLoadedBy`)).then(s => {
      if (s.val()===MY_NAME) return;
      get(ref(db,`rooms/${ROOM}/videoTitle`)).then(t => {
        applyVideo(url, t.val()||"Video");
        toast(PARTNER_NAME+" loaded a video 🎬");
      });
    });
  });
}

function applyVideo(url, title) {
  video.pause(); video.removeAttribute("src"); video.load();
  video.src = url; video.setAttribute("data-src", url);
  video.onerror = () => errToast("Video failed. Try Google Drive with 'Anyone with the link' sharing.");
  video.oncanplay = () => toast("✓ Video ready! Press ▶ 🎬");
  video.style.display="block"; video.classList.add("active");
  document.getElementById("ph").style.display="none";
  document.getElementById("ctrl-bar").style.display="flex";
  document.getElementById("vol-row").style.display="flex";
  document.getElementById("sync-row").style.display="flex";
  toast("Loading video...");
  // Save to history
  addHistory(url, title||extractTitle(url));
}

// ── VIDEO HISTORY ──────────────────────────────────────────
function getHistory() { try { return JSON.parse(localStorage.getItem("tw_history")||"[]"); } catch { return []; } }
function addHistory(url, title) {
  let h = getHistory().filter(i=>i.url!==url);
  h.unshift({url, title, at:Date.now()});
  h = h.slice(0,10);
  localStorage.setItem("tw_history", JSON.stringify(h));
}
function renderHistory() {
  const list = document.getElementById("history-list"); if(!list) return;
  const h = getHistory();
  list.innerHTML = "";
  if (!h.length) { list.innerHTML='<p style="font-size:12px;color:var(--muted)">No history yet</p>'; return; }
  h.forEach((item,i) => {
    const div=document.createElement("div"); div.className="history-item";
    div.innerHTML=`<span class="history-icon">🎬</span><span class="history-name">${esc(item.title)}</span><button class="history-del" onclick="delHistory(${i})">✕</button>`;
    div.addEventListener("click", e => { if(!e.target.classList.contains("history-del")) { applyVideo(item.url,item.title); update(roomRef,{videoUrl:item.url,videoLoadedBy:MY_NAME,videoTitle:item.title}); } });
    list.appendChild(div);
  });
}
window.delHistory = function(i) {
  const h=getHistory(); h.splice(i,1); localStorage.setItem("tw_history",JSON.stringify(h)); renderHistory();
};

// ── FILE UPLOAD ────────────────────────────────────────────
window.onFileChosen = function(e) {
  const f=e.target.files[0]; if(!f) return; selectedFile=f;
  document.getElementById("upload-name").textContent="📽 "+f.name;
  document.getElementById("upload-bar").style.display="flex";
};
window.onDrop = function(e) {
  e.preventDefault();
  const f=e.dataTransfer.files[0];
  if(f&&f.type.startsWith("video/")){selectedFile=f;document.getElementById("upload-name").textContent="📽 "+f.name;document.getElementById("upload-bar").style.display="flex";}
};
window.loadFile = function() {
  if(!selectedFile){toast("Pick a video file first!");return;}
  const url=URL.createObjectURL(selectedFile);
  applyVideo(url, selectedFile.name);
  video.setAttribute("data-src","local:"+selectedFile.name);
  update(roomRef,{videoUrl:"",videoLoadedBy:MY_NAME,videoHint:MY_NAME+" loaded: "+selectedFile.name});
  toast("Loaded! Partner must load the same file 🎬");
};

// ── PLAYBACK SYNC ──────────────────────────────────────────
function pushPlay() {
  if(isSyncing||!video.src) return;
  update(playRef,{playing:!video.paused,currentTime:video.currentTime,updatedAt:Date.now(),by:MY_ID});
}
function listenPlayState() {
  onValue(playRef, snap => {
    const s=snap.val(); if(!s||s.by===MY_ID||!video||!video.src) return;
    isSyncing=true;
    const drift=Math.abs(video.currentTime-s.currentTime);
    if(drift>2) video.currentTime=s.currentTime;
    if(s.playing&&video.paused)  video.play().catch(()=>{});
    if(!s.playing&&!video.paused) video.pause();
    setTimeout(()=>{isSyncing=false;},600);
    const dot=document.getElementById("sync-dot"),lbl=document.getElementById("sync-label");
    dot.style.color=drift<=2?"#4ade80":"#f0c060";
    lbl.textContent=drift<=2?"● In sync with "+PARTNER_NAME+" ✓":"● Resyncing...";
  });
}
function updateProgress() {
  if(!video.duration) return;
  document.getElementById("prog-fill").style.width=(video.currentTime/video.duration*100)+"%";
  const f=t=>`${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,"0")}`;
  document.getElementById("time-lbl").textContent=f(video.currentTime)+" / "+f(video.duration);
  document.getElementById("pp-btn").textContent=video.paused?"▶":"⏸";
  // Whisper mode: lower volume when typing or talking
  if(whisperMode && !video.paused) video.volume=0.2;
}
window.togglePlay=()=>{ if(!video.src){toast("Load a video first!");return;} video.paused?video.play():video.pause(); };
window.skip=s=>{ if(!video.src)return; video.currentTime=Math.max(0,Math.min(video.duration||0,video.currentTime+s)); };
window.seekTo=e=>{ if(!video.duration)return; video.currentTime=(e.offsetX/e.currentTarget.offsetWidth)*video.duration; };
window.setVolume=v=>{ if(video) video.volume=parseFloat(v); };

// ── WHISPER MODE ───────────────────────────────────────────
window.toggleWhisper = function() {
  whisperMode = !whisperMode;
  const btn=document.getElementById("whisper-btn");
  btn.classList.toggle("active",whisperMode);
  btn.textContent = whisperMode ? "🤫 Whisper ON" : "🤫 Whisper Mode";
  if(!whisperMode && video) video.volume=parseFloat(document.getElementById("vol-slider").value);
  toast(whisperMode ? "Whisper Mode ON — volume lowers when talking 🤫" : "Whisper Mode OFF");
};

// ── SLEEP MODE ─────────────────────────────────────────────
window.toggleSleep = function() {
  sleepMode = !sleepMode;
  const overlay=document.getElementById("sleep-overlay"),btn=document.getElementById("sleep-btn");
  overlay.classList.toggle("on",sleepMode);
  btn.classList.toggle("active",sleepMode);
  btn.textContent = sleepMode ? "☀️ Wake Up Mode" : "🌙 Sleep Together Mode";
  if(sleepMode && video) video.volume=0.15;
  else if(video) video.volume=parseFloat(document.getElementById("vol-slider").value);
  toast(sleepMode ? "Sleep mode ON 🌙 Sweet dreams together 💕" : "Good morning! ☀️");
};
window.closeBubble=()=>{document.getElementById("my-bubble").classList.remove("show");};

// ── EMOJI REACTIONS ────────────────────────────────────────
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
  updateCount(emoji);
  const n=rcounts[emoji], big=BIG.includes(emoji)&&n>=2;
  spawnEmoji(emoji, big);
  if(HARTS.includes(emoji)) for(let i=0;i<Math.min(n+1,6);i++) setTimeout(()=>spawnHeart(),i*140);
}
function updateCount(emoji) {
  const i=EI.indexOf(emoji); if(i<0) return;
  const el=document.getElementById("rc-"+i); if(!el) return;
  const n=rcounts[emoji]||0;
  if(n>1){el.textContent=n;el.classList.add("on");}else el.classList.remove("on");
}
function listenReactions() {
  onValue(reactRef, snap => {
    Object.values(snap.val()||{}).forEach(item => {
      if(item.at>jtReact&&item.by!==MY_NAME) doReact(item.emoji);
    });
  });
}
function spawnEmoji(emoji,big) {
  const el=document.createElement("div");
  el.className="fe"+(big?" big":"");
  el.textContent=emoji;
  el.style.cssText=`font-size:${big?64:36}px;left:${30+Math.random()*(window.innerWidth-80)}px;bottom:155px;`;
  document.getElementById("float-con").appendChild(el);
  setTimeout(()=>el.remove(), big?3300:2900);
}
function spawnHeart() {
  const el=document.createElement("div");el.className="fh";el.textContent="❤️";
  el.style.cssText=`left:${30+Math.random()*(window.innerWidth-80)}px;bottom:${95+Math.random()*70}px;--drift:${(Math.random()-.5)*110}px;font-size:${15+Math.random()*15}px;`;
  document.getElementById("float-con").appendChild(el);
  setTimeout(()=>el.remove(),2600);
}

// ── MOOD ───────────────────────────────────────────────────
window.setMood=function(btn,mood){
  document.querySelectorAll(".mood-btn").forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");
  set(moodRef,{name:MY_NAME,mood,at:Date.now()});
  toast("Mood shared 💕");
};
function listenMoods(){
  onValue(ref(db,`rooms/${ROOM}/moods`),snap=>{
    const others=Object.entries(snap.val()||{}).filter(([id])=>id!==MY_ID).map(([,v])=>v);
    if(others.length>0){
      document.getElementById("par-mood").style.display="flex";
      document.getElementById("par-mood-val").textContent=others[0].mood;
    }
  });
}

// ── CHAT ───────────────────────────────────────────────────
window.sendMsg=function(){
  const inp=document.getElementById("chat-in"),t=inp.value.trim();if(!t)return;
  push(chatRef,{name:MY_NAME,text:t,localAt:Date.now()});
  inp.value="";
  remove(typingRef);clearTimeout(typingTimer);
  if(whisperMode&&video&&!video.paused){video.volume=parseFloat(document.getElementById("vol-slider").value);}
};
window.chatEmoji=function(e){push(chatRef,{name:MY_NAME,text:e,localAt:Date.now(),eo:true});};
window.onTyping=function(){
  set(typingRef,{name:MY_NAME,at:Date.now()});
  clearTimeout(typingTimer);typingTimer=setTimeout(()=>remove(typingRef),3000);
  // Whisper mode: lower volume while typing
  if(whisperMode&&video&&!video.paused) video.volume=0.2;
};
function listenTyping(){
  onValue(ref(db,`rooms/${ROOM}/typing`),snap=>{
    const others=Object.entries(snap.val()||{}).filter(([id])=>id!==MY_ID);
    document.getElementById("typing-ind").classList.toggle("show",others.length>0);
  });
}
function listenSeen(){
  onValue(ref(db,`rooms/${ROOM}/seen`),snap=>{
    const others=Object.entries(snap.val()||{}).filter(([id])=>id!==MY_ID);
    if(others.length>0) lastSeenAt=others[0][1].at||0;
    renderMsgs();
  });
}
function markSeen(){set(seenRef,{name:MY_NAME,at:Date.now()});}
function listenMessages(){
  onValue(chatRef,snap=>{
    cachedMsgs=Object.values(snap.val()||{});
    renderMsgs();
    if(!document.getElementById("tab-chat").classList.contains("active"))
      document.getElementById("chat-badge").style.display="inline";
  });
}
function renderMsgs(){
  const list=document.getElementById("msg-list");list.innerHTML="";
  let lastDate="";
  cachedMsgs.forEach(msg=>{
    const mine=msg.name===MY_NAME;
    const md=msg.localAt?new Date(msg.localAt).toDateString():"";
    if(md&&md!==lastDate){
      lastDate=md;
      const sep=document.createElement("div");sep.className="date-sep";
      sep.textContent=md===new Date().toDateString()?"Today":md;
      list.appendChild(sep);
    }
    const div=document.createElement("div");div.className="message "+(mine?"mine":"theirs");
    const time=msg.localAt?fmtTime(msg.localAt):"";
    const seen=mine&&msg.localAt&&lastSeenAt>msg.localAt;
    const seenHtml=mine?`<span class="msg-seen ${seen?"s":"u"}">${seen?"✔✔":"✔"}</span>`:"";
    div.innerHTML=`
      <span class="msg-name">${esc(msg.name)} ${mine?"💙":"💛"}</span>
      <div class="bubble${msg.eo?" eo":""}">${esc(msg.text)}</div>
      <div class="msg-meta"><span class="msg-time">${time}</span>${seenHtml}</div>`;
    list.appendChild(div);
  });
  const w=document.querySelector(".chat-wrap");if(w)w.scrollTop=w.scrollHeight;
}

// ── TABS ───────────────────────────────────────────────────
window.switchTab=function(name,el){
  document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(b=>b.classList.remove("active"));
  document.getElementById("tab-"+name).classList.add("active");el.classList.add("active");
  if(name==="chat"){
    document.getElementById("chat-badge").style.display="none";markSeen();
    setTimeout(()=>{const w=document.querySelector(".chat-wrap");if(w)w.scrollTop=w.scrollHeight;},50);
  }
  if(name==="profile") fillProfileTab();
};
window.copyCode=()=>{ navigator.clipboard.writeText(ROOM).then(()=>toast("Code copied! Send it to "+PARTNER_NAME+" 💕")).catch(()=>toast("Room: "+ROOM)); };

// ── PROFILE TAB ────────────────────────────────────────────
function fillProfileTab(){
  document.getElementById("prof-couple-name").textContent = COUPLE_NAME||"Your Couple Name 💕";
  document.getElementById("prof-name-you").textContent    = MY_NAME;
  document.getElementById("prof-name-partner").textContent= PARTNER_NAME;
  setAvatarEl("prof-av-you",     AVATAR_YOU);
  setAvatarEl("prof-av-partner", AVATAR_PAR);
  document.getElementById("edit-couple").value  = COUPLE_NAME;
  document.getElementById("edit-myname").value  = MY_NAME;
  document.getElementById("edit-partner").value = PARTNER_NAME;
  document.getElementById("edit-dist").value    = DISTANCE;
  if(DISTANCE){document.getElementById("prof-dist").style.display="flex";document.getElementById("prof-km").textContent=DISTANCE;}
  // Joined
  const jd=localStorage.getItem("tw_joined");
  if(jd){
    document.getElementById("edit-joined").value=jd;
    const d=new Date(jd),now=new Date(),days=Math.floor((now-d)/(1000*60*60*24));
    document.getElementById("prof-since").textContent="Together since "+d.toLocaleDateString("en-IN",{day:"numeric",month:"long",year:"numeric"})+" · "+days+" days 💕";
  }
}
window.pickAvatar2=function(who){document.getElementById("prof-av-"+who+"-file").click();};
window.loadProfileAvatar=function(who,e){
  const f=e.target.files[0];if(!f)return;
  const r=new FileReader();
  r.onload=ev=>{
    const d=ev.target.result;
    localStorage.setItem("tw_avatar_"+who,d);
    sessionStorage.setItem("tw_avatar_"+who,d);
    setAvatarEl("prof-av-"+who,d);
    setAvatarEl("hdr-avatar-"+who,d);
    toast("Photo updated 💕");
  };
  r.readAsDataURL(f);
};
window.saveProfile=function(){
  const cn=document.getElementById("edit-couple").value.trim();
  const mn=document.getElementById("edit-myname").value.trim()||MY_NAME;
  const pn=document.getElementById("edit-partner").value.trim()||PARTNER_NAME;
  const dist=document.getElementById("edit-dist").value.trim();
  const jd=document.getElementById("edit-joined").value;
  sessionStorage.setItem("tw_couple",cn);
  sessionStorage.setItem("tw_distance",dist);
  if(jd) localStorage.setItem("tw_joined",jd);
  document.getElementById("prof-couple-name").textContent=cn||"Your Couple Name 💕";
  document.getElementById("hdr-name-you").textContent=mn;
  document.getElementById("hdr-name-partner").textContent=pn;
  if(dist){document.getElementById("prof-dist").style.display="flex";document.getElementById("prof-km").textContent=dist;document.getElementById("dist-badge").style.display="flex";document.getElementById("dist-text").textContent=dist;}
  fillProfileTab();
  toast("Profile saved! 💕");
};

// ── WebRTC CALL ────────────────────────────────────────────
const ICE={iceServers:[{urls:"stun:stun.l.google.com:19302"},{urls:"stun:stun1.l.google.com:19302"}]};

function listenSignals(){
  onValue(sigRef,async snap=>{
    const data=snap.val()||{};
    for(const [id,sig] of Object.entries(data)){
      if(sig.to!==MY_ID) continue;
      if(sig.type==="offer"&&!pc)              await handleOffer(sig);
      else if(sig.type==="answer"&&pc)         await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp)).catch(console.error);
      else if(sig.type==="ice-candidate"&&pc)  await pc.addIceCandidate(new RTCIceCandidate(sig.candidate)).catch(()=>{});
      remove(ref(db,`rooms/${ROOM}/signals/${id}`));
    }
  });
}
async function getPid(){
  const s=await get(ref(db,`rooms/${ROOM}/presence`));
  return Object.keys(s.val()||{}).filter(id=>id!==MY_ID)[0]||null;
}
async function buildPC(stream){
  pc=new RTCPeerConnection(ICE);
  stream.getTracks().forEach(t=>pc.addTrack(t,stream));
  pc.ontrack=e=>{
    const rv=document.getElementById("bubble-remote");
    if(rv.srcObject!==e.streams[0]){rv.srcObject=e.streams[0];document.getElementById("remote-bubble").classList.add("show");}
  };
  pc.onicecandidate=async e=>{
    if(!e.candidate) return;
    const pid=await getPid();if(pid) push(sigRef,{type:"ice-candidate",candidate:e.candidate.toJSON(),from:MY_ID,to:pid});
  };
  pc.onconnectionstatechange=()=>{
    const s=pc.connectionState,el=document.getElementById("call-status");
    if(s==="connected"){el.textContent="✓ Connected with "+PARTNER_NAME+" 💕";el.className="call-status on";}
    else if(s==="disconnected"||s==="failed"){el.textContent="Call ended.";el.className="call-status";endCall();}
  };
}
async function handleOffer(sig){
  const c=sig.callType==="video"?{audio:true,video:true}:{audio:true};
  try{localStream=await navigator.mediaDevices.getUserMedia(c);}catch{toast("Cannot access mic/camera.");return;}
  showBubble(sig.callType==="video");
  await buildPC(localStream);
  await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
  const ans=await pc.createAnswer();await pc.setLocalDescription(ans);
  push(sigRef,{type:"answer",sdp:pc.localDescription.toJSON(),from:MY_ID,to:sig.from});
  callActive=true;callType=sig.callType;updateCallUI();toast("Call connected with "+PARTNER_NAME+" 💕");
}
window.toggleVoice=async()=>{callActive?endCall():await startCall("voice");};
window.toggleVideo=async()=>{callActive?endCall():await startCall("video");};
async function startCall(type){
  const pid=await getPid();if(!pid){toast(PARTNER_NAME+" is not in the room yet!");return;}
  const c=type==="video"?{audio:true,video:true}:{audio:true};
  try{localStream=await navigator.mediaDevices.getUserMedia(c);}catch{toast("Cannot access mic/camera.");return;}
  showBubble(type==="video");
  await buildPC(localStream);
  const offer=await pc.createOffer();await pc.setLocalDescription(offer);
  push(sigRef,{type:"offer",sdp:pc.localDescription.toJSON(),callType:type,from:MY_ID,to:pid});
  callActive=true;callType=type;updateCallUI();
  document.getElementById("call-status").textContent="Calling "+PARTNER_NAME+"... 📞";
}
function showBubble(withVideo){
  const lv=document.getElementById("bubble-local");lv.srcObject=localStream;
  if(withVideo) document.getElementById("my-bubble").classList.add("show");
}
function updateCallUI(){
  const vb=document.getElementById("voice-btn"),vd=document.getElementById("video-btn");
  if(callActive){
    vb.querySelector("span:last-child").textContent=callType==="voice"?"End Call":"Voice Call";
    vd.querySelector("span:last-child").textContent=callType==="video"?"End Call":"Video Call";
    if(callType==="voice")vb.classList.add("active");if(callType==="video")vd.classList.add("active");
  }else{vb.className="c-btn";vd.className="c-btn";vb.querySelector("span:last-child").textContent="Voice Call";vd.querySelector("span:last-child").textContent="Video Call";}
}
function endCall(){
  if(localStream)localStream.getTracks().forEach(t=>t.stop());
  if(pc){pc.close();pc=null;}
  localStream=null;callActive=false;callType=false;isMuted=false;isCamOff=false;
  ["my-bubble","remote-bubble"].forEach(id=>document.getElementById(id).classList.remove("show"));
  document.getElementById("bubble-local").srcObject=null;
  document.getElementById("bubble-remote").srcObject=null;
  document.getElementById("call-status").textContent="Call ended. Miss them already? 💕";
  document.getElementById("call-status").className="call-status";
  updateCallUI();
  document.getElementById("mute-btn").classList.remove("active","muted");
  document.getElementById("mute-btn").textContent="🎙️ Mute";
}

// ── MUTE / CAM / PTT ──────────────────────────────────────
window.toggleMute=function(){
  if(!localStream){toast("Start a call first!");return;}
  isMuted=!isMuted;
  localStream.getAudioTracks().forEach(t=>t.enabled=!isMuted);
  const btn=document.getElementById("mute-btn");
  btn.textContent=isMuted?"🔇 Unmute":"🎙️ Mute";
  btn.classList.toggle("muted",isMuted);
  toast(isMuted?"Muted 🔇":"Unmuted 🎙️");
};
window.toggleCam=function(){
  if(!localStream){toast("Start a video call first!");return;}
  isCamOff=!isCamOff;
  localStream.getVideoTracks().forEach(t=>t.enabled=!isCamOff);
  const btn=document.getElementById("cam-btn");
  btn.textContent=isCamOff?"📷 Show Cam":"📷 Camera";
  btn.classList.toggle("active",!isCamOff);
  toast(isCamOff?"Camera off":"Camera on");
};
// Push-to-talk: unmute on press, mute on release
window.pttStart=function(){
  if(!localStream) return;
  localStream.getAudioTracks().forEach(t=>t.enabled=true);
  document.getElementById("ptt-btn").classList.add("active");
  if(whisperMode&&video&&!video.paused) video.volume=0.15;
};
window.pttEnd=function(){
  if(!localStream) return;
  localStream.getAudioTracks().forEach(t=>t.enabled=false);
  document.getElementById("ptt-btn").classList.remove("active");
  if(whisperMode&&video) video.volume=parseFloat(document.getElementById("vol-slider").value);
};

// ── UTILS ──────────────────────────────────────────────────
function fmtTime(ts){const d=new Date(ts);return`${d.getHours()}:${String(d.getMinutes()).padStart(2,"0")}`;}
function esc(s){if(!s)return"";return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
window.toast=function(m){
  const t=document.getElementById("toast");
  t.style.background="";t.style.borderColor="";
  t.textContent=m;t.classList.add("show");clearTimeout(t._t);
  t._t=setTimeout(()=>t.classList.remove("show"),3000);
};
function errToast(m){
  const t=document.getElementById("toast");
  t.style.background="rgba(80,8,8,0.97)";t.style.borderColor="#f87171";
  t.textContent="❌ "+m;t.classList.add("show");clearTimeout(t._t);
  t._t=setTimeout(()=>{t.classList.remove("show");t.style.background="";t.style.borderColor="";},8000);
}

// =============================================
//  NOTIFICATIONS v7
//  ✅ Message sound  ✅ Call ringtone + vibration
//  ✅ Browser notifications  ✅ Both-end call end
// =============================================

// ── Audio engine (Web Audio API — no files needed) ─────────
const AC = new (window.AudioContext || window.webkitAudioContext)();

function playBeep(freq=440, dur=0.12, vol=0.3, type="sine") {
  try {
    const o=AC.createOscillator(), g=AC.createGain();
    o.connect(g); g.connect(AC.destination);
    o.frequency.value=freq; o.type=type;
    g.gain.setValueAtTime(0,AC.currentTime);
    g.gain.linearRampToValueAtTime(vol, AC.currentTime+0.01);
    g.gain.linearRampToValueAtTime(0,  AC.currentTime+dur);
    o.start(AC.currentTime); o.stop(AC.currentTime+dur+0.01);
  } catch(e){}
}

// Message received sound — soft double ping
function playMsgSound() {
  playBeep(880, 0.08, 0.2, "sine");
  setTimeout(()=>playBeep(1100, 0.08, 0.15, "sine"), 100);
}

// Reaction sound — warm pop
function playReactSound() {
  playBeep(660, 0.07, 0.18, "sine");
}

// Call ringtone — repeating pattern
let ringTimer = null;
function startRingtone() {
  stopRingtone();
  function ring() {
    playBeep(830, 0.15, 0.35, "sine");
    setTimeout(()=>playBeep(830, 0.15, 0.35, "sine"), 250);
    setTimeout(()=>playBeep(1050, 0.2, 0.35, "sine"), 500);
  }
  ring();
  ringTimer = setInterval(ring, 1200);
  // Vibrate on mobile
  if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
}
function stopRingtone() {
  if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
  if (navigator.vibrate) navigator.vibrate(0);
}

// Call connected sound — two ascending tones
function playCallConnected() {
  stopRingtone();
  playBeep(660, 0.12, 0.3);
  setTimeout(()=>playBeep(880, 0.18, 0.3), 150);
}

// Call ended sound — descending
function playCallEnded() {
  playBeep(600, 0.12, 0.25);
  setTimeout(()=>playBeep(450, 0.18, 0.2), 140);
}

// ── BROWSER NOTIFICATIONS ───────────────────────────────────
async function askNotifPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }
}

function showNotif(title, body, icon="💕") {
  if (Notification.permission !== "granted") return;
  if (document.hasFocus()) return; // only show when app is in background
  try {
    const n = new Notification(title, {
      body,
      icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>" + icon + "</text></svg>",
      badge:"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>💕</text></svg>",
      tag: "tw-notif",
      renotify: true,
    });
    n.onclick = () => { window.focus(); n.close(); };
    setTimeout(()=>n.close(), 5000);
  } catch(e){}
}

// ── CALL SIGNALING — with both-end end ─────────────────────
// We add a "callEnd" signal so when one hangs up the other also ends
const callCtrlRef = ref(db, `rooms/${ROOM}/callControl`);

function listenCallControl() {
  onValue(callCtrlRef, snap => {
    const data = snap.val();
    if (!data) return;
    if (data.action === "end" && data.by !== MY_ID && callActive) {
      // Partner hung up — end on our side too
      endCall();
      toast(PARTNER_NAME + " ended the call 💔");
      playCallEnded();
    }
    if (data.action === "ringing" && data.to === MY_ID && !callActive) {
      // Incoming call notification
      startRingtone();
      showNotif(
        "📞 Incoming " + (data.callType==="video"?"Video":"Voice") + " Call",
        PARTNER_NAME + " is calling you! Open the app to answer 💕",
        data.callType==="video"?"📹":"🎙️"
      );
      toast("📞 " + PARTNER_NAME + " is calling! Go to Call tab");
      // Vibrate in a ring pattern
      if (navigator.vibrate) navigator.vibrate([500,200,500,200,500,200,500]);
    }
  });
}

// ── OVERRIDE signal functions to add notifications ──────────

// Override listenSignals to add ring + sound
function listenSignalsWithNotif() {
  onValue(sigRef, async snap => {
    const data = snap.val() || {};
    for (const [id, sig] of Object.entries(data)) {
      if (sig.to !== MY_ID) continue;

      if (sig.type === "offer" && !pc) {
        // Incoming call!
        startRingtone();
        showNotif(
          "📞 Incoming " + (sig.callType==="video"?"Video":"Voice") + " Call! 💕",
          PARTNER_NAME + " is calling you!",
          sig.callType==="video" ? "📹" : "🎙️"
        );
        toast("📞 " + PARTNER_NAME + " is calling! Answer below ↓");
        if (navigator.vibrate) navigator.vibrate([400,150,400,150,400,150,400]);
        await handleOfferWithSound(sig);
      } else if (sig.type === "answer" && pc) {
        stopRingtone();
        playCallConnected();
        await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp)).catch(console.error);
      } else if (sig.type === "ice-candidate" && pc) {
        await pc.addIceCandidate(new RTCIceCandidate(sig.candidate)).catch(()=>{});
      }
      remove(ref(db, `rooms/${ROOM}/signals/${id}`));
    }
  });
}

async function handleOfferWithSound(sig) {
  const c = sig.callType==="video" ? {audio:true,video:true} : {audio:true};
  try { localStream = await navigator.mediaDevices.getUserMedia(c); }
  catch { stopRingtone(); toast("Cannot access mic/camera."); return; }
  stopRingtone();
  playCallConnected();
  showBubble(sig.callType==="video");
  await buildPC(localStream);
  await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
  const ans = await pc.createAnswer();
  await pc.setLocalDescription(ans);
  push(sigRef, {type:"answer", sdp:pc.localDescription.toJSON(), from:MY_ID, to:sig.from});
  callActive=true; callType=sig.callType; updateCallUI();
  toast("✓ Call connected with " + PARTNER_NAME + " 💕");
  showNotif("✓ Connected!", "You are now on a call with " + PARTNER_NAME + " 💕", "💕");
}

// ── OVERRIDE startCall to notify partner ────────────────────
window.toggleVoice = async()=>{ callActive ? hangUp() : await startCallWithNotif("voice"); };
window.toggleVideo = async()=>{ callActive ? hangUp() : await startCallWithNotif("video"); };

async function startCallWithNotif(type) {
  const pid = await getPid();
  if (!pid) { toast(PARTNER_NAME+" is not in the room yet!"); return; }
  const c = type==="video" ? {audio:true,video:true} : {audio:true};
  try { localStream = await navigator.mediaDevices.getUserMedia(c); }
  catch { toast("Cannot access mic/camera."); return; }
  showBubble(type==="video");
  await buildPC(localStream);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  push(sigRef, {type:"offer", sdp:pc.localDescription.toJSON(), callType:type, from:MY_ID, to:pid});
  // Notify partner
  set(callCtrlRef, {action:"ringing", by:MY_ID, to:pid, callType:type, at:Date.now()});
  callActive=true; callType=type; updateCallUI();
  document.getElementById("call-status").textContent = "Calling " + PARTNER_NAME + "... 📞";
  toast("Calling " + PARTNER_NAME + "... 📞");
  // Ring for caller too (softer)
  playBeep(550, 0.1, 0.15);
}

// Hang up and tell partner
function hangUp() {
  // Signal partner to end their call too
  set(callCtrlRef, {action:"end", by:MY_ID, at:Date.now()});
  stopRingtone();
  playCallEnded();
  endCall();
  // Clear the signal after 2s
  setTimeout(()=>set(callCtrlRef,null), 2000);
}

// ── OVERRIDE listenMessages to add sound + notif ────────────
const msgJoinTime = Date.now();

function listenMessagesWithSound() {
  onValue(chatRef, snap => {
    const msgs = Object.values(snap.val()||{});
    // Check for new messages from partner
    msgs.forEach(msg => {
      if (msg.localAt && msg.localAt > msgJoinTime && msg.name !== MY_NAME) {
        // New message from partner!
        playMsgSound();
        showNotif(
          "💬 " + PARTNER_NAME + " sent a message",
          msg.eo ? "Sent a reaction " + msg.text : msg.text,
          "💬"
        );
        // Vibrate once briefly
        if (navigator.vibrate) navigator.vibrate(100);
      }
    });
    cachedMsgs = msgs;
    renderMsgs();
    if (!document.getElementById("tab-chat").classList.contains("active"))
      document.getElementById("chat-badge").style.display = "inline";
  });
}

// ── OVERRIDE listenReactions to add sound ──────────────────
function listenReactionsWithSound() {
  onValue(reactRef, snap => {
    const data = snap.val() || {};
    Object.values(data).forEach(item => {
      if (item.at > jtReact && item.by !== MY_NAME) {
        doReact(item.emoji);
        playReactSound();
        if (navigator.vibrate) navigator.vibrate(60);
      }
    });
  });
}

// ── BOOT PATCH — replace listeners with enhanced versions ───
// This runs after DOMContentLoaded already fired, so we patch immediately
(function patchListeners() {
  // Ask for notification permission on first interaction
  document.addEventListener("click", function askOnce() {
    askNotifPermission();
    AC.resume().catch(()=>{});
    document.removeEventListener("click", askOnce);
  }, {once:true});
})();

// Export patched functions so boot can call them
window.__startNotifListeners = function() {
  listenSignalsWithNotif();
  listenCallControl();
  listenMessagesWithSound();
  listenReactionsWithSound();
};
