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

/**
 * Welke versie hier draait.
 *
 * Het versienummer wordt tijdens het bouwen ingebakken (zie vite.config.ts).
 * Hier stond `import.meta.env.VITE_APP_VERSION`, en die variabele bestaat
 * niet -- niet in .env, niet in de workflow, nergens. Dus stuurde elke kassa
 * bij het koppelen een lege versie mee, en stond in het dashboard bij alle
 * apparaten niets. Precies het soort fout dat blijft zitten: er is geen
 * foutmelding, alleen een kolom die altijd leeg is.
 *
 * De `typeof`-omweg is er voor de zelftest: die draait in Node, waar Vite niet
 * langs is geweest en de constante dus niet bestaat.
 */
export function apparaatVersie(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
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
            versie: apparaatVersie(),
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

/**
 * Wat er van een mislukte functieaanroep aan de gebruiker verteld wordt.
 *
 * Los gezet en zonder netwerk eromheen, zodat de zelftest erbij kan -- want
 * hier ging het één keer mis en dat was geen kleinigheid. Er stond alleen "pak
 * `reden` uit het antwoord", en dat werkt zolang het antwoord van onze eigen
 * functie komt. Kwam het van de poort ervoor, omdat de functie niet uitgerold
 * was, dan stond er op de kassa "Edge Function returned a non-2xx status code".
 * Dat is geen melding maar een raadsel: je weet niet of de code verlopen is, of
 * de lijn eruit ligt, of er iets op de server mist -- en het lag aan het
 * laatste.
 */
export function foutUitleg(input: {
  status?: number
  /** Het antwoord als het leesbare JSON was. */
  body?: unknown
  /** Het antwoord als platte tekst, als het geen JSON was. */
  plat?: string
  /** Wat de bibliotheek er zelf van maakte. */
  message?: string
}): string {
  const veld = (naam: string) => {
    const v = (input.body as Record<string, unknown> | null | undefined)?.[naam]
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }

  // Onze eigen functie legt het altijd uit in `reden`. Die gaat voor alles.
  const eigen = veld('reden')
  if (eigen) return eigen

  if (input.status === 404) {
    return 'De serverfunctie "kassa-koppelen" staat nog niet op de server. Dat ' +
           'is geen fout in de code die je intikte. Laat hem uitrollen met ' +
           '"npm run functions" in de dashboard-map; daarna werkt koppelen meteen.'
  }

  if (input.status === 401 || input.status === 403) {
    return `De server weigert dit verzoek al voordat het bij de functie is (code ${
      input.status}). Dat betekent bijna altijd dat kassa-koppelen is uitgerold ` +
      'zonder --no-verify-jwt: een kassa die nog niet gekoppeld is heeft geen ' +
      'inlog, dus die deur moet open staan. Rol hem opnieuw uit met ' +
      '"npm run functions".'
  }

  const anders = veld('message') ?? veld('error') ?? veld('msg')
  const plat = input.plat && input.plat.length < 200 ? input.plat.trim() : null
  const kern = anders ?? plat ?? input.message

  return `Koppelen lukte niet${input.status ? ` (code ${input.status})` : ''}: ${
    kern ?? 'de server gaf geen uitleg'}.`
}

/** Leest het antwoord van een mislukte aanroep uit en laat foutUitleg praten. */
async function leesFout(error: unknown): Promise<string> {
  const met = error as {
    context?: { status?: number; text?: () => Promise<string> }
    message?: string
  }

  let plat = ''
  let body: unknown = null
  try {
    /*
     * Als tekst ophalen en daarna zelf ontleden. Het antwoord kan maar één keer
     * gelezen worden; probeer je json() en mislukt dat, dan is text() daarna
     * leeg -- en dan heb je niets meer om te laten zien.
     */
    plat = (await met.context?.text?.()) ?? ''
    if (plat) body = JSON.parse(plat)
  } catch {
    /* geen JSON; dan blijft de platte tekst over */
  }

  return foutUitleg({ status: met.context?.status, body, plat, message: met.message })
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

/**
 * Bijhouden dat deze kassa er nog is, en op welke versie hij staat.
 *
 * Die versie stond er eerst niet bij, en dat maakte het bijwerken
 * oncontroleerbaar: je kon in het dashboard wel zien dat een kassa nog meedeed,
 * maar niet of hij achterliep. Bij een systeem dat zichzelf bijwerkt is dat
 * juist het enige wat je wilt kunnen nakijken -- "hij doet het vanzelf" is een
 * bewering tot je het ziet.
 *
 * De versie komt liefst van buiten mee: op Windows is dat het nummer dat
 * electron kent en op Android dat uit de APK zelf, en die kunnen bij een half
 * gelukte update afwijken van de webbundel. Juist dan wil je weten wat er
 * daadwerkelijk draait.
 */
export async function apparaatGezien(versie?: string): Promise<void> {
  const apparaat = await huidigApparaat()
  if (!apparaat || apparaat.status !== 'actief') return

  const nu = apparaatVersie()
  const draait = (versie || nu || '').slice(0, 40)
  const soort = apparaatPlatform()

  /*
   * Niet bij elke synchronisatie: één keer per uur is genoeg om te zien dat
   * een kassa nog meedoet, en het scheelt een rij in de wachtrij per ronde.
   *
   * Maar een nieuwe versie of een ander soort apparaat wacht dat uur niet uit.
   * Na een update herstart de kassa, en dan is dit de eerste ronde -- zou hij
   * dan afhaken op de klok, dan staat er tot een uur later een versienummer in
   * het dashboard dat niet meer klopt. Dat is precies het moment waarop iemand
   * kijkt.
   */
  const uur = 60 * 60_000
  const veranderd = draait !== (apparaat.appVersion ?? '') || soort !== apparaat.platform
  if (!veranderd && apparaat.lastSeenAt && Date.now() - apparaat.lastSeenAt < uur) return

  const rij: PosDevice = {
    ...apparaat,
    appVersion: draait || undefined,
    platform: soort,
    lastSeenAt: Date.now(),
    updatedAt: Date.now(),
  }
  await db.devices.put(rij)
  await enqueue('devices', 'put', rij.id, rij)
}

/* ------------------------------------------------------------------ *
 *  Eruit: op afstand, of hier aan de kassa zelf
 *
 *  Twee wegen naar dezelfde plek, en de tweede is er omdat de eerste niet
 *  altijd kan. Op afstand intrekken werkt alleen als er iemand achter een
 *  dashboard zit; staat er een kassa die verhuisd is of opnieuw ingericht moet
 *  worden, dan moet dat ook aan de balie kunnen -- zonder dat er iemand met
 *  SQL aan de database komt.
 *
 *  Wat in beide gevallen hetzelfde is: de wachtrij gaat voor. Een kassa die
 *  zich wist terwijl er nog een bon in staat, gooit omzet weg die nergens
 *  anders bestaat.
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
 * Mag dit apparaat nu leeggemaakt worden, of niet?
 *
 * Apart gezet en zonder database eromheen, zodat de zelftest erbij kan. Dit is
 * de rem die voorkomt dat er omzet verdwijnt, en een rem die je niet kunt
 * testen is geen rem.
 */
export function ontkoppelBezwaar(wachtrij: number, forceren = false): string | null {
  if (wachtrij === 0) return null
  if (forceren) return null
  return `Er ${wachtrij === 1 ? 'wacht nog 1 wijziging' : `wachten nog ${wachtrij} wijzigingen`} ` +
         'op verzending. Daar kan omzet in zitten die nergens anders staat, dus die ' +
         'gaat eerst de deur uit.'
}

export interface WisOpties {
  /**
   * Terugmelden aan het kantoor dat dit apparaat zich gewist heeft.
   *
   * Alleen bij een intrekking. Bij ontkoppelen aan de balie niet: dan is er
   * geen intrekking om af te melden, en zou het kantoor een apparaat als
   * "afgemeld" zien terwijl het er nooit uit gezet is.
   */
  melden?: boolean
  /**
   * Doorzetten terwijl er nog een wachtrij is, en die weggooien.
   *
   * Alleen voor het geval dat een kassa de server niet meer kan bereiken en er
   * toch iets moet gebeuren. Wat erin staat is dan echt weg -- vandaar dat het
   * scherm er een aparte bevestiging voor vraagt en het hier in het logboek
   * komt.
   */
  forceren?: boolean
}

/**
 * Dit apparaat leegmaken.
 *
 * Wat blijft staan: het kenmerk van dit apparaat (apparaatSleutel). Zo herkent
 * de server hem na een nieuwe code als hetzelfde apparaat, en komt hij niet
 * als tweede in de lijst te staan -- en dat is precies wat de database
 * tegenhoudt, dus zonder dat zou hetzelfde apparaat zich niet opnieuw kunnen
 * koppelen aan dezelfde kassa.
 */
export async function wisApparaat(opties: WisOpties = {}): Promise<{ ok: boolean; reden?: string }> {
  const { wachtrij } = await intrekkingStand()
  const bezwaar = ontkoppelBezwaar(wachtrij, opties.forceren)
  if (bezwaar) return { ok: false, reden: bezwaar }

  if (opties.melden) {
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
  }

  if (opties.forceren && wachtrij > 0) {
    /*
     * Hardop, en op een plek waar het terug te vinden is. Dit is het enige
     * moment in de hele kassa waarop er met opzet iets uit de administratie
     * verdwijnt.
     */
    logLive('waarschuwing',
      `${wachtrij} niet-verstuurde wijziging(en) weggegooid bij het ontkoppelen`)
    await db.outbox.clear()
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
  await useSync.getState().refreshPending()

  logLive('actie', opties.melden
    ? 'Dit apparaat is op afstand ingetrokken en heeft zich gewist'
    : 'Deze kassa is aan de balie ontkoppeld')
  return { ok: true }
}

/** Zichzelf wissen na een intrekking van het kantoor. Zie OpSlot. */
export const apparaatWissen = () => wisApparaat({ melden: true })
