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
function isoWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}
function eventDayKey(e) { return dayKey(new Date(e.start_at)); }
function eventTime(e) { return fmtTime(new Date(e.start_at)); }

/* ===================== Backend (Supabase ou démo) ===================== */
const LS_USERS = "lm_users";
const LS_SESSION = "lm_session";
const LS_EVENTS = "lm_events";
const LS_TODOS = "lm_todos";

function lsGet(k, fallback) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; }
  catch (e) { return fallback; }
}
function lsSet(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
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

  /* ---------- Événements ---------- */
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
  $("#view-auth").classList.add("hidden");
  $("#view-app").classList.remove("hidden");
  $("#sidebar-username").textContent = session.username;
  $("#sidebar-email").textContent = session.email;
  navigate("dashboard");
}

function showAuth() {
  $("#view-app").classList.add("hidden");
  $("#view-auth").classList.remove("hidden");
  $("#auth-password").value = "";
  hideAuthError();
}

/* ===================== Navigation ===================== */
const PAGES = ["dashboard", "schedule", "todos"];

function navigate(page) {
  PAGES.forEach((p) => {
    $("#page-" + p).classList.toggle("hidden", p !== page);
    $("#nav-" + p).classList.toggle("active", p === page);
  });
  if (page === "dashboard") renderDashboard();
  if (page === "schedule") renderSchedule();
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
  const pendingTodos = todos.filter((t) => !t.done);

  $("#dash-event-today").textContent = todayEvents.length;
  $("#dash-todo-pending").textContent = pendingTodos.length;

  const upcoming = events.filter((e) => new Date(e.start_at) >= now)
    .sort((a, b) => (a.start_at < b.start_at ? -1 : 1))[0];
  $("#dash-next-event").textContent = upcoming
    ? (upcoming.title + " · " + fmtDateShort(new Date(upcoming.start_at)) + (upcoming.all_day ? "" : " · " + eventTime(upcoming)))
    : "Aucun événement à venir";

  $("#dash-today-list").innerHTML = todayEvents.length
    ? todayEvents.map((ev) =>
        '<div class="dash-event"><span class="time">' + (ev.all_day ? "Journée" : eventTime(ev)) + '</span>' +
        '<span class="title">' + esc(ev.title) + '</span></div>'
      ).join("")
    : "<p class='empty'>Rien de prévu aujourd'hui 🎉</p>";

  $("#dash-todos-list").innerHTML = pendingTodos.length
    ? '<ul class="dash-todo">' + pendingTodos.slice(0, 5).map((t) => '<li>' + esc(t.title) + '</li>').join("") + '</ul>'
    : '<p class="empty">Toutes les tâches sont terminées ✅</p>';
}

function updateClock() {
  const now = new Date();
  $("#dash-clock").textContent = now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

/* ===================== Emploi du temps ===================== */
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
  let html = '<div class="cal-grid">' +
    DAYS_SHORT.map((x) => '<div class="cal-dow">' + x + '</div>').join("");

  for (let i = 0; i < 42; i++) {
    const key = dayKey(d);
    const inMonth = d.getMonth() === cal.cursor.getMonth();
    const dayEvents = sortEvents(events.filter((e) => eventDayKey(e) === key));
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
  let html = '<div class="cal-week">';
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    const key = dayKey(d);
    const dayEvents = sortEvents(events.filter((e) => eventDayKey(e) === key));
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
  const dayEvents = sortEvents(events.filter((e) => eventDayKey(e) === key));
  const allDay = dayEvents.filter((e) => e.all_day);
  const timed = dayEvents.filter((e) => !e.all_day);

  let html = '<div class="day-head"><span>' + fmtDateLong(cal.cursor) + '</span>' +
    '<button class="cell-add" data-key="' + key + '" style="opacity:1">＋</button></div>';
  if (allDay.length) html += '<div class="day-allday">' + allDay.map(eventItem).join("") + '</div>';

  html += '<div class="day-hours">';
  for (let h = 6; h <= 22; h++) {
    const hourEvents = timed.filter((e) => new Date(e.start_at).getHours() === h);
    html += '<div class="hour-row"><span class="hour-label">' + pad(h) + ':00</span>' +
      '<div class="hour-events">' + hourEvents.map(eventItem).join("") + '</div></div>';
  }
  html += '</div>';
  c.innerHTML = html;
}

function renderYear(c) {
  const year = cal.cursor.getFullYear();
  let html = '<div class="year-grid">';
  for (let m = 0; m < 12; m++) {
    const first = new Date(year, m, 1);
    const count = events.filter((e) => {
      const dt = new Date(e.start_at);
      return dt.getFullYear() === year && dt.getMonth() === m;
    }).length;
    html += '<div class="year-month" data-month="' + m + '">' +
      '<div class="ym-head">' + MONTHS[m] + '</div>' +
      '<div class="ym-grid">' + DAYS_SHORT.map((x) => '<span class="ym-dow">' + x[0] + '</span>').join("") + renderYearDays(first) + '</div>' +
      '<div class="ym-count">' + count + ' événement(s)</div></div>';
  }
  html += '</div>';
  c.innerHTML = html;
}

function renderYearDays(first) {
  const keys = new Set(events.map(eventDayKey));
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

/* ===================== Modale événement ===================== */
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

/* ===================== To-Do ===================== */
let todoFilter = "all";

const PRIO_LABEL = { high: "Haute", medium: "Moyenne", low: "Basse" };
const PRIO_ORDER = ["low", "medium", "high"];

function renderTodos() {
  const list = todos.filter((t) =>
    todoFilter === "all" ? true : (todoFilter === "done" ? t.done : !t.done)
  );
  $("#todo-list").innerHTML = list.length
    ? list.map(todoItem).join("")
    : '<p class="empty">' + (todoFilter === "done" ? "Aucune tâche terminée" : todoFilter === "active" ? "Aucune tâche en cours 🎉" : "Aucune tâche") + '</p>';

  const done = todos.filter((t) => t.done).length;
  const pct = todos.length ? Math.round((done / todos.length) * 100) : 0;
  $("#todo-progress-fill").style.width = pct + "%";
  $("#todo-progress-label").textContent = done + " / " + todos.length;
}

function todoItem(t) {
  const prio = t.priority || "medium";
  return '<li class="todo' + (t.done ? " done" : "") + '" data-id="' + t.id + '">' +
    '<button class="todo-check" data-act="toggle" title="Terminer">' + (t.done ? "✓" : "") + '</button>' +
    '<span class="todo-title">' + esc(t.title) + '</span>' +
    '<button class="prio prio-' + prio + '" data-act="prio" title="Changer la priorité">' + PRIO_LABEL[prio] + '</button>' +
    '<button class="todo-del" data-act="del" title="Supprimer">🗑</button>' +
    '</li>';
}

async function addTodo() {
  const input = $("#todo-input");
  const title = input.value.trim();
  if (!title) return;
  const priority = $("#todo-priority").value;
  try {
    await Backend.saveTodo({ id: null, title, done: false, priority });
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
    } else if (act === "prio") {
      const i = PRIO_ORDER.indexOf(t.priority || "medium");
      await Backend.saveTodo({ ...t, priority: PRIO_ORDER[(i + 1) % 3] });
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

/* ===================== Écouteurs ===================== */
$("#auth-tab-login").addEventListener("click", () => switchAuthMode("login"));
$("#auth-tab-signup").addEventListener("click", () => switchAuthMode("signup"));
$("#auth-form").addEventListener("submit", handleAuthSubmit);

$("#nav-dashboard").addEventListener("click", () => navigate("dashboard"));
$("#nav-schedule").addEventListener("click", () => navigate("schedule"));
$("#nav-todos").addEventListener("click", () => navigate("todos"));
$("#btn-logout").addEventListener("click", async () => {
  await Backend.signOut();
  showAuth();
});

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

$("#todo-add").addEventListener("click", addTodo);
$("#todo-input").addEventListener("keydown", (e) => { if (e.key === "Enter") addTodo(); });
$("#todo-list").addEventListener("click", handleTodoListClick);
$$(".tf").forEach((b) => b.addEventListener("click", () => {
  todoFilter = b.dataset.filter;
  $$(".tf").forEach((x) => x.classList.toggle("active", x === b));
  renderTodos();
}));

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("#modal").classList.contains("open")) closeModal();
});

/* ===================== Init ===================== */
async function init() {
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
