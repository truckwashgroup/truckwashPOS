import { centen } from './geld'

/* ------------------------------------------------------------------ *
 *  Briefjes en munten
 *
 *  De kluis rekent niet met bedragen maar met wat er fysiek ligt. Dat is de
 *  hele reden dat dit bestand bestaat, dus het is het waard om op te schrijven
 *  waarom:
 *
 *  Wie 340 euro afstort, legt drie briefjes van honderd en twee van twintig
 *  neer. Tikt hij "340" in, dan is er geen enkele manier om er later achter te
 *  komen dat er 240 lag. Tikt hij de briefjes aan, dan telt de kassa het
 *  bedrag uit -- en die kan zich niet vertikken.
 *
 *  Het maakt bovendien het tellen mogelijk. "Er hoort 310 in de kluis te
 *  liggen" is een getal waar je niets mee kunt; "er hoort drie keer honderd en
 *  één keer tien te liggen" leg je naast elkaar en dan zie je meteen wat
 *  ontbreekt.
 *
 *  De sleutels zijn b<euro> voor briefjes en m<cent> voor munten. Let op het
 *  verschil tussen b5 (het briefje van vijf) en m5 (de munt van vijf cent) --
 *  dat is precies waarom er een letter voor staat en niet alleen een getal.
 *  Dezelfde sleutels staan in de database, in pos_munt_waarde().
 * ------------------------------------------------------------------ */

export type MuntCode =
  | 'b500' | 'b200' | 'b100' | 'b50' | 'b20' | 'b10' | 'b5'
  | 'm200' | 'm100' | 'm50' | 'm20' | 'm10' | 'm5' | 'm2' | 'm1'

export interface Coupure {
  code: MuntCode
  /** In euro's. */
  waarde: number
  soort: 'biljet' | 'munt'
  /** Zoals het op het knopje staat. */
  label: string
}

/**
 * Aflopend, want zo tel je: eerst de grote briefjes.
 *
 * De naam is met opzet niet COUPURES: dat heet in geld.ts al iets anders --
 * de lijst waarmee wisselgeld wordt uitgerekend, en daar zitten geen
 * briefjes van honderd in. Twee lijsten met dezelfde naam in één app is een
 * fout die pas opvalt als er geld mist.
 *
 * De munten van één en twee cent staan erbij en dat is een keuze. Contant
 * wordt op vijf cent afgerond, dus in de lade horen ze niet -- maar ze bestaan
 * en ze komen soms mee. Kun je ze niet aantikken, dan klopt een telling een
 * paar cent niet en gaat iemand zoeken naar een fout die er niet is.
 */
export const MUNTSOORTEN: Coupure[] = [
  { code: 'b500', waarde: 500, soort: 'biljet', label: '€ 500' },
  { code: 'b200', waarde: 200, soort: 'biljet', label: '€ 200' },
  { code: 'b100', waarde: 100, soort: 'biljet', label: '€ 100' },
  { code: 'b50',  waarde: 50,  soort: 'biljet', label: '€ 50' },
  { code: 'b20',  waarde: 20,  soort: 'biljet', label: '€ 20' },
  { code: 'b10',  waarde: 10,  soort: 'biljet', label: '€ 10' },
  { code: 'b5',   waarde: 5,   soort: 'biljet', label: '€ 5' },
  { code: 'm200', waarde: 2,   soort: 'munt',   label: '€ 2' },
  { code: 'm100', waarde: 1,   soort: 'munt',   label: '€ 1' },
  { code: 'm50',  waarde: 0.5, soort: 'munt',   label: '50 ct' },
  { code: 'm20',  waarde: 0.2, soort: 'munt',   label: '20 ct' },
  { code: 'm10',  waarde: 0.1, soort: 'munt',   label: '10 ct' },
  { code: 'm5',   waarde: 0.05, soort: 'munt',  label: '5 ct' },
  { code: 'm2',   waarde: 0.02, soort: 'munt',  label: '2 ct' },
  { code: 'm1',   waarde: 0.01, soort: 'munt',  label: '1 ct' },
]

export const MUNTSOORT_VAN = new Map(MUNTSOORTEN.map((c) => [c.code, c]))

/** Hoeveel van elke coupure. Wat er niet in staat, is er nul van. */
export type Munten = Partial<Record<MuntCode, number>>

/**
 * Wat één briefje of munt waard is, uit zijn sleutel.
 *
 * Onbekende sleutel is nul en geen fout: komt er ooit een coupure bij, dan
 * moet een oude telling nog leesbaar zijn in plaats van de app te laten
 * omvallen. Dezelfde afspraak als in pos_munt_waarde() in de database.
 */
export function muntWaarde(code: string): number {
  const bekend = MUNTSOORT_VAN.get(code as MuntCode)
  if (bekend) return bekend.waarde
  if (/^b\d+$/.test(code)) return Number(code.slice(1))
  if (/^m\d+$/.test(code)) return centen(Number(code.slice(1)) / 100)
  return 0
}

/** Wat er bij elkaar ligt. */
export function muntenBedrag(munten: Munten | null | undefined): number {
  if (!munten) return 0
  let som = 0
  for (const [code, aantal] of Object.entries(munten)) {
    if (!aantal) continue
    som = centen(som + muntWaarde(code) * aantal)
  }
  return som
}

/** Hoeveel briefjes en munten het in totaal zijn. */
export function muntenAantal(munten: Munten | null | undefined): number {
  if (!munten) return 0
  return Object.values(munten).reduce((s, n) => s + (n || 0), 0)
}

export function muntenLeeg(munten: Munten | null | undefined): boolean {
  return muntenAantal(munten) === 0
}

/**
 * Twee stapels bij elkaar. `factor` mag -1 zijn om af te halen.
 *
 * Nullen blijven niet staan: een kluis met "nul briefjes van vijfhonderd" in
 * de administratie is ruis waar iemand naar gaat kijken.
 */
export function muntenOptellen(a: Munten, b: Munten, factor = 1): Munten {
  const uit: Munten = {}
  for (const c of MUNTSOORTEN) {
    const n = (a[c.code] ?? 0) + (b[c.code] ?? 0) * factor
    if (n !== 0) uit[c.code] = n
  }
  return uit
}

/** Alleen de coupures waar iets van is, aflopend. */
export function muntenLijst(munten: Munten | null | undefined): {
  coupure: Coupure
  aantal: number
  bedrag: number
}[] {
  if (!munten) return []
  return MUNTSOORTEN
    .filter((c) => (munten[c.code] ?? 0) !== 0)
    .map((c) => ({
      coupure: c,
      aantal: munten[c.code] as number,
      bedrag: centen(c.waarde * (munten[c.code] as number)),
    }))
}

/**
 * Kan dit eruit?
 *
 * Dit is de rem die het hele scherm zijn nut geeft. Wie wisselgeld uit de
 * kluis haalt, kan geen vier briefjes van vijftig aantikken als er drie in
 * liggen -- en hij hoeft er niet zelf op te letten.
 *
 * Er wordt niet gewisseld. Vijf briefjes van tien is niet hetzelfde als één
 * van vijftig: het gaat om wat je in je hand hebt.
 */
export function muntenPassen(voorraad: Munten, gevraagd: Munten): {
  ok: boolean
  tekort: Munten
} {
  const tekort: Munten = {}
  for (const c of MUNTSOORTEN) {
    const mist = (gevraagd[c.code] ?? 0) - (voorraad[c.code] ?? 0)
    if (mist > 0) tekort[c.code] = mist
  }
  return { ok: muntenAantal(tekort) === 0, tekort }
}

/** Alleen de coupures die er echt zijn, zonder nullen en zonder negatieven. */
export function muntenOpschonen(munten: Munten): Munten {
  const uit: Munten = {}
  for (const c of MUNTSOORTEN) {
    const n = Math.floor(munten[c.code] ?? 0)
    if (n > 0) uit[c.code] = n
  }
  return uit
}

/**
 * Zoals je het opzegt: "3x €100, 2x €20".
 *
 * Voor de bon, het logboek en het scherm. Zonder dit staat er straks alleen
 * een bedrag in de historie, en dan is de hele opzet voor niets geweest.
 */
export function muntenTekst(munten: Munten | null | undefined): string {
  const lijst = muntenLijst(munten)
  if (!lijst.length) return 'niets'
  return lijst.map((r) => `${r.aantal}x ${r.coupure.label}`).join(', ')
}
