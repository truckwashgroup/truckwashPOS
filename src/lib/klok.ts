import { db, uid } from './db'
import { enqueue } from './sync'
import type { TimeEntry, User } from './types'

/* ------------------------------------------------------------------ *
 *  Klokken
 *
 *  De kassa schrijft de uren in dezelfde tabel als de wasstraat-app
 *  (time_entries). Daardoor is er geen "urenlijst van de kassa" die iemand
 *  later moet overtypen: wie hier inklokt, staat meteen in het dashboard
 *  onder Uren, en de leidinggevende keurt ze daar goed.
 *
 *  Eén open dienst per persoon. Dat is geen technische beperking maar hoe het
 *  werkt: je bent aan het werk of je bent het niet.
 * ------------------------------------------------------------------ */

/**
 * Langer dan dit is geen dienst maar een vergeten uitklok.
 *
 * We sluiten hem niet stil af -- dan verzint de kassa uren die niemand heeft
 * gemaakt. In plaats daarvan valt hij op, en corrigeert iemand hem met de
 * werkelijke eindtijd.
 */
export const LANGSTE_DIENST_MS = 16 * 3_600_000

async function put(entry: TimeEntry) {
  const gestempeld = { ...entry, updatedAt: Date.now() }
  await db.timeEntries.put(gestempeld)
  await enqueue('timeEntries', 'put', gestempeld.id, gestempeld)
  return gestempeld
}

/** De dienst die nog open staat voor deze persoon, of null. */
export async function openDienst(userId: string): Promise<TimeEntry | null> {
  const rijen = await db.timeEntries.where('userId').equals(userId).toArray()
  const open = rijen.filter((r) => !r.end).sort((a, b) => b.start - a.start)
  return open[0] ?? null
}

/** Staat deze dienst er te lang op om nog te kloppen? */
export function vergeten(entry: TimeEntry): boolean {
  return !entry.end && Date.now() - entry.start > LANGSTE_DIENST_MS
}

/**
 * Inklokken.
 *
 * Stond er nog een dienst open, dan geven we die terug in plaats van een
 * tweede te beginnen. Twee open diensten naast elkaar zou betekenen dat
 * iemand dubbel uitbetaald wordt.
 */
export async function inklokken(user: User, locationId?: string): Promise<{
  entry: TimeEntry
  alOpen: boolean
}> {
  const bestaand = await openDienst(user.id)
  if (bestaand) return { entry: bestaand, alOpen: true }

  const entry: TimeEntry = {
    id: uid('uur'),
    locationId: locationId ?? user.locationId,
    userId: user.id,
    userName: user.name,
    start: Date.now(),
    updatedAt: Date.now(),
  }
  return { entry: await put(entry), alOpen: false }
}

/** Uitklokken. Geeft de gesloten dienst terug, of null als er niets open stond. */
export async function uitklokken(userId: string, note?: string): Promise<TimeEntry | null> {
  const open = await openDienst(userId)
  if (!open) return null
  return put({ ...open, end: Date.now(), note: note ?? open.note })
}

/**
 * Een dienst met de hand rechtzetten.
 *
 * Nodig na een vergeten uitklok, en na een kassa die halverwege de dag
 * uitviel. Wie het deed en waarom hoort erbij -- een gecorrigeerde urenstaat
 * zonder toelichting is een discussie op de loonstrook.
 */
export async function dienstCorrigeren(opts: {
  entryId: string
  start?: number
  end?: number
  note: string
  doorNaam: string
}): Promise<TimeEntry | null> {
  const entry = await db.timeEntries.get(opts.entryId)
  if (!entry) return null

  const toelichting = `${opts.note} (bijgesteld door ${opts.doorNaam})`
  return put({
    ...entry,
    start: opts.start ?? entry.start,
    end: opts.end ?? entry.end,
    note: entry.note ? `${entry.note} — ${toelichting}` : toelichting,
  })
}

/* ------------------------------------------------------------------ *
 *  Wie is er?
 * ------------------------------------------------------------------ */

export interface Aanwezig {
  user: User
  entry: TimeEntry
  vergeten: boolean
}

/**
 * Wie op deze vestiging is ingeklokt.
 *
 * Dit is het scherm waar de leidinggevende 's ochtends naar kijkt, dus het
 * moet ook zonder internet kloppen -- vandaar dat het uit de lokale cache
 * komt en niet uit een vraag aan de server.
 */
export async function aanwezig(locationId?: string): Promise<Aanwezig[]> {
  const rijen = (await db.timeEntries.toArray()).filter((r) => !r.end)
  const uit: Aanwezig[] = []

  for (const entry of rijen) {
    if (locationId && entry.locationId && entry.locationId !== locationId) continue
    const user = await db.users.get(entry.userId)
    if (!user) continue
    uit.push({ user, entry, vergeten: vergeten(entry) })
  }

  return uit.sort((a, b) => a.user.name.localeCompare(b.user.name, 'nl'))
}

/** Hoeveel er vandaag op staat voor deze persoon, in milliseconden. */
export async function vandaagGewerkt(userId: string): Promise<number> {
  const begin = new Date()
  begin.setHours(0, 0, 0, 0)
  const vanaf = begin.getTime()

  const rijen = await db.timeEntries.where('userId').equals(userId).toArray()
  return rijen
    .filter((r) => (r.end ?? Date.now()) > vanaf)
    .reduce((som, r) => {
      const van = Math.max(r.start, vanaf)
      const tot = r.end ?? Date.now()
      // Een vergeten uitklok telt niet mee in het dagtotaal; die zou het
      // getal onzin maken.
      if (!r.end && vergeten(r)) return som
      return som + Math.max(0, tot - van)
    }, 0)
}

/** Deze week, vanaf maandag. */
export async function wekelijkGewerkt(userId: string): Promise<number> {
  const nu = new Date()
  const dag = (nu.getDay() + 6) % 7 // maandag = 0
  const begin = new Date(nu)
  begin.setDate(nu.getDate() - dag)
  begin.setHours(0, 0, 0, 0)
  const vanaf = begin.getTime()

  const rijen = await db.timeEntries.where('userId').equals(userId).toArray()
  return rijen
    .filter((r) => (r.end ?? Date.now()) > vanaf)
    .reduce((som, r) => {
      if (!r.end && vergeten(r)) return som
      const van = Math.max(r.start, vanaf)
      const tot = r.end ?? Date.now()
      return som + Math.max(0, tot - van)
    }, 0)
}
