/* ------------------------------------------------------------------ *
 *  De speler, van de kant van de app
 *
 *  Het werk met de schijf en het tweede venster zit in electron/speler.cjs:
 *  een webpagina mag geen mappen doorzoeken en geen venster op een ander
 *  scherm openen, en dat hoort ook zo te blijven. Dit is de brug ernaartoe.
 *
 *  Op een tablet bestaat die brug niet. Dan geeft alles hier netjes terug dat
 *  het niet kan, in plaats van een fout te gooien -- want de kassa moet door.
 * ------------------------------------------------------------------ */

export interface Bestand {
  pad: string
  naam: string
  /** De onderliggende map, om te laten zien waar het uit komt. */
  map: string
  /** Het adres waarmee de speler erbij komt (speler://…). */
  adres: string
}

export interface Scherm {
  id: string
  naam: string
  hoofdscherm: boolean
  breedte: number
  hoogte: number
}

export interface VideoOpdracht {
  soort: 'spelen' | 'pauze' | 'dempen'
  adres?: string
  naam?: string
  gedempt?: boolean
}

interface SpelerBrug {
  spelerKiesMap(vanaf: string | null): Promise<{ pad: string | null }>
  spelerLijstMap(map: string): Promise<{
    geluid: Bestand[]
    beeld: Bestand[]
    fout: string | null
  }>
  spelerSchermen(): Promise<Scherm[]>
  spelerVideoOpenen(schermId?: string): Promise<{
    ok: boolean
    alOpen?: boolean
    opTweedeScherm?: boolean
    reden?: string
  }>
  spelerVideoSluiten(): Promise<{ ok: boolean }>
  spelerVideoOpdracht(opdracht: VideoOpdracht): Promise<{ ok: boolean; reden?: string }>
  spelerVideoStaatOpen(): Promise<boolean>
  spelerOpVideoOpdracht(cb: (o: VideoOpdracht) => void): () => void
}

function brug(): SpelerBrug | null {
  const d = typeof window !== 'undefined'
    ? (window.desktop as unknown as SpelerBrug | undefined)
    : undefined
  return d && typeof d.spelerLijstMap === 'function' ? d : null
}

export const kanSpelen = (): boolean => brug() !== null

const GEEN_BRUG =
  'Zelf muziek of video afspelen werkt alleen op de Windows-kassa. Een tablet ' +
  'mag geen mappen doorzoeken.'

export async function kiesMap(vanaf: string | null): Promise<{
  pad: string | null
  fout?: string
}> {
  const b = brug()
  if (!b) return { pad: null, fout: GEEN_BRUG }
  try {
    return await b.spelerKiesMap(vanaf)
  } catch (e) {
    return { pad: null, fout: e instanceof Error ? e.message : String(e) }
  }
}

export async function lijstMap(map: string): Promise<{
  geluid: Bestand[]
  beeld: Bestand[]
  fout: string | null
}> {
  const b = brug()
  if (!b) return { geluid: [], beeld: [], fout: GEEN_BRUG }
  try {
    return await b.spelerLijstMap(map)
  } catch (e) {
    return {
      geluid: [], beeld: [],
      fout: e instanceof Error ? e.message : String(e),
    }
  }
}

export async function schermen(): Promise<Scherm[]> {
  const b = brug()
  if (!b) return []
  try {
    return await b.spelerSchermen()
  } catch {
    return []
  }
}

export async function openVideo(schermId?: string) {
  const b = brug()
  if (!b) return { ok: false, reden: GEEN_BRUG }
  try {
    return await b.spelerVideoOpenen(schermId)
  } catch (e) {
    return { ok: false, reden: e instanceof Error ? e.message : String(e) }
  }
}

export async function sluitVideo() {
  const b = brug()
  if (!b) return { ok: false }
  try {
    return await b.spelerVideoSluiten()
  } catch {
    return { ok: false }
  }
}

export async function naarVideo(opdracht: VideoOpdracht) {
  const b = brug()
  if (!b) return { ok: false, reden: GEEN_BRUG }
  try {
    return await b.spelerVideoOpdracht(opdracht)
  } catch (e) {
    return { ok: false, reden: e instanceof Error ? e.message : String(e) }
  }
}

export async function videoStaatOpen(): Promise<boolean> {
  const b = brug()
  if (!b) return false
  try {
    return await b.spelerVideoStaatOpen()
  } catch {
    return false
  }
}

/** Alleen in het videovenster: luisteren naar wat de kassa opdraagt. */
export function opVideoOpdracht(cb: (o: VideoOpdracht) => void): () => void {
  const b = brug()
  if (!b) return () => {}
  try {
    return b.spelerOpVideoOpdracht(cb)
  } catch {
    return () => {}
  }
}
