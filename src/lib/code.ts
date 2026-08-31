import { db, getMeta, setMeta, uid } from './db'
import { enqueue } from './sync'
import type { PosPin, User } from './types'

/* ------------------------------------------------------------------ *
 *  De persoonlijke code
 *
 *  Aan één kassa werken meerdere mensen. Het apparaat is ingelogd met een
 *  kassa-account; wie er op dat moment achter staat blijkt uit zijn eigen
 *  code van zes cijfers, of uit zijn badge. Daarmee klokt hij in, en daarmee
 *  komt zijn naam op de bon.
 *
 *  Wat dit is, en wat het niet is:
 *
 *  De code is een ondertekening, zoals een paraaf op een urenlijst. Hij zegt
 *  wie er handelde. Hij is géén wachtwoord waarmee je bij gegevens komt --
 *  daarvoor is het kassa-account, en dat wachtwoord staat nergens op dit
 *  apparaat.
 *
 *  Waarom dat onderscheid nodig is: controleren moet ook zonder internet
 *  kunnen, dus de kassa heeft de afgeleide van de code lokaal. Wie dat
 *  bestand in handen krijgt kan er offline op los proberen. Zes cijfers met
 *  PBKDF2 op 210.000 rondes kost dan ongeveer een etmaal rekenen per persoon.
 *  Genoeg om een nieuwsgierige collega tegen te houden, niet genoeg om er een
 *  wachtwoord van te maken -- en dat is precies hoe hij bedoeld is.
 * ------------------------------------------------------------------ */

const RONDES = 210_000
const LENGTE = 6

const enc = new TextEncoder()

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function afleiden(code: string, salt: string, rondes: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: rondes, hash: 'SHA-256' },
    key,
    256,
  )
  return hex(bits)
}

/** Vergelijken zonder dat de tijd verraadt hoeveel tekens klopten. */
function gelijk(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let verschil = 0
  for (let i = 0; i < a.length; i++) verschil |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return verschil === 0
}

/* ------------------------------------------------------------------ *
 *  Een code instellen
 * ------------------------------------------------------------------ */

/** Waarom deze code niet kan, of null als hij mag. */
export function codeProbleem(code: string): string | null {
  if (!/^\d+$/.test(code)) return 'Een code bestaat alleen uit cijfers.'
  if (code.length !== LENGTE) return `Een code is precies ${LENGTE} cijfers lang.`

  if (new Set(code).size === 1) return 'Zes dezelfde cijfers is te makkelijk te raden.'

  // Oplopend of aflopend, zoals 123456 of 987654.
  const stappen = [...code].slice(1).map((c, i) => Number(c) - Number(code[i]))
  if (stappen.every((s) => s === 1) || stappen.every((s) => s === -1)) {
    return 'Een rijtje op of af is te makkelijk te raden.'
  }

  // Een geboortejaar of een datum als 010199 valt hier niet onder; dat is aan
  // de medewerker. Wat we tegenhouden is wat iedereen als eerste probeert.
  if (['000000', '123456', '654321', '111222', '112233'].includes(code)) {
    return 'Deze code staat op elk lijstje van eerste pogingen.'
  }

  return null
}

/**
 * Zet de code van een medewerker.
 *
 * `doorId` is wie het instelt -- dat staat op de rij, zodat je later kunt zien
 * of iemand zijn eigen code koos of dat de leiding hem heeft gezet.
 */
export async function codeInstellen(opts: {
  userId: string
  code: string
  doorId?: string
  moetWijzigen?: boolean
}): Promise<PosPin> {
  const probleem = codeProbleem(opts.code)
  if (probleem) throw new Error(probleem)

  const bestaand = await db.pins.where('userId').equals(opts.userId).first()
  const salt = uid('zout')

  const rij: PosPin = {
    id: bestaand?.id ?? uid('pin'),
    userId: opts.userId,
    salt,
    hash: await afleiden(opts.code, salt, RONDES),
    iterations: RONDES,
    // Een bestaande badge blijft geldig; die hoort bij de persoon, niet bij
    // de code.
    badgeToken: bestaand?.badgeToken,
    mustChange: opts.moetWijzigen ?? false,
    setBy: opts.doorId,
    updatedAt: Date.now(),
  }

  await db.pins.put(rij)
  await enqueue('pins', 'put', rij.id, rij)
  await vergetenPogingen(opts.userId)
  return rij
}

/** Maakt een nieuwe badge aan voor iemand, en geeft de code erop terug. */
export async function badgeMaken(userId: string): Promise<string> {
  const bestaand = await db.pins.where('userId').equals(userId).first()
  if (!bestaand) {
    throw new Error('Stel eerst een persoonlijke code in; de badge hangt daaraan.')
  }

  // Lang en willekeurig: een badge wordt gescand, niet ingetoetst, dus
  // leesbaarheid is geen eis en raadbaarheid wel een risico.
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const token = 'TWB-' + hex(bytes.buffer).toUpperCase().slice(0, 24)

  const rij = { ...bestaand, badgeToken: token, updatedAt: Date.now() }
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

/* ------------------------------------------------------------------ *
 *  Te vaak misgetoetst
 *
 *  Zonder rem is zes cijfers aan een kassa met een rij ervoor nog steeds
 *  weinig: iemand die er lang genoeg staat, tikt ze allemaal. Vijf pogingen
 *  en dan een minuut wachten maakt dat onbegonnen werk, en hindert iemand die
 *  zich één keer vertikt niet.
 * ------------------------------------------------------------------ */

const MAX_POGINGEN = 5
const WACHTTIJD_MS = 60_000

const pogingenKey = (userId: string) => `pogingen:${userId}`

interface Pogingen { aantal: number; laatste: number }

async function pogingen(userId: string): Promise<Pogingen> {
  return getMeta<Pogingen>(pogingenKey(userId), { aantal: 0, laatste: 0 })
}

async function vergetenPogingen(userId: string) {
  await setMeta(pogingenKey(userId), { aantal: 0, laatste: 0 })
}

/** Hoeveel milliseconden iemand nog moet wachten. 0 = mag proberen. */
export async function wachttijd(userId: string): Promise<number> {
  const p = await pogingen(userId)
  if (p.aantal < MAX_POGINGEN) return 0
  return Math.max(0, WACHTTIJD_MS - (Date.now() - p.laatste))
}

/* ------------------------------------------------------------------ *
 *  Herkennen
 * ------------------------------------------------------------------ */

export type HerkenResultaat =
  | { ok: true; user: User }
  | { ok: false; reden: 'onbekend' | 'geblokkeerd' | 'geen-code' | 'inactief'; wachtMs?: number }

/**
 * Wie hoort bij deze code?
 *
 * De code alleen is niet genoeg om iemand te vinden -- twee mensen kunnen
 * dezelfde zes cijfers kiezen. Daarom kiest de medewerker eerst zijn naam en
 * toetst hij daarna zijn code. Dat is aan een kassa ook sneller dan een
 * personeelsnummer intoetsen.
 */
export async function herken(userId: string, code: string): Promise<HerkenResultaat> {
  const user = await db.users.get(userId)
  if (!user) return { ok: false, reden: 'onbekend' }
  if (!user.active) return { ok: false, reden: 'inactief' }

  const wacht = await wachttijd(userId)
  if (wacht > 0) return { ok: false, reden: 'geblokkeerd', wachtMs: wacht }

  const pin = await db.pins.where('userId').equals(userId).first()
  if (!pin) return { ok: false, reden: 'geen-code' }

  const afgeleid = await afleiden(code, pin.salt, pin.iterations || RONDES)
  if (!gelijk(afgeleid, pin.hash)) {
    const p = await pogingen(userId)
    await setMeta(pogingenKey(userId), {
      aantal: p.aantal + 1,
      laatste: Date.now(),
    })
    return { ok: false, reden: 'onbekend' }
  }

  await vergetenPogingen(userId)
  return { ok: true, user }
}

/** Wie hoort bij deze gescande badge? */
export async function herkenBadge(token: string): Promise<HerkenResultaat> {
  const pin = await db.pins.where('badgeToken').equals(token.trim()).first()
  if (!pin) return { ok: false, reden: 'onbekend' }
  const user = await db.users.get(pin.userId)
  if (!user) return { ok: false, reden: 'onbekend' }
  if (!user.active) return { ok: false, reden: 'inactief' }
  return { ok: true, user }
}

/** Heeft deze medewerker al een code? */
export async function heeftCode(userId: string): Promise<boolean> {
  return Boolean(await db.pins.where('userId').equals(userId).first())
}
