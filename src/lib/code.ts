import { db, getMeta, setMeta, uid } from './db'
import { enqueue } from './sync'
import type { PosPin, User } from './types'

/* ------------------------------------------------------------------ *
 *  Wie staat er achter de kassa?
 *
 *  Het personeelsnummer is de inlogcode. Eén nummer per persoon, dat hij
 *  toch al kent en dat al in het dossier staat -- dus niets extra's om uit
 *  te delen, te onthouden of kwijt te raken.
 *
 *  De lengte doet niet mee: drie cijfers of acht, met of zonder letters ervoor.
 *  Wat er in het dossier staat, is wat er werkt.
 *
 *  Wat dit is, en wat het niet is:
 *
 *  Een personeelsnummer is geen geheim. Het staat op roosters, op urenlijsten
 *  en in de app van collega's. Wie het nummer van iemand anders kent, kan zich
 *  als die persoon aanmelden. Dat is een bewuste keuze -- het is hoe de meeste
 *  kassa's met een medewerkersnummer werken -- maar het betekent dat de code
 *  zegt *wie er handelde*, en niet *dat het echt die persoon was*.
 *
 *  Daarom staat hier wel een rem op het gokken, en daarom komt het nummer
 *  nergens in de app in beeld waar iemand het kan aflezen. Bij de gegevens
 *  komt niemand ermee: dat doet het account waarmee de kassa is ingericht.
 * ------------------------------------------------------------------ */

/**
 * Een nummer op één vorm brengen.
 *
 * Wat er in het dossier staat is niet altijd wat iemand intikt: "TW-014" wordt
 * op een cijfertoetsenbord "014", en wie het uit zijn hoofd doet laat de
 * streepjes weg. Alles naar hoofdletters en zonder leestekens dus.
 */
export function normaliseerNummer(ruw: string): string {
  return ruw.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Alleen de cijfers, zodat "014" ook "TW-014" vindt. */
function alleenCijfers(ruw: string): string {
  return ruw.replace(/\D/g, '')
}

/** Waarom dit nummer niet kan, of null als het mag. */
export function nummerProbleem(nummer: string): string | null {
  const schoon = normaliseerNummer(nummer)
  if (!schoon) return 'Vul je personeelsnummer in.'
  if (schoon.length > 24) return 'Dat zijn meer tekens dan een personeelsnummer heeft.'
  return null
}

/**
 * De vormen waarop een medewerker te vinden is.
 *
 * Twee: het hele nummer zonder leestekens, en alleen de cijfers eruit. Zo
 * werkt "TW-014" én "014" én "tw014" -- en dat scheelt uitleg aan de balie.
 */
function sleutelsVan(user: User): string[] {
  const nummer = (user.personnelNumber ?? '').trim()
  if (!nummer) return []

  const heel = normaliseerNummer(nummer)
  const cijfers = alleenCijfers(nummer)

  const uit = [heel]
  if (cijfers && cijfers !== heel) uit.push(cijfers)
  return uit
}

/* ------------------------------------------------------------------ *
 *  Te vaak misgetoetst
 *
 *  Een nummer van drie cijfers is te raden door het simpelweg te proberen.
 *  Vijf pogingen en dan een minuut wachten maakt dat onbegonnen werk, en
 *  hindert iemand die zich één keer vertikt niet.
 *
 *  De teller staat op het nummer dat is ingetoetst en niet op de persoon:
 *  bij een fout nummer weten we immers niet wie het probeerde.
 * ------------------------------------------------------------------ */

const MAX_POGINGEN = 5
const WACHTTIJD_MS = 60_000

const pogingenKey = 'pogingen'

interface Pogingen { aantal: number; laatste: number }

async function pogingen(): Promise<Pogingen> {
  return getMeta<Pogingen>(pogingenKey, { aantal: 0, laatste: 0 })
}

/** Hoeveel milliseconden er nog gewacht moet worden. 0 = mag proberen. */
export async function wachttijd(): Promise<number> {
  const p = await pogingen()
  if (p.aantal < MAX_POGINGEN) return 0
  return Math.max(0, WACHTTIJD_MS - (Date.now() - p.laatste))
}

async function misgetoetst() {
  const p = await pogingen()
  await setMeta(pogingenKey, { aantal: p.aantal + 1, laatste: Date.now() })
}

async function gelukt() {
  await setMeta(pogingenKey, { aantal: 0, laatste: 0 })
}

/* ------------------------------------------------------------------ *
 *  Herkennen
 * ------------------------------------------------------------------ */

export type HerkenResultaat =
  | { ok: true; user: User }
  | {
      ok: false
      reden: 'onbekend' | 'geblokkeerd' | 'inactief' | 'dubbel' | 'geen-nummer'
      wachtMs?: number
      /** Bij 'dubbel': wie er allemaal op dit nummer staan. */
      namen?: string[]
    }

/**
 * Wie hoort bij dit nummer?
 *
 * Geen naam kiezen meer vooraf: een personeelsnummer is uniek, dus het nummer
 * alleen is genoeg. Dat is aan een balie ook een handeling minder.
 *
 * Staat hetzelfde nummer bij twee mensen, dan weigeren we het. Gokken welke
 * van de twee bedoeld is zou betekenen dat de bon en de urenstaat op de
 * verkeerde naam komen, en dat merkt niemand tot het over geld gaat.
 */
export async function herkenOpNummer(ingetoetst: string): Promise<HerkenResultaat> {
  const wacht = await wachttijd()
  if (wacht > 0) return { ok: false, reden: 'geblokkeerd', wachtMs: wacht }

  const zoek = normaliseerNummer(ingetoetst)
  if (!zoek) return { ok: false, reden: 'onbekend' }

  const alles = await db.users.toArray()
  const treffers = alles.filter((u) => sleutelsVan(u).includes(zoek))

  if (!treffers.length) {
    await misgetoetst()
    return { ok: false, reden: 'onbekend' }
  }

  const actief = treffers.filter((u) => u.active)
  if (!actief.length) {
    await gelukt()
    return { ok: false, reden: 'inactief' }
  }

  if (actief.length > 1) {
    // Geen rem hierop: het nummer is juist wél gevonden. Dit is een probleem
    // in de administratie, niet iemand die staat te gokken.
    return {
      ok: false,
      reden: 'dubbel',
      namen: actief.map((u) => u.name),
    }
  }

  await gelukt()
  return { ok: true, user: actief[0] }
}

/** Wie hoort bij deze gescande badge? */
export async function herkenBadge(token: string): Promise<HerkenResultaat> {
  const pin = await db.pins.where('badgeToken').equals(token.trim()).first()
  if (!pin) return { ok: false, reden: 'onbekend' }
  const user = await db.users.get(pin.userId)
  if (!user) return { ok: false, reden: 'onbekend' }
  if (!user.active) return { ok: false, reden: 'inactief' }
  await gelukt()
  return { ok: true, user }
}

/* ------------------------------------------------------------------ *
 *  Wat er mis kan zijn met de nummers
 *
 *  Twee dingen maken aanmelden onmogelijk, en ze zijn beide te zien vóórdat
 *  iemand ermee vastloopt: een medewerker zonder nummer, en twee mensen met
 *  hetzelfde nummer. Beide horen in het dashboard rechtgezet te worden, onder
 *  Personeel -- daarom melden we het en repareren we het hier niet.
 * ------------------------------------------------------------------ */

export interface NummerControle {
  zonderNummer: User[]
  dubbel: { nummer: string; namen: string[] }[]
}

export async function nummersNakijken(locationId?: string): Promise<NummerControle> {
  const alles = (await db.users.toArray()).filter((u) =>
    u.active &&
    (!locationId || !u.locationId || u.locationId === locationId || u.allLocations))

  const zonderNummer = alles.filter((u) => !(u.personnelNumber ?? '').trim())

  const perSleutel = new Map<string, User[]>()
  for (const u of alles) {
    for (const s of sleutelsVan(u)) {
      perSleutel.set(s, [...(perSleutel.get(s) ?? []), u])
    }
  }

  const dubbel: NummerControle['dubbel'] = []
  const gezien = new Set<string>()
  for (const [sleutel, mensen] of perSleutel) {
    if (mensen.length < 2) continue
    // Dezelfde botsing kan onder twee sleutels opduiken (heel en cijfers);
    // die melden we één keer.
    const vinger = mensen.map((m) => m.id).sort().join('|')
    if (gezien.has(vinger)) continue
    gezien.add(vinger)
    dubbel.push({ nummer: sleutel, namen: mensen.map((m) => m.name) })
  }

  return { zonderNummer, dubbel }
}

/* ------------------------------------------------------------------ *
 *  Badges
 *
 *  Een badge blijft bestaan naast het nummer: scannen is sneller dan tikken,
 *  en op een sleutelhanger raak je hem minder makkelijk kwijt dan een nummer
 *  uit je hoofd.
 *
 *  Hij hangt aan de tabel die eerder de codes bevatte. De kolommen voor die
 *  code zijn leeg gebleven -- er wordt niets meer mee gecontroleerd.
 * ------------------------------------------------------------------ */

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Maakt een nieuwe badge voor iemand, en geeft de code erop terug. */
export async function badgeMaken(userId: string): Promise<string> {
  const bestaand = await db.pins.where('userId').equals(userId).first()

  // Lang en willekeurig: een badge wordt gescand, niet ingetoetst, dus
  // leesbaarheid is geen eis en raadbaarheid wel een risico.
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const token = 'TWB-' + hex(bytes.buffer).toUpperCase().slice(0, 24)

  const rij: PosPin = {
    id: bestaand?.id ?? uid('badge'),
    userId,
    salt: bestaand?.salt ?? '',
    hash: bestaand?.hash ?? '',
    iterations: bestaand?.iterations ?? 0,
    badgeToken: token,
    mustChange: false,
    setBy: bestaand?.setBy,
    updatedAt: Date.now(),
  }

  await db.pins.put(rij)
  await enqueue('pins', 'put', rij.id, rij)
  return token
}

export async function badgeIntrekken(userId: string): Promise<void> {
  const bestaand = await db.pins.where('userId').equals(userId).first()
  if (!bestaand?.badgeToken) return
  const rij = { ...bestaand, badgeToken: undefined, updatedAt: Date.now() }
  await db.pins.put(rij)
  await enqueue('pins', 'put', rij.id, rij)
}

/** Heeft deze medewerker een badge? */
export async function heeftBadge(userId: string): Promise<boolean> {
  const rij = await db.pins.where('userId').equals(userId).first()
  return Boolean(rij?.badgeToken)
}
