import { Capacitor } from '@capacitor/core'
import { supabase } from './api'
import { db, getMeta, setMeta, uid } from './db'
import { enqueue, useSync } from './sync'
import { logLive } from './trail'
import type { PosDevice, PosRegister } from './types'

/* ------------------------------------------------------------------ *
 *  Dit apparaat koppelen aan een kassa
 *
 *  Hoe het ging: je logde op de kassa in met het account van een medewerker
 *  en maakte daar zelf een kassa aan. Dat werkt, en het heeft twee gaten. Op
 *  elke tablet achter de balie staat dan iemands wachtwoord, en het kantoor
 *  weet niet welke apparaten er meedoen -- dus kan het er ook niets aan doen
 *  als er een kwijtraakt.
 *
 *  Hoe het gaat: het kantoor maakt de kassa aan en zet er een code bij die
 *  één keer geldig is. Die code wordt hier ingetoetst. De serverfunctie
 *  kassa-koppelen geeft dit apparaat daarna zijn eigen inlog en zet het in een
 *  lijst waar het kantoor bij kan.
 *
 *  Wat daarmee kan, en waarom het zo is opgezet:
 *
 *  blokkeren    De kassa gaat op slot maar blijft synchroniseren. Dat is
 *               precies wat je wil als een tablet kwijt is terwijl de omzet
 *               van vandaag er nog op staat.
 *  intrekken    De kassa stuurt eerst zijn wachtrij leeg, wist daarna
 *               zichzelf en meldt dat terug. Pas daarna mag het account weg.
 *               Andersom zou de omzet die nog op dat apparaat stond nergens
 *               meer aankomen.
 * ------------------------------------------------------------------ */

const SLEUTEL_KEY = 'apparaatSleutel'
const APPARAAT_KEY = 'apparaatId'
const INLOG_KEY = 'apparaatInlog'

export const REGISTER_META = 'registerId'

/* ------------------------------------------------------------------ *
 *  De code
 * ------------------------------------------------------------------ */

/**
 * Streepjes en spaties eruit, kleine letters omhoog.
 *
 * Het dashboard toont de code in groepjes van vier omdat dat overtypen
 * makkelijker maakt. Wie die streepjes meetikt, hoort niet op een foutmelding
 * te stuiten. Dezelfde opschoning staat in de serverfunctie; ze horen bij
 * elkaar en mogen niet uit elkaar lopen.
 */
export function koppelcodeOpschonen(ruw: string): string {
  return (ruw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * Wat er mis is met deze code, of null.
 *
 * De letters I, L en O en de cijfers 0 en 1 zitten niet in het alfabet
 * waaruit codes worden gemaakt, juist omdat ze bij het overtypen door elkaar
 * gaan. Iemand die ze intikt heeft dus iets verkeerd gelezen, en dat is beter
 * hier te zeggen dan na een rondje langs de server.
 */
export function koppelcodeProbleem(code: string): string | null {
  if (!code) return 'Vul de code in die in het dashboard staat.'
  if (code.length < 8) return 'De code bestaat uit acht tekens.'
  if (code.length > 8) return 'De code bestaat uit acht tekens; dit zijn er meer.'
  const verward = code.match(/[ILO01]/g)
  if (verward) {
    const uniek = [...new Set(verward)].join(', ')
    return `In een koppelcode zit geen ${uniek}. Kijk nog eens: een O is een ` +
           'nul die er niet is, en een I of een L is meestal een 1 die er ook niet is.'
  }
  return null
}

/* ------------------------------------------------------------------ *
 *  Wat dit apparaat van zichzelf weet
 * ------------------------------------------------------------------ */

/**
 * Een eigen kenmerk voor dit apparaat, dat blijft staan.
 *
 * Waarom niet iets uit het apparaat zelf, zoals een serienummer: dat is er in
 * een browser en in een webview niet, en wat er wel is (schermmaat,
 * user-agent) verschilt tussen twee dezelfde tablets niet. Dus verzinnen we
 * er één keer een en bewaren die. Raakt hij kwijt, dan is dit voor de server
 * een nieuw apparaat -- en dan is een nieuwe code nodig. Dat is de bedoeling.
 */
export async function apparaatSleutel(): Promise<string> {
  const bestaand = await getMeta<string | null>(SLEUTEL_KEY, null)
  if (bestaand) return bestaand
  const nieuw = uid('app')
  await setMeta(SLEUTEL_KEY, nieuw)
  return nieuw
}

export function apparaatPlatform(): string {
  if (typeof window !== 'undefined' && window.desktop?.isElectron) {
    return 'windows'
  }
  return Capacitor.isNativePlatform() ? Capacitor.getPlatform() : 'web'
}

/** Een naam die in de lijst van het kantoor iets zegt. */
export function apparaatNaam(): string {
  const soort = apparaatPlatform()
  if (soort === 'windows') return 'Windows-kassa'
  if (soort === 'android') return 'Android-tablet'
  if (soort === 'ios') return 'iPad'
  return 'Browser'
}

/* ------------------------------------------------------------------ *
 *  Koppelen
 * ------------------------------------------------------------------ */

export interface KoppelUitslag {
  ok: boolean
  reden?: string
  register?: PosRegister
  vestiging?: { id: string; code: string; name: string } | null
  /** De inloggegevens van dit apparaat; die gaan hierna naar useAuth. */
  inlog?: { email: string; wachtwoord: string }
  apparaatId?: string
}

interface Antwoord {
  ok: boolean
  reden?: string
  apparaatId?: string
  email?: string
  wachtwoord?: string
  kassa?: {
    id: string
    code: string
    name: string
    locationId?: string
    printer?: unknown
    terminal?: unknown
    lastSeq?: number
    active?: boolean
  }
  vestiging?: { id: string; code: string; name: string } | null
}

/**
 * De code inwisselen.
 *
 * Dit is het enige moment waarop de kassa met de server praat zonder ingelogd
 * te zijn. De serverfunctie staat daarom open (--no-verify-jwt) en wordt door
 * de code zelf beschermd: acht tekens, één keer geldig, en hij verloopt.
 */
export async function koppelMetCode(ruweCode: string): Promise<KoppelUitslag> {
  const code = koppelcodeOpschonen(ruweCode)
  const probleem = koppelcodeProbleem(code)
  if (probleem) return { ok: false, reden: probleem }

  const sleutel = await apparaatSleutel()

  let antwoord: Antwoord | null = null
  try {
    const { data, error } = await supabase().functions.invoke<Antwoord>(
      'kassa-koppelen',
      {
        body: {
          code,
          apparaat: {
            sleutel,
            naam: apparaatNaam(),
            platform: apparaatPlatform(),
            versie: (import.meta as unknown as { env?: Record<string, string> })
              .env?.VITE_APP_VERSION ?? '',
          },
        },
      },
    )

    /*
     * De functie antwoordt met een uitleg in `reden`, ook bij een foutcode.
     * Supabase maakt daar een FunctionsHttpError van waarin die uitleg alleen
     * in het antwoord zit -- dus lezen we die eruit. Zonder dit staat er op de
     * kassa "Edge Function returned a non-2xx status code", en dan weet
     * niemand of de code verlopen is of dat de lijn eruit ligt.
     */
    if (error) {
      const uit = await leesFout(error)
      return { ok: false, reden: uit }
    }
    antwoord = data
  } catch (e) {
    return {
      ok: false,
      reden: 'De server is niet bereikbaar: ' +
             (e instanceof Error ? e.message : String(e)) +
             '. Koppelen kan alleen met internet; daarna werkt de kassa ook offline.',
    }
  }

  if (!antwoord?.ok || !antwoord.kassa || !antwoord.email || !antwoord.wachtwoord) {
    return { ok: false, reden: antwoord?.reden ?? 'Koppelen lukte niet.' }
  }

  const k = antwoord.kassa
  const register: PosRegister = {
    id: k.id,
    locationId: k.locationId,
    code: k.code,
    name: k.name || k.code,
    printer: (k.printer as PosRegister['printer']) ?? { kind: 'geen', breedte: 42 },
    terminal: (k.terminal as PosRegister['terminal']) ?? { provider: 'handmatig' },
    lastSeq: Number(k.lastSeq ?? 0),
    active: k.active !== false,
    updatedAt: Date.now(),
  }

  /*
   * De kassa staat meteen lokaal, vóór de eerste synchronisatie. Anders staat
   * de app na het koppelen op een wit scherm te wachten op gegevens, en dat
   * ziet uit als "het werkt niet".
   */
  await db.registers.put(register)
  await setMeta(REGISTER_META, register.id)
  if (antwoord.apparaatId) await setMeta(APPARAAT_KEY, antwoord.apparaatId)

  logLive('actie', `Gekoppeld aan kassa ${register.code}`)

  return {
    ok: true,
    register,
    vestiging: antwoord.vestiging ?? null,
    inlog: { email: antwoord.email, wachtwoord: antwoord.wachtwoord },
    apparaatId: antwoord.apparaatId,
  }
}

/** Haalt de uitleg uit een mislukte functieaanroep. */
async function leesFout(error: unknown): Promise<string> {
  const met = error as { context?: { json?: () => Promise<unknown> }; message?: string }
  try {
    const body = await met.context?.json?.()
    const reden = (body as { reden?: string } | undefined)?.reden
    if (reden) return reden
  } catch {
    /* geen leesbaar antwoord; dan de kale melding */
  }
  return met.message ?? 'Koppelen lukte niet.'
}

/* ------------------------------------------------------------------ *
 *  De inlog van dit apparaat bewaren
 *
 *  Ja, dat is een wachtwoord in de opslag van het apparaat. Dat is hier geen
 *  nieuw risico maar hetzelfde risico: Supabase bewaart al een vernieuwbare
 *  sleutel op dezelfde plek, en daarmee kom je net zo goed binnen.
 *
 *  Wat het oplevert is groot. Zonder dit is een kassa waarvan de opslag is
 *  opgeschoond -- of die twee weken uit heeft gestaan en zijn sessie kwijt is
 *  -- alleen weer aan de praat te krijgen met een nieuwe code van het
 *  kantoor. Op een zaterdagochtend is dat het verschil tussen doorwerken en
 *  wachten. En het account is niet dat van een mens: het is van dit apparaat,
 *  het mag alleen bij deze vestiging, en het kantoor kan het intrekken.
 * ------------------------------------------------------------------ */

export async function inlogBewaren(inlog: { email: string; wachtwoord: string }) {
  await setMeta(INLOG_KEY, inlog)
}

export async function bewaardeInlog(): Promise<{ email: string; wachtwoord: string } | null> {
  return getMeta<{ email: string; wachtwoord: string } | null>(INLOG_KEY, null)
}

/* ------------------------------------------------------------------ *
 *  Wat het kantoor van dit apparaat vindt
 * ------------------------------------------------------------------ */

export async function huidigApparaatId(): Promise<string | null> {
  return getMeta<string | null>(APPARAAT_KEY, null)
}

/**
 * De regel van dit apparaat, zoals hij nu in de cache staat.
 *
 * Undefined betekent "nog niet gekeken", null betekent "er is geen regel". Dat
 * onderscheid is nodig: een kassa die nog niet gesynchroniseerd heeft mag niet
 * op slot gaan omdat de lijst nog leeg is.
 */
export async function huidigApparaat(): Promise<PosDevice | null> {
  const id = await huidigApparaatId()
  if (!id) return null
  return (await db.devices.get(id)) ?? null
}

/** Meldt dat dit apparaat er nog is. Meer mag hij van zijn eigen regel niet. */
export async function apparaatGezien(): Promise<void> {
  const apparaat = await huidigApparaat()
  if (!apparaat || apparaat.status !== 'actief') return

  // Niet bij elke synchronisatie: één keer per uur is genoeg om te zien dat
  // een kassa nog meedoet, en het scheelt een rij in de wachtrij per ronde.
  const uur = 60 * 60_000
  if (apparaat.lastSeenAt && Date.now() - apparaat.lastSeenAt < uur) return

  const rij: PosDevice = { ...apparaat, lastSeenAt: Date.now(), updatedAt: Date.now() }
  await db.devices.put(rij)
  await enqueue('devices', 'put', rij.id, rij)
}

/* ------------------------------------------------------------------ *
 *  Op afstand eruit
 * ------------------------------------------------------------------ */

export interface IntrekkingStand {
  /** Hoeveel wijzigingen er nog naar de server moeten. */
  wachtrij: number
  /** Klaar om te wissen: de wachtrij is leeg. */
  klaar: boolean
}

export async function intrekkingStand(): Promise<IntrekkingStand> {
  const wachtrij = await db.outbox.count()
  return { wachtrij, klaar: wachtrij === 0 }
}

/**
 * Zichzelf wissen na een intrekking.
 *
 * Alleen als de wachtrij leeg is. Een kassa die zich wist terwijl er nog een
 * bon in de wachtrij staat, gooit omzet weg -- en dat is precies wat deze hele
 * opzet in twee stappen moet voorkomen.
 *
 * Wat blijft staan: het kenmerk van dit apparaat. Zo komt hetzelfde apparaat
 * na een nieuwe code niet als tweede in de lijst.
 */
export async function apparaatWissen(): Promise<{ ok: boolean; reden?: string }> {
  const { klaar, wachtrij } = await intrekkingStand()
  if (!klaar) {
    return {
      ok: false,
      reden: `Er wachten nog ${wachtrij} wijziging(en) op verzending. Die gaan ` +
             'eerst; daarna wist de kassa zich vanzelf.',
    }
  }

  const apparaat = await huidigApparaat()
  if (apparaat && !apparaat.wipedAt) {
    /*
     * Eerst terugmelden, dan wissen. Zou het andersom gaan, dan weet het
     * kantoor niet of het account weg mag -- en dan blijft er een inlog
     * bestaan die niemand meer gebruikt.
     */
    const rij: PosDevice = { ...apparaat, wipedAt: Date.now(), updatedAt: Date.now() }
    await db.devices.put(rij)
    await enqueue('devices', 'put', rij.id, rij)
    await useSync.getState().sync({ silent: true })
  }

  await Promise.all([
    db.users.clear(), db.companies.clear(), db.washJobs.clear(),
    db.inventory.clear(), db.locations.clear(),
    db.registers.clear(), db.products.clear(),
    db.sales.clear(), db.saleLines.clear(), db.payments.clear(),
    db.cashSessions.clear(), db.cashMoves.clear(),
    db.subscriptions.clear(), db.subscriptionUses.clear(),
    db.pins.clear(), db.timeEntries.clear(), db.stockMovements.clear(),
    db.safes.clear(), db.safeMoves.clear(), db.devices.clear(),
  ])

  await db.meta.delete(REGISTER_META)
  await db.meta.delete(APPARAAT_KEY)
  await db.meta.delete(INLOG_KEY)

  logLive('actie', 'Dit apparaat is op afstand ingetrokken en heeft zich gewist')
  return { ok: true }
}
