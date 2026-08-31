/**
 * Zelftest van de kassa.
 *
 * Draait in Node met een nagebootste IndexedDB, zodat de dingen die geld
 * kosten echt getest worden en niet alleen compileren: het rekenwerk, de
 * persoonlijke code, het afrekenen, het crediteren en de kasafsluiting.
 *
 * De synchronisatie staat hierbij bewust uit. Dat is geen tekortkoming van de
 * test maar het geval dat je wilt kunnen bewijzen: een kassa zonder
 * verbinding rekent gewoon af, en alles wat naar de server moet blijft in de
 * wachtrij staan.
 *
 *   npm run selftest
 */

import 'fake-indexeddb/auto'

/* ---- browsertoestand nabootsen -------------------------------------- */

const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
}

// navigator is in Node alleen-lezen: eigenschap vervangen i.p.v. toewijzen
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  get: () => ({ onLine: false }),
})

;(globalThis as any).window = {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
}

/* ---- test-hulpjes --------------------------------------------------- */

let passed = 0
let failed = 0

function check(naam: string, ok: boolean, extra = '') {
  if (ok) {
    passed++
    console.log(`  ok   ${naam}`)
  } else {
    failed++
    console.log(`  FAIL ${naam}${extra ? ' — ' + extra : ''}`)
  }
}

const bijna = (a: number, b: number) => Math.abs(a - b) < 0.005

/* ---- modules ophalen na het opzetten van de globals ------------------ */

const { db, uid } = await import('../src/lib/db')
const geld = await import('../src/lib/geld')
const {
  badgeMaken, herkenBadge, herkenOpNummer, normaliseerNummer, nummerProbleem,
  nummersNakijken,
} = await import('../src/lib/code')
const klok = await import('../src/lib/klok')
const kaarten = await import('../src/lib/kaarten')
const kassa = await import('../src/lib/kassa')
const kas = await import('../src/lib/kas')
const { bonOpmaken, alsTekst, bonGegevens } = await import('../src/lib/bon')
const { PUSH_ORDER } = await import('../src/lib/sync')
const { vergelijkVersies } = await import('../src/lib/hardware/apkUpdate')

type User = import('../src/lib/types').User
type PosRegister = import('../src/lib/types').PosRegister
type PosProduct = import('../src/lib/types').PosProduct

/* ================================================================== *
 *  1. Rekenen met geld
 * ================================================================== */

console.log('\n1. Rekenen met geld')

check('afronden op centen', geld.centen(1.005) === 1.01, String(geld.centen(1.005)))
check('afronden houdt het teken', geld.centen(-1.005) === -1.01, String(geld.centen(-1.005)))
check('0.1 + 0.2 blijft 0.30', geld.centen(0.1 + 0.2) === 0.3)

const s21 = geld.splits(78.65, 21)
check('btw uit een prijs van 78,65 bij 21%', bijna(s21.btw, 13.65), String(s21.btw))
check('exclusief plus btw is precies inclusief', s21.excl + s21.btw === s21.incl,
  `${s21.excl} + ${s21.btw} = ${s21.excl + s21.btw}`)

// Dit is het geval waar een naïeve berekening een cent naast zit.
let allesKlopt = true
for (let cent = 1; cent <= 5000; cent++) {
  for (const pct of [21, 9, 0]) {
    const d = geld.splits(cent / 100, pct)
    if (geld.centen(d.excl + d.btw) !== d.incl) {
      allesKlopt = false
      break
    }
  }
}
check('bij vijfduizend bedragen × drie tarieven klopt de btw-splitsing', allesKlopt)

check('regel met korting', geld.regelTotaal({ qty: 2, priceIncl: 10, discountPct: 25 }) === 15)
check('korting op de regel', geld.regelKorting({ qty: 2, priceIncl: 10, discountPct: 25 }) === 5)

const c1 = geld.afrondenContant(12.32)
check('contant 12,32 wordt 12,30', c1.teBetalen === 12.3 && bijna(c1.verschil, -0.02),
  `${c1.teBetalen} / ${c1.verschil}`)
const c2 = geld.afrondenContant(12.33)
check('contant 12,33 wordt 12,35', c2.teBetalen === 12.35 && bijna(c2.verschil, 0.02),
  `${c2.teBetalen} / ${c2.verschil}`)
check('een bedrag op vijf cent blijft staan', geld.afrondenContant(12.35).verschil === 0)

const wissel = geld.wisselgeld(87.65)
const wisselSom = wissel.reduce((s, w) => geld.centen(s + w.aantal * w.coupure), 0)
check('wisselgeld telt op tot het bedrag', wisselSom === 87.65, String(wisselSom))

const totalen = geld.bonTotalen([
  { id: 'a', name: 'Buitenwas', kind: 'wasbeurt', qty: 1, priceIncl: 78.65, vatPct: 21, discountPct: 0 },
  { id: 'b', name: 'Koffie', kind: 'artikel', qty: 2, priceIncl: 2.5, vatPct: 9, discountPct: 0 },
])
check('bontotaal', totalen.incl === 83.65, String(totalen.incl))
check('btw-staffel heeft twee tarieven', totalen.staffel.length === 2)
check('staffel telt op tot het totaal',
  geld.centen(totalen.staffel.reduce((s, t) => s + t.incl, 0)) === totalen.incl)
check('exclusief plus btw is het totaal', geld.centen(totalen.excl + totalen.btw) === totalen.incl)

check('gemengd betalen heet gemengd',
  geld.betaalwijze([
    { method: 'contant', amount: 10 }, { method: 'pin', amount: 5 },
  ]) === 'gemengd')
check('een kaartbetaling van nul euro telt mee',
  geld.betaalwijze([{ method: 'abonnement', amount: 0 }]) === 'abonnement')

/* ---- versies vergelijken ----
 *
 * Dit bepaalt of een tablet zichzelf bijwerkt. Gaat het hier fout, dan
 * weigert hij een update zonder te zeggen waarom, of haalt hij er een op die
 * ouder is dan wat er staat.
 */

check('0.2.0 is nieuwer dan 0.1.1', vergelijkVersies('0.2.0', '0.1.1') > 0)
check('0.1.1 is ouder dan 0.2.0', vergelijkVersies('0.1.1', '0.2.0') < 0)
check('gelijk is gelijk', vergelijkVersies('1.2.3', '1.2.3') === 0)
check('de v ervoor doet niet mee', vergelijkVersies('v1.2.3', '1.2.3') === 0)

// Dit is het geval dat met een tekstvergelijking altijd fout gaat: als tekst
// komt "1" voor "9", dus zou 0.10.0 ouder lijken dan 0.9.0.
check('0.10.0 is nieuwer dan 0.9.0', vergelijkVersies('0.10.0', '0.9.0') > 0)
check('1.0.0 is nieuwer dan 0.99.99', vergelijkVersies('1.0.0', '0.99.99') > 0)

check('een ontbrekend deel geldt als nul', vergelijkVersies('1.2', '1.2.0') === 0)
check('en dan is 1.2.1 nieuwer dan 1.2', vergelijkVersies('1.2.1', '1.2') > 0)
check('onzin in het nummer laat de rest werken',
  vergelijkVersies('1.2.x', '1.2.0') === 0)

/* ================================================================== *
 *  2. Gegevens klaarzetten
 * ================================================================== */

console.log('\n2. Gegevens klaarzetten')

const wasser: User = {
  id: 'u_wasser', email: 'wasser@truckwash1group.nl', password: '', name: 'Ali Yildiz',
  roles: ['employee'], active: true, locationId: 'loc_utr', personnelNumber: 'TW-014',
  updatedAt: Date.now(),
}
const baas: User = {
  id: 'u_baas', email: 'baas@truckwash1group.nl', password: '', name: 'Casper',
  roles: ['management'], active: true, locationId: 'loc_utr', updatedAt: Date.now(),
}

await db.users.bulkPut([wasser, baas])
await db.locations.put({
  id: 'loc_utr', code: 'TW-UTR', name: 'Utrecht', kind: 'vestiging',
  address: 'Wasstraat 1', postcode: '3500 AA', city: 'Utrecht', bays: 2,
  active: true, updatedAt: Date.now(),
})
await db.companies.put({
  id: 'co_jansen', name: 'Transport Jansen B.V.', contact: 'Mark Jansen',
  email: 'planning@transportjansen.nl', phone: '030-1234567', city: 'Utrecht',
  contractDiscountPct: 10, updatedAt: Date.now(),
})
await db.inventory.put({
  id: 'inv_koffie', locationId: 'loc_utr', name: 'Koffiebonen', unit: 'kg',
  stock: 20, minStock: 5, pricePerUnit: 12, supplier: 'Koffiehuis',
  updatedAt: Date.now(),
})

const register: PosRegister = {
  id: 'reg_1', locationId: 'loc_utr', code: 'KAS-UTR-1', name: 'Balie',
  printer: { kind: 'geen', breedte: 42 }, terminal: { provider: 'handmatig' },
  lastSeq: 0, active: true, updatedAt: Date.now(),
}
await db.registers.put(register)

const koffie: PosProduct = {
  id: 'p_koffie', locationId: 'loc_utr', code: 'A001', barcode: '8712345678904',
  name: 'Koffie', groupName: 'Shop', unit: 'stuk', priceIncl: 2.5, vatPct: 9,
  kind: 'artikel', inventoryItemId: 'inv_koffie', sort: 10, active: true,
  updatedAt: Date.now(),
}
const buitenwas: PosProduct = {
  id: 'p_was', locationId: 'loc_utr', code: 'W001', name: 'Buitenwas',
  groupName: 'Wassen', unit: 'stuk', priceIncl: 78.65, vatPct: 21,
  kind: 'wasbeurt', washService: 'buitenwas', sort: 1, active: true,
  updatedAt: Date.now(),
}
const kaart10: PosProduct = {
  id: 'p_kaart', locationId: 'loc_utr', code: 'K010', name: '10-badenkaart',
  groupName: 'Kaarten', unit: 'stuk', priceIncl: 700, vatPct: 21,
  kind: 'strippenkaart', credits: 10, sort: 5, active: true, updatedAt: Date.now(),
}
await db.products.bulkPut([koffie, buitenwas, kaart10])

check('de kassa staat in de cache', (await db.registers.count()) === 1)
check('er zijn drie artikelen', (await db.products.count()) === 3)
check('de wachtrij is nog leeg', (await db.outbox.count()) === 0)

/* ---- de code van een kassa ---- */

const opschonen = kassa.kassaCodeOpschonen

check('een code met een spaties wordt bruikbaar gemaakt',
  opschonen('Balie 1') === 'BALIE-1', opschonen('Balie 1'))
check('punten worden streepjes',
  opschonen('KAS.UTR.1') === 'KAS-UTR-1', opschonen('KAS.UTR.1'))
check('kleine letters worden hoofdletters',
  opschonen('kas utr 1') === 'KAS-UTR-1', opschonen('kas utr 1'))
check('een bruikbare code blijft ongewijzigd',
  opschonen('KAS-UTR-1') === 'KAS-UTR-1', opschonen('KAS-UTR-1'))
check('ruimte eromheen valt eraf',
  opschonen('  KAS-UTR-1  ') === 'KAS-UTR-1', opschonen('  KAS-UTR-1  '))
check('leestekens vallen eraf',
  opschonen('Balie (voorkant)') === 'BALIE-VOORKANT', opschonen('Balie (voorkant)'))
check('dubbele streepjes worden er een',
  opschonen('KAS--UTR') === 'KAS-UTR', opschonen('KAS--UTR'))

check('twee tekens is te kort', kassa.kassaCodeProbleem(opschonen('ka')) !== null)
check('drie tekens mag', kassa.kassaCodeProbleem(opschonen('KAS')) === null)
check('meer dan twintig tekens is te lang',
  kassa.kassaCodeProbleem(opschonen('A'.repeat(21))) !== null)

/*
 * Waar dit over gaat: de code komt vooraan in elk bonnummer, en dat nummer
 * moet uniek zijn in de database. Een code die stilletjes iets anders wordt
 * dan wat iemand intikte, geeft later bonnummers die niemand terugvindt.
 */
const bonNaOpschonen = opschonen('Balie 1')
check('een opgeschoonde code levert een bruikbaar bonnummer',
  /^[A-Z0-9-]+$/.test(bonNaOpschonen))

/* ================================================================== *
 *  3. Aanmelden met het personeelsnummer
 * ================================================================== */

console.log('\n3. Aanmelden met het personeelsnummer')

/* ---- het nummer op één vorm brengen ---- */

check('streepjes en kleine letters doen niet mee',
  normaliseerNummer('tw-014') === 'TW014', normaliseerNummer('tw-014'))
check('ruimte eromheen valt eraf',
  normaliseerNummer('  014  ') === '014', normaliseerNummer('  014  '))
check('een leeg nummer blijft leeg', normaliseerNummer('  ') === '')

check('zonder nummer kom je er niet in', nummerProbleem('') !== null)
check('één cijfer mag', nummerProbleem('7') === null)
check('drie cijfers mag', nummerProbleem('014') === null)
check('acht cijfers mag ook', nummerProbleem('20260014') === null)
check('een nummer met letters mag', nummerProbleem('TW-014') === null)
check('vijfentwintig tekens is geen personeelsnummer',
  nummerProbleem('1'.repeat(25)) !== null)

/* ---- wat het toetsenblok met een aanslag doet ----
 *
 * Hier zat een fout die je alleen vindt door het echt in te toetsen: er werden
 * voorloopnullen weggehaald. Dus wie 014 intoetste, probeerde 14 en kreeg "dat
 * nummer is niet bekend" -- zonder aanwijzing.
 */

const { toetsErbij } = await import('../src/components/Toetsenblok')

check('een voorloopnul blijft staan', toetsErbij('0', '1', 24) === '01')
check('en twee ook', toetsErbij('00', '7', 24) === '007')
check('een gewoon nummer groeit gewoon', toetsErbij('01', '4', 24) === '014')
// En dan het geval waar het om gaat: 014 intoetsen op het blok, en dat
// vindt de wasser met nummer TW-014.
const ingetoetst = toetsErbij(toetsErbij(toetsErbij('', '0', 24), '1', 24), '4', 24)
check('wat je intoetst blijft 014', ingetoetst === '014', ingetoetst)
check('en daarmee wordt de medewerker gevonden',
  (await herkenOpNummer(ingetoetst)).ok)
check('voller dan de maat gaat niet', toetsErbij('123', '4', 3) === '123')

/* ---- herkennen ----
 *
 * De wasser staat in de cache met nummer TW-014. Drie manieren waarop iemand
 * dat intoetst horen alle drie te werken: het hele nummer, zonder streepje, en
 * op een cijfertoetsenbord alleen de cijfers.
 */

const opNummer = await herkenOpNummer('TW-014')
check('het hele nummer werkt', opNummer.ok && opNummer.user.id === wasser.id)

check('zonder streepje werkt ook', (await herkenOpNummer('TW014')).ok)
check('kleine letters ook', (await herkenOpNummer('tw-014')).ok)
check('alleen de cijfers ook (cijfertoetsenbord)', (await herkenOpNummer('014')).ok)

const onbekend = await herkenOpNummer('999999')
check('een onbekend nummer komt er niet in', !onbekend.ok)

/* ---- twee mensen op hetzelfde nummer ----
 *
 * Dit is het geval waarop de kassa moet weigeren in plaats van gokken: kwam er
 * een willekeurige van de twee uit, dan komen bon en urenstaat op de verkeerde
 * naam en merkt niemand het tot het over geld gaat.
 */

const tweeling: User = {
  id: 'u_tweeling', email: 'tweeling@truckwash1group.nl', password: '',
  name: 'Sam de Tweeling', roles: ['employee'], active: true,
  locationId: 'loc_utr', personnelNumber: 'TW-014', updatedAt: Date.now(),
}
await db.users.put(tweeling)

const dubbel = await herkenOpNummer('TW-014')
check('bij een dubbel nummer weigert hij', !dubbel.ok)
check('en zegt hij wie het zijn',
  !dubbel.ok && dubbel.reden === 'dubbel' && (dubbel.namen ?? []).length === 2,
  !dubbel.ok ? String(dubbel.reden) : '')

const nagekeken = await nummersNakijken('loc_utr')
check('de controle vindt het dubbele nummer', nagekeken.dubbel.length === 1)
check('en noemt beide namen', (nagekeken.dubbel[0]?.namen ?? []).length === 2)

await db.users.delete(tweeling.id)
check('na het opruimen werkt het nummer weer', (await herkenOpNummer('TW-014')).ok)

/* ---- wie geen nummer heeft ---- */

const zonder: User = {
  id: 'u_zonder', email: 'zonder@truckwash1group.nl', password: '',
  name: 'Nog Geen Nummer', roles: ['employee'], active: true,
  locationId: 'loc_utr', updatedAt: Date.now(),
}
await db.users.put(zonder)
const controle = await nummersNakijken('loc_utr')
check('de controle ziet wie geen nummer heeft',
  controle.zonderNummer.some((u) => u.id === zonder.id))
await db.users.delete(zonder.id)

/* ---- iemand die uit dienst is ---- */

await db.users.put({ ...wasser, active: false })
const uitDienst = await herkenOpNummer('TW-014')
check('wie uit dienst is komt er niet meer in',
  !uitDienst.ok && uitDienst.reden === 'inactief')
await db.users.put({ ...wasser, active: true })

/* ---- de rem op gokken ----
 *
 * Een nummer van drie cijfers is te raden door het simpelweg te proberen.
 * Vijf pogingen en dan een minuut wachten maakt dat onbegonnen werk.
 */

for (let i = 0; i < 5; i++) await herkenOpNummer('888' + i)
const geblokkeerd = await herkenOpNummer('TW-014')
check('na vijf misgetoetste nummers zit hij even op slot',
  !geblokkeerd.ok && geblokkeerd.reden === 'geblokkeerd')

// Een geslaagde poging zet de teller terug; hier doen we dat met de badge,
// want die loopt niet langs de rem van de nummers.
const badge = await badgeMaken(wasser.id)
check('een badge begint met TWB-', badge.startsWith('TWB-'))
check('met de badge kom je binnen', (await herkenBadge(badge)).ok)
check('met een verzonnen badge niet', !(await herkenBadge('TWB-ONZIN')).ok)
check('en de rem staat daarna weer los', (await herkenOpNummer('TW-014')).ok)

check('een badge heeft geen code nodig',
  Boolean((await db.pins.where('userId').equals(wasser.id).first())?.badgeToken))

/* ================================================================== *
 *  4. Klokken
 * ================================================================== */

console.log('\n4. Klokken')

const eerste = await klok.inklokken(wasser, 'loc_utr')
check('inklokken maakt een dienst', !eerste.alOpen && Boolean(eerste.entry.id))

const tweede = await klok.inklokken(wasser, 'loc_utr')
check('twee keer inklokken geeft geen tweede dienst',
  tweede.alOpen && tweede.entry.id === eerste.entry.id)

check('hij staat op de lijst van aanwezigen',
  (await klok.aanwezig('loc_utr')).some((a) => a.user.id === wasser.id))

const uit = await klok.uitklokken(wasser.id)
check('uitklokken zet een eindtijd', Boolean(uit?.end))
check('daarna is er niemand meer ingeklokt',
  (await klok.aanwezig('loc_utr')).length === 0)

check('de dienst staat in de tabel van het dashboard',
  (await db.timeEntries.count()) === 1)
check('en in de wachtrij naar de server',
  (await db.outbox.where('entity').equals('timeEntries').count()) === 1)

// Een dienst die twintig uur openstaat is een vergeten uitklok.
const vergetenId = uid('uur')
await db.timeEntries.put({
  id: vergetenId, userId: wasser.id, userName: wasser.name,
  locationId: 'loc_utr', start: Date.now() - 20 * 3_600_000, updatedAt: Date.now(),
})
const nu = await klok.aanwezig('loc_utr')
check('een dienst van twintig uur valt op als vergeten',
  nu.length === 1 && nu[0].vergeten)
check('en telt niet mee in het dagtotaal',
  (await klok.vandaagGewerkt(wasser.id)) < 2 * 3_600_000)

await klok.dienstCorrigeren({
  entryId: vergetenId,
  end: Date.now() - 12 * 3_600_000,
  note: 'ploeg eindigde om 17:00',
  doorNaam: baas.name,
})
const rechtgezet = await db.timeEntries.get(vergetenId)
check('rechtzetten sluit de dienst', Boolean(rechtgezet?.end))
check('en legt vast wie het deed',
  (rechtgezet?.note ?? '').includes('Casper'))

/* ================================================================== *
 *  5. Afrekenen
 * ================================================================== */

console.log('\n5. Afrekenen')

const bon1 = await kassa.afrekenen({
  register,
  door: wasser,
  regels: [
    {
      id: 'm1', productId: buitenwas.id, name: 'Buitenwas', kind: 'wasbeurt',
      qty: 1, priceIncl: 78.65, vatPct: 21, discountPct: 0,
      washService: 'buitenwas',
    },
    {
      id: 'm2', productId: koffie.id, name: 'Koffie', kind: 'artikel',
      qty: 2, priceIncl: 2.5, vatPct: 9, discountPct: 0,
      inventoryItemId: 'inv_koffie',
    },
  ],
  betalingen: [{ method: 'contant', amount: 83.65, received: 100, changeGiven: 16.35 }],
  klant: { companyId: 'co_jansen', name: 'Transport Jansen B.V.' },
  plate: 'AA-11-BB',
  afronding: 0,
})

check('de bon heeft een nummer met de kassacode erin',
  bon1.bon.receiptNo.startsWith('KAS-UTR-1-'), bon1.bon.receiptNo)
check('het volgnummer begint bij 1', bon1.bon.seq === 1)
check('de bon is afgerekend', bon1.bon.status === 'afgerekend')
check('het totaal klopt', bon1.bon.totalIncl === 83.65, String(bon1.bon.totalIncl))
check('exclusief plus btw is het totaal',
  geld.centen(bon1.bon.totalExcl + bon1.bon.vatTotal) === bon1.bon.totalIncl)
check('er staan twee regels op', bon1.regels.length === 2)
check('de betaalwijze is contant', bon1.bon.method === 'contant')

check('de wasbeurt staat in de wachtrij van de wasstraat',
  bon1.wasopdrachten.length === 1 && bon1.wasopdrachten[0].status === 'wachtrij')
check('met het kenteken erop', bon1.wasopdrachten[0].plate === 'AA-11-BB')
check('en op naam van de klant', bon1.wasopdrachten[0].companyId === 'co_jansen')
check('de prijs op de wasopdracht is exclusief btw',
  bijna(bon1.wasopdrachten[0].priceExcl, 65), String(bon1.wasopdrachten[0].priceExcl))

const koffieNa = await db.inventory.get('inv_koffie')
check('de voorraad is met twee afgeboekt', koffieNa?.stock === 18, String(koffieNa?.stock))
check('er staat een voorraadmutatie', (await db.stockMovements.count()) === 1)

/* ---- de wachtrij ---- */

const wachtrij = await db.outbox.toArray()
const rang = new Map(PUSH_ORDER.map((e, i) => [e, i]))
const gesorteerd = [...wachtrij].sort(
  (a, b) => (rang.get(a.entity) ?? 99) - (rang.get(b.entity) ?? 99))

const plek = (entiteit: string) => gesorteerd.findIndex((r) => r.entity === entiteit)

check('alles staat in de wachtrij, want er is geen verbinding', wachtrij.length > 0)
check('de bon gaat vóór zijn regels', plek('sales') < plek('saleLines'))
check('de bon gaat vóór zijn betalingen', plek('sales') < plek('payments'))
check('de wasopdracht gaat vóór de bon die ernaar verwijst',
  plek('washJobs') < plek('sales'))

/* ---- tweede bon: het nummer loopt door ---- */

const bon2 = await kassa.afrekenen({
  register,
  door: wasser,
  regels: [{
    id: 'm3', productId: koffie.id, name: 'Koffie', kind: 'artikel',
    qty: 1, priceIncl: 2.5, vatPct: 9, discountPct: 0,
  }],
  betalingen: [{ method: 'pin', amount: 2.5, terminalRef: '004512' }],
})
check('het bonnummer loopt door', bon2.bon.seq === 2)
check('twee bonnen hebben nooit hetzelfde nummer',
  bon1.bon.receiptNo !== bon2.bon.receiptNo)

/* ---- een strippenkaart verkopen en gebruiken ---- */

const bon3 = await kassa.afrekenen({
  register,
  door: wasser,
  regels: [{
    id: 'm4', productId: kaart10.id, name: '10-badenkaart', kind: 'strippenkaart',
    qty: 1, priceIncl: 700, vatPct: 21, discountPct: 0, credits: 10,
  }],
  betalingen: [{ method: 'op-rekening', amount: 700 }],
  klant: { companyId: 'co_jansen', name: 'Transport Jansen B.V.' },
})

check('er is een kaart aangemaakt', bon3.kaarten.length === 1)
check('met tien beurten erop', bon3.kaarten[0].credits === 10)

const kaart = (await db.subscriptions.toArray())[0]
check('het saldo is tien', (await kaarten.saldo(kaart.id)) === 10)

const metKaart = await kassa.afrekenen({
  register,
  door: wasser,
  regels: [{
    id: 'm5', productId: buitenwas.id, name: 'Buitenwas', kind: 'wasbeurt',
    qty: 1, priceIncl: 78.65, vatPct: 21,
    // Honderd procent korting: de wasbeurt is al betaald toen de kaart
    // werd verkocht.
    discountPct: 100,
    washService: 'buitenwas',
  }],
  betalingen: [{ method: 'abonnement', amount: 0, subscriptionId: kaart.id }],
  klant: { companyId: 'co_jansen', name: 'Transport Jansen B.V.' },
  plate: 'AA-11-BB',
})

check('een wasbeurt van de kaart kost niets', metKaart.bon.totalIncl === 0)
check('de betaalwijze is de kaart', metKaart.bon.method === 'abonnement')
check('er is één beurt van de kaart af', (await kaarten.saldo(kaart.id)) === 9,
  String(await kaarten.saldo(kaart.id)))

// Dezelfde afboeking twee keer versturen mag geen tweede strip kosten.
await kaarten.afboeken({
  subscriptionId: kaart.id, saleId: metKaart.bon.id, credits: 1, door: wasser,
})
check('dezelfde afboeking nog eens kost geen tweede beurt',
  (await kaarten.saldo(kaart.id)) === 9, String(await kaarten.saldo(kaart.id)))

const beoordeeld = await kaarten.beoordeel(kaart)
check('de kaart is nog geldig', beoordeeld.geldig && beoordeeld.saldo === 9)

/* ================================================================== *
 *  6. Crediteren
 * ================================================================== */

console.log('\n6. Crediteren')

const credit = await kassa.crediteren({
  saleId: bon1.bon.id,
  register,
  door: baas,
  reden: 'verkeerd aangeslagen',
})

check('de creditbon verwijst naar de oorspronkelijke',
  credit.bon.creditOf === bon1.bon.id)
check('het bedrag is negatief', credit.bon.totalIncl === -83.65,
  String(credit.bon.totalIncl))
check('de regels zijn negatief',
  credit.regels.every((r) => r.totalIncl <= 0 && r.qty <= 0))

const origineel = await db.sales.get(bon1.bon.id)
check('de oorspronkelijke bon blijft bestaan', Boolean(origineel))
check('en staat op gecrediteerd', origineel?.status === 'gecrediteerd')

const koffieTerug = await db.inventory.get('inv_koffie')
check('de voorraad staat weer op twintig', koffieTerug?.stock === 20,
  String(koffieTerug?.stock))

let tweedeKeer = ''
try {
  await kassa.crediteren({
    saleId: bon1.bon.id, register, door: baas, reden: 'nog een keer',
  })
} catch (e) {
  tweedeKeer = e instanceof Error ? e.message : String(e)
}
check('een bon kan niet twee keer gecrediteerd worden',
  tweedeKeer.includes('al gecrediteerd'), tweedeKeer)

/* ================================================================== *
 *  7. Parkeren
 * ================================================================== */

console.log('\n7. Parkeren')

const geparkeerd = await kassa.parkeren({
  register,
  door: wasser,
  regels: [{
    id: 'm6', productId: koffie.id, name: 'Koffie', kind: 'artikel',
    qty: 3, priceIncl: 2.5, vatPct: 9, discountPct: 0,
  }],
  plate: 'CC-33-DD',
})

check('een geparkeerde bon krijgt nog geen nummer', geparkeerd.receiptNo === '')
check('en staat op geparkeerd', geparkeerd.status === 'geparkeerd')
check('hij staat in de lijst',
  (await kassa.geparkeerdeBonnen(register.id)).length === 1)

const hervat = await kassa.hervatten(geparkeerd.id)
check('hervatten geeft de regels terug', hervat?.regels.length === 1)
check('met het juiste aantal', hervat?.regels[0].qty === 3)
check('en het kenteken', hervat?.bon.plate === 'CC-33-DD')

await kassa.parkeerbonWeggooien(geparkeerd.id, 'niemand kwam terug')
check('een geparkeerde bon kan weg', (await db.sales.get(geparkeerd.id)) === undefined)

/* ================================================================== *
 *  8. De kassadag
 * ================================================================== */

console.log('\n8. De kassadag')

const { sessie } = await kas.kasOpenen({ register, door: baas, startbedrag: 150 })
check('de kas staat open', sessie.status === 'open' && sessie.startFloat === 150)

const nogEens = await kas.kasOpenen({ register, door: baas, startbedrag: 999 })
check('twee keer openen geeft dezelfde kas',
  nogEens.alOpen && nogEens.sessie.id === sessie.id)

// Een contante bon in deze kassadag.
const dagbon = await kassa.afrekenen({
  register,
  door: wasser,
  regels: [{
    id: 'm7', productId: koffie.id, name: 'Koffie', kind: 'artikel',
    qty: 1, priceIncl: 2.5, vatPct: 9, discountPct: 0,
  }],
  betalingen: [{ method: 'contant', amount: 2.5, received: 5, changeGiven: 2.5 }],
  cashSessionId: sessie.id,
})

await kas.kasMutatie({
  sessionId: sessie.id, kind: 'afstorting', bedrag: 50,
  reden: 'naar de kluis', door: baas,
})

const stand = await kas.kasStand(sessie.id)
check('de contante omzet staat erin', stand?.contant === 2.5, String(stand?.contant))
check('de afstorting gaat eraf', stand?.afstorting === -50, String(stand?.afstorting))
check('wat er in de lade hoort te liggen',
  stand?.verwachtContant === 102.5, String(stand?.verwachtContant))
check('en één bon', stand?.aantalBonnen === 1, String(stand?.aantalBonnen))

const { verschil } = await kas.kasSluiten({
  sessionId: sessie.id, door: baas, geteld: 102.5,
})
check('een goede telling geeft geen verschil', verschil === 0, String(verschil))

const gesloten = await db.cashSessions.get(sessie.id)
check('de kas staat dicht', gesloten?.status === 'gesloten')
check('het verwachte bedrag is vastgelegd', gesloten?.expected === 102.5)

let alDicht = ''
try {
  await kas.kasSluiten({ sessionId: sessie.id, door: baas, geteld: 1 })
} catch (e) {
  alDicht = e instanceof Error ? e.message : String(e)
}
check('een gesloten kas kan niet opnieuw dicht', alDicht.includes('al afgesloten'), alDicht)

/* ================================================================== *
 *  9. Muziek: het uitlezen van wat een speaker terugstuurt
 *
 *  Zonder speaker is het netwerkdeel niet te testen. Wat wél te testen is, is
 *  precies het deel dat stil fout gaat: het uitlezen van de XML die een
 *  apparaat terugstuurt. Zit daar een fout in, dan staat er "onbekend" op het
 *  scherm terwijl het apparaat het netjes vertelde.
 * ================================================================== */

console.log('\n9. Muziek: uitlezen wat een speaker terugstuurt')

const muziek = (await import('../electron/muziek.cjs')).default as any
const { kopregels, tag, parseerApparaat, parseerNummer, envelop } =
  (muziek._intern ?? muziek) as any

/* ---- SSDP-antwoord ---- */

const ssdp = [
  'HTTP/1.1 200 OK',
  'CACHE-CONTROL: max-age = 1800',
  'LOCATION: http://192.168.1.42:1400/xml/device_description.xml',
  'SERVER: Linux UPnP/1.0 Sonos/70.1-12345',
  'ST: urn:schemas-upnp-org:device:ZonePlayer:1',
  '', '',
].join('\r\n')

const kop = kopregels(ssdp)
check('het adres uit een SSDP-antwoord',
  kop.location === 'http://192.168.1.42:1400/xml/device_description.xml', kop.location)
check('de kopregel is niet gevoelig voor hoofdletters',
  Boolean(kop.server && kop.st))

/* ---- de beschrijving van een Sonos ---- */

const sonosXml = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType>
    <friendlyName>192.168.1.42 - Sonos One SL</friendlyName>
    <manufacturer>Sonos, Inc.</manufacturer>
    <modelName>Sonos One SL</modelName>
    <roomName>Balie</roomName>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <controlURL>/MediaRenderer/AVTransport/Control</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <controlURL>/MediaRenderer/RenderingControl/Control</controlURL>
      </service>
    </serviceList>
  </device>
</root>`

const sonos = parseerApparaat(sonosXml, 'http://192.168.1.42:1400/xml/device_description.xml')
check('een Sonos wordt herkend', Boolean(sonos))
// De ruimte, niet het model: "Balie" is aan een balie duidelijker dan
// "Sonos One SL".
check('de naam is de ruimte', sonos.naam === 'Balie', sonos?.naam)
check('het merk staat erbij', sonos.merk.includes('Sonos'), sonos?.merk)
check('het adres voor pauze is volledig gemaakt',
  sonos.transportUrl === 'http://192.168.1.42:1400/MediaRenderer/AVTransport/Control',
  sonos?.transportUrl)
check('en het adres voor volume ook',
  sonos.volumeUrl === 'http://192.168.1.42:1400/MediaRenderer/RenderingControl/Control',
  sonos?.volumeUrl)

/* ---- een apparaat waar we niets mee kunnen ---- */

const routerXml = `<?xml version="1.0"?>
<root><device>
  <friendlyName>Internetmodem</friendlyName>
  <serviceList>
    <service>
      <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
      <controlURL>/upnp/control/wan</controlURL>
    </service>
  </serviceList>
</device></root>`

check('een modem zonder AVTransport valt af',
  parseerApparaat(routerXml, 'http://192.168.1.1:5000/desc.xml') === null)

/* ---- een speaker zonder volumebesturing ---- */

const geenVolume = parseerApparaat(
  sonosXml.replace(/<service>\s*<serviceType>urn:schemas-upnp-org:service:RenderingControl:1[\s\S]*?<\/service>/, ''),
  'http://192.168.1.55:8080/desc.xml')
check('een apparaat zonder volume wordt toch herkend', Boolean(geenVolume))
check('en meldt dat het volume niet kan', geenVolume.volumeUrl === '')

/* ---- wat er speelt ----
 *
 * De metadata is XML binnen XML: het apparaat stuurt een veld waarin de
 * tekens zijn ontdubbeld. Wie die stap vergeet, leest niets uit en zet
 * "onbekend" op het scherm.
 */

const positieXml = `<?xml version="1.0"?>
<s:Envelope><s:Body><u:GetPositionInfoResponse>
  <Track>3</Track>
  <TrackDuration>0:03:42</TrackDuration>
  <TrackMetaData>&lt;DIDL-Lite&gt;&lt;item&gt;&lt;dc:title&gt;Rondje Rotterdam&lt;/dc:title&gt;&lt;dc:creator&gt;De Vrachtwagens&lt;/dc:creator&gt;&lt;upnp:album&gt;Onderweg&lt;/upnp:album&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;</TrackMetaData>
  <RelTime>0:01:12</RelTime>
</u:GetPositionInfoResponse></s:Body></s:Envelope>`

const speelt = parseerNummer(positieXml)
check('de titel komt eruit', speelt.titel === 'Rondje Rotterdam', speelt.titel)
check('de artiest ook', speelt.artiest === 'De Vrachtwagens', speelt.artiest)
check('het album ook', speelt.album === 'Onderweg', speelt.album)
check('en hoe lang het nog duurt',
  speelt.duur === '0:03:42' && speelt.positie === '0:01:12',
  `${speelt.duur} / ${speelt.positie}`)

const leeg = parseerNummer('<x><TrackDuration>NOT_IMPLEMENTED</TrackDuration></x>')
check('een apparaat dat niets vertelt geeft leeg terug, geen onzin',
  leeg.titel === '' && leeg.duur === '')

/* ---- de envelop die we versturen ---- */

const env = envelop(
  'urn:schemas-upnp-org:service:RenderingControl:1', 'SetVolume',
  { InstanceID: 0, Channel: 'Master', DesiredVolume: 25 })
check('de envelop noemt de handeling', env.includes('<u:SetVolume'))
check('en het bedrag', env.includes('<DesiredVolume>25</DesiredVolume>'))
check('en sluit hem netjes af', env.includes('</u:SetVolume>'))

/* ================================================================== *
 *  10. De bon
 * ================================================================== */

console.log('\n10. De bon')

const gegevens = await bonGegevens(bon1.bon.id)
check('de bongegevens komen uit de cache', Boolean(gegevens))

const opdrachten = bonOpmaken(gegevens!)
const tekst = alsTekst(opdrachten, 42)
const regels = tekst.split('\n')

check('de bon past op de rol', regels.every((r) => r.length <= 42),
  regels.find((r) => r.length > 42))
check('het bonnummer staat erop', tekst.includes(bon1.bon.receiptNo))
check('de vestiging staat erop', tekst.includes('Utrecht'))
check('de medewerker staat erop', tekst.includes('Ali Yildiz'))
check('het kenteken staat erop', tekst.includes('AA-11-BB'))
check('de btw-specificatie staat erop', tekst.includes('BTW-specificatie'))
check('beide tarieven staan erop', tekst.includes('21%') && tekst.includes('9%'))
check('het totaal staat erop', tekst.includes('83,65'))
check('het wisselgeld staat erop', tekst.includes('16,35'))

const creditGegevens = await bonGegevens(credit.bon.id)
check('een creditbon heet CREDITBON',
  alsTekst(bonOpmaken(creditGegevens!), 42).includes('CREDITBON'))

const kaartGegevens = await bonGegevens(bon3.bon.id)
check('de kaartcode staat op de bon waarop hij verkocht is',
  alsTekst(bonOpmaken(kaartGegevens!), 42).includes(kaart.code))

/* ================================================================== */

await db.close()

console.log(`\n${passed} geslaagd, ${failed} mislukt\n`)
process.exit(failed === 0 ? 0 : 1)
