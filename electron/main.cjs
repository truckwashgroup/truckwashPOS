const { app, BrowserWindow, ipcMain, shell, Menu, Notification } = require('electron')
const path = require('node:path')
const escpos = require('./escpos.cjs')
const terminal = require('./terminal.cjs')

// dev = vite-server; anders wordt de gebouwde dist/ geladen
const isDev = process.env.NODE_ENV === 'development'
let mainWindow = null
let autoUpdater = null

/* ------------------------------------------------------------------ */
/* Auto-update (Windows)                                               */
/*                                                                     */
/* Bij een kassa is dit gevoeliger dan bij een dashboard: je wilt niet  */
/* dat er halverwege een transactie iets omvalt. Daarom downloadt hij   */
/* op de achtergrond en installeert hij pas bij het afsluiten -- of     */
/* wanneer iemand er zelf op drukt, na de dagafsluiting.                */
/* ------------------------------------------------------------------ */
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

function initAutoUpdater() {
  if (!app.isPackaged) return // alleen een geïnstalleerde app kan updaten
  try {
    autoUpdater = require('electron-updater').autoUpdater
  } catch {
    return
  }

  autoUpdater.autoDownload = true
  // Niet vanzelf herstarten. De kassa bepaalt zelf wanneer het rustig is.
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => send('update:status', { state: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    send('update:status', { state: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => send('update:status', { state: 'up-to-date' }))
  autoUpdater.on('download-progress', (p) =>
    send('update:status', { state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) =>
    send('update:status', { state: 'ready', version: info.version }))
  autoUpdater.on('error', (err) =>
    send('update:status', { state: 'error', message: String(err && err.message ? err.message : err) }))

  autoUpdater.checkForUpdates().catch(() => {})
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 30 * 60 * 1000)
}

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 850,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#0b1220',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5174')
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  mainWindow.on('closed', () => { mainWindow = null })
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

ipcMain.handle('app:version', () => app.getVersion())

ipcMain.handle('update:check', async () => {
  if (!autoUpdater) return { ok: false, reason: app.isPackaged ? 'unavailable' : 'dev' }
  try {
    await autoUpdater.checkForUpdates()
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) }
  }
})

ipcMain.handle('update:install', () => {
  if (autoUpdater) autoUpdater.quitAndInstall(false, true)
})

ipcMain.handle('notify:show', (_e, { title, body }) => {
  if (!Notification.isSupported()) return false
  const n = new Notification({
    title: String(title ?? 'Truckwash1 Kassa'),
    body: String(body ?? ''),
    silent: false,
  })
  n.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  n.show()
  return true
})

/* ---- bonprinter en lade ---- */

/*
 * Een mislukte afdruk is geen mislukte verkoop. De bon staat al in de kassa;
 * afdrukken kan opnieuw. Daarom geeft dit nooit een uitzondering terug maar
 * altijd een antwoord waarin staat wat er misging -- de kassa kan dan door.
 */
ipcMain.handle('printer:bon', async (_e, { opdrachten, printer, ladeOpen }) => {
  try {
    return await escpos.printBon(opdrachten ?? [], printer ?? {}, { ladeOpen: Boolean(ladeOpen) })
  } catch (e) {
    return { ok: false, reden: String(e && e.message ? e.message : e) }
  }
})

ipcMain.handle('printer:proef', async (_e, { printer }) => {
  try {
    return await escpos.proefBon(printer ?? {})
  } catch (e) {
    return { ok: false, reden: String(e && e.message ? e.message : e) }
  }
})

ipcMain.handle('lade:open', async (_e, { printer }) => {
  try {
    return await escpos.openLade(printer ?? {})
  } catch (e) {
    return { ok: false, reden: String(e && e.message ? e.message : e) }
  }
})

/* ---- betaalterminal ---- */

ipcMain.handle('terminal:betaal', async (_e, opdracht) => {
  try {
    return await terminal.betaal(opdracht ?? {})
  } catch (e) {
    return { ok: false, reden: String(e && e.message ? e.message : e) }
  }
})

ipcMain.handle('terminal:afbreken', async (_e, opdracht) => {
  try {
    return await terminal.afbreken(opdracht ?? {})
  } catch (e) {
    return { ok: false, reden: String(e && e.message ? e.message : e) }
  }
})

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // Twee kassa's op één apparaat zou twee keer hetzelfde bonnummer uitdelen.
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'Bestand',
          submenu: [{ role: 'quit', label: 'Afsluiten' }],
        },
        {
          label: 'Beeld',
          submenu: [
            { role: 'reload', label: 'Herladen' },
            { role: 'toggleDevTools', label: 'Ontwikkelaarstools' },
            { type: 'separator' },
            { role: 'resetZoom', label: 'Zoom herstellen' },
            { role: 'zoomIn', label: 'Inzoomen' },
            { role: 'zoomOut', label: 'Uitzoomen' },
            { type: 'separator' },
            { role: 'togglefullscreen', label: 'Volledig scherm' },
          ],
        },
      ])
    )
    createWindow()
    initAutoUpdater()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
