/**
 * Maakt schermafdrukken van de gebouwde app.
 *
 * Waarom dit bestaat: "de UI is vervelend" is niet op te lossen met CSS lezen.
 * Dit start de app, wacht tot hij staat, en legt vast wat er daadwerkelijk in
 * beeld komt -- in licht én donker, en op de maten waarop een kassa staat.
 *
 *   npm run build
 *   node scripts/schermafdruk.cjs
 *
 * De afdrukken komen in schermafdrukken/ (die map staat in .gitignore).
 *
 * Het venster verschijnt kort in beeld. Dat moet: een venster dat nooit
 * getekend wordt, levert een lege afbeelding op.
 */

const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const speler = require(path.join(__dirname, '..', 'electron', 'speler.cjs'))
const ipc = require(path.join(__dirname, '..', 'electron', 'ipc.cjs'))

const WORTEL = path.resolve(__dirname, '..')
const DOEL = path.join(WORTEL, 'schermafdrukken')

/**
 * Nepgegevens om verder te komen dan het inrichtscherm.
 *
 * Zonder dit zie je altijd de inlogpagina, en juist de schermen daarachter
 * zijn de schermen waar iemand de hele dag naar kijkt. Dit zet een sessie en
 * een kassa rechtstreeks in IndexedDB -- dezelfde plek waar de app ze zelf
 * neerzet -- zodat de app denkt dat hij is ingericht.
 *
 * Alleen voor afdrukken. Het gaat naar een aparte sessie per afdruk, dus het
 * raakt de echte kassa op dit apparaat niet aan.
 */
const MUZIEKMAP = path.join(WORTEL, 'schermafdrukken', 'proefmuziek')

const ZAAD = `
const MUZIEKMAP = ${JSON.stringify(MUZIEKMAP)}

new Promise((klaar) => {
  const verzoek = indexedDB.open('truckwash-kassa')
  verzoek.onsuccess = () => {
    const db = verzoek.result
    const nu = Date.now()

    const mensen = [
      { id: 'u_demo', email: 'demo@truckwash1group.nl', name: 'Casper de Vries',
        roles: ['management'], active: true, locationId: 'loc_demo',
        personnelNumber: '014', updatedAt: nu },
      { id: 'u_ali', email: 'ali@truckwash1group.nl', name: 'Ali Yildiz',
        roles: ['employee'], active: true, locationId: 'loc_demo',
        personnelNumber: '027', updatedAt: nu },
      // Twee zonder nummer, zodat de melding onderaan in beeld komt.
      { id: 'u_nieuw1', email: 'nieuw1@truckwash1group.nl', name: 'Joris Peters',
        roles: ['employee'], active: true, locationId: 'loc_demo', updatedAt: nu },
      { id: 'u_nieuw2', email: 'nieuw2@truckwash1group.nl', name: 'Sanne Bos',
        roles: ['employee'], active: true, locationId: 'loc_demo', updatedAt: nu },
    ]

    const t = db.transaction(['users', 'registers', 'locations', 'meta'], 'readwrite')
    for (const m of mensen) t.objectStore('users').put(m)
    t.objectStore('locations').put({
      id: 'loc_demo', code: 'TW-UTR', name: 'Utrecht', kind: 'vestiging',
      address: 'Wasstraat 1', postcode: '3500 AA', city: 'Utrecht',
      bays: 2, active: true, updatedAt: nu,
    })
    t.objectStore('registers').put({
      id: 'reg_demo', locationId: 'loc_demo', code: 'KAS-UTR-1', name: 'Balie',
      printer: { kind: 'geen', breedte: 42 }, terminal: { provider: 'handmatig' },
      lastSeq: 0, active: true, updatedAt: nu,
    })
    t.objectStore('meta').put({ key: 'registerId', value: 'reg_demo' })
    // De proefmuziekmap, zodat het Speler-scherm niet leeg in beeld komt.
    t.objectStore('meta').put({ key: 'spelerMap', value: MUZIEKMAP })
    t.oncomplete = () => {
      localStorage.setItem('kassa.sessie', JSON.stringify({ userId: 'u_demo', at: nu }))
      klaar(true)
    }
    t.onerror = () => klaar(false)
  }
  verzoek.onerror = () => klaar(false)
})
`

/** Wat we willen zien, en hoe groot. */
const AFDRUKKEN = [
  { naam: 'inrichten-donker', thema: 'donker', breedte: 1366, hoogte: 850 },
  { naam: 'inrichten-licht', thema: 'licht', breedte: 1366, hoogte: 850 },
  { naam: 'aanmelden-donker', thema: 'donker', breedte: 1366, hoogte: 850, zaad: true },
  { naam: 'aanmelden-licht', thema: 'licht', breedte: 1366, hoogte: 850, zaad: true },
  // Een kleine tablet in liggende stand: de maat waarop dingen gaan wringen.
  { naam: 'aanmelden-tablet', thema: 'donker', breedte: 1024, hoogte: 700, zaad: true },

  // En de schermen waar iemand de hele dag naar kijkt. Het nummer is dat van
  // de nepmedewerker uit ZAAD.
  { naam: 'kassa-donker', thema: 'donker', breedte: 1366, hoogte: 850, zaad: true, nummer: '014' },
  { naam: 'kassa-licht', thema: 'licht', breedte: 1366, hoogte: 850, zaad: true, nummer: '014' },
  { naam: 'klok', thema: 'donker', breedte: 1366, hoogte: 850, zaad: true, nummer: '014', tab: 'Klok' },
  { naam: 'kas', thema: 'donker', breedte: 1366, hoogte: 850, zaad: true, nummer: '014', tab: 'Kas' },
  { naam: 'muziek', thema: 'donker', breedte: 1366, hoogte: 850, zaad: true, nummer: '014', tab: 'Muziek' },
  { naam: 'beheer', thema: 'donker', breedte: 1366, hoogte: 850, zaad: true, nummer: '014', tab: 'Beheer' },
  { naam: 'speler', thema: 'donker', breedte: 1366, hoogte: 850, zaad: true, nummer: '014', tab: 'Speler' },
  { naam: 'speler-licht', thema: 'licht', breedte: 1366, hoogte: 850, zaad: true, nummer: '014', tab: 'Speler' },
]

// Hetzelfde als in main.cjs: het speler://-schema moet aangemeld worden
// voordat de app klaar is, anders komen bestanden er niet door.
speler.meldSchemaAan()

const wacht = (ms) => new Promise((r) => setTimeout(r, ms))

async function maak({ naam, thema, breedte, hoogte, zaad, nummer, tab }) {
  const win = new BrowserWindow({
    width: breedte,
    height: hoogte,
    show: true,
    backgroundColor: '#0b1220',
    webPreferences: {
      preload: path.join(WORTEL, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Elke afdruk in een eigen sessie, zodat de ene niet de sessie of de
      // themakeuze van de andere overneemt.
      partition: 'afdruk-' + naam,
    },
  })
  win.setMenuBarVisibility(false)
  huidigVenster = win

  /*
   * De themakeuze staat in localStorage, en die moet er staan vóórdat de app
   * hem uitleest. Vandaar dat we hem hier zetten en daarna herladen -- dat is
   * betrouwbaarder dan hopen dat we er tussen laden en lezen in komen.
   */
  const pagina = path.join(WORTEL, 'dist', 'index.html')

  await win.loadFile(pagina)
  await win.webContents.executeJavaScript(
    `try { localStorage.setItem('tw.thema', ${JSON.stringify(thema)}) } catch {}`)

  if (zaad) {
    // De eerste keer laden heeft de database aangemaakt; nu kan het erin.
    await wacht(600)
    const gelukt = await win.webContents.executeJavaScript(ZAAD, true)
    if (!gelukt) console.log(`  (${naam}: nepgegevens klaarzetten lukte niet)`)
  }

  // Opnieuw laden met loadFile en niet met reload(): reload() geeft hier
  // geregeld ERR_FAILED terug als er kort daarvoor een ander venster is
  // weggegooid, en dan krijg je een lege afdruk zonder te weten waarom.
  await win.loadFile(pagina)
  // Even laten staan: de app haalt zijn sessie uit IndexedDB en tekent daarna.
  await wacht(2500)

  /*
   * Aanmelden door het nummer echt in te toetsen.
   *
   * Wie er achter de kassa staat, staat in het geheugen en niet in de opslag --
   * dat is met opzet, want het wisselt de hele dag. Dus zetten we het niet in
   * de database maar tikken we het in, net als een medewerker: cijfers en dan
   * Enter. Zo krijgen we ook de schermen achter het aanmelden in beeld.
   */
  if (nummer) {
    for (const teken of String(nummer)) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: teken })
      win.webContents.sendInputEvent({ type: 'char', keyCode: teken })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: teken })
      await wacht(60)
    }
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await wacht(1200)
  }

  if (tab) {
    const gelukt = await win.webContents.executeJavaScript(`
      (() => {
        const knop = [...document.querySelectorAll('.tab')]
          .find((b) => b.textContent && b.textContent.includes(${JSON.stringify(tab)}))
        if (!knop) return false
        knop.click()
        return true
      })()
    `)
    if (!gelukt) console.log(`  (${naam}: tabblad "${tab}" niet gevonden)`)
    await wacht(1200)
  }

  const plaat = await win.webContents.capturePage()
  const bytes = plaat.toPNG()

  /*
   * Een lege afdruk wegschrijven is erger dan geen afdruk: dan kijk je naar
   * een bestand van nul bytes en denk je dat het scherm zelf leeg is. Dus
   * proberen we het nog een keer en zeggen we het als het dan nog niet lukt.
   */
  if (bytes.length < 1024) {
    await wacht(1500)
    const tweede = (await win.webContents.capturePage()).toPNG()
    if (tweede.length < 1024) {
      console.log(`  ${naam.padEnd(22)} MISLUKT — het venster tekende niets`)
      return
    }
    fs.writeFileSync(path.join(DOEL, naam + '.png'), tweede)
  } else {
    fs.writeFileSync(path.join(DOEL, naam + '.png'), bytes)
  }

  const kb = fs.statSync(path.join(DOEL, naam + '.png')).size / 1024
  console.log(`  ${naam.padEnd(22)} ${breedte}x${hoogte}  ${kb.toFixed(0)} kB`)

  win.destroy()
  huidigVenster = null
  // Chromium heeft even nodig na het weggooien van een venster; zonder deze
  // pauze tekent het volgende soms niets.
  await wacht(400)
}

/*
 * Electron sluit de app af zodra het laatste venster dichtgaat -- dat is het
 * standaardgedrag op Windows. Hier is dat precies verkeerd: we maken de
 * afdrukken één voor één, dus tussen twee vensters is er even geen venster.
 * Zonder deze regel mislukt alles na de eerste afdruk met ERR_FAILED, en dat
 * zegt niets over de oorzaak.
 */
app.on('window-all-closed', () => {})

/** Het venster van de afdruk die nu gemaakt wordt. */
let huidigVenster = null

app.whenReady().then(async () => {
  speler.koppelSchema()

  /*
   * Dezelfde handlers als de echte app. Zonder dit krijgt het scherm
   * "No handler registered" terug op alles wat het aan de brug vraagt, en dan
   * staat er op de afdruk iets anders dan in het echt -- precies wat je met
   * een afdruk wilde voorkomen.
   */
  ipc.registreer({
    hoofdvenster: () => huidigVenster,
    paginaAdres: () => path.join(WORTEL, 'dist', 'index.html'),
  })

  fs.mkdirSync(DOEL, { recursive: true })
  console.log('\nSchermafdrukken\n')

  // node scripts/schermafdruk.cjs --alleen=speler
  const filter = (process.argv.find((a) => a.startsWith('--alleen=')) || '')
    .slice('--alleen='.length)

  const lijst = filter
    ? AFDRUKKEN.filter((a) => a.naam.includes(filter))
    : AFDRUKKEN

  for (const opdracht of lijst) {
    try {
      await maak(opdracht)
    } catch (e) {
      console.log(`  ${opdracht.naam}: mislukt — ${e.message}`)
    }
  }
  console.log('\nKlaar. Ze staan in schermafdrukken/\n')
  app.quit()
})
