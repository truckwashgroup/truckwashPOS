/**
 * De bonprinter en de kassalade.
 *
 * Bonprinters praten ESC/POS: een reeks bytes met stuurcodes ertussen. Dat is
 * ouder dan het web en werkt daardoor overal, maar het betekent ook dat je de
 * bytes zelf moet maken. Dat gebeurt hier.
 *
 * Twee manieren om ze bij de printer te krijgen:
 *
 *  netwerk  De printer heeft een eigen IP en luistert op poort 9100. Dit is
 *           de betrouwbaarste weg: geen driver, geen wachtrij, geen Windows
 *           ertussen. Als het even kan, zo.
 *
 *  windows  De printer hangt aan de USB en is in Windows gedeeld. We kopiëren
 *           de bytes naar die share. Dat werkt omdat Windows een gedeelde
 *           printer als bestandsdoel behandelt en de bytes ongewijzigd
 *           doorgeeft -- zou de driver ze "netjes opmaken", dan kwam er onzin
 *           uit.
 *
 * De kassalade zit meestal aan de printer (een RJ11-poort achterop). Openen is
 * dan één stuurcode naar de printer, geen apart apparaat.
 */

const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')

/* ------------------------------------------------------------------ */
/* Stuurcodes                                                          */
/* ------------------------------------------------------------------ */

const ESC = 0x1b
const GS = 0x1d

const INIT = Buffer.from([ESC, 0x40])                  // printer terug op nul
const CODEPAGE_437 = Buffer.from([ESC, 0x74, 0x00])    // tekenset CP437
const LINKS = Buffer.from([ESC, 0x61, 0x00])
const MIDDEN = Buffer.from([ESC, 0x61, 0x01])
const VET_AAN = Buffer.from([ESC, 0x45, 0x01])
const VET_UIT = Buffer.from([ESC, 0x45, 0x00])
const GROOT = Buffer.from([GS, 0x21, 0x11])            // dubbel hoog en breed
const NORMAAL = Buffer.from([GS, 0x21, 0x00])
const AFSNIJDEN = Buffer.from([GS, 0x56, 0x42, 0x00])
const REGEL = Buffer.from([0x0a])

/**
 * De lade opendrukken.
 *
 * ESC p, dan de poort (0), dan hoe lang de puls aan en uit staat. Die tijden
 * zijn in stapjes van 2 ms; 50 en 250 is wat vrijwel elke lade wil. Te kort en
 * hij klikt zonder open te gaan.
 */
const LADE_OPEN = Buffer.from([ESC, 0x70, 0x00, 0x32, 0xfa])

/* ------------------------------------------------------------------ */
/* Tekens                                                              */
/* ------------------------------------------------------------------ */

/**
 * Van Unicode naar CP437.
 *
 * Een bonprinter kent geen UTF-8. Wat hij niet kent drukt hij af als een
 * willekeurig teken, en dan staat er "Beëindigd" met een blokje in het midden.
 * Dus: wat CP437 wél heeft zetten we om, de rest vervangen we door iets
 * leesbaars. Een euroteken bestaat niet in CP437; daar schrijven we EUR.
 */
const CP437 = {
  'é': 0x82, 'è': 0x8a, 'ê': 0x88, 'ë': 0x89,
  'á': 0xa0, 'à': 0x85, 'â': 0x83, 'ä': 0x84,
  'í': 0xa1, 'ì': 0x8d, 'î': 0x8c, 'ï': 0x8b,
  'ó': 0xa2, 'ò': 0x95, 'ô': 0x93, 'ö': 0x94,
  'ú': 0xa3, 'ù': 0x97, 'û': 0x96, 'ü': 0x81,
  'ç': 0x87, 'ñ': 0xa4, 'ÿ': 0x98,
  'É': 0x90, 'Ä': 0x8e, 'Ö': 0x99, 'Ü': 0x9a, 'Ç': 0x80, 'Ñ': 0xa5,
  '°': 0xf8, '£': 0x9c, '¥': 0x9d, '½': 0xab, '¼': 0xac, '·': 0xfa,
}

const VERVANG = {
  '€': 'EUR', '…': '...', '—': '-', '–': '-', '’': "'", '‘': "'",
  '“': '"', '”': '"', ' ': ' ', '×': 'x', '•': '*',
}

function tekst(s) {
  const bytes = []
  for (const teken of String(s)) {
    if (CP437[teken] !== undefined) {
      bytes.push(CP437[teken])
      continue
    }
    const vervanging = VERVANG[teken]
    if (vervanging !== undefined) {
      for (const c of vervanging) bytes.push(c.charCodeAt(0) & 0x7f)
      continue
    }
    const code = teken.charCodeAt(0)
    bytes.push(code < 0x80 ? code : 0x3f) // onbekend teken -> vraagteken
  }
  return Buffer.from(bytes)
}

/* ------------------------------------------------------------------ */
/* QR-code                                                             */
/* ------------------------------------------------------------------ */

/**
 * Een QR-code laten we de printer zelf tekenen.
 *
 * Dat scheelt een afbeelding versturen, en het resultaat is scherper: de
 * printer weet hoe groot zijn punten zijn. De vier commando's hieronder zijn
 * achtereenvolgens: model kiezen, puntgrootte, foutcorrectie, gegevens in het
 * geheugen zetten, en afdrukken.
 */
function qr(data) {
  const inhoud = Buffer.from(String(data), 'ascii')
  const lengte = inhoud.length + 3
  const kop = (fn, extra) =>
    Buffer.concat([
      Buffer.from([GS, 0x28, 0x6b, extra.length + 3, 0x00, 0x31, fn]),
      Buffer.from(extra),
    ])

  return Buffer.concat([
    MIDDEN,
    kop(0x41, [0x32, 0x00]),          // model 2
    kop(0x43, [0x06]),                // puntgrootte 6
    kop(0x45, [0x31]),                // foutcorrectie M
    Buffer.concat([
      Buffer.from([GS, 0x28, 0x6b, lengte & 0xff, (lengte >> 8) & 0xff, 0x31, 0x50, 0x30]),
      inhoud,
    ]),
    kop(0x51, [0x30]),                // afdrukken
    LINKS,
  ])
}

/* ------------------------------------------------------------------ */
/* De bon opbouwen                                                     */
/* ------------------------------------------------------------------ */

function paar(links, rechts, breedte) {
  const l = String(links)
  const r = String(rechts)
  const ruimte = breedte - r.length
  const kort = l.length > ruimte - 1 ? l.slice(0, Math.max(0, ruimte - 2)) + '.' : l
  return kort + ' '.repeat(Math.max(1, breedte - kort.length - r.length)) + r
}

/**
 * Zet de opdrachten uit src/lib/bon.ts om in bytes.
 *
 * Dezelfde lijst gaat ook naar het scherm. Dat is de reden dat de opmaak in
 * opdrachten is uitgedrukt en niet in tekst: zo kan de printer vet en dubbel
 * groot doen zonder dat het scherm er iets van hoeft te weten.
 */
function bouwBon(opdrachten, opties = {}) {
  const breedte = opties.breedte || 42
  const delen = [INIT, CODEPAGE_437, LINKS]

  for (const o of opdrachten) {
    switch (o.soort) {
      case 'leeg':
        delen.push(REGEL)
        break
      case 'streep':
        delen.push(tekst('-'.repeat(breedte)), REGEL)
        break
      case 'midden':
        delen.push(MIDDEN)
        if (o.vet) delen.push(VET_AAN)
        if (o.groot) delen.push(GROOT)
        delen.push(tekst(o.tekst), REGEL)
        if (o.groot) delen.push(NORMAAL)
        if (o.vet) delen.push(VET_UIT)
        delen.push(LINKS)
        break
      case 'links':
        if (o.vet) delen.push(VET_AAN)
        delen.push(tekst(o.tekst), REGEL)
        if (o.vet) delen.push(VET_UIT)
        break
      case 'paar':
        if (o.vet) delen.push(VET_AAN)
        delen.push(tekst(paar(o.links, o.rechts, breedte)), REGEL)
        if (o.vet) delen.push(VET_UIT)
        break
      case 'qr':
        delen.push(qr(o.data))
        if (o.onder) {
          delen.push(MIDDEN, tekst(o.onder), REGEL, LINKS)
        }
        break
      default:
        break
    }
  }

  // Doorvoeren zodat de bon voorbij het mes komt, dan afsnijden.
  delen.push(REGEL, REGEL, REGEL, REGEL)
  if (opties.afsnijden !== false) delen.push(AFSNIJDEN)
  if (opties.ladeOpen) delen.push(LADE_OPEN)

  return Buffer.concat(delen)
}

/* ------------------------------------------------------------------ */
/* Versturen                                                           */
/* ------------------------------------------------------------------ */

function naarNetwerk(buffer, host, port = 9100, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket()
    let klaar = false

    const af = (fout) => {
      if (klaar) return
      klaar = true
      socket.destroy()
      fout ? reject(fout) : resolve()
    }

    socket.setTimeout(timeout)
    socket.once('timeout', () => af(new Error(
      `De printer op ${host}:${port} antwoordt niet. Staat hij aan en zit hij aan het netwerk?`)))
    socket.once('error', (e) => af(new Error(
      `Printer op ${host}:${port}: ${e.message}`)))
    // 'close' na een geslaagde write is het teken dat alles eruit is.
    socket.once('close', () => af(null))

    socket.connect(port, host, () => {
      socket.write(buffer, (e) => {
        if (e) return af(e)
        socket.end()
      })
    })
  })
}

/**
 * Naar een in Windows gedeelde printer.
 *
 * `copy /b` stuurt de bytes ongewijzigd door. De printer moet daarvoor gedeeld
 * zijn (Printereigenschappen -> Delen -> Deze printer delen). Zonder share is
 * er geen pad om naartoe te kopiëren; dat is de prijs van deze weg, en de
 * reden dat een netwerkprinter te verkiezen is.
 */
function naarWindows(buffer, share) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      return reject(new Error('Deze manier van afdrukken werkt alleen op Windows.'))
    }

    const doel = share.startsWith('\\\\')
      ? share
      : `\\\\${os.hostname()}\\${share}`

    const tijdelijk = path.join(os.tmpdir(), `bon-${Date.now()}.prn`)

    try {
      fs.writeFileSync(tijdelijk, buffer)
    } catch (e) {
      return reject(new Error(`Kon de bon niet klaarzetten: ${e.message}`))
    }

    execFile(
      'cmd',
      ['/c', 'copy', '/b', tijdelijk, doel],
      { windowsHide: true, timeout: 15000 },
      (fout, _uit, fouttekst) => {
        fs.unlink(tijdelijk, () => {})
        if (fout) {
          return reject(new Error(
            `Afdrukken naar ${doel} lukte niet: ${(fouttekst || fout.message).trim()}. ` +
            'Staat de printer gedeeld onder precies deze naam?'))
        }
        resolve()
      },
    )
  })
}

async function verstuur(buffer, printer) {
  const kind = (printer && printer.kind) || 'geen'

  if (kind === 'geen') {
    return { ok: false, reden: 'Er is geen bonprinter ingesteld.' }
  }
  if (kind === 'netwerk') {
    if (!printer.host) return { ok: false, reden: 'Er is geen printeradres ingesteld.' }
    await naarNetwerk(buffer, printer.host, printer.port || 9100)
    return { ok: true }
  }
  if (kind === 'windows') {
    if (!printer.share) return { ok: false, reden: 'Er is geen printernaam ingesteld.' }
    await naarWindows(buffer, printer.share)
    return { ok: true }
  }
  return { ok: false, reden: `Onbekende soort printer: ${kind}` }
}

/* ------------------------------------------------------------------ */

module.exports = {
  /** Drukt een bon af. `opdrachten` komt uit bonOpmaken(). */
  async printBon(opdrachten, printer, opties = {}) {
    const buffer = bouwBon(opdrachten, {
      breedte: (printer && printer.breedte) || 42,
      ladeOpen: opties.ladeOpen === true,
    })
    return verstuur(buffer, printer)
  },

  /** Opent alleen de lade, zonder iets af te drukken. */
  async openLade(printer) {
    return verstuur(Buffer.concat([INIT, LADE_OPEN]), printer)
  },

  /** Een proefbon, om te zien of de instellingen kloppen. */
  async proefBon(printer) {
    const opdrachten = [
      { soort: 'midden', tekst: 'TRUCKWASH1 KASSA', groot: true, vet: true },
      { soort: 'leeg' },
      { soort: 'midden', tekst: 'Proefafdruk' },
      { soort: 'streep' },
      { soort: 'paar', links: 'Tekens per regel', rechts: String((printer && printer.breedte) || 42) },
      { soort: 'paar', links: 'Verbinding', rechts: (printer && printer.kind) || 'geen' },
      { soort: 'links', tekst: 'Accenten: één café, drie ijsjes' },
      { soort: 'paar', links: 'Bedrag', rechts: '1.234,56' },
      { soort: 'streep' },
      { soort: 'qr', data: 'TRUCKWASH1-PROEF', onder: 'Scan mij' },
    ]
    return module.exports.printBon(opdrachten, printer, { ladeOpen: false })
  },

  bouwBon,
}
