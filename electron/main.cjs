const { app, BrowserWindow, ipcMain, shell, Menu, Notification } = require('electron')
const path = require('node:path')
const speler = require('./speler.cjs')
const ipc = require('./ipc.cjs')

// dev = vite-server; anders wordt de gebouwde dist/ geladen
const isDev = process.env.NODE_ENV === 'development'

/*
 * Het speler://-schema aanmelden.
 *
 * Moet hier, boven alles: Electron neemt schema's alleen aan voordat de app
 * klaar is. Doe je het later, dan werkt het stil niet -- de speler krijgt dan
 * "onbekend adres" en er is niets aan te zien.
 */
speler.meldSchemaAan()
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
    /*
      Geen menubalk in beeld.

      "Bestand / Beeld" hoort niet op een kassascherm: er is niets te openen
      en niets op te slaan. De balk blijft wel bestaan -- met Alt komt hij
      tevoorschijn -- zodat herladen en de ontwikkelaarstools bereikbaar
      blijven als er iets te onderzoeken valt.
    */
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.setMenuBarVisibility(false)
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

/*
 * De handlers voor de bonprinter, de betaalterminal, de muziek en de speler
 * staan in ipc.cjs. Ze worden hieronder aangemeld, zodra de app klaar is.
 *
 * Waarom apart: het script dat schermafdrukken maakt start zijn eigen
 * hoofdproces en laadt dit bestand niet. Twee lijsten met dezelfde handlers
 * lopen uit elkaar, en dan werkt de app wel en de afdruk niet -- of erger,
 * omgekeerd.
 */

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
    // Nu de app klaar is, mag het speler://-schema echt bestanden uitleveren.
    speler.koppelSchema()

    ipc.registreer({
      hoofdvenster: () => mainWindow,
      paginaAdres: () => (isDev
        ? 'http://localhost:5174'
        : path.join(__dirname, '..', 'dist', 'index.html')),
    })

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
