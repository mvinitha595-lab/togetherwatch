import { db } from "./firebase-config.js";
import { ref, set, get } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

function code6() {
  const c="ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from({length:6},()=>c[Math.floor(Math.random()*c.length)]).join("");
}
function setStatus(m,col="rgba(255,255,255,0.45)"){
  const el=document.getElementById("lobby-status");if(el){el.textContent=m;el.style.color=col;}
}
function setLoad(v){["create-btn","join-btn"].forEach(id=>{const b=document.getElementById(id);if(b)b.disabled=v;});}

function getProfile() {
  return {
    myName:      document.getElementById("my-name").value.trim()      || "You",
    partnerName: document.getElementById("partner-name").value.trim() || "Partner",
    coupleName:  document.getElementById("couple-name").value.trim()  || "",
    distance:    document.getElementById("distance").value.trim()     || "",
    avatarYou:     localStorage.getItem("tw_avatar_you")     || "",
    avatarPartner: localStorage.getItem("tw_avatar_partner") || "",
    joinedDate:    localStorage.getItem("tw_joined")         || "",
  };
}

window.createRoom = async function() {
  const p = getProfile();
  const code = code6();
  setLoad(true); setStatus("Creating room...");
  try {
    await set(ref(db,`rooms/${code}`),{
      createdAt:Date.now(), host:p.myName,
      coupleName:p.coupleName, distance:p.distance,
      videoUrl:"", playState:{playing:false,currentTime:0,updatedAt:Date.now()},
    });
  } catch(e){
    setLoad(false); setStatus("❌ "+e.message,"#f87171");
    alert("Firebase error: "+e.message+"\n\nCheck firebase-config.js has the correct databaseURL.");
    return;
  }
  sessionStorage.setItem("tw_room",code);
  sessionStorage.setItem("tw_name",p.myName);
  sessionStorage.setItem("tw_partner",p.partnerName);
  sessionStorage.setItem("tw_couple",p.coupleName);
  sessionStorage.setItem("tw_distance",p.distance);
  sessionStorage.setItem("tw_avatar_you",p.avatarYou);
  sessionStorage.setItem("tw_avatar_partner",p.avatarPartner);
  setStatus("✓ Room created! Entering...","#4ade80");
  window.location.href=`pages/room.html?room=${code}`;
};

window.joinRoom = async function() {
  const raw=document.getElementById("join-code").value.trim().toUpperCase();
  if(!raw||raw.length<4){setStatus("Enter a valid room code!","#fbbf24");return;}
  const p = getProfile();
  setLoad(true); setStatus("Looking for room "+raw+"...");
  try {
    const snap=await get(ref(db,`rooms/${raw}`));
    if(!snap.exists()){setLoad(false);setStatus("❌ Room not found! Check the code 💕","#f87171");return;}
  } catch(e){
    setLoad(false); setStatus("❌ "+e.message,"#f87171");
    alert("Firebase error: "+e.message); return;
  }
  sessionStorage.setItem("tw_room",raw);
  sessionStorage.setItem("tw_name",p.myName);
  sessionStorage.setItem("tw_partner",p.partnerName);
  sessionStorage.setItem("tw_couple",p.coupleName);
  sessionStorage.setItem("tw_distance",p.distance);
  sessionStorage.setItem("tw_avatar_you",p.avatarYou);
  sessionStorage.setItem("tw_avatar_partner",p.avatarPartner);
  setStatus("✓ Room found! Entering...","#4ade80");
  window.location.href=`pages/room.html?room=${raw}`;
};
