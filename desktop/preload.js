// ============================================================
//  Life Manager - Preload (sandboxé)
//  Expose une API minimale et sûre à la page :
//   - isDesktop : indique qu'on tourne dans l'exe (et non un navigateur)
//   - quit()    : demande la fermeture réelle de l'application
// ============================================================
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lmDesktop", {
  isDesktop: true,
  quit: () => ipcRenderer.send("app-quit")
});
