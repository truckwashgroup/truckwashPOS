import { getMeta, setMeta } from '../db'

/* ------------------------------------------------------------------ *
 *  Muziek bijsturen
 *
 *  Het netwerkwerk zit in electron/muziek.cjs: een webview mag geen UDP
 *  versturen en geen SOAP naar een willekeurig apparaat sturen, en dat hoort
 *  ook zo te blijven. Dit is de brug ernaartoe.
 *
 *  Welk apparaat gekozen is, staat lokaal op deze kassa en niet in de
 *  gedeelde instellingen. Een speaker heeft een adres op één netwerk; de kassa
 *  in Rotterdam heeft niets te zoeken bij de boxen in Utrecht.
 * ------------------------------------------------------------------ */

export interface MuziekApparaat {
  id: string
  naam: string
  merk: string
  model: string
  wortel: string
  transportUrl: string
  volumeUrl: string
}

export interface MuziekNummer {
  titel: string
  artiest: string
  album: string
  duur: string
  positie: string
}

export interface MuziekStand {
  speelt: boolean
  volume: number | null
  gedempt: boolean
  nummer: MuziekNummer | null
  fout: string | null
}

export type MuziekActie =
  | 'spelen' | 'pauze' | 'volgende' | 'vorige' | 'volume' | 'dempen'

interface MuziekBrug {
  muziekZoeken(): Promise<{ apparaten: MuziekApparaat[]; google: string[] }>
  muziekStand(apparaat: MuziekApparaat): Promise<MuziekStand>
  muziekBesturen(
    apparaat: MuziekApparaat,
    actie: MuziekActie,
    waarde?: number | boolean,
  ): Promise<{ ok: boolean; reden?: string }>
}

const brug = (): MuziekBrug | null => {
  const d = typeof window !== 'undefined' ? (window.desktop as unknown as MuziekBrug | undefined) : undefined
  return d && typeof d.muziekZoeken === 'function' ? d : null
}

export const kanMuziek = (): boolean => brug() !== null

/* ------------------------------------------------------------------ *
 *  Welk apparaat
 * ------------------------------------------------------------------ */

const SLEUTEL = 'muziekApparaat'

export const gekozenApparaat = () => getMeta<MuziekApparaat | null>(SLEUTEL, null)

export const kiesApparaat = (apparaat: MuziekApparaat | null) =>
  setMeta(SLEUTEL, apparaat)

/* ------------------------------------------------------------------ *
 *  Doen
 * ------------------------------------------------------------------ */

const GEEN_BRUG = {
  ok: false,
  reden: 'Muziek bijsturen werkt alleen op de Windows-kassa: een tablet mag ' +
         'geen netwerkopdrachten naar een speaker sturen.',
}

export async function zoekApparaten(): Promise<{
  apparaten: MuziekApparaat[]
  google: string[]
  fout?: string
}> {
  const b = brug()
  if (!b) return { apparaten: [], google: [], fout: GEEN_BRUG.reden }
  try {
    return await b.muziekZoeken()
  } catch (e) {
    return {
      apparaten: [], google: [],
      fout: e instanceof Error ? e.message : String(e),
    }
  }
}

export async function haalStand(apparaat: MuziekApparaat): Promise<MuziekStand> {
  const b = brug()
  if (!b) {
    return { speelt: false, volume: null, gedempt: false, nummer: null, fout: GEEN_BRUG.reden }
  }
  try {
    return await b.muziekStand(apparaat)
  } catch (e) {
    return {
      speelt: false, volume: null, gedempt: false, nummer: null,
      fout: e instanceof Error ? e.message : String(e),
    }
  }
}

export async function bestuur(
  apparaat: MuziekApparaat,
  actie: MuziekActie,
  waarde?: number | boolean,
): Promise<{ ok: boolean; reden?: string }> {
  const b = brug()
  if (!b) return GEEN_BRUG
  try {
    return await b.muziekBesturen(apparaat, actie, waarde)
  } catch (e) {
    return { ok: false, reden: e instanceof Error ? e.message : String(e) }
  }
}
