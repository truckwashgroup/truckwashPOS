import { entiteitAantal, type EntityName, type OutboxRecord } from './types'

/* ------------------------------------------------------------------ *
 *  Wat er vastzit, en hoe je dat aan de balie zegt
 *
 *  De aanleiding staat in sync.ts: een inklokking verdween omdat de server hem
 *  weigerde op de rechten. Dat is daar rechtgezet -- zo'n weigering gooit niets
 *  meer weg. Maar daarmee is het probleem maar half opgelost, want een regel die
 *  voor altijd in de wachtrij blijft staan is óók onzichtbaar.
 *
 *  En bij uren is onzichtbaar het echte probleem. Wie zijn uren kwijtraakt,
 *  hoort dat op de dag zelf te merken -- dan weet hij nog hoe lang hij er stond
 *  en kan het rechtgezet worden. Aan het eind van de maand is het zijn woord
 *  tegen een lege urenstaat.
 *
 *  Dit bestand is daarom alleen rekenwerk: van een wachtrij naar één stand die
 *  het scherm kan laten zien. Zonder database eromheen, zodat de zelftest erbij
 *  kan -- want een melding die niet komt is net zo stil als geen melding.
 * ------------------------------------------------------------------ */

export interface VastStand {
  /** Alles wat op verzending wacht, ook wat gewoon nog niet geweest is. */
  totaal: number
  /** Wat is geweigerd om iets wat los van het record staat. */
  vast: number
  /** Hoeveel daarvan in- of uitklokkingen zijn. */
  uren: number
  /** Sinds wanneer het oudste vastzittende record er staat. */
  sindsMs: number | null
  /** De laatste weigering, zoals de server hem gaf. */
  reden: string | null
  /** Welke soorten er vastzitten, aflopend op aantal. */
  entiteiten: { entiteit: EntityName; aantal: number }[]
}

export const LEEG: VastStand = {
  totaal: 0, vast: 0, uren: 0, sindsMs: null, reden: null, entiteiten: [],
}

/**
 * Een record zit vast als het geweigerd is om iets wat er los van staat.
 *
 * Niet "heeft een fout gehad": een gewone fout hoort erbij en gaat over. Deze
 * teller wordt in sync.ts alleen gevuld bij de vier weigeringen die niets over
 * het record zeggen -- rechten, sessie, tabel, kolom.
 */
export const zitVast = (r: OutboxRecord): boolean => (r.geweigerd ?? 0) > 0

export function vatWachtrij(rijen: OutboxRecord[]): VastStand {
  const vast = rijen.filter(zitVast)
  if (!vast.length) return { ...LEEG, totaal: rijen.length }

  const perSoort = new Map<EntityName, number>()
  for (const r of vast) perSoort.set(r.entity, (perSoort.get(r.entity) ?? 0) + 1)

  /*
   * De oudste, en niet de nieuwste. "Staat vast sinds kwart over negen" zegt
   * hoe lang het al mis is; "sinds twee minuten" zegt alleen dat het nog mis
   * is, en dat wist je al doordat de melding er staat.
   */
  const oudste = vast.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b))

  return {
    totaal: rijen.length,
    vast: vast.length,
    uren: perSoort.get('timeEntries') ?? 0,
    sindsMs: oudste.createdAt,
    reden: oudste.lastError ?? null,
    entiteiten: [...perSoort.entries()]
      .map(([entiteit, aantal]) => ({ entiteit, aantal }))
      .sort((a, b) => b.aantal - a.aantal),
  }
}

/* ------------------------------------------------------------------ *
 *  En hoe dat op het scherm komt
 * ------------------------------------------------------------------ */

/**
 * De korte tekst voor de balk bovenaan.
 *
 * Uren worden bij naam genoemd en de rest niet, en dat is een keuze: uren zijn
 * het enige in de kassa dat aan één persoon toebehoort. Een bon die vastzit is
 * een probleem van de zaak; een inklokking die vastzit is het loon van degene
 * die ernaar kijkt.
 */
export function vastKort(stand: VastStand): string | null {
  if (stand.vast === 0) return null
  if (stand.uren > 0) {
    return stand.uren === 1 ? '1 klokregel vast' : `${stand.uren} klokregels vast`
  }
  return stand.vast === 1 ? '1 regel vast' : `${stand.vast} regels vast`
}

/**
 * Het hele verhaal, voor de melding in beeld.
 *
 * Wat er moet staan: wat er vastzit, sinds wanneer, en wat er nu te doen valt.
 * Dat laatste vooral -- iemand achter een balie kan niets met een foutmelding,
 * maar wel met "meld het aan het kantoor, en schrijf op hoe lang je er stond".
 */
export function vastVerhaal(stand: VastStand, nu = Date.now()): string | null {
  if (stand.vast === 0) return null

  const stukken: string[] = []

  if (stand.uren > 0) {
    stukken.push(stand.uren === 1
      ? 'Er staat 1 in- of uitklokking die de administratie niet heeft aangenomen.'
      : `Er staan ${stand.uren} in- en uitklokkingen die de administratie niet heeft aangenomen.`)
  }

  const anders = stand.vast - stand.uren
  if (anders > 0) {
    const soorten = stand.entiteiten
      .filter((e) => e.entiteit !== 'timeEntries')
      .map((e) => entiteitAantal(e.entiteit, e.aantal))

    // "1 bonregel en 2 bonnen" leest als een zin; "1 bonregel, 2 bonnen" als
    // een lijstje uit een database.
    const opsomming = soorten.length === 1
      ? soorten[0]
      : `${soorten.slice(0, -1).join(', ')} en ${soorten[soorten.length - 1]}`

    stukken.push(`Verder ${anders === 1 ? 'blijft' : 'blijven'} er ${opsomming} staan.`)
  }

  if (stand.sindsMs) {
    const minuten = Math.max(0, Math.round((nu - stand.sindsMs) / 60_000))
    stukken.push(minuten < 60
      ? `De oudste staat er ${minuten} minuut${minuten === 1 ? '' : 'en'}.`
      : `De oudste staat er ${Math.floor(minuten / 60)} uur en ${minuten % 60} minuten.`)
  }

  /*
   * Niets is weggegooid, en dat hoort er expliciet bij te staan. Zonder die
   * regel leest deze melding als "je uren zijn kwijt" en gaat iemand ze op een
   * briefje bijhouden -- terwijl ze er nog zijn en alsnog meegaan.
   */
  stukken.push(
    'Er is niets weggegooid: zodra het kantoor het rechtzet, gaat dit alsnog ' +
    'mee. Meld het wel, en schrijf op hoe lang je er vandaag stond.')

  return stukken.join(' ')
}
