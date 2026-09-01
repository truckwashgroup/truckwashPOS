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

  /*
   * Een melding voor later, die het afsluiten van de kassa overleeft.
   * Zie electron/melding.cjs -- dit is niet hetzelfde als notify hierboven,
   * want die kan alleen zolang de app draait.
   */
  meldingPlannen: (opdracht) => ipcRenderer.invoke('melding:plan', opdracht),

  /* --- bonprinter en lade --- */
  printBon: (opdrachten, printer, ladeOpen) =>
    ipcRenderer.invoke('printer:bon', { opdrachten, printer, ladeOpen }),
  proefBon: (printer) => ipcRenderer.invoke('printer:proef', { printer }),
  openLade: (printer) => ipcRenderer.invoke('lade:open', { printer }),

  /* --- betaalterminal --- */
  pinBetaling: (opdracht) => ipcRenderer.invoke('terminal:betaal', opdracht),
  pinAfbreken: (opdracht) => ipcRenderer.invoke('terminal:afbreken', opdracht),

  /* --- muziek op het netwerk (UPnP) --- */
  muziekZoeken: () => ipcRenderer.invoke('muziek:zoek'),
  muziekStand: (apparaat) => ipcRenderer.invoke('muziek:stand', apparaat),
  muziekBesturen: (apparaat, actie, waarde) =>
    ipcRenderer.invoke('muziek:bestuur', { apparaat, actie, waarde }),

  /* --- de kassa als speler: eigen bestanden en een tweede scherm --- */
  spelerKiesMap: (vanaf) => ipcRenderer.invoke('speler:kiesMap', vanaf),
  spelerLijstMap: (map) => ipcRenderer.invoke('speler:lijstMap', map),
  spelerSchermen: () => ipcRenderer.invoke('speler:schermen'),
  spelerVideoOpenen: (schermId) => ipcRenderer.invoke('speler:videoOpenen', schermId),
  spelerVideoSluiten: () => ipcRenderer.invoke('speler:videoSluiten'),
  spelerVideoStaatOpen: () => ipcRenderer.invoke('speler:videoStaatOpen'),
  spelerVideoOpdracht: (opdracht) => ipcRenderer.invoke('speler:videoOpdracht', opdracht),

  // Het videovenster luistert hiernaar; de kassa stuurt erop.
  spelerOpVideoOpdracht: (cb) => {
    const luister = (_e, opdracht) => cb(opdracht)
    ipcRenderer.on('speler:video', luister)
    return () => ipcRenderer.removeListener('speler:video', luister)
  },

  // En de andere kant op: het videovenster meldt dat een video klaar is.
  spelerVideoKlaar: () => ipcRenderer.invoke('speler:videoKlaar'),
  spelerOpVideoKlaar: (cb) => {
    const luister = () => cb()
    ipcRenderer.on('speler:videoKlaar', luister)
    return () => ipcRenderer.removeListener('speler:videoKlaar', luister)
  },
})
