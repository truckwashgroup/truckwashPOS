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
import { liveQuery } from 'dexie'
import { readFileSync } from 'node:fs'

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

const { db, uid, setMeta, getMeta } = await import('../src/lib/db')
const geld = await import('../src/lib/geld')
const {
  badgeMaken, herkenBadge, herkenFout, herkenOpNummer, magOpKassa,
  normaliseerNummer, nummerProbleem, nummersNakijken,
} = await import('../src/lib/code')
const klok = await import('../src/lib/klok')
const kaarten = await import('../src/lib/kaarten')
const kassa = await import('../src/lib/kassa')
const kas = await import('../src/lib/kas')
const { bonOpmaken, alsTekst, bonGegevens } = await import('../src/lib/bon')
const {
  NOOIT_STUREN, OPSCHONEN, PUSH_ORDER, enqueue, pushPerStuk,
  ruimNietMeerVerstuurbaarOp, setSyncEnabled, syncStaatAan, useSync,
  verwijderWatWegIs,
} = await import('../src/lib/sync')
const wachtrijLib = await import('../src/lib/wachtrij')
const foutsoorten = await import('../src/lib/api/supabaseApi')
const { api: deApi } = await import('../src/lib/api')
const munten = await import('../src/lib/munten')
const kluis = await import('../src/lib/kluis')
const koppelen = await import('../src/lib/koppelen')
const beeld = await import('../src/lib/afbeelding')
const artikel = await import('../src/lib/artikel')
const { toRow, fromRow, eigenVelden } = await import('../src/lib/api/supabaseApi')
const { vergelijkVersies } = await import('../src/lib/hardware/apkUpdate')
const {
  STIL_GENOEG_MS, UITSTEL_MS, mogenWeInstalleren, secondenTeGaan, updateBericht,
} = await import('../src/lib/updateMoment')

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
 *  19. Wie mag op welke kassa?
 *
 *  Wie op één vestiging staat, mag alleen de kassa van die vestiging. Wie
 *  overal mag werken, mag elke kassa.
 *
 *  Dit stond er niet, en dat was niet zichtbaar: de kassa haalt het personeel
 *  van zijn eigen vestiging op, dus in de praktijk stonden er meestal alleen
 *  mensen in de cache die er hoorden. Maar de beveiligingsregels laten ook
 *  dossiers zonder vestiging door -- die zijn "voor iedereen" -- en wie een
 *  nummer intoetste dat in de cache stond, kwam erin. Iemand van Asten die op
 *  de kassa in Rotterdam inklokt, komt met zijn uren op de verkeerde
 *  vestiging terecht, en dat merkt niemand tot iemand ze naast elkaar legt.
 * ================================================================== */

console.log('\n19. Wie mag op welke kassa?')

const asten = { locationId: 'loc_asten' }
const rotterdam = 'loc_rtm'

check('wie op deze vestiging staat, mag erop',
  magOpKassa(asten, 'loc_asten').ok)

const kassaElders = magOpKassa(asten, rotterdam)
check('en op een andere kassa niet',
  !kassaElders.ok && kassaElders.reden === 'andere-vestiging',
  JSON.stringify(kassaElders))

check('wie overal mag werken, mag elke kassa',
  magOpKassa({ locationId: 'loc_hk', allLocations: true }, rotterdam).ok)

check('en wie leiding heeft over deze vestiging ook',
  magOpKassa({ locationId: 'loc_asten', manages: ['loc_rtm'] }, rotterdam).ok)

/*
 * Geen vestiging in het dossier is een eigen geval, met een eigen melding: bij
 * de verkeerde vestiging staat iemand op de verkeerde plek, hier is het
 * dossier niet af. Maar de deur gaat in beide gevallen dicht -- zou "geen
 * vestiging" wel binnenkomen, dan is dat precies de opening die dit moet
 * sluiten, want juist die dossiers staan bij elke kassa in de cache.
 */
const zonderVestiging = magOpKassa({}, rotterdam)
check('zonder vestiging in het dossier komt niemand erin',
  !zonderVestiging.ok && zonderVestiging.reden === 'geen-vestiging', JSON.stringify(zonderVestiging))

/*
 * En een kassa zonder vestiging toetst niets. Een kassa op slot zetten om
 * ontbrekende gegevens is erger dan het gat dat het dicht.
 */
check('een kassa zonder vestiging laat iedereen door',
  magOpKassa(asten, undefined).ok && magOpKassa({}, '').ok)

/* ---- en dan door de echte deur ---- */

const astenLocatie = 'loc_asten'
await db.locations.put({
  id: astenLocatie, code: 'TW-AST', name: 'Asten', kind: 'vestiging',
  active: true, updatedAt: Date.now(),
} as any)

const vanAsten: User = {
  ...wasser,
  id: 'u_asten', email: 'asten@truckwash1group.nl', name: 'Aad van Asten',
  personnelNumber: 'TW-777', locationId: astenLocatie, allLocations: false,
  manages: [],
}
await db.users.put(vanAsten)

const opEigenKassa = await herkenOpNummer('777', astenLocatie)
check('op zijn eigen kassa komt hij erin',
  opEigenKassa.ok && opEigenKassa.user.id === 'u_asten')

const opAndereKassa = await herkenOpNummer('777', register.locationId)
check('op de kassa van een andere vestiging niet',
  !opAndereKassa.ok && opAndereKassa.reden === 'andere-vestiging',
  JSON.stringify(opAndereKassa))

/*
 * De melding is het halve werk. "Je mag hier niet" laat iemand het nog drie
 * keer proberen; met zijn naam en zijn vestiging erin weet hij meteen wat er
 * aan de hand is -- en als het niet klopt, weet hij ook wat er in het
 * dashboard verkeerd staat.
 */
const melding = herkenFout(opAndereKassa as any)
check('en de melding noemt hem bij naam', melding.includes('Aad van Asten'), melding)
check('en zegt waar hij dan wel hoort', melding.includes('Asten'), melding)
check('en wat eraan te doen valt', melding.includes('kantoor'), melding)

/* ---- de badge is dezelfde deur ---- */

// badgeMaken geeft de code zelf terug, geen rij.
const astenBadge = await badgeMaken(vanAsten.id)
const badgeElders = await herkenBadge(astenBadge, register.locationId)
check('een badge van een andere vestiging komt er ook niet door',
  !badgeElders.ok && badgeElders.reden === 'andere-vestiging',
  JSON.stringify(badgeElders))

const badgeEigen = await herkenBadge(astenBadge, astenLocatie)
check('en op zijn eigen kassa wel', badgeEigen.ok)

/* ---- iemand die overal mag, komt overal door ---- */

await db.users.put({ ...vanAsten, id: 'u_overal', name: 'Wendy Overal',
  personnelNumber: 'TW-778', allLocations: true } as User)

const overalHier = await herkenOpNummer('778', register.locationId)
check('wie overal mag werken komt er ook hier in', overalHier.ok)

await db.users.delete('u_overal')
await db.users.delete('u_asten')

/* ================================================================== */

/* ================================================================== *
 *  20. Artikelen van Trucksupply
 *
 *  De leverancier beheert vanaf nu de artikelen: naam, eenheid, foto en de
 *  voorraadstand staan in inventory_items, en een serverfunctie zet ze in
 *  pos_products. De kassa las die voorraadtabel al -- verkoop boekt er af --
 *  maar liet er niets van zien.
 *
 *  Wat hier gemeten wordt is het samenvoegen van die twee, en de twee dingen
 *  die daarbij stil fout kunnen gaan: een kolomnaam die niet omgezet wordt, en
 *  een verkoop van een artikel dat de leverancier net heeft uitgezet.
 * ================================================================== */

console.log('\n20. Artikelen van Trucksupply')

/* ---- komen de nieuwe kolommen door de omzetting? ---- */

const uitDatabase = fromRow('inventory', {
  id: 'inv_1',
  location_id: 'loc_utr',
  name: 'Ruitenwisservloeistof',
  unit: 'fles',
  stock: 4,
  min_stock: 6,
  price_per_unit: 3.2,
  supplier: 'Trucksupply',
  sku: 'TS-1044',
  omschrijving: 'Zomer, 5 liter',
  image: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
  bestelhoeveelheid: 12,
  inkoopprijs: 2.75,
  actief: true,
  exact_code: 'EX-1044',
  updated_at: 1,
}) as any

check('min_stock wordt minStock', uitDatabase.minStock === 6)
check('exact_code wordt exactCode', uitDatabase.exactCode === 'EX-1044')
check('bestelhoeveelheid blijft bestelhoeveelheid', uitDatabase.bestelhoeveelheid === 12)
check('en sku, omschrijving, inkoopprijs en actief komen mee',
  uitDatabase.sku === 'TS-1044' && uitDatabase.omschrijving === 'Zomer, 5 liter' &&
  uitDatabase.inkoopprijs === 2.75 && uitDatabase.actief === true)

/*
 * En de weg terug, want de kassa boekt voorraad af en stuurt de rij mee. Een
 * veld dat op de terugweg een andere naam krijgt, komt in een kolom die niet
 * bestaat -- en dan weigert de database de hele mutatie.
 */
const naarDatabase = toRow('inventory', uitDatabase) as any
check('en op de terugweg heten ze weer zoals in de database',
  'min_stock' in naarDatabase && 'exact_code' in naarDatabase &&
  'bestelhoeveelheid' in naarDatabase && !('minStock' in naarDatabase),
  Object.keys(naarDatabase).join(', '))

/* ---- de foto van het artikel valt in ---- */

const voorraadItem = {
  id: 'inv_foto', locationId: register.locationId ?? 'loc_test',
  name: 'Handreiniger', unit: 'fles', stock: 9, minStock: 3,
  pricePerUnit: 2, supplier: 'Trucksupply',
  image: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
  actief: true, updatedAt: Date.now(),
} as any
await db.inventory.put(voorraadItem)

const voorraadNu = artikel.voorraadKaart(await db.inventory.toArray())

check('zonder eigen foto komt die van het artikel',
  artikel.artikelFoto({ inventoryItemId: 'inv_foto' }, voorraadNu) === voorraadItem.image)

/*
 * En de eigen foto gaat voor. Die heeft iemand aan de kassa met opzet gekozen;
 * zou de leverancier hem overschrijven, dan is dat werk voor niets geweest.
 */
const eigen = 'data:image/png;base64,iVBORw0K'
check('een eigen foto gaat voor die van het artikel',
  artikel.artikelFoto({ image: eigen, inventoryItemId: 'inv_foto' }, voorraadNu) === eigen)

check('een artikel zonder voorraad heeft geen foto',
  artikel.artikelFoto({ inventoryItemId: undefined }, voorraadNu) === null)

check('en rommel in het veld komt er niet door',
  artikel.artikelFoto({ image: 'data:text/html;base64,PHNjcmlwdD4=' }, voorraadNu) === null)

/* ---- de voorraadstand ---- */

const genoeg = artikel.artikelVoorraad({ inventoryItemId: 'inv_foto' }, voorraadNu)
check('de stand komt uit het artikel',
  genoeg?.stand === 9 && genoeg?.eenheid === 'fles' && !genoeg?.onderMinimum)

await db.inventory.put({ ...voorraadItem, id: 'inv_laag', stock: 2, minStock: 6 } as any)
await db.inventory.put({ ...voorraadItem, id: 'inv_leeg', stock: 0, minStock: 6 } as any)
const voorraadDaarna = artikel.voorraadKaart(await db.inventory.toArray())

const laag = artikel.artikelVoorraad({ inventoryItemId: 'inv_laag' }, voorraadDaarna)
check('onder het minimum valt op', laag?.onderMinimum === true && laag?.leeg === false)

const opVoorraadLeeg = artikel.artikelVoorraad({ inventoryItemId: 'inv_leeg' }, voorraadDaarna)
check('en leeg is iets anders dan laag', opVoorraadLeeg?.leeg === true)
check('en dat staat er ook zo', artikel.voorraadTekst(opVoorraadLeeg!) === 'niet op voorraad')
/*
 * Zonder eenheid. Op de eerste afdruk stond "9 fles op voorraad": geen
 * Nederlands, en het liep de tegel uit. Meervoud maken van een eenheid die de
 * leverancier zelf intikt gaat niet -- stuk, doos, rol, liter en 5L hebben elk
 * hun eigen regel of geen.
 */
check('en bij genoeg staat alleen het getal',
  artikel.voorraadTekst(genoeg!) === '9 op voorraad')

/*
 * Geen minimum ingesteld is geen tekort. Anders staat elk artikel waar niemand
 * een minimum voor heeft bedacht in het geel, en dan kijkt iedereen eroverheen.
 */
await db.inventory.put({ ...voorraadItem, id: 'inv_geen_min', stock: 0, minStock: 0 } as any)
const zonderMin = artikel.artikelVoorraad(
  { inventoryItemId: 'inv_geen_min' }, artikel.voorraadKaart(await db.inventory.toArray()))
check('zonder minimum is er geen tekort', zonderMin?.onderMinimum === false)

check('een wasbeurt heeft geen stand',
  artikel.artikelVoorraad({ inventoryItemId: undefined }, voorraadDaarna) === null)

/* ---- wie mag artikelen bewaren ---- */

/*
 * Dit gaat over het account van de kassa en niet over wie ervoor staat, want
 * dat is wat de database toetst. Een gekoppelde kassa heeft de rol employee en
 * één recht: hours.clock.
 */
const apparaatAccount = {
  ...wasser, id: 'u_apparaat', name: 'Kassa KAS-UTR-1',
  roles: ['employee'], grants: ['hours.clock'], isDevice: true,
} as User

check('een kassa-account mag de kassa niet beheren',
  !artikel.apparaatMagBeheren(apparaatAccount))

check('met pos.manage erbij wel',
  artikel.apparaatMagBeheren({ ...apparaatAccount, grants: ['pos.manage'] } as User))

check('en een kassa die met een managementaccount is ingericht ook',
  artikel.apparaatMagBeheren({ ...apparaatAccount, roles: ['management'] } as User))

check('zonder account mag er niets', !artikel.apparaatMagBeheren(null))

/* ---- een artikel dat de leverancier uitzet ---- */

const uitgezet: PosProduct = {
  id: 'prod_uit', locationId: register.locationId, code: 'TS-9', name: 'Oud artikel',
  groupName: 'Shop', unit: 'stuk', priceIncl: 3, vatPct: 21, kind: 'artikel',
  inventoryItemId: 'inv_foto', sort: 10, active: false, updatedAt: Date.now(),
}
await db.products.put(uitgezet)

check('een uitgezet artikel staat niet meer op het kassascherm',
  (await db.products.toArray()).filter((x) => x.active && x.id === 'prod_uit').length === 0)

/*
 * Maar een bon die er al mee bezig was, moet gewoon af kunnen. Anders staat er
 * een chauffeur bij de kassa met een fles in zijn hand die niet meer af te
 * rekenen valt omdat het kantoor hem net uit het assortiment haalde.
 */
const bonMetUitgezet = await kassa.afrekenen({
  register,
  door: wasser,
  regels: [{
    id: 'm_uit', productId: uitgezet.id, name: uitgezet.name, kind: 'artikel',
    qty: 1, priceIncl: 3, vatPct: 21, discountPct: 0,
    inventoryItemId: 'inv_foto',
  }],
  betalingen: [{ method: 'contant', amount: 3, received: 5, changeGiven: 2 }],
})

check('en een bon die er al mee bezig was kan gewoon af',
  bonMetUitgezet.bon.status === 'afgerekend')

check('de voorraad is er ook echt op afgeboekt',
  Number((await db.inventory.get('inv_foto'))?.stock) === 8,
  String((await db.inventory.get('inv_foto'))?.stock))

check('en er staat niets vast in de wachtrij',
  (await db.outbox.toArray()).every((r) => (r.geweigerd ?? 0) === 0))

await db.products.delete('prod_uit')

/* ================================================================== */


/* ------------------------------------------------------------------ *
 *  Artikelen gaan nooit meer de deur uit
 *
 *  Artikelen en prijzen worden in het dashboard beheerd. De kassa haalt ze op
 *  en houdt ze in zijn cache, en stuurt er nooit iets terug.
 *
 *  Twee redenen, en de tweede is de zwaarste. De database weigert het (een
 *  kassa-account heeft geen mag_kassa_beheren), dus zo'n rij blijft sinds
 *  0.10.0 zichtbaar in de wachtrij staan -- een alarm zonder uitweg. En erger:
 *  de kassa heeft een kopie van elk artikel, dus zou hij die terugsturen, dan
 *  overschrijft een kassa die een dag uit heeft gestaan de prijs die gisteren
 *  is gezet. Eén tablet in een hoek kan zo een prijswijziging ongedaan maken.
 * ------------------------------------------------------------------ */

check('artikelen staan op de lijst van wat nooit verstuurd wordt',
  NOOIT_STUREN.includes('products'))

check('en staan dus niet meer in de push-volgorde',
  !PUSH_ORDER.includes('products'))

/*
 * Bonnen en uren gaan wel. Zou die lijst te ruim worden, dan verdwijnt er
 * omzet -- vandaar dat dit erbij staat.
 */
check('bonnen, uren en kluisboekingen gaan wel de deur uit',
  !NOOIT_STUREN.includes('sales') && !NOOIT_STUREN.includes('timeEntries') &&
  !NOOIT_STUREN.includes('safeMoves'))

await db.outbox.clear()
await enqueue('products', 'put', 'prod_x', { id: 'prod_x', priceIncl: 1 })
check('een artikel komt niet in de wachtrij', (await db.outbox.count()) === 0)

await enqueue('sales', 'put', 'bon_x', { id: 'bon_x' })
check('een bon wel', (await db.outbox.count()) === 1)

/* ---- en wat er nog stond, gaat eruit ---- */

/*
 * Met opzet een uitzondering op "wij gooien niets weg". Deze rijen zouden
 * anders voor altijd blijven staan: de server weigert ze, en de regels rond
 * rechten gooien ze juist niet weg. Dan staat er een melding aan de balie die
 * nooit meer overgaat.
 */
await db.outbox.add({
  entity: 'products', op: 'put', recordId: 'prod_oud',
  payload: { id: 'prod_oud' }, createdAt: Date.now(), tries: 0, geweigerd: 9,
})
check('een artikel dat er nog stond wordt gevonden',
  (await db.outbox.where('entity').equals('products').count()) === 1)

const opgeruimd = await ruimNietMeerVerstuurbaarOp()
check('en opgeruimd', opgeruimd === 1 &&
  (await db.outbox.where('entity').equals('products').count()) === 0)

check('en de bon staat er nog', (await db.outbox.count()) === 1)

check('en er staat niets meer vast', useSync.getState().vast.vast === 0)

await db.outbox.clear()
await useSync.getState().refreshPending()


/* ================================================================== *
 *  21. Toegang intrekken werkt ook echt
 *
 *  Twee gaten, en ze zaten er allebei. Gemeld met: "je kan nog steeds
 *  inloggen, ook als ik de vestiging weghaal, zelfs als ik de volledige
 *  permissie weghaal."
 *
 *  1. Het recht werd nergens getoetst. In de README stond dat wie geen pos.use
 *     heeft niet aanmeldt, maar herkenOpNummer keek alleen naar het nummer, of
 *     iemand actief was, en de vestiging.
 *
 *  2. De cache gooide nooit iets weg. pull() vertelt wat er is bijgekomen of
 *     gewijzigd, niet wat er wég is -- en "weg" is hier niet alleen verwijderd:
 *     haal je de rollen weg, dan valt het dossier buiten wat de kassa mag zien
 *     en komt het simpelweg niet meer mee. De oude rij bleef staan, met de oude
 *     rollen en de oude vestiging, en daarmee kon iemand blijven aanmelden. Op
 *     elke kassa, voor altijd.
 * ================================================================== */

console.log('\n21. Toegang intrekken werkt ook echt')

const kassaVest = register.locationId ?? 'loc_test'

/* ---- het recht ---- */

const metRecht = { locationId: kassaVest, roles: ['employee'], active: true } as any
check('een werknemer met pos.use mag aanmelden',
  magOpKassa(metRecht, kassaVest, 'pos.use').ok)

/*
 * pos.use zit in de rol employee. Trek je het in met revokes, dan is het weg --
 * en dat was precies wat er niet werd getoetst.
 */
const ingetrokken = { ...metRecht, revokes: ['pos.use'] }
const geenRecht = magOpKassa(ingetrokken, kassaVest, 'pos.use')
check('met pos.use ingetrokken niet',
  !geenRecht.ok && geenRecht.reden === 'geen-recht', JSON.stringify(geenRecht))

check('en zonder enkele rol al helemaal niet',
  !magOpKassa({ locationId: kassaVest, roles: [], active: true } as any,
    kassaVest, 'pos.use').ok)

/*
 * En het geval dat het in het echt was: management met pos.use ingetrokken, en
 * alle vestigingen aan. Die kwam er langs de vestigingspoort heen -- dat is de
 * bedoeling van "werkt op alle vestigingen" -- en er was niets dat het recht
 * toetste. Intrekken wint van een rol, ook van management.
 */
const baasIngetrokken = {
  locationId: 'loc_asten', allLocations: true, active: true,
  roles: ['employee', 'management'], revokes: ['pos.use'],
} as any
check('management met pos.use ingetrokken komt er ook niet in',
  !magOpKassa(baasIngetrokken, kassaVest, 'pos.use').ok)
check('en de vestigingspoort liet hem juist wél door -- dat was het niet',
  magOpKassa(baasIngetrokken, kassaVest).ok)

/*
 * Maar inklokken vraagt dat recht niet, en dat is geen slordigheid. Iedereen op
 * de vloer klokt in, ook wie niet achter de kassa mag staan. Zou het klokscherm
 * pos.use vragen, dan kan de helft van het personeel zijn uren niet kwijt.
 */
check('maar inklokken mag hij nog wel',
  magOpKassa(ingetrokken, kassaVest).ok)

const meldingGeenRecht = herkenFout({ ok: false, reden: 'geen-recht', naam: 'Ali Yildiz' } as any)
check('en de melding zegt dat klokken nog kan',
  meldingGeenRecht.includes('Alleen klokken'), meldingGeenRecht)
check('en waar het recht vandaan komt',
  meldingGeenRecht.includes('Rechten'), meldingGeenRecht)

/* ---- door de echte deur ---- */

const zonderRecht: User = {
  ...wasser, id: 'u_zonder', email: 'zonder@truckwash1group.nl',
  name: 'Rob Zonder', personnelNumber: 'TW-808',
  locationId: kassaVest, revokes: ['pos.use'],
}
await db.users.put(zonderRecht)

const pogingZonder = await herkenOpNummer('808', kassaVest, 'pos.use')
check('aanmelden aan de kassa lukt niet zonder pos.use',
  !pogingZonder.ok && pogingZonder.reden === 'geen-recht',
  JSON.stringify(pogingZonder))

const pogingKlok = await herkenOpNummer('808', kassaVest)
check('en inklokken lukt wel', pogingKlok.ok)

/* ---- en wat de server niet meer laat zien, gaat uit de cache ---- */

/*
 * Dit is het tweede gat. De echte push en pull worden onderschept, zodat
 * gemeten wordt wat verwijderWatWegIs doet en niet wat de server vindt.
 */
const echtIds = (deApi as any).zichtbareIds
const zetIds = (fn: any) => { (deApi as any).zichtbareIds = fn }

check('artikelen, personeel, voorraad en vestigingen worden opgeschoond',
  OPSCHONEN.includes('users') && OPSCHONEN.includes('products') &&
  OPSCHONEN.includes('inventory') && OPSCHONEN.includes('locations'))

/*
 * En de journaaltabellen juist niet. Die vallen na zestig dagen buiten de
 * horizon, dus opschonen zou betekenen dat de kassa zijn eigen bonnen wist.
 */
check('en bonnen, uren en kluisboekingen juist niet',
  !OPSCHONEN.includes('sales') && !OPSCHONEN.includes('timeEntries') &&
  !OPSCHONEN.includes('safeMoves') && !OPSCHONEN.includes('payments'))

await db.outbox.clear()
const ietsErbij: User = {
  ...wasser, id: 'u_ingetrokken', email: 'weg@truckwash1group.nl',
  name: 'Wim Weg', personnelNumber: 'TW-809', locationId: kassaVest,
}
await db.users.put(ietsErbij)
check('hij staat in de cache', Boolean(await db.users.get('u_ingetrokken')))

// De server laat hem niet meer zien; de anderen wel.
const blijvers = (await db.users.toArray())
  .map((u) => u.id).filter((id) => id !== 'u_ingetrokken')
zetIds(async (entiteit: string) => {
  if (entiteit === 'users') return blijvers
  return (await (db as any)[entiteit === 'inventory' ? 'inventory' : entiteit].toArray())
    .map((r: { id: string }) => r.id)
})

const opgeschoond = await verwijderWatWegIs()
check('en na een ronde is hij uit de cache', !(await db.users.get('u_ingetrokken')),
  `${opgeschoond} opgeruimd`)
check('en de rest staat er nog', Boolean(await db.users.get(wasser.id)))

const naOpschonen = await herkenOpNummer('809', kassaVest, 'pos.use')
check('en aanmelden lukt niet meer',
  !naOpschonen.ok && naOpschonen.reden === 'onbekend', JSON.stringify(naOpschonen))

/* ---- de rem: een lege lijst is verdacht, geen opdracht ---- */

/*
 * Zou de kassa op een leeg antwoord zijn cache leeggooien, dan maakt één
 * rechten- of sessieprobleem een kassa die offline moet kunnen werken volledig
 * onbruikbaar. Dat is erger dan een dossier dat een ronde te lang blijft staan.
 */
const voorLeeg = await db.users.count()
zetIds(async () => [])
await verwijderWatWegIs()
check('een leeg antwoord gooit de cache niet leeg',
  (await db.users.count()) === voorLeeg, String(await db.users.count()))

/* ---- en wat nog verstuurd moet worden, blijft staan ---- */

await db.users.put(ietsErbij)
await enqueue('users', 'put', 'u_ingetrokken', ietsErbij)
zetIds(async (entiteit: string) => (entiteit === 'users' ? blijvers : ['x']))
await verwijderWatWegIs()
check('een rij die nog in de wachtrij staat wordt niet opgeruimd',
  Boolean(await db.users.get('u_ingetrokken')))

zetIds(echtIds)
await db.users.delete('u_ingetrokken')
await db.users.delete('u_zonder')
await db.outbox.clear()
await useSync.getState().refreshPending()

/* ================================================================== */

/* ================================================================== *
 *  22. Een update installeert zichzelf aan de voorkant
 *
 *  Gemeld met: "nu moest iemand eerst inloggen, en dat moet niet."
 *
 *  Het installeren stond onder Beheer -> Versie, en Beheer zit achter een
 *  aanmelding. Een kassa waar niemand achter staat -- of waar degene die er
 *  staat geen beheerrecht heeft -- installeerde dus nooit iets. Op Windows was
 *  er nog een tweede weg (electron installeert bij het afsluiten), maar een
 *  kassa die maanden aanstaat sluit nooit af.
 *
 *  Wat hier gemeten wordt, is niet dat er een knop is. Het is de andere kant:
 *  dat een kassa die zichzelf herstart dat niet doet op een moment waarop
 *  iemand ernaar staat te kijken. Dat is de fout die dit had kunnen worden.
 * ================================================================== */

console.log('\n22. Een update installeert zichzelf aan de voorkant')

const vrij = {
  kanaal: 'windows' as const,
  stand: 'ready' as const,
  magInstalleren: true,
  bezet: false,
  mandje: false,
  verstuurt: false,
  stilMs: STIL_GENOEG_MS,
  uitgesteldTot: null,
  nu: 1_000_000,
}

check('een vrije kassa installeert zichzelf, zonder dat iemand inlogt',
  mogenWeInstalleren(vrij).nu)

/* ---- en alle vier de redenen om te wachten ---- */

const wacht = (naam: string, aanpassing: object, reden: string) => {
  const uit = mogenWeInstalleren({ ...vrij, ...aanpassing }) as any
  check(naam, uit.nu === false && uit.reden === reden, JSON.stringify(uit))
}

wacht('maar niet met iemand achter de kassa', { bezet: true }, 'bezet')
wacht('niet met iets in het mandje', { mandje: true }, 'mandje')
wacht('niet halverwege een verzending', { verstuurt: true }, 'verstuurt')
wacht('en niet als er net iemand op het scherm tikte',
  { stilMs: STIL_GENOEG_MS - 1 }, 'te-kort-stil')
wacht('en niet als er niets klaarstaat', { stand: 'available' }, 'niets-klaar')

/*
 * De stilte-eis is de belangrijkste van de vier, want de andere drie zijn
 * toestanden en deze is een moment. Iemand die zijn personeelsnummer intikt is
 * niet aangemeld, heeft niets in het mandje en synchroniseert niet -- en toch
 * mag de kassa dan niet onder zijn handen weg herstarten.
 */
check('en de aftelling loopt af zoals hij hoort',
  secondenTeGaan({ ...vrij, stilMs: STIL_GENOEG_MS - 5_000 }) === 5)
check('en telt niet meer als het moment er is',
  secondenTeGaan(vrij) === 0)
check('en telt niet als er iemand aan het werk is',
  secondenTeGaan({ ...vrij, bezet: true }) === null)

/* ---- uitstel ---- */

check('Straks houdt hem vier uur tegen',
  !mogenWeInstalleren({ ...vrij, uitgesteldTot: vrij.nu + UITSTEL_MS }).nu)
check('en daarna gaat het alsnog door',
  mogenWeInstalleren({ ...vrij, uitgesteldTot: vrij.nu - 1 }).nu)
check('en vier uur is één dienst', UITSTEL_MS === 4 * 60 * 60_000)

/* ---- Android doet het nooit vanzelf, en dat is met opzet ---- */

/*
 * Android zet altijd zijn eigen bevestiging voor een installatie, ook met de
 * toestemming aan. Zou de kassa daar vanzelf beginnen, dan staat er op een
 * onbeheerde tablet een systeemvenster over het aanmeldscherm -- en de eerste
 * die langskomt ziet niet zijn kassa maar een vraag van Android. Die drukt op
 * Annuleren.
 */
const tablet = { ...vrij, kanaal: 'mobile' as const }
wacht('een tablet begint er niet vanzelf aan', { kanaal: 'mobile' }, 'wacht-op-een-tik')
wacht('en zegt het eerlijk als Android het niet toestaat',
  { kanaal: 'mobile', magInstalleren: false }, 'geen-toestemming')

// De webversie heeft niets te installeren: die laadt de nieuwste bundel.
wacht('en de webversie herstart nergens voor', { kanaal: 'web' }, 'niets-klaar')

/* ---- wat er op het scherm komt ---- */

/*
 * "Zichtbaar maar niet hinderlijk" was de eis, en de scherpste vorm daarvan is
 * deze: een kassa die bij is, zegt niets. Zonder dat staat er permanent een
 * mededeling op het scherm dat een chauffeur over de balie heen ziet.
 */
check('een kassa die bij is zegt niets',
  updateBericht({ ...vrij, stand: 'up-to-date' }, null) === null)
check('en een kassa die aan het kijken is ook niet',
  updateBericht({ ...vrij, stand: 'checking' }, null) === null)

const opgehaald = updateBericht({ ...vrij, stand: 'downloading' }, '0.15.0')!
check('tijdens het ophalen staat er wat er gebeurt',
  opgehaald.tekst.includes('0.15.0') && opgehaald.tekst.includes('opgehaald'),
  opgehaald.tekst)
check('en geen knop, want er is nog niets te installeren',
  opgehaald.knop === null && !opgehaald.uitstellen)

const aftellen = updateBericht({ ...vrij, stilMs: 20_000 }, '0.15.0')!
check('bij het aftellen staan de seconden erbij',
  aftellen.tekst.includes('25 seconden'), aftellen.tekst)
check('en dat de kassa even herstart',
  aftellen.tekst.includes('herstart'), aftellen.tekst)
check('met een knop om het nu te doen en een om te wachten',
  aftellen.knop === 'installeren' && aftellen.uitstellen)

/*
 * En als er wél iemand aan het werk is: geen aftelling, want die zou onwaar
 * zijn -- er wordt niet geteld. Wel de knop, want wie klaar is mag het zelf
 * afmaken, en dat hoeft nog steeds zonder aanmelden.
 */
const bezig = updateBericht({ ...vrij, bezet: true }, '0.15.0')!
check('met iemand achter de kassa geen aftelling',
  !bezig.tekst.includes('seconde') && !bezig.uitstellen, bezig.tekst)
check('maar wel de knop, en die vraagt geen aanmelding',
  bezig.knop === 'installeren')
check('en er staat dat het vanzelf gaat zodra de kassa vrij is',
  bezig.tekst.includes('vrij is'), bezig.tekst)

const geenToestemming = updateBericht(
  { ...tablet, magInstalleren: false }, '0.15.0')!
check('zonder toestemming van Android wijst de knop naar de instelling',
  geenToestemming.knop === 'toestemming', JSON.stringify(geenToestemming))

/*
 * En zonder versienummer nog steeds een leesbare zin. newVersion kan null zijn
 * -- op Android komt het uit GitHub en op Windows uit electron, en beide kunnen
 * de stand op 'ready' zetten voordat het nummer binnen is. "Versie null staat
 * klaar" is precies het soort melding dat het vertrouwen kost.
 */
const zonderNummer = updateBericht({ ...tablet }, null)!
check('en zonder versienummer staat er geen null op het scherm',
  !zonderNummer.tekst.toLowerCase().includes('null')
  && zonderNummer.tekst.startsWith('Een nieuwe versie'), zonderNummer.tekst)

/* ================================================================== */

/* ================================================================== *
 *  23. Welke versie draait deze kassa?
 *
 *  Aanleiding: het dashboard kon niet zien op welke versie een kassa stond.
 *  De kolom app_version bestaat in pos_devices, de kassa mag hem van zijn
 *  eigen regel wijzigen -- en hij vulde hem nooit.
 *
 *  Twee oorzaken, en de eerste was de stille:
 *
 *    1. Bij het koppelen stuurde de kassa import.meta.env.VITE_APP_VERSION mee,
 *       en die variabele bestaat niet. Niet in .env, niet in de workflow,
 *       nergens. Dus stuurde hij een lege tekst, de serverfunctie sloeg netjes
 *       niets op, en in het dashboard stond bij alle apparaten niets. Geen
 *       foutmelding, alleen een kolom die altijd leeg is -- in de database van
 *       vandaag stond bij alle drie de apparaten een leeg veld.
 *
 *    2. apparaatGezien() hield alleen last_seen_at bij. Ook als de versie
 *       ondertussen veranderd was.
 *
 *  Waarom dit meer is dan een kolom vullen: de kassa werkt zichzelf bij (zie
 *  afdeling 22). "Hij doet het vanzelf" is een bewering tot je het kunt nakijken.
 * ================================================================== */

console.log('\n23. Welke versie draait deze kassa?')

/*
 * apparaatVersie() geeft in Node een lege tekst: het versienummer wordt tijdens
 * het bouwen ingebakken en Vite is hier niet langs geweest. Dat het niet
 * omvalt is wat hier telt -- een zelftest die struikelt over een ontbrekende
 * bouwconstante meet niets meer.
 */
check('de versie opvragen valt niet om zonder bouwstap',
  typeof koppelen.apparaatVersie() === 'string')

const teApparaat = 'dev_versietest'
const teRegister = register.id

await setMeta('apparaatId', teApparaat)
const apparaatRij = {
  id: teApparaat,
  registerId: teRegister,
  locationId: register.locationId,
  deviceKey: 'sleutel-versietest',
  name: 'Windows-kassa',
  platform: 'windows',
  status: 'actief' as const,
  pairedAt: Date.now() - 86_400_000,
  lastSeenAt: Date.now(),
  updatedAt: Date.now(),
}
await db.devices.put(apparaatRij)
await db.outbox.clear()

/*
 * De klok staat op "net gezien", dus zonder versieverandering hoort er niets te
 * gebeuren: één keer per uur is genoeg om te zien dat een kassa nog meedoet, en
 * elke ronde een rij in de wachtrij is zonde.
 */
await koppelen.apparaatGezien('0.15.0')
check('een nieuwe versie wacht het uur niet uit',
  (await db.devices.get(teApparaat))?.appVersion === '0.15.0',
  String((await db.devices.get(teApparaat))?.appVersion))
check('en gaat de wachtrij in, zodat het kantoor het ziet',
  (await db.outbox.toArray())
    .some((r) => r.entity === 'devices' && r.recordId === teApparaat))

/*
 * Dat het uur wordt overgeslagen bij een verandering is niet netjesheid maar
 * noodzaak: na een update herstart de kassa, en dan is dit de eerste ronde.
 * Zou hij dan afhaken op de klok, dan staat er tot een uur later een
 * versienummer in het dashboard dat niet meer klopt -- en dat is precies het
 * moment waarop iemand kijkt.
 */
await db.outbox.clear()
await koppelen.apparaatGezien('0.15.0')
check('maar dezelfde versie binnen het uur niet',
  (await db.outbox.count()) === 0, String(await db.outbox.count()))

// En na een uur wel, want dan gaat het weer om "hij doet nog mee".
await db.devices.put({
  ...(await db.devices.get(teApparaat))!,
  lastSeenAt: Date.now() - 2 * 60 * 60_000,
})
await koppelen.apparaatGezien('0.15.0')
check('na een uur meldt hij zich alsnog',
  (await db.outbox.count()) > 0)

/* ---- en zonder nummer van buiten geen onwaarheid ---- */

/*
 * Op Windows komt het nummer van electron en op Android uit de APK; die kunnen
 * bij een half gelukte update afwijken van de webbundel, en dan is het echte
 * nummer wat je wilt zien. Komt er niets mee, dan valt hij terug op de bundel
 * -- en in Node is die leeg. Dan hoort er geen lege tekst in de kolom te
 * belanden: leeg en "onbekend" zijn niet hetzelfde, en een lege tekst in een
 * kolom leest als "hij zei dat hij niets was".
 */
await db.outbox.clear()
await db.devices.put({ ...(await db.devices.get(teApparaat))!, appVersion: undefined })
await koppelen.apparaatGezien()
check('zonder nummer blijft het veld leeg in plaats van een lege tekst',
  (await db.devices.get(teApparaat))?.appVersion === undefined)

/* ---- en een ingetrokken kassa meldt niets meer ---- */

/*
 * Anders houdt een apparaat dat eruit gezet is zichzelf in het dashboard levend
 * -- en dan lijkt een intrekking niet gewerkt te hebben.
 */
await db.devices.put({ ...(await db.devices.get(teApparaat))!, status: 'ingetrokken' })
await db.outbox.clear()
await koppelen.apparaatGezien('0.15.0')
check('een ingetrokken kassa meldt zich niet meer',
  (await db.outbox.count()) === 0)

/* ---- wat de kassa van zijn eigen regel mag ---- */

/*
 * De database laat een apparaat van zijn eigen regel alleen bijhouden dat hij
 * er nog is; register_id, location_id, status, auth_user_id, profile_id en
 * device_key houdt een trigger tegen. app_version en platform mag hij wel
 * zetten -- nagekeken in de live database vóór dit gebouwd werd, want een
 * scherm dat invoer aanneemt die de server weigert, hoort die invoer niet aan
 * te nemen.
 *
 * Deze controle legt dat vast in code: verandert er ooit iets aan die lijst,
 * dan hoort dit mee te veranderen.
 */
const gestuurd = (await db.devices.get(teApparaat))!
check('en hij verandert niets aan zijn eigen plek of status',
  gestuurd.registerId === teRegister
  && gestuurd.locationId === register.locationId
  && gestuurd.deviceKey === 'sleutel-versietest')

await db.devices.delete(teApparaat)
await setMeta('apparaatId', null)
await db.outbox.clear()
await useSync.getState().refreshPending()

/* ================================================================== */

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


/* ================================================================== *
 *  25. Komt een blokkade wel aan?
 *
 *  Gemeld met: "ik kan nog doorgaan? enkel als ik de gehele app restart gooit
 *  hij me er pas uit."
 *
 *  Het scherm hangt aan de apparaatregel in de cache, en die hoort bij elke
 *  ronde bijgewerkt te worden. Dat scherm is er, de regel wordt opgehaald, en
 *  toch gebeurde er niets. Dus meten we de weg zelf: van een ronde naar wat er
 *  daarna in de cache staat.
 *
 *  Drie stappen, en de laatste twee zijn waar het misging.
 * ================================================================== */

console.log('\n25. Komt een blokkade wel aan?')

const echtePull = (deApi as any).pull
const zetPull = (fn: any) => { (deApi as any).pull = fn }
const echtePing = (deApi as any).ping

const apparaatId = 'dev_blok'

async function apparaatInCache(status: string) {
  await db.devices.clear()
  await db.devices.put({
    id: apparaatId, registerId: register.id, locationId: register.locationId,
    deviceKey: 'sleutel-blok', name: 'Windows-kassa', platform: 'windows',
    status, pairedAt: Date.now() - 86_400_000,
    lastSeenAt: Date.now(), updatedAt: Date.now(),
  } as any)
  await setMeta('apparaatId', apparaatId)
}

/** Eén ronde, met een server die zegt dat dit apparaat geblokkeerd is. */
function serverZegtGeblokkeerd() {
  zetPull(async () => ({
    serverTime: Date.now(),
    changes: {
      devices: [{
        id: apparaatId, registerId: register.id, locationId: register.locationId,
        deviceKey: 'sleutel-blok', name: 'Windows-kassa', platform: 'windows',
        status: 'geblokkeerd', pairedAt: Date.now() - 86_400_000,
        lastSeenAt: Date.now(), updatedAt: Date.now(),
      }],
    },
  }))
}

/* ---- 1. de gewone weg ---- */

await apparaatInCache('actief')
await db.outbox.clear()
serverZegtGeblokkeerd()
zetPush(async () => {})
;(deApi as any).ping = async () => true
setSyncEnabled(true)

await useSync.getState().sync({ silent: true })
check('een ronde zet de blokkade in de cache',
  (await koppelen.huidigApparaat())?.status === 'geblokkeerd',
  String((await koppelen.huidigApparaat())?.status))

/* ---- 2. met een rij die blijft weigeren ---- */

/*
 * En dit is de fout waar het om ging.
 *
 * sync() deed eerst versturen en dan ophalen, in een enkele try. Ging het
 * versturen mis, dan kwam het ophalen niet meer aan de beurt -- en dan kwam er
 * niets meer binnen. Geen blokkade, geen intrekking, geen nieuwe prijzen, geen
 * personeel dat eruit is.
 *
 * En dat is geen zeldzaam geval. Een geblokkeerde kassa stuurt zijn hartslag
 * met status "actief", de database weigert dat (een apparaat mag zijn eigen
 * status niet zetten), en zo'n weigering laat de rij met opzet in de wachtrij
 * staan. Een vastgelopen rij bevroor daarmee alles wat binnen moest komen --
 * de blokkade zelf incluis. Vandaar dat de kassa gewoon doorging.
 *
 * Twee dingen zitten hier in een controle, en dat is met opzet: het is ook een
 * situatie. De rij staat nog in de wachtrij (dus de rem "lokaal is nieuwer"
 * mag hem niet tegenhouden) en het versturen weigert (dus het ophalen mag er
 * niet aan hangen).
 */
await apparaatInCache('actief')
await db.outbox.clear()
await enqueue('devices', 'put', apparaatId, { id: apparaatId, status: 'actief' })
serverZegtGeblokkeerd()
zetPush(async () => {
  throw new foutsoorten.GeenRechten('pos_devices', 'een kassa mag zijn eigen status niet zetten')
})

await useSync.getState().sync({ silent: true })
check('een geweigerde rij houdt de blokkade niet meer tegen',
  (await koppelen.huidigApparaat())?.status === 'geblokkeerd',
  String((await koppelen.huidigApparaat())?.status))

/*
 * En de fout van het versturen is niet verdwenen. Zou die stil wegvallen, dan
 * ruilen we een kassa die niets meer ophaalt in voor een kassa die niet meer
 * verstuurt zonder dat iemand het ziet -- en dat tweede is erger, want daar
 * hangt omzet aan.
 */
check('en de fout van het versturen staat er nog',
  (useSync.getState().lastError ?? '').length > 0,
  String(useSync.getState().lastError))
check('terwijl de ronde wel is doorgelopen',
  useSync.getState().lastSyncAt !== null)

/*
 * En de rij zelf is niet weggegooid. Dat hoort ook zo: een weigering op de
 * rechten zegt niets over dat record, en een kassa die zijn wachtrij weggooit
 * omdat de server iets anders weigerde, gooit omzet weg.
 */
check('en de geweigerde rij staat er nog', (await db.outbox.count()) > 0)

/* ---- en waarom die weigering er ueberhaupt was ---- */

/*
 * De kassa stuurde bij het bijwerken de hele rij mee, status inbegrepen.
 * Zolang de waarden gelijk waren viel dat niet op -- gelijk is niet "distinct
 * from", dus geen fout. Maar zodra het kantoor blokkeerde, verschilde de
 * status en werd elke hartslag geweigerd.
 *
 * Een scherm dat invoer aanneemt die de server weigert, hoort die invoer niet
 * aan te nemen. Dat geldt net zo goed voor wat de kassa achter de schermen
 * verstuurt. Deze lijst moet gelijk blijven met de triggers in de database, en
 * dat is precies het soort afspraak dat stil uit elkaar loopt -- vandaar dat
 * hij hier nagelopen wordt.
 */
const heleRij = {
  id: apparaatId, register_id: register.id, location_id: 'loc_anders',
  device_key: 'andere-sleutel', status: 'actief', auth_user_id: 'auth_x',
  profile_id: 'u_x', last_seen_at: 1234, app_version: '0.18.0',
  name: 'Windows-kassa', platform: 'windows', updated_at: 99,
}
const magSturen = eigenVelden('devices', heleRij) as Record<string, unknown>

for (const verboden of
  ['id', 'register_id', 'location_id', 'device_key', 'status', 'auth_user_id', 'profile_id']) {
  check('een kassa stuurt geen ' + verboden + ' mee', !(verboden in magSturen))
}
check('maar wel dat hij er nog is, en op welke versie',
  magSturen.last_seen_at === 1234 && magSturen.app_version === '0.18.0',
  JSON.stringify(magSturen))

/*
 * En updated_at gaat niet mee, ook al staat het in de rij. Dat zet de server
 * zelf -- een kassa met een verkeerd gezette klok zou anders rijen kunnen
 * neerzetten die in de toekomst liggen, en die komen bij niemand meer langs.
 */
check('en de klok van de kassa gaat niet mee',
  !('updated_at' in magSturen))

/*
 * En bij de kassa-regel dezelfde regel: de printer en de pinautomaat mag hij
 * zetten, zijn code en zijn vestiging niet.
 */
const kassaRij = eigenVelden('registers', {
  id: register.id, code: 'KAS-X', name: 'Anders', location_id: 'loc_anders',
  active: false, printer: { kind: 'geen' }, last_seq: 7, updated_at: 5,
}) as Record<string, unknown>
check('en van zijn kassa-regel alleen de randapparatuur',
  !('code' in kassaRij) && !('location_id' in kassaRij) && !('active' in kassaRij)
  && kassaRij.last_seq === 7 && Boolean(kassaRij.printer),
  JSON.stringify(kassaRij))

/* ---- en een intrekking komt langs dezelfde weg ---- */

zetPull(async () => ({
  serverTime: Date.now(),
  changes: {
    devices: [{
      id: apparaatId, registerId: register.id, locationId: register.locationId,
      deviceKey: 'sleutel-blok', name: 'Windows-kassa', platform: 'windows',
      status: 'ingetrokken', pairedAt: Date.now() - 86_400_000,
      lastSeenAt: Date.now(), updatedAt: Date.now(),
    }],
  },
}))
await useSync.getState().sync({ silent: true })
check('een intrekking komt er net zo goed door',
  (await koppelen.huidigApparaat())?.status === 'ingetrokken',
  String((await koppelen.huidigApparaat())?.status))

/* ---- en het scherm moet die wijziging ook te zien krijgen ----
 *
 * De controle hierboven leest de regel achteraf opnieuw uit, en die slaagt
 * ook als het scherm nooit iets merkt. Dat is precies wat er misging: een
 * ingetrokken kassa bleef gewoon verkopen omdat App.tsx een niet-async
 * pijlfunctie aan useLiveQuery gaf. Dexie tilt zijn observatiezone alleen
 * over een await heen als de querier zelf async is; huidigApparaat() leest
 * eerst db.meta en pas daarna db.devices, en die tweede lezing viel dus
 * buiten de bewaking. De rij veranderde, het scherm keek er nooit meer naar.
 *
 * Daarom abonneren we hier echt, zoals het scherm dat doet.
 */
const gezien: (string | undefined)[] = []
const abo = liveQuery(koppelen.huidigApparaat).subscribe(
  (v) => gezien.push(v?.status))
await new Promise((r) => setTimeout(r, 60))
await db.devices.bulkPut([{
  ...(await koppelen.huidigApparaat())!, status: 'actief', updatedAt: Date.now(),
}])
await new Promise((r) => setTimeout(r, 150))
abo.unsubscribe()
check('een gewijzigde apparaatregel bereikt het scherm',
  gezien.length > 1, JSON.stringify(gezien))

/*
 * En de vorm zelf, want de controle hierboven abonneert met de goede vorm en
 * zou ook slagen als een scherm de kapotte vorm terugzet. Deze helpers lezen
 * twee tabellen achter elkaar; wie ze in een niet-async pijl aan useLiveQuery
 * geeft, krijgt een abonnement dat de tweede tabel niet bewaakt.
 */
const KETENENDE_HELPERS = ['huidigApparaat', 'huidigeRegister', 'bonMetAlles', 'aanwezig']
const schermen = [
  'src/App.tsx', 'src/components/OpSlot.tsx',
  'src/screens/Bonnen.tsx', 'src/screens/Klok.tsx',
]
const kapot: string[] = []
for (const bestand of schermen) {
  const tekst = readFileSync(new URL('../' + bestand, import.meta.url), 'utf8')
  for (const helper of KETENENDE_HELPERS) {
    // De fout is de pijl zonder async: useLiveQuery(() => helper(...))
    if (tekst.includes('useLiveQuery(() => ' + helper)) kapot.push(bestand + ' -> ' + helper)
  }
}
check('geen scherm geeft een ketenende helper in een niet-async pijl mee',
  kapot.length === 0, kapot.join(', '))

zetPush(echtePush)
zetPull(echtePull)
;(deApi as any).ping = echtePing
setSyncEnabled(false)
await db.devices.clear()
await db.outbox.clear()
await setMeta('apparaatId', null)
await useSync.getState().refreshPending()

/* ================================================================== */


/* ================================================================== *
 *  24. Eruit gegooid is ook echt eruit
 *
 *  Gemeld met: "als ik een kassa eruit gooi, dan moet die kassa zichzelf
 *  volledig uitloggen."
 *
 *  Dat deed hij niet. Het scherm riep apparaatWissen() aan, en dat maakte
 *  alleen de lokale gegevens leeg. Wat bleef staan:
 *
 *    - de sessie bij Supabase, dus een geldige inlog op het account van die
 *      kassa, op een apparaat dat eruit gegooid was;
 *    - de bewaarde inloggegevens, waarmee hij zich bij de volgende start
 *      opnieuw zou aanmelden;
 *    - het apparaat in het geheugen van de store, dus het scherm bleef denken
 *      dat hij gekoppeld was;
 *    - de synchronisatie, die met dat account bleef draaien -- en dus gegevens
 *      terughaalde in een cache die net gewist was.
 *
 *  Nu loopt het via ontkoppel() van de store, dezelfde weg als de knop aan de
 *  balie. Eén deur die het hele werk doet; twee deuren waarvan er één de helft
 *  deed, is hoe dit is ontstaan.
 *
 *  Deze afdeling staat achteraan, net als 15: hij maakt de kassa leeg.
 * ================================================================== */

console.log('\n24. Eruit gegooid is ook echt eruit')

const { useAuth } = await import('../src/store/useAuth')

/*
 * Een gekoppelde kassa nabouwen: een apparaatregel, een sessie in de opslag,
 * en de synchronisatie aan. Dat is precies de stand waarin een intrekking
 * binnenkomt.
 */
async function zetKassaNeer(status: 'actief' | 'ingetrokken') {
  await db.devices.clear()
  await db.outbox.clear()
  await db.devices.put({
    id: 'dev_slot', registerId: register.id, locationId: register.locationId,
    deviceKey: 'sleutel-slot', name: 'Windows-kassa', platform: 'windows',
    appVersion: '0.16.0', status,
    pairedAt: Date.now() - 86_400_000, lastSeenAt: Date.now(), updatedAt: Date.now(),
  })
  await setMeta('apparaatId', 'dev_slot')
  await db.registers.put(register)
  await setMeta('registerId', register.id)
  localStorage.setItem('kassa.sessie', JSON.stringify({ userId: baas.id }))
  await db.users.put(baas)
  setSyncEnabled(true)
  useAuth.setState({ apparaat: baas, operator: baas })
}

/* ---- eerst de rem: met werk in de wachtrij gaat er niets weg ---- */

/*
 * Dit is de belangrijkste controle van de twee. Een kassa die zich uitlogt met
 * een bon in de wachtrij gooit omzet weg die nergens anders bestaat -- niet in
 * de kassa en niet in de administratie. "Volledig uitloggen" mag nooit
 * betekenen "en de rest ook".
 */
await zetKassaNeer('ingetrokken')
await enqueue('sales', 'put', 'bon_slot', { id: 'bon_slot', total: 42 })

const remErop = await useAuth.getState().ontkoppel({ melden: true })
check('met een bon in de wachtrij logt hij zich niet uit',
  !remErop.ok, JSON.stringify(remErop))
check('en de bon staat er nog', (await db.outbox.count()) > 0)
check('en de sessie ook', localStorage.getItem('kassa.sessie') !== null)
check('en hij blijft versturen, want die bon moet eruit', syncStaatAan())
check('en het apparaat is nog gekoppeld', useAuth.getState().apparaat !== null)

/* ---- en dan met een lege wachtrij: alles eruit ---- */

await db.outbox.clear()
await useSync.getState().refreshPending()

const eruit = await useAuth.getState().ontkoppel({ melden: true })
check('met een lege wachtrij gaat hij er wel uit', eruit.ok, JSON.stringify(eruit))

// De vier dingen die bleven staan, elk apart.
check('de sessie is weg', localStorage.getItem('kassa.sessie') === null)
check('het apparaat is uit het geheugen', useAuth.getState().apparaat === null)
check('en de medewerker ook', useAuth.getState().operator === null)
check('de synchronisatie staat uit', !syncStaatAan())

// En de gegevens zelf, want een uitgelogde kassa met de artikelen en het
// personeel van een vestiging er nog op is geen uitgelogde kassa.
check('het apparaat staat niet meer in de cache',
  (await db.devices.count()) === 0)
check('en de vestiging is losgelaten',
  (await getMeta('apparaatId', null)) === null
  && (await getMeta('registerId', null)) === null)
check('en het personeel is eruit', (await db.users.count()) === 0)
check('en de artikelen', (await db.products.count()) === 0)

/*
 * En de bewaarde inlog, want dat is de sluipweg: die staat er zodat een kassa
 * na een opgeschoonde opslag zichzelf weer aanmeldt in plaats van om een nieuwe
 * code te vragen. Blijft hij staan na een intrekking, dan meldt het apparaat
 * zich bij de volgende start gewoon opnieuw aan -- en dan heeft het uitloggen
 * niets uitgehaald.
 */
check('en de bewaarde inlog is weg',
  (await koppelen.bewaardeInlog()) === null)

/* ================================================================== */

await db.close()

console.log(`\n${passed} geslaagd, ${failed} mislukt\n`)
process.exit(failed === 0 ? 0 : 1)
