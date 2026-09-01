import { db, tijdstempel, uid } from './db'
import { centen } from './geld'
import { kasMutatie, openSessie } from './kas'
import {
  type Munten, muntenAantal, muntenBedrag, muntenOpschonen, muntenOptellen,
  muntenPassen, muntenTekst,
} from './munten'
import { enqueue } from './sync'
import { logLive } from './trail'
import type {
  KluisSoort, PosRegister, PosSafe, PosSafeMove, User,
} from './types'
import { KLUIS_LABELS, KLUIS_TEKEN } from './types'

/* ------------------------------------------------------------------ *
 *  De kluis
 *
 *  Twee regels, en ze verklaren alles wat hieronder staat.
 *
 *  1. Er wordt geteld, niet ingetikt. Elke beweging is een stapel briefjes en
 *     munten; het bedrag volgt daaruit. Zie munten.ts voor waarom dat de kern
 *     is en niet een aardigheidje in de vormgeving.
 *
 *  2. Het saldo is een som, geen veld. Vanaf de laatste telling optellen, en
 *     zonder telling vanaf nul. Zo kunnen twee mensen offline tegelijk iets
 *     uit de kluis halen zonder elkaars saldo te overschrijven -- hetzelfde
 *     principe als bij het saldo van een strippenkaart.
 *
 *  Die telling is meer dan een controle: hij is het ijkpunt. Wat ervoor
 *  gebeurde telt niet meer mee in het saldo, en het verschil blijft staan
 *  zoals het die avond is vastgesteld. Zou de app het verschil wegrekenen,
 *  dan is een kluis die structureel tien euro mist niet te onderscheiden van
 *  een kluis die klopt.
 *
 *  Het geld gaat bijna nooit alleen de kluis in of uit. Een afstorting gaat
 *  uít de kassalade, wisselgeld gaat erín. Daarom staan die twee hieronder als
 *  één handeling die beide boeken bijwerkt: doe je het los, dan is de kluis
 *  bij en de lade niet, en dan klopt de dagafsluiting niet meer.
 * ------------------------------------------------------------------ */

/** De kluis van deze vestiging, of null als het dashboard er nog geen heeft. */
export async function kluisVanLocatie(locationId?: string): Promise<PosSafe | null> {
  const alles = await db.safes.toArray()
  const actief = alles.filter((k) => k.active)
  if (locationId) {
    const eigen = actief.find((k) => k.locationId === locationId)
    if (eigen) return eigen
  }
  // Een kluis zonder vestiging bestaat niet in het dashboard, maar een kassa
  // zonder vestiging wel. Dan liever de enige kluis die er is dan niets.
  return actief.length === 1 ? actief[0] : null
}

export interface KluisStand {
  kluis: PosSafe
  /** Wat er hoort te liggen, per briefje en munt. */
  munten: Munten
  bedrag: number
  /** Alle boekingen, nieuwste eerst. */
  boekingen: PosSafeMove[]
  /** De telling die nu het ijkpunt is, als er een is. */
  laatsteTelling?: PosSafeMove
  /** Hoeveel boekingen er sinds die telling bij zijn gekomen. */
  sindsTelling: number
}

/**
 * Wat er in de kluis hoort te liggen.
 *
 * Uit de lokale cache, want dit moet ook zonder internet kloppen. Een kluis
 * open je niet minder vaak als de lijn eruit ligt.
 */
export async function kluisStand(safeId: string): Promise<KluisStand | null> {
  const kluis = await db.safes.get(safeId)
  if (!kluis) return null

  /*
   * Sorteren op tijd, en bij gelijke tijd op id.
   *
   * Dat tweede is geen nettigheid. Eerst stond hier alleen de tijd, en werd
   * daarna alles meegeteld met `at > tijd van de telling`. Een boeking in
   * dezelfde milliseconde als de telling viel daardoor weg: tel je de kluis en
   * boek je meteen daarna een uitgave, dan bleef die uitgave buiten het saldo
   * -- geen foutmelding, alleen een bedrag dat niet klopt. De zelftest ving het
   * omdat hij snel genoeg is om binnen één milliseconde te tellen en te boeken;
   * met de hand duurt dat langer, maar twee kassa's die offline tegelijk boeken
   * hebben dat probleem wel.
   *
   * Het id als tweede sleutel maakt de volgorde op elke kassa dezelfde. Dat is
   * willekeurig maar niet toevallig: overal willekeurig op dezelfde manier is
   * precies wat je nodig hebt.
   */
  const alles = (await db.safeMoves.where('safeId').equals(safeId).toArray())
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))

  /*
   * De laatste telling is het ijkpunt, en "laatste" is nu een plaats in de
   * lijst en geen tijdstip. Alles wat daarna komt telt mee.
   */
  let plaats = -1
  for (let i = 0; i < alles.length; i++) {
    if (alles[i].soort === 'telling' && alles[i].counted) plaats = i
  }

  const telling = plaats >= 0 ? alles[plaats] : undefined
  const na = alles.slice(plaats + 1).filter((m) => m.soort !== 'telling')

  let munten: Munten = telling?.counted ? { ...telling.counted } : {}
  for (const m of na) {
    munten = muntenOptellen(munten, m.coins, KLUIS_TEKEN[m.soort])
  }

  return {
    kluis,
    munten,
    bedrag: muntenBedrag(munten),
    boekingen: [...alles].reverse(),
    laatsteTelling: telling,
    sindsTelling: na.length,
  }
}

/* ------------------------------------------------------------------ *
 *  Boeken
 * ------------------------------------------------------------------ */

async function bewaar(boeking: PosSafeMove): Promise<PosSafeMove> {
  await db.safeMoves.put(boeking)
  await enqueue('safeMoves', 'put', boeking.id, boeking)
  logLive('actie', `Kluis: ${KLUIS_LABELS[boeking.soort]} — ${
    boeking.soort === 'telling'
      ? muntenTekst(boeking.counted)
      : muntenTekst(boeking.coins)}`)
  return boeking
}

export interface KluisBoekingOpties {
  kluis: PosSafe
  soort: Exclude<KluisSoort, 'telling'>
  munten: Munten
  reden?: string
  door: Pick<User, 'id' | 'name'>
  /** Bij afstorting en wisselgeld: uit of naar welke lade. */
  sessionId?: string
  registerId?: string
}

/**
 * Eén beweging in de kluis.
 *
 * Wat eruit gaat kan niet meer zijn dan er ligt. Dat is niet alleen netjes:
 * zonder die rem staat er morgen een negatief aantal briefjes van vijftig in
 * de administratie, en dan is er geen manier meer om te zien waar het misging.
 */
export async function kluisBoeken(opts: KluisBoekingOpties): Promise<PosSafeMove> {
  const munten = muntenOpschonen(opts.munten)
  if (muntenAantal(munten) === 0) {
    throw new Error('Tik aan welke briefjes en munten er in of uit gaan.')
  }

  const teken = KLUIS_TEKEN[opts.soort]

  if (teken < 0) {
    const stand = await kluisStand(opts.kluis.id)
    const { ok, tekort } = muntenPassen(stand?.munten ?? {}, munten)
    if (!ok) {
      throw new Error(
        `Dat ligt er niet in: ${muntenTekst(tekort)} te weinig. Tel de kluis ` +
        'als het er wél in ligt — dan klopt de administratie weer met de kluis.',
      )
    }
  }

  const nu = tijdstempel()
  return bewaar({
    id: uid('kluis'),
    safeId: opts.kluis.id,
    locationId: opts.kluis.locationId,
    soort: opts.soort,
    coins: munten,
    amount: centen(muntenBedrag(munten) * teken),
    sessionId: opts.sessionId,
    registerId: opts.registerId,
    reason: (opts.reden ?? '').trim() || KLUIS_LABELS[opts.soort],
    userId: opts.door.id,
    userName: opts.door.name,
    at: nu,
    updatedAt: nu,
  })
}

/* ------------------------------------------------------------------ *
 *  De lade en de kluis in één handeling
 * ------------------------------------------------------------------ */

/**
 * Geld uit de kassalade naar de kluis.
 *
 * Twee boekingen die bij elkaar horen: eraf bij de lade, erbij in de kluis.
 * Lokaal in één transactie, want de ene zonder de andere is erger dan geen
 * van beide -- dan lijkt er geld verdwenen te zijn.
 *
 * Naar de server gaan ze los, via de wachtrij. Dat mag: de server telt ze
 * allebei op bij hun eigen boek, en de volgorde maakt daar niets uit.
 */
export async function afstortenNaarKluis(opts: {
  kluis: PosSafe
  register: PosRegister
  munten: Munten
  door: User
  reden?: string
}): Promise<{ boeking: PosSafeMove; bedrag: number }> {
  const munten = muntenOpschonen(opts.munten)
  const bedrag = muntenBedrag(munten)
  if (bedrag <= 0) throw new Error('Tik aan welke briefjes en munten je afstort.')

  const sessie = await openSessie(opts.register.id)
  if (!sessie) {
    throw new Error(
      'Er staat geen kassadag open op deze kassa. Open eerst de lade onder Kas; ' +
      'anders is er geen dag om deze afstorting van af te halen.',
    )
  }

  const reden = (opts.reden ?? '').trim()
    || `Naar de kluis (${muntenTekst(munten)})`

  const boeking = await db.transaction(
    'rw', db.cashMoves, db.safes, db.safeMoves, db.outbox,
    async () => {
      await kasMutatie({
        sessionId: sessie.id,
        kind: 'afstorting',
        bedrag,
        reden,
        door: opts.door,
      })

      return kluisBoeken({
        kluis: opts.kluis,
        soort: 'afstorting',
        munten,
        reden: `Uit ${opts.register.code}`,
        door: opts.door,
        sessionId: sessie.id,
        registerId: opts.register.id,
      })
    })

  return { boeking, bedrag }
}

/**
 * Wisselgeld uit de kluis naar de kassalade.
 *
 * De andere kant op, en met dezelfde koppeling. Hier bijt de rem uit
 * kluisBoeken: je kunt geen vier rollen munten van twee euro halen als er
 * drie in de kluis liggen.
 */
export async function wisselgeldUitKluis(opts: {
  kluis: PosSafe
  register: PosRegister
  munten: Munten
  door: User
  reden?: string
}): Promise<{ boeking: PosSafeMove; bedrag: number }> {
  const munten = muntenOpschonen(opts.munten)
  const bedrag = muntenBedrag(munten)
  if (bedrag <= 0) throw new Error('Tik aan welk wisselgeld je meeneemt.')

  const sessie = await openSessie(opts.register.id)
  if (!sessie) {
    throw new Error(
      'Er staat geen kassadag open op deze kassa. Open eerst de lade onder Kas, ' +
      'anders komt dit wisselgeld nergens in de telling terecht.',
    )
  }

  const boeking = await db.transaction(
    'rw', db.cashMoves, db.safes, db.safeMoves, db.outbox,
    async () => {
      /*
       * Eerst uit de kluis, en niet omgekeerd. Die kant kan weigeren -- er
       * ligt misschien niet wat je aantikte. Zou de lade voorop gaan, dan
       * stond er in het slechtste geval geld in de lade dat nooit uit de
       * kluis kwam. De transactie draait het weliswaar terug, maar de
       * volgorde die ook zonder die redding klopt, is de betere.
       */
      const uit = await kluisBoeken({
        kluis: opts.kluis,
        soort: 'wisselgeld',
        munten,
        reden: (opts.reden ?? '').trim() || `Naar ${opts.register.code}`,
        door: opts.door,
        sessionId: sessie.id,
        registerId: opts.register.id,
      })

      await kasMutatie({
        sessionId: sessie.id,
        kind: 'inleg',
        bedrag,
        reden: `Wisselgeld uit de kluis (${muntenTekst(munten)})`,
        door: opts.door,
      })

      return uit
    })

  return { boeking, bedrag }
}

/* ------------------------------------------------------------------ *
 *  Tellen
 * ------------------------------------------------------------------ */

/**
 * De kluis tellen.
 *
 * Wat er geteld is, is vanaf nu het saldo. Het verschil met wat er hoorde te
 * liggen wordt vastgelegd en niet weggerekend: een kluis die elke maand tien
 * euro mist, is iets anders dan een kluis die klopt, en dat verschil hoort
 * zichtbaar te blijven.
 */
export async function kluisTellen(opts: {
  kluis: PosSafe
  geteld: Munten
  door: Pick<User, 'id' | 'name'>
  note?: string
}): Promise<{ boeking: PosSafeMove; verschil: number; verwacht: number }> {
  const stand = await kluisStand(opts.kluis.id)
  const verwacht = stand?.bedrag ?? 0

  const geteld = muntenOpschonen(opts.geteld)
  const bedrag = muntenBedrag(geteld)
  const verschil = centen(bedrag - verwacht)

  const nu = tijdstempel()
  const boeking = await bewaar({
    id: uid('kluis'),
    safeId: opts.kluis.id,
    locationId: opts.kluis.locationId,
    soort: 'telling',
    coins: {},
    counted: geteld,
    // Een telling verplaatst geen geld; hij stelt vast wat er ligt. Het
    // verschil staat apart, zodat het optellen van bewegingen niet ineens
    // een correctie bevat die niemand geboekt heeft.
    amount: 0,
    expected: verwacht,
    difference: verschil,
    reason: (opts.note ?? '').trim() || 'Kluis geteld',
    userId: opts.door.id,
    userName: opts.door.name,
    at: nu,
    updatedAt: nu,
  })

  return { boeking, verschil, verwacht }
}

/* ------------------------------------------------------------------ *
 *  Hoe lang is er niet geteld?
 * ------------------------------------------------------------------ */

/** Na zoveel stilte hoort er iets in beeld te komen. */
export const TEL_HERINNERING_MS = 30 * 24 * 60 * 60_000

export function telHerinnering(stand: KluisStand | null): string | null {
  if (!stand) return null
  if (!stand.laatsteTelling) {
    return stand.boekingen.length === 0
      ? null
      : 'Deze kluis is nog nooit geteld. Tot de eerste telling is het saldo ' +
        'niets meer dan de som van wat er geboekt is.'
  }
  const stil = Date.now() - stand.laatsteTelling.at
  if (stil < TEL_HERINNERING_MS) return null
  const dagen = Math.floor(stil / 86_400_000)
  return `De kluis is ${dagen} dagen niet geteld. Zonder telling weet niemand ` +
         'of de administratie nog met de kluis klopt.'
}
