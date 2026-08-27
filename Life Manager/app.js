"use strict";

/* ===================== Life Manager — Local ===================== */
let session = { userId: "local", email: "", username: "Moi" };
let events = [];
let todos = [];
let ttActivities = [];       // activités récurrentes de l'emploi du temps
let ttCancellations = [];    // annulations ponctuelles (par semaine)
let ttSettings = null;       // null = emploi du temps pas encore créé ; sinon { slot_min }
let weatherCache = null;      // { lat, lon, city, current, daily, fetchedAt }
let weatherCity = null;       // ville manuelle
let projects = [];
let projectTasks = [];
let projectNotes = [];
let projectDetailId = null;

/* ===================== Utilitaires ===================== */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function pad(n) { return String(n).padStart(2, "0"); }
function dayKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function parseDay(key) { const p = key.split("-").map(Number); return new Date(p[0], p[1] - 1, p[2]); }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function addMonths(d, n) { const r = new Date(d); r.setMonth(r.getMonth() + n); return r; }
function addYears(d, n) { const r = new Date(d); r.setFullYear(r.getFullYear() + n); return r; }
function startOfWeek(d) { const r = new Date(d); r.setDate(r.getDate() - ((r.getDay() + 6) % 7)); return r; }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }

const DAYS_SHORT = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const DAYS_FULL = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const MONTHS = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];

function fmtDateLong(d) {
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
function fmtDateShort(d) {
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}
function fmtTime(d) {
  return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}
function fmtTTime(t) { return String(t || "").slice(0, 5); }
function isoWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}
function eventDayKey(e) { return dayKey(new Date(e.start_at)); }
function eventTime(e) { return fmtTime(new Date(e.start_at)); }

/* ===================== Agenda / Emploi du temps (helpers) ===================== */
function isPastEvent(e) { return eventDayKey(e) < dayKey(new Date()); }
function visibleEvents() { return events.filter((e) => !isPastEvent(e)); }

function ttDayIndex() { return (new Date().getDay() + 6) % 7; } // 0 = Lundi
function currentWeekStartKey() { return dayKey(startOfWeek(new Date())); }
function ttMinutes(t) {
  const p = String(t || "08:00").split(":");
  return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0);
}
function ttCancelledIds() {
  const wk = currentWeekStartKey();
  const set = new Set();
  for (const c of ttCancellations) {
    if (String(c.week_start).slice(0, 10) === wk) set.add(c.activity_id);
  }
  return set;
}
function activeTimetableForDay(dayIndex) {
  const cancelled = ttCancelledIds();
  return ttActivities
    .filter((a) => a.day_of_week === dayIndex && !cancelled.has(a.id))
    .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
}

/* ===================== Backend (Supabase ou démo) ===================== */
const LS_WEATHER = "lm_weather";
const LS_WEATHER_CITY = "lm_weather_city";

function lsGet(k, fallback) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; }
  catch (e) { return fallback; }
}
function lsSet(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
}

/* ===================== Backend (localStorage) ===================== */
const LS_EVENTS   = "lm_events";
const LS_TODOS    = "lm_todos";
const LS_TT_ACT   = "lm_tt_activities";
const LS_TT_CANC  = "lm_tt_cancellations";
const LS_TT_SET   = "lm_tt_settings";
const LS_PROJ     = "lm_projects";
const LS_PROJ_TSK = "lm_project_tasks";
const LS_PROJ_NOTE = "lm_project_notes";
const LS_PW_HASH  = "lm_pw_hash";
const LS_SESSION  = "lm_session";
const LS_USERNAME = "lm_username";
const LS_SALT     = "lm_salt";
const LS_CHECK    = "lm_check";
const LS_THEME    = "lm_theme";
const LS_PW_STRONG = "lm_pw_strong"; // "1" si le mot de passe maître est fort, "0" sinon

/* ===================== Chiffrement des données (AES-256-GCM + PBKDF2) =====================
   Toutes les données applicatives sont chiffrées dans localStorage. La clé AES est dérivée
   du mot de passe (PBKDF2, 600 000 itérations) et n'est JAMAIS stockée : sans le mot de passe,
   les données sont irrécupérables. Un wrapper transparent sur localStorage chiffre/déchiffre
   à la volée une fois la clé dérivée (vaultKey).
============================================================================= */
const ENC_PREFIX = "ENC1:";
// Clés stockées en clair (nécessaires avant la connexion, non sensibles)
const VAULT_PLAIN_KEYS = new Set([LS_SALT, LS_SESSION, LS_USERNAME, LS_THEME, LS_PW_STRONG]);

let vaultKey = null;          // CryptoKey AES-GCM en mémoire (jamais persistée)
const vaultCache = new Map(); // valeurs déchiffrées de la session
const encQueue = new Map();   // sérialise le chiffrement asynchrone par clé

// Références aux méthodes originales, liées à localStorage (utilisées avant/indépendamment du wrapper)
const _rawGet = Storage.prototype.getItem.bind(localStorage);
const _rawSet = Storage.prototype.setItem.bind(localStorage);
const _rawRemove = Storage.prototype.removeItem.bind(localStorage);

function bufToHex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,"0")).join(""); }
function hexToBuf(hex) { return new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b,16))); }

function b64Encode(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}
function b64Decode(b64) { return Uint8Array.from(atob(b64), c => c.charCodeAt(0)); }

const PBKDF2_ITER = 600000;       // itérations actuelles (renforcées)
const PBKDF2_ITER_LEGACY = 200000; // anciennes itérations (migration des vieux comptes)

async function deriveKey(password, saltHex, iterations) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: hexToBuf(saltHex), iterations: iterations || PBKDF2_ITER, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}

async function encValue(key, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return ENC_PREFIX + b64Encode(iv) + "." + b64Encode(new Uint8Array(ct));
}

async function decValue(key, stored) {
  const [ivB64, ctB64] = stored.slice(ENC_PREFIX.length).split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64Decode(ivB64) }, key, b64Decode(ctB64));
  return new TextDecoder().decode(pt);
}

/* --- Wrapper transparent sur localStorage --- */
function installVaultWrapper() {
  Storage.prototype.getItem = function (k) {
    if (vaultCache.has(k)) return vaultCache.get(k);
    const v = _rawGet(k);
    if (v && v.startsWith(ENC_PREFIX) && !vaultKey) return null; // chiffré mais pas encore de clé
    return v;
  };
  Storage.prototype.setItem = function (k, v) {
    const val = String(v);
    if (!vaultKey || VAULT_PLAIN_KEYS.has(k)) { _rawSet(k, val); return; }
    vaultCache.set(k, val);
    const prev = encQueue.get(k) || Promise.resolve();
    const p = prev.then(() => encValue(vaultKey, val))
      .then(ct => { if (_rawGet(k) !== ct) _rawSet(k, ct); })
      .catch(() => {});
    encQueue.set(k, p);
  };
  Storage.prototype.removeItem = function (k) {
    vaultCache.delete(k);
    _rawRemove(k);
  };
}
installVaultWrapper();

/* --- Vérification du mot de passe (ancien système, migration) --- */
async function hashPassword(password, salt, iterations) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name:"PBKDF2", salt: hexToBuf(salt), iterations: iterations || PBKDF2_ITER, hash:"SHA-256" }, key, 256);
  return bufToHex(bits);
}

async function verifyLegacyPassword(password) {
  const raw = _rawGet(LS_PW_HASH);
  if (!raw) return false;
  try {
    const { salt, hash } = JSON.parse(raw);
    if ((await hashPassword(password, salt, PBKDF2_ITER_LEGACY)) === hash) return true;
    if ((await hashPassword(password, salt, PBKDF2_ITER)) === hash) return true;
    return false;
  }
  catch(e) { return false; }
}

/* --- Ouverture du coffre au login --- */
async function unlockVault(password) {
  let salt = _rawGet(LS_SALT);
  if (!salt) {
    // Migration depuis l'ancien système (hash uniquement, données en clair)
    const ok = await verifyLegacyPassword(password);
    if (!ok) return false;
    salt = bufToHex(crypto.getRandomValues(new Uint8Array(16)));
    _rawSet(LS_SALT, salt);
    vaultKey = await deriveKey(password, salt);
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (VAULT_PLAIN_KEYS.has(k) || k === LS_CHECK || k === LS_PW_HASH) continue;
      const v = _rawGet(k);
      if (v) localStorage.setItem(k, v); // sera chiffré par le wrapper
    }
    localStorage.setItem(LS_CHECK, "ok");
    _rawRemove(LS_PW_HASH);
    await Promise.all(encQueue.values());
    return true;
  }
  let key = await deriveKey(password, salt, PBKDF2_ITER);
  const check = _rawGet(LS_CHECK);
  let valid = false;
  let migrated = false; // vrai si le compte utilisait l'ancien nombre d'itérations
  if (check && check.startsWith(ENC_PREFIX)) {
    try { valid = (await decValue(key, check)) === "ok"; } catch (e) { valid = false; }
    if (!valid) {
      // Migration : l'ancien compte était chiffré avec 200 000 itérations
      try {
        const oldKey = await deriveKey(password, salt, PBKDF2_ITER_LEGACY);
        valid = (await decValue(oldKey, check)) === "ok";
        if (valid) {
          key = await deriveKey(password, salt, PBKDF2_ITER);
          migrated = true;
        }
      } catch (e) { valid = false; }
    }
  } else {
    valid = await verifyLegacyPassword(password);
    if (valid) {
      vaultKey = key;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (VAULT_PLAIN_KEYS.has(k) || k === LS_CHECK || k === LS_PW_HASH) continue;
        const v = _rawGet(k);
        if (v) localStorage.setItem(k, v);
      }
      localStorage.setItem(LS_CHECK, "ok");
      _rawRemove(LS_PW_HASH);
    }
  }
  if (!valid) return false;
  vaultKey = key;
  vaultCache.clear();
  const readKey = migrated ? await deriveKey(password, salt, PBKDF2_ITER_LEGACY) : key;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (VAULT_PLAIN_KEYS.has(k) || k === LS_CHECK) continue;
    const v = _rawGet(k);
    if (!v) continue;
    try { vaultCache.set(k, v.startsWith(ENC_PREFIX) ? await decValue(readKey, v) : v); } catch (e) {}
  }
  if (migrated) {
    // Re-chiffre toutes les données avec la nouvelle clé (600 000 itérations)
    for (const [k, v] of vaultCache) {
      try { _rawSet(k, await encValue(key, v)); } catch (e) {}
    }
    _rawSet(LS_CHECK, await encValue(key, "ok"));
  }
  await pwUnlock(password);
  await Promise.all(encQueue.values());
  return true;
}

/* --- Premier lancement / réinitialisation --- */
async function setupVault(password) {
  const salt = bufToHex(crypto.getRandomValues(new Uint8Array(16)));
  _rawSet(LS_SALT, salt);
  _rawSet(LS_PW_STRONG, isStrongPassword(password).ok ? "1" : "0");
  vaultKey = await deriveKey(password, salt);
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (VAULT_PLAIN_KEYS.has(k) || k === LS_CHECK || k === LS_PW_HASH) continue;
    const v = _rawGet(k);
    if (v && !v.startsWith(ENC_PREFIX)) localStorage.setItem(k, v);
  }
  localStorage.setItem(LS_CHECK, "ok");
  _rawRemove(LS_PW_HASH);
  await pwUnlock(password);
  await Promise.all(encQueue.values());
}

/* --- Changer le mot de passe (avec l'ancien) --- */
async function changeVaultPassword(oldPw, newPw) {
  const ok = await unlockVault(oldPw);
  if (!ok) return false;
  const salt = bufToHex(crypto.getRandomValues(new Uint8Array(16)));
  _rawSet(LS_SALT, salt);
  const newKey = await deriveKey(newPw, salt);
  vaultKey = newKey;
  for (const [k, v] of vaultCache) {
    try { _rawSet(k, await encValue(newKey, v)); } catch (e) {}
  }
  _rawSet(LS_CHECK, await encValue(newKey, "ok"));
  _rawSet(LS_PW_STRONG, isStrongPassword(newPw).ok ? "1" : "0");
  await pwChangePassword(oldPw, newPw);
  return true;
}

async function lockVault() {
  await Promise.all(encQueue.values());
  vaultCache.clear();
  vaultKey = null;
  pwVaultKey = null;
  pwStore = null;
}

/* ===================== Coffre mots de passe (chiffré, clé dédiée) =====================
   Stocké dans une valeur unique `lm_pw_vault`, chiffrée AES-256-GCM avec une clé dérivée
   du mot de passe via PBKDF2 (sel dédié `lm_pw_salt`, 600 000 itérations). La clé n'est
   gardée qu'en mémoire, jamais stockée. Déverrouillé automatiquement au login.
============================================================================= */
const LS_PW_SALT  = "lm_pw_salt";
const LS_PW_VAULT = "lm_pw_vault";

let pwVaultKey = null;   // CryptoKey AES-GCM du coffre mots de passe (mémoire uniquement)
let pwStore = null;      // { categories: [], entries: [] } déchiffrés

function pwGenId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function pwDeriveKey(password) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  const saltHex = _rawGet(LS_PW_SALT);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: hexToBuf(saltHex), iterations: PBKDF2_ITER, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}

async function pwSave(store) {
  if (!pwVaultKey) return;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, pwVaultKey, new TextEncoder().encode(JSON.stringify(store)));
  _rawSet(LS_PW_VAULT, ENC_PREFIX + b64Encode(iv) + "." + b64Encode(new Uint8Array(ct)));
}

async function pwLoad() {
  const raw = _rawGet(LS_PW_VAULT);
  if (!raw) { pwStore = { categories: [], entries: [] }; return pwStore; }
  if (!pwVaultKey) return null;
  try {
    const json = await decValue(pwVaultKey, raw);
    const data = JSON.parse(json);
    pwStore = { categories: data.categories || [], entries: data.entries || [] };
    return pwStore;
  } catch (e) { return null; }
}

async function pwUnlock(password) {
  // Crée le sel au premier déverrouillage s'il n'existe pas encore
  if (!_rawGet(LS_PW_SALT)) {
    _rawSet(LS_PW_SALT, bufToHex(crypto.getRandomValues(new Uint8Array(16))));
    pwVaultKey = await pwDeriveKey(password);
    await pwSave({ categories: [], entries: [] });
    return true;
  }
  try {
    pwVaultKey = await pwDeriveKey(password);
    const ok = await pwLoad();
    return !!ok;
  } catch (e) {
    pwVaultKey = null;
    return false;
  }
}

async function pwChangePassword(oldPw, newPw) {
  // Déverrouiller avec l'ancien (si pas déjà fait)
  if (!pwVaultKey || !pwStore) {
    const ok = await pwUnlock(oldPw);
    if (!ok) return false;
  }
  // Re-chiffrer avec un nouveau sel + nouvelle clé
  const store = pwStore || { categories: [], entries: [] };
  _rawSet(LS_PW_SALT, bufToHex(crypto.getRandomValues(new Uint8Array(16))));
  pwVaultKey = await pwDeriveKey(newPw);
  await pwSave(store);
  pwStore = store;
  return true;
}

function genId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* --- API localStorage --- */
const API = {
  isPasswordSet() { return !!(_rawGet(LS_SALT) || _rawGet(LS_PW_HASH)); },
  async logout() { await lockVault(); _rawRemove(LS_SESSION); session = null; },

  async loadEvents()   { events = lsGet(LS_EVENTS, []); return events; },
  async saveEvent(ev)  { if (!ev.id) ev.id = genId("ev"); const l=lsGet(LS_EVENTS,[]); const i=l.findIndex(x=>x.id===ev.id); if(i>=0) l[i]=ev; else l.push(ev); lsSet(LS_EVENTS,l); return ev; },
  async deleteEvent(id){ lsSet(LS_EVENTS, lsGet(LS_EVENTS,[]).filter(x=>x.id!==id)); },

  async loadTodos()    { todos = lsGet(LS_TODOS, []); return todos; },
  async saveTodo(t)    { if (!t.id) t.id = genId("td"); const l=lsGet(LS_TODOS,[]); const i=l.findIndex(x=>x.id===t.id); if(i>=0) l[i]=t; else l.push(t); lsSet(LS_TODOS,l); return t; },
  async deleteTodo(id) { lsSet(LS_TODOS, lsGet(LS_TODOS,[]).filter(x=>x.id!==id)); },

  async loadTimetable() { ttActivities=lsGet(LS_TT_ACT,[]); ttCancellations=lsGet(LS_TT_CANC,[]); return {activities:ttActivities,cancellations:ttCancellations}; },
  async saveTimetableActivity(a) { if (!a.id) a.id = genId("tt"); const l=lsGet(LS_TT_ACT,[]); const i=l.findIndex(x=>x.id===a.id); if(i>=0) l[i]=a; else l.push(a); lsSet(LS_TT_ACT,l); return a; },
  async deleteTimetableActivity(id) { lsSet(LS_TT_ACT, lsGet(LS_TT_ACT,[]).filter(x=>x.id!==id)); },
  async cancelActivityForWeek(activityId) { const l=lsGet(LS_TT_CANC,[]); const c={id:"c_"+activityId+"_"+currentWeekStartKey(),activity_id:activityId,week_start:currentWeekStartKey()}; if(!l.find(x=>x.id===c.id)) l.push(c); lsSet(LS_TT_CANC,l); },
  async reactivateActivity(activityId) { lsSet(LS_TT_CANC, lsGet(LS_TT_CANC,[]).filter(x=>x.activity_id!==activityId||x.week_start!==currentWeekStartKey())); },
  async loadTimetableSettings() { ttSettings=lsGet(LS_TT_SET,null); return ttSettings; },
  async saveTimetableSettings(slotMin) { ttSettings={slot_min:slotMin}; lsSet(LS_TT_SET,ttSettings); return ttSettings; },

  async loadProjects()     { projects = lsGet(LS_PROJ, []); return projects; },
  async saveProject(p)     { if (!p.id) p.id = genId("pr"); const l=lsGet(LS_PROJ,[]); const i=l.findIndex(x=>x.id===p.id); if(i>=0) l[i]=p; else l.push(p); lsSet(LS_PROJ,l); return p; },
  async deleteProject(id)  { lsSet(LS_PROJ, lsGet(LS_PROJ,[]).filter(x=>x.id!==id)); },
  async loadProjectTasks() { projectTasks = lsGet(LS_PROJ_TSK, []); return projectTasks; },
  async saveProjectTask(t) { if (!t.id) t.id = genId("pt"); const l=lsGet(LS_PROJ_TSK,[]); const i=l.findIndex(x=>x.id===t.id); if(i>=0) l[i]=t; else l.push(t); lsSet(LS_PROJ_TSK,l); return t; },
  async deleteProjectTask(id) { lsSet(LS_PROJ_TSK, lsGet(LS_PROJ_TSK,[]).filter(x=>x.id!==id)); },
  async loadProjectNotes() { projectNotes = lsGet(LS_PROJ_NOTE, []); return projectNotes; },
  async saveProjectNote(n) { if (!n.id) n.id = genId("pn"); const l=lsGet(LS_PROJ_NOTE,[]); const i=l.findIndex(x=>x.id===n.id); if(i>=0) l[i]=n; else l.push(n); lsSet(LS_PROJ_NOTE,l); return n; },
  async deleteProjectNote(id) { lsSet(LS_PROJ_NOTE, lsGet(LS_PROJ_NOTE,[]).filter(x=>x.id!==id)); },
};
/* ===================== Authentification (UI) ===================== */

async function showLogin() {
  document.body.dataset.accent = "green";
  document.getElementById("view-login").classList.remove("hidden");
  document.getElementById("view-app").classList.add("hidden");
  var isSetup = API.isPasswordSet();
  var storedName = lsGet(LS_USERNAME, "") || "";
  document.getElementById("login-title").textContent = isSetup ? "Content de te revoir" : "Bienvenue !";
  document.getElementById("login-sub").textContent = isSetup
    ? (storedName ? "Content de te revoir, " + storedName + " ! Entre ton mot de passe pour accéder à tes données." : "Entre ton mot de passe pour accéder à tes données.")
    : "Première utilisation — choisis ton nom et un mot de passe pour protéger tes données.";
  document.getElementById("login-setup-msg").classList.toggle("hidden", isSetup);
  document.getElementById("login-btn").textContent = isSetup ? "Accéder" : "Créer mon compte";
  document.getElementById("login-msg").textContent = "";
  document.getElementById("login-msg").className = "msg";
  document.getElementById("pw-input").value = "";
  var nf = document.getElementById("name-field"), ni = document.getElementById("name-input");
  if (nf) nf.classList.toggle("hidden", isSetup);
  if (ni) ni.value = "";
  var fp = document.getElementById("forgot-pw");
  if (fp) fp.classList.toggle("hidden", !isSetup);
  (isSetup ? document.getElementById("pw-input") : document.getElementById("name-input")).focus();
}

/* ===================== Politique de mot de passe fort =====================
   Imposée à la création et au changement de mot de passe :
   - 12 caractères minimum
   - au moins une majuscule, une minuscule, un chiffre et un symbole
   - pas de mot du dictionnaire (liste de mots courants FR/EN)
============================================================================= */
const COMMON_WORDS = new Set([
  // français courants
  "motdepasse","mdp","bonjour","soleil","minou","chaton","amour","famille","maison","voiture",
  "coucou","salut","hello","bienvenue","maman","papa","toto","titi","tutu","tata",
  "password","pass","passw0rd","p@ssword","secret","secrete","cle","clé","code","acces","accès",
  "root","admin","user","test","demo","guest","invite","invité","login","connection","connexion",
  "freebuff","free","buff","life","manager","lifemanager","projet","projet123",
  "securite","sécurité","securite123","sécurité123","crypto","chiffrement","chiffre",
  // prénoms et noms courants
  "johnatan","john","johny","johnny","johathan","johnathan","jonathan","jean","jeanmichel",
  "michel","philippe","pierre","paul","jacques","marie","claire","julie","nicolas","thomas",
  "michael","robert","sarah","william","george","daniel","jordan","jessica","charlie",
  "maman","papa","bebe","bébé","soeur","soeur","frere","frère","copain","copine","ami","amie",
  // anglais courants
  "password1","password123","letmein","welcome","monkey","dragon","shadow","master",
  "superman","batman","princess","iloveyou","trustno1","sunshine","football","baseball",
  "soccer","mustang","cookie","hunter","ranger","buster","summer","tigger","harley","pepper",
  "killer","asdfgh","qwerty","qwertz","azerty","azertyuiop","abc123","1q2w3e4r","1qaz2wsx",
  "qazwsx","zxcvbn","poiuytrewq","lkjhgfdsa","mnbvcxz","dragon","monkey","shadow",
  "baseball","football","letmein","master","princess","soccer","welcome","whatever","trustno1",
  // mots simples à exclure même seuls
  "oui","non","ok","moi","toi","nous","vous","bonjour","aujourdhui","maintenant"
]);

function isStrongPassword(pw) {
  if (!pw || pw.length < 12) return { ok: false, reason: "Au moins 12 caractères requis." };
  var hasUpper = /[A-Z]/.test(pw);
  var hasLower = /[a-z]/.test(pw);
  var hasDigit = /[0-9]/.test(pw);
  var hasSymbol = /[^A-Za-z0-9]/.test(pw);
  if (!hasUpper || !hasLower || !hasDigit || !hasSymbol) {
    return { ok: false, reason: "Il faut une majuscule, une minuscule, un chiffre et un symbole." };
  }
  // Pas de mot du dictionnaire entier dans le mot de passe (insensible à la casse)
  var norm = pw.toLowerCase().replace(/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~ ]/g, "");
  for (var w of COMMON_WORDS) {
    if (norm.includes(w)) return { ok: false, reason: "Évite les mots courants comme \"" + w + "\" — trop faciles à deviner." };
  }
  return { ok: true };
}

async function handleLogin(e) {
  e.preventDefault();
  var pw = document.getElementById("pw-input").value.trim();
  var msg = document.getElementById("login-msg");
  if (!pw) { msg.textContent = "Saisis un mot de passe."; msg.className = "msg error"; return; }
  if (pw.length < 4) { msg.textContent = "Mot de passe trop court (4 caracteres minimum)."; msg.className = "msg error"; return; }
  var btn = document.getElementById("login-btn");
  btn.disabled = true;
  try {
    var isSetup = API.isPasswordSet();
    if (!isSetup) {
      var name = document.getElementById("name-input").value.trim();
      if (!name) { msg.textContent = "Indique ton nom pour personnaliser ton profil."; msg.className = "msg error"; btn.disabled = false; return; }
      lsSet(LS_USERNAME, name);
      if (session) session.username = name;
      await setupVault(pw);
      localStorage.setItem(LS_SESSION, "1");
      await enterApp();
    } else {
      var ok = await unlockVault(pw);
      if (!ok) { msg.textContent = "Mot de passe incorrect."; msg.className = "msg error"; return; }
      localStorage.setItem(LS_SESSION, "1");
      await enterApp();
    }
  } catch (err) {
    msg.textContent = "Une erreur est survenue."; msg.className = "msg error";
  } finally { btn.disabled = false; }
}

async function enterApp() {
  if (!session) session = { userId: "local", email: "", username: "Moi" };
  session.username = lsGet(LS_USERNAME, "") || "Moi";
  document.getElementById("view-login").classList.add("hidden");
  document.getElementById("view-app").classList.remove("hidden");
  await API.loadEvents();
  await API.loadTodos();
  await API.loadTimetable();
  await API.loadTimetableSettings();
  await API.loadProjects();
  await API.loadProjectTasks();
  await API.loadProjectNotes();
  loadWeatherCache();
  newsCache = lsGet(LS_NEWS, null);
  fetchWeather(false);
  loadNews(false);
  navigate("dashboard");
}

function showAuth() {
  localStorage.removeItem(LS_SESSION);
  session = null;
  showLogin();
}

/* ===================== Options (profil + mot de passe) ===================== */
function renderOptions() {
  var input = $("#opt-username");
  var name = (session && session.username) || "Moi";
  if (input) input.value = name === "Moi" ? "" : name;
  clearOptMsg("name");
  clearOptMsg("pw");
  var o = $("#opt-old-pw"), n = $("#opt-new-pw"), c = $("#opt-new-pw2");
  if (o) o.value = ""; if (n) n.value = ""; if (c) c.value = "";
}

function clearOptMsg(kind) {
  var m = $("#opt-" + kind + "-msg");
  if (m) { m.textContent = ""; m.className = "opt-msg"; void m.offsetWidth; }
}

function setOptMsg(kind, text, isError) {
  var m = $("#opt-" + kind + "-msg");
  if (!m) return;
  m.textContent = text;
  m.className = "opt-msg" + (isError ? " opt-msg-error" : " opt-msg-ok");
}

async function saveOptName() {
  var input = $("#opt-username");
  var name = (input.value || "").trim();
  if (!name) { setOptMsg("name", "Indique un nom de profil.", true); return; }
  lsSet(LS_USERNAME, name);
  if (session) session.username = name;
  setOptMsg("name", "Nom enregistré ✓");
  if (typeof renderDashboard === "function" && $("#page-dashboard") && !$("#page-dashboard").classList.contains("hidden")) renderDashboard();
}

async function saveOptPassword() {
  var oldPw = $("#opt-old-pw").value;
  var newPw = $("#opt-new-pw").value;
  var newPw2 = $("#opt-new-pw2").value;
  if (!oldPw) { setOptMsg("pw", "Entre ton mot de passe actuel.", true); return; }
  if (newPw.length < 4) { setOptMsg("pw", "Nouveau mot de passe trop court (4 caractères min).", true); return; }
  var strength = isStrongPassword(newPw);
  if (!strength.ok) { setOptMsg("pw", "Mot de passe trop faible : " + strength.reason, true); return; }
  if (newPw !== newPw2) { setOptMsg("pw", "Les nouveaux mots de passe ne correspondent pas.", true); return; }
  var ok = await changeVaultPassword(oldPw, newPw);
  if (!ok) { setOptMsg("pw", "L'ancien mot de passe est incorrect.", true); return; }
  var o = $("#opt-old-pw"), n = $("#opt-new-pw"), c = $("#opt-new-pw2");
  if (o) o.value = ""; if (n) n.value = ""; if (c) c.value = "";
  setOptMsg("pw", "Mot de passe modifié ✓");
}

/* ===================== Navigation ===================== */
const PAGES = ["dashboard", "schedule", "timetable", "todos", "weather", "youtube", "projects", "passwords", "options"];
const ACCENTS = { dashboard: "green", schedule: "blue", timetable: "violet", todos: "yellow", weather: "cyan", youtube: "red", projects: "green", passwords: "cyan", options: "green" };

let pwUpgradeDone = false; // true juste après un renforcement réussi (évite la ré-ouverture)

function navigate(page) {
  // Accès au coffre : exige un mot de passe fort (sauf juste après renforcement)
  if (page === "passwords" && !pwUpgradeDone && _rawGet(LS_PW_STRONG) !== "1") {
    openPwUpgrade();
    return;
  }
  pwUpgradeDone = false;
  PAGES.forEach((p) => {
    var pg = $("#page-" + p); if (pg) pg.classList.toggle("hidden", p !== page);
    var navEl = $("#nav-" + p); if (navEl) navEl.classList.toggle("active", p === page);
  });
  document.body.dataset.accent = ACCENTS[page] || "green";
  if (page === "dashboard") renderDashboard();
  if (page === "schedule") renderSchedule();
  if (page === "timetable") renderTimetable();
  if (page === "todos") renderTodos();
  if (page === "weather") renderWeatherPage();
  if (page === "youtube") renderYouTubePage();
  if (page === "projects") renderProjects();
  if (page === "passwords") renderPasswords();
  if (page === "options") renderOptions();
}

/* --- Modale de renforcement du mot de passe (accès au coffre) --- */
function openPwUpgrade() {
  var m = $("#modal-pw-upgrade");
  if (!m) return;
  var o = $("#pwu-old"), n = $("#pwu-new"), n2 = $("#pwu-new2"), msg = $("#pwu-msg");
  if (o) o.value = ""; if (n) n.value = ""; if (n2) n2.value = "";
  if (msg) { msg.textContent = ""; msg.className = "opt-msg"; }
  m.classList.add("open");
  if (o) o.focus();
}

function closePwUpgrade() {
  var m = $("#modal-pw-upgrade");
  if (m) m.classList.remove("open");
  var msg = $("#pwu-msg");
  if (msg) { msg.textContent = ""; msg.className = "opt-msg"; }
}

async function confirmPwUpgrade() {
  var oldPw = $("#pwu-old").value;
  var newPw = $("#pwu-new").value;
  var newPw2 = $("#pwu-new2").value;
  var msg = $("#pwu-msg");
  if (!oldPw) { msg.textContent = "Entre ton mot de passe actuel."; msg.className = "opt-msg opt-msg-error"; return; }
  if (newPw.length < 4) { msg.textContent = "Nouveau mot de passe trop court (4 caractères min)."; msg.className = "opt-msg opt-msg-error"; return; }
  var strength = isStrongPassword(newPw);
  if (!strength.ok) { msg.textContent = "Mot de passe trop faible : " + strength.reason; msg.className = "opt-msg opt-msg-error"; return; }
  if (newPw !== newPw2) { msg.textContent = "Les nouveaux mots de passe ne correspondent pas."; msg.className = "opt-msg opt-msg-error"; return; }
  var btn = $("#pwu-confirm");
  btn.disabled = true;
  try {
    var ok = await changeVaultPassword(oldPw, newPw);
    if (!ok) { msg.textContent = "Le mot de passe actuel est incorrect."; msg.className = "opt-msg opt-msg-error"; btn.disabled = false; return; }
    closePwUpgrade();
    pwUpgradeDone = true;
    navigate("passwords");
  } catch (e) {
    msg.textContent = "Une erreur est survenue."; msg.className = "opt-msg opt-msg-error";
  } finally { btn.disabled = false; }
}

/* ===================== Mots de passe ===================== */
const PW_CAT_COLORS = ["#4f8ef7", "#f78e4f", "#7ac74f", "#c74ff7", "#4fc7c7", "#e05b7a", "#8a7ae0", "#d9a33a", "#56b881", "#b85d5d"];
let pwFilterCat = "all";     // "all" | "none" | catId
let pwFilterQ = "";
let pwEditId = null;          // id de l'entrée en cours d'édition
let pwClipboardClear = null;  // timer effacement presse-papiers

function pwCatColor(id) {
  const i = pwStore.categories.findIndex((c) => c.id === id);
  return PW_CAT_COLORS[Math.abs(i) % PW_CAT_COLORS.length];
}
function pwCatName(id) {
  const c = pwStore.categories.find((c) => c.id === id);
  return c ? c.name : "";
}

function pwHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
}

function pwEntriesFiltered() {
  let list = pwStore.entries.slice();
  if (pwFilterCat === "none") list = list.filter((e) => !e.categoryId);
  else if (pwFilterCat !== "all") list = list.filter((e) => e.categoryId === pwFilterCat);
  const q = pwFilterQ.trim().toLowerCase();
  if (q) {
    list = list.filter((e) =>
      (e.site || "").toLowerCase().includes(q) ||
      (e.username || "").toLowerCase().includes(q) ||
      (e.url || "").toLowerCase().includes(q) ||
      (e.notes || "").toLowerCase().includes(q) ||
      (pwCatName(e.categoryId) || "").toLowerCase().includes(q)
    );
  }
  const sort = ($("#pw-sort") || {}).value || "site";
  if (sort === "cat") list.sort((a, b) => (a.categoryId || "").localeCompare(b.categoryId || ""));
  else if (sort === "recent") list.sort((a, b) => ((b.updatedAt || 0) - (a.updatedAt || 0)));
  else list.sort((a, b) => (a.site || "").localeCompare(b.site || ""));
  return list;
}

function renderPasswords() {
  if (!pwStore) pwStore = { categories: [], entries: [] };
  const list = pwEntriesFiltered();
  $("#pw-count").textContent = pwStore.entries.length === 0 ? "0 mot de passe"
    : (pwStore.entries.length + " mot" + (pwStore.entries.length > 1 ? "s " : " ") + "de passe");

  // Catégories (pills)
  const cats = $("#pw-cats");
  if (cats) {
    const pills = [{ id: "all", label: "Toutes" }, { id: "none", label: "Sans catégorie" }]
      .concat(pwStore.categories.map((c) => ({ id: c.id, label: c.name, color: pwCatColor(c.id) })));
    cats.innerHTML = pills.map((p) => {
      const count = p.id === "all" ? pwStore.entries.length
        : p.id === "none" ? pwStore.entries.filter((e) => !e.categoryId).length
        : pwStore.entries.filter((e) => e.categoryId === p.id).length;
      return `<button class="pw-cat${pwFilterCat === p.id ? " active" : ""}" data-cat="${p.id}" type="button"`
        + (p.color ? ` style="--pc:${p.color}"` : "") + `>${p.label} <span class="pw-cat-count">${count}</span></button>`;
    }).join("");
    const catClicks = cats.querySelectorAll(".pw-cat");
    catClicks.forEach((b) => b.addEventListener("click", () => {
      pwFilterCat = b.dataset.cat;
      renderPasswords();
    }));
  }

  // Liste
  const box = $("#pw-list");
  const empty = $("#pw-empty");
  if (box) {
    if (list.length === 0) {
      box.innerHTML = "";
      if (empty) empty.classList.add("show");
    } else {
      if (empty) empty.classList.remove("show");
      box.innerHTML = list.map((e) => {
        const catName = pwCatName(e.categoryId);
        const host = pwHost(e.url) || e.site;
        return `<div class="pw-entry" data-id="${e.id}">
          <div class="pw-entry-fav" style="background:${catName ? pwCatColor(e.categoryId) : "#3a4a5e"}">${(e.site || "•").charAt(0).toUpperCase()}</div>
          <div class="pw-entry-main">
            <div class="pw-entry-site">${e.url ? `<a class="pw-site-link" href="${esc(e.url)}" target="_blank" rel="noopener" title="Ouvrir ${esc(e.url)}">${esc(e.site || "Sans nom")} <span class="pw-ext">↗</span></a>` : `<span class="pw-site-name">${esc(e.site || "Sans nom")}</span>`}
              ${host ? `<span class="pw-entry-host">${esc(host)}</span>` : ""}
              ${catName ? `<span class="pw-cat-badge" style="--pc:${pwCatColor(e.categoryId)}">${esc(catName)}</span>` : ""}
            </div>
            <div class="pw-entry-creds">
              <span><b>${esc(e.username || "—")}</b></span>
              <span class="pw-pass-mask">${esc(e.password || "").replace(/./g, "•") || "•••"}</span>
            </div>
          </div>
          <div class="pw-entry-actions">
            <button class="pw-copy" data-copy="user" title="Copier l'identifiant">📋</button>
            <button class="pw-copy" data-copy="pass" title="Copier le mot de passe (effacé après 30 s)">🔑</button>
            <button data-act="edit" title="Modifier">✏️</button>
            <button data-act="del" class="pw-del" title="Supprimer">🗑</button>
          </div>
        </div>`;
      }).join("");

      // Actions
      box.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => {
        const id = b.closest(".pw-entry").dataset.id;
        if (b.dataset.act === "edit") openPwModal(id);
        else if (confirm("Supprimer ce mot de passe ?")) {
          pwStore.entries = pwStore.entries.filter((x) => x.id !== id);
          pwSave(pwStore).then(() => renderPasswords());
        }
      }));
      box.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const id = b.closest(".pw-entry").dataset.id;
        const e = pwStore.entries.find((x) => x.id === id);
        if (!e) return;
        pwCopyToClipboard(b.dataset.copy === "user" ? (e.username || "") : (e.password || ""), b);
      }));
    }
  }
}

async function pwCopyToClipboard(text, btn) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // fallback
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e2) {}
    ta.remove();
  }
  if (pwClipboardClear) clearTimeout(pwClipboardClear);
  const orig = btn.textContent;
  btn.textContent = "✅";
  setTimeout(() => { btn.textContent = orig; }, 1500);
  // Effacer le presse-papiers après 30 s (sécurité)
  pwClipboardClear = setTimeout(() => {
    try { navigator.clipboard.writeText(""); } catch (e) {}
  }, 30000);
}

/* --- Modale ajout / édition --- */
function openPwModal(id) {
  pwEditId = id || null;
  const e = id ? pwStore.entries.find((x) => x.id === id) : null;
  $("#pwm-title").textContent = e ? "Modifier le mot de passe" : "Nouveau mot de passe";
  $("#pwm-site").value = e ? (e.site || "") : "";
  $("#pwm-url").value = e ? (e.url || "") : "";
  $("#pwm-username").value = e ? (e.username || "") : "";
  $("#pwm-password").value = e ? (e.password || "") : "";
  $("#pwm-notes").value = e ? (e.notes || "") : "";
  $("#pwm-password").type = "password";
  $("#pwm-eye").textContent = "👁";
  renderPwCatSelect(e ? e.categoryId : "");
  $("#pwm-del").style.display = e ? "" : "none";
  $("#pwm-msg").textContent = ""; $("#pwm-msg").className = "opt-msg";
  $("#modal-pw").classList.add("open");
  $("#pwm-site").focus();
}
function closePwModal() { $("#modal-pw").classList.remove("open"); pwEditId = null; }

function renderPwCatSelect(selected) {
  const sel = $("#pwm-cat");
  sel.innerHTML = `<option value="">Sans catégorie</option>` + pwStore.categories.map((c) =>
    `<option value="${c.id}"${c.id === selected ? " selected" : ""}>${esc(c.name)}</option>`
  ).join("");
  if (selected && !pwStore.categories.some((c) => c.id === selected)) sel.value = "";
}

function pwAddCategory(name) {
  const id = pwGenId("cat");
  pwStore.categories.push({ id, name: name.trim() });
  return id;
}

function savePwModal() {
  const site = $("#pwm-site").value.trim();
  const username = $("#pwm-username").value.trim();
  const password = $("#pwm-password").value;
  if (!site) { pwModalMsg("Indique le site / l'application.", true); return; }
  if (!username) { pwModalMsg("Indique l'identifiant.", true); return; }
  if (!password) { pwModalMsg("Indique un mot de passe.", true); return; }
  const data = {
    site, url: $("#pwm-url").value.trim(),
    username, password,
    categoryId: $("#pwm-cat").value || "",
    notes: $("#pwm-notes").value.trim(),
  };
  if (pwEditId) {
    const e = pwStore.entries.find((x) => x.id === pwEditId);
    if (e) Object.assign(e, data, { updatedAt: Date.now() });
  } else {
    data.id = pwGenId("pw"); data.createdAt = Date.now(); data.updatedAt = Date.now();
    pwStore.entries.push(data);
  }
  pwSave(pwStore).then(() => { closePwModal(); renderPasswords(); });
}
function pwModalMsg(text, isError) {
  const m = $("#pwm-msg");
  m.textContent = text;
  m.className = "opt-msg" + (isError ? " opt-msg-error" : " opt-msg-ok");
}

function pwGenerate() {
  const chars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*()-_=+";
  let s = "";
  const arr = new Uint32Array(18);
  crypto.getRandomValues(arr);
  for (const n of arr) s += chars[n % chars.length];
  $("#pwm-password").value = s;
  $("#pwm-password").type = "text";
  $("#pwm-eye").textContent = "🙈";
}

/* --- Import / Export --- */
function pwExportCsv() {
  if (!pwStore.entries.length) { alert("Aucun mot de passe à exporter."); return; }
  const escCsv = (s) => "\"" + String(s || "").replace(/"/g, "\"\"") + "\"";
  const rows = ["name,url,username,password,note"];
  for (const e of pwStore.entries) {
    rows.push([escCsv(e.site), escCsv(e.url || ""), escCsv(e.username), escCsv(e.password), escCsv(e.notes || "")].join(","));
  }
  const blob = new Blob(["\uFEFF" + rows.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "life-manager-mots-de-passe.csv";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function pwParseCsv(text) {
  // Parser simple CSV (supporte quotes)
  const rows = []; let row = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === "\"") { if (text[i + 1] === "\"") { cur += "\""; i++; } else inQ = false; }
      else cur += c;
    } else if (c === "\"") inQ = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

function pwParseImport(rows) {
  if (!rows.length) return { entries: [], format: "" };
  const first = rows[0].map((c) => c.trim().toLowerCase());
  const hasHeader = /name|url|username|password|httprealm|login/.test(first.join(" "));
  const entries = [];
  let format = "";
  const start = hasHeader ? 1 : 0;
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < 2) continue;
    const lower = r.map((c) => String(c).toLowerCase());
    if (hasHeader && first.includes("url") && first.includes("username") && first.includes("password") && !first.includes("name")) {
      // Firefox : url,username,password,...  (pas de colonne "name")
      const iu = first.indexOf("username"), ip = first.indexOf("password"), iurl = first.indexOf("url");
      entries.push({ site: pwHost(r[iurl]) || "Imported", url: r[iurl] || "", username: r[iu] || "", password: r[ip] || "" });
      format = "firefox";
    } else if (hasHeader && (first.includes("name") || (first.includes("url") && first.includes("password")))) {
      // Chrome/Edge : name,url,username,password[,note]
      const idx = (k) => first.indexOf(k);
      const name = r[idx("name")] !== undefined ? r[idx("name")] : r[0];
      const url = r[idx("url")] !== undefined ? r[idx("url")] : "";
      const user = r[idx("username")] !== undefined ? r[idx("username")] : (r[idx("login")] !== undefined ? r[idx("login")] : "");
      const pass = r[idx("password")] !== undefined ? r[idx("password")] : "";
      if (user || pass) { entries.push({ site: name || pwHost(url) || "Imported", url, username: user, password: pass }); format = "chrome"; }
    } else {
      // Générique : site, identifiant, mot de passe
      entries.push({ site: r[0], url: "", username: r.length > 1 ? r[1] : "", password: r.length > 2 ? r[2] : "" });
      format = "generic";
    }
  }
  return { entries: entries.filter((e) => e.username || e.password), format };
}

function pwDoImport(text) {
  const { entries } = pwParseImport(pwParseCsv(text));
  if (!entries.length) { alert("Aucune entrée reconnue dans ce fichier."); return; }
  pwStore = pwStore || { categories: [], entries: [] };
  const now = Date.now();
  for (const e of entries) {
    e.id = pwGenId("pw"); e.createdAt = now; e.updatedAt = now; e.categoryId = ""; e.notes = e.notes || "";
    pwStore.entries.push(e);
  }
  pwSave(pwStore).then(() => {
    renderPasswords();
    alert(entries.length + " mot(s) de passe importé(s).");
  });
}

/* ===================== Tableau de bord ===================== */
function renderDashboard() {
  const now = new Date();
  $("#dash-greeting").textContent = "Bonjour, " + session.username + " 👋";
  $("#dash-date").textContent = fmtDateLong(now);
  $("#dash-week").textContent = "Semaine " + isoWeek(now);

  const todayKey = dayKey(now);
  const todayEvents = events.filter((e) => eventDayKey(e) === todayKey)
    .sort((a, b) => (a.start_at < b.start_at ? -1 : 1));
  const pendingTodos = sortTodos(todos.filter((t) => !t.done));
  const ttToday = activeTimetableForDay(ttDayIndex());

  $("#dash-event-today").textContent = todayEvents.length;
  $("#dash-todo-pending").textContent = pendingTodos.length;
  $("#dash-course-today").textContent = ttToday.length;

  const upcoming = events.filter((e) => new Date(e.start_at) >= now)
    .sort((a, b) => (a.start_at < b.start_at ? -1 : 1))[0];
  $("#dash-next-event").textContent = upcoming
    ? (upcoming.title + " · " + fmtDateShort(new Date(upcoming.start_at)) + (upcoming.all_day ? "" : " · " + eventTime(upcoming)))
    : "Aucun événement à venir";

  const eventHtml = todayEvents.length
    ? todayEvents.map((ev) =>
        '<div class="dash-event"><span class="time">' + (ev.all_day ? "Journée" : eventTime(ev)) + '</span>' +
        '<span class="title">' + esc(ev.title) + '</span></div>'
      ).join("")
    : "";
  const courseHtml = ttToday.length
    ? ttToday.map((a) =>
        '<div class="dash-event"><span class="time">' + fmtTTime(a.start_time) + '</span>' +
        '<span class="title">🏫 ' + esc(a.title) + '</span></div>'
      ).join("")
    : "";
  $("#dash-today-list").innerHTML = (eventHtml + courseHtml) ||
    "<p class='empty'>Rien de prévu aujourd'hui 🎉</p>";

  $("#dash-todos-list").innerHTML = pendingTodos.length
    ? '<ul class="dash-todo">' + pendingTodos.slice(0, 5).map((t) => '<li>' + esc(t.title) + '</li>').join("") + '</ul>'
    : '<p class="empty">Toutes les tâches sont terminées ✅</p>';

  renderWeatherDashboard();
  renderDashboardProjects();
  renderYtDashChannel();
  loadNews(false);
}

function renderYtDashChannel() {
  const card = $("#dash-yt-mini");
  const body = $("#dash-yt-mini-body");
  if (!card || !body) return;
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(LS_YT_DASH_CHANNEL) || "null"); } catch (e) {}
  if (!cached || (!cached.name && !cached.subs)) { card.classList.add("hidden"); return; }
  const subs = Number(cached.subs) || 0;
  body.innerHTML =
    "<div class='dash-yt-mini-main'>" +
      (cached.avatar ? "<img class='dash-yt-mini-pp' src='" + esc(cached.avatar) + "' alt='' loading='lazy' referrerpolicy='no-referrer'>" : "<div class='dash-yt-mini-pp dash-yt-mini-pp-empty'>▶️</div>") +
      "<div class='dash-yt-mini-info'>" +
        "<div class='dash-yt-mini-name' title='" + esc(cached.name || "") + "'>" + esc(cached.name || "Ma chaîne") + "</div>" +
        "<div class='dash-yt-mini-sub'><strong>" + esc(subs.toLocaleString("fr-FR")) + "</strong><span> abonnés</span></div>" +
      "</div>" +
    "</div>";
  card.classList.remove("hidden");
}

function updateClock() {
  const now = new Date();
  $("#dash-clock").textContent = now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/* ===================== Agenda (événements datés) ===================== */
const cal = { view: "month", cursor: new Date() };
let modalEventId = null;

function setCalView(view) { cal.view = view; renderSchedule(); }

function calPrev() {
  if (cal.view === "week") cal.cursor = addDays(cal.cursor, -7);
  else if (cal.view === "month") cal.cursor = addMonths(cal.cursor, -1);
  else cal.cursor = addYears(cal.cursor, -1);
  renderSchedule();
}
function calNext() {
  if (cal.view === "week") cal.cursor = addDays(cal.cursor, 7);
  else if (cal.view === "month") cal.cursor = addMonths(cal.cursor, 1);
  else cal.cursor = addYears(cal.cursor, 1);
  renderSchedule();
}
function calToday() { cal.cursor = new Date(); renderSchedule(); }

function calLabel() {
  const d = cal.cursor;
  if (cal.view === "week") {
    const s = startOfWeek(d), e = addDays(s, 6);
    return s.getDate() + " " + MONTHS[s.getMonth()] + " – " + e.getDate() + " " + MONTHS[e.getMonth()] + " " + e.getFullYear();
  }
  if (cal.view === "month") return MONTHS[d.getMonth()] + " " + d.getFullYear();
  return String(d.getFullYear());
}

function renderSchedule() {
  $("#cal-label").textContent = calLabel();
  $$(".cal-view-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === cal.view));
  const c = $("#calendar");
  if (cal.view === "month") renderMonth(c);
  else if (cal.view === "week") renderWeek(c);
  else renderYear(c);
}

function sortEvents(list) {
  return list.slice().sort((a, b) => (a.start_at < b.start_at ? -1 : 1));
}

function eventItem(ev) {
  return '<button class="event-item" data-id="' + ev.id + '">' +
    '<span class="dot"></span><span>' + esc(ev.title) + '</span>' +
    (ev.all_day ? "" : '<time>' + eventTime(ev) + '</time>') +
    '</button>';
}

function renderMonth(c) {
  const first = startOfMonth(cal.cursor);
  let d = startOfWeek(first);
  const today = dayKey(new Date());
  const vis = visibleEvents();
  let html = '<div class="cal-grid">' +
    DAYS_SHORT.map((x) => '<div class="cal-dow">' + x + '</div>').join("");

  for (let i = 0; i < 42; i++) {
    const key = dayKey(d);
    const inMonth = d.getMonth() === cal.cursor.getMonth();
    const dayEvents = sortEvents(vis.filter((e) => eventDayKey(e) === key));
    const chips = dayEvents.slice(0, 3).map((ev) =>
      '<span class="chip' + (ev.all_day ? ' allday' : '') + '">' + esc(ev.title) + '</span>').join("");
    const more = dayEvents.length > 3 ? '<span class="more">+' + (dayEvents.length - 3) + '</span>' : "";
    html += '<div class="cal-cell' + (inMonth ? "" : " out") + (key === today ? " today" : "") + '" data-key="' + key + '">' +
      '<div class="cell-head"><span class="dnum">' + d.getDate() + '</span>' +
      '<button class="cell-add" data-key="' + key + '" title="Ajouter">＋</button></div>' +
      '<div class="cell-body">' + chips + more + '</div></div>';
    d = addDays(d, 1);
  }
  html += '</div>';
  c.innerHTML = html;
}

function renderWeek(c) {
  const start = startOfWeek(cal.cursor);
  const today = dayKey(new Date());
  const vis = visibleEvents();
  let html = '<div class="cal-week">';
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    const key = dayKey(d);
    const dayEvents = sortEvents(vis.filter((e) => eventDayKey(e) === key));
    html += '<div class="week-day' + (key === today ? " today" : "") + '" data-key="' + key + '">' +
      '<div class="week-head"><span class="wdow">' + DAYS_SHORT[i] + '</span>' +
      '<span class="wdnum">' + d.getDate() + '</span></div>' +
      '<div class="week-events">' + (dayEvents.map(eventItem).join("") || '<span class="empty">—</span>') + '</div>' +
      '</div>';
  }
  html += '</div>';
  c.innerHTML = html;
}

function renderYear(c) {
  const year = cal.cursor.getFullYear();
  const vis = visibleEvents();
  let html = '<div class="year-grid">';
  for (let m = 0; m < 12; m++) {
    const first = new Date(year, m, 1);
    const count = vis.filter((e) => {
      const dt = new Date(e.start_at);
      return dt.getFullYear() === year && dt.getMonth() === m;
    }).length;
    html += '<div class="year-month" data-month="' + m + '">' +
      '<div class="ym-head">' + MONTHS[m] + '</div>' +
      '<div class="ym-grid">' + DAYS_SHORT.map((x) => '<span class="ym-dow">' + x[0] + '</span>').join("") + renderYearDays(first, vis) + '</div>' +
      '<div class="ym-count">' + count + ' événement(s)</div></div>';
  }
  html += '</div>';
  c.innerHTML = html;
}

function renderYearDays(first, vis) {
  const keys = new Set(vis.map(eventDayKey));
  let d = startOfWeek(first);
  let html = "";
  for (let i = 0; i < 42; i++) {
    const inMonth = d.getMonth() === first.getMonth();
    const has = keys.has(dayKey(d));
    html += '<span class="ym-cell' + (inMonth ? "" : " out") + (has ? " has" : "") + '">' + d.getDate() + '</span>';
    d = addDays(d, 1);
  }
  return html;
}

/* ===================== Modale événement (Agenda) ===================== */
function openModal() { $("#modal").classList.add("open"); }
function closeModal() { $("#modal").classList.remove("open"); modalEventId = null; }

function toTimeInput(d) { return pad(d.getHours()) + ":" + pad(d.getMinutes()); }

function openEventModal(ev, dateKey) {
  modalEventId = ev ? ev.id : null;
  $("#modal-title").textContent = ev ? "Modifier l'événement" : "Nouvel événement";
  $("#modal-delete").style.display = ev ? "" : "none";
  const d = ev ? new Date(ev.start_at) : (dateKey ? parseDay(dateKey) : new Date());
  $("#ev-title").value = ev ? ev.title : "";
  $("#ev-date").value = dayKey(d);
  $("#ev-start").value = (ev && !ev.all_day) ? toTimeInput(new Date(ev.start_at)) : "09:00";
  $("#ev-end").value = (ev && !ev.all_day && ev.end_at) ? toTimeInput(new Date(ev.end_at)) : "10:00";
  $("#ev-allday").checked = ev ? !!ev.all_day : false;
  toggleAllDay();
  openModal();
  setTimeout(() => $("#ev-title").focus(), 60);
}

function toggleAllDay() {
  const allDay = $("#ev-allday").checked;
  $("#ev-times").style.display = allDay ? "none" : "flex";
}

async function submitEvent() {
  const title = $("#ev-title").value.trim();
  if (!title) { $("#ev-title").focus(); return; }
  const dateStr = $("#ev-date").value;
  const allDay = $("#ev-allday").checked;
  let start_at, end_at = null;
  if (allDay) {
    start_at = new Date(dateStr + "T00:00:00").toISOString();
  } else {
    start_at = new Date(dateStr + "T" + $("#ev-start").value).toISOString();
    end_at = new Date(dateStr + "T" + $("#ev-end").value).toISOString();
  }
  try {
    await API.saveEvent({ id: modalEventId, title, start_at, end_at, all_day: allDay });
    await API.loadEvents();
    closeModal();
    renderSchedule();
    renderDashboard();
  } catch (err) {
    alert(err.message || "Erreur lors de l'enregistrement.");
  }
}

async function deleteEventFromModal() {
  if (!modalEventId) return;
  try {
    await API.deleteEvent(modalEventId);
    await API.loadEvents();
    closeModal();
    renderSchedule();
    renderDashboard();
  } catch (err) {
    alert(err.message || "Erreur lors de la suppression.");
  }
}

/* ===================== Emploi du temps (hebdomadaire) ===================== */
const TT_START = 7;    // 07:00
const TT_END = 22;     // 22:00
const TT_SLOT = 60;    // découpage fixé à 1 h (les 30 min sont retirés)
const TT_ROW_H = 44;   // hauteur (px) d'un créneau de 1 h
const TT_MAX_PER_CELL = 3;

let ttEditMode = false;
let ttModalMode = null;       // "add" | "edit" | "view"
let ttModalActivityId = null;
let ttPendingDay = 0;
let ttPendingStart = "08:00";
let ttLanePref = {};          // preference de couloir (session, mode edition)
let ttPendingCol = -1;        // couloir choisi a l'ajout

function ttSlotMin() { return TT_SLOT; }
function ttRowH() { return TT_ROW_H; }
function ttNumSlots() { return Math.round(((TT_END - TT_START) * 60) / ttSlotMin()); }
function ttSlotOf(mins) {
  return Math.max(0, Math.min(ttNumSlots() - 1, Math.floor((mins - TT_START * 60) / ttSlotMin())));
}
function ttMinsToTime(mins) { return pad(Math.floor(mins / 60)) + ":" + pad(mins % 60); }
function activityColorIndex(a) {
  let h = 0;
  const s = String(a.id || a.title || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (h % 6) + 1;
}

function renderTimetable() {
  const grid = $("#tt-grid");
  const emptyEl = $("#tt-empty");
  const editBtn = $("#tt-edit");
  const exportBtn = $("#tt-export");
  const excelBtn = $("#tt-export-excel");
  const pdfBtn = $("#tt-export-pdf");
  const banner = $("#tt-banner");

  if (ttSettings === null && ttActivities.length === 0 && !ttEditMode) {
    grid.classList.add("hidden");
    emptyEl.classList.remove("hidden");
    editBtn.hidden = true;
    exportBtn.hidden = true;
    if (excelBtn) excelBtn.hidden = true;
    if (pdfBtn) pdfBtn.hidden = true;
    banner.classList.add("hidden");
    return;
  }

  grid.classList.remove("hidden");
  emptyEl.classList.add("hidden");
  editBtn.hidden = false;
  editBtn.textContent = ttEditMode ? "Terminer" : "Modifier";
  exportBtn.hidden = ttEditMode;
  if (excelBtn) excelBtn.hidden = ttEditMode;
  if (pdfBtn) pdfBtn.hidden = ttEditMode;
  banner.classList.toggle("hidden", !ttEditMode);
  grid.classList.toggle("editing", ttEditMode);
  renderTTHead();
  renderTTBoard();
}

function renderTTHead() {
  const today = ttDayIndex();
  let html = '<div class="tt-corner"></div>';
  for (let d = 0; d < 7; d++) {
    html += '<div class="tt-day' + (d === today ? " today" : "") + '">' + DAYS_SHORT[d] + "</div>";
  }
  $("#tt-head").innerHTML = html;
}

/* Placement des activités d'une journée : colonnes dynamiques, 3 max par créneau */
function layoutDay(dayIndex, extraAct, exceptId) {
  const cancelled = ttCancelledIds();
  const acts = ttActivities
    .filter((a) => a.day_of_week === dayIndex && a.id !== exceptId)
    .slice();
  if (extraAct) acts.push(extraAct);
  acts.sort((a, b) => ttMinutes(a.start_time) - ttMinutes(b.start_time));

  const slotMin = ttSlotMin();
  const placed = [];
  const res = [];
  let overflow = false;
  for (const a of acts) {
    const s = ttSlotOf(ttMinutes(a.start_time));
    const e = Math.max(s + 1, Math.ceil((ttMinutes(a.end_time) - TT_START * 60) / slotMin));
    let col = -1;
    for (let c = 0; c < TT_MAX_PER_CELL; c++) {
      if (!placed.some((p) => p.col === c && p.s < e && s < p.e)) { col = c; break; }
    }
    if (col === -1) { overflow = true; col = TT_MAX_PER_CELL - 1; }
    placed.push({ s, e, col });
    res.push({ act: a, s, e, col, cancelled: cancelled.has(a.id) });
  }
  for (const L of res) {
    const m = Math.max(1, new Set(placed.filter((p) => p.s < L.e && L.s < p.e).map((p) => p.col)).size);
    L.cf = L.col / m;
    L.wf = 1 / m;
    L.dur = Math.max(1, L.e - L.s);
  }
  return { items: res, overflow };
}

/* Mode edition : 3 couloirs fixes (1/3 de largeur), toujours cliquables */
function layoutDayEdit(dayIndex, extraAct, exceptId, prefCol) {
  const cancelled = ttCancelledIds();
  const acts = ttActivities
    .filter((a) => a.day_of_week === dayIndex && a.id !== exceptId)
    .slice();
  if (extraAct) acts.push(extraAct);
  acts.sort((a, b) => ttMinutes(a.start_time) - ttMinutes(b.start_time));

  const slotMin = ttSlotMin();
  const placed = [];
  const res = [];
  let overflow = false;
  for (const a of acts) {
    const s = ttSlotOf(ttMinutes(a.start_time));
    const e = Math.max(s + 1, Math.ceil((ttMinutes(a.end_time) - TT_START * 60) / slotMin));
    const want = (a === extraAct && prefCol != null && prefCol >= 0 && prefCol < TT_MAX_PER_CELL)
      ? prefCol
      : (ttLanePref[a.id] != null ? ttLanePref[a.id] : -1);
    let col = -1;
    if (want >= 0 && !placed.some((p) => p.col === want && p.s < e && s < p.e)) col = want;
    if (col === -1) {
      for (let c = 0; c < TT_MAX_PER_CELL; c++) {
        if (!placed.some((p) => p.col === c && p.s < e && s < p.e)) { col = c; break; }
      }
    }
    if (col === -1) { overflow = true; col = TT_MAX_PER_CELL - 1; }
    placed.push({ s, e, col });
    res.push({ act: a, s, e, col, cancelled: cancelled.has(a.id),
      cf: col / TT_MAX_PER_CELL, wf: 1 / TT_MAX_PER_CELL, dur: Math.max(1, e - s) });
  }
  return { items: res, overflow };
}

function layoutForMode(dayIndex, extraAct, exceptId, prefCol) {
  return ttEditMode
    ? layoutDayEdit(dayIndex, extraAct, exceptId, prefCol)
    : layoutDay(dayIndex, extraAct, exceptId);
}

function ttSubslotsHtml(dayIndex, slotIndex) {
  let h = "";
  for (let c = 0; c < TT_MAX_PER_CELL; c++) {
    h += '<div class="tt-subslot" data-day="' + dayIndex + '" data-slot="' + slotIndex + '" data-col="' + c + '"></div>';
  }
  return h;
}

function renderTTBoard() {
  const slotMin = ttSlotMin();
  const rowH = ttRowH();
  const n = ttNumSlots();
  const today = ttDayIndex();

  const board = $("#tt-board");
  board.style.setProperty("--n", n);
  board.style.setProperty("--rowh", rowH + "px");
  board.style.height = n * rowH + "px";

  let html = "";
  for (let i = 0; i < n; i++) {
    html += '<div class="tt-hour-label" style="grid-row:' + (i + 1) + ';grid-column:1">' +
      ttMinsToTime(TT_START * 60 + i * slotMin) + '</div>';
  }
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < 7; d++) {
      html += '<div class="tt-cell' + (d === today ? " today" : "") + '"' +
        ' style="grid-row:' + (i + 1) + ';grid-column:' + (d + 2) + '"' +
        ' data-day="' + d + '" data-slot="' + i + '">' +
        (ttEditMode ? ttSubslotsHtml(d, i) : "") +
        '</div>';
    }
  }
  for (let d = 0; d < 7; d++) {
    const laid = layoutForMode(d);
    for (const L of laid.items) {
      const a = L.act;
      // Position en % par rapport au nombre total de créneaux : s'aligne sur la grille.
      const topPct = (L.s / n) * 100;
      const hgtPct = (L.dur / n) * 100;
      html += '<button class="tt-activity c' + activityColorIndex(a) + (L.cancelled ? " cancelled" : "") + (ttEditMode || L.wf < 0.45 ? " crowded" : "") + '"' +
        ' style="top:' + topPct + '%;height:calc(' + hgtPct + '% - 2px);' +
        '--d:' + d + ';--cf:' + L.cf + ';--wf:' + L.wf + '"' +
        ' data-id="' + a.id + '">' +
        '<span class="tt-act-time">' + fmtTTime(a.start_time) + '</span>' +
        '<span class="tt-act-title">' + esc(a.title) + '</span>' +
        '</button>';
    }
  }
  board.innerHTML = html;
}

function openTTAdd(dayIndex, slotIndex, col) {
  ttPendingDay = (dayIndex == null) ? ttDayIndex() : dayIndex;
  ttPendingCol = (col == null || col < 0 || col >= TT_MAX_PER_CELL) ? -1 : col;
  const slotMin = ttSlotMin();
  const startMins = (slotIndex == null) ? TT_START * 60 + 60 : TT_START * 60 + slotIndex * slotMin;
  ttPendingStart = ttMinsToTime(startMins);
  openTTActivity(null, "add");
}

function openTTActivity(activityId, mode) {
  ttModalMode = mode;
  ttModalActivityId = activityId || null;
  renderTTModal();
  $("#modal-tt").classList.add("open");
}

function closeTTModal() {
  $("#modal-tt").classList.remove("open");
  ttModalMode = null;
  ttModalActivityId = null;
  ttPendingCol = -1;
}

function renderTTModal() {
  const a = ttActivities.find((x) => x.id === ttModalActivityId) || null;
  const titleEl = $("#ttm-title");
  const body = $("#ttm-body");
  const footer = $("#ttm-footer");

  if (ttModalMode === "view" && a) {
    const cancelled = ttCancelledIds().has(a.id);
    titleEl.textContent = a.title;
    body.innerHTML =
      '<p class="tt-view-meta"><span>' + DAYS_FULL[a.day_of_week] + ' · ' + fmtTTime(a.start_time) + ' – ' + fmtTTime(a.end_time) + '</span>' +
      (cancelled ? '<span class="tt-view-badge">Annulée cette semaine</span>' : '') + '</p>' +
      '<div class="tt-view-desc">' +
        (a.description ? '<p>' + esc(a.description) + '</p>' : '<p class="tt-desc-empty">Aucune description.</p>') +
      '</div>';
    footer.innerHTML =
      '<span class="spacer"></span>' +
      '<button class="btn-danger" data-act="cancel">' + (cancelled ? 'Réactiver' : 'Annuler') + '</button>';
    return;
  }

  const isEdit = ttModalMode === "edit" && a;
  titleEl.textContent = isEdit ? "Modifier l'activité" : "Nouvelle activité";
  const daySel = isEdit ? a.day_of_week : ttPendingDay;
  const startVal = isEdit ? fmtTTime(a.start_time) : ttPendingStart;
  const endVal = isEdit ? fmtTTime(a.end_time) : ttMinsToTime(ttMinutes(startVal) + ttSlotMin());
  body.innerHTML =
    '<label class="field"><span>Titre court</span><input id="tta-title" type="text" placeholder="Ex : Maths" value="' + esc(isEdit ? a.title : "") + '"></label>' +
    '<label class="field"><span>Description</span><textarea id="tta-desc" rows="3" placeholder="Détails, salle, professeur…">' + esc(isEdit ? (a.description || "") : "") + '</textarea></label>' +
    '<label class="field"><span>Jour</span><select id="tta-day">' +
      DAYS_FULL.map((d, i) => '<option value="' + i + '"' + (daySel === i ? ' selected' : '') + '>' + d + '</option>').join("") +
    '</select></label>' +
    '<div class="row">' +
      '<label class="field"><span>Début</span><input id="tta-start" type="time" value="' + startVal + '"></label>' +
      '<label class="field"><span>Fin</span><input id="tta-end" type="time" value="' + endVal + '"></label>' +
    '</div>';
  footer.innerHTML =
    (isEdit ? '<button class="btn-danger" data-act="del">Supprimer</button>' : '') +
    '<span class="spacer"></span>' +
    '<button class="btn-ghost" data-act="close">Annuler</button>' +
    '<button class="btn-primary" data-act="save">Enregistrer</button>';
  if (!isEdit) setTimeout(() => $("#tta-title").focus(), 60);
}

async function saveTTActivityFromModal() {
  const title = $("#tta-title").value.trim();
  if (!title) { $("#tta-title").focus(); return; }
  const start = $("#tta-start").value;
  const end = $("#tta-end").value;
  if (!start || !end) { alert("Indique une heure de début et de fin."); return; }
  if (ttMinutes(end) <= ttMinutes(start)) { alert("L'heure de fin doit être après l'heure de début."); return; }
  const candidate = {
    id: ttModalActivityId,
    title,
    description: $("#tta-desc").value.trim(),
    day_of_week: Number($("#tta-day").value),
    start_time: start,
    end_time: end,
  };
  const { overflow } = layoutForMode(candidate.day_of_week, candidate, ttModalActivityId, ttPendingCol);
  if (overflow) {
    alert("Cette case est pleine : 3 activités maximum par créneau.");
    return;
  }
  try {
    const saved = await API.saveTimetableActivity(candidate);
    await API.loadTimetable();
    if (saved && saved.id && ttPendingCol >= 0) ttLanePref[saved.id] = ttPendingCol;
    ttPendingCol = -1;
    closeTTModal();
    renderTimetable();
    renderDashboard();
  } catch (err) {
    alert(err.message || "Erreur lors de l'enregistrement.");
  }
}

/* ===================== To-Do ===================== */
let todoFilter = "all";

const PRIO_LABEL = { high: "Haute", medium: "Moyenne", low: "Basse" };
const PRIO_ORDER = ["low", "medium", "high"];
const PRIO_RANK = { high: 0, medium: 1, low: 2 };

function sortTodos(list) {
  return list.slice().sort((a, b) => {
    if ((a.done ? 1 : 0) !== (b.done ? 1 : 0)) return a.done ? 1 : -1;
    const ra = PRIO_RANK[a.priority] ?? 1;
    const rb = PRIO_RANK[b.priority] ?? 1;
    if (ra !== rb) return ra - rb;
    return String(b.created_at || "").localeCompare(String(a.created_at || ""));
  });
}

function renderTodos() {
  const filtered = todos.filter((t) =>
    todoFilter === "all" ? true : (todoFilter === "done" ? t.done : !t.done)
  );
  const list = sortTodos(filtered);
  $("#todo-list").innerHTML = list.length
    ? list.map(todoItem).join("")
    : '<p class="empty">' + (todoFilter === "done" ? "Aucune tâche terminée" : todoFilter === "active" ? "Aucune tâche en cours 🎉" : "Aucune tâche") + '</p>';

  const done = todos.filter((t) => t.done).length;
  const pct = todos.length ? Math.round((done / todos.length) * 100) : 0;
  $("#todo-progress-fill").style.width = pct + "%";
  $("#todo-progress-label").textContent = done + " / " + todos.length;
}

function todoDueText(t) {
  if (!t.due_date) return "";
  const due = parseDay(String(t.due_date).slice(0, 10));
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((due - today) / 86400000);
  if (days < 0) return '<span class="todo-due overdue">En retard de ' + (-days) + ' jour' + (-days > 1 ? "s" : "") + '</span>';
  if (days === 0) return '<span class="todo-due due-today">Dernier jour !</span>';
  return '<span class="todo-due">Il reste ' + days + ' jour' + (days > 1 ? "s" : "") + '</span>';
}

function todoItem(t) {
  const prio = t.priority || "medium";
  return '<li class="todo todo-p-' + prio + (t.done ? " done" : "") + '" data-id="' + t.id + '">' +
    '<button class="todo-check" data-act="toggle" title="Terminer">' + (t.done ? "✓" : "") + '</button>' +
    '<span class="todo-title">' + esc(t.title) + '</span>' +
    '<span class="prio prio-' + prio + '">' + PRIO_LABEL[prio] + '</span>' +
    todoDueText(t) +
    '<button class="todo-edit" data-act="edit" title="Modifier">✏️</button>' +
    '<button class="todo-del" data-act="del" title="Supprimer">🗑</button>' +
    '</li>';
}

/* ---------- Modale d'édition d'une tâche ---------- */
let todoModalId = null;

function openTodoModal(t) {
  todoModalId = t ? t.id : null;
  $("#todom-title").textContent = t ? "Modifier la tâche" : "Nouvelle tâche";
  $("#todox-title").value = t ? t.title : "";
  $("#todox-priority").value = t ? (t.priority || "medium") : "medium";
  $("#todox-due").value = t && t.due_date ? String(t.due_date).slice(0, 10) : "";
  $("#todox-done").checked = t ? !!t.done : false;
  $("#todom-del").style.display = t ? "" : "none";
  $("#modal-todo").classList.add("open");
  setTimeout(() => $("#todox-title").focus(), 60);
}

function closeTodoModal() {
  $("#modal-todo").classList.remove("open");
  todoModalId = null;
}

async function saveTodoFromModal() {
  const title = $("#todox-title").value.trim();
  if (!title) { $("#todox-title").focus(); return; }
  try {
    await API.saveTodo({
      id: todoModalId,
      title,
      done: $("#todox-done").checked,
      priority: $("#todox-priority").value,
      due_date: $("#todox-due").value || null,
    });
    await API.loadTodos();
    closeTodoModal();
    renderTodos();
    renderDashboard();
  } catch (err) {
    alert(err.message || "Erreur lors de l'enregistrement.");
  }
}

async function deleteTodoFromModal() {
  if (!todoModalId) return;
  try {
    await API.deleteTodo(todoModalId);
    await API.loadTodos();
    closeTodoModal();
    renderTodos();
    renderDashboard();
  } catch (err) {
    alert(err.message || "Erreur lors de la suppression.");
  }
}

async function addTodo() {
  const input = $("#todo-input");
  const title = input.value.trim();
  if (!title) return;
  const priority = $("#todo-priority").value;
  const dueDate = $("#todo-due").value || null;
  try {
    await API.saveTodo({ id: null, title, done: false, priority, due_date: dueDate });
    await API.loadTodos();
    input.value = "";
    renderTodos();
    renderDashboard();
  } catch (err) {
    alert(err.message || "Erreur lors de l'ajout.");
  }
}

async function handleTodoListClick(e) {
  const li = e.target.closest(".todo");
  if (!li) return;
  const id = li.dataset.id;
  const act = (e.target.closest("[data-act]") || {}).dataset?.act;
  const t = todos.find((x) => x.id === id);
  if (!t) return;
  try {
    if (act === "toggle") {
      await API.saveTodo({ ...t, done: !t.done });
    } else if (act === "del") {
      await API.deleteTodo(id);
    } else if (act === "edit") {
      openTodoModal(t);
      return;
    } else {
      return;
    }
    await API.loadTodos();
    renderTodos();
    renderDashboard();
  } catch (err) {
    alert(err.message || "Erreur.");
  }
}


/* ===================== Météo ===================== */
const WEATHER_CODES = {
  0: ["☀️", "Ensoleillé"], 1: ["🌤", "Peu nuageux"], 2: ["⛅", "Partiellement nuageux"],
  3: ["☁️", "Nuageux"], 45: ["🌫", "Brouillard"], 48: ["🌫", "Brouillard givrant"],
  51: ["🌦", "Bruine légère"], 53: ["🌦", "Bruine"], 55: ["🌧", "Bruine dense"],
  61: ["🌧", "Pluie légère"], 63: ["🌧", "Pluie"], 65: ["🌧", "Pluie forte"],
  71: ["🌨", "Neige légère"], 73: ["🌨", "Neige"], 75: ["❄️", "Neige forte"],
  77: ["🌨", "Grains de neige"], 80: ["🌦", "Averses légères"], 81: ["🌧", "Averses"],
  82: ["⛈", "Averses violentes"], 85: ["🌨", "Averses de neige légères"], 86: ["❄️", "Averses de neige"],
  95: ["⛈", "Orage"], 96: ["⛈", "Orage avec grêle"], 99: ["⛈", "Orage violent avec grêle"]
};
function weatherEmoji(code) { const w = WEATHER_CODES[code]; return w ? w[0] : "🌤"; }
function weatherLabel(code) { const w = WEATHER_CODES[code]; return w ? w[1] : "Inconnu"; }
function uvLabel(value) {
  if (value == null || Number.isNaN(Number(value))) return "Indisponible";
  if (value < 3) return "Faible";
  if (value < 6) return "Modéré";
  if (value < 8) return "Élevé";
  if (value < 11) return "Très élevé";
  return "Extrême";
}
function windDirection(deg) {
  if (deg == null || Number.isNaN(Number(deg))) return "";
  const dirs = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
  return dirs[Math.round(Number(deg) / 45) % 8];
}
function monthKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1); }
function monthLabel(key) {
  const p = key.split("-").map(Number);
  return new Date(p[0], p[1] - 1, 1).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
}
function previousDayKey(d) { return dayKey(addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -1)); }

function loadWeatherCache() {
  weatherCache = lsGet(LS_WEATHER + "_" + session.userId, null);
  weatherCity = lsGet(LS_WEATHER_CITY + "_" + session.userId, null);
}
function saveWeatherCache(data) {
  if (!session) return;
  weatherCache = { ...data, fetchedAt: Date.now() };
  lsSet(LS_WEATHER + "_" + session.userId, weatherCache);
  lsSet(LS_WEATHER_CITY + "_" + session.userId, weatherCity);
}
function weatherCacheValid() {
  return weatherCache && weatherCache.fetchedAt && (Date.now() - weatherCache.fetchedAt < 1800000);
}

async function fetchWeather(force) {
  if (!force && weatherCacheValid()) return;
  let lat, lon, cityLabel;
  if (weatherCity) {
    try {
      const geoRes = await fetch("https://geocoding-api.open-meteo.com/v1/search?name=" + encodeURIComponent(weatherCity) + "&count=1&language=fr");
      const geoData = await geoRes.json();
      if (!geoData.results || !geoData.results.length) return;
      const g = geoData.results[0];
      lat = g.latitude;
      lon = g.longitude;
      const parts = [g.name];
      if (g.admin2) parts.push(g.admin2);
      if (g.postcodes && g.postcodes.length) parts.push(g.postcodes[0]);
      if (g.country) parts.push(g.country);
      cityLabel = parts.join(", ");
    } catch (e) { return; }
  } else {
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 });
      });
      lat = pos.coords.latitude;
      lon = pos.coords.longitude;
    } catch (e) { return; }
  }

  const today = new Date();
  const monthStart = dayKey(new Date(today.getFullYear(), today.getMonth(), 1));
  const archiveEnd = previousDayKey(today);
  const key = monthKey(today);
  const forecastUrl = "https://api.open-meteo.com/v1/forecast?latitude=" + lat.toFixed(4) + "&longitude=" + lon.toFixed(4) +
    "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,uv_index" +
    "&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m,uv_index" +
    "&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,uv_index_max,wind_speed_10m_max,wind_direction_10m_dominant" +
    "&timezone=auto&forecast_days=9&forecast_hours=24";
  const archiveUrl = archiveEnd >= monthStart
    ? "https://archive-api.open-meteo.com/v1/archive?latitude=" + lat.toFixed(4) + "&longitude=" + lon.toFixed(4) +
      "&start_date=" + monthStart + "&end_date=" + archiveEnd +
      "&daily=temperature_2m_mean,temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code&timezone=auto"
    : null;
  const airUrl = "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=" + lat.toFixed(4) + "&longitude=" + lon.toFixed(4) +
    "&hourly=pm10,pm2_5,us_aqi&timezone=auto&forecast_hours=24";

  const [forecastResult, archiveResult, airResult] = await Promise.allSettled([
    fetch(forecastUrl).then((r) => r.json()),
    archiveUrl ? fetch(archiveUrl).then((r) => r.json()) : Promise.resolve(null),
    fetch(airUrl).then((r) => r.json()),
  ]);
  if (forecastResult.status !== "fulfilled") return;
  const forecast = forecastResult.value;
  const archive = archiveResult.status === "fulfilled" ? archiveResult.value : null;
  const air = airResult.status === "fulfilled" ? airResult.value : null;
  const old = weatherCache || {};
  const airHourly = air && air.hourly;
  const airData = airHourly ? {
    time: airHourly.time && airHourly.time[0],
    pm10: airHourly.pm10 && airHourly.pm10[0],
    pm2_5: airHourly.pm2_5 && airHourly.pm2_5[0],
    us_aqi: airHourly.us_aqi && airHourly.us_aqi[0],
  } : null;
  saveWeatherCache({
    lat, lon, city: cityLabel || old.city || (lat.toFixed(2) + ", " + lon.toFixed(2)),
    current: forecast.current,
    daily: forecast.daily,
    hourly: forecast.hourly,
    monthly: archive && archive.daily ? { key, daily: archive.daily } : (old.monthly && old.monthly.key === key ? old.monthly : null),
    air: airData || old.air || null,
  });
  renderWeatherDashboard();
  if ($("#page-weather") && !$("#page-weather").classList.contains("hidden")) renderWeatherPage();
}

function renderWeatherDashboard() {
  const el = $("#weather-now");
  if (!el) return;
  if (!weatherCache || !weatherCache.current) {
    el.innerHTML = '<span class="weather-loading">Autorise la localisation ou recherche une ville dans l\'onglet Météo 🌦</span>';
    return;
  }
  const c = weatherCache.current;
  el.innerHTML = '<div class="weather-main"><span class="weather-emoji">' + weatherEmoji(c.weather_code) + '</span>' +
    '<span class="weather-temp">' + Math.round(c.temperature_2m) + '°C</span></div>' +
    '<div class="weather-info"><span>' + weatherLabel(c.weather_code) + '</span>' +
    '<span class="weather-city">' + esc(weatherCache.city || "") + '</span></div>';
}

function monthlyStats() {
  const m = weatherCache && weatherCache.monthly;
  if (!m || !m.daily || !m.daily.time || !m.daily.time.length) return null;
  const d = m.daily;
  const means = (d.temperature_2m_mean || []).filter((v) => v != null);
  const mins = (d.temperature_2m_min || []).filter((v) => v != null);
  const maxs = (d.temperature_2m_max || []).filter((v) => v != null);
  const rain = (d.precipitation_sum || []).filter((v) => v != null);
  const mean = means.length ? means.reduce((a, b) => a + Number(b), 0) / means.length : null;
  return {
    days: d.time.length,
    mean,
    minMean: mins.length ? mins.reduce((a, b) => a + Number(b), 0) / mins.length : null,
    maxMean: maxs.length ? maxs.reduce((a, b) => a + Number(b), 0) / maxs.length : null,
    rain: rain.reduce((a, b) => a + Number(b), 0),
    rainyDays: rain.filter((v) => Number(v) >= 0.1).length,
    daily: d,
    key: m.key,
  };
}
function weatherNumber(value, unit) { return value == null ? "—" : Number(value).toFixed(unit === "°" ? 1 : 1) + unit; }
function renderMonthlyWeather() {
  const statsEl = $("#weather-monthly-stats");
  const periodEl = $("#weather-monthly-period");
  const chartEl = $("#weather-monthly-chart");
  if (!statsEl || !periodEl || !chartEl) return;
  const stats = monthlyStats();
  if (!stats) {
    periodEl.textContent = "Données historiques indisponibles pour le moment.";
    statsEl.innerHTML = "";
    chartEl.innerHTML = '<p class="weather-empty">Les statistiques apparaîtront après récupération des données du mois.</p>';
    return;
  }
  periodEl.textContent = "Jours disponibles : " + stats.days + " · " + monthLabel(stats.key);
  statsEl.innerHTML =
    '<div class="weather-stat"><strong>' + weatherNumber(stats.mean, "°") + '</strong><span>Température moyenne</span></div>' +
    '<div class="weather-stat"><strong>' + weatherNumber(stats.minMean, "°") + '</strong><span>Minimale moyenne</span></div>' +
    '<div class="weather-stat"><strong>' + weatherNumber(stats.maxMean, "°") + '</strong><span>Maximale moyenne</span></div>' +
    '<div class="weather-stat"><strong>' + stats.rain.toFixed(1) + ' mm</strong><span>Précipitations · ' + stats.rainyDays + ' jour(s)</span></div>';
  const d = stats.daily;
  const mins = (d.temperature_2m_min || []).filter((v) => v != null).map(Number);
  const maxs = (d.temperature_2m_max || []).filter((v) => v != null).map(Number);
  const floor = Math.floor(Math.min.apply(null, mins.concat(maxs)) - 2);
  const ceiling = Math.ceil(Math.max.apply(null, mins.concat(maxs)) + 2);
  const span = Math.max(1, ceiling - floor);
  chartEl.innerHTML = '<div class="weather-chart-legend"><span><i class="chart-dot high"></i>Maximale</span><span><i class="chart-dot low"></i>Minimale</span></div><div class="weather-chart">' +
    (d.time || []).map(function(t, i) {
      const lo = d.temperature_2m_min[i];
      const hi = d.temperature_2m_max[i];
      if (lo == null || hi == null) return "";
      const lowPos = ((Number(lo) - floor) / span) * 100;
      const highPos = ((Number(hi) - floor) / span) * 100;
      return '<div class="weather-chart-day" title="' + t + ' · ' + Number(lo).toFixed(1) + '° à ' + Number(hi).toFixed(1) + '°">' +
        '<div class="weather-chart-values"><b>' + Math.round(hi) + '°</b><span>' + Math.round(lo) + '°</span></div>' +
        '<div class="weather-chart-track"><i class="weather-chart-range" style="bottom:' + lowPos + '%;height:' + Math.max(4, highPos - lowPos) + '%"></i></div>' +
        '<small>' + new Date(t + "T12:00:00").getDate() + '</small></div>';
    }).join("") + '</div>';
}
function renderHourlyWeather() {
  const el = $("#weather-hourly");
  if (!el) return;
  const h = weatherCache && weatherCache.hourly;
  if (!h || !h.time || !h.time.length) { el.innerHTML = '<p class="weather-empty">Prévisions horaires indisponibles.</p>'; return; }
  el.innerHTML = h.time.slice(0, 24).map(function(t, i) {
    const date = new Date(t);
    const rain = h.precipitation_probability && h.precipitation_probability[i];
    const wind = h.wind_speed_10m && h.wind_speed_10m[i];
    return '<div class="weather-hour"><strong>' + date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) + '</strong>' +
      '<span class="weather-hour-icon">' + weatherEmoji(h.weather_code[i]) + '</span>' +
      '<b>' + Math.round(h.temperature_2m[i]) + '°</b>' +
      '<span>' + (rain == null ? "—" : "💧 " + rain + "%") + '</span>' +
      '<span>' + (wind == null ? "—" : Math.round(wind) + " km/h") + '</span></div>';
  }).join("");
}
function renderOutdoorConditions() {
  const el = $("#weather-conditions");
  if (!el) return;
  const c = weatherCache && weatherCache.current;
  const d = weatherCache && weatherCache.daily;
  if (!c) { el.innerHTML = '<p class="weather-empty">Conditions indisponibles.</p>'; return; }
  const uv = d && d.uv_index_max ? d.uv_index_max[0] : c.uv_index;
  const wind = c.wind_speed_10m;
  const dir = windDirection(c.wind_direction_10m);
  el.innerHTML =
    '<div class="weather-condition"><span>Indice UV maximal</span><strong>' + (uv == null ? "—" : Number(uv).toFixed(1)) + '</strong><small>' + uvLabel(uv) + '</small></div>' +
    '<div class="weather-condition"><span>Vent actuel</span><strong>' + (wind == null ? "—" : Math.round(wind) + ' km/h') + '</strong><small>' + (dir ? 'Direction ' + dir : 'Direction indisponible') + '</small></div>' +
    '<div class="weather-condition"><span>Ressenti</span><strong>' + (c.apparent_temperature == null ? "—" : Math.round(c.apparent_temperature) + '°C') + '</strong><small>Humidité ' + (c.relative_humidity_2m == null ? "—" : c.relative_humidity_2m + '%') + '</small></div>';
}
function airQualityLabel(aqi) {
  if (aqi == null) return "Indisponible";
  if (aqi <= 20) return "Très bonne";
  if (aqi <= 50) return "Bonne";
  if (aqi <= 100) return "Moyenne";
  if (aqi <= 150) return "Dégradée";
  return "Mauvaise";
}
function renderAirQuality() {
  const el = $("#weather-air");
  if (!el) return;
  const a = weatherCache && weatherCache.air;
  if (!a || a.us_aqi == null) { el.innerHTML = '<p class="weather-empty">Qualité de l’air indisponible pour cette localisation.</p>'; return; }
  el.innerHTML = '<div class="air-main"><strong>' + Math.round(a.us_aqi) + '</strong><span>' + airQualityLabel(Number(a.us_aqi)) + '</span></div>' +
    '<div class="air-values"><span>PM2.5 <b>' + (a.pm2_5 == null ? "—" : Number(a.pm2_5).toFixed(1) + ' µg/m³') + '</b></span>' +
    '<span>PM10 <b>' + (a.pm10 == null ? "—" : Number(a.pm10).toFixed(1) + ' µg/m³') + '</b></span>' +
    '<small>Dernière mesure : ' + (a.time ? new Date(a.time).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "—") + '</small></div>';
}
function renderWeatherPage() {
  const locEl = $("#weather-location");
  const weekly = $("#weather-weekly");
  if (!weatherCache || !weatherCache.daily) {
    locEl.textContent = "Aucune donnée météo. Recherche une ville ou active la localisation.";
    weekly.innerHTML = "";
    renderMonthlyWeather(); renderHourlyWeather(); renderOutdoorConditions(); renderAirQuality();
    return;
  }
  locEl.textContent = weatherCache.city || (weatherCache.lat.toFixed(2) + ", " + weatherCache.lon.toFixed(2));
  const d = weatherCache.daily;
  let html = "";
  for (let i = 0; i < Math.min(9, d.time.length); i++) {
    const date = new Date(d.time[i] + "T12:00:00");
    const dayName = i === 0 ? "Aujourd'hui" : (i === 1 ? "Demain" : DAYS_FULL[(date.getDay() + 6) % 7]);
    const code = d.weather_code[i];
    html += '<div class="weather-day"><div class="wd-name">' + dayName + '</div><div class="wd-date">' + fmtDateShort(date) + '</div><div class="wd-emoji">' + weatherEmoji(code) + '</div><div class="wd-label">' + weatherLabel(code) + '</div><div class="wd-temps"><span class="wd-hi">' + Math.round(d.temperature_2m_max[i]) + '°</span><span class="wd-lo">' + Math.round(d.temperature_2m_min[i]) + '°</span></div>' + (d.precipitation_probability_max[i] ? '<div class="wd-rain">💧 ' + d.precipitation_probability_max[i] + '%</div>' : '') + '</div>';
  }
  weekly.innerHTML = html;
  renderMonthlyWeather(); renderHourlyWeather(); renderOutdoorConditions(); renderAirQuality();
}

async function searchWeatherCity() {
  const input = $("#weather-city-search");
  const city = input.value.trim();
  if (!city) return;
  weatherCity = city;
  await fetchWeather(true);
  renderWeatherPage();
  renderWeatherDashboard();
}


/* ===================== Projets ===================== */
let projModalId = null;


function renderProjects() {
  projectDetailId = null;
  $("#proj-list").classList.remove("hidden");
  $("#proj-detail").classList.add("hidden");
  renderProjStats();
  const countEl = $("#proj-count");
  if (countEl) countEl.textContent = projects.length + " projet" + (projects.length > 1 ? "s" : "");
  const list = filteredProjects();
  if (!list.length) {
    $("#proj-list").innerHTML = "<p class='empty'>" + (projects.length ? "Aucun projet ne correspond à ta recherche." : "Aucun projet. Crée ton premier projet !") + "</p>";
    return;
  }
  $("#proj-list").innerHTML = list.map(projCard).join("");
}

const PROJ_STATUS = { todo: "À faire", doing: "En cours", done: "Terminé", paused: "En pause" };
const KANBAN_COLS = [["todo", "À faire"], ["doing", "En cours"], ["done", "Terminé"]];

let projSearch = "";
let projFilterStatus = "all";
let projFilterPrio = "all";
let projSort = "recent";

function projMeta(p) {
  return {
    status: p.status || "todo",
    priority: p.priority || "medium",
    due_date: p.due_date || null,
    color: p.color || ("c" + activityColorIndex(p)),
    tags: Array.isArray(p.tags) ? p.tags : String(p.tags || "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}
function projectTasksOf(p) { return projectTasks.filter((t) => t.project_id === p.id); }
function taskStatus(t) { return t.status || (t.done ? "done" : "todo"); }
function projectPct(p) {
  const tasks = projectTasksOf(p);
  if (!tasks.length) return 0;
  const done = tasks.filter((t) => taskStatus(t) === "done").length;
  return Math.round((done / tasks.length) * 100);
}
function filteredProjects() {
  const q = projSearch.trim().toLowerCase();
  let list = projects.filter((p) => {
    const m = projMeta(p);
    if (q) {
      const hay = (p.name + " " + (p.description || "") + " " + m.tags.join(" ")).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    if (projFilterStatus !== "all" && m.status !== projFilterStatus) return false;
    if (projFilterPrio !== "all" && m.priority !== projFilterPrio) return false;
    return true;
  });
  list.sort((a, b) => {
    const ma = projMeta(a), mb = projMeta(b);
    if (projSort === "name") return a.name.localeCompare(b.name, "fr");
    if (projSort === "due") {
      if (!ma.due_date && !mb.due_date) return 0;
      if (!ma.due_date) return 1;
      if (!mb.due_date) return -1;
      return ma.due_date.localeCompare(mb.due_date);
    }
    if (projSort === "progress") return projectPct(b) - projectPct(a);
    if (projSort === "priority") return (PRIO_RANK[ma.priority] ?? 1) - (PRIO_RANK[mb.priority] ?? 1);
    return String(b.created_at || "").localeCompare(String(a.created_at || ""));
  });
  return list;
}
function renderProjStats() {
  const el = $("#proj-stats");
  if (!el) return;
  const counts = { todo: 0, doing: 0, done: 0, paused: 0 };
  projects.forEach((p) => { counts[projMeta(p).status] = (counts[projMeta(p).status] || 0) + 1; });
  const overdue = projects.filter((p) => projMeta(p).due_date && projMeta(p).due_date < dayKey(new Date()) && projMeta(p).status !== "done").length;
  el.innerHTML =
    "<div class='proj-stat'><strong>" + projects.length + "</strong><span>Projets</span></div>" +
    "<div class='proj-stat'><strong>" + counts.todo + "</strong><span>À faire</span></div>" +
    "<div class='proj-stat'><strong>" + counts.doing + "</strong><span>En cours</span></div>" +
    "<div class='proj-stat'><strong>" + counts.done + "</strong><span>Terminés</span></div>" +
    "<div class='proj-stat'><strong>" + counts.paused + "</strong><span>En pause</span></div>" +
    "<div class='proj-stat'><strong class='" + (overdue ? "overdue" : "") + "'>" + overdue + "</strong><span>En retard</span></div>";
}
function projCard(p) {
  const m = projMeta(p);
  const pct = projectPct(p);
  const overdue = m.due_date && m.due_date < dayKey(new Date()) && m.status !== "done";
  return "<button class='proj-card' data-id='" + p.id + "'>" +
    "<div class='proj-card-top'>" +
      "<span class='proj-color-dot color-" + m.color + "'></span>" +
      "<span class='proj-name'>" + esc(p.name) + "</span>" +
      "<span class='proj-badge st-" + m.status + "'>" + PROJ_STATUS[m.status] + "</span>" +
      "<span class='proj-badge prio-" + m.priority + "'>" + PRIO_LABEL[m.priority] + "</span>" +
    "</div>" +
    (p.description ? "<div class='proj-desc-line'>" + esc(p.description.slice(0, 90)) + (p.description.length > 90 ? "…" : "") + "</div>" : "") +
    (m.tags.length ? "<div class='proj-tags'>" + m.tags.map((t) => "<span class='proj-tag'>" + esc(t) + "</span>").join("") + "</div>" : "") +
    "<div class='proj-bar-wrap'><div class='proj-bar'><div class='proj-bar-fill' style='width:" + pct + "%'></div></div>" +
    "<span class='proj-pct'>" + pct + "%</span></div>" +
    (m.due_date ? "<div class='proj-due" + (overdue ? " overdue" : "") + "'>📅 " + fmtDateShort(parseDay(m.due_date)) + (overdue ? " · en retard" : "") + "</div>" : "") +
    "</button>";
}

function renderProjectDetail(projId) {
  projectDetailId = projId;
  const p = projects.find((x) => x.id === projId);
  if (!p) return renderProjects();
  $("#proj-list").classList.add("hidden");
  const detail = $("#proj-detail");
  detail.classList.remove("hidden");
  const m = projMeta(p);
  const tasks = projectTasksOf(p);
  const pct = projectPct(p);
  const done = tasks.filter((t) => taskStatus(t) === "done").length;
  const overdue = m.due_date && m.due_date < dayKey(new Date()) && m.status !== "done";
  const notes = projectNotes.filter((n) => n.project_id === projId)
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));

  detail.innerHTML =
    "<div class='proj-detail-head'>" +
      "<button class='btn-ghost proj-back' type='button'>← Retour</button>" +
      "<div><h2><span class='proj-color-dot color-" + m.color + "'></span> " + esc(p.name) + "</h2>" +
      "<button class='btn-ghost proj-edit-btn' data-id='" + p.id + "' type='button'>Modifier</button></div>" +
    "</div>" +
    "<div class='proj-detail-meta'>" +
      "<span class='proj-badge st-" + m.status + "'>" + PROJ_STATUS[m.status] + "</span>" +
      "<span class='proj-badge prio-" + m.priority + "'>" + PRIO_LABEL[m.priority] + "</span>" +
      (m.due_date ? "<span class='proj-badge due" + (overdue ? " overdue" : "") + "'>📅 " + fmtDateShort(parseDay(m.due_date)) + "</span>" : "") +
      (m.tags.length ? m.tags.map((t) => "<span class='proj-tag'>" + esc(t) + "</span>").join("") : "") +
    "</div>" +
    "<div class='proj-progress'><div class='proj-bar'><div class='proj-bar-fill' style='width:" + pct + "%'></div></div>" +
      "<span class='proj-pct'>" + done + " / " + tasks.length + " (" + pct + "%)</span></div>" +
    "<div class='kanban'>" + kanbanHtml(p, tasks) + "</div>" +
    "<div class='proj-detail-cols'>" +
      "<div class='proj-detail-desc'><h3>Description</h3>" +
      "<textarea id='proj-desc-edit' rows='6' placeholder='Objectif, idées, avancement…'>" + esc(p.description || "") + "</textarea>" +
      "<button id='proj-desc-save' class='btn-ghost' type='button'>Enregistrer la description</button></div>" +
      "<div class='proj-detail-journal'><h3>Journal d'avancement</h3>" +
      "<div class='proj-journal-add'><input id='proj-journal-input' type='text' placeholder='Note rapide…'>" +
      "<button id='proj-journal-add-btn' class='btn-primary' type='button'>+</button></div>" +
      (notes.length
        ? "<ul class='proj-journal-list'>" + notes.map((n) =>
            "<li class='proj-journal-item' data-id='" + n.id + "'><time>" + fmtNoteDate(n.created_at) + "</time>" +
            "<p>" + esc(n.text) + "</p><button class='todo-del' data-act='ndel' data-id='" + n.id + "' title='Supprimer'>🗑</button></li>"
          ).join("") + "</ul>"
        : "<p class='proj-journal-empty'>Aucune note pour l'instant.</p>") +
      "</div>" +
    "</div>";
  bindKanban(detail, p);
  const ji = $("#proj-journal-input");
  if (ji) ji.addEventListener("keydown", (e) => { if (e.key === "Enter") addProjectNote(); });
}

function kanbanHtml(p, tasks) {
  return KANBAN_COLS.map(([st, label]) => {
    const list = tasks.filter((t) => taskStatus(t) === st)
      .sort((a, b) => (PRIO_RANK[a.priority || "medium"] ?? 1) - (PRIO_RANK[b.priority || "medium"] ?? 1));
    return "<div class='kanban-col' data-status='" + st + "'>" +
      "<div class='kanban-head'><span>" + label + "</span><b>" + list.length + "</b></div>" +
      "<div class='kanban-list'>" +
        (list.length ? list.map(kanbanCard).join("") : "<p class='kanban-empty'>—</p>") +
      "</div>" +
      "<button class='kanban-add' data-act='kadd' data-status='" + st + "' type='button'>＋ Ajouter</button>" +
      "</div>";
  }).join("");
}
function kanbanCard(t) {
  const due = t.due_date;
  const overdue = due && due < dayKey(new Date()) && taskStatus(t) !== "done";
  return "<div class='kanban-card' draggable='true' data-id='" + t.id + "'>" +
    "<div class='kanban-card-title'>" + esc(t.title) + "</div>" +
    "<div class='kanban-card-meta'>" +
      "<span class='proj-badge prio-" + (t.priority || "medium") + "'>" + PRIO_LABEL[t.priority || "medium"] + "</span>" +
      (due ? "<span class='kanban-due" + (overdue ? " overdue" : "") + "'>📅 " + fmtDateShort(parseDay(due)) + "</span>" : "") +
      "<button class='todo-del' data-act='kdel' data-id='" + t.id + "' title='Supprimer'>✕</button>" +
    "</div></div>";
}
function bindKanban(container, p) {
  container.querySelectorAll(".kanban-card").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", card.dataset.id);
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });
  container.querySelectorAll(".kanban-col").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("over"); });
    col.addEventListener("dragleave", () => col.classList.remove("over"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("over");
      const id = e.dataTransfer.getData("text/plain");
      const t = projectTasks.find((x) => x.id === id);
      if (!t || !projectDetailId) return;
      const st = col.dataset.status;
      if (taskStatus(t) === st) return;
      try {
        await API.saveProjectTask({ ...t, status: st, done: st === "done" });
        await API.loadProjectTasks();
        renderProjectDetail(projectDetailId);
      } catch (err) { alert(err.message || "Erreur."); }
    });
  });
}

function openProjectModal(proj) {
  projModalId = proj ? proj.id : null;
  const m = proj ? projMeta(proj) : { status: "todo", priority: "medium", color: "c1", due_date: null, tags: [] };
  $("#projm-title").textContent = proj ? "Modifier le projet" : "Nouveau projet";
  $("#projm-name").value = proj ? proj.name : "";
  $("#projm-desc").value = proj ? (proj.description || "") : "";
  $("#projm-status").value = m.status;
  $("#projm-priority").value = m.priority;
  $("#projm-due").value = m.due_date || "";
  $("#projm-color").value = m.color;
  $("#projm-tags").value = m.tags.join(", ");
  $("#projm-del").style.display = proj ? "" : "none";
  $("#modal-proj").classList.add("open");
  setTimeout(() => { $("#projm-name").focus(); }, 60);
}

function closeProjectModal() {
  $("#modal-proj").classList.remove("open");
  projModalId = null;
}

async function saveProjectFromModal() {
  const name = $("#projm-name").value.trim();
  if (!name) { $("#projm-name").focus(); return; }
  try {
    await API.saveProject({
      id: projModalId,
      name,
      description: $("#projm-desc").value.trim(),
      status: $("#projm-status").value,
      priority: $("#projm-priority").value,
      due_date: $("#projm-due").value || null,
      color: $("#projm-color").value,
      tags: $("#projm-tags").value.split(",").map((s) => s.trim()).filter(Boolean),
    });
    await API.loadProjects();
    closeProjectModal();
    if (projectDetailId) renderProjectDetail(projectDetailId);
    else renderProjects();
  } catch (err) { alert(err.message || "Erreur lors de l'enregistrement."); }
}

async function deleteProjectFromModal() {
  if (!projModalId) return;
  try {
    const id = projModalId;
    await API.deleteProject(id);
    await API.loadProjects();
    for (const t of projectTasks.filter((x) => x.project_id === id)) await API.deleteProjectTask(t.id);
    for (const n of projectNotes.filter((x) => x.project_id === id)) await API.deleteProjectNote(n.id);
    await API.loadProjectTasks();
    await API.loadProjectNotes();
    closeProjectModal();
    projectDetailId = null;
    renderProjects();
  } catch (err) { alert(err.message || "Erreur lors de la suppression."); }
}

/* ---------- Tâches de projet (Kanban) ---------- */
let ptaskModalId = null;
let ptaskPendingStatus = "todo";

function openPTaskModal(task, status) {
  ptaskModalId = task ? task.id : null;
  ptaskPendingStatus = status || (task ? taskStatus(task) : "todo");
  $("#ptaskm-title").textContent = task ? "Modifier la tâche" : "Nouvelle tâche";
  $("#ptaskm-name").value = task ? task.title : "";
  $("#ptaskm-priority").value = task ? (task.priority || "medium") : "medium";
  $("#ptaskm-status").value = ptaskPendingStatus;
  $("#ptaskm-due").value = task && task.due_date ? String(task.due_date).slice(0, 10) : "";
  $("#ptaskm-del").style.display = task ? "" : "none";
  $("#modal-ptask").classList.add("open");
  setTimeout(() => { $("#ptaskm-name").focus(); }, 60);
}
function closePTaskModal() {
  $("#modal-ptask").classList.remove("open");
  ptaskModalId = null;
}
async function savePTaskFromModal() {
  const title = $("#ptaskm-name").value.trim();
  if (!title) { $("#ptaskm-name").focus(); return; }
  const st = $("#ptaskm-status").value;
  try {
    await API.saveProjectTask({
      id: ptaskModalId,
      project_id: projectDetailId,
      title,
      priority: $("#ptaskm-priority").value,
      due_date: $("#ptaskm-due").value || null,
      status: st,
      done: st === "done",
    });
    await API.loadProjectTasks();
    closePTaskModal();
    renderProjectDetail(projectDetailId);
  } catch (err) { alert(err.message || "Erreur lors de l'enregistrement."); }
}
async function deletePTaskFromModal() {
  if (!ptaskModalId) return;
  try {
    await API.deleteProjectTask(ptaskModalId);
    await API.loadProjectTasks();
    closePTaskModal();
    renderProjectDetail(projectDetailId);
  } catch (err) { alert(err.message || "Erreur lors de la suppression."); }
}
async function deletePTaskFromList(id) {
  try {
    await API.deleteProjectTask(id);
    await API.loadProjectTasks();
    renderProjectDetail(projectDetailId);
  } catch (err) { alert(err.message || "Erreur."); }
}

/* ---------- Journal d'avancement ---------- */
function fmtNoteDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) + " · " +
    d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}
async function addProjectNote() {
  if (!projectDetailId) return;
  const input = $("#proj-journal-input");
  const text = input.value.trim();
  if (!text) return;
  try {
    await API.saveProjectNote({ id: null, project_id: projectDetailId, text, created_at: new Date().toISOString() });
    await API.loadProjectNotes();
    input.value = "";
    renderProjectDetail(projectDetailId);
  } catch (err) { alert(err.message || "Erreur lors de l'ajout."); }
}
async function deleteProjectNote(id) {
  try {
    await API.deleteProjectNote(id);
    await API.loadProjectNotes();
    renderProjectDetail(projectDetailId);
  } catch (err) { alert(err.message || "Erreur."); }
}

/* ---------- Export CSV ---------- */
function exportProjectsCSV() {
  const rows = [["Nom", "Statut", "Priorité", "Échéance", "Progression (%)", "Étiquettes", "Description"]];
  projects.forEach((p) => {
    const m = projMeta(p);
    rows.push([
      p.name, PROJ_STATUS[m.status], PRIO_LABEL[m.priority], m.due_date || "",
      projectPct(p), m.tags.join(", "), (p.description || "").replace(/\n/g, " "),
    ]);
    projectTasksOf(p).forEach((t) => rows.push([
      "  → " + t.title,
      taskStatus(t) === "done" ? "Terminée" : (taskStatus(t) === "doing" ? "En cours" : "À faire"),
      PRIO_LABEL[t.priority || "medium"], t.due_date || "", "", "", "",
    ]));
  });
  downloadCSV("projets.csv", rows);
}
function downloadCSV(filename, rows) {
  const csv = "\uFEFF" + rows.map((r) => r.map((c) => '"' + String(c ?? "").replace(/"/g, '""') + '"').join(";")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

/* ---------- Panel tableau de bord ---------- */
function renderDashboardProjects() {
  const el = $("#dash-projects-list");
  if (!el) return;
  const active = projects
    .filter((p) => projMeta(p).status === "doing" || projMeta(p).status === "todo")
    .sort((a, b) => projectPct(b) - projectPct(a))
    .slice(0, 3);
  el.innerHTML = active.length
    ? active.map((p) => {
        const pct = projectPct(p);
        return "<button class='dash-proj' data-id='" + p.id + "'>" +
          "<span class='proj-color-dot color-" + projMeta(p).color + "'></span>" +
          "<span class='dash-proj-name'>" + esc(p.name) + "</span>" +
          "<div class='proj-bar'><div class='proj-bar-fill' style='width:" + pct + "%'></div></div>" +
          "<span class='proj-pct'>" + pct + "%</span></button>";
      }).join("")
    : "<p class='empty'>Aucun projet en cours.</p>";
}

async function saveProjectDesc() {
  if (!projectDetailId) return;
  var p = projects.find(function(x) { return x.id === projectDetailId; });
  if (!p) return;
  p.description = $("#proj-desc-edit").value;
  try {
    await API.saveProject(p);
    await API.loadProjects();
    alert("Description enregistree !");
  } catch (err) { alert(err.message || "Erreur."); }
}


/* ===================== Actualités (Google News RSS) ===================== */
const NEWS_CATS = {
  top: { label: "À la une", url: "https://www.francetvinfo.fr/titres.rss" },
  tech: { label: "Technologie", url: "https://www.numerama.com/feed/" },
  sport: { label: "Sport", url: "https://www.lemonde.fr/sport/rss_full.xml" },
  sante: { label: "Santé", url: "https://www.lemonde.fr/sante/rss_full.xml" },
  science: { label: "Science", url: "https://www.lemonde.fr/sciences/rss_full.xml" },
  jeux: { label: "Jeux vidéo", url: "https://www.jeuxvideo.com/rss/rss.xml" },
};
const LS_NEWS = "lm_news_cache_v2";
let newsCache = null;

function newsUrl(cat) {
  const c = NEWS_CATS[cat] || NEWS_CATS.top;
  return c.url;
}
const NEWS_PROXIES = [
  (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
  (u) => "https://corsproxy.io/?url=" + encodeURIComponent(u),
];

function parseNewsXML(xml) {
  try {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const items = [...doc.querySelectorAll("item")].slice(0, 15).map((it) => {
      const srcEl = it.querySelector("source");
      const enc = it.querySelector("enclosure");
      const media = it.querySelector("media\:thumbnail, thumbnail");
      const img = (enc && enc.getAttribute && enc.getAttribute("url")) ||
        (media && media.getAttribute && media.getAttribute("url")) || "";
      return {
        title: (it.querySelector("title") || {}).textContent?.trim() || "",
        link: (it.querySelector("link") || {}).textContent?.trim() || "",
        pubDate: (it.querySelector("pubDate") || {}).textContent?.trim() || "",
        source: srcEl ? (srcEl.textContent || "").trim() : "",
        img,
      };
    }).filter((it) => it.title && it.link);
    return items.length ? items : null;
  } catch (e) { return null; }
}

async function fetchNewsRSS(url) {
  let lastErr = null;
  for (const proxy of NEWS_PROXIES) {
    try {
      const res = await fetch(proxy(url), { signal: AbortSignal.timeout(15000) });
      if (!res.ok) { lastErr = new Error("HTTP " + res.status); continue; }
      const xml = await res.text();
      const items = parseNewsXML(xml);
      if (items && items.length) return items;
      lastErr = new Error("Aucun article");
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Erreur réseau");
}

/* rss2json : JSON avec CORS natif, plus fiable que les proxys */
async function fetchNewsJSON(url) {
  const res = await fetch("https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent(url), { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (data.status !== "ok" || !data.items || !data.items.length) throw new Error("Aucun article");
  return data.items.slice(0, 15).map((it) => {
    const { title, source } = splitNewsTitle(it.title || "");
    return {
      title,
      link: it.link || "",
      pubDate: it.pubDate || "",
      source: it.author || source,
      img: it.thumbnail || (it.enclosure && it.enclosure.link) || "",
    };
  }).filter((it) => it.title && it.link);
}
function splitNewsTitle(raw) {
  const idx = String(raw).lastIndexOf(" - ");
  if (idx > 10) return { title: raw.slice(0, idx), source: raw.slice(idx + 3) };
  return { title: raw, source: "" };
}

function newsCacheValid() {
  return newsCache && newsCache.fetchedAt && (Date.now() - newsCache.fetchedAt < 30 * 60 * 1000);
}

async function loadNews(force) {
  const catEl = $("#news-cat");
  const cat = (catEl && catEl.value) || "top";
  if (!force && newsCacheValid() && newsCache.cat === cat) { renderNews(); return; }
  const listEl = $("#news-list");
  if (listEl) listEl.innerHTML = "<p class='news-status'>Chargement des actualités…</p>";
  let items = null;
  try {
    items = await fetchNewsJSON(newsUrl(cat));
  } catch (e) {
    try { items = await fetchNewsRSS(newsUrl(cat)); } catch (e2) { /* tout a échoué */ }
  }
  if (items && items.length) {
    newsCache = { cat, fetchedAt: Date.now(), items };
    lsSet(LS_NEWS, newsCache);
    renderNews();
  } else if (listEl) {
    listEl.innerHTML = "<p class='news-status error'>Impossible de charger les actualités. Vérifie ta connexion.</p>";
  }
}

function renderNews() {
  const listEl = $("#news-list");
  if (!listEl) return;
  if (!newsCache || !newsCache.items || !newsCache.items.length) {
    listEl.innerHTML = "<p class='news-status'>Aucune actualité pour le moment.</p>";
    return;
  }
  listEl.innerHTML = newsCache.items.map((n) => {
    const d = n.pubDate ? new Date(n.pubDate) : null;
    const t = d && !isNaN(d) ? d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "";
    return "<a class='news-item' href='" + esc(n.link) + "' target='_blank' rel='noopener'>" +
      "<span class='news-title'>" + esc(n.title) + "</span>" +
      (n.img ? "<img class='news-img' src='" + esc(n.img) + "' alt='' loading='lazy'>" : "") +
      "<span class='news-body'>" +
        (n.source ? "<span class='news-src'>" + esc(n.source) + (t ? " · " + t : "") + "</span>" : "") +
      "</span>" +
      "</a>";
  }).join("");
}

/* ===================== YouTube (Data API v3, clé seule) ===================== */
const LS_YT_KEY = "lm_yt_key";
const LS_YT_CHANNEL = "lm_yt_channel";
const LS_YT_DASH_CHANNEL = "lm_yt_dash_channel";
let ytView = "trending";
let ytTrendingCat = ""; // catégorie de tendances choisie (videoCategoryId)
let ytResults = [];
let ytSearching = false;
let ytError = null;
let ytChannel = null; // dashboard de chaîne : { info, handle, videos }

function ytAPIKey() { return localStorage.getItem(LS_YT_KEY) || ""; }

function renderYouTubePage() {
  const key = ytAPIKey();
  const handle = ytChannelHandle();
  const keyInput = $("#yt-key-input");
  if (keyInput) keyInput.value = key;
  const chInput = $("#yt-channel-input");
  if (chInput) chInput.value = handle;
  const missing = $("#yt-key-missing");
  if (missing) missing.classList.toggle("hidden", !!key);
  const cmissing = $("#yt-channel-missing");
  if (cmissing) cmissing.classList.toggle("hidden", !!handle);
  const input = $("#yt-search-input");
  const btn = $("#yt-search-btn");
  const tfilter = $("#yt-trending-filter");
  const isTrending = ytView === "trending";
  const noInput = isTrending || ytView === "channel";
  if (input) {
    input.placeholder = noInput ? "" : "Rechercher une vidéo…";
    input.classList.toggle("hidden", noInput);
    if (noInput) input.value = "";
  }
  if (tfilter) {
    tfilter.classList.toggle("hidden", !isTrending);
    if (isTrending && tfilter.value) ytTrendingCat = tfilter.value;
  }
  if (btn) btn.textContent = ((isTrending || ytView === "channel") ? "Actualiser" : "Rechercher");
  $$(".yt-tab").forEach((b) => b.classList.toggle("active", b.dataset.ytview === ytView));
  if (isTrending && key && !ytResults.length && !ytSearching) ytLoadTrending();
  if (ytView === "channel" && key && handle && !ytResults.length && !ytSearching) ytLoadChannel();
  ytRender();
}

async function ytFetch(path) {
  const key = ytAPIKey();
  if (!key) throw new Error("NO_KEY");
  const res = await fetch("https://www.googleapis.com/youtube/v3/" + path + "&key=" + encodeURIComponent(key));
  const data = await res.json();
  if (!res.ok || data.error) {
    const msg = (data.error && data.error.message) ? data.error.message : ("Erreur HTTP " + res.status);
    throw new Error(msg);
  }
  return data;
}

function fmtCompact(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(".", ",") + " M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(".", ",") + " k";
  return String(n);
}
function fmtDuration(iso) {
  if (!iso) return "";
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return iso;
  const h = m[1] ? Number(m[1]) : 0;
  const min = m[2] ? Number(m[2]) : 0;
  const s = m[3] ? Number(m[3]) : 0;
  return (h ? h + ":" + pad(min) : min) + ":" + pad(s);
}
function ytVideoId(v) {
  const id = v && v.id;
  if (!id) return "";
  // API search YouTube : id est un objet { videoId, ... } ; sinon (videos/playlist) c'est une chaîne.
  if (typeof id === "object") return String(id.videoId || "");
  return String(id);
}
function ytThumbUrl(v) {
  const sn = v.snippet || {};
  const t = sn.thumbnails || {};
  return (t.medium || t.default || t.high || {}).url || "";
}
function ytCardHtml(v) {
  const sn = v.snippet || {};
  const st = v.statistics || {};
  const views = st.viewCount ? fmtCompact(Number(st.viewCount)) : "";
  const date = sn.publishedAt ? new Date(sn.publishedAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) : "";
  const thumb = ytThumbUrl(v);
  return "<button class='yt-card' data-id='" + esc(ytVideoId(v)) + "' type='button'>" +
    (thumb ? "<img class='yt-thumb' src='" + esc(thumb) + "' alt='' loading='lazy'>" : "<div class='yt-thumb yt-thumb-empty'>🎬</div>") +
    "<div class='yt-card-info'><span class='yt-card-title'>" + esc(sn.title || "Sans titre") + "</span>" +
    "<span class='yt-card-sub'>" + esc(sn.channelTitle || "") + (views ? " · " + views + " vues" : "") + (date ? " · " + date : "") + "</span></div>" +
    "</button>";
}
function ytRender() {
  const el = $("#yt-results");
  if (!el) return;
  el.classList.toggle("yt-results-channel", ytView === "channel");
  if (!ytAPIKey()) { el.innerHTML = ""; return; }
  if (ytError) {
    el.innerHTML = "<p class='yt-status error'>" + esc(ytError.message || "Une erreur est survenue.") + "</p>";
    return;
  }
  if (ytSearching) { el.innerHTML = "<p class='yt-status'>Chargement…</p>"; return; }
  if (!ytResults.length) {
    el.innerHTML = "<p class='yt-status'>" +
      (ytView === "channel" ? "Clique sur « Actualiser » pour charger le dashboard de la chaîne configurée."
        : (ytView === "trending" ? "Clique sur « Actualiser » pour charger les tendances France."
          : "Lance une recherche pour voir des résultats.")) +
      "</p>";
    return;
  }
  el.innerHTML = ytView === "channel" ? ytChannelDashHtml() : ytResults.map(ytCardHtml).join("");
}
function showYtError(e) {
  ytError = e;
  if (e.message === "NO_KEY") { const m = $("#yt-key-missing"); if (m) m.classList.remove("hidden"); }
}

async function ytDoSearch() {
  const q = $("#yt-search-input").value.trim();
  if (!q) return;
  ytError = null; ytSearching = true; ytRender();
  try {
    const data = await ytFetch("search?part=snippet&type=video&maxResults=24&regionCode=FR&relevanceLanguage=fr&q=" + encodeURIComponent(q));
    ytResults = data.items || [];
  } catch (e) { ytResults = []; showYtError(e); }
  finally { ytSearching = false; ytRender(); }
}
async function ytLoadTrending() {
  const tfilter = $("#yt-trending-filter");
  if (tfilter) ytTrendingCat = tfilter.value;
  ytError = null; ytSearching = true; ytRender();
  try {
    let url = "videos?part=snippet,statistics&chart=mostPopular&regionCode=FR&maxResults=24";
    if (ytTrendingCat) url += "&videoCategoryId=" + encodeURIComponent(ytTrendingCat);
    const data = await ytFetch(url);
    ytResults = data.items || [];
  } catch (e) { ytResults = []; showYtError(e); }
  finally { ytSearching = false; ytRender(); }
}

/* ---- Dashboard de chaîne ---- */
function ytChannelHandle() { return localStorage.getItem(LS_YT_CHANNEL) || ""; }

function ytChannelParam(handle) {
  const h = String(handle || "").trim();
  if (!h) return null;
  if (h.charAt(0) === "@") return "forHandle=" + encodeURIComponent(h);
  if (/^UC[\w-]{22}$/.test(h)) return "id=" + encodeURIComponent(h);
  return "forHandle=" + encodeURIComponent("@" + h);
}

async function ytLoadChannel() {
  const handle = ytChannelHandle();
  if (!handle) {
    const m = $("#yt-channel-missing"); if (m) m.classList.remove("hidden");
    showYtError(new Error("Aucune chaîne configurée. Entre un @handle ou un ID ci-dessus."));
    return;
  }
  const param = ytChannelParam(handle);
  if (!param) { showYtError(new Error("Handle ou ID de chaîne invalide.")); return; }
  ytError = null; ytSearching = true; ytRender();
  try {
    const data = await ytFetch("channels?part=snippet,statistics,contentDetails,brandingSettings&" + param);
    const info = (data.items || [])[0];
    if (!info) throw new Error("Chaîne introuvable. Vérifie le handle ou l'ID.");
    const uploads = (info.contentDetails && info.contentDetails.relatedPlaylists && info.contentDetails.relatedPlaylists.uploads) || "";
    const videos = [];
    if (uploads) {
      const pl = await ytFetch("playlistItems?part=snippet&playlistId=" + encodeURIComponent(uploads) + "&maxResults=24");
      const ids = (pl.items || []).map((it) => it.snippet && it.snippet.resourceId && it.snippet.resourceId.videoId).filter(Boolean);
      for (let i = 0; i < ids.length; i += 24) {
        const vd = await ytFetch("videos?part=snippet,statistics,contentDetails&id=" + encodeURIComponent(ids.slice(i, i + 24).join(",")));
        (vd.items || []).forEach((v) => videos.push(v));
      }
    }
    ytChannel = { info, handle, videos };
    ytResults = videos;
    const snp = info.snippet || {};
    const th = snp.thumbnails || {};
    const avatar = (th.medium || th.high || th.default || {}).url || "";
    const last = videos[0];
    const lastViews = last && last.statistics && last.statistics.viewCount ? Number(last.statistics.viewCount) : null;
    const lastTitle = last && last.snippet && last.snippet.title ? last.snippet.title : "";
    try { localStorage.setItem(LS_YT_DASH_CHANNEL, JSON.stringify({ name: snp.title || "", handle, subs: String((info.statistics || {}).subscriberCount || "0"), avatar, lastViews, lastTitle })); } catch (e) {}
  } catch (e) { ytResults = []; showYtError(e); }
  finally { ytSearching = false; ytRender(); }
}

function ytChannelStats(videos) {
  let views = 0, likes = 0;
  (videos || []).forEach((v) => {
    const s = v.statistics || {};
    if (s.viewCount) views += Number(s.viewCount);
    if (s.likeCount) likes += Number(s.likeCount);
  });
  return { views, likes };
}

function ytStatCard(v, label) {
  return "<div class='yt-channel-stat'><strong>" + esc(v) + "</strong><span>" + esc(label) + "</span></div>";
}
function ytChartHtml(videos) {
  if (!videos.length) return "";
  const top = videos.slice().sort((a, b) => (Number((b.statistics || {}).viewCount) || 0) - (Number((a.statistics || {}).viewCount) || 0)).slice(0, 12);
  const max = Math.max.apply(null, top.map((v) => Number((v.statistics || {}).viewCount) || 0));
  const rows = top.map((v) => {
    const n = Number((v.statistics || {}).viewCount) || 0;
    const w = max ? Math.round((n / max) * 100) : 0;
    return "<div class='yt-chart-row'>" +
      "<span class='yt-chart-title' title='" + esc((v.snippet || {}).title || "") + "'>" + esc((v.snippet || {}).title || "—") + "</span>" +
      "<div class='yt-chart-track'><div class='yt-chart-bar' style='width:" + w + "%'></div></div>" +
      "<span class='yt-chart-val'>" + fmtCompact(n) + "</span>" +
    "</div>";
  }).join("");
  return "<div class='panel yt-chart'><h3>📊 Vues des dernières vidéos</h3>" + rows + "</div>";
}
function ytTableHtml(videos) {
  if (!videos.length) return "";
  const rows = videos.map((v) => {
    const sn = v.snippet || {};
    const st = v.statistics || {};
    const thumb = ytThumbUrl(v);
    const date = sn.publishedAt ? new Date(sn.publishedAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) : "—";
    return "<tr class='yt-table-row' data-id='" + esc(ytVideoId(v)) + "'>" +
      "<td class='yt-t-video'>" +
        (thumb ? "<img class='yt-t-thumb' src='" + esc(thumb) + "' alt='' loading='lazy'>" : "") +
        "<span class='yt-t-title'>" + esc(sn.title || "Sans titre") + "</span>" +
      "</td>" +
      "<td>" + (st.viewCount ? fmtCompact(Number(st.viewCount)) : "—") + "</td>" +
      "<td>" + (st.likeCount ? fmtCompact(Number(st.likeCount)) : "—") + "</td>" +
      "<td>" + (fmtDuration((v.contentDetails || {}).duration) || "—") + "</td>" +
      "<td>" + esc(date) + "</td>" +
    "</tr>";
  }).join("");
  return "<div class='panel yt-table-panel'><h3>🎬 Dernières vidéos</h3>" +
    "<div class='yt-table-wrap'><table class='yt-table'><thead><tr>" +
    "<th>Vidéo</th><th>Vues</th><th>Likes</th><th>Durée</th><th>Publiée</th>" +
    "</tr></thead><tbody>" + rows + "</tbody></table></div></div>";
}
function ytChannelStripHtml() {
  if (!ytChannel || !ytChannel.info) return "";
  const info = ytChannel.info;
  const sn = info.snippet || {};
  const st = info.statistics || {};
  const videos = ytChannel.videos || [];
  const th = sn.thumbnails || {};
  const avatar = (th.medium || th.high || th.default || {}).url || "";
  const recent = ytChannelStats(videos);
  return "<div class='yt-channel-strip'>" +
    "<div class='yt-channel-id'>" +
      (avatar ? "<img class='yt-channel-avatar' src='" + esc(avatar) + "' alt=''>" : "<div class='yt-channel-avatar'></div>") +
      "<div class='yt-channel-idtext'>" +
        "<div class='yt-channel-name'>" + esc(sn.title || "Chaîne") + "</div>" +
        "<div class='yt-channel-handle'>" + esc(String(ytChannel.handle || "")) + "</div>" +
        "<div class='yt-channel-subs'>" + (st.subscriberCount ? fmtCompact(Number(st.subscriberCount)) + " abonnés" : "—") + "</div>" +
      "</div>" +
    "</div>" +
    "<div class='yt-channel-stats'>" +
      ytStatCard(st.subscriberCount ? fmtCompact(Number(st.subscriberCount)) : "—", "Abonnés") +
      ytStatCard(st.viewCount ? fmtCompact(Number(st.viewCount)) : "—", "Vues totales") +
      ytStatCard(st.videoCount ? fmtCompact(Number(st.videoCount)) : "—", "Vidéos") +
      ytStatCard(videos.length ? fmtCompact(recent.views) : "—", "Vues récentes") +
      ytStatCard(videos.length ? fmtCompact(recent.likes) : "—", "Likes récents") +
    "</div>" +
    "<a class='btn-ghost yt-channel-open' href='https://www.youtube.com/channel/" + esc(String(info.id || "")) + "' target='_blank' rel='noopener'>Ouvrir la chaîne ↗</a>" +
  "</div>";
}

function ytChannelDashHtml() {
  if (!ytChannel || !ytChannel.info) return "";
  const videos = ytChannel.videos || [];
  return ytChannelStripHtml() +
    "<div class='yt-channel-videos'>" + videos.map(ytCardHtml).join("") + "</div>" +
    "<div class='yt-channel-dash'>" +
      ytChartHtml(videos) +
      ytTableHtml(videos) +
    "</div>";
}

function openYtModal(v) {
  const sn = v.snippet || {};
  const st = v.statistics || {};
  const cd = v.contentDetails || {};
  const desc = (sn.description || "").slice(0, 400);
  const th = sn.thumbnails || {};
  const thumb = (th.maxres || th.high || th.medium || th.default || {}).url || "";
  const watch = "https://www.youtube.com/watch?v=" + esc(ytVideoId(v));
  $("#ytm-body").innerHTML =
    "<a class='yt-thumb-link' href='" + watch + "' target='_blank' rel='noopener' title='Regarder sur YouTube'>" +
      (thumb ? "<img class='yt-modal-thumb' src='" + esc(thumb) + "' alt='' loading='lazy'>" : "<div class='yt-modal-thumb yt-thumb-empty'>🎬</div>") +
      "<span class='yt-play-overlay'></span>" +
    "</a>" +
    "<div class='yt-detail'><h3>" + esc(sn.title || "") + "</h3>" +
    "<span class='yt-detail-channel'>" + esc(sn.channelTitle || "") + "</span>" +
    "<div class='yt-detail-stats'>" +
      "<span>👁 " + (st.viewCount ? fmtCompact(Number(st.viewCount)) + " vues" : "—") + "</span>" +
      "<span>👍 " + (st.likeCount ? fmtCompact(Number(st.likeCount)) : "—") + "</span>" +
      "<span>💬 " + (st.commentCount ? fmtCompact(Number(st.commentCount)) : "—") + "</span>" +
      "<span>⏱ " + (fmtDuration(cd.duration) || "—") + "</span>" +
      (sn.publishedAt ? "<span>📅 " + new Date(sn.publishedAt).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }) + "</span>" : "") +
    "</div>" +
    (desc ? "<p class='yt-detail-desc'>" + esc(desc) + (sn.description.length > 400 ? "…" : "") + "</p>" : "") +
    "</div>";
  $("#modal-yt").classList.add("open");
}
function closeYtModal() { $("#modal-yt").classList.remove("open"); }

/* ---- Modale d'aide : mise en place des API YouTube ---- */
function openYtInfo() {
  const body = $("#ytinfo-body");
  if (!body) return;
  body.innerHTML = "<h2>❓ Utiliser l'onglet YouTube</h2>" +
  "<p>L'onglet YouTube a besoin d'une <strong>clé API</strong> gratuite pour afficher les vidéos, " +
  "les tendances et le dashboard d'une chaîne. Voici comment en obtenir une en quelques minutes. " +
  "Aucune carte bancaire n'est nécessaire.</p>" +

  "<h3>1. Créer un projet Google Cloud</h3>" +
  "<p>Va sur <a href='https://console.cloud.google.com' target='_blank' rel='noopener'>console.cloud.google.com</a> " +
  "et connecte-toi avec ton compte Google. En haut, ouvre le <strong>sélecteur de projet</strong>, " +
  "clique sur <strong>« Nouveau projet »</strong>, donne-lui un nom libre (ex. <code>mon-projet</code>) " +
  "puis « Créer ».</p>" +

  "<h3>2. Activer l'API YouTube</h3>" +
  "<p>Ouvre ce lien direct : " +
  "<a href='https://console.cloud.google.com/apis/library/youtube.googleapis.com' target='_blank' rel='noopener'>activer l'API YouTube Data v3</a>. " +
  "Vérifie que ton projet est sélectionné, puis clique sur le bouton bleu <strong>« Activer »</strong>.</p>" +

  "<h3>3. Créer et copier la clé API</h3>" +
  "<ol>" +
  "<li>Va sur <a href='https://console.cloud.google.com/apis/credentials' target='_blank' rel='noopener'>Identifiants</a>.</li>" +
  "<li>Clique sur <strong>« + Créer des identifiants »</strong> puis <strong>« Clé API »</strong>.</li>" +
  "<li>Copie la clé de type <code>AIzaSy…</code> (elle ne s'affiche qu'une seule fois en entier).</li>" +
  "<li>Colle-la dans le champ <strong>« Clé API YouTube… »</strong> puis « Enregistrer la clé ».</li>" +
  "</ol>" +

  "<p>💡 <strong>Conseil sécurité :</strong> pour restreindre la clé, clique sur elle dans " +
  "« Identifiants » → <strong>« Restrictions de l'API »</strong> → coche uniquement " +
  "<strong>« YouTube Data API v3 »</strong> → Enregistrer.</p>" +

  "<h3>4. Afficher une chaîne</h3>" +
  "<p>Dans le champ <strong>« Handle ou ID de chaîne… »</strong>, entre le <code>@handle</code> d'une " +
  "chaîne (ex. <code>@monchaine</code>) ou son ID, puis « Enregistrer la chaîne ». L'onglet " +
  "<strong>« 📺 Ma chaîne »</strong> affiche les stats de n'importe quelle chaîne publique.</p>" +

  "<h3>Dépannage rapide</h3>" +
  "<ul>" +
  "<li><strong>« API key not valid »</strong> : clé mal copiée ou mauvaise clé.</li>" +
  "<li><strong>« Access not configured »</strong> : l'API n'est pas activée (étape 2).</li>" +
  "<li><strong>« Quota exceeded »</strong> : limite gratuite du jour atteinte — réessaie demain.</li>" +
  "</ul>" +
  "<p class='yt-info-note'>ℹ️ La clé reste dans ton navigateur. Ne la partage pas dans un chat public.</p>";
  $("#modal-yt-info").classList.add("open");
}
function closeYtInfo() { $("#modal-yt-info").classList.remove("open"); }

/* ===================== Export Emploi du temps (Excel / PDF) ===================== */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Impossible de charger " + src));
    document.head.appendChild(s);
  });
}
const TT_EXCEL_COLORS = { 1: "D4FCDC", 2: "D4E0FC", 3: "FCD4F0", 4: "FCF0D4", 5: "D4FCF8", 6: "FCE0D4" };
const TT_PDF_COLORS = {
  1: [212, 252, 220], 2: [212, 224, 252], 3: [252, 212, 240],
  4: [252, 240, 212], 5: [212, 252, 248], 6: [252, 224, 212],
};

function ttExportRows() {
  return ttActivities.map((a) => ({
    day: a.day_of_week,
    start: fmtTTime(a.start_time),
    end: fmtTTime(a.end_time),
    title: a.title,
    desc: a.description || "",
    cancelled: ttCancelledIds().has(a.id),
    color: activityColorIndex(a),
  })).sort((a, b) => (a.day - b.day) || a.start.localeCompare(b.start));
}

async function exportTTExcel() {
  if (!window.XLSX) {
    try { await loadScript("https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js"); }
    catch (e) { alert("Impossible de charger la librairie Excel (connexion requise)."); return; }
  }
  const rows = ttExportRows();
  const slotMin = ttSlotMin();
  const n = ttNumSlots();
  const grid = [["Heure", ...DAYS_FULL]];
  for (let i = 0; i < n; i++) {
    const t0 = TT_START * 60 + i * slotMin;
    const t1 = t0 + slotMin;
    const line = [ttMinsToTime(t0) + " – " + ttMinsToTime(t1)];
    for (let d = 0; d < 7; d++) {
      const acts = rows.filter((r) => r.day === d && ttMinutes(r.start) < t1 && ttMinutes(r.end) > t0);
      line.push(acts.map((r) => (r.cancelled ? "✗ " : "") + r.title + (ttMinutes(r.start) !== t0 ? " (" + r.start + ")" : "")).join("\n"));
    }
    grid.push(line);
  }
  const wsGrid = XLSX.utils.aoa_to_sheet(grid);
  wsGrid["!cols"] = [{ wch: 15 }, ...Array(7).fill({ wch: 22 })];
  for (let i = 1; i <= n; i++) {
    const t0 = TT_START * 60 + (i - 1) * slotMin;
    const t1 = t0 + slotMin;
    for (let d = 0; d < 7; d++) {
      const acts = rows.filter((r) => r.day === d && ttMinutes(r.start) < t1 && ttMinutes(r.end) > t0);
      if (!acts.length) continue;
      const cell = wsGrid[XLSX.utils.encode_cell({ r: i, c: d + 1 })];
      if (!cell) continue;
      const s = { alignment: { wrapText: true, vertical: "center" } };
      const color = TT_EXCEL_COLORS[acts[0].color];
      if (color) s.fill = { fgColor: { rgb: color } };
      cell.s = s;
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsGrid, "Grille");

  const list = [["Jour", "Début", "Fin", "Activité", "Description", "Annulé"]];
  rows.forEach((r) => list.push([DAYS_FULL[r.day], r.start, r.end, r.title, r.desc, r.cancelled ? "Oui" : "Non"]));
  const wsList = XLSX.utils.aoa_to_sheet(list);
  wsList["!cols"] = [{ wch: 10 }, { wch: 8 }, { wch: 8 }, { wch: 26 }, { wch: 44 }, { wch: 8 }];
  XLSX.utils.book_append_sheet(wb, wsList, "Liste");
  XLSX.writeFile(wb, "emploi-du-temps.xlsx");
}

async function exportTTPdf() {
  if (!window.jspdf) {
    try { await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"); }
    catch (e) { alert("Impossible de charger la librairie PDF (connexion requise)."); return; }
  }
  if (!window.jspdf.jsPDF) { alert("Librairie PDF indisponible."); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const rows = ttExportRows();
  const slotMin = ttSlotMin();
  const n = ttNumSlots();

  const PAGE_W = 297;
  const PAGE_H = 210;
  const M = 8;
  const HEADER_H = 7;
  const timeW = 22;
  const x0 = M;
  const y0 = 25;
  const usableW = PAGE_W - 2 * M - timeW;
  const dayW = usableW / 7;
  const rowH = (PAGE_H - M - y0) / n;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text("Emploi du temps — Life Manager", PAGE_W / 2, 11, { align: "center" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text("Semaine type · " + ttMinsToTime(TT_START * 60) + " – " + ttMinsToTime(TT_END * 60) + " · découpage " + slotMin + " min", PAGE_W / 2, 17, { align: "center" });

  /* En-tête */
  doc.setFillColor(228, 228, 228);
  doc.rect(x0, y0, timeW + usableW, HEADER_H, "F");
  doc.setDrawColor(100, 100, 100);
  doc.setLineWidth(0.15);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(0, 0, 0);
  let hx = x0;
  doc.text("Heure", hx + timeW / 2, y0 + HEADER_H / 2 + 1.1, { align: "center" });
  hx += timeW;
  for (let d = 0; d < 7; d++) {
    doc.text(DAYS_SHORT[d], hx + dayW / 2, y0 + HEADER_H / 2 + 1.1, { align: "center" });
    hx += dayW;
  }
  doc.setFont("helvetica", "normal");

  /* Corps */
  for (let i = 0; i < n; i++) {
    const t0 = TT_START * 60 + i * slotMin;
    const t1 = t0 + slotMin;
    const y = y0 + HEADER_H + i * rowH;

    /* colonne heure */
    doc.setFillColor(245, 245, 245);
    doc.rect(x0, y, timeW, rowH, "F");
    doc.setFontSize(6.5);
    doc.setTextColor(60, 60, 60);
    doc.text(ttMinsToTime(t0) + " – " + ttMinsToTime(t1), x0 + 1.4, y + rowH / 2 + 1.1);

    /* cases jours */
    for (let d = 0; d < 7; d++) {
      const cx = x0 + timeW + d * dayW;
      const acts = rows.filter((r) => r.day === d && ttMinutes(r.start) < t1 && ttMinutes(r.end) > t0);
      if (acts.length) {
        const a0 = acts[0];
        const fill = a0.cancelled ? [238, 238, 238] : (TT_PDF_COLORS[a0.color] || [220, 240, 220]);
        const fg = a0.cancelled ? [140, 140, 140] : [25, 55, 40];
        doc.setFillColor(fill[0], fill[1], fill[2]);
        doc.setTextColor(fg[0], fg[1], fg[2]);
        doc.rect(cx, y, dayW, rowH, "F");
        doc.setFontSize(7);
        let ty = y + 2.6;
        acts.forEach((a) => {
          const label = (a.cancelled ? "X " : "") + a.title + (ttMinutes(a.start) !== t0 ? " (" + a.start + ")" : "");
          const lines = doc.splitTextToSize(label, dayW - 2.6).slice(0, 2);
          lines.forEach((ln) => { doc.text(ln, cx + 1.3, ty); ty += 2.4; });
        });
      } else {
        doc.setFillColor(255, 255, 255);
        doc.rect(cx, y, dayW, rowH, "F");
      }
    }
  }

  /* quadrillage */
  doc.setDrawColor(100, 100, 100);
  doc.setLineWidth(0.15);
  for (let i = 0; i <= n; i++) {
    const y = y0 + HEADER_H + i * rowH;
    doc.line(x0, y, x0 + timeW + usableW, y);
  }
  for (let c = 0; c <= 7; c++) {
    const x = x0 + (c === 0 ? 0 : timeW + c * dayW - dayW);
    doc.line(x, y0, x, y0 + HEADER_H + n * rowH);
  }
  doc.line(x0 + timeW, y0, x0 + timeW, y0 + HEADER_H + n * rowH);
  doc.line(x0 + timeW + usableW, y0, x0 + timeW + usableW, y0 + HEADER_H + n * rowH);
  doc.setDrawColor(228, 228, 228);
  doc.setLineWidth(0.1);
  doc.line(x0, y0 + HEADER_H, x0 + timeW + usableW, y0 + HEADER_H);

  doc.save("emploi-du-temps.pdf");
}

/* ===================== Thème clair / sombre ===================== */
let theme = "dark";
try { theme = localStorage.getItem("lm_theme") || "dark"; } catch (e) {}

function applyTheme() {
  document.documentElement.dataset.theme = theme;
  const btn = $("#btn-theme");
  if (btn) {
    btn.textContent = theme === "dark" ? "☀️" : "🌙";
    btn.title = theme === "dark" ? "Passer en mode clair" : "Passer en mode sombre";
  }
}

function toggleTheme() {
  theme = theme === "dark" ? "light" : "dark";
  try { localStorage.setItem("lm_theme", theme); } catch (e) {}
  applyTheme();
}

/* ===================== Écouteurs ===================== */
$("#nav-dashboard").addEventListener("click", () => navigate("dashboard"));
$("#nav-schedule").addEventListener("click", () => navigate("schedule"));
$("#nav-timetable").addEventListener("click", () => navigate("timetable"));
$("#nav-todos").addEventListener("click", () => navigate("todos"));
$("#nav-weather").addEventListener("click", () => navigate("weather"));
$("#nav-youtube").addEventListener("click", () => navigate("youtube"));
$("#nav-projects").addEventListener("click", () => navigate("projects"));
$("#nav-passwords").addEventListener("click", () => navigate("passwords"));
$("#btn-logout").addEventListener("click", async () => {
  await API.logout();
  // Dans l'exe : ferme réellement l'application. Dans le navigateur : retour au login.
  if (window.lmDesktop && window.lmDesktop.isDesktop) {
    window.lmDesktop.quit();
  } else {
    showAuth();
  }
});
$("#btn-theme").addEventListener("click", toggleTheme);
$("#btn-settings").addEventListener("click", () => navigate("options"));
$("#opt-save-name").addEventListener("click", saveOptName);
$("#opt-save-pw").addEventListener("click", saveOptPassword);

$$(".cal-view-btn").forEach((b) => b.addEventListener("click", () => setCalView(b.dataset.view)));
$("#cal-prev").addEventListener("click", calPrev);
$("#cal-next").addEventListener("click", calNext);
$("#cal-today").addEventListener("click", calToday);
$("#cal-add-event").addEventListener("click", () => openEventModal(null, dayKey(cal.cursor)));

$("#calendar").addEventListener("click", (e) => {
  const addBtn = e.target.closest(".cell-add");
  if (addBtn) { openEventModal(null, addBtn.dataset.key); return; }
  const evBtn = e.target.closest(".event-item");
  if (evBtn) {
    const ev = events.find((x) => x.id === evBtn.dataset.id);
    if (ev) openEventModal(ev);
    return;
  }
  const ym = e.target.closest(".year-month");
  if (ym) { cal.view = "month"; cal.cursor = new Date(cal.cursor.getFullYear(), Number(ym.dataset.month), 1); renderSchedule(); return; }
  const cell = e.target.closest(".cal-cell");
  if (cell) { cal.view = "week"; cal.cursor = parseDay(cell.dataset.key); renderSchedule(); }
});

$("#ev-allday").addEventListener("change", toggleAllDay);
$("#modal-save").addEventListener("click", submitEvent);
$("#modal-delete").addEventListener("click", deleteEventFromModal);
$("#modal-cancel").addEventListener("click", closeModal);
$("#modal").addEventListener("click", (e) => { if (!e.target.closest(".modal")) closeModal(); });

/* Emploi du temps */
$("#tt-create").addEventListener("click", async () => {
  try {
    await API.saveTimetableSettings(60);
    ttEditMode = true;
    renderTimetable();
  } catch (err) {
    alert(err.message || "Erreur lors de la création.");
  }
});
$("#tt-edit").addEventListener("click", () => { ttEditMode = !ttEditMode; renderTimetable(); });
$("#tt-export").addEventListener("click", () => { window.print(); });
$("#tt-export-excel").addEventListener("click", exportTTExcel);
$("#tt-export-pdf").addEventListener("click", exportTTPdf);
$("#tt-board").addEventListener("click", (e) => {
  const sub = e.target.closest(".tt-subslot");
  if (sub && ttEditMode) {
    openTTAdd(Number(sub.dataset.day), Number(sub.dataset.slot), Number(sub.dataset.col));
    return;
  }
  const act = e.target.closest(".tt-activity");
  if (act) {
    const id = act.dataset.id;
    if (ttEditMode) openTTActivity(id, "edit");
    else openTTActivity(id, "view");
    return;
  }
  const cell = e.target.closest(".tt-cell");
  if (cell && ttEditMode) openTTAdd(Number(cell.dataset.day), Number(cell.dataset.slot));
});
$("#ttm-close").addEventListener("click", closeTTModal);
$("#ttm-footer").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const a = ttActivities.find((x) => x.id === ttModalActivityId) || null;
  try {
    if (act === "close") {
      closeTTModal();
    } else if (act === "cancel") {
      if (!a) return;
      const cancelled = ttCancelledIds().has(a.id);
      if (cancelled) await API.reactivateActivity(a.id);
      else await API.cancelActivityForWeek(a.id);
      await API.loadTimetable();
      renderTimetable();
      openTTActivity(a.id, "view");
    } else if (act === "save") {
      await saveTTActivityFromModal();
    } else if (act === "del") {
      if (!a) return;
      delete ttLanePref[a.id];
      await API.deleteTimetableActivity(a.id);
      await API.loadTimetable();
      closeTTModal();
      renderTimetable();
      renderDashboard();
    }
  } catch (err) {
    alert(err.message || "Une erreur est survenue.");
  }
});
$("#modal-tt").addEventListener("click", (e) => { if (!e.target.closest(".modal")) closeTTModal(); });

$("#todo-add").addEventListener("click", addTodo);
$("#todo-input").addEventListener("keydown", (e) => { if (e.key === "Enter") addTodo(); });
$("#todo-list").addEventListener("click", handleTodoListClick);
$("#todom-save").addEventListener("click", saveTodoFromModal);
$("#todom-del").addEventListener("click", deleteTodoFromModal);
$("#todom-cancel").addEventListener("click", closeTodoModal);
$("#todom-close").addEventListener("click", closeTodoModal);
$("#modal-todo").addEventListener("click", (e) => { if (!e.target.closest(".modal")) closeTodoModal(); });
$$(".tf").forEach((b) => b.addEventListener("click", () => {
  todoFilter = b.dataset.filter;
  $$(".tf").forEach((x) => x.classList.toggle("active", x === b));
  renderTodos();
}));

var wcb = $("#weather-city-btn"); if (wcb) wcb.addEventListener("click", searchWeatherCity);
var wcs = $("#weather-city-search"); if (wcs) wcs.addEventListener("keydown", (e) => { if (e.key === "Enter") searchWeatherCity(); });

/* Projets */
var pn = $("#proj-new"); if (pn) pn.addEventListener("click", () => openProjectModal(null));
var pl = $("#proj-list"); if (pl) pl.addEventListener("click", (e) => {
  const card = e.target.closest(".proj-card");
  if (card) renderProjectDetail(card.dataset.id);
});
var pd = $("#proj-detail"); if (pd) pd.addEventListener("click", (e) => {
  const back = e.target.closest(".proj-back");
  if (back) { renderProjects(); return; }
  const edit = e.target.closest(".proj-edit-btn");
  if (edit) { const p = projects.find((x) => x.id === edit.dataset.id); if (p) openProjectModal(p); return; }
  const saveDesc = e.target.closest("#proj-desc-save");
  if (saveDesc) { saveProjectDesc(); return; }
  const journalAdd = e.target.closest("#proj-journal-add-btn");
  if (journalAdd) { addProjectNote(); return; }
  const actEl = e.target.closest("[data-act]");
  if (actEl) {
    const act = actEl.dataset.act;
    if (act === "kadd") { openPTaskModal(null, actEl.dataset.status || "todo"); return; }
    if (act === "kdel") { deletePTaskFromList(actEl.dataset.id); return; }
    if (act === "ndel") { deleteProjectNote(actEl.dataset.id); return; }
    return;
  }
  const cardEl = e.target.closest(".kanban-card");
  if (cardEl) {
    const t = projectTasks.find((x) => x.id === cardEl.dataset.id);
    if (t) openPTaskModal(t);
  }
});
var psearch = $("#proj-search"); if (psearch) psearch.addEventListener("input", () => { projSearch = psearch.value; renderProjects(); });
var pfstatus = $("#proj-filter-status"); if (pfstatus) pfstatus.addEventListener("change", () => { projFilterStatus = pfstatus.value; renderProjects(); });
var pfprio = $("#proj-filter-prio"); if (pfprio) pfprio.addEventListener("change", () => { projFilterPrio = pfprio.value; renderProjects(); });
var psort = $("#proj-sort"); if (psort) psort.addEventListener("change", () => { projSort = psort.value; renderProjects(); });
var pexport = $("#proj-export"); if (pexport) pexport.addEventListener("click", exportProjectsCSV);

var ps = $("#projm-save"); if (ps) ps.addEventListener("click", saveProjectFromModal);
var pdl = $("#projm-del"); if (pdl) pdl.addEventListener("click", deleteProjectFromModal);
var pc = $("#projm-cancel"); if (pc) pc.addEventListener("click", closeProjectModal);
var pcl = $("#projm-close"); if (pcl) pcl.addEventListener("click", closeProjectModal);
var mp = $("#modal-proj"); if (mp) mp.addEventListener("click", (e) => { if (!e.target.closest(".modal")) closeProjectModal(); });

/* Tâche de projet (Kanban) */
var ptasks = $("#ptaskm-save"); if (ptasks) ptasks.addEventListener("click", savePTaskFromModal);
var ptaskd = $("#ptaskm-del"); if (ptaskd) ptaskd.addEventListener("click", deletePTaskFromModal);
var ptaskc = $("#ptaskm-cancel"); if (ptaskc) ptaskc.addEventListener("click", closePTaskModal);
var ptaskx = $("#ptaskm-close"); if (ptaskx) ptaskx.addEventListener("click", closePTaskModal);
var mptask = $("#modal-ptask"); if (mptask) mptask.addEventListener("click", (e) => { if (!e.target.closest(".modal")) closePTaskModal(); });

/* Dashboard → Projets */
var dprojs = $("#dash-projects-list"); if (dprojs) dprojs.addEventListener("click", (e) => {
  const btn = e.target.closest(".dash-proj");
  if (btn) { navigate("projects"); renderProjectDetail(btn.dataset.id); }
});

/* Dashboard → Ma chaîne YouTube */
var dytmini = $("#dash-yt-mini"); if (dytmini) dytmini.addEventListener("click", () => {
  if (dytmini.classList.contains("hidden")) return;
  ytView = "channel";
  ytResults = [];
  ytChannel = null;
  navigate("youtube");
  renderYouTubePage();
});

/* Actualités */
var nc = $("#news-cat"); if (nc) nc.addEventListener("change", () => loadNews(true));
var nr = $("#news-refresh"); if (nr) nr.addEventListener("click", () => loadNews(true));

/* YouTube */
var ytks = $("#yt-key-save"); if (ytks) ytks.addEventListener("click", () => {
  const v = $("#yt-key-input").value.trim();
  try { localStorage.setItem(LS_YT_KEY, v); } catch (e) {}
  ytError = null;
  renderYouTubePage();
  if (v && ytView === "trending") ytLoadTrending();
});
var ytcs = $("#yt-channel-save"); if (ytcs) ytcs.addEventListener("click", () => {
  const v = $("#yt-channel-input").value.trim();
  try { localStorage.setItem(LS_YT_CHANNEL, v); } catch (e) {}
  ytError = null;
  renderYouTubePage();
  if (v && ytView === "channel") ytLoadChannel();
});
$$(".yt-tab").forEach((b) => b.addEventListener("click", () => {
  ytView = b.dataset.ytview;
  ytError = null;
  ytResults = (ytView === "channel" && ytChannel) ? ytChannel.videos : [];
  renderYouTubePage();
}));
var ytsb = $("#yt-search-btn"); if (ytsb) ytsb.addEventListener("click", () => {
  if (ytView === "trending") ytLoadTrending();
  else if (ytView === "channel") ytLoadChannel();
  else ytDoSearch();
});
var ytsi = $("#yt-search-input"); if (ytsi) ytsi.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (ytView === "trending") ytLoadTrending();
  else if (ytView === "channel") ytLoadChannel();
  else ytDoSearch();
});
var ytinfo = $("#yt-info"); if (ytinfo) ytinfo.addEventListener("click", openYtInfo);
var ytinfoc = $("#ytinfo-close"); if (ytinfoc) ytinfoc.addEventListener("click", closeYtInfo);
var ytinfobox = $("#modal-yt-info"); if (ytinfobox) ytinfobox.addEventListener("click", (e) => { if (e.target === ytinfobox) closeYtInfo(); });
var yttf = $("#yt-trending-filter"); if (yttf) yttf.addEventListener("change", () => { ytResults = []; if (ytView === "trending" && ytAPIKey()) ytLoadTrending(); });
var ytr = $("#yt-results"); if (ytr) ytr.addEventListener("click", (e) => {
  const card = e.target.closest(".yt-card, .yt-table-row");
  if (card) {
    const v = ytResults.find((x) => ytVideoId(x) === card.dataset.id);
    if (v) openYtModal(v);
  }
});
var ytmc = $("#ytm-close"); if (ytmc) ytmc.addEventListener("click", closeYtModal);
var myt = $("#modal-yt"); if (myt) myt.addEventListener("click", (e) => { if (!e.target.closest(".modal")) closeYtModal(); });

/* ----- Mots de passe : listeners ----- */
var pwNewBtn = $("#pw-new"); if (pwNewBtn) pwNewBtn.addEventListener("click", () => openPwModal(null));
var pwExpBtn = $("#pw-export"); if (pwExpBtn) pwExpBtn.addEventListener("click", pwExportCsv);
var pwImpBtn = $("#pw-import"); if (pwImpBtn) pwImpBtn.addEventListener("click", () => {
  $("#pwip-file").value = "";
  $("#pwip-msg").textContent = ""; $("#pwip-msg").className = "opt-msg";
  $("#pwip-confirm").disabled = true;
  $("#modal-import-pw").classList.add("open");
});
var pwSearchIn = $("#pw-search"); if (pwSearchIn) pwSearchIn.addEventListener("input", () => { pwFilterQ = pwSearchIn.value; renderPasswords(); });
var pwClearBtn = $("#pw-clear"); if (pwClearBtn) pwClearBtn.addEventListener("click", () => {
  const n = pwStore ? pwStore.entries.length : 0;
  if (n === 0) { alert("Le coffre est déjà vide."); return; }
  // Demander le mot de passe de l'application avant de vider
  var msg = $("#pwc-msg"); if (msg) { msg.textContent = ""; msg.className = "opt-msg"; }
  var pwIn = $("#pwc-password"); if (pwIn) pwIn.value = "";
  var m = $("#modal-pw-confirm"); if (m) m.classList.add("open");
  if (pwIn) setTimeout(function(){ pwIn.focus(); }, 60);
});

function doClearPwVault() {
  var pwIn = $("#pwc-password"); var msg = $("#pwc-msg");
  var pw = pwIn ? pwIn.value : "";
  if (!pw) { if (msg) { msg.textContent = "Entre ton mot de passe."; msg.className = "opt-msg opt-msg-error"; } return; }
  var btn = $("#pwc-confirm"); if (btn) btn.disabled = true;
  if (msg) { msg.textContent = "Vérification…"; msg.className = "opt-msg"; }
  unlockVault(pw).then(function(ok) {
    if (btn) btn.disabled = false;
    if (!ok) {
      if (msg) { msg.textContent = "Mot de passe incorrect."; msg.className = "opt-msg opt-msg-error"; }
      return;
    }
    if (msg) { msg.textContent = ""; msg.className = "opt-msg"; }
    var m = $("#modal-pw-confirm"); if (m) m.classList.remove("open");
    pwStore.entries = []; pwStore.categories = [];
    pwSave(pwStore).then(() => { pwFilterQ = ""; pwFilterCat = "all";
      var si = $("#pw-search"); if (si) si.value = "";
      renderPasswords();
    });
  }).catch(function(e) {
    if (btn) btn.disabled = false;
    if (msg) { msg.textContent = "Une erreur est survenue."; msg.className = "opt-msg opt-msg-error"; }
  });
}

var pwcClose = $("#pwc-close"); if (pwcClose) pwcClose.addEventListener("click", () => { $("#modal-pw-confirm").classList.remove("open"); });
var pwcCancel = $("#pwc-cancel"); if (pwcCancel) pwcCancel.addEventListener("click", () => { $("#modal-pw-confirm").classList.remove("open"); });
var pwcConfirm = $("#pwc-confirm"); if (pwcConfirm) pwcConfirm.addEventListener("click", doClearPwVault);
var pwuClose = $("#pwu-close"); if (pwuClose) pwuClose.addEventListener("click", closePwUpgrade);
var pwuCancel = $("#pwu-cancel"); if (pwuCancel) pwuCancel.addEventListener("click", closePwUpgrade);
var pwuConfirm = $("#pwu-confirm"); if (pwuConfirm) pwuConfirm.addEventListener("click", confirmPwUpgrade);
var pwuNew = $("#pwu-new"); if (pwuNew) pwuNew.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); confirmPwUpgrade(); } });
var pwcInput = $("#pwc-password"); if (pwcInput) pwcInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); doClearPwVault(); } });
var pwSortIn = $("#pw-sort"); if (pwSortIn) pwSortIn.addEventListener("change", renderPasswords);

var pwmc = $("#pwm-close"); if (pwmc) pwmc.addEventListener("click", closePwModal);
var pwmcancel = $("#pwm-cancel"); if (pwmcancel) pwmcancel.addEventListener("click", closePwModal);
var pwmSave = $("#pwm-save"); if (pwmSave) pwmSave.addEventListener("click", savePwModal);
var pwmDel = $("#pwm-del"); if (pwmDel) pwmDel.addEventListener("click", () => {
  if (!pwEditId) return;
  if (confirm("Supprimer ce mot de passe ?")) {
    pwStore.entries = pwStore.entries.filter((x) => x.id !== pwEditId);
    pwSave(pwStore).then(() => { closePwModal(); renderPasswords(); });
  }
});
var pwmEye = $("#pwm-eye"); if (pwmEye) pwmEye.addEventListener("click", () => {
  const inp = $("#pwm-password");
  const show = inp.type === "password";
  inp.type = show ? "text" : "password";
  pwmEye.textContent = show ? "🙈" : "👁";
});
var pwmGen = $("#pwm-gen"); if (pwmGen) pwmGen.addEventListener("click", pwGenerate);
var pwmCatNew = $("#pwm-cat-new"); if (pwmCatNew) pwmCatNew.addEventListener("click", () => {
  const name = prompt("Nom de la nouvelle catégorie :");
  if (!name || !name.trim()) return;
  const id = pwAddCategory(name);
  pwSave(pwStore).then(() => {
    renderPwCatSelect(id);
    renderPasswords();
  });
});
var pwModalEl = $("#modal-pw"); if (pwModalEl) pwModalEl.addEventListener("click", (e) => { if (!e.target.closest(".modal")) closePwModal(); });

var pwipCancel = $("#pwip-cancel"); if (pwipCancel) pwipCancel.addEventListener("click", () => $("#modal-import-pw").classList.remove("open"));
var pwipClose = $("#pwip-close"); if (pwipClose) pwipClose.addEventListener("click", () => $("#modal-import-pw").classList.remove("open"));
var pwipFile = $("#pwip-file"); if (pwipFile) pwipFile.addEventListener("change", () => {
  const f = pwipFile.files && pwipFile.files[0];
  const msg = $("#pwip-msg");
  if (!f) { msg.textContent = ""; msg.className = "opt-msg"; $("#pwip-confirm").disabled = true; return; }
  const reader = new FileReader();
  reader.onload = () => {
    const { entries, format } = pwParseImport(pwParseCsv(String(reader.result)));
    pwipFile.dataset.entries = JSON.stringify(entries);
    if (entries.length) {
      msg.textContent = entries.length + " entrée(s) détectée(s)" + (format ? " (format " + format + ")" : "") + ".";
      msg.className = "opt-msg opt-msg-ok";
      $("#pwip-confirm").disabled = false;
    } else {
      msg.textContent = "Aucune entrée reconnue dans ce fichier.";
      msg.className = "opt-msg opt-msg-error";
      $("#pwip-confirm").disabled = true;
    }
  };
  reader.readAsText(f, "utf-8");
});
var pwipConfirm = $("#pwip-confirm"); if (pwipConfirm) pwipConfirm.addEventListener("click", () => {
  const entries = JSON.parse(pwipFile.dataset.entries || "[]");
  if (!entries.length) return;
  pwStore = pwStore || { categories: [], entries: [] };
  const now = Date.now();
  for (const e of entries) {
    e.id = pwGenId("pw"); e.createdAt = now; e.updatedAt = now; e.categoryId = ""; e.notes = e.notes || "";
    pwStore.entries.push(e);
  }
  pwSave(pwStore).then(() => {
    $("#modal-import-pw").classList.remove("open");
    renderPasswords();
  });
});
var pwimpOverlay = $("#modal-import-pw"); if (pwimpOverlay) pwimpOverlay.addEventListener("click", (e) => { if (!e.target.closest(".modal")) pwimpOverlay.classList.remove("open"); });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if ($("#modal-todo").classList.contains("open")) closeTodoModal();
    else if ($("#modal-tt").classList.contains("open")) closeTTModal();
    else if ($("#modal-ptask").classList.contains("open")) closePTaskModal();
    else if ($("#modal-yt").classList.contains("open")) closeYtModal();
    else if ($("#modal-proj").classList.contains("open")) closeProjectModal();
    else if ($("#modal").classList.contains("open")) closeModal();
    else if ($("#modal-pw").classList.contains("open")) closePwModal();
    else if ($("#modal-import-pw").classList.contains("open")) $("#modal-import-pw").classList.remove("open");
  }
});

/* ===================== Init ===================== */
async function init() {
  applyTheme();
  document.body.dataset.accent = "green";
  updateClock();
  setInterval(updateClock, 1000);

  // Event listeners pour la page de login
  document.getElementById("login-form").addEventListener("submit", handleLogin);
  var fpw = document.getElementById("forgot-pw");
  if (fpw) fpw.addEventListener("click", () => {
    if (!confirm("R\u00e9initialiser l'application ?\n\nTes donn\u00e9es sont chiffr\u00e9es avec ton mot de passe : sans lui, elles sont irr\u00e9cup\u00e9rables. La r\u00e9initialisation effacera TOUTES tes donn\u00e9es et ton profil.")) return;
    vaultCache.clear();
    vaultKey = null;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k !== LS_THEME) _rawRemove(k); // on garde le thème choisi
    }
    encQueue.clear();
    showLogin();
  });

  // Les données sont chiffrées avec le mot de passe : il est toujours demandé au démarrage
  showLogin();
}

init();
;
