// ============================================================
//  Life Manager - Processus principal Electron
//  Sert l'application via un serveur HTTP local (port fixe)
//  pour un comportement identique à l'environnement de dev
//  (CORS, API Google, localStorage, export PDF).
//
//  IMPORTANT : le port doit être STABLE entre les lancements,
//  car localStorage est lié à l'origine http://127.0.0.1:PORT.
//  Un port aléatoire = données perdues à chaque session.
// ============================================================
const { app, BrowserWindow, shell, ipcMain } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");

const APP_DIR = path.join(__dirname, "app");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf"
};

const DEFAULT_PORT = 38471;
const PORT_FILE = () => path.join(app.getPath("userData"), "lm-port.txt");
const WINDOW_FILE = () => path.join(app.getPath("userData"), "lm-window.json");

let server = null;
let mainWindow = null;
let winSaveTimer = null;

// --- Sauvegarde de la taille/position de la fenêtre (et état maximisé) ---
function saveWindowState(win) {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  try {
    // Quand la fenêtre est maximisée, on garde les dimensions normales
    // (avant maximisation) + le flag maximized pour la restaurer ensuite.
    const maximized = win.isMaximized();
    const b = maximized ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(WINDOW_FILE(), JSON.stringify({ width: b.width, height: b.height, x: b.x, y: b.y, maximized }));
  } catch (e) {}
}

function scheduleWindowSave(win) {
  if (winSaveTimer) clearTimeout(winSaveTimer);
  winSaveTimer = setTimeout(() => { saveWindowState(win); }, 400);
}

function loadWindowState() {
  try {
    if (fs.existsSync(WINDOW_FILE())) {
      const s = JSON.parse(fs.readFileSync(WINDOW_FILE(), "utf8"));
      const w = parseInt(s.width, 10), h = parseInt(s.height, 10);
      const x = parseInt(s.x, 10), y = parseInt(s.y, 10);
      // Taille normale valide (>= min), ou état maximisé (les bounds normales restent vérifiées)
      if (w >= 800 && h >= 600 && x >= 0 && y >= 0) {
        return { width: w, height: h, x, y, maximized: s.maximized === true };
      }
    }
  } catch (e) {}
  return null;
}

function serveStatic(req, res) {
  // Décoder l'URL et supprimer la query string
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  // Empêcher les traversées de chemin
  let filePath = path.normalize(path.join(APP_DIR, urlPath));
  if (!filePath.startsWith(APP_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// --- Port fixe persistant : même origine localStorage entre les sessions ---
function startServer() {
  return new Promise((resolve, reject) => {
    let preferred = DEFAULT_PORT;
    try {
      if (fs.existsSync(PORT_FILE())) {
        const p = parseInt(fs.readFileSync(PORT_FILE(), "utf8"), 10);
        if (p > 0 && p < 65536) preferred = p;
      }
    } catch (e) {}

    const tryListen = (port) => {
      const srv = http.createServer(serveStatic);
      srv.on("error", (err) => {
        // Port occupé : essaie le suivant (cas rare : conflit externe)
        if (port < 65535) tryListen(port + 1);
        else reject(err);
      });
      srv.listen(port, "127.0.0.1", () => {
        server = srv;
        try { fs.writeFileSync(PORT_FILE(), String(port)); } catch (e) {}
        resolve(port);
      });
    };
    tryListen(preferred);
  });
}

function createWindow(port) {
  const saved = loadWindowState();
  const win = new BrowserWindow({
    width: saved ? saved.width : 1800,
    height: saved ? saved.height : 1012,
    x: saved ? saved.x : undefined,
    y: saved ? saved.y : undefined,
    minWidth: 800,
    minHeight: 600,
    title: "Life Manager",
    autoHideMenuBar: true,
    backgroundColor: "#0b1220",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow = win;

  // Restaure l'état maximisé (plein écran fenêtre)
  if (saved && saved.maximized) {
    win.maximize();
  }

  // Sauvegarde la taille/position au redimensionnement / déplacement
  win.on("resize", () => scheduleWindowSave(win));
  win.on("move", () => scheduleWindowSave(win));
  win.on("close", () => { if (winSaveTimer) clearTimeout(winSaveTimer); saveWindowState(win); });

  // Les liens cible="_blank" s'ouvrent dans le navigateur par défaut
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  win.loadURL(`http://127.0.0.1:${port}/index.html`);
  return win;
}

// --- Fermeture : le bouton Quitter de l'app demande la fermeture réelle ---
ipcMain.on("app-quit", () => {
  app.quit();
});

// --- Une seule instance : évite 2 ports / 2 stockages différents ---
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const port = await startServer();
    createWindow(port);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    if (server) { try { server.close(); } catch (e) {} }
  });
}
