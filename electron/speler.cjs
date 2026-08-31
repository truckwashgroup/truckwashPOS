/**
 * De kassa als speler.
 *
 * Anders dan muziek.cjs, en het is belangrijk om die twee niet te verwarren:
 *
 *   muziek.cjs  stuurt bij wat er op een ánder apparaat speelt (UPnP).
 *   speler.cjs  laat de kássa spelen, en dan bepaalt Windows waar het geluid
 *               uitkomt: de luidspreker van de pc, een kabel naar de
 *               versterker, of een gekoppelde bluetooth-box.
 *
 *  Dat laatste is waarom bluetooth hier wél werkt en in muziek.cjs niet. Als
 *  de kassa de bron is, hoeft er niets bestuurd te worden -- pauze is dan
 *  gewoon een knop, en de box hoort alleen wat eruit komt.
 *
 *  Beeld gaat níét over bluetooth; dat bestaat in de praktijk niet. Video gaat
 *  daarom naar een tweede scherm aan de kassa-pc, in een eigen venster dat je
 *  volledig scherm zet.
 */

const { BrowserWindow, dialog, net, protocol, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

/* ------------------------------------------------------------------ */
/* Wat de kassa kan spelen                                             */
/* ------------------------------------------------------------------ */

/*
 * Alleen wat Chromium ook echt kan weergeven. Een lijst met alles wat op
 * "muziek" lijkt levert bestanden op die stil overgeslagen worden, en dan
 * denkt iemand dat de speler stuk is.
 *
 * .mkv staat er bewust niet bij: dat is een omhulsel dat vaak codecs bevat
 * die Chromium niet heeft, dus soms werkt het en soms niet -- en "soms" is
 * erger dan "niet".
 */
const GELUID = ['.mp3', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wav']
const BEELD = ['.mp4', '.m4v', '.webm']

/** Mappen die de gebruiker heeft aangewezen. Alleen hieruit mag gelezen worden. */
const toegestaneMappen = new Set()

/**
 * Mag dit bestand uitgeleverd worden?
 *
 * Zonder deze controle zou het scherm elk bestand op de schijf kunnen opvragen
 * via het speler://-adres. Dat is precies het soort gat dat je niet wil op een
 * apparaat waar ook een kassa-administratie op staat.
 */
function magGelezenWorden(bestand) {
  const echt = path.resolve(bestand)
  for (const map of toegestaneMappen) {
    const wortel = path.resolve(map)
    if (echt === wortel) return true
    if (echt.startsWith(wortel + path.sep)) return true
  }
  return false
}

/* ------------------------------------------------------------------ */
/* Het adres waarmee de speler bij een bestand komt                    */
/* ------------------------------------------------------------------ */

/**
 * Het schema aanmelden. Moet gebeuren vóórdat de app klaar is.
 *
 * `stream` is hier het punt: zonder dat kan een video niet doorgespoeld
 * worden, want dan komt er geen Range-verzoek door en moet de browser het
 * hele bestand ophalen voordat hij iets laat zien.
 */
function meldSchemaAan() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'speler',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
      },
    },
  ])
}

/** Het schema laten werken. Na app.whenReady(). */
function koppelSchema() {
  protocol.handle('speler', async (verzoek) => {
    let pad = ''
    try {
      pad = decodeURIComponent(new URL(verzoek.url).searchParams.get('pad') || '')
    } catch {
      return new Response('onleesbaar adres', { status: 400 })
    }

    if (!pad || !magGelezenWorden(pad)) {
      return new Response('niet toegestaan', { status: 403 })
    }

    // De kopregels doorgeven, want daar zit het Range-verzoek in waarmee de
    // browser in een video kan springen.
    return net.fetch(pathToFileURL(pad).toString(), { headers: verzoek.headers })
  })
}

/* ------------------------------------------------------------------ */
/* Een map kiezen en doorzoeken                                        */
/* ------------------------------------------------------------------ */

async function kiesMap(vanaf) {
  const uitslag = await dialog.showOpenDialog({
    title: 'Kies de map met muziek of video',
    defaultPath: vanaf || undefined,
    properties: ['openDirectory'],
    buttonLabel: 'Deze map gebruiken',
  })

  if (uitslag.canceled || !uitslag.filePaths.length) return { pad: null }
  const pad = uitslag.filePaths[0]
  toegestaneMappen.add(pad)
  return { pad }
}

/**
 * Een map doorzoeken op bestanden die we kunnen spelen.
 *
 * Twee lagen diep. Dat dekt "Muziek/Artiest/nummer.mp3" en houdt het meteen
 * beperkt: iemand die per ongeluk zijn hele schijf aanwijst, wacht anders
 * minuten op een lijst waar niemand iets aan heeft.
 */
function lijstMap(wortel, diepte = 2) {
  if (!wortel) return { geluid: [], beeld: [], fout: 'Er is geen map gekozen.' }

  toegestaneMappen.add(wortel)

  const geluid = []
  const beeld = []

  const loop = (map, over) => {
    let inhoud
    try {
      inhoud = fs.readdirSync(map, { withFileTypes: true })
    } catch (e) {
      return
    }

    for (const item of inhoud) {
      const vol = path.join(map, item.name)

      if (item.isDirectory()) {
        if (over > 0 && !item.name.startsWith('.')) loop(vol, over - 1)
        continue
      }
      if (!item.isFile()) continue

      const ext = path.extname(item.name).toLowerCase()
      const rij = {
        pad: vol,
        naam: path.basename(item.name, path.extname(item.name)),
        map: path.relative(wortel, map) || '',
        adres: 'speler://media/?pad=' + encodeURIComponent(vol),
      }

      if (GELUID.includes(ext)) geluid.push(rij)
      else if (BEELD.includes(ext)) beeld.push(rij)
    }
  }

  try {
    if (!fs.statSync(wortel).isDirectory()) {
      return { geluid: [], beeld: [], fout: 'Dat is geen map.' }
    }
  } catch {
    return {
      geluid: [], beeld: [],
      fout: 'Die map is er niet meer. Kies hem opnieuw.',
    }
  }

  loop(wortel, diepte)

  const opNaam = (a, b) =>
    (a.map + a.naam).localeCompare(b.map + b.naam, 'nl', { numeric: true })
  geluid.sort(opNaam)
  beeld.sort(opNaam)

  return { geluid, beeld, fout: null }
}

/* ------------------------------------------------------------------ */
/* Het tweede scherm                                                   */
/* ------------------------------------------------------------------ */

let videoVenster = null

/** Welke schermen er zijn, zodat de app kan zeggen waar het venster komt. */
function schermen() {
  const alle = screen.getAllDisplays()
  const hoofd = screen.getPrimaryDisplay()
  return alle.map((d, i) => ({
    id: d.id,
    naam: d.label || `Scherm ${i + 1}`,
    hoofdscherm: d.id === hoofd.id,
    breedte: d.size.width,
    hoogte: d.size.height,
  }))
}

/**
 * Het videovenster openen.
 *
 * Is er een tweede scherm, dan zet hij zichzelf daar volledig scherm neer --
 * dat is waar een wachtruimtescherm voor bedoeld is. Is er maar één scherm,
 * dan komt hij als gewoon venster in beeld, want dan zou hij de kassa
 * bedekken.
 */
function openVideo(paginaAdres, opties = {}) {
  if (videoVenster && !videoVenster.isDestroyed()) {
    videoVenster.show()
    videoVenster.focus()
    return { ok: true, alOpen: true }
  }

  const alle = screen.getAllDisplays()
  const hoofd = screen.getPrimaryDisplay()
  const tweede = alle.find((d) => d.id !== hoofd.id)
  const doel = opties.schermId
    ? alle.find((d) => String(d.id) === String(opties.schermId)) || tweede
    : tweede

  videoVenster = new BrowserWindow({
    width: doel ? doel.workArea.width : 1280,
    height: doel ? doel.workArea.height : 720,
    x: doel ? doel.workArea.x : undefined,
    y: doel ? doel.workArea.y : undefined,
    fullscreen: Boolean(doel),
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: 'Truckwash1 — scherm',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  videoVenster.setMenuBarVisibility(false)
  videoVenster.on('closed', () => { videoVenster = null })

  // Dezelfde app, maar met een vlag zodat hij alleen het scherm tekent en
  // niet de hele kassa. Zo is er geen tweede bundel te onderhouden.
  if (paginaAdres.startsWith('http')) {
    videoVenster.loadURL(paginaAdres + '?scherm=video')
  } else {
    videoVenster.loadFile(paginaAdres, { query: { scherm: 'video' } })
  }

  return { ok: true, alOpen: false, opTweedeScherm: Boolean(doel) }
}

function sluitVideo() {
  if (videoVenster && !videoVenster.isDestroyed()) videoVenster.close()
  videoVenster = null
  return { ok: true }
}

/** Een opdracht naar het videovenster sturen (welk bestand, pauze, volume). */
function naarVideo(opdracht) {
  if (!videoVenster || videoVenster.isDestroyed()) {
    return { ok: false, reden: 'Het videoscherm staat niet open.' }
  }
  videoVenster.webContents.send('speler:video', opdracht)
  return { ok: true }
}

function videoStaatOpen() {
  return Boolean(videoVenster && !videoVenster.isDestroyed())
}

module.exports = {
  meldSchemaAan,
  koppelSchema,
  kiesMap,
  lijstMap,
  schermen,
  openVideo,
  sluitVideo,
  naarVideo,
  videoStaatOpen,
  // Voor de zelftest: de stukken die zonder Electron te controleren zijn.
  _intern: { GELUID, BEELD, magGelezenWorden, toegestaneMappen },
}
