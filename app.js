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
let weatherCache = null;      // { lat, lon, city, current, daily, fetchedAt }
let weatherCity = null;       // ville manuelle
let projects = [];
let projectTasks = [];
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
const LS_USERS = "lm_users";
const LS_SESSION = "lm_session";
const LS_EVENTS = "lm_events";
const LS_TODOS = "lm_todos";
const LS_TT = "lm_tt_activities";
const LS_TTC = "lm_tt_cancellations";
const LS_TTS = "lm_tt_settings";
const LS_WEATHER = "lm_weather";
const LS_WEATHER_CITY = "lm_weather_city";
const LS_PROJECTS = "lm_projects";
const LS_PROJECT_TASKS = "lm_project_tasks";

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
  await Backend.loadProjects();
  await Backend.loadProjectTasks();
  loadWeatherCache();
  fetchWeather(false);
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
const PAGES = ["dashboard", "schedule", "timetable", "todos", "weather", "projects"];
const ACCENTS = { dashboard: "green", schedule: "blue", timetable: "violet", todos: "yellow", weather: "cyan", projects: "green" };

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
  if (page === "weather") renderWeatherPage();
  if (page === "projects") renderProjects();
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
  const exportBtn = $("#tt-export");
  const banner = $("#tt-banner");

  if (ttSettings === null && ttActivities.length === 0 && !ttEditMode) {
    grid.classList.add("hidden");
    emptyEl.classList.remove("hidden");
    editBtn.hidden = true;
    exportBtn.hidden = true;
    banner.classList.add("hidden");
    return;
  }

  grid.classList.remove("hidden");
  emptyEl.classList.add("hidden");
  editBtn.hidden = false;
  editBtn.textContent = ttEditMode ? "Terminer" : "Modifier";
  exportBtn.hidden = ttEditMode;
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

const BackendProj = {
  async loadProjects() {
    if (DEMO) { projects = lsGet(LS_PROJECTS + "_" + session.userId, []); return projects; }
    try {
      const { data, error } = await supabaseClient.from("projects").select("*").eq("user_id", session.userId).order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      projects = data || [];
      return projects;
    } catch (err) {
      if (/could not find the table|does not exist/i.test(String(err.message))) { projects = []; return []; }
      throw err;
    }
  },
  async loadProjectTasks() {
    if (DEMO) { projectTasks = lsGet(LS_PROJECT_TASKS + "_" + session.userId, []); return projectTasks; }
    try {
      const { data, error } = await supabaseClient.from("project_tasks").select("*").eq("user_id", session.userId).order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      projectTasks = data || [];
      return projectTasks;
    } catch (err) {
      if (/could not find the table|does not exist/i.test(String(err.message))) { projectTasks = []; return []; }
      throw err;
    }
  },
  async saveProject(proj) {
    if (DEMO) {
      if (proj.id) { const i = projects.findIndex((p) => p.id === proj.id); if (i >= 0) projects[i] = proj; else projects.push(proj); }
      else { proj.id = "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); projects.unshift(proj); }
      lsSet(LS_PROJECTS + "_" + session.userId, projects);
      return proj;
    }
    const row = { name: proj.name, description: proj.description || "" };
    if (proj.id) {
      const { data, error } = await supabaseClient.from("projects").update(row).eq("id", proj.id).select().single();
      if (error) throw new Error(error.message);
      return data;
    }
    const { data, error } = await supabaseClient.from("projects").insert({ ...row, user_id: session.userId }).select().single();
    if (error) throw new Error(error.message);
    return data;
  },
  async deleteProject(id) {
    if (DEMO) {
      projects = projects.filter((p) => p.id !== id);
      projectTasks = projectTasks.filter((t) => t.project_id !== id);
      lsSet(LS_PROJECTS + "_" + session.userId, projects);
      lsSet(LS_PROJECT_TASKS + "_" + session.userId, projectTasks);
      return;
    }
    const { error } = await supabaseClient.from("projects").delete().eq("id", id);
    if (error) throw new Error(error.message);
  },
  async saveProjectTask(t) {
    if (DEMO) {
      if (t.id) { const i = projectTasks.findIndex((x) => x.id === t.id); if (i >= 0) projectTasks[i] = t; else projectTasks.push(t); }
      else { t.id = "pt_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); projectTasks.push(t); }
      lsSet(LS_PROJECT_TASKS + "_" + session.userId, projectTasks);
      return t;
    }
    const row = { title: t.title, done: t.done, project_id: t.project_id };
    if (t.id) {
      const { data, error } = await supabaseClient.from("project_tasks").update(row).eq("id", t.id).select().single();
      if (error) throw new Error(error.message);
      return data;
    }
    const { data, error } = await supabaseClient.from("project_tasks").insert({ ...row, user_id: session.userId }).select().single();
    if (error) throw new Error(error.message);
    return data;
  },
  async deleteProjectTask(id) {
    if (DEMO) { projectTasks = projectTasks.filter((t) => t.id !== id); lsSet(LS_PROJECT_TASKS + "_" + session.userId, projectTasks); return; }
    const { error } = await supabaseClient.from("project_tasks").delete().eq("id", id);
    if (error) throw new Error(error.message);
  },
};

Object.assign(Backend, BackendProj);
function renderProjects() {
  projectDetailId = null;
  $("#proj-list").classList.remove("hidden");
  $("#proj-detail").classList.add("hidden");
  if (!projects.length) {
    $("#proj-list").innerHTML = "<p class='empty'>Aucun projet. Cree ton premier projet !</p>";
    return;
  }
  var html = "";
  for (var i = 0; i < projects.length; i++) {
    var p = projects[i];
    var tasks = projectTasks.filter(function(t) { return t.project_id === p.id; });
    var done = tasks.filter(function(t) { return t.done; }).length;
    var pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
    html += "<button class='proj-card' data-id='" + p.id + "'>" +
      "<div class='proj-name'>" + esc(p.name) + "</div>" +
      "<div class='proj-desc-line'>" + esc((p.description || "").slice(0, 80) + (p.description && p.description.length > 80 ? "..." : "")) + "</div>" +
      "<div class='proj-bar-wrap'><div class='proj-bar'><div class='proj-bar-fill' style='width:" + pct + "%'></div></div>" +
      "<span class='proj-pct'>" + pct + "%</span></div>" +
      "</button>";
  }
  $("#proj-list").innerHTML = html;
}

function renderProjectDetail(projId) {
  projectDetailId = projId;
  var p = projects.find(function(x) { return x.id === projId; });
  if (!p) return renderProjects();
  $("#proj-list").classList.add("hidden");
  var detail = $("#proj-detail");
  detail.classList.remove("hidden");
  var tasks = projectTasks.filter(function(t) { return t.project_id === projId; });
  var done = tasks.filter(function(t) { return t.done; }).length;
  var pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  var html = "<div class='proj-detail-head'>" +
    "<button class='btn-ghost proj-back' type='button'>Retour</button>" +
    "<div><h2>" + esc(p.name) + "</h2>" +
    "<button class='btn-ghost proj-edit-btn' data-id='" + p.id + "' type='button'>Modifier</button></div>" +
    "</div>" +
    "<div class='proj-progress'><div class='proj-bar'><div class='proj-bar-fill' style='width:" + pct + "%'></div></div>" +
    "<span class='proj-pct'>" + done + " / " + tasks.length + " (" + pct + "%)</span></div>" +
    "<div class='proj-detail-cols'>" +
    "<div class='proj-detail-desc'><h3>Description</h3>" +
    "<textarea id='proj-desc-edit' rows='6' placeholder='Objectif, idees, avancement...'>" + esc(p.description || "") + "</textarea>" +
    "<button id='proj-desc-save' class='btn-ghost' type='button'>Enregistrer la description</button></div>" +
    "<div class='proj-detail-tasks'><h3>Taches</h3>" +
    "<div class='proj-task-add'><input id='proj-task-input' type='text' placeholder='Ajouter une tache...'>" +
    "<button id='proj-task-add-btn' class='btn-primary' type='button'>+</button></div>" +
    "<ul class='proj-task-list'>" + tasks.map(function(t) {
      return "<li class='proj-task" + (t.done ? " done" : "") + "' data-id='" + t.id + "'>" +
        "<button class='todo-check' data-act='ptoggle'>" + (t.done ? "OK" : "") + "</button>" +
        "<span class='proj-task-title'>" + esc(t.title) + "</span>" +
        "<button class='todo-del' data-act='pdel'>X</button></li>";
    }).join("") + "</ul></div></div>";
  detail.innerHTML = html;
  var pti = $("#proj-task-input");
  if (pti) pti.addEventListener("keydown", function(e) { if (e.key === "Enter") addProjectTask(); });
}

function openProjectModal(proj) {
  projModalId = proj ? proj.id : null;
  $("#projm-title").textContent = proj ? "Modifier le projet" : "Nouveau projet";
  $("#projm-name").value = proj ? proj.name : "";
  $("#projm-desc").value = proj ? (proj.description || "") : "";
  $("#projm-del").style.display = proj ? "" : "none";
  $("#modal-proj").classList.add("open");
  setTimeout(function() { $("#projm-name").focus(); }, 60);
}

function closeProjectModal() {
  $("#modal-proj").classList.remove("open");
  projModalId = null;
}

async function saveProjectFromModal() {
  var name = $("#projm-name").value.trim();
  if (!name) { $("#projm-name").focus(); return; }
  try {
    await Backend.saveProject({ id: projModalId, name: name, description: $("#projm-desc").value.trim() });
    await Backend.loadProjects();
    closeProjectModal();
    if (projectDetailId) renderProjectDetail(projectDetailId);
    else renderProjects();
  } catch (err) { alert(err.message || "Erreur lors de l'enregistrement."); }
}

async function deleteProjectFromModal() {
  if (!projModalId) return;
  try {
    await Backend.deleteProject(projModalId);
    await Backend.loadProjects();
    await Backend.loadProjectTasks();
    closeProjectModal();
    projectDetailId = null;
    renderProjects();
  } catch (err) { alert(err.message || "Erreur lors de la suppression."); }
}

async function addProjectTask() {
  if (!projectDetailId) return;
  var input = $("#proj-task-input");
  var title = input.value.trim();
  if (!title) return;
  try {
    await Backend.saveProjectTask({ id: null, project_id: projectDetailId, title: title, done: false });
    await Backend.loadProjectTasks();
    input.value = "";
    renderProjectDetail(projectDetailId);
  } catch (err) { alert(err.message || "Erreur lors de l'ajout."); }
}

async function handleProjectTaskClick(e) {
  var li = e.target.closest(".proj-task");
  if (!li) return;
  var id = li.dataset.id;
  var actEl = e.target.closest("[data-act]");
  if (!actEl) return;
  var act = actEl.dataset.act;
  var t = projectTasks.find(function(x) { return x.id === id; });
  if (!t) return;
  try {
    if (act === "ptoggle") {
      await Backend.saveProjectTask({ id: t.id, project_id: t.project_id, title: t.title, done: !t.done });
    } else if (act === "pdel") {
      await Backend.deleteProjectTask(id);
    }
    await Backend.loadProjectTasks();
    if (projectDetailId) renderProjectDetail(projectDetailId);
  } catch (err) { alert(err.message || "Erreur."); }
}

async function saveProjectDesc() {
  if (!projectDetailId) return;
  var p = projects.find(function(x) { return x.id === projectDetailId; });
  if (!p) return;
  p.description = $("#proj-desc-edit").value;
  try {
    await Backend.saveProject(p);
    await Backend.loadProjects();
    alert("Description enregistree !");
  } catch (err) { alert(err.message || "Erreur."); }
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
$("#nav-weather").addEventListener("click", () => navigate("weather"));
$("#nav-projects").addEventListener("click", () => navigate("projects"));
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
$("#tt-export").addEventListener("click", () => { window.print(); });
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

var wcb = $("#weather-city-btn"); if (wcb) wcb.addEventListener("click", searchWeatherCity);
var wcs = $("#weather-city-search"); if (wcs) wcs.addEventListener("keydown", (e) => { if (e.key === "Enter") searchWeatherCity(); });

var pn = $("#proj-new"); if (pn) pn.addEventListener("click", () => openProjectModal(null));
var pl = $("#proj-list"); if (pl) pl.addEventListener("click", (e) => {
  const card = e.target.closest(".proj-card");
  if (card) renderProjectDetail(card.dataset.id);
});
var pd = $("#proj-detail"); if (pd) pd.addEventListener("click", (e) => {
  const back = e.target.closest(".proj-back");
  if (back) renderProjects();
  const edit = e.target.closest(".proj-edit-btn");
  if (edit) { const p = projects.find((x) => x.id === edit.dataset.id); if (p) openProjectModal(p); }
  const saveDesc = e.target.closest("#proj-desc-save");
  if (saveDesc) saveProjectDesc();
  const taskAdd = e.target.closest("#proj-task-add-btn");
  if (taskAdd) addProjectTask();
  if (e.target.closest(".proj-task")) handleProjectTaskClick(e);
});

var ps = $("#projm-save"); if (ps) ps.addEventListener("click", saveProjectFromModal);
var pdl = $("#projm-del"); if (pdl) pdl.addEventListener("click", deleteProjectFromModal);
var pc = $("#projm-cancel"); if (pc) pc.addEventListener("click", closeProjectModal);
var pcl = $("#projm-close"); if (pcl) pcl.addEventListener("click", closeProjectModal);
var mp = $("#modal-proj"); if (mp) mp.addEventListener("click", (e) => { if (!e.target.closest(".modal")) closeProjectModal(); });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if ($("#modal-todo").classList.contains("open")) closeTodoModal();
    else if ($("#modal-tt").classList.contains("open")) closeTTModal();
    else if ($("#modal-proj").classList.contains("open")) closeProjectModal();
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
