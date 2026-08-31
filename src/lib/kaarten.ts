import { db, uid } from './db'
import { enqueue } from './sync'
import type {
  PosSubscription, PosSubscriptionUse, ServiceKind, User,
} from './types'

/* ------------------------------------------------------------------ *
 *  Strippenkaarten en abonnementen
 *
 *  Een strippenkaart is een aantal wasbeurten dat vooruit betaald is. Een
 *  abonnement is een periode waarin onbeperkt gewassen mag worden.
 *
 *  Het saldo van een kaart staat nergens als getal. Het is een som: wat erop
 *  zat, min alles wat er is afgeboekt. Dat is bewust.
 *
 *  Twee kassa's op twee vestigingen kunnen tegelijk offline een strip
 *  gebruiken. Zouden ze allebei het saldoveld bijwerken, dan overschrijft de
 *  laatste de eerste en heeft de klant er één gratis bij. Regels bij elkaar
 *  optellen kan niet fout gaan: ze komen allebei binnen, en samen kloppen ze.
 *
 *  Het gevolg dat je moet accepteren: een kaart kan één keer over zijn saldo
 *  heen gaan als twee kassa's tegelijk offline de laatste strip pakken. Dat
 *  valt op bij het volgende bezoek, en het is aanzienlijk beter dan een
 *  chauffeur die bij een storing niet weg kan.
 * ------------------------------------------------------------------ */

export interface KaartMetSaldo {
  kaart: PosSubscription
  /** Alleen bij een strippenkaart. Bij een abonnement is dit null. */
  saldo: number | null
  geldig: boolean
  /** Waarom hij niet gebruikt kan worden. */
  reden?: string
}

/** Wat er nog op een strippenkaart staat. */
export async function saldo(subscriptionId: string): Promise<number> {
  const kaart = await db.subscriptions.get(subscriptionId)
  if (!kaart) return 0
  const gebruikt = await db.subscriptionUses
    .where('subscriptionId').equals(subscriptionId).toArray()
  return kaart.creditsTotal - gebruikt.reduce((som, u) => som + u.credits, 0)
}

/** Kaart plus saldo plus of hij nu gebruikt mag worden. */
export async function beoordeel(
  kaart: PosSubscription,
  service?: ServiceKind,
): Promise<KaartMetSaldo> {
  if (!kaart.active) {
    return { kaart, saldo: null, geldig: false, reden: 'Deze kaart is ingetrokken.' }
  }

  if (kaart.washService && service && kaart.washService !== service) {
    return {
      kaart, saldo: null, geldig: false,
      reden: `Deze kaart geldt alleen voor ${kaart.washService}.`,
    }
  }

  if (kaart.kind === 'abonnement') {
    const nu = Date.now()
    if (kaart.validFrom && nu < kaart.validFrom) {
      return { kaart, saldo: null, geldig: false, reden: 'Dit abonnement begint later.' }
    }
    if (kaart.validTo && nu > kaart.validTo) {
      return { kaart, saldo: null, geldig: false, reden: 'Dit abonnement is verlopen.' }
    }
    return { kaart, saldo: null, geldig: true }
  }

  const rest = await saldo(kaart.id)
  if (rest <= 0) {
    return { kaart, saldo: rest, geldig: false, reden: 'Deze kaart is op.' }
  }
  return { kaart, saldo: rest, geldig: true }
}

/**
 * Een kaart opzoeken.
 *
 * Aan de balie gebeurt dat op drie manieren: de code van de kaart scannen, het
 * kenteken intoetsen, of de klant kiezen. Alle drie leveren hier iets op.
 */
export async function zoekKaarten(zoek: string): Promise<PosSubscription[]> {
  const term = zoek.trim().toUpperCase()
  if (!term) return []

  const alles = await db.subscriptions.toArray()
  return alles
    .filter((k) =>
      k.code.toUpperCase() === term ||
      (k.plate ?? '').toUpperCase().replace(/-/g, '') === term.replace(/-/g, '') ||
      (k.customerName ?? '').toUpperCase().includes(term))
    .sort((a, b) => Number(b.active) - Number(a.active))
}

export async function kaartenVanKlant(companyId: string): Promise<PosSubscription[]> {
  return db.subscriptions.where('companyId').equals(companyId).toArray()
}

/* ------------------------------------------------------------------ *
 *  Afboeken
 * ------------------------------------------------------------------ */

/**
 * Boekt strippen van een kaart af.
 *
 * Het id is opzettelijk voorspelbaar: bon + kaart. Komt dezelfde afboeking
 * twee keer langs -- omdat de eerste poging strandde op een wegvallende
 * verbinding en de kassa hem opnieuw stuurt -- dan overschrijft hij zichzelf
 * in plaats van er een tweede strip af te halen.
 */
export async function afboeken(opts: {
  subscriptionId: string
  saleId: string
  credits?: number
  door: Pick<User, 'id' | 'name'>
}): Promise<PosSubscriptionUse> {
  const rij: PosSubscriptionUse = {
    id: `gebruik_${opts.saleId}_${opts.subscriptionId}`,
    subscriptionId: opts.subscriptionId,
    saleId: opts.saleId,
    credits: opts.credits ?? 1,
    userId: opts.door.id,
    userName: opts.door.name,
    at: Date.now(),
    updatedAt: Date.now(),
  }
  await db.subscriptionUses.put(rij)
  await enqueue('subscriptionUses', 'put', rij.id, rij)
  return rij
}

/** Een afboeking terugdraaien, bij een creditbon. */
export async function terugboeken(opts: {
  subscriptionId: string
  creditSaleId: string
  origineleSaleId: string
  credits?: number
  door: Pick<User, 'id' | 'name'>
}): Promise<PosSubscriptionUse> {
  // Een negatieve afboeking, dus telt op bij het saldo. De oorspronkelijke
  // regel laten we staan: de administratie hoort te laten zien dat er eerst
  // een strip af ging en daarna terug, niet dat het nooit gebeurde.
  const rij: PosSubscriptionUse = {
    id: `gebruik_${opts.creditSaleId}_${opts.subscriptionId}`,
    subscriptionId: opts.subscriptionId,
    saleId: opts.creditSaleId,
    credits: -(opts.credits ?? 1),
    userId: opts.door.id,
    userName: opts.door.name,
    at: Date.now(),
    updatedAt: Date.now(),
  }
  await db.subscriptionUses.put(rij)
  await enqueue('subscriptionUses', 'put', rij.id, rij)
  return rij
}

/* ------------------------------------------------------------------ *
 *  Verkopen
 * ------------------------------------------------------------------ */

/**
 * De code die op de kaart komt te staan.
 *
 * Kort genoeg om over te typen als de scanner het niet doet, en met een
 * controlecijfer zodat een verkeerd overgetypte code niet per ongeluk de kaart
 * van iemand anders is.
 */
function kaartCode(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  const kern = [...bytes].map((b) => b.toString(36).toUpperCase().padStart(2, '0')).join('')
  const som = [...kern].reduce((s, c) => s + c.charCodeAt(0), 0) % 36
  return `TW-${kern}-${som.toString(36).toUpperCase()}`
}

/** Maakt de kaart aan die net op de bon is verkocht. */
export async function kaartVerkopen(opts: {
  saleId: string
  locationId?: string
  companyId?: string
  customerName?: string
  plate?: string
  kind: 'strippenkaart' | 'abonnement'
  credits?: number
  validDays?: number
  washService?: ServiceKind
}): Promise<PosSubscription> {
  const nu = Date.now()
  const kaart: PosSubscription = {
    id: uid('kaart'),
    locationId: opts.locationId,
    companyId: opts.companyId,
    customerName: opts.customerName,
    plate: opts.plate,
    code: kaartCode(),
    kind: opts.kind,
    creditsTotal: opts.kind === 'strippenkaart' ? (opts.credits ?? 0) : 0,
    validFrom: opts.kind === 'abonnement' ? nu : undefined,
    validTo: opts.kind === 'abonnement' && opts.validDays
      ? nu + opts.validDays * 86_400_000
      : undefined,
    washService: opts.washService,
    soldSaleId: opts.saleId,
    active: true,
    updatedAt: nu,
  }
  await db.subscriptions.put(kaart)
  await enqueue('subscriptions', 'put', kaart.id, kaart)
  return kaart
}

/** Een kaart intrekken (kwijt, misbruik, of teruggedraaide verkoop). */
export async function kaartIntrekken(id: string, reden: string): Promise<void> {
  const kaart = await db.subscriptions.get(id)
  if (!kaart) return
  const rij: PosSubscription = {
    ...kaart,
    active: false,
    note: kaart.note ? `${kaart.note} — ${reden}` : reden,
    updatedAt: Date.now(),
  }
  await db.subscriptions.put(rij)
  await enqueue('subscriptions', 'put', rij.id, rij)
}
