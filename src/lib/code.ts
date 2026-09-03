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
             | 'andere-vestiging' | 'geen-vestiging'
      wachtMs?: number
      /** Bij 'dubbel': wie er allemaal op dit nummer staan. */
      namen?: string[]
      /** Bij 'andere-vestiging': waar deze persoon dan wel hoort. */
      vestiging?: string
      /** En hoe hij heet, zodat de melding niet over een nummer gaat. */
      naam?: string
    }

/**
 * Wat er op het scherm komt als het aanmelden niet lukte.
 *
 * Op één plek, want het stond op twee -- in useAuth en in het klokscherm -- en
 * die twee waren al uit elkaar gelopen. Een melding die op de ene deur anders
 * luidt dan op de andere is een melding waar niemand op vertrouwt.
 */
export function herkenFout(uitslag: Extract<HerkenResultaat, { ok: false }>): string {
  switch (uitslag.reden) {
    case 'geblokkeerd':
      return `Te vaak misgetoetst. Probeer het over ${
        Math.ceil((uitslag.wachtMs ?? 0) / 1000)} seconden weer.`

    case 'inactief':
      return 'Deze medewerker staat niet meer op de loonlijst.'

    case 'dubbel':
      // Geen fout van wie er staat, dus zeggen we wat er aan de hand is en
      // waar het rechtgezet wordt.
      return `Dit nummer staat bij meer dan één medewerker (${
        (uitslag.namen ?? []).join(', ')}). Laat het in het dashboard onder ` +
        'Personeel rechtzetten; zolang het dubbel staat, komt de bon op de ' +
        'verkeerde naam.'

    case 'andere-vestiging':
      /*
       * Met naam en vestiging erbij. "Je mag hier niet" laat iemand het nog
       * drie keer proberen; "Ali Yildiz staat op Asten" is meteen duidelijk --
       * en als dat niet klopt, weet hij ook meteen wat er in het dashboard
       * verkeerd staat.
       */
      return `${uitslag.naam ?? 'Deze medewerker'} staat op ${
        uitslag.vestiging ?? 'een andere vestiging'} en kan daar aanmelden. ` +
        'Moet hij op meer vestigingen kunnen werken, dan zet het kantoor dat ' +
        'in zijn dossier.'

    case 'geen-vestiging':
      return `${uitslag.naam ?? 'Deze medewerker'} heeft geen vestiging in zijn ` +
        'dossier, dus weet de kassa niet of hij hier hoort. Dat zet het kantoor ' +
        'in het dashboard onder Personeel.'

    case 'geen-nummer':
      return 'Er staat geen personeelsnummer in dit dossier.'

    default:
      return 'Dat personeelsnummer is niet bekend op deze vestiging.'
  }
}

/* ------------------------------------------------------------------ *
 *  Op welke kassa mag iemand?
 *
 *  Wie op één vestiging staat, mag alleen de kassa van die vestiging. Wie
 *  overal mag werken, mag elke kassa.
 *
 *  Waarom dat er hoort te staan en niet vanzelf goed gaat: de kassa haalt het
 *  personeel van zijn eigen vestiging op, maar de beveiligingsregels laten ook
 *  dossiers zonder vestiging door -- die zijn "voor iedereen". En wie een
 *  nummer intoetst dat in die cache staat, kwam erin. Iemand van Asten die op
 *  de kassa in Rotterdam staat, klokt daar in, verkoopt daar, en zijn uren
 *  komen op de verkeerde vestiging terecht. Dat merkt niemand tot iemand de
 *  uren per vestiging naast elkaar legt.
 *
 *  Vier manieren waarop het mag, en die eerste is er alleen voor de zekerheid:
 *
 *   1. de kassa hangt (nog) niet aan een vestiging -- dan is er niets om aan
 *      te toetsen, en een kassa op slot zetten om ontbrekende gegevens is
 *      erger dan het gat;
 *   2. deze persoon mag overal werken (allLocations);
 *   3. hij staat op deze vestiging;
 *   4. hij heeft leiding over deze vestiging (manages).
 * ------------------------------------------------------------------ */

export type KassaToegang =
  | { ok: true }
  | { ok: false; reden: 'andere-vestiging' | 'geen-vestiging' }

export function magOpKassa(
  user: Pick<User, 'locationId' | 'manages' | 'allLocations'>,
  kassaLocatie: string | undefined | null,
): KassaToegang {
  if (!kassaLocatie) return { ok: true }
  if (user.allLocations) return { ok: true }
  if (user.locationId && user.locationId === kassaLocatie) return { ok: true }
  if ((user.manages ?? []).includes(kassaLocatie)) return { ok: true }

  /*
   * Geen vestiging in het dossier is iets anders dan de verkeerde vestiging,
   * en het hoort ook een andere melding te geven. Bij de verkeerde vestiging
   * staat iemand op de verkeerde plek; hier is het dossier niet af, en dat is
   * in het dashboard in tien seconden rechtgezet.
   *
   * Beide keren gaat de deur dicht. Zou "geen vestiging" wél binnenkomen, dan
   * is dat precies de opening die dit moet sluiten -- want de kassa heeft die
   * dossiers in zijn cache staan.
   */
  return { ok: false, reden: user.locationId ? 'andere-vestiging' : 'geen-vestiging' }
}

/** De naam van een vestiging, voor de melding. Valt terug op de code. */
export async function vestigingsNaam(id?: string): Promise<string | undefined> {
  if (!id) return undefined
  const l = await db.locations.get(id)
  return l?.name || l?.code || undefined
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
export async function herkenOpNummer(
  ingetoetst: string,
  /**
   * De vestiging van deze kassa. Weggelaten = niet toetsen; dat is er voor de
   * zelftest en voor een kassa die nog geen vestiging heeft.
   */
  kassaLocatie?: string,
): Promise<HerkenResultaat> {
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

  /*
   * Pas hier de vestiging toetsen, en niet bij het zoeken op nummer.
   *
   * Zou het nummer van iemand van een andere vestiging als "onbekend" gelden,
   * dan krijgt hij "dat nummer is niet bekend" te zien -- en dan staat hij het
   * opnieuw in te toetsen omdat hij denkt dat hij zich verkeken heeft. Nu
   * krijgt hij te horen wat er werkelijk aan de hand is.
   *
   * De rem op misgetoetste nummers blijft hier ook buiten: het nummer is juist
   * wél goed.
   */
  const toegang = magOpKassa(actief[0], kassaLocatie)
  if (!toegang.ok) {
    await gelukt()
    return {
      ok: false,
      reden: toegang.reden,
      naam: actief[0].name,
      vestiging: await vestigingsNaam(actief[0].locationId),
    }
  }

  await gelukt()
  return { ok: true, user: actief[0] }
}

/** Wie hoort bij deze gescande badge? */
export async function herkenBadge(
  token: string,
  kassaLocatie?: string,
): Promise<HerkenResultaat> {
  const pin = await db.pins.where('badgeToken').equals(token.trim()).first()
  if (!pin) return { ok: false, reden: 'onbekend' }
  const user = await db.users.get(pin.userId)
  if (!user) return { ok: false, reden: 'onbekend' }
  if (!user.active) return { ok: false, reden: 'inactief' }

  // Een badge is dezelfde deur als een nummer, dus dezelfde poort ervoor.
  const toegang = magOpKassa(user, kassaLocatie)
  if (!toegang.ok) {
    return {
      ok: false,
      reden: toegang.reden,
      naam: user.name,
      vestiging: await vestigingsNaam(user.locationId),
    }
  }

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
    // Een kassa heeft een eigen dossier, want daar hangt de vestiging aan.
    // Het is geen mens: hij heeft geen personeelsnummer en hoort dus niet in
    // de lijst "medewerkers zonder nummer" te staan.
    !u.isDevice &&
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
