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
const VASTGELOPEN = VAST_VLAG

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

    /*
     * Nepfoto's, hier ter plekke getekend.
     *
     * Geen bestanden erbij dus, en het loopt langs dezelfde weg als een echte
     * foto: een canvas, toDataURL als JPEG, en daarna door veiligeAfbeelding
     * heen. Zo laat de afdruk ook zien dat die weg werkt.
     */
    const nepfoto = (kleur, dop) => {
      const doek = document.createElement('canvas')
      doek.width = 240
      doek.height = 240
      const pen = doek.getContext('2d')
      pen.fillStyle = '#f4f5f7'
      pen.fillRect(0, 0, 240, 240)
      // een flesje: dop, hals, romp, etiket
      pen.fillStyle = dop
      pen.fillRect(100, 28, 40, 26)
      pen.fillStyle = kleur
      pen.fillRect(106, 54, 28, 26)
      pen.beginPath()
      pen.roundRect(72, 78, 96, 132, 14)
      pen.fill()
      pen.fillStyle = 'rgba(255,255,255,.85)'
      pen.fillRect(72, 118, 96, 46)
      pen.fillStyle = kleur
      pen.fillRect(80, 132, 60, 6)
      pen.fillRect(80, 146, 42, 6)
      return doek.toDataURL('image/jpeg', 0.8)
    }

    const t = db.transaction(
      ['users', 'registers', 'locations', 'meta', 'safes', 'safeMoves', 'products',
       'timeEntries', 'outbox', 'inventory'],
      'readwrite')
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

    /*
     * Iemand aan het werk, en een wachtrij waarin zijn inklokking vastzit.
     *
     * Dit staat hier omdat het de afdruk is die de fout van gisteren laat zien:
     * een urenregel die de server weigert op de rechten. Die verdween eerst
     * stil na acht pogingen; nu blijft hij staan en komt er een melding.
     * Zonder deze zaadgegevens is dat op geen enkele afdruk te zien.
     */
    if (VASTGELOPEN) {
      t.objectStore('timeEntries').put({
        id: 'uur_demo', userId: 'u_ali', userName: 'Ali Yildiz',
        start: nu - 2 * 3600000, locationId: 'loc_demo', updatedAt: nu,
      })
      t.objectStore('outbox').put({
        entity: 'timeEntries', op: 'put', recordId: 'uur_demo',
        payload: { id: 'uur_demo' },
        createdAt: nu - 95 * 60000,
        tries: 0,
        geweigerd: 14,
        lastError:
          'De database weigert dit voor "time_entries": new row violates ' +
          'row-level security policy for table "time_entries". Dat gaat over ' +
          'rechten, niet over dit record -- het blijft in de wachtrij staan.',
      })
      t.objectStore('outbox').put({
        entity: 'saleLines', op: 'put', recordId: 'regel_demo',
        payload: { id: 'regel_demo' },
        createdAt: nu - 20 * 60000, tries: 0, geweigerd: 6,
      })
      // En iets dat gewoon nog niet geweest is: dat hoort géén melding te geven.
      t.objectStore('outbox').put({
        entity: 'sales', op: 'put', recordId: 'bon_demo',
        payload: { id: 'bon_demo' }, createdAt: nu, tries: 0,
      })
    }

    // Artikelen, met en zonder foto, zodat beide standen op de afdruk staan.
    const artikelen = [
      { id: 'a1', code: 'A001', name: 'Koffie', groupName: 'Shop', unit: 'beker',
        priceIncl: 2.5, vatPct: 9, kind: 'artikel', sort: 10 },
      { id: 'a2', code: 'A010', name: 'Ruitenwisservloeistof zomer', groupName: 'Shop',
        unit: 'fles', priceIncl: 7.95, vatPct: 21, kind: 'artikel', sort: 20,
        image: nepfoto('#2f7ed8', '#1b4f8f') },
      { id: 'a3', code: 'A011', name: 'Ruitenwisservloeistof winter', groupName: 'Shop',
        unit: 'fles', priceIncl: 9.5, vatPct: 21, kind: 'artikel', sort: 30,
        image: nepfoto('#7a3fd8', '#4c208f') },
      { id: 'a4', code: 'A020', name: 'Handreiniger', groupName: 'Shop',
        unit: 'fles', priceIncl: 4.75, vatPct: 21, kind: 'artikel', sort: 40,
        image: nepfoto('#e0a11b', '#9c6c0d') },
      { id: 'a5', code: 'A030', name: 'Microvezeldoek', groupName: 'Shop',
        unit: 'stuk', priceIncl: 3.25, vatPct: 21, kind: 'artikel', sort: 50 },
      { id: 'a6', code: 'W001', name: 'Buitenwas', groupName: 'Wassen', unit: 'stuk',
        priceIncl: 78.65, vatPct: 21, kind: 'wasbeurt', washService: 'buitenwas', sort: 10 },
    ]
    for (const a of artikelen) {
      t.objectStore('products').put({
        locationId: 'loc_demo', active: true, updatedAt: nu, ...a,
      })
    }

    /*
     * Voorraadartikelen van Trucksupply, gekoppeld aan drie van die producten.
     *
     * Drie standen, want het verschil ertussen is waar het scherm voor is:
     * genoeg leest je langs, onder het minimum valt op, en leeg houdt je
     * tegen. Bij de winterfles staat met opzet geen eigen productfoto: die
     * moet de foto van het artikel oppakken.
     */
    const artikelen_voorraad = [
      { id: 'inv_zomer', name: 'Ruitenwisservloeistof zomer', unit: 'fles',
        stock: 14, minStock: 6, sku: 'TS-1044' },
      { id: 'inv_winter', name: 'Ruitenwisservloeistof winter', unit: 'fles',
        stock: 2, minStock: 6, sku: 'TS-1045', image: nepfoto('#7a3fd8', '#4c208f') },
      { id: 'inv_hand', name: 'Handreiniger', unit: 'fles',
        stock: 0, minStock: 4, sku: 'TS-2010' },
    ]
    for (const v of artikelen_voorraad) {
      t.objectStore('inventory').put({
        locationId: 'loc_demo', pricePerUnit: 2.5, supplier: 'Trucksupply',
        actief: true, bestelhoeveelheid: 12, updatedAt: nu, ...v,
      })
    }

    // En de koppeling erop, zoals de serverfunctie hem legt.
    t.objectStore('products').put({
      ...artikelen[1], locationId: 'loc_demo', active: true, updatedAt: nu,
      inventoryItemId: 'inv_zomer',
    })
    t.objectStore('products').put({
      ...artikelen[2], locationId: 'loc_demo', active: true, updatedAt: nu,
      inventoryItemId: 'inv_winter', image: undefined,
    })
    t.objectStore('products').put({
      ...artikelen[3], locationId: 'loc_demo', active: true, updatedAt: nu,
      inventoryItemId: 'inv_hand',
    })

    // Een kluis met iets erin, anders is het kluisscherm een lege doos.
    t.objectStore('safes').put({
      id: 'kluis_loc_demo', locationId: 'loc_demo', name: 'Kluis Utrecht',
      active: true, updatedAt: nu,
    })
    const kluisboekingen = [
      { id: 'kl_a', soort: 'telling', coins: {},
        counted: { b100: 2, b50: 3, b20: 4, m200: 20 },
        amount: 0, expected: 430, difference: 0,
        userName: 'Casper de Vries', at: nu - 86400000 * 6 },
      { id: 'kl_b', soort: 'afstorting', coins: { b50: 2, b20: 3 }, amount: 160,
        reason: 'Uit KAS-UTR-1', userName: 'Ali Yildiz', at: nu - 86400000 * 2 },
      { id: 'kl_c', soort: 'wisselgeld', coins: { m200: 10 }, amount: -20,
        reason: 'Naar KAS-UTR-1', userName: 'Casper de Vries', at: nu - 3600000 * 5 },
    ]
    for (const b of kluisboekingen) {
      t.objectStore('safeMoves').put({
        safeId: 'kluis_loc_demo', locationId: 'loc_demo', reason: '',
        userId: 'u_demo', updatedAt: nu, ...b,
      })
    }
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
  { naam: 'koppelen-donker', thema: 'donker', breedte: 1366, hoogte: 850 },
  { naam: 'koppelen-licht', thema: 'licht', breedte: 1366, hoogte: 850 },
  { naam: 'aanmelden-donker', thema: 'donker', breedte: 1366, hoogte: 850, zaad: true },
  { naam: 'aanmelden-licht', thema: 'licht', breedte: 1366, hoogte: 850, zaad: true },
  // Een kleine tablet in liggende stand: de maat waarop dingen gaan wringen.
  { naam: 'aanmelden-tablet', thema: 'donker', breedte: 1024, hoogte: 700, zaad: true },

  // En de schermen waar iemand de hele dag naar kijkt. Het nummer is dat van
  // de nepmedewerker uit ZAAD.
  { naam: 'kassa-donker', thema: 'donker', breedte: 1366, hoogte: 850, zaad: true, nummer: '014' },
  { naam: 'kassa-licht', thema: 'licht', breedte: 1366, hoogte: 850, zaad: true, nummer: '014' },
  { naam: 'klok', thema: 'donker', breedte: 1366, hoogte: 850, zaad: true, nummer: '014', tab: 'Klok' },
  // De melding die er niet was toen een inklokking verdween.
  { naam: 'klok-vast', thema: 'donker', breedte: 1366, hoogte: 850, zaad: true,
    nummer: '014', tab: 'Klok', vast: true },
  { naam: 'klok-vast-licht', thema: 'licht', breedte: 1366, hoogte: 850, zaad: true,
    nummer: '014', tab: 'Klok', vast: true },
  { naam: 'kas', thema: 'donker', breedte: 1366, hoogte: 850, zaad: true, nummer: '014', tab: 'Kas' },
  { naam: 'kluis', thema: 'donker', breedte: 1366, hoogte: 850, zaad: true, nummer: '014', tab: 'Kluis' },
  { naam: 'kluis-licht', thema: 'licht', breedte: 1366, hoogte: 850, zaad: true, nummer: '014', tab: 'Kluis' },
  // Het muntenbord zelf: waar de kluis om draait.
  { naam: 'kluis-wisselgeld', thema: 'donker', breedte: 1366, hoogte: 850, zaad: true, nummer: '014', tab: 'Kluis', knop: 'Wisselgeld halen' },
  { naam: 'kluis-tellen', thema: 'donker', breedte: 1366, hoogte: 850, zaad: true, nummer: '014', tab: 'Kluis', knop: 'Kluis tellen' },
  /*
   * De krapste maat waarop dit nog moet werken: een tablet in liggende
   * stand, met een vastgelopen wachtrij erbij. Dat is de stand waarin de
   * Beheer-tab niet meer in te drukken was.
   */
  { naam: 'balk-krap', thema: 'donker', breedte: 1024, hoogte: 700, zaad: true,
    nummer: '014', tab: 'Klok', vast: true },
  // En met een update die klaarstaat: een stip op Beheer, geen pil in de balk.
  { naam: 'update-stip', thema: 'donker', breedte: 1366, hoogte: 850, zaad: true,
    nummer: '014', tab: 'Kassa', update: true },
  { naam: 'muziek', thema: 'donker', breedte: 1366, hoogte: 850, zaad: true, nummer: '014', tab: 'Muziek' },
  { naam: 'beheer', thema: 'donker', breedte: 1366, hoogte: 850, zaad: true, nummer: '014', tab: 'Beheer' },
  { naam: 'beheer-kassa', thema: 'donker', breedte: 1366, hoogte: 1000, zaad: true, nummer: '014',
    tab: 'Beheer', knop: 'Deze kassa' },
  { naam: 'ontkoppelen', thema: 'donker', breedte: 1366, hoogte: 850, zaad: true, nummer: '014',
    tab: 'Beheer', knop: ['Deze kassa', 'Ontkoppelen'] },
  // Eén artikel bekijken: alles alleen-lezen, met de foto en de voorraad erbij.
  { naam: 'artikel-bekijken', thema: 'donker', breedte: 1366, hoogte: 900, zaad: true,
    nummer: '014', tab: 'Beheer', knop: ['@table.tabel tbody tr:nth-child(2)'] },
  { naam: 'speler', thema: 'donker', breedte: 1366, hoogte: 850, zaad: true, nummer: '014', tab: 'Speler' },
  { naam: 'speler-licht', thema: 'licht', breedte: 1366, hoogte: 850, zaad: true, nummer: '014', tab: 'Speler' },
]

// Hetzelfde als in main.cjs: het speler://-schema moet aangemeld worden
// voordat de app klaar is, anders komen bestanden er niet door.
speler.meldSchemaAan()

const wacht = (ms) => new Promise((r) => setTimeout(r, ms))

async function maak({ naam, thema, breedte, hoogte, zaad, nummer, tab, knop, vast, update }) {
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
    const zaad = ZAAD.replace('VAST_VLAG', vast ? 'true' : 'false')
    const gelukt = await win.webContents.executeJavaScript(zaad, true)
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
    /*
     * Ruim wachten, en niet krap. Na het aanmelden zet de app het blad terug
     * op Kassa -- een nieuwe medewerker begint niet waar de vorige gebleven
     * was. Klik je te snel op een tabblad, dan gooit die reactie het er weer
     * af, en staat er op de afdruk het kassascherm terwijl er niets fout is.
     */
    await wacht(2400)
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

  /*
   * En een knop erin, zodat ook wat in een venster zit op de afdruk komt.
   *
   * Zonder dit zie je van de kluis alleen het overzicht, en juist het bord met
   * briefjes en munten is het onderdeel waar het om gaat -- dat zit achter een
   * knop. Een deel van de app dat je nooit ziet, is een deel waar een fout
   * ongestoord in blijft zitten.
   */
  // Eén knop of een rijtje achter elkaar, want soms zit iets twee klikken diep.
  for (const label of (Array.isArray(knop) ? knop : knop ? [knop] : [])) {
    /*
     * Een knop op zijn tekst, of -- met @ ervoor -- iets anders op een
     * CSS-kiezer. Dat tweede is er voor rijen in een tabel: die zijn geen
     * knop, en juist wat daarachter zit (het artikelformulier) wil je op een
     * afdruk kunnen zien.
     */
    const gelukt = await win.webContents.executeJavaScript(`
      (() => {
        const kiezer = ${JSON.stringify(label)}
        const doel = kiezer.startsWith('@')
          ? document.querySelector(kiezer.slice(1))
          : [...document.querySelectorAll('button')]
              .find((b) => b.textContent && b.textContent.includes(kiezer))
        if (!doel) return false
        doel.click()
        return true
      })()
    `)
    if (!gelukt) console.log(`  (${naam}: knop "${label}" niet gevonden)`)
    await wacht(900)
  }

  /*
   * Nakijken of elke tab te raken is.
   *
   * Dit is er omdat een afdruk daar niet over gaat: op een plaatje ziet een
   * strook die je moet verschuiven er precies zo uit als een strook die past.
   * Wat telt is of het middelpunt van de knop binnen het venster valt en of er
   * niets bovenop ligt -- dat is wat een vinger doet.
   */
  /*
   * Doen alsof er een update klaarstaat.
   *
   * Via hetzelfde bericht dat de echte updater stuurt (update:status), zodat de
   * afdruk de weg volgt die het in het echt ook aflegt -- preload geeft het aan
   * de store, de store zet de stip op Beheer. Een nagemaakte stip zou alleen
   * bewijzen dat CSS werkt.
   */
  if (update) {
    // Let op het veld: de store leest `state`, niet `kind`. Met `kind` kwam er
    // geen stip en leek de stip stuk, terwijl het bericht niet aankwam.
    win.webContents.send('update:status', { state: 'ready', version: '0.11.0' })
    await wacht(500)
  }

  if (tab || nummer) {
    const bereik = await win.webContents.executeJavaScript(`
      (() => {
        /*
         * Staat er een venster open, dan hoort er niets achter raakbaar te
         * zijn -- dat is precies wat een venster doet. Zonder deze regel riep
         * de meting "NIET TE RAKEN" bij elke afdruk met een dialoog erop.
         */
        if (document.querySelector('.sluier')) return JSON.stringify([])

        const uit = []
        for (const knop of document.querySelectorAll('.balk .tab')) {
          const r = knop.getBoundingClientRect()
          const x = Math.round(r.left + r.width / 2)
          const y = Math.round(r.top + r.height / 2)
          const bovenop = document.elementFromPoint(x, y)
          uit.push({
            naam: (knop.textContent || '').trim(),
            binnen: r.left >= 0 && r.right <= window.innerWidth
                    && r.top >= 0 && r.bottom <= window.innerHeight,
            raakbaar: Boolean(bovenop && knop.contains(bovenop)),
          })
        }
        return JSON.stringify(uit)
      })()
    `).catch(() => null)

    if (bereik) {
      const tabs = JSON.parse(bereik)
      const stuk = tabs.filter((t) => !t.binnen || !t.raakbaar)
      if (tabs.length && stuk.length) {
        console.log(`  (${naam}: NIET TE RAKEN -- ` +
          stuk.map((t) => t.naam).join(', ') + ')')
      } else if (tabs.length) {
        console.log(`  (${naam}: alle ${tabs.length} tabbladen zijn te raken)`)
      }
    }
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
