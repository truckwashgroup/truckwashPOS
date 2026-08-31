import { db, uid } from './db'
import { enqueue } from './sync'
import { centen } from './geld'
import type {
  CashMoveKind, PosCashMove, PosCashSession, PosRegister, PosSale, User,
} from './types'

/* ------------------------------------------------------------------ *
 *  De kassadag
 *
 *  's Ochtends gaat de lade open met een startbedrag aan wisselgeld.
 *  's Avonds wordt er geteld en gaat hij dicht. Wat ertussen zit is de omzet
 *  van die dag, per betaalwijze.
 *
 *  Waarom dat één ding is en niet "de omzet van vandaag": een kassadag loopt
 *  niet gelijk met een kalenderdag. Een late vrachtwagen om kwart over twaalf
 *  hoort bij de dag ervoor, en bij twee ploegen zijn er twee lades. Wie de
 *  kas telt, telt zijn eigen kas.
 *
 *  Het verschil tussen geteld en verwacht wordt opgeslagen zoals het die
 *  avond is vastgesteld. Niet opnieuw uitrekenen bij het opvragen: als er
 *  later een bon bijkomt die nog in een wachtrij stond, moet je kunnen zien
 *  dat het verschil van toen anders was dan het verschil van nu.
 * ------------------------------------------------------------------ */

/** De lade die nu open staat op deze kassa, of null. */
export async function openSessie(registerId: string): Promise<PosCashSession | null> {
  const alles = await db.cashSessions.where('registerId').equals(registerId).toArray()
  return alles
    .filter((s) => s.status === 'open')
    .sort((a, b) => b.openedAt - a.openedAt)[0] ?? null
}

async function bewaar(sessie: PosCashSession): Promise<PosCashSession> {
  const rij = { ...sessie, updatedAt: Date.now() }
  await db.cashSessions.put(rij)
  await enqueue('cashSessions', 'put', rij.id, rij)
  return rij
}

/**
 * De lade openen.
 *
 * Stond er nog een open, dan geven we die terug. Twee open lades op één kassa
 * betekent dat de omzet over twee tellingen verdeeld raakt en dat er 's avonds
 * niets meer klopt.
 */
export async function kasOpenen(opts: {
  register: PosRegister
  door: User
  startbedrag: number
}): Promise<{ sessie: PosCashSession; alOpen: boolean }> {
  const bestaand = await openSessie(opts.register.id)
  if (bestaand) return { sessie: bestaand, alOpen: true }

  const sessie: PosCashSession = {
    id: uid('kas'),
    registerId: opts.register.id,
    registerCode: opts.register.code,
    locationId: opts.register.locationId,
    openedBy: opts.door.id,
    openedByName: opts.door.name,
    openedAt: Date.now(),
    startFloat: centen(opts.startbedrag),
    cashTotal: 0,
    pinTotal: 0,
    invoiceTotal: 0,
    salesCount: 0,
    status: 'open',
    updatedAt: Date.now(),
  }
  return { sessie: await bewaar(sessie), alOpen: false }
}

/* ------------------------------------------------------------------ *
 *  Geld erin, geld eruit
 * ------------------------------------------------------------------ */

export async function kasMutatie(opts: {
  sessionId: string
  kind: CashMoveKind
  bedrag: number
  reden: string
  door: Pick<User, 'id' | 'name'>
}): Promise<PosCashMove> {
  if (!opts.reden.trim()) {
    throw new Error('Zet erbij waarom er geld in of uit de lade gaat.')
  }

  /*
   * Het teken staat vast per soort, zodat niemand zich kan vertikken met een
   * min: inleg erbij, afstorting eraf. Een correctie mag beide kanten op --
   * dat is nu juist waar hij voor is.
   */
  const bedrag = opts.kind === 'afstorting'
    ? -Math.abs(centen(opts.bedrag))
    : opts.kind === 'inleg'
      ? Math.abs(centen(opts.bedrag))
      : centen(opts.bedrag)

  const mutatie: PosCashMove = {
    id: uid('kasm'),
    sessionId: opts.sessionId,
    kind: opts.kind,
    amount: bedrag,
    reason: opts.reden.trim(),
    userId: opts.door.id,
    userName: opts.door.name,
    at: Date.now(),
    updatedAt: Date.now(),
  }
  await db.cashMoves.put(mutatie)
  await enqueue('cashMoves', 'put', mutatie.id, mutatie)
  return mutatie
}

/* ------------------------------------------------------------------ *
 *  Tellen
 * ------------------------------------------------------------------ */

export interface KasStand {
  sessie: PosCashSession
  bonnen: PosSale[]
  contant: number
  pin: number
  opRekening: number
  metKaart: number
  afronding: number
  omzetIncl: number
  omzetExcl: number
  btw: number
  mutaties: PosCashMove[]
  inleg: number
  afstorting: number
  /** Wat er in de lade hoort te liggen. */
  verwachtContant: number
  aantalBonnen: number
  aantalCredit: number
}

/**
 * De stand van deze kassadag, uit de lokale cache.
 *
 * Dit is de basis van de dagafsluiting, dus het moet ook zonder internet
 * kloppen -- en dat kan, want alle bonnen van deze lade zijn hier gemaakt.
 */
export async function kasStand(sessionId: string): Promise<KasStand | null> {
  const sessie = await db.cashSessions.get(sessionId)
  if (!sessie) return null

  const bonnen = (await db.sales.where('cashSessionId').equals(sessionId).toArray())
    .filter((b) => b.status === 'afgerekend' || b.status === 'gecrediteerd')

  let contant = 0
  let pin = 0
  let opRekening = 0
  let metKaart = 0

  for (const bon of bonnen) {
    const betalingen = await db.payments.where('saleId').equals(bon.id).toArray()
    for (const b of betalingen) {
      if (b.method === 'contant') contant = centen(contant + b.amount)
      if (b.method === 'pin') pin = centen(pin + b.amount)
      if (b.method === 'op-rekening') opRekening = centen(opRekening + b.amount)
      if (b.method === 'abonnement') metKaart = centen(metKaart + b.amount)
    }
  }

  const mutaties = (await db.cashMoves.where('sessionId').equals(sessionId).toArray())
    .sort((a, b) => a.at - b.at)

  const inleg = mutaties.filter((m) => m.amount > 0)
    .reduce((s, m) => centen(s + m.amount), 0)
  const afstorting = mutaties.filter((m) => m.amount < 0)
    .reduce((s, m) => centen(s + m.amount), 0)

  const omzetIncl = bonnen.reduce((s, b) => centen(s + b.totalIncl), 0)
  const btw = bonnen.reduce((s, b) => centen(s + b.vatTotal), 0)

  return {
    sessie,
    bonnen,
    contant, pin, opRekening, metKaart,
    afronding: bonnen.reduce((s, b) => centen(s + b.rounding), 0),
    omzetIncl,
    omzetExcl: centen(omzetIncl - btw),
    btw,
    mutaties, inleg, afstorting,
    // Contant plus wisselgeld plus wat er met de hand in of uit ging. De
    // afronding zit al in de contante bedragen; die is namelijk betaald.
    verwachtContant: centen(sessie.startFloat + contant + inleg + afstorting),
    aantalBonnen: bonnen.filter((b) => !b.creditOf).length,
    aantalCredit: bonnen.filter((b) => b.creditOf).length,
  }
}

/* ------------------------------------------------------------------ *
 *  Afsluiten
 * ------------------------------------------------------------------ */

export async function kasSluiten(opts: {
  sessionId: string
  door: User
  geteld: number
  note?: string
}): Promise<{ sessie: PosCashSession; verschil: number }> {
  const stand = await kasStand(opts.sessionId)
  if (!stand) throw new Error('Die kassadag staat niet in de kassa.')
  if (stand.sessie.status === 'gesloten') {
    throw new Error('Deze kassadag is al afgesloten.')
  }

  const geteld = centen(opts.geteld)
  const verschil = centen(geteld - stand.verwachtContant)

  const sessie = await bewaar({
    ...stand.sessie,
    closedBy: opts.door.id,
    closedByName: opts.door.name,
    closedAt: Date.now(),
    counted: geteld,
    expected: stand.verwachtContant,
    difference: verschil,
    cashTotal: stand.contant,
    pinTotal: stand.pin,
    invoiceTotal: stand.opRekening,
    salesCount: stand.aantalBonnen,
    status: 'gesloten',
    note: opts.note,
  })

  return { sessie, verschil }
}

/** De laatste afsluitingen, om terug te kijken. */
export async function afsluitingen(registerId?: string, limiet = 30): Promise<PosCashSession[]> {
  const alles = await db.cashSessions.toArray()
  return alles
    .filter((s) => s.status === 'gesloten' && (!registerId || s.registerId === registerId))
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    .slice(0, limiet)
}
