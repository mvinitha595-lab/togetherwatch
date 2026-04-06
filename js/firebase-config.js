import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase }   from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const firebaseConfig = {
  apiKey:            "AIzaSyDFXIvQq0YD8i_ldVpVm92upLVuF5YtR94",
  authDomain:        "love-watch-480cc.firebaseapp.com",
  databaseURL:       "https://love-watch-480cc-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "love-watch-480cc",
  storageBucket:     "love-watch-480cc.firebasestorage.app",
  messagingSenderId: "600304633883",
  appId:             "1:600304633883:web:462e928ddcb906d9e110be",
};

const app  = initializeApp(firebaseConfig);
const db   = getDatabase(app);
const auth = getAuth(app);
signInAnonymously(auth).catch(e => console.error("Auth:", e));
export { db, auth };
