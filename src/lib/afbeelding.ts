/* ------------------------------------------------------------------ *
 *  Een foto bij een artikel
 *
 *  Aan een balie zoek je niet op naam maar op hoe iets eruitziet. Twee flessen
 *  van hetzelfde merk verschillen een letter in de naam en een kleur op het
 *  etiket; wie er de hele dag staat kiest op die kleur.
 *
 *  De foto gaat in de artikelrij mee, niet in een bestandsopslag achter een
 *  URL. Dat is een bewuste keuze: de kassa moet het zonder internet doen, en
 *  een foto achter een URL is een foto die er niet is als de lijn eruit ligt.
 *  Dan staat er een rij grijze vlakken op precies het moment dat het rustig
 *  moet blijven werken.
 *
 *  De prijs daarvan is grootte, en die betalen we hier. Wat er uit de camera
 *  van een tablet komt is drie tot acht megabyte. Wat een tegel van honderdzestig
 *  pixels nodig heeft is een paar tienden van een kilobyte. Dus wordt elke foto
 *  vóór het opslaan verkleind en samengeperst, met een harde bovengrens -- en
 *  niet met de hoop dat iemand kleine foto's kiest.
 * ------------------------------------------------------------------ */

/** De langste zijde die we bewaren. Een tegel is ~160 pixels breed. */
export const MAX_ZIJDE = 400

/**
 * De bovengrens, in bytes aan beeldgegevens.
 *
 * Als base64 wordt dit ongeveer een derde groter. Vijftig artikelen met een
 * foto is dan zo'n drie megabyte in de tabel -- dat komt één keer mee met de
 * synchronisatie en staat daarna in de cache.
 */
export const MAX_BYTES = 48_000

/** Wat we uitlezen. Alles wat een browser als afbeelding opent. */
export const TOEGESTANE_SOORTEN = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/heic',
]

/* ------------------------------------------------------------------ *
 *  Rekenwerk, zonder browser
 *
 *  Los gezet zodat de zelftest erbij kan. Wat hier fout gaat, gaat stil fout:
 *  een foto die scheef wordt getrokken ziet eruit als een slechte foto, niet
 *  als een fout in een berekening.
 * ------------------------------------------------------------------ */

/**
 * Hoe groot de foto wordt, met dezelfde verhoudingen.
 *
 * Nooit groter maken dan hij was. Een foto van tachtig pixels oprekken naar
 * vierhonderd levert een wazige tegel op en een bestand dat vijf keer zo groot
 * is voor dezelfde informatie.
 */
export function beeldMaten(breedte: number, hoogte: number, maxZijde = MAX_ZIJDE): {
  breedte: number
  hoogte: number
} {
  if (!(breedte > 0) || !(hoogte > 0)) return { breedte: 0, hoogte: 0 }

  const langste = Math.max(breedte, hoogte)
  if (langste <= maxZijde) {
    return { breedte: Math.round(breedte), hoogte: Math.round(hoogte) }
  }

  const factor = maxZijde / langste
  return {
    breedte: Math.max(1, Math.round(breedte * factor)),
    hoogte: Math.max(1, Math.round(hoogte * factor)),
  }
}

/** Hoeveel bytes aan beeld er in een data-URI zit. */
export function dataUriBytes(uri: string): number {
  const komma = uri.indexOf(',')
  if (komma < 0) return 0
  const base64 = uri.slice(komma + 1)
  const opvulling = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - opvulling)
}

/**
 * Is dit een afbeelding waar we een img-tag op durven te zetten?
 *
 * De waarde komt uit de database, en die is er niet om ons te plagen -- maar
 * hij komt wel van buiten dit apparaat. Een data-URI met text/html erin doet
 * in een img-tag niets, en toch is "alleen afbeeldingen" een regel die je
 * ergens hoort op te schrijven in plaats van aan te nemen.
 */
export function veiligeAfbeelding(waarde: unknown): string | null {
  if (typeof waarde !== 'string' || !waarde) return null
  if (!/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(waarde)) return null
  return waarde
}

/**
 * De kwaliteiten die we achter elkaar proberen.
 *
 * Aflopend, want het is beter een foto twee stappen slechter te maken dan hem
 * te weigeren: iemand die een foto van zijn tablet toevoegt wil een foto, niet
 * een uitleg over compressie.
 */
export const KWALITEITEN = [0.82, 0.68, 0.55, 0.42, 0.3] as const

/* ------------------------------------------------------------------ *
 *  Het echte werk, met een canvas
 * ------------------------------------------------------------------ */

export interface Uitkomst {
  ok: boolean
  /** De foto als data-URI, klaar om in het artikel te zetten. */
  dataUri?: string
  reden?: string
  /** Wat het was en wat het werd, om te kunnen laten zien. */
  vanBytes?: number
  naarBytes?: number
  breedte?: number
  hoogte?: number
}

function laadAfbeelding(bron: string): Promise<HTMLImageElement> {
  return new Promise((klaar, mis) => {
    const beeld = new Image()
    beeld.onload = () => klaar(beeld)
    beeld.onerror = () => mis(new Error('Dit bestand is geen afbeelding die de kassa kan openen.'))
    beeld.src = bron
  })
}

function lees(bestand: File): Promise<string> {
  return new Promise((klaar, mis) => {
    const lezer = new FileReader()
    lezer.onload = () => klaar(String(lezer.result))
    lezer.onerror = () => mis(new Error('Het bestand kon niet gelezen worden.'))
    lezer.readAsDataURL(bestand)
  })
}

/**
 * Een gekozen bestand naar een kleine foto.
 *
 * Geeft nooit een fout terug maar altijd een antwoord waarin staat wat er
 * misging. Een foto is een aardigheid bij een artikel; als het niet lukt, hoort
 * het artikel het gewoon zonder te doen.
 */
export async function verkleinAfbeelding(bestand: File): Promise<Uitkomst> {
  try {
    if (bestand.size === 0) return { ok: false, reden: 'Dit bestand is leeg.' }

    const bron = await lees(bestand)
    const beeld = await laadAfbeelding(bron)

    const maten = beeldMaten(beeld.naturalWidth, beeld.naturalHeight)
    if (!maten.breedte) {
      return { ok: false, reden: 'De kassa kon niet zien hoe groot deze afbeelding is.' }
    }

    /*
     * Twee rondes: eerst op de gewenste maat, en als het dan nog te groot is,
     * op de halve maat. Bij een foto van een etiket met veel tekst is
     * samenpersen alleen niet genoeg -- dan is er gewoon te veel detail.
     */
    for (const deler of [1, 2]) {
      const breedte = Math.max(1, Math.round(maten.breedte / deler))
      const hoogte = Math.max(1, Math.round(maten.hoogte / deler))

      const doek = document.createElement('canvas')
      doek.width = breedte
      doek.height = hoogte
      const pen = doek.getContext('2d')
      if (!pen) return { ok: false, reden: 'Dit apparaat kan geen afbeeldingen bewerken.' }

      /*
       * Eerst wit, dan de foto. Een PNG met een doorzichtige achtergrond wordt
       * als JPEG anders zwart, en dan staat er een zwart vlak op de tegel waar
       * een flesje had moeten staan.
       */
      pen.fillStyle = '#ffffff'
      pen.fillRect(0, 0, breedte, hoogte)
      pen.drawImage(beeld, 0, 0, breedte, hoogte)

      for (const kwaliteit of KWALITEITEN) {
        const uri = doek.toDataURL('image/jpeg', kwaliteit)
        const bytes = dataUriBytes(uri)
        if (bytes <= MAX_BYTES) {
          return {
            ok: true,
            dataUri: uri,
            vanBytes: bestand.size,
            naarBytes: bytes,
            breedte,
            hoogte,
          }
        }
      }
    }

    return {
      ok: false,
      reden: 'Deze foto blijft ook verkleind te groot. Maak er een met minder ' +
             'detail, of snijd hem strakker om het artikel heen.',
    }
  } catch (e) {
    return { ok: false, reden: e instanceof Error ? e.message : String(e) }
  }
}

/** Om de grootte te laten zien: 47128 -> "46 kB". */
export function bytesKort(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
