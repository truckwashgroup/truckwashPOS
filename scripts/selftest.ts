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
const { PUSH_ORDER, pushPerStuk, useSync } = await import('../src/lib/sync')
const wachtrijLib = await import('../src/lib/wachtrij')
const foutsoorten = await import('../src/lib/api/supabaseApi')
const { api: deApi } = await import('../src/lib/api')
const munten = await import('../src/lib/munten')
const kluis = await import('../src/lib/kluis')
const koppelen = await import('../src/lib/koppelen')
const beeld = await import('../src/lib/afbeelding')
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
 *  10. De speler: volgorde en welke bestanden meedoen
 *
 *  De kassa als bron. Zonder muziekmap is het afspelen niet te testen; de
 *  volgorde wél, en dat is precies het rekenwerk dat één keer per honderd
 *  nummers fout gaat en dan een uur zoeken kost.
 * ================================================================== */

console.log('\n10. De speler')

const { volgendeIndex, vorigeIndex } = await import('../src/store/useSpeler')

/* ---- op volgorde ---- */

check('van 0 naar 1', volgendeIndex(0, 5, false) === 1)
check('en van de laatste terug naar de eerste', volgendeIndex(4, 5, false) === 0)
check('vorige van 0 is de laatste', vorigeIndex(0, 5) === 4)
check('vorige van 3 is 2', vorigeIndex(3, 5) === 2)

/* ---- één nummer, of geen ---- */

check('met één nummer blijf je erop staan', volgendeIndex(0, 1, false) === 0)
check('en met shuffle ook', volgendeIndex(0, 1, true) === 0)
check('een lege lijst geeft geen onzin',
  volgendeIndex(0, 0, false) === 0 && vorigeIndex(0, 0) === 0)

/* ---- shuffle ----
 *
 * Nooit twee keer hetzelfde nummer achter elkaar. Dat is geen willekeur maar
 * een keuze: hetzelfde nummer opnieuw voelt als een kapotte speler, niet als
 * toeval.
 */

// Toeval nabootsen zodat het altijd hetzelfde nummer wil kiezen.
const altijdDrie = () => 3 / 10
check('shuffle kiest niet het nummer dat al speelt',
  volgendeIndex(3, 10, true, altijdDrie) !== 3,
  String(volgendeIndex(3, 10, true, altijdDrie)))

let zelfde = 0
for (let i = 0; i < 400; i++) {
  if (volgendeIndex(i % 8, 8, true) === i % 8) zelfde++
}
check('en dat geldt over vierhonderd keer', zelfde === 0, String(zelfde))

let binnenBereik = true
for (let i = 0; i < 400; i++) {
  const n = volgendeIndex(i % 8, 8, true)
  if (n < 0 || n > 7) binnenBereik = false
}
check('shuffle blijft binnen de lijst', binnenBereik)

/* ---- welke bestanden meedoen ----
 *
 * Alleen wat Chromium ook echt kan weergeven. Een ruimere lijst levert
 * bestanden op die stil overgeslagen worden, en dan denkt iemand dat de speler
 * stuk is.
 */

const spelerModule = (await import('../electron/speler.cjs')).default as any
const { GELUID, BEELD } = (spelerModule._intern ?? spelerModule) as any

check('mp3 doet mee', GELUID.includes('.mp3'))
check('flac en opus ook', GELUID.includes('.flac') && GELUID.includes('.opus'))
check('mp4 en webm doen mee als beeld', BEELD.includes('.mp4') && BEELD.includes('.webm'))
check('wma doet niet mee (Chromium kan het niet)', !GELUID.includes('.wma'))
check('mkv doet niet mee (soms wel, soms niet, en dat is erger)',
  !BEELD.includes('.mkv'))
check('geluid en beeld overlappen niet',
  GELUID.every((e: string) => !BEELD.includes(e)))

/* ---- alleen uit de gekozen map ----
 *
 * Zonder deze grens zou het scherm elk bestand op de schijf kunnen opvragen
 * via het speler://-adres. Dat is precies het soort gat dat je niet wil op een
 * apparaat waar ook een kassa-administratie op staat.
 */

const { magGelezenWorden, toegestaneMappen } = (spelerModule._intern ?? spelerModule) as any

/*
 * De paden bouwen we met node:path en niet met de hand.
 *
 * Eerst stonden hier Windows-paden ("C:\muziek\nummer.mp3"). Dat werkte hier
 * en niet op de bouwmachine: daar is Linux, en dan is een backslash geen
 * mappenscheiding maar een gewoon teken in een bestandsnaam -- dus viel de
 * vergelijking om terwijl de code goed was. De speler draait alleen op
 * Windows, maar de test draait overal.
 */
const nodePath = await import('node:path')

const muziekWortel = nodePath.resolve('proef-muziekmap')
const elders = nodePath.resolve('proef-ergens-anders')

check('zonder gekozen map mag niets',
  !magGelezenWorden(nodePath.join(muziekWortel, 'nummer.mp3')))

toegestaneMappen.add(muziekWortel)

check('uit de gekozen map mag het',
  magGelezenWorden(nodePath.join(muziekWortel, 'nummer.mp3')))
check('de map zelf mag ook', magGelezenWorden(muziekWortel))
check('uit een onderliggende map ook',
  magGelezenWorden(nodePath.join(muziekWortel, 'artiest', 'nummer.mp3')))
check('van elders niet',
  !magGelezenWorden(nodePath.join(elders, 'geheim.txt')))
check('en met een omweg naar boven ook niet',
  !magGelezenWorden(nodePath.join(muziekWortel, '..', 'proef-ergens-anders', 'geheim.txt')))
check('een map die er net op lijkt is niet dezelfde',
  !magGelezenWorden(muziekWortel + '-anders' + nodePath.sep + 'nummer.mp3'))

/* ================================================================== *
 *  11. De bon
 * ================================================================== */

console.log('\n11. De bon')

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

/* ================================================================== *
 *  12. Briefjes en munten
 *
 *  Het rekenwerk onder de kluis. Dit is de plek waar een fout geld kost
 *  zonder dat iemand het merkt: als muntenBedrag() er een cent naast zit,
 *  klopt elke telling een beetje niet en gaat iemand zoeken in de verkeerde
 *  hoek.
 * ================================================================== */

console.log('\n12. Briefjes en munten')

check('drie briefjes van honderd en twee van twintig is 340',
  munten.muntenBedrag({ b100: 3, b20: 2 }) === 340)

check('een briefje van vijf is niet een munt van vijf cent',
  munten.muntWaarde('b5') === 5 && munten.muntWaarde('m5') === 0.05)

/*
 * De reden dat elke tussenstap op centen afrondt. Drie keer tien cent is in
 * JavaScript 0.30000000000000004; twintig keer vijf cent net zo. Eén cent
 * verschil per telling is genoeg om een kluis nooit meer te laten kloppen.
 */
check('kleingeld telt op zonder rekenrestjes',
  munten.muntenBedrag({ m10: 3 }) === 0.3 &&
  munten.muntenBedrag({ m5: 20 }) === 1 &&
  munten.muntenBedrag({ m1: 7, m2: 4 }) === 0.15)

check('een onbekende coupure is nul en geen fout',
  munten.muntWaarde('b7') === 7 && munten.muntWaarde('rommel') === 0)

check('optellen laat geen nullen achter',
  JSON.stringify(munten.muntenOptellen({ b50: 1 }, { b50: 1 }, -1)) === '{}')

check('aftrekken kan met dezelfde functie',
  munten.muntenOptellen({ b50: 3, m200: 5 }, { b50: 1 }, -1).b50 === 2)

const past = munten.muntenPassen({ b50: 3, m200: 10 }, { b50: 2 })
check('twee van de drie briefjes halen mag', past.ok)

const pastNiet = munten.muntenPassen({ b50: 3 }, { b50: 4 })
check('vier van de drie kan niet', !pastNiet.ok && pastNiet.tekort.b50 === 1)

/*
 * Er wordt niet gewisseld, en dat is met opzet. Vijf briefjes van tien is
 * hetzelfde bedrag als één van vijftig, maar niet hetzelfde als wat je in je
 * hand hebt -- en het gaat hier om wat je in je hand hebt.
 */
const geenWissel = munten.muntenPassen({ b10: 5 }, { b50: 1 })
check('hetzelfde bedrag in ander kleingeld telt niet als wisselen',
  !geenWissel.ok && geenWissel.tekort.b50 === 1)

check('opschonen gooit nullen en negatieven weg',
  JSON.stringify(munten.muntenOpschonen({ b50: 2, b20: 0, m200: -3 })) === '{"b50":2}')

check('opschonen laat halve briefjes niet staan',
  munten.muntenOpschonen({ b50: 2.7 }).b50 === 2)

check('de tekst leest als een opsomming',
  munten.muntenTekst({ b100: 3, b20: 2 }) === '3x € 100, 2x € 20')

check('en zegt "niets" als er niets is', munten.muntenTekst({}) === 'niets')

/* ================================================================== *
 *  13. De kluis
 *
 *  Twee dingen die bewezen moeten worden, want ze zijn de kern:
 *
 *  1. Het saldo volgt uit de bewegingen, en een telling is het ijkpunt.
 *  2. Er kan niet meer uit dan erin zit.
 *
 *  En één die er praktisch bij hoort: de kluis en de kassalade blijven bij
 *  elkaar. Een afstorting die in de kluis staat maar niet van de lade af is,
 *  is geld dat lijkt te bestaan op twee plekken.
 * ================================================================== */

console.log('\n13. De kluis')

const deKluis = {
  id: 'kluis_test',
  locationId: register.locationId,
  name: 'Kluis Utrecht',
  active: true,
  updatedAt: Date.now(),
}
await db.safes.put(deKluis)

check('de kluis van deze vestiging wordt gevonden',
  (await kluis.kluisVanLocatie(register.locationId))?.id === deKluis.id)

const kluisLeeg = await kluis.kluisStand(deKluis.id)
check('een lege kluis staat op nul', kluisLeeg?.bedrag === 0)
check('en heeft nooit geteld', !kluisLeeg?.laatsteTelling)

await kluis.kluisBoeken({
  kluis: deKluis, soort: 'van-bank',
  munten: { b100: 3, b20: 2, m200: 10 }, door: baas,
})

const na1 = await kluis.kluisStand(deKluis.id)
check('wat erin gaat komt erbij', na1?.bedrag === 360, String(na1?.bedrag))
check('en staat per coupure in de kluis',
  na1?.munten.b100 === 3 && na1?.munten.m200 === 10)

/* ---- er kan niet meer uit dan erin zit ---- */

let teveel = ''
try {
  await kluis.kluisBoeken({
    kluis: deKluis, soort: 'naar-bank', munten: { b100: 4 }, door: baas,
  })
} catch (e) {
  teveel = e instanceof Error ? e.message : String(e)
}
check('meer eruit halen dan erin zit wordt geweigerd',
  teveel.includes('ligt er niet in'), teveel)
check('en de melding zegt wat er precies mist', teveel.includes('1x € 100'), teveel)

check('de kluis is er niet door veranderd',
  (await kluis.kluisStand(deKluis.id))?.bedrag === 360)

/*
 * Bedrag klopt maar het kleingeld niet: dit is de fout die een gewone
 * saldocontrole erdoor laat. Er ligt 360 in de kluis, dus 200 eruit "kan" --
 * alleen niet in twee briefjes van honderd, want er zijn er drie en die zijn
 * al niet het probleem. Vraag om vier briefjes van vijftig en het bedrag past
 * ruim, maar de briefjes liggen er niet.
 */
let verkeerdKleingeld = ''
try {
  await kluis.kluisBoeken({
    kluis: deKluis, soort: 'naar-bank', munten: { b50: 4 }, door: baas,
  })
} catch (e) {
  verkeerdKleingeld = e instanceof Error ? e.message : String(e)
}
check('het bedrag past maar de briefjes liggen er niet',
  verkeerdKleingeld.includes('ligt er niet in'), verkeerdKleingeld)

/* ---- de lade en de kluis blijven bij elkaar ---- */

const { sessie: kluisSessie } = await kas.kasOpenen({
  register, door: baas, startbedrag: 200,
})

const afgestort = await kluis.afstortenNaarKluis({
  kluis: deKluis, register, munten: { b50: 2 }, door: baas,
})
check('afstorten telt op in de kluis', afgestort.bedrag === 100)

const kluisNaAfstorten = await kluis.kluisStand(deKluis.id)
check('en de kluis staat op 460', kluisNaAfstorten?.bedrag === 460,
  String(kluisNaAfstorten?.bedrag))

const ladeNaAfstorten = await kas.kasStand(kluisSessie.id)
check('en het is ook echt van de lade af',
  ladeNaAfstorten?.verwachtContant === 100, String(ladeNaAfstorten?.verwachtContant))

const gehaald = await kluis.wisselgeldUitKluis({
  kluis: deKluis, register, munten: { m200: 10 }, door: baas,
})
check('wisselgeld halen gaat de andere kant op', gehaald.bedrag === 20)

const kluisNaHalen = await kluis.kluisStand(deKluis.id)
const ladeNaHalen = await kas.kasStand(kluisSessie.id)
check('uit de kluis', kluisNaHalen?.bedrag === 440, String(kluisNaHalen?.bedrag))
check('en in de lade', ladeNaHalen?.verwachtContant === 120,
  String(ladeNaHalen?.verwachtContant))

/*
 * En de rem blijft ook staan bij een handeling die twee boeken raakt. Zonder
 * dit zou er wisselgeld in de lade kunnen komen dat nooit uit de kluis kwam.
 */
const ladeVoorMislukt = (await kas.kasStand(kluisSessie.id))?.verwachtContant
let wisselTeveel = ''
try {
  await kluis.wisselgeldUitKluis({
    kluis: deKluis, register, munten: { b500: 1 }, door: baas,
  })
} catch (e) {
  wisselTeveel = e instanceof Error ? e.message : String(e)
}
check('wisselgeld halen dat er niet is, gaat niet',
  wisselTeveel.includes('ligt er niet in'), wisselTeveel)
check('en dan komt er ook niets in de lade',
  (await kas.kasStand(kluisSessie.id))?.verwachtContant === ladeVoorMislukt)

/* ---- de telling is het ijkpunt ---- */

const geteldMinder = await kluis.kluisTellen({
  kluis: deKluis, geteld: { b100: 3, b50: 1, b20: 4 }, door: baas,
})
check('het verwachte bedrag wordt vastgelegd', geteldMinder.verwacht === 440,
  String(geteldMinder.verwacht))
check('en het verschil ook', geteldMinder.verschil === -10,
  String(geteldMinder.verschil))

const naTelling = await kluis.kluisStand(deKluis.id)
check('na de telling is het saldo wat er geteld is', naTelling?.bedrag === 430,
  String(naTelling?.bedrag))
check('en dat is nu het ijkpunt', naTelling?.sindsTelling === 0)

/*
 * Het verschil wordt niet weggerekend. Zou de app dat doen, dan is een kluis
 * die elke maand tien euro mist niet te onderscheiden van een kluis die
 * klopt -- en dat is precies wat je wilt zien.
 */
check('het verschil blijft in de boeking staan',
  (await db.safeMoves.get(geteldMinder.boeking.id))?.difference === -10)

await kluis.kluisBoeken({
  kluis: deKluis, soort: 'uitgave', munten: { b20: 1 }, reden: 'ruitenwissers',
  door: baas,
})
const naUitgave = await kluis.kluisStand(deKluis.id)
check('wat na de telling komt telt weer mee', naUitgave?.bedrag === 410,
  String(naUitgave?.bedrag))
check('en de boeking staat in de historie met zijn briefjes',
  naUitgave?.boekingen[0].coins.b20 === 1)

/*
 * Tellen en in dezelfde milliseconde boeken.
 *
 * Dit is de fout waar de zelftest hierboven per ongeluk op stuitte: hij is snel
 * genoeg om binnen één milliseconde te tellen en te boeken, en toen viel die
 * boeking uit het saldo. Met de hand duurt dat langer -- maar twee kassa's die
 * offline tegelijk boeken hebben precies hetzelfde probleem, en dan gaat het
 * over geld. Vandaar dat het nu expliciet vastligt.
 */
/*
 * Ná alles wat er al staat. Date.now() is hier niet goed genoeg: de kluis
 * gebruikt tijdstempel(), en die loopt bij drukte een paar milliseconden voor
 * op de klok. Dan zou deze telling tussen de eerdere boekingen belanden en
 * meet de controle iets anders dan waar hij over gaat.
 */
const zelfdeMs = Math.max(
  ...(await db.safeMoves.toArray()).map((m) => m.at)) + 5
await db.safeMoves.bulkPut([
  {
    id: 'kl_gelijk_telling', safeId: deKluis.id, locationId: deKluis.locationId,
    soort: 'telling', coins: {}, counted: { b50: 2 }, amount: 0,
    expected: 0, difference: 0, reason: 'telling', userName: 'Test',
    at: zelfdeMs, updatedAt: zelfdeMs,
  },
  {
    id: 'kl_gelijk_uitgave', safeId: deKluis.id, locationId: deKluis.locationId,
    soort: 'uitgave', coins: { b50: 1 }, amount: -50, reason: 'in dezelfde ms',
    userName: 'Test', at: zelfdeMs, updatedAt: zelfdeMs,
  },
] as any)

const gelijk = await kluis.kluisStand(deKluis.id)
check('een boeking in dezelfde milliseconde als de telling valt niet weg',
  gelijk?.bedrag === 50, String(gelijk?.bedrag))

check('een lege boeking wordt geweigerd', await (async () => {
  try {
    await kluis.kluisBoeken({ kluis: deKluis, soort: 'inleg', munten: {}, door: baas })
    return false
  } catch { return true }
})())

/* ---- alles staat in de wachtrij ---- */

const kluisWachtrij = (await db.outbox.toArray()).filter((r) => r.entity === 'safeMoves')
check('elke kluisboeking staat in de wachtrij', kluisWachtrij.length >= 5,
  String(kluisWachtrij.length))
check('de kluisboeking gaat na de kassadag de deur uit',
  PUSH_ORDER.indexOf('safeMoves') > PUSH_ORDER.indexOf('cashSessions'))

/*
 * Twee tabellen mag de kassa alleen bijwerken en niet aanmaken: zijn eigen
 * kassa en zijn eigen regel in de apparatenlijst. Die worden door het kantoor
 * en door de koppelfunctie gemaakt.
 *
 * Dit ging mis met een upsert. Die is voor alle andere tabellen precies goed --
 * een bon die opnieuw wordt aangeboden mag niet stuklopen op "bestaat al" --
 * maar voor Postgres is het een INSERT met een uitweg, en die wordt eerst tegen
 * de INSERT-regel gehouden. Voor een apparaat bestaat die niet. Aan de balie
 * stond "new row violates row-level security policy for table pos_devices",
 * over een nieuwe rij die er niet was.
 */
check('de kassa maakt zijn eigen kassa en apparaat niet aan',
  foutsoorten.ALLEEN_BIJWERKEN.includes('registers') &&
  foutsoorten.ALLEEN_BIJWERKEN.includes('devices'),
  foutsoorten.ALLEEN_BIJWERKEN.join(', '))

check('en bonnen en uren gaan wel als upsert, want die maakt hij zelf',
  !foutsoorten.ALLEEN_BIJWERKEN.includes('sales') &&
  !foutsoorten.ALLEEN_BIJWERKEN.includes('timeEntries'))

/*
 * Een naam die er niet is, valt stil terug op de upsert -- en dan is de fout
 * terug zonder dat iemand het merkt.
 */
check('en die lijst bevat alleen tabellen die de kassa echt verstuurt',
  foutsoorten.ALLEEN_BIJWERKEN.every((e) => PUSH_ORDER.includes(e)),
  foutsoorten.ALLEEN_BIJWERKEN.filter((e) => !PUSH_ORDER.includes(e)).join(', '))

/* ---- de herinnering om te tellen ---- */

check('een verse telling geeft geen herinnering',
  kluis.telHerinnering(naUitgave) === null)

const oudeTelling = {
  ...naUitgave!,
  laatsteTelling: { ...geteldMinder.boeking, at: Date.now() - 60 * 86400000 },
}
check('een telling van twee maanden oud wel',
  (kluis.telHerinnering(oudeTelling) ?? '').includes('niet geteld'))

/* ================================================================== *
 *  14. De koppelcode
 *
 *  Het inwisselen zelf gaat over het netwerk en is hier niet te testen. Wat
 *  wél te testen is, is het deel dat iemand op een maandagochtend tegenhoudt:
 *  het opschonen en het nakijken van wat er is ingetikt.
 * ================================================================== */

console.log('\n14. De koppelcode')

check('streepjes en spaties mogen mee',
  koppelen.koppelcodeOpschonen('k7qj-4m2p') === 'K7QJ4M2P' &&
  koppelen.koppelcodeOpschonen(' K7QJ 4M2P ') === 'K7QJ4M2P')

check('een goede code komt er zonder klacht door',
  koppelen.koppelcodeProbleem('K7QJ4M2P') === null)

check('te kort wordt gemeld',
  (koppelen.koppelcodeProbleem('K7QJ') ?? '').includes('acht tekens'))

check('te lang ook',
  (koppelen.koppelcodeProbleem('K7QJ4M2PX') ?? '').includes('acht tekens'))

/*
 * Dit is de melding die het telefoontje voorkomt. Wie een O voor een nul
 * aanziet, krijgt niet "onbekende code" maar te horen wát er mis is.
 */
const verward = koppelen.koppelcodeProbleem('K7QJ4M2O') ?? ''
check('een O in de code wordt uitgelegd', verward.includes('O'), verward)
check('en de uitleg zegt waarom', verward.includes('nul'), verward)

check('een nul en een één worden ook opgemerkt',
  (koppelen.koppelcodeProbleem('K7QJ4M20') ?? '').includes('0') &&
  (koppelen.koppelcodeProbleem('K7QJ4M21') ?? '').includes('1'))

check('een leeg veld zegt wat je moet doen',
  (koppelen.koppelcodeProbleem('') ?? '').includes('dashboard'))

/* ---- en wat de kassa zegt als het versturen mislukt ----
 *
 * Dit is de plek waar het één keer echt misging. De kassa zei "Edge Function
 * returned a non-2xx status code" terwijl de serverfunctie simpelweg niet
 * uitgerold was. Dat is geen melding maar een raadsel: je weet niet of de code
 * verlopen is, of de lijn eruit ligt, of er iets op de server mist.
 */

check('onze eigen uitleg gaat voor alles',
  koppelen.foutUitleg({
    status: 422,
    body: { ok: false, reden: 'Deze code is al gebruikt.' },
  }) === 'Deze code is al gebruikt.')

const nietUitgerold = koppelen.foutUitleg({
  status: 404,
  body: { code: 'NOT_FOUND', message: 'Requested function was not found' },
})
check('een 404 zonder eigen uitleg betekent: de functie staat er niet',
  nietUitgerold.includes('staat nog niet op de server'), nietUitgerold)
check('en zegt hoe je dat oplost',
  nietUitgerold.includes('npm run functions'), nietUitgerold)
check('en niet dat de code fout is',
  !nietUitgerold.toLowerCase().includes('code die je intikte is'), nietUitgerold)

/*
 * De valkuil eronder: onze eigen functie gaf een onbekende code eerst óók een
 * 404 terug. Dan zijn die twee gevallen aan de status niet te onderscheiden.
 * Nu is dat 422 -- en zelfs als het weer 404 wordt, wint `reden`.
 */
check('een 404 mét eigen uitleg blijft die eigen uitleg',
  koppelen.foutUitleg({ status: 404, body: { reden: 'Deze code kent de database niet.' } })
    === 'Deze code kent de database niet.')

const dichteDeur = koppelen.foutUitleg({
  status: 401,
  body: { message: 'Missing authorization header' },
})
check('een 401 wijst naar de sleutelcontrole',
  dichteDeur.includes('no-verify-jwt'), dichteDeur)

const ietsAnders = koppelen.foutUitleg({
  status: 500,
  body: { message: 'boom' },
})
check('bij iets anders staat de code én wat de server zei erin',
  ietsAnders.includes('500') && ietsAnders.includes('boom'), ietsAnders)

check('platte tekst mag ook meekomen',
  koppelen.foutUitleg({ status: 502, plat: 'Bad Gateway' }).includes('Bad Gateway'))

check('en zonder iets bruikbaars blijft het eerlijk',
  koppelen.foutUitleg({}).includes('geen uitleg'))

/* ================================================================== */


/* ================================================================== *
 *  15. Ontkoppelen
 *
 *  Deze afdeling staat achteraan met een reden: hij maakt de kassa leeg. Alles
 *  wat erboven staat heeft zijn gegevens dan al gehad.
 *
 *  Wat hier bewezen moet worden is niet dat het wist -- dat is een regel code.
 *  Het is de rem: een kassa die zich leegmaakt terwijl er nog een bon in de
 *  wachtrij staat, gooit omzet weg die nergens anders bestaat.
 * ================================================================== */

console.log('\n15. Ontkoppelen')

check('met een lege wachtrij is er geen bezwaar',
  koppelen.ontkoppelBezwaar(0) === null)

const eenBezwaar = koppelen.ontkoppelBezwaar(1) ?? ''
check('met een wijziging staat er enkelvoud',
  eenBezwaar.includes('wacht nog 1 wijziging'), eenBezwaar)

const meerBezwaar = koppelen.ontkoppelBezwaar(7) ?? ''
check('en met meer het aantal', meerBezwaar.includes('7 wijzigingen'), meerBezwaar)
check('en de uitleg zegt waarom het erop staat',
  meerBezwaar.includes('omzet'), meerBezwaar)

check('forceren zet de rem eraf', koppelen.ontkoppelBezwaar(7, true) === null)

/* ---- de rem zit er ook echt op ---- */

const wachtrijVooraf = await db.outbox.count()
check('er staat nog iets in de wachtrij van deze test', wachtrijVooraf > 0,
  String(wachtrijVooraf))

const geweigerd = await koppelen.wisApparaat()
check('ontkoppelen wordt geweigerd zolang er iets wacht',
  !geweigerd.ok && (geweigerd.reden ?? '').includes('wachten nog'),
  geweigerd.reden ?? '')
check('en dan is er niets gewist', (await db.registers.count()) > 0)

/* ---- en met forceren gaat het door ---- */

const sleutelVooraf = await koppelen.apparaatSleutel()

const gewist = await koppelen.wisApparaat({ forceren: true })
check('met forceren lukt het wel', gewist.ok, gewist.reden ?? '')

check('de wachtrij is leeg', (await db.outbox.count()) === 0)
check('de kassa is uit de cache', (await db.registers.count()) === 0)
check('het personeel ook', (await db.users.count()) === 0)
check('en de kluis', (await db.safes.count()) === 0 && (await db.safeMoves.count()) === 0)
check('de gekozen kassa staat niet meer in meta',
  (await db.meta.get('registerId')) === undefined)

/*
 * En het enige dat blijft staan. Zonder dit kenmerk is dit apparaat voor de
 * server een nieuw apparaat, en dan weigert de database een tweede apparaat op
 * dezelfde kassa -- dus zou hetzelfde apparaat zich niet opnieuw kunnen
 * koppelen aan de kassa waar het net af kwam.
 */
check('het kenmerk van dit apparaat blijft staan',
  (await koppelen.apparaatSleutel()) === sleutelVooraf)

/* ================================================================== *
 *  16. De foto bij een artikel
 *
 *  Het verkleinen zelf vraagt een canvas en dus een browser; dat is hier niet
 *  te testen. Wat wél te testen is, is het rekenwerk eromheen -- en dat is
 *  precies het deel dat stil fout gaat. Een foto die scheef wordt getrokken
 *  ziet eruit als een slechte foto en niet als een fout in een berekening, en
 *  een grens die niet klopt merk je pas als elke synchronisatie traag wordt.
 * ================================================================== */

console.log('\n16. De foto bij een artikel')

check('een grote foto wordt op de lange zijde geschaald',
  JSON.stringify(beeld.beeldMaten(4000, 3000, 400)) === '{"breedte":400,"hoogte":300}')

check('en staand net zo goed',
  JSON.stringify(beeld.beeldMaten(3000, 4000, 400)) === '{"breedte":300,"hoogte":400}')

check('vierkant blijft vierkant',
  JSON.stringify(beeld.beeldMaten(1000, 1000, 400)) === '{"breedte":400,"hoogte":400}')

/*
 * Niet oprekken. Een foto van tachtig pixels naar vierhonderd blazen geeft een
 * wazige tegel en een bestand dat vijf keer zo groot is voor dezelfde
 * informatie.
 */
check('een kleine foto wordt niet opgerekt',
  JSON.stringify(beeld.beeldMaten(80, 60, 400)) === '{"breedte":80,"hoogte":60}')

check('een rare maat geeft nul en geen fout',
  JSON.stringify(beeld.beeldMaten(0, 100)) === '{"breedte":0,"hoogte":0}')

/* ---- hoe groot is een data-URI ---- */

// "AAAA" is base64 voor drie bytes; met opvulling wordt het minder.
check('de bytes achter een data-URI worden goed geteld',
  beeld.dataUriBytes('data:image/jpeg;base64,AAAA') === 3 &&
  beeld.dataUriBytes('data:image/jpeg;base64,AAA=') === 2 &&
  beeld.dataUriBytes('data:image/jpeg;base64,AA==') === 1)

check('zonder komma is het niets', beeld.dataUriBytes('rommel') === 0)

/* ---- wat mag er in een img-tag ---- */

const eenGeldige = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
check('een echte afbeelding komt erdoor',
  beeld.veiligeAfbeelding(eenGeldige) === eenGeldige)

check('png en webp ook',
  beeld.veiligeAfbeelding('data:image/png;base64,iVBORw0K') !== null &&
  beeld.veiligeAfbeelding('data:image/webp;base64,UklGRg==') !== null)

/*
 * En wat er niet in mag. De waarde komt uit de database en dus van buiten dit
 * apparaat. In een img-tag doet een stuk html niets, maar "alleen
 * afbeeldingen" is een regel die je opschrijft in plaats van aanneemt.
 */
check('html vermomd als afbeelding komt er niet door',
  beeld.veiligeAfbeelding('data:text/html;base64,PHNjcmlwdD4=') === null)
check('een gewoon adres ook niet',
  beeld.veiligeAfbeelding('https://ergens/plaatje.jpg') === null)
check('en rommel in de base64 evenmin',
  beeld.veiligeAfbeelding('data:image/jpeg;base64,<script>') === null)
check('leeg is leeg',
  beeld.veiligeAfbeelding('') === null && beeld.veiligeAfbeelding(undefined) === null)

/* ---- de grenzen ---- */

check('de bovengrens past ruim onder wat de database toestaat',
  // 150000 tekens in de kolom; base64 maakt bytes ongeveer een derde groter.
  Math.ceil((beeld.MAX_BYTES * 4) / 3) < 150000)

check('de kwaliteiten lopen af en blijven bruikbaar',
  beeld.KWALITEITEN.every((k, i, r) => i === 0 || k < r[i - 1]) &&
  beeld.KWALITEITEN[beeld.KWALITEITEN.length - 1] >= 0.25)

check('de grootte leest als een grootte',
  beeld.bytesKort(512) === '512 B' &&
  beeld.bytesKort(47128) === '46 kB' &&
  beeld.bytesKort(3_500_000) === '3.3 MB')

/* ================================================================== *
 *  17. Een geweigerde urenregel verdwijnt niet
 *
 *  Dit is de afdeling die er niet was toen het misging. Een inklokking
 *  verdween: het apparaataccount miste een recht, de database weigerde de
 *  urenregel, en pushPerStuk deed wat hij bij elke fout deed -- acht keer
 *  proberen en dan weggooien. Aan de balie was niets te zien; de medewerker had
 *  "is ingeklokt" gelezen en stond onder "Nu aan het werk".
 *
 *  Wat hier gemeten wordt is precies dat: dat een weigering op rechten de regel
 *  laat staan, dat hij dat blijft doen -- ook na meer rondes dan MAX_TRIES --
 *  en dat het in beeld komt. En eronder de tegenproef: een fout die wel over
 *  het record gaat, wordt nog steeds opgegeven.
 * ================================================================== */

console.log('\n17. Een geweigerde urenregel verdwijnt niet')

const MAX_TRIES_HIER = 8

/*
 * De echte push onderscheppen. Dat kan omdat api een object is: de binding is
 * const, de inhoud niet. Zo meten we het gedrag van pushPerStuk zelf en niet
 * dat van een nagemaakte kopie ervan.
 */
const echtePush = deApi.push
const zetPush = (fn: typeof deApi.push) => { (deApi as any).push = fn }

// Schoon beginnen: eerdere afdelingen hebben de wachtrij gevuld.
await db.outbox.clear()

const klokker = (await db.users.get(wasser.id)) ?? wasser
await klok.inklokken(klokker, register.locationId)

const inDeRij = await db.outbox.where('entity').equals('timeEntries').toArray()
check('inklokken zet een regel in de wachtrij', inDeRij.length === 1,
  String(inDeRij.length))

/* ---- de server weigert het op de rechten ---- */

zetPush(async () => {
  throw new foutsoorten.GeenRechten(
    'time_entries', 'new row violates row-level security policy')
})

/*
 * Ruim meer rondes dan er pogingen zijn. Was dit de oude code, dan was de
 * regel na de achtste ronde weg -- en dat is precies wat er in het echt
 * gebeurde.
 */
for (let ronde = 0; ronde < MAX_TRIES_HIER + 4; ronde++) {
  await pushPerStuk(await db.outbox.toArray())
}

const naWeigeren = await db.outbox.where('entity').equals('timeEntries').toArray()
check(`de urenregel staat er na ${MAX_TRIES_HIER + 4} weigeringen nog`,
  naWeigeren.length === 1, `${naWeigeren.length} regels over`)
check('en heeft geen enkele poging verbruikt',
  naWeigeren[0]?.tries === 0, `tries = ${naWeigeren[0]?.tries}`)
check('de weigeringen worden apart geteld',
  naWeigeren[0]?.geweigerd === MAX_TRIES_HIER + 4,
  `geweigerd = ${naWeigeren[0]?.geweigerd}`)
check('en de reden staat erbij zoals de server hem gaf',
  (naWeigeren[0]?.lastError ?? '').includes('row-level security'),
  naWeigeren[0]?.lastError ?? '')

/* ---- en de andere drie soorten net zo ---- */

const soorten: [string, () => Error][] = [
  ['een verlopen sessie', () => new foutsoorten.GeenSessie()],
  ['een ontbrekende tabel', () => new foutsoorten.OntbrekendeTabel('time_entries')],
  ['een ontbrekende kolom', () => new foutsoorten.OntbrekendeKolom('time_entries', 'x')],
]

for (const [naam, maakFout] of soorten) {
  await db.outbox.clear()
  await klok.uitklokken(klokker.id)
  await klok.inklokken(klokker, register.locationId)

  zetPush(async () => { throw maakFout() })
  for (let ronde = 0; ronde < MAX_TRIES_HIER + 2; ronde++) {
    await pushPerStuk(await db.outbox.toArray())
  }

  const over = await db.outbox.count()
  check(`${naam} gooit ook niets weg`, over > 0, `${over} regels over`)
  check(`en verbruikt ook bij ${naam} geen pogingen`,
    (await db.outbox.toArray()).every((r) => r.tries === 0))
}

/* ---- de tegenproef: een echte fout op dit record ---- */

await db.outbox.clear()
await klok.uitklokken(klokker.id)
await klok.inklokken(klokker, register.locationId)

zetPush(async () => { throw new Error('opslaan in time_entries: waarde te lang') })
for (let ronde = 0; ronde < MAX_TRIES_HIER; ronde++) {
  await pushPerStuk(await db.outbox.toArray())
}

const naEchteFout = await db.outbox.count()
check('een fout die wel over het record gaat wordt nog steeds opgegeven',
  naEchteFout === 0, `${naEchteFout} regels over`)

/* ---- en als de rechten kloppen, gaat hij alsnog mee ---- */

/*
 * Eerst uitklokken, dan de rij leeg, dan inklokken. Uitklokken zet namelijk
 * zelf ook een regel in de wachtrij -- en dan meet je twee dingen terwijl je
 * er één bedoelde.
 */
await klok.uitklokken(klokker.id)
await db.outbox.clear()
await klok.inklokken(klokker, register.locationId)

zetPush(async () => { throw new foutsoorten.GeenRechten('time_entries', 'geweigerd') })
await pushPerStuk(await db.outbox.toArray())
check('vastgelopen, en dat is te zien', (await db.outbox.count()) > 0)

// Het kantoor zet het recht goed.
let verstuurd = 0
zetPush(async () => { verstuurd++ })
await pushPerStuk(await db.outbox.toArray())

const naHerstel = await db.outbox.count()
check('zodra het recht klopt gaat de regel alsnog de deur uit',
  verstuurd === 1 && naHerstel === 0, `${verstuurd} verstuurd, ${naHerstel} over`)

zetPush(echtePush)

/* ================================================================== *
 *  18. En het komt in beeld
 *
 *  De helft van de fout was dat er niets werd weggegooid maar ook niets
 *  gezegd. Een regel die voor altijd in de wachtrij blijft staan is net zo
 *  onzichtbaar als een regel die weg is -- en bij uren is onzichtbaar het
 *  echte probleem. Wie zijn uren kwijtraakt hoort dat vandaag te weten en niet
 *  aan het eind van de maand.
 * ================================================================== */

console.log('\n18. En het komt in beeld')

const nuMeting = Date.now()

check('een schone wachtrij meldt niets',
  wachtrijLib.vatWachtrij([]).vast === 0 &&
  wachtrijLib.vastKort(wachtrijLib.vatWachtrij([])) === null &&
  wachtrijLib.vastVerhaal(wachtrijLib.vatWachtrij([])) === null)

/*
 * Een regel die gewoon nog niet geweest is, is niet vastgelopen. Dat verschil
 * moet blijven staan: anders staat er een waarschuwing zodra de kassa een
 * seconde offline is, en dan leert iedereen die melding wegkijken.
 */
const nogNietGeweest = wachtrijLib.vatWachtrij([
  { entity: 'sales', op: 'put', recordId: 'b1', payload: {}, createdAt: nuMeting, tries: 0 },
])
check('wat nog niet geweest is, zit niet vast',
  nogNietGeweest.totaal === 1 && nogNietGeweest.vast === 0)
check('en levert dus geen melding op', wachtrijLib.vastKort(nogNietGeweest) === null)

const eenPoging = wachtrijLib.vatWachtrij([
  { entity: 'sales', op: 'put', recordId: 'b1', payload: {}, createdAt: nuMeting,
    tries: 3, lastError: 'time-out' },
])
check('een gewone mislukte poging ook niet', eenPoging.vast === 0)

/* ---- en wat wel vastzit ---- */

const vast = wachtrijLib.vatWachtrij([
  { entity: 'timeEntries', op: 'put', recordId: 't1', payload: {},
    createdAt: nuMeting - 95 * 60_000, tries: 0, geweigerd: 12,
    lastError: 'De database weigert dit voor "time_entries"' },
  { entity: 'timeEntries', op: 'put', recordId: 't2', payload: {},
    createdAt: nuMeting - 30 * 60_000, tries: 0, geweigerd: 4 },
  { entity: 'saleLines', op: 'put', recordId: 'r1', payload: {},
    createdAt: nuMeting - 10 * 60_000, tries: 0, geweigerd: 2 },
  { entity: 'sales', op: 'put', recordId: 'b9', payload: {}, createdAt: nuMeting, tries: 0 },
])

check('de uren worden apart geteld', vast.uren === 2, String(vast.uren))
check('en het totaal dat vastzit', vast.vast === 3, String(vast.vast))
check('de rest van de wachtrij telt mee in het totaal', vast.totaal === 4)
check('de oudste bepaalt sinds wanneer', vast.sindsMs === nuMeting - 95 * 60_000)
check('en zijn reden komt mee',
  (vast.reden ?? '').includes('weigert dit voor'), vast.reden ?? '')

const kort = wachtrijLib.vastKort(vast) ?? ''
check('de balk noemt de uren en niet de rest', kort === '2 klokregels vast', kort)

const verhaal = wachtrijLib.vastVerhaal(vast, nuMeting) ?? ''
check('de melding zegt hoeveel klokkingen er vastzitten',
  verhaal.includes('2 in- en uitklokkingen'), verhaal)
check('en noemt de rest in gewone woorden en niet in tabelnamen',
  verhaal.includes('1 bonregel') && !verhaal.includes('saleLines'), verhaal)
/*
 * "1x bonregels" stond op de eerste afdruk, en dat is het soort scheve zin
 * waardoor iemand een waarschuwing niet meer serieus neemt.
 */
check('en zet enkelvoud waar het er een is',
  !verhaal.includes('1x') && !verhaal.includes('1 bonregels'), verhaal)
check('en zegt hoe lang het al mis is',
  verhaal.includes('1 uur en 35 minuten'), verhaal)

/*
 * De regel die het verschil maakt tussen een melding en paniek. Zonder deze
 * zin leest het als "je uren zijn kwijt", en gaat iemand ze op een briefje
 * bijhouden terwijl ze er nog zijn.
 */
check('en dat er niets is weggegooid', verhaal.includes('niets weggegooid'), verhaal)
check('en wat hij nu moet doen', verhaal.includes('Meld het'), verhaal)

/* ---- zonder uren blijft het netjes ---- */

const alleenBonnen = wachtrijLib.vatWachtrij([
  { entity: 'sales', op: 'put', recordId: 'b1', payload: {},
    createdAt: nuMeting - 5 * 60_000, tries: 0, geweigerd: 1 },
])
check('zonder uren noemt de balk gewoon regels',
  wachtrijLib.vastKort(alleenBonnen) === '1 regel vast')
check('en de melding heeft het niet over klokkingen',
  !(wachtrijLib.vastVerhaal(alleenBonnen, nuMeting) ?? '').includes('uitklokking'))

/* ---- en het staat ook echt in de stand die het scherm uitleest ---- */

await klok.uitklokken(klokker.id)
await db.outbox.clear()
await klok.inklokken(klokker, register.locationId)
zetPush(async () => {
  throw new foutsoorten.GeenRechten('time_entries', 'geweigerd op de rechten')
})
await pushPerStuk(await db.outbox.toArray())
await useSync.getState().refreshPending()
zetPush(echtePush)

const standScherm = useSync.getState().vast
check('de synchronisatiestand die het scherm uitleest weet het ook',
  standScherm.uren === 1 && standScherm.vast === 1,
  `uren ${standScherm.uren}, vast ${standScherm.vast}`)
check('en heeft een tekst voor de balk',
  wachtrijLib.vastKort(standScherm) === '1 klokregel vast')

await db.outbox.clear()

await db.close()

console.log(`\n${passed} geslaagd, ${failed} mislukt\n`)
process.exit(failed === 0 ? 0 : 1)
