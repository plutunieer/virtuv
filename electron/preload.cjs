// Brücke zwischen Fenster und Mac-App: nur „Ordner wählen …“ (Mac-Dialog). Sonst kein Zugriff aufs System.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("urs", {
  istApp: true,
  ordnerWaehlen: (sprache) => ipcRenderer.invoke("ordner-waehlen", sprache === "de" ? "de" : "en"),
});
