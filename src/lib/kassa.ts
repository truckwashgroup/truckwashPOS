import { db, getMeta, setMeta, uid } from './db'
import { enqueue } from './sync'
import { afboeken, kaartVerkopen, terugboeken } from './kaarten'
import { bonTotalen, centen, betaalwijze, regelTotaal, splits } from './geld'
import type {
  DeelBetaling, InventoryItem, MandjeRegel, PosPayment, PosRegister, PosSale,
  PosSaleLine, StockMovement, User, WashJob,
} from './types'

/* ------------------------------------------------------------------ *
 *  Afrekenen
 *
 *  Alles wat hier gebeurt is lokaal en klaar voordat het netwerk erbij komt.
 *  De bon is afgerekend, het bonnummer staat vast, de bon kan naar de printer
 *  en de lade mag open -- of er verbinding is of niet. Wat naar de server moet
 *  gaat via de outbox.
 *
 *  Wat een bon afrekenen allemaal in beweging zet:
 *
 *   * de bon zelf, met zijn regels en betalingen
 *   * een wasopdracht in de wasstraat-app, als er een wasbeurt op staat
 *   * een voorraadmutatie, voor artikelen die aan de voorraad hangen
 *   * een strippenkaart of abonnement, als dat verkocht of gebruikt is
 *
 *  Dat gebeurt in één keer of niet. Valt de kassa er middenin uit, dan staat
 *  er een bon zonder regels -- en dat is de reden dat de bon als laatste
 *  wordt weggeschreven en niet als eerste.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 *  Welke kassa is dit?
 * ------------------------------------------------------------------ */

const REGISTER_KEY = 'registerId'
const APPARAAT_KEY = 'apparaatId'

/** Een blijvend kenmerk van dit apparaat, zodat twee kassa's opvallen. */
export async function apparaatId(): Promise<string> {
  let id = await getMeta<string | null>(APPARAAT_KEY, null)
  if (!id) {
    id = uid('app')
    await setMeta(APPARAAT_KEY, id)
  }
  return id
}

export async function huidigeRegister(): Promise<PosRegister | null> {
  const id = await getMeta<string | null>(REGISTER_KEY, null)
  if (!id) return null
  return (await db.registers.get(id)) ?? null
}

/**
 * Deze kassa aan een register koppelen.
 *
 * Het bonnummer begint met de code van het register en loopt op dit apparaat
 * door. Twee apparaten op hetzelfde register zouden dus dezelfde bonnummers
 * uitdelen, en de database weigert de tweede -- die omzet blijft dan in de
 * wachtrij hangen. Vandaar dat we het apparaat vastleggen en hardop
 * waarschuwen als er al een ander op staat.
 */
export async function kiesRegister(registerId: string): Promise<{ waarschuwing?: string }> {
  const register = await db.registers.get(registerId)
  if (!register) throw new Error('Die kassa staat niet in de lijst.')

  const dit = await apparaatId()
  let waarschuwing: string | undefined

  if (register.device && register.device !== dit) {
    waarschuwing =
      `Kassa ${register.code} stond op een ander apparaat. Draaien er twee ` +
      'tegelijk op dezelfde kassa, dan krijgen bonnen hetzelfde nummer en ' +
      'blijft de tweede in de wachtrij staan. Geef het tweede apparaat een ' +
      'eigen kassa.'
  }

  await setMeta(REGISTER_KEY, registerId)
  await bewaarRegister({ ...register, device: dit })
  return { waarschuwing }
}

export async function bewaarRegister(register: PosRegister): Promise<PosRegister> {
  const rij = { ...register, updatedAt: Date.now() }
  await db.registers.put(rij)
  await enqueue('registers', 'put', rij.id, rij)
  return rij
}

/* ------------------------------------------------------------------ *
 *  Bonnummers
 * ------------------------------------------------------------------ */

const seqKey = (code: string) => `bonnummer:${code}`

const twee = (n: number) => String(n).padStart(2, '0')

/**
 * Het volgende bonnummer voor deze kassa.
 *
 * De teller staat op het apparaat, zodat hij ook zonder internet doorloopt.
 * `lastSeq` van de server doet mee als bovengrens: is de kassa opnieuw
 * ingericht, dan begint hij niet weer bij één -- dan zou hij nummers uitdelen
 * die al bestaan.
 */
export async function volgendBonnummer(register: PosRegister): Promise<{
  seq: number
  receiptNo: string
}> {
  const lokaal = await getMeta<number>(seqKey(register.code), 0)
  const seq = Math.max(lokaal, register.lastSeq ?? 0) + 1
  await setMeta(seqKey(register.code), seq)

  const d = new Date()
  const datum = `${d.getFullYear()}${twee(d.getMonth() + 1)}${twee(d.getDate())}`
  return { seq, receiptNo: `${register.code}-${datum}-${String(seq).padStart(4, '0')}` }
}

/* ------------------------------------------------------------------ *
 *  Regels wegschrijven
 * ------------------------------------------------------------------ */

function naarBonregel(saleId: string, regel: MandjeRegel, nummer: number): PosSaleLine {
  const totaal = regelTotaal(regel)
  const deel = splits(totaal, regel.vatPct)
  return {
    id: uid('regel'),
    saleId,
    lineNo: nummer,
    productId: regel.productId,
    name: regel.name,
    kind: regel.kind,
    qty: regel.qty,
    priceIncl: regel.priceIncl,
    vatPct: regel.vatPct,
    discountPct: regel.discountPct,
    totalIncl: deel.incl,
    totalExcl: deel.excl,
    vatAmount: deel.btw,
    washJobId: regel.washJobId,
    note: regel.note,
    updatedAt: Date.now(),
  }
}

/* ------------------------------------------------------------------ *
 *  Voorraad
 * ------------------------------------------------------------------ */

/**
 * Boekt het verbruik af, net zoals de wasstraat-app dat doet: een mutatie in
 * stock_movements plus de nieuwe stand op het artikel.
 *
 * De mutaties zijn de waarheid; de stand is de optelsom die iedereen leest.
 * Twee kassa's die tegelijk hetzelfde artikel afboeken kunnen elkaars stand
 * overschrijven -- de mutaties blijven dan wel staan, dus het is te herstellen
 * door opnieuw te tellen. Dat is dezelfde afweging die het dashboard maakt.
 */
async function voorraadAf(
  regels: MandjeRegel[],
  door: Pick<User, 'id' | 'name'>,
  bonnummer: string,
  locationId?: string,
) {
  for (const regel of regels) {
    if (!regel.inventoryItemId || regel.qty <= 0) continue
    const item = await db.inventory.get(regel.inventoryItemId)
    if (!item) continue

    const mutatie: StockMovement = {
      id: uid('sm'),
      locationId: locationId ?? item.locationId,
      itemId: item.id,
      itemName: item.name,
      qty: -regel.qty,
      reason: `Verkocht aan de kassa (${bonnummer})`,
      userId: door.id,
      userName: door.name,
      at: Date.now(),
    }
    await db.stockMovements.put(mutatie)
    await enqueue('stockMovements', 'put', mutatie.id, mutatie)

    const nieuw: InventoryItem = {
      ...item,
      stock: centen(item.stock - regel.qty),
      updatedAt: Date.now(),
    }
    await db.inventory.put(nieuw)
    await enqueue('inventory', 'put', nieuw.id, nieuw)
  }
}

/* ------------------------------------------------------------------ *
 *  De koppeling met de wasstraat
 * ------------------------------------------------------------------ */

/**
 * Zet een verkochte wasbeurt in de wachtrij van de wasstraat.
 *
 * Zo hoeft de balie niets door te bellen: de wasser ziet de opdracht in zijn
 * eigen app staan, met kenteken en soort wasbeurt.
 *
 * Wat hier in de weg zit: een wasopdracht hoort in de database bij een klant,
 * en dat veld mag niet leeg zijn. Bij een losse chauffeur die contant betaalt
 * is er geen klant. Daarvoor is de instelling "klant voor losse ritten" -- één
 * bedrijf waar alle losse wasbeurten onder vallen. Is die niet gezet, dan
 * verkoopt de kassa de wasbeurt gewoon, maar komt hij niet in de wachtrij; de
 * bon is dan het bewijs.
 */
const LOSSE_KLANT_KEY = 'losseKlantId'

export const losseKlant = {
  get: () => getMeta<string | null>(LOSSE_KLANT_KEY, null),
  set: (companyId: string | null) => setMeta(LOSSE_KLANT_KEY, companyId),
}

async function wasopdrachtenAanmaken(opts: {
  regels: MandjeRegel[]
  bon: PosSale
  door: Pick<User, 'id' | 'name'>
}): Promise<{ aangemaakt: WashJob[]; nietIngepland: number }> {
  const aangemaakt: WashJob[] = []
  let nietIngepland = 0

  const losse = await losseKlant.get()

  for (const regel of opts.regels) {
    if (regel.kind !== 'wasbeurt' || !regel.washService) continue

    // Rekende de bon een bestaande opdracht af? Dan is die al ingepland en
    // zetten we hem hieronder alleen op gereed.
    if (regel.washJobId) continue

    const companyId = opts.bon.customerCompanyId ?? losse ?? null
    if (!companyId) {
      nietIngepland++
      continue
    }

    const bedrijf = await db.companies.get(companyId)

    for (let i = 0; i < Math.max(1, Math.round(regel.qty)); i++) {
      const deel = splits(regel.priceIncl, regel.vatPct)
      const job: WashJob = {
        id: uid('job'),
        ticket: opts.bon.receiptNo,
        locationId: opts.bon.locationId ?? '',
        companyId,
        companyName: bedrijf?.name ?? opts.bon.customerName ?? 'Losse rit',
        plate: (opts.bon.plate ?? '').toUpperCase(),
        service: regel.washService,
        // Aan de kassa betaald betekent: de vrachtwagen staat er nu.
        status: 'wachtrij',
        scheduledAt: Date.now(),
        priceExcl: deel.excl,
        notes: `Aan de kassa verkocht en betaald — bon ${opts.bon.receiptNo}`,
        createdBy: opts.door.id,
        updatedAt: Date.now(),
      }
      await db.washJobs.put(job)
      await enqueue('washJobs', 'put', job.id, job)
      aangemaakt.push(job)
    }
  }

  return { aangemaakt, nietIngepland }
}

/** Een bestaande wasopdracht als betaald en gereed afmelden. */
async function wasopdrachtAfmelden(washJobId: string) {
  const job = await db.washJobs.get(washJobId)
  if (!job) return
  const rij: WashJob = {
    ...job,
    status: 'gereed',
    completedAt: job.completedAt ?? Date.now(),
    updatedAt: Date.now(),
  }
  await db.washJobs.put(rij)
  await enqueue('washJobs', 'put', rij.id, rij)
}

/* ------------------------------------------------------------------ *
 *  Afrekenen
 * ------------------------------------------------------------------ */

export interface AfrekenOpties {
  register: PosRegister
  /** Wie er achter de kassa staat -- niet het account van het apparaat. */
  door: User
  regels: MandjeRegel[]
  betalingen: DeelBetaling[]
  klant?: { companyId?: string; name?: string }
  plate?: string
  /** Contante afronding, uit afrondenContant(). */
  afronding?: number
  cashSessionId?: string
  note?: string
  /** Een geparkeerde bon die nu wordt afgerekend. */
  hervatId?: string
}

export interface AfgerekendeBon {
  bon: PosSale
  regels: PosSaleLine[]
  betalingen: PosPayment[]
  /** Wasopdrachten die de kassa in de wasstraat heeft gezet. */
  wasopdrachten: WashJob[]
  /** Wasbeurten die niet ingepland konden worden (geen klant bekend). */
  nietIngepland: number
  /** Kaarten die net verkocht zijn, met hun code erop. */
  kaarten: { code: string; kind: string; credits: number }[]
}

export async function afrekenen(opts: AfrekenOpties): Promise<AfgerekendeBon> {
  if (!opts.regels.length) throw new Error('Er staat niets op de bon.')

  const totalen = bonTotalen(opts.regels)
  const nu = Date.now()
  const { seq, receiptNo } = await volgendBonnummer(opts.register)

  const bon: PosSale = {
    id: opts.hervatId ?? uid('bon'),
    registerId: opts.register.id,
    registerCode: opts.register.code,
    locationId: opts.register.locationId,
    receiptNo,
    seq,
    status: 'afgerekend',
    operatorId: opts.door.id,
    operatorName: opts.door.name,
    customerCompanyId: opts.klant?.companyId,
    customerName: opts.klant?.name,
    plate: opts.plate?.toUpperCase(),
    // Rekent deze bon precies één bestaande wasopdracht af, dan hangt hij
    // eraan. Bij meerdere staat de verwijzing op de regels.
    washJobId: opts.regels.filter((r) => r.washJobId).length === 1
      ? opts.regels.find((r) => r.washJobId)?.washJobId
      : undefined,
    totalIncl: totalen.incl,
    totalExcl: totalen.excl,
    vatTotal: totalen.btw,
    discountIncl: totalen.korting,
    rounding: opts.afronding ?? 0,
    method: betaalwijze(opts.betalingen),
    cashSessionId: opts.cashSessionId,
    openedAt: nu,
    closedAt: nu,
    printed: false,
    note: opts.note,
    updatedAt: nu,
  }

  const regels = opts.regels.map((r, i) => naarBonregel(bon.id, r, i + 1))

  /*
   * Betalingen van nul euro slaan we niet op -- behalve die met een kaart.
   * Een kaartbetaling is juist nul: de wasbeurt is al betaald toen de kaart
   * werd verkocht. Op de bon hoort wel te staan dat er met kaart X is betaald,
   * anders is niet terug te vinden waar die strip heen ging.
   */
  const betalingen: PosPayment[] = opts.betalingen
    .filter((b) => b.amount !== 0 || b.method === 'abonnement')
    .map((b) => ({
      id: uid('bet'),
      saleId: bon.id,
      method: b.method,
      amount: centen(b.amount),
      received: b.received,
      changeGiven: b.changeGiven,
      terminalRef: b.terminalRef,
      terminalStatus: b.terminalStatus,
      cardBrand: b.cardBrand,
      subscriptionId: b.subscriptionId,
      at: nu,
      updatedAt: nu,
    }))

  /*
   * Lokaal opslaan gaat in één transactie: een bon zonder regels is erger
   * dan geen bon. Naar de server gaat het daarna via de outbox, en dáár
   * bepaalt PUSH_ORDER de volgorde -- de bon voor zijn regels.
   */
  await db.transaction('rw', db.sales, db.saleLines, db.payments, async () => {
    await db.sales.put(bon)
    await db.saleLines.bulkPut(regels)
    await db.payments.bulkPut(betalingen)
  })

  await enqueue('sales', 'put', bon.id, bon)
  for (const r of regels) await enqueue('saleLines', 'put', r.id, r)
  for (const b of betalingen) await enqueue('payments', 'put', b.id, b)

  /* ---- de gevolgen ---- */

  const { aangemaakt, nietIngepland } = await wasopdrachtenAanmaken({
    regels: opts.regels, bon, door: opts.door,
  })

  for (const regel of opts.regels) {
    if (regel.washJobId) await wasopdrachtAfmelden(regel.washJobId)
  }

  await voorraadAf(opts.regels, opts.door, bon.receiptNo, bon.locationId)

  // Verkochte kaarten aanmaken.
  const kaarten: AfgerekendeBon['kaarten'] = []
  for (const regel of opts.regels) {
    if (regel.kind !== 'strippenkaart' && regel.kind !== 'abonnement') continue
    for (let i = 0; i < Math.max(1, Math.round(regel.qty)); i++) {
      const kaart = await kaartVerkopen({
        saleId: bon.id,
        locationId: bon.locationId,
        companyId: bon.customerCompanyId,
        customerName: bon.customerName,
        plate: bon.plate,
        kind: regel.kind,
        credits: regel.credits,
        validDays: regel.validDays,
        washService: regel.washService,
      })
      kaarten.push({
        code: kaart.code,
        kind: kaart.kind,
        credits: kaart.creditsTotal,
      })
    }
  }

  // Met een kaart betaald? Dan gaat er een strip af.
  for (const betaling of opts.betalingen) {
    if (betaling.method === 'abonnement' && betaling.subscriptionId) {
      await afboeken({
        subscriptionId: betaling.subscriptionId,
        saleId: bon.id,
        credits: opts.regels
          .filter((r) => r.kind === 'wasbeurt')
          .reduce((n, r) => n + Math.max(1, Math.round(r.qty)), 0) || 1,
        door: opts.door,
      })
    }
  }

  return { bon, regels, betalingen, wasopdrachten: aangemaakt, nietIngepland, kaarten }
}

/** Onthouden dat de bon uit de printer kwam. */
export async function bonAfgedrukt(saleId: string) {
  const bon = await db.sales.get(saleId)
  if (!bon || bon.printed) return
  const rij = { ...bon, printed: true, updatedAt: Date.now() }
  await db.sales.put(rij)
  await enqueue('sales', 'put', rij.id, rij)
}

/* ------------------------------------------------------------------ *
 *  Crediteren
 *
 *  Een afgerekende bon wordt niet gewijzigd en niet verwijderd -- de database
 *  weigert dat ook. Terugdraaien gebeurt met een tweede bon met negatieve
 *  bedragen, die naar de eerste verwijst. Zo blijft te zien wat er gebeurd is
 *  en niet alleen wat er overbleef.
 * ------------------------------------------------------------------ */

export async function crediteren(opts: {
  saleId: string
  register: PosRegister
  door: User
  reden: string
  /** Welke regels terug; leeg = de hele bon. */
  regelIds?: string[]
  cashSessionId?: string
}): Promise<AfgerekendeBon> {
  const origineel = await db.sales.get(opts.saleId)
  if (!origineel) throw new Error('Die bon staat niet in de kassa.')
  if (origineel.status === 'gecrediteerd') {
    throw new Error(`Bon ${origineel.receiptNo} is al gecrediteerd.`)
  }
  if (origineel.status !== 'afgerekend') {
    throw new Error('Alleen een afgerekende bon kan gecrediteerd worden.')
  }

  const alleRegels = await db.saleLines.where('saleId').equals(opts.saleId).toArray()
  const terug = opts.regelIds?.length
    ? alleRegels.filter((r) => opts.regelIds!.includes(r.id))
    : alleRegels
  if (!terug.length) throw new Error('Er is niets aangewezen om terug te nemen.')

  const nu = Date.now()
  const { seq, receiptNo } = await volgendBonnummer(opts.register)

  const negatief = terug.map((r) => centen(-r.totalIncl))
  const totaalIncl = negatief.reduce((s, n) => centen(s + n), 0)
  const totaalBtw = terug.reduce((s, r) => centen(s - r.vatAmount), 0)

  const bon: PosSale = {
    id: uid('bon'),
    registerId: opts.register.id,
    registerCode: opts.register.code,
    locationId: origineel.locationId,
    receiptNo,
    seq,
    status: 'afgerekend',
    operatorId: opts.door.id,
    operatorName: opts.door.name,
    customerCompanyId: origineel.customerCompanyId,
    customerName: origineel.customerName,
    plate: origineel.plate,
    totalIncl: totaalIncl,
    totalExcl: centen(totaalIncl - totaalBtw),
    vatTotal: totaalBtw,
    discountIncl: 0,
    rounding: 0,
    // Terugbetalen gaat zoals er betaald is. Bij gemengd is dat een keuze aan
    // de balie; die staat in de reden.
    method: origineel.method === 'gemengd' ? 'contant' : origineel.method,
    creditOf: origineel.id,
    cashSessionId: opts.cashSessionId,
    openedAt: nu,
    closedAt: nu,
    printed: false,
    note: `Creditbon op ${origineel.receiptNo} — ${opts.reden}`,
    updatedAt: nu,
  }

  const regels: PosSaleLine[] = terug.map((r, i) => ({
    ...r,
    id: uid('regel'),
    saleId: bon.id,
    lineNo: i + 1,
    qty: -r.qty,
    totalIncl: centen(-r.totalIncl),
    totalExcl: centen(-r.totalExcl),
    vatAmount: centen(-r.vatAmount),
    note: `Terug van ${origineel.receiptNo}`,
    updatedAt: nu,
  }))

  const betaling: PosPayment = {
    id: uid('bet'),
    saleId: bon.id,
    method: (bon.method ?? 'contant') as PosPayment['method'],
    amount: totaalIncl,
    at: nu,
    updatedAt: nu,
  }

  await db.transaction('rw', db.sales, db.saleLines, db.payments, async () => {
    await db.sales.put(bon)
    await db.saleLines.bulkPut(regels)
    await db.payments.put(betaling)
    // De oorspronkelijke bon blijft staan; alleen zijn status verandert. Dat
    // is precies wat de database nog toestaat.
    await db.sales.put({ ...origineel, status: 'gecrediteerd', updatedAt: nu })
  })

  await enqueue('sales', 'put', bon.id, bon)
  for (const r of regels) await enqueue('saleLines', 'put', r.id, r)
  await enqueue('payments', 'put', betaling.id, betaling)
  await enqueue('sales', 'put', origineel.id,
    { ...origineel, status: 'gecrediteerd', updatedAt: nu })

  /* ---- de gevolgen terugdraaien ---- */

  // Voorraad terug op de stelling.
  for (const r of terug) {
    if (!r.productId) continue
    const product = await db.products.get(r.productId)
    if (!product?.inventoryItemId) continue
    const item = await db.inventory.get(product.inventoryItemId)
    if (!item) continue

    const mutatie: StockMovement = {
      id: uid('sm'),
      locationId: bon.locationId ?? item.locationId,
      itemId: item.id,
      itemName: item.name,
      qty: r.qty,
      reason: `Retour aan de kassa (${bon.receiptNo})`,
      userId: opts.door.id,
      userName: opts.door.name,
      at: nu,
    }
    await db.stockMovements.put(mutatie)
    await enqueue('stockMovements', 'put', mutatie.id, mutatie)

    const nieuw: InventoryItem = { ...item, stock: centen(item.stock + r.qty), updatedAt: nu }
    await db.inventory.put(nieuw)
    await enqueue('inventory', 'put', nieuw.id, nieuw)
  }

  // Strippen terug op de kaart.
  const gebruikt = await db.payments.where('saleId').equals(origineel.id).toArray()
  for (const b of gebruikt) {
    if (b.method === 'abonnement' && b.subscriptionId) {
      await terugboeken({
        subscriptionId: b.subscriptionId,
        creditSaleId: bon.id,
        origineleSaleId: origineel.id,
        door: opts.door,
      })
    }
  }

  return {
    bon, regels, betalingen: [betaling],
    wasopdrachten: [], nietIngepland: 0, kaarten: [],
  }
}

/* ------------------------------------------------------------------ *
 *  Parkeren
 *
 *  Een chauffeur die nog even naar zijn cabine loopt houdt de rij niet op:
 *  zijn bon gaat aan de kant en de volgende kan afrekenen.
 * ------------------------------------------------------------------ */

export async function parkeren(opts: {
  register: PosRegister
  door: User
  regels: MandjeRegel[]
  klant?: { companyId?: string; name?: string }
  plate?: string
  note?: string
}): Promise<PosSale> {
  const totalen = bonTotalen(opts.regels)
  const nu = Date.now()

  const bon: PosSale = {
    id: uid('bon'),
    registerId: opts.register.id,
    registerCode: opts.register.code,
    locationId: opts.register.locationId,
    // Een geparkeerde bon krijgt nog geen nummer: hij is niet afgerekend, en
    // een nummer uitdelen dat later niet gebruikt wordt geeft een gat in de
    // reeks.
    receiptNo: '',
    seq: 0,
    status: 'geparkeerd',
    operatorId: opts.door.id,
    operatorName: opts.door.name,
    customerCompanyId: opts.klant?.companyId,
    customerName: opts.klant?.name,
    plate: opts.plate?.toUpperCase(),
    totalIncl: totalen.incl,
    totalExcl: totalen.excl,
    vatTotal: totalen.btw,
    discountIncl: totalen.korting,
    rounding: 0,
    openedAt: nu,
    printed: false,
    note: opts.note,
    updatedAt: nu,
  }

  const regels = opts.regels.map((r, i) => naarBonregel(bon.id, r, i + 1))

  await db.transaction('rw', db.sales, db.saleLines, async () => {
    await db.sales.put(bon)
    await db.saleLines.bulkPut(regels)
  })
  await enqueue('sales', 'put', bon.id, bon)
  for (const r of regels) await enqueue('saleLines', 'put', r.id, r)

  return bon
}

export async function geparkeerdeBonnen(registerId?: string): Promise<PosSale[]> {
  const alles = await db.sales.where('status').equals('geparkeerd').toArray()
  return alles
    .filter((b) => !registerId || b.registerId === registerId)
    .sort((a, b) => b.openedAt - a.openedAt)
}

/** Een geparkeerde bon terug in het mandje. */
export async function hervatten(saleId: string): Promise<{
  bon: PosSale
  regels: MandjeRegel[]
} | null> {
  const bon = await db.sales.get(saleId)
  if (!bon || bon.status !== 'geparkeerd') return null
  const regels = await db.saleLines.where('saleId').equals(saleId).toArray()

  const mandje: MandjeRegel[] = await Promise.all(
    regels
      .sort((a, b) => a.lineNo - b.lineNo)
      .map(async (r) => {
        const product = r.productId ? await db.products.get(r.productId) : undefined
        return {
          id: uid('m'),
          productId: r.productId,
          name: r.name,
          kind: r.kind,
          qty: r.qty,
          priceIncl: r.priceIncl,
          vatPct: r.vatPct,
          discountPct: r.discountPct,
          washJobId: r.washJobId,
          credits: product?.credits,
          validDays: product?.validDays,
          washService: product?.washService,
          inventoryItemId: product?.inventoryItemId,
          note: r.note,
        }
      }),
  )

  return { bon, regels: mandje }
}

/** Een geparkeerde bon die niemand meer komt ophalen. */
export async function parkeerbonWeggooien(saleId: string, reden: string) {
  const bon = await db.sales.get(saleId)
  if (!bon || bon.status !== 'geparkeerd') return

  /*
   * Weggooien is hier echt weggooien: een geparkeerde bon is nooit afgerekend,
   * dus er is geen omzet die verdwijnt. De database staat dit dan ook toe --
   * en alleen dit.
   */
  const regels = await db.saleLines.where('saleId').equals(saleId).toArray()
  await db.transaction('rw', db.sales, db.saleLines, async () => {
    await db.saleLines.bulkDelete(regels.map((r) => r.id))
    await db.sales.delete(saleId)
  })
  await enqueue('sales', 'delete', saleId, { reden })
}

/* ------------------------------------------------------------------ *
 *  Terugkijken
 * ------------------------------------------------------------------ */

export interface VolledigeBon {
  bon: PosSale
  regels: PosSaleLine[]
  betalingen: PosPayment[]
}

export async function bonMetAlles(saleId: string): Promise<VolledigeBon | null> {
  const bon = await db.sales.get(saleId)
  if (!bon) return null
  return {
    bon,
    regels: (await db.saleLines.where('saleId').equals(saleId).toArray())
      .sort((a, b) => a.lineNo - b.lineNo),
    betalingen: await db.payments.where('saleId').equals(saleId).toArray(),
  }
}

/** Bonnen zoeken op nummer, kenteken, klant of bedrag. */
export async function zoekBonnen(term: string, limiet = 40): Promise<PosSale[]> {
  const zoek = term.trim().toUpperCase()
  const alles = await db.sales.toArray()

  const afgerekend = alles.filter((b) => b.status !== 'geparkeerd')
  if (!zoek) {
    return afgerekend
      .sort((a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt))
      .slice(0, limiet)
  }

  const zonderStreep = zoek.replace(/-/g, '')
  return afgerekend
    .filter((b) =>
      b.receiptNo.toUpperCase().includes(zoek) ||
      (b.plate ?? '').toUpperCase().replace(/-/g, '').includes(zonderStreep) ||
      (b.customerName ?? '').toUpperCase().includes(zoek) ||
      b.totalIncl.toFixed(2) === zoek.replace(',', '.'))
    .sort((a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt))
    .slice(0, limiet)
}
