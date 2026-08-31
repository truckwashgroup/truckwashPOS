/**
 * De brug naar de hardware, op één plek.
 *
 * Hier staan de handlers voor de bonprinter, de betaalterminal, de muziek op
 * het netwerk en de speler. Ze stonden eerst in main.cjs, en dat werkte tot er
 * een tweede proces bij kwam: het script dat schermafdrukken maakt start zijn
 * eigen venster en laadt main.cjs niet. Alles wat de app aan de brug vroeg,
 * kwam daar dus terug als "No handler registered" -- en dan zie je op de
 * afdruk een leeg scherm zonder te weten waarom.
 *
 * Twee plekken met dezelfde lijst handlers zou hetzelfde nog een keer laten
 * gebeuren zodra er één bij komt. Dus staat de lijst hier, en roepen beide
 * processen dezelfde functie aan.
 */

const { ipcMain, Notification } = require('electron')

const escpos = require('./escpos.cjs')
const terminal = require('./terminal.cjs')
const muziek = require('./muziek.cjs')
const speler = require('./speler.cjs')

/** Een fout in de hardware mag de kassa nooit vastzetten. */
const veilig = (kanaal, fn, bijFout) => {
  ipcMain.removeHandler(kanaal)
  ipcMain.handle(kanaal, async (...args) => {
    try {
      return await fn(...args)
    } catch (e) {
      const reden = String(e && e.message ? e.message : e)
      return typeof bijFout === 'function' ? bijFout(reden) : { ok: false, reden }
    }
  })
}

/**
 * @param {object} opties
 * @param {() => import('electron').BrowserWindow | null} opties.hoofdvenster
 *        Waar meldingen en het "video is klaar"-bericht naartoe gaan.
 * @param {() => string} opties.paginaAdres
 *        Wat het videovenster moet laden.
 */
function registreer({ hoofdvenster, paginaAdres }) {
  const venster = () => {
    const w = hoofdvenster()
    return w && !w.isDestroyed() ? w : null
  }

  /* ---- meldingen ---- */

  veilig('notify:show', (_e, { title, body }) => {
    if (!Notification.isSupported()) return false
    const n = new Notification({
      title: String(title ?? 'Truckwash1 Kassa'),
      body: String(body ?? ''),
      silent: false,
    })
    n.on('click', () => {
      const w = venster()
      if (w) {
        if (w.isMinimized()) w.restore()
        w.focus()
      }
    })
    n.show()
    return true
  }, () => false)

  /* ---- bonprinter en lade ----
   *
   * Een mislukte afdruk is geen mislukte verkoop. De bon staat al in de kassa;
   * afdrukken kan opnieuw. Daarom komt hier altijd een antwoord terug waarin
   * staat wat er misging.
   */

  veilig('printer:bon', (_e, { opdrachten, printer, ladeOpen }) =>
    escpos.printBon(opdrachten ?? [], printer ?? {}, { ladeOpen: Boolean(ladeOpen) }))

  veilig('printer:proef', (_e, { printer }) => escpos.proefBon(printer ?? {}))

  veilig('lade:open', (_e, { printer }) => escpos.openLade(printer ?? {}))

  /* ---- betaalterminal ---- */

  veilig('terminal:betaal', (_e, opdracht) => terminal.betaal(opdracht ?? {}))
  veilig('terminal:afbreken', (_e, opdracht) => terminal.afbreken(opdracht ?? {}))

  /* ---- muziek bijsturen op het netwerk (UPnP) ---- */

  veilig('muziek:zoek', () => muziek.zoek(),
    (reden) => ({ apparaten: [], google: [], fout: reden }))

  veilig('muziek:stand', (_e, apparaat) => muziek.stand(apparaat ?? {}),
    (reden) => ({ speelt: false, volume: null, gedempt: false, nummer: null, fout: reden }))

  veilig('muziek:bestuur', (_e, { apparaat, actie, waarde }) =>
    muziek.bestuur(apparaat ?? {}, actie, waarde))

  /* ---- de kassa als speler ---- */

  veilig('speler:kiesMap', (_e, vanaf) => speler.kiesMap(vanaf),
    (reden) => ({ pad: null, fout: reden }))

  veilig('speler:lijstMap', (_e, map) => speler.lijstMap(map),
    (reden) => ({ geluid: [], beeld: [], fout: reden }))

  veilig('speler:schermen', () => speler.schermen(), () => [])

  veilig('speler:videoOpenen', (_e, schermId) =>
    speler.openVideo(paginaAdres(), { schermId }))

  veilig('speler:videoSluiten', () => speler.sluitVideo())
  veilig('speler:videoStaatOpen', () => speler.videoStaatOpen(), () => false)
  veilig('speler:videoOpdracht', (_e, opdracht) => speler.naarVideo(opdracht))

  /*
   * Het videovenster meldt dat een video klaar is; de kassa bepaalt wat er
   * daarna komt. De lijst staat aan de kassakant, en op één plek.
   */
  veilig('speler:videoKlaar', () => {
    const w = venster()
    if (w) w.webContents.send('speler:videoKlaar')
    return { ok: true }
  })
}

module.exports = { registreer }
