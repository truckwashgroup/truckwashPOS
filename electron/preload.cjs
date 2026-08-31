const { contextBridge, ipcRenderer } = require('electron')

/**
 * De brug tussen de kassa-app en Windows.
 *
 * Alleen wat hier staat kan de app aanroepen. De app zelf heeft geen toegang
 * tot bestanden, netwerkpoorten of processen -- die gaan allemaal via deze
 * lijst. Dat is de reden dat de bonprinter niet vanuit de app wordt
 * aangestuurd maar hier: een webpagina kan geen TCP-verbinding openen, en dat
 * hoort ook zo te blijven.
 */
contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  isElectron: true,

  getVersion: () => ipcRenderer.invoke('app:version'),

  /* --- updates --- */
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb) => {
    const luister = (_e, payload) => cb(payload)
    ipcRenderer.on('update:status', luister)
    return () => ipcRenderer.removeListener('update:status', luister)
  },

  /* --- meldingen --- */
  notify: (title, body) => ipcRenderer.invoke('notify:show', { title, body }),

  /* --- bonprinter en lade --- */
  printBon: (opdrachten, printer, ladeOpen) =>
    ipcRenderer.invoke('printer:bon', { opdrachten, printer, ladeOpen }),
  proefBon: (printer) => ipcRenderer.invoke('printer:proef', { printer }),
  openLade: (printer) => ipcRenderer.invoke('lade:open', { printer }),

  /* --- betaalterminal --- */
  pinBetaling: (opdracht) => ipcRenderer.invoke('terminal:betaal', opdracht),
  pinAfbreken: (opdracht) => ipcRenderer.invoke('terminal:afbreken', opdracht),
})
