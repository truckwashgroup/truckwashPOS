/**
 * Muziek bijsturen vanaf de kassa.
 *
 * Eén protocol voor alles: UPnP, oftewel DLNA. Dat is wat een Sonos spreekt,
 * en ook wat de meeste soundbars, AV-receivers en smart-tv's spreken. Dus geen
 * koppeling per merk, geen account, geen sleutel, geen internet -- alles gaat
 * over het eigen netwerk.
 *
 * Twee dingen zitten erin:
 *
 *   zoeken     SSDP: een vraag over UDP naar het hele netwerk ("wie is hier
 *              een mediarenderer?") en verzamelen wie antwoordt.
 *   besturen   SOAP: een HTTP-verzoek naar het apparaat met een XML-envelop
 *              erin. Pauzeren, volgende, volume, en opvragen wat er speelt.
 *
 * Wat hier NIET in zit, en waarom:
 *
 *   Chromecast en Google Nest spreken geen UPnP maar een eigen protocol
 *   (castv2, protobuf over TLS). Dat is een ander bouwwerk, en bovendien laat
 *   een Chromecast waarop iemand Spotify heeft gecast zich door een derde app
 *   niet besturen. Vindt de kassa wel iets van Google, dan zegt hij dat -- dan
 *   weten we dat het de moeite waard is om erbij te bouwen.
 *
 *   Spotify Connect. Dat gaat via hun cloud, vraagt Premium en een inlog per
 *   kassa, en muziek in een bedrijfsruimte valt buiten een persoonlijk
 *   abonnement. Dat is een beslissing en geen bouwwerk.
 */

const dgram = require('node:dgram')
const http = require('node:http')
const { URL } = require('node:url')

/* ------------------------------------------------------------------ */
/* Zoeken op het netwerk (SSDP)                                        */
/* ------------------------------------------------------------------ */

const SSDP_ADRES = '239.255.255.250'
const SSDP_POORT = 1900

/**
 * Waar we naar vragen.
 *
 * Twee vragen achter elkaar. De eerste vindt alles wat muziek kan spelen; de
 * tweede vindt Sonos ook als hij zich niet als mediarenderer meldt (oudere
 * modellen doen dat niet altijd). Dubbele antwoorden filteren we er later uit.
 */
const ZOEKOPDRACHTEN = [
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'urn:schemas-upnp-org:device:ZonePlayer:1',
]

function zoekBericht(doel) {
  return Buffer.from(
    'M-SEARCH * HTTP/1.1\r\n' +
    `HOST: ${SSDP_ADRES}:${SSDP_POORT}\r\n` +
    'MAN: "ssdp:discover"\r\n' +
    'MX: 2\r\n' +
    `ST: ${doel}\r\n` +
    '\r\n',
  )
}

/** De kopregels uit een SSDP-antwoord, met kleine letters als sleutel. */
function kopregels(tekst) {
  const uit = {}
  for (const regel of String(tekst).split('\r\n')) {
    const dp = regel.indexOf(':')
    if (dp === -1) continue
    uit[regel.slice(0, dp).trim().toLowerCase()] = regel.slice(dp + 1).trim()
  }
  return uit
}

/**
 * Vraagt het netwerk wie er muziek kan spelen.
 *
 * Geeft de adressen van de beschrijvingen terug, plus wat er van Google
 * langskwam. Dat laatste is geen bruikbaar apparaat voor ons, maar wel het
 * antwoord op de vraag of er een Chromecast staat.
 */
function zoekAdressen(wachtMs = 3000) {
  return new Promise((klaar) => {
    const gevonden = new Map()
    const anders = new Set()
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

    socket.on('message', (bericht, van) => {
      const kop = kopregels(bericht.toString('utf8'))
      const locatie = kop.location
      const server = kop.server || ''

      if (locatie && !gevonden.has(locatie)) {
        gevonden.set(locatie, { locatie, ip: van.address, server })
      }
      // Google-apparaten melden zich soms via SSDP zonder bruikbare
      // besturing; we onthouden alleen dát ze er zijn.
      if (/google|chromecast/i.test(server)) anders.add(van.address)
    })

    socket.on('error', () => {
      try { socket.close() } catch { /* al dicht */ }
      klaar({ adressen: [], google: [] })
    })

    socket.bind(() => {
      try {
        socket.setBroadcast(true)
      } catch { /* niet overal nodig */ }

      for (const doel of ZOEKOPDRACHTEN) {
        const bericht = zoekBericht(doel)
        socket.send(bericht, 0, bericht.length, SSDP_POORT, SSDP_ADRES)
      }
    })

    setTimeout(() => {
      try { socket.close() } catch { /* al dicht */ }
      klaar({ adressen: [...gevonden.values()], google: [...anders] })
    }, wachtMs)
  })
}

/* ------------------------------------------------------------------ */
/* De beschrijving van een apparaat ophalen                            */
/* ------------------------------------------------------------------ */

function haalOp(adres, timeout = 4000) {
  return new Promise((klaar, mis) => {
    const verzoek = http.get(adres, { timeout }, (antwoord) => {
      if (antwoord.statusCode !== 200) {
        antwoord.resume()
        return mis(new Error(`HTTP ${antwoord.statusCode}`))
      }
      let tekst = ''
      antwoord.setEncoding('utf8')
      antwoord.on('data', (d) => { tekst += d })
      antwoord.on('end', () => klaar(tekst))
    })
    verzoek.on('timeout', () => { verzoek.destroy(); mis(new Error('geen antwoord')) })
    verzoek.on('error', mis)
  })
}

/** Eén tag uit XML halen. Geen parser nodig voor zo weinig. */
function tag(xml, naam) {
  const m = new RegExp(`<${naam}[^>]*>([\\s\\S]*?)</${naam}>`, 'i').exec(xml)
  return m ? m[1].trim() : ''
}

/**
 * De beschrijving van een apparaat uitlezen.
 *
 * Wat we eruit nodig hebben: hoe het heet, en de twee adressen waar we naartoe
 * mogen praten -- één voor pauze en volgende (AVTransport), één voor volume
 * (RenderingControl). Die staan in de servicelijst en verschillen per merk,
 * dus die zoeken we op in plaats van ze te verzinnen.
 *
 * Geeft null als het geen apparaat is waar wij iets mee kunnen. Dat is geen
 * fout: een netwerk staat vol met dingen die op SSDP antwoorden.
 */
function parseerApparaat(xml, locatie) {
  const basis = new URL(locatie)
  const wortel = `${basis.protocol}//${basis.host}`

  const diensten = [...xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)]
    .map((m) => ({
      type: tag(m[1], 'serviceType'),
      controle: tag(m[1], 'controlURL'),
    }))
    .filter((d) => d.type && d.controle)

  const vind = (soort) =>
    diensten.find((d) => d.type.includes(soort))?.controle ?? ''

  const transport = vind('AVTransport')
  const volume = vind('RenderingControl')

  // Zonder AVTransport valt er niets te pauzeren; dan is het voor ons geen
  // muziekapparaat maar bijvoorbeeld een router of een printer.
  if (!transport) return null

  const heel = (pad) => (pad.startsWith('http') ? pad : wortel + (pad.startsWith('/') ? pad : '/' + pad))

  // Sonos noemt de ruimte in plaats van het apparaat; dat leest beter aan een
  // balie ("Balie" is duidelijker dan "Sonos One SL").
  const kamer = tag(xml, 'roomName')
  const naam = tag(xml, 'friendlyName')

  return {
    id: wortel,
    naam: kamer || naam || basis.hostname,
    merk: tag(xml, 'manufacturer'),
    model: tag(xml, 'modelName'),
    wortel,
    transportUrl: heel(transport),
    volumeUrl: volume ? heel(volume) : '',
  }
}

/* ------------------------------------------------------------------ */
/* Besturen (SOAP)                                                     */
/* ------------------------------------------------------------------ */

const AV = 'urn:schemas-upnp-org:service:AVTransport:1'
const RC = 'urn:schemas-upnp-org:service:RenderingControl:1'

function envelop(dienst, actie, velden) {
  const inhoud = Object.entries(velden)
    .map(([k, v]) => `<${k}>${String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</${k}>`)
    .join('')

  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${actie} xmlns:u="${dienst}">${inhoud}</u:${actie}></s:Body>` +
    '</s:Envelope>'
}

function soap(adres, dienst, actie, velden = {}, timeout = 4000) {
  return new Promise((klaar, mis) => {
    const lijf = Buffer.from(envelop(dienst, actie, { InstanceID: 0, ...velden }), 'utf8')
    const url = new URL(adres)

    const verzoek = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: 'POST',
        timeout,
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          'Content-Length': lijf.length,
          SOAPACTION: `"${dienst}#${actie}"`,
        },
      },
      (antwoord) => {
        let tekst = ''
        antwoord.setEncoding('utf8')
        antwoord.on('data', (d) => { tekst += d })
        antwoord.on('end', () => {
          if (antwoord.statusCode !== 200) {
            // Het apparaat vertelt in de fout wat er niet kan; dat is nuttiger
            // dan "HTTP 500".
            const uitleg = tag(tekst, 'errorDescription') || tag(tekst, 'faultstring')
            return mis(new Error(uitleg || `HTTP ${antwoord.statusCode}`))
          }
          klaar(tekst)
        })
      },
    )

    verzoek.on('timeout', () => { verzoek.destroy(); mis(new Error('geen antwoord')) })
    verzoek.on('error', mis)
    verzoek.end(lijf)
  })
}

/** Titel en artiest uit de metadata die AVTransport teruggeeft. */
function parseerNummer(xml) {
  const metadata = tag(xml, 'TrackMetaData')
  // De metadata is XML in XML, dus eerst de entiteiten terug.
  const binnen = metadata
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')

  const titel = tag(binnen, 'dc:title')
  const artiest = tag(binnen, 'dc:creator') || tag(binnen, 'upnp:artist')
  const album = tag(binnen, 'upnp:album')
  const duur = tag(xml, 'TrackDuration')
  const positie = tag(xml, 'RelTime')

  return {
    titel: titel || '',
    artiest: artiest || '',
    album: album || '',
    duur: duur && duur !== 'NOT_IMPLEMENTED' ? duur : '',
    positie: positie && positie !== 'NOT_IMPLEMENTED' ? positie : '',
  }
}

/* ------------------------------------------------------------------ */
/* Wat de app kan vragen                                               */
/* ------------------------------------------------------------------ */

async function zoek() {
  const { adressen, google } = await zoekAdressen()

  const apparaten = []
  const gezien = new Set()

  for (const { locatie } of adressen) {
    try {
      const xml = await haalOp(locatie)
      const apparaat = parseerApparaat(xml, locatie)
      if (apparaat && !gezien.has(apparaat.id)) {
        gezien.add(apparaat.id)
        apparaten.push(apparaat)
      }
    } catch {
      // Een apparaat dat niet wil antwoorden slaan we over; het netwerk staat
      // vol met dingen die op SSDP reageren en verder niets kunnen.
    }
  }

  apparaten.sort((a, b) => a.naam.localeCompare(b.naam, 'nl'))
  return { apparaten, google }
}

/** Wat er nu speelt, en hoe hard. */
async function stand(apparaat) {
  const uit = { speelt: false, volume: null, gedempt: false, nummer: null, fout: null }

  try {
    const transport = await soap(apparaat.transportUrl, AV, 'GetTransportInfo')
    uit.speelt = /PLAYING/i.test(tag(transport, 'CurrentTransportState'))
  } catch (e) {
    uit.fout = e.message
    return uit
  }

  try {
    const positie = await soap(apparaat.transportUrl, AV, 'GetPositionInfo')
    uit.nummer = parseerNummer(positie)
  } catch { /* niet elk apparaat vertelt wat er speelt */ }

  if (apparaat.volumeUrl) {
    try {
      const vol = await soap(apparaat.volumeUrl, RC, 'GetVolume', { Channel: 'Master' })
      const n = Number(tag(vol, 'CurrentVolume'))
      if (Number.isFinite(n)) uit.volume = n
    } catch { /* volume niet op te vragen: dan verbergen we de schuif */ }

    try {
      const dempt = await soap(apparaat.volumeUrl, RC, 'GetMute', { Channel: 'Master' })
      uit.gedempt = tag(dempt, 'CurrentMute') === '1'
    } catch { /* niet erg */ }
  }

  return uit
}

/**
 * Eén handeling.
 *
 * Geeft altijd een antwoord en gooit nooit: dit hangt aan een kassa, en een
 * speaker die niet meewerkt mag het afrekenen niet in de weg staan.
 */
async function bestuur(apparaat, actie, waarde) {
  try {
    switch (actie) {
      case 'spelen':
        await soap(apparaat.transportUrl, AV, 'Play', { Speed: 1 })
        return { ok: true }
      case 'pauze':
        await soap(apparaat.transportUrl, AV, 'Pause')
        return { ok: true }
      case 'volgende':
        await soap(apparaat.transportUrl, AV, 'Next')
        return { ok: true }
      case 'vorige':
        await soap(apparaat.transportUrl, AV, 'Previous')
        return { ok: true }
      case 'volume': {
        if (!apparaat.volumeUrl) return { ok: false, reden: 'Dit apparaat laat het volume niet instellen.' }
        const n = Math.max(0, Math.min(100, Math.round(Number(waarde) || 0)))
        await soap(apparaat.volumeUrl, RC, 'SetVolume', { Channel: 'Master', DesiredVolume: n })
        return { ok: true }
      }
      case 'dempen': {
        if (!apparaat.volumeUrl) return { ok: false, reden: 'Dit apparaat laat dempen niet instellen.' }
        await soap(apparaat.volumeUrl, RC, 'SetMute', {
          Channel: 'Master', DesiredMute: waarde ? 1 : 0,
        })
        return { ok: true }
      }
      default:
        return { ok: false, reden: `Onbekende handeling: ${actie}` }
    }
  } catch (e) {
    return { ok: false, reden: e && e.message ? e.message : String(e) }
  }
}

module.exports = {
  zoek,
  stand,
  bestuur,
  // Voor de zelftest: de stukken die je zonder speaker kunt nakijken.
  _intern: { kopregels, tag, parseerApparaat, parseerNummer, envelop },
}
