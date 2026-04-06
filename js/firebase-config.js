// =============================================
//  firebase-config.js  —  TogetherWatch
//  Single source of truth for Firebase init
// =============================================
//
//  ⚠️  IMPORTANT: Also add your databaseURL below!
//  It looks like: https://YOUR-PROJECT-default-rtdb.firebaseio.com
//
//  Steps if you haven't done this yet:
//  1. Firebase console → Build → Realtime Database → Create database
//  2. Choose region → Start in TEST MODE
//  3. Copy the database URL shown and paste it below as "databaseURL"
//  4. Firebase console → Build → Authentication → Sign-in method
//     → Anonymous → Enable → Save
// =============================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase }   from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const firebaseConfig = {
  apiKey:            "AIzaSyDFXIvQq0YD8i_ldVpVm92upLVuF5YtR94",
  authDomain:        "love-watch-480cc.firebaseapp.com",
  // ⚠️  ADD YOUR DATABASE URL HERE — get it from Firebase console → Realtime Database
  databaseURL:       "https://love-watch-480cc-default-rtdb.firebaseio.com",
  projectId:         "love-watch-480cc",
  storageBucket:     "love-watch-480cc.firebasestorage.app",
  messagingSenderId: "600304633883",
  appId:             "1:600304633883:web:462e928ddcb906d9e110be",
};

const app  = initializeApp(firebaseConfig);
const db   = getDatabase(app);
const auth = getAuth(app);

// Sign in anonymously so Realtime Database rules allow read/write
signInAnonymously(auth).catch((e) => console.error("Auth error:", e));

export { db, auth };
