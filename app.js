"use strict";

/* ===================== Config & backend ===================== */
const CFG = window.SUPABASE_CONFIG || {};
const CONFIGURED = !!CFG.url && !!CFG.anonKey &&
  !/VOTRE_|REMPLACEZ/i.test(String(CFG.url) + String(CFG.anonKey));

let supabaseClient = null;
let DEMO = false;

if (CONFIGURED && window.supabase && window.supabase.createClient) {
  supabaseClient = window.supabase.createClient(CFG.url, CFG.anonKey);
} else {
  DEMO = true;
}

/* session courante : { userId, email, username } */
let session = null;
let events = [];
let todos = [];
let ttActivities = [];       // activités récurrentes de l'emploi du temps
let ttCancellations = [];    // annulations ponctuelles (par semaine)
let ttSettings = null;       // null = emploi du temps pas encore créé ; sinon { slot_min }

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
const LS_USERS = "lm_users";
const LS_SESSION = "lm_session";
const LS_EVENTS = "lm_events";
const LS_TODOS = "lm_todos";
const LS_TT = "lm_tt_activities";
const LS_TTC = "lm_tt_cancellations";
const LS_TTS = "lm_tt_settings";

function lsGet(k, fallback) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; }
  catch (e) { return fallback; }
}
function lsSet(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
}

let todosDueColKnown = null; // null = inconnu ; true/false = colonne due_date presente
async function todosDueColumnExists() {
  if (todosDueColKnown !== null) return todosDueColKnown;
  try {
    const { error } = await supabaseClient.from("todos").select("due_date").limit(1);
    todosDueColKnown = !error;
  } catch (e) { todosDueColKnown = false; }
  return todosDueColKnown;
}

const Backend = {
  /* ---------- Authentification ---------- */
  async signUp(email, password, username) {
    if (DEMO) {
      const users = lsGet(LS_USERS, []);
      if (users.some((u) => u.email === email)) {
        throw new Error("Un compte existe déjà avec cet email.");
      }
      const user = { id: "u_" + Date.now().toString(36), email, password, username };
      users.push(user);
      lsSet(LS_USERS, users);
      session = { userId: user.id, email, username };
      lsSet(LS_SESSION, session);
      return session;
    }
    const { data, error } = await supabaseClient.auth.signUp({
      email, password,
      options: { data: { username } },
    });
    if (error) throw new Error(error.message);
    if (data.session) {
      session = { userId: data.user.id, email, username: data.user.user_metadata?.username || username };
      return session;
    }
    return null; // email de confirmation requis
  },

  async signIn(email, password) {
    if (DEMO) {
      const users = lsGet(LS_USERS, []);
      const u = users.find((x) => x.email === email && x.password === password);
      if (!u) throw new Error("Email ou mot de passe incorrect.");
      session = { userId: u.id, email: u.email, username: u.username };
      lsSet(LS_SESSION, session);
      return session;
    }
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    session = {
      userId: data.user.id,
      email: data.user.email,
      username: data.user.user_metadata?.username || data.user.email.split("@")[0],
    };
    return session;
  },

  async signOut() {
    if (!DEMO) await supabaseClient.auth.signOut();
    session = null;
    lsSet(LS_SESSION, null);
  },

  async getCurrentUser() {
    if (DEMO) { session = lsGet(LS_SESSION, null); return session; }
    const { data } = await supabaseClient.auth.getUser();
    if (data && data.user) {
      session = {
        userId: data.user.id,
        email: data.user.email,
        username: data.user.user_metadata?.username || data.user.email.split("@")[0],
      };
      return session;
    }
    session = null;
    return null;
  },

  /* ---------- Agenda (événements datés) ---------- */
  async loadEvents() {
    if (DEMO) { events = lsGet(LS_EVENTS + "_" + session.userId, []); return events; }
    const { data, error } = await supabaseClient.from("events").select("*").eq("user_id", session.userId);
    if (error) throw new Error(error.message);
    events = data || [];
    return events;
  },

  async saveEvent(ev) {
    if (DEMO) {
      if (ev.id) { const i = events.findIndex((e) => e.id === ev.id); if (i >= 0) events[i] = ev; else events.push(ev); }
      else { ev.id = "e_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); events.push(ev); }
      lsSet(LS_EVENTS + "_" + session.userId, events);
      return ev;
    }
    const row = { title: ev.title, start_at: ev.start_at, end_at: ev.end_at, all_day: ev.all_day };
    if (ev.id) {
      const { data, error } = await supabaseClient.from("events").update(row).eq("id", ev.id).select().single();
      if (error) throw new Error(error.message);
      return data;
    }
    const { data, error } = await supabaseClient.from("events")
      .insert({ ...row, user_id: session.userId }).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  async deleteEvent(id) {
    if (DEMO) { events = events.filter((e) => e.id !== id); lsSet(LS_EVENTS + "_" + session.userId, events); return; }
    const { error } = await supabaseClient.from("events").delete().eq("id", id);
    if (error) throw new Error(error.message);
  },

  /* ---------- Tâches ---------- */
  async loadTodos() {
    if (DEMO) { todos = lsGet(LS_TODOS + "_" + session.userId, []); return todos; }
    const { data, error } = await supabaseClient.from("todos").select("*").eq("user_id", session.userId);
    if (error) throw new Error(error.message);
    todos = data || [];
    return todos;
  },

  async saveTodo(t) {
    if (DEMO) {
      if (t.id) { const i = todos.findIndex((x) => x.id === t.id); if (i >= 0) todos[i] = t; else todos.push(t); }
      else { t.id = "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); todos.push(t); }
      lsSet(LS_TODOS + "_" + session.userId, todos);
      return t;
    }
    const row = { title: t.title, done: t.done, priority: t.priority };
    if (t.due_date !== undefined && t.due_date !== null) {
      if (await todosDueColumnExists()) {
        row.due_date = t.due_date;
      } else if (t.due_date) {
        throw new Error("Colonne due_date absente : exécute dans le SQL Editor Supabase : ALTER TABLE public.todos ADD COLUMN due_date date;");
      }
    }
    if (t.id) {
      const { data, error } = await supabaseClient.from("todos").update(row).eq("id", t.id).select().single();
      if (error) throw new Error(error.message);
      return data;
    }
    const { data, error } = await supabaseClient.from("todos")
      .insert({ ...row, user_id: session.userId }).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  async deleteTodo(id) {
    if (DEMO) { todos = todos.filter((t) => t.id !== id); lsSet(LS_TODOS + "_" + session.userId, todos); return; }
    const { error } = await supabaseClient.from("todos").delete().eq("id", id);
    if (error) throw new Error(error.message);
  },

  /* ---------- Emploi du temps (activités récurrentes) ---------- */
  async loadTimetable() {
    if (DEMO) {
      ttActivities = lsGet(LS_TT + "_" + session.userId, []);
      ttCancellations = lsGet(LS_TTC + "_" + session.userId, []);
      return { activities: ttActivities, cancellations: ttCancellations };
    }
    try {
      const [aRes, cRes] = await Promise.all([
        supabaseClient.from("timetable_activities").select("*").eq("user_id", session.userId),
        supabaseClient.from("timetable_cancellations").select("*"),
      ]);
      if (aRes.error) throw new Error(aRes.error.message);
      if (cRes.error) throw new Error(cRes.error.message);
      ttActivities = aRes.data || [];
      ttCancellations = cRes.data || [];
      return { activities: ttActivities, cancellations: ttCancellations };
    } catch (err) {
      // Tables pas encore créées : on ne bloque pas l'accès à l'app.
      if (/could not find the table|does not exist/i.test(String(err.message))) {
        ttActivities = [];
        ttCancellations = [];
        return { activities: [], cancellations: [] };
      }
      throw err;
    }
  },

  async saveTimetableActivity(a) {
    if (DEMO) {
      if (a.id) { const i = ttActivities.findIndex((x) => x.id === a.id); if (i >= 0) ttActivities[i] = a; else ttActivities.push(a); }
      else { a.id = "ta_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); ttActivities.push(a); }
      lsSet(LS_TT + "_" + session.userId, ttActivities);
      return a;
    }
    const row = {
      title: a.title,
      description: a.description || "",
      day_of_week: a.day_of_week,
      start_time: a.start_time,
      end_time: a.end_time,
    };
    if (a.id) {
      const { data, error } = await supabaseClient.from("timetable_activities").update(row).eq("id", a.id).select().single();
      if (error) throw new Error(error.message);
      return data;
    }
    const { data, error } = await supabaseClient.from("timetable_activities")
      .insert({ ...row, user_id: session.userId }).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  async deleteTimetableActivity(id) {
    if (DEMO) {
      ttActivities = ttActivities.filter((a) => a.id !== id);
      ttCancellations = ttCancellations.filter((c) => c.activity_id !== id);
      lsSet(LS_TT + "_" + session.userId, ttActivities);
      lsSet(LS_TTC + "_" + session.userId, ttCancellations);
      return;
    }
    const { error } = await supabaseClient.from("timetable_activities").delete().eq("id", id);
    if (error) throw new Error(error.message);
  },

  async cancelActivityForWeek(activityId) {
    const weekStart = currentWeekStartKey();
    if (DEMO) {
      if (!ttCancellations.some((c) => c.activity_id === activityId && c.week_start === weekStart)) {
        ttCancellations.push({ activity_id: activityId, week_start: weekStart });
        lsSet(LS_TTC + "_" + session.userId, ttCancellations);
      }
      return;
    }
    const { error } = await supabaseClient.from("timetable_cancellations")
      .upsert({ activity_id: activityId, week_start: weekStart }, { onConflict: "activity_id,week_start" });
    if (error) throw new Error(error.message);
  },

  async reactivateActivity(activityId) {
    const weekStart = currentWeekStartKey();
    if (DEMO) {
      ttCancellations = ttCancellations.filter((c) => !(c.activity_id === activityId && c.week_start === weekStart));
      lsSet(LS_TTC + "_" + session.userId, ttCancellations);
      return;
    }
    const { error } = await supabaseClient.from("timetable_cancellations")
      .delete().eq("activity_id", activityId).eq("week_start", weekStart);
    if (error) throw new Error(error.message);
  },

  /* ---------- Emploi du temps (réglages : découpage horaire) ---------- */
  async loadTimetableSettings() {
    if (DEMO) {
      ttSettings = lsGet(LS_TTS + "_" + session.userId, null);
      return ttSettings;
    }
    try {
      const { data, error } = await supabaseClient.from("timetable_settings")
        .select("*").eq("user_id", session.userId).maybeSingle();
      if (error) throw new Error(error.message);
      ttSettings = data || null;
      return ttSettings;
    } catch (err) {
      if (/could not find the table|does not exist/i.test(String(err.message))) {
        ttSettings = null;
        return null;
      }
      throw err;
    }
  },

  async saveTimetableSettings(slotMin) {
    if (DEMO) {
      ttSettings = { user_id: session.userId, slot_min: slotMin, created_at: new Date().toISOString() };
      lsSet(LS_TTS + "_" + session.userId, ttSettings);
      return ttSettings;
    }
    const { data, error } = await supabaseClient.from("timetable_settings")
      .upsert({ user_id: session.userId, slot_min: slotMin }, { onConflict: "user_id" }).select().single();
    if (error) throw new Error(error.message);
    ttSettings = data;
    return data;
  },
};

/* ===================== Authentification (UI) ===================== */
let authMode = "login";

function switchAuthMode(mode) {
  authMode = mode;
  $("#auth-tab-login").classList.toggle("active", mode === "login");
  $("#auth-tab-signup").classList.toggle("active", mode === "signup");
  $("#auth-username-wrap").classList.toggle("hidden", mode === "login");
  $("#auth-submit").textContent = mode === "login" ? "Se connecter" : "Créer mon compte";
  $("#auth-title").textContent = mode === "login" ? "Content de te revoir" : "Créer un compte";
  $("#auth-subtitle").textContent = mode === "login"
    ? "Connecte-toi pour retrouver ton espace."
    : "Rejoins Life Manager en quelques secondes.";
  hideAuthError();
}

function showAuthError(msg) { $("#auth-error").textContent = msg; }
function hideAuthError() { $("#auth-error").textContent = ""; }
function setAuthLoading(loading) {
  $("#auth-submit").disabled = loading;
  $("#auth-submit").textContent = loading ? "Chargement…" : (authMode === "login" ? "Se connecter" : "Créer mon compte");
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  const username = $("#auth-username").value.trim();
  hideAuthError();

  if (!email || !password) return showAuthError("Renseigne l'email et le mot de passe.");
  if (authMode === "signup") {
    if (password.length < 6) return showAuthError("Le mot de passe doit faire au moins 6 caractères.");
    if (!username) return showAuthError("Choisis un nom d'utilisateur.");
  }

  setAuthLoading(true);
  try {
    if (authMode === "signup") {
      const s = await Backend.signUp(email, password, username);
      if (!s) {
        showAuthError("Compte créé ! Vérifie ta boîte mail pour le confirmer, puis connecte-toi.");
        switchAuthMode("login");
        return;
      }
      await enterApp();
    } else {
      await Backend.signIn(email, password);
      await enterApp();
    }
  } catch (err) {
    showAuthError(err.message || "Une erreur est survenue.");
  } finally {
    setAuthLoading(false);
  }
}

async function enterApp() {
  await Backend.loadEvents();
  await Backend.loadTodos();
  await Backend.loadTimetable();
  await Backend.loadTimetableSettings();
  $("#view-auth").classList.add("hidden");
  $("#view-app").classList.remove("hidden");
  $("#sidebar-username").textContent = session.username;
  $("#sidebar-email").textContent = session.email;
  navigate("dashboard");
}

function showAuth() {
  document.body.dataset.accent = "green";
  $("#view-app").classList.add("hidden");
  $("#view-auth").classList.remove("hidden");
  $("#auth-password").value = "";
  hideAuthError();
}

/* ===================== Navigation ===================== */
const PAGES = ["dashboard", "schedule", "timetable", "todos"];
const ACCENTS = { dashboard: "green", schedule: "blue", timetable: "violet", todos: "yellow" };

function navigate(page) {
  PAGES.forEach((p) => {
    $("#page-" + p).classList.toggle("hidden", p !== page);
    $("#nav-" + p).classList.toggle("active", p === page);
  });
  document.body.dataset.accent = ACCENTS[page] || "green";
  if (page === "dashboard") renderDashboard();
  if (page === "schedule") renderSchedule();
  if (page === "timetable") renderTimetable();
  if (page === "todos") renderTodos();
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
}

function updateClock() {
  const now = new Date();
  $("#dash-clock").textContent = now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

/* ===================== Agenda (événements datés) ===================== */
const cal = { view: "month", cursor: new Date() };
let modalEventId = null;

function setCalView(view) { cal.view = view; renderSchedule(); }

function calPrev() {
  if (cal.view === "day") cal.cursor = addDays(cal.cursor, -1);
  else if (cal.view === "week") cal.cursor = addDays(cal.cursor, -7);
  else if (cal.view === "month") cal.cursor = addMonths(cal.cursor, -1);
  else cal.cursor = addYears(cal.cursor, -1);
  renderSchedule();
}
function calNext() {
  if (cal.view === "day") cal.cursor = addDays(cal.cursor, 1);
  else if (cal.view === "week") cal.cursor = addDays(cal.cursor, 7);
  else if (cal.view === "month") cal.cursor = addMonths(cal.cursor, 1);
  else cal.cursor = addYears(cal.cursor, 1);
  renderSchedule();
}
function calToday() { cal.cursor = new Date(); renderSchedule(); }

function calLabel() {
  const d = cal.cursor;
  if (cal.view === "day") return fmtDateLong(d);
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
  else if (cal.view === "day") renderDay(c);
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

function renderDay(c) {
  const key = dayKey(cal.cursor);
  const vis = visibleEvents();
  const dayEvents = sortEvents(vis.filter((e) => eventDayKey(e) === key));
  const allDay = dayEvents.filter((e) => e.all_day);
  const timed = dayEvents.filter((e) => !e.all_day);

  let html = '<div class="day-head"><span>' + fmtDateLong(cal.cursor) + '</span>' +
    '<button class="cell-add" data-key="' + key + '" style="opacity:1">＋</button></div>';
  if (allDay.length) html += '<div class="day-allday">' + allDay.map(eventItem).join("") + '</div>';

  html += '<div class="day-cols">' + dayCol(0, 12, timed) + dayCol(12, 24, timed) + '</div>';
  c.innerHTML = html;
}

function dayCol(from, to, timed) {
  let html = '<div class="day-col"><div class="day-col-head">' + pad(from) + ':00 – ' + pad(to) + ':00</div>' +
    '<div class="day-hours">';
  for (let h = from; h < to; h++) {
    const hourEvents = timed.filter((e) => new Date(e.start_at).getHours() === h);
    html += '<div class="hour-row"><span class="hour-label">' + pad(h) + ':00</span>' +
      '<div class="hour-events">' + hourEvents.map(eventItem).join("") + '</div></div>';
  }
  html += '</div></div>';
  return html;
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
    await Backend.saveEvent({ id: modalEventId, title, start_at, end_at, all_day: allDay });
    await Backend.loadEvents();
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
    await Backend.deleteEvent(modalEventId);
    await Backend.loadEvents();
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
const SLOT_H30 = 22;   // hauteur (px) d'un créneau de 30 min
const TT_MAX_PER_CELL = 3;

let ttEditMode = false;
let ttModalMode = null;       // "add" | "edit" | "view"
let ttModalActivityId = null;
let ttPendingDay = 0;
let ttPendingStart = "08:00";
let ttLanePref = {};          // preference de couloir (session, mode edition)
let ttPendingCol = -1;        // couloir choisi a l'ajout

function ttSlotMin() { return (ttSettings && ttSettings.slot_min) || 60; }
function ttRowH() { return SLOT_H30 * (ttSlotMin() / 30); }
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
  const banner = $("#tt-banner");

  if (ttSettings === null && ttActivities.length === 0 && !ttEditMode) {
    grid.classList.add("hidden");
    emptyEl.classList.remove("hidden");
    editBtn.hidden = true;
    banner.classList.add("hidden");
    return;
  }

  grid.classList.remove("hidden");
  emptyEl.classList.add("hidden");
  editBtn.hidden = false;
  editBtn.textContent = ttEditMode ? "Terminer" : "Modifier";
  banner.classList.toggle("hidden", !ttEditMode);
  grid.classList.toggle("editing", ttEditMode);
  $("#tt-slot").value = String(ttSlotMin());
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
      html += '<button class="tt-activity c' + activityColorIndex(a) + (L.cancelled ? " cancelled" : "") + (ttEditMode || L.wf < 0.45 ? " crowded" : "") + '"' +
        ' style="top:' + (L.s * rowH) + 'px;height:' + (L.dur * rowH - 2) + 'px;' +
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
    const saved = await Backend.saveTimetableActivity(candidate);
    await Backend.loadTimetable();
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
    await Backend.saveTodo({
      id: todoModalId,
      title,
      done: $("#todox-done").checked,
      priority: $("#todox-priority").value,
      due_date: $("#todox-due").value || null,
    });
    await Backend.loadTodos();
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
    await Backend.deleteTodo(todoModalId);
    await Backend.loadTodos();
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
    await Backend.saveTodo({ id: null, title, done: false, priority, due_date: dueDate });
    await Backend.loadTodos();
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
      await Backend.saveTodo({ ...t, done: !t.done });
    } else if (act === "del") {
      await Backend.deleteTodo(id);
    } else if (act === "edit") {
      openTodoModal(t);
      return;
    } else {
      return;
    }
    await Backend.loadTodos();
    renderTodos();
    renderDashboard();
  } catch (err) {
    alert(err.message || "Erreur.");
  }
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
$("#auth-tab-login").addEventListener("click", () => switchAuthMode("login"));
$("#auth-tab-signup").addEventListener("click", () => switchAuthMode("signup"));
$("#auth-form").addEventListener("submit", handleAuthSubmit);

$("#nav-dashboard").addEventListener("click", () => navigate("dashboard"));
$("#nav-schedule").addEventListener("click", () => navigate("schedule"));
$("#nav-timetable").addEventListener("click", () => navigate("timetable"));
$("#nav-todos").addEventListener("click", () => navigate("todos"));
$("#btn-logout").addEventListener("click", async () => {
  await Backend.signOut();
  showAuth();
});
$("#btn-theme").addEventListener("click", toggleTheme);

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
  if (cell) { cal.view = "day"; cal.cursor = parseDay(cell.dataset.key); renderSchedule(); }
});

$("#ev-allday").addEventListener("change", toggleAllDay);
$("#modal-save").addEventListener("click", submitEvent);
$("#modal-delete").addEventListener("click", deleteEventFromModal);
$("#modal-cancel").addEventListener("click", closeModal);
$("#modal").addEventListener("click", (e) => { if (!e.target.closest(".modal")) closeModal(); });

/* Emploi du temps */
$("#tt-create").addEventListener("click", async () => {
  try {
    await Backend.saveTimetableSettings(60);
    ttEditMode = true;
    renderTimetable();
  } catch (err) {
    alert(err.message || "Erreur lors de la création.");
  }
});
$("#tt-edit").addEventListener("click", () => { ttEditMode = !ttEditMode; renderTimetable(); });
$("#tt-slot").addEventListener("change", async () => {
  try {
    await Backend.saveTimetableSettings(Number($("#tt-slot").value));
    renderTimetable();
  } catch (err) {
    alert(err.message || "Erreur lors de l'enregistrement du découpage.");
  }
});
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
      if (cancelled) await Backend.reactivateActivity(a.id);
      else await Backend.cancelActivityForWeek(a.id);
      await Backend.loadTimetable();
      renderTimetable();
      openTTActivity(a.id, "view");
    } else if (act === "save") {
      await saveTTActivityFromModal();
    } else if (act === "del") {
      if (!a) return;
      delete ttLanePref[a.id];
      await Backend.deleteTimetableActivity(a.id);
      await Backend.loadTimetable();
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

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if ($("#modal-todo").classList.contains("open")) closeTodoModal();
    else if ($("#modal-tt").classList.contains("open")) closeTTModal();
    else if ($("#modal").classList.contains("open")) closeModal();
  }
});

/* ===================== Init ===================== */
async function init() {
  applyTheme();
  document.body.dataset.accent = "green";
  if (DEMO) $("#auth-demo-banner").classList.remove("hidden");
  switchAuthMode("login");
  updateClock();
  setInterval(updateClock, 30000);

  try {
    const s = await Backend.getCurrentUser();
    if (s) await enterApp();
    else showAuth();
  } catch (err) {
    showAuth();
  }
}

init();
