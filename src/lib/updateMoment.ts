import type { UpdateState } from './updates'

/* ------------------------------------------------------------------ *
 *  Wanneer een update zichzelf mag installeren
 *
 *  De update stond onder Beheer -> Versie, en Beheer zit achter een
 *  aanmelding. Dat betekende: een kassa waar niemand achter staat, of waar
 *  degene die er staat geen beheerrecht heeft, installeert nooit iets. En dat
 *  is precies de kassa die het het langst niet doet -- de tablet bij de
 *  tankzuil waar één keer per week iemand komt.
 *
 *  Op Windows was er nog een tweede weg (electron installeert bij het
 *  afsluiten), maar een kassa die maanden aanstaat sluit nooit af.
 *
 *  Vanaf nu gebeurt het aan de voorkant, op het aanmeldscherm, zonder dat er
 *  iemand hoeft in te loggen. Wat hier staat is de vraag wanneer dat mag --
 *  puur rekenwerk, zonder React en zonder database, zodat de zelftest erbij
 *  kan. Een kassa die op het verkeerde moment herstart is erger dan een kassa
 *  met de vorige versie.
 *
 *  De voorwaarden, en waarom
 *  -------------------------
 *
 *  Er staat niemand achter de kassa   Anders verdwijnt het scherm onder de
 *                                     handen van iemand die aan het afrekenen
 *                                     is.
 *  Het mandje is leeg                 Een half aangeslagen bon overleeft een
 *                                     herstart wel, maar de chauffeur die
 *                                     ernaar staat te kijken niet.
 *  Er wordt niet verstuurd            De wachtrij staat in IndexedDB en gaat
 *                                     niet verloren, maar een ronde afmaken is
 *                                     goedkoper dan hem overdoen.
 *  Het scherm is even stil            Iemand die zijn personeelsnummer intikt
 *                                     is niet "niemand". Vandaar de stilte-eis:
 *                                     dit gaat om een kassa die staat te
 *                                     wachten, niet om een kassa waar net
 *                                     iemand voor staat.
 * ------------------------------------------------------------------ */

/**
 * Hoe lang het aanmeldscherm onaangeroerd moet zijn.
 *
 * Drie kwart minuut is lang genoeg dat je niet herstart terwijl iemand zijn
 * nummer intikt of even wegkijkt, en kort genoeg dat een kassa die 's ochtends
 * aangaat het voor de eerste klant al gedaan heeft.
 */
export const STIL_GENOEG_MS = 45_000

/**
 * Hoe lang "Straks" duurt.
 *
 * Zonder uitstel is er geen ontsnapping: wie de kassa net aanzet om iets op te
 * zoeken, krijgt na drie kwart minuut een herstart. Vier uur is één dienst.
 */
export const UITSTEL_MS = 4 * 60 * 60_000

export interface Situatie {
  kanaal: 'windows' | 'mobile' | 'web'
  stand: UpdateState
  /** Op Android: mag deze app een installatie starten? */
  magInstalleren: boolean
  /** Staat er iemand aangemeld (of op het klokscherm)? */
  bezet: boolean
  /** Ligt er iets in het mandje? */
  mandje: boolean
  /** Is de synchronisatie op dit moment aan het versturen? */
  verstuurt: boolean
  /** Hoe lang het scherm onaangeroerd is, in milliseconden. */
  stilMs: number
  /** Tot wanneer iemand het heeft uitgesteld, of null. */
  uitgesteldTot: number | null
  nu: number
}

export type Reden =
  | 'niets-klaar'
  | 'wacht-op-een-tik'
  | 'geen-toestemming'
  | 'bezet'
  | 'mandje'
  | 'verstuurt'
  | 'te-kort-stil'
  | 'uitgesteld'

export type Moment =
  | { nu: true }
  | { nu: false; reden: Reden }

/**
 * Mag de kassa nu, uit zichzelf, herstarten om de update te installeren?
 *
 * De volgorde is niet willekeurig: eerst of er iets te installeren valt, dan
 * of het überhaupt zonder mens kan, en pas daarna of het moment goed is. Zo
 * zegt de reden altijd het eerste dat er echt aan schort.
 */
export function mogenWeInstalleren(s: Situatie): Moment {
  if (s.stand !== 'ready') return { nu: false, reden: 'niets-klaar' }

  /*
   * Op Android kan dit niet vanzelf, en dat is geen keuze van ons.
   *
   * Het systeem zet er altijd een eigen bevestiging voor -- ook met de
   * toestemming aan. Zouden we hier vanzelf beginnen, dan staat er op een
   * kassa waar niemand bij is een Android-venster over het aanmeldscherm, en
   * de eerste die langskomt ziet niet zijn kassa maar een vraag van het
   * systeem. Die drukt op Annuleren, en dan is de update weg tot de volgende
   * ronde.
   *
   * Dus: op een tablet zet de voorkant er een knop, en die knop hoeft niemand
   * ervoor aan te melden. Dat was de klacht, en dat is daarmee opgelost.
   */
  if (s.kanaal === 'mobile') {
    if (!s.magInstalleren) return { nu: false, reden: 'geen-toestemming' }
    return { nu: false, reden: 'wacht-op-een-tik' }
  }

  // De webversie haalt de nieuwste bundel bij het laden; daar valt niets te
  // installeren en dus ook niets voor te herstarten.
  if (s.kanaal !== 'windows') return { nu: false, reden: 'niets-klaar' }

  if (s.uitgesteldTot !== null && s.nu < s.uitgesteldTot) {
    return { nu: false, reden: 'uitgesteld' }
  }
  if (s.bezet) return { nu: false, reden: 'bezet' }
  if (s.mandje) return { nu: false, reden: 'mandje' }
  if (s.verstuurt) return { nu: false, reden: 'verstuurt' }
  if (s.stilMs < STIL_GENOEG_MS) return { nu: false, reden: 'te-kort-stil' }

  return { nu: true }
}

/** Hoeveel seconden er nog te gaan zijn, of null als er niet geteld wordt. */
export function secondenTeGaan(s: Situatie): number | null {
  const m = mogenWeInstalleren(s)
  if (m.nu) return 0
  if (m.reden !== 'te-kort-stil') return null
  return Math.max(0, Math.ceil((STIL_GENOEG_MS - s.stilMs) / 1000))
}

/* ------------------------------------------------------------------ *
 *  En wat er dan op het scherm staat
 * ------------------------------------------------------------------ */

export interface Bericht {
  /** De regel zelf. Kort: dit staat op een aanmeldscherm, niet in een handleiding. */
  tekst: string
  /** Mag er een knop bij, en wat staat erop? */
  knop: 'installeren' | 'toestemming' | null
  /** Mag er uitgesteld worden? Alleen als het anders vanzelf gebeurt. */
  uitstellen: boolean
}

/**
 * Wat de voorkant erover zegt, of null als er niets te melden is.
 *
 * "Niet hinderlijk" is hier de eis, en die is scherper dan hij lijkt: dit
 * scherm is wat een chauffeur over de balie heen ziet. Dus geen rood, geen
 * uitroepteken, en vooral: alleen tekst als er iets te zeggen is. Een kassa
 * die bij is, zegt niets.
 */
export function updateBericht(s: Situatie, nieuweVersie: string | null): Bericht | null {
  const versie = nieuweVersie ? `Versie ${nieuweVersie}` : 'Een nieuwe versie'

  if (s.stand === 'downloading') {
    // Wel melden, geen knop: er valt nog niets te installeren, en een balkje
    // dat vooruitgaat is het verschil tussen "hij doet iets" en "hij hangt".
    return { tekst: `${versie} wordt opgehaald…`, knop: null, uitstellen: false }
  }

  if (s.stand !== 'ready') return null

  const m = mogenWeInstalleren(s)

  if (m.nu) {
    return { tekst: `${versie} wordt nu geïnstalleerd…`, knop: null, uitstellen: false }
  }

  switch (m.reden) {
    case 'geen-toestemming':
      return {
        tekst: `${versie} staat klaar. Android moet deze app eenmalig toestaan te installeren.`,
        knop: 'toestemming',
        uitstellen: false,
      }

    case 'wacht-op-een-tik':
      return {
        tekst: `${versie} staat klaar. Installeren duurt een halve minuut.`,
        knop: 'installeren',
        uitstellen: false,
      }

    case 'te-kort-stil': {
      const sec = secondenTeGaan(s) ?? 0
      return {
        tekst: `${versie} wordt over ${sec} seconde${sec === 1 ? '' : 'n'} geïnstalleerd. De kassa herstart even.`,
        knop: 'installeren',
        uitstellen: true,
      }
    }

    /*
     * Bezet, mandje, versturen: dan staat er iemand te werken en hoort hier
     * geen countdown. Wel de knop, want wie klaar is mag het zelf afmaken --
     * en dat hoeft nog steeds zonder aanmelden.
     */
    case 'bezet':
    case 'mandje':
    case 'verstuurt':
      return {
        tekst: `${versie} staat klaar. Zodra de kassa vrij is, installeert hij zichzelf.`,
        knop: 'installeren',
        uitstellen: false,
      }

    case 'uitgesteld':
      return {
        tekst: `${versie} staat klaar en wordt later vandaag geïnstalleerd.`,
        knop: 'installeren',
        uitstellen: false,
      }

    default:
      return null
  }
}
