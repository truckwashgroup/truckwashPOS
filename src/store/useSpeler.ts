import { create } from 'zustand'
import { getMeta, setMeta } from '../lib/db'
import {
  kiesMap as kiesMapBrug, lijstMap, naarVideo, openVideo, schermen, sluitVideo,
  videoStaatOpen, type Bestand, type Scherm,
} from '../lib/hardware/speler'

/* ------------------------------------------------------------------ *
 *  De speler
 *
 *  De kassa als bron: hij speelt zelf, en waar het geluid uitkomt bepaalt
 *  Windows -- de luidspreker van de pc, een kabel naar de versterker, of een
 *  gekoppelde bluetooth-box. Daarom werkt bluetooth hier wél en bij het
 *  bijsturen van een ander apparaat niet.
 *
 *  Eén keuze bepaalt de hele opzet: het geluidselement staat buiten React.
 *
 *  Zet je een <audio> in een component, dan stopt de muziek zodra iemand naar
 *  een ander tabblad gaat -- want dan wordt dat component afgebroken. Aan een
 *  kassa is dat onbruikbaar: je gaat de hele dag heen en weer tussen afrekenen
 *  en de klok. Dus leeft het element hier, in de module, en overleeft het elke
 *  schermwissel.
 * ------------------------------------------------------------------ */

export type Bron = 'map' | 'radio'

export interface Radio {
  naam: string
  url: string
}

interface SpelerStore {
  /* --- muziek --- */
  bron: Bron
  map: string | null
  nummers: Bestand[]
  index: number
  speelt: boolean
  shuffle: boolean
  volume: number
  bezig: boolean
  fout: string | null

  radios: Radio[]
  radio: Radio | null

  /* --- video --- */
  videos: Bestand[]
  videoOpen: boolean
  videoIndex: number
  videoGedempt: boolean
  schermen: Scherm[]

  herstel: () => Promise<void>
  mapKiezen: () => Promise<void>
  mapVernieuwen: () => Promise<void>

  spelen: (index?: number) => void
  pauze: () => void
  wissel: () => void
  volgende: () => void
  vorige: () => void
  zetVolume: (v: number) => void
  zetShuffle: (v: boolean) => void
  zetBron: (b: Bron) => void

  radioToevoegen: (r: Radio) => Promise<void>
  radioWeghalen: (url: string) => Promise<void>
  radioSpelen: (r: Radio) => void

  videoOpenen: (schermId?: string) => Promise<void>
  videoSluiten: () => Promise<void>
  videoSpelen: (index: number) => void
  videoVolgende: () => void
  videoPauze: () => void
  videoDempen: (v: boolean) => void
  schermenVernieuwen: () => Promise<void>
}

/* ------------------------------------------------------------------ *
 *  Het element
 * ------------------------------------------------------------------ */

let geluid: HTMLAudioElement | null = null

function element(): HTMLAudioElement {
  if (geluid) return geluid
  geluid = new Audio()
  geluid.preload = 'auto'

  // Nummer klaar? Dan het volgende. Dat is het hele punt van een afspeellijst.
  geluid.addEventListener('ended', () => {
    useSpeler.getState().volgende()
  })

  /*
   * Een bestand dat niet wil spelen mag de lijst niet stilzetten. Chromium
   * kan sommige bestanden niet aan (een .wav met een rare codec, een bestand
   * dat halverwege is gekopieerd) en dan hoort de speler door te gaan in
   * plaats van te blijven staan op iets wat niet werkt.
   */
  geluid.addEventListener('error', () => {
    const s = useSpeler.getState()
    if (s.bron === 'radio') {
      useSpeler.setState({
        speelt: false,
        fout: 'Die stream doet het niet. Ligt de verbinding eruit, of is het adres veranderd?',
      })
      return
    }
    if (s.nummers.length > 1) {
      useSpeler.setState({ fout: `"${s.nummers[s.index]?.naam}" kon niet gespeeld worden.` })
      s.volgende()
    } else {
      useSpeler.setState({ speelt: false, fout: 'Dit bestand kon niet gespeeld worden.' })
    }
  })

  geluid.addEventListener('playing', () => useSpeler.setState({ speelt: true, fout: null }))
  geluid.addEventListener('pause', () => useSpeler.setState({ speelt: false }))

  return geluid
}

/* ------------------------------------------------------------------ *
 *  Onthouden
 * ------------------------------------------------------------------ */

const SLEUTELS = {
  map: 'spelerMap',
  volume: 'spelerVolume',
  shuffle: 'spelerShuffle',
  radios: 'spelerRadios',
  bron: 'spelerBron',
}

/** Een paar stations om mee te beginnen, zodat het veld niet leeg is. */
const STANDAARD_RADIOS: Radio[] = [
  { naam: 'NPO Radio 2', url: 'https://icecast.omroep.nl/radio2-bb-mp3' },
  { naam: 'NPO 3FM', url: 'https://icecast.omroep.nl/3fm-bb-mp3' },
  { naam: 'NPO Radio 5', url: 'https://icecast.omroep.nl/radio5-bb-mp3' },
]

/* ------------------------------------------------------------------ *
 *  Volgorde
 * ------------------------------------------------------------------ */

/**
 * De volgende index, met of zonder shuffle.
 *
 * Los gezet zodat de zelftest erbij kan: dit is precies het soort rekenwerk
 * dat één keer per honderd nummers fout gaat en dan een uur zoeken kost.
 *
 * Shuffle kiest willekeurig maar nooit hetzelfde nummer twee keer achter
 * elkaar -- dat voelt namelijk als een kapotte speler, niet als toeval.
 */
export function volgendeIndex(
  huidig: number,
  aantal: number,
  shuffle: boolean,
  toeval: () => number = Math.random,
): number {
  if (aantal <= 0) return 0
  if (aantal === 1) return 0

  if (!shuffle) return (huidig + 1) % aantal

  let nieuw = Math.floor(toeval() * aantal)
  if (nieuw === huidig) nieuw = (nieuw + 1) % aantal
  return nieuw
}

export function vorigeIndex(huidig: number, aantal: number): number {
  if (aantal <= 0) return 0
  return (huidig - 1 + aantal) % aantal
}

/* ------------------------------------------------------------------ */

export const useSpeler = create<SpelerStore>((set, get) => ({
  bron: 'map',
  map: null,
  nummers: [],
  index: 0,
  speelt: false,
  shuffle: false,
  volume: 0.6,
  bezig: false,
  fout: null,

  radios: STANDAARD_RADIOS,
  radio: null,

  videos: [],
  videoOpen: false,
  videoIndex: 0,
  videoGedempt: true,
  schermen: [],

  herstel: async () => {
    const [map, volume, shuffle, radios, bron] = await Promise.all([
      getMeta<string | null>(SLEUTELS.map, null),
      getMeta<number>(SLEUTELS.volume, 0.6),
      getMeta<boolean>(SLEUTELS.shuffle, false),
      getMeta<Radio[]>(SLEUTELS.radios, STANDAARD_RADIOS),
      getMeta<Bron>(SLEUTELS.bron, 'map'),
    ])

    set({ map, volume, shuffle, radios: radios?.length ? radios : STANDAARD_RADIOS, bron })
    element().volume = volume

    if (map) await get().mapVernieuwen()
    await get().schermenVernieuwen()
    set({ videoOpen: await videoStaatOpen() })
  },

  mapKiezen: async () => {
    set({ bezig: true, fout: null })
    const { pad, fout } = await kiesMapBrug(get().map)
    if (fout) { set({ bezig: false, fout }); return }
    if (!pad) { set({ bezig: false }); return }

    await setMeta(SLEUTELS.map, pad)
    set({ map: pad })
    await get().mapVernieuwen()
    set({ bezig: false })
  },

  mapVernieuwen: async () => {
    const map = get().map
    if (!map) return
    set({ bezig: true })
    const uitslag = await lijstMap(map)
    set({
      nummers: uitslag.geluid,
      videos: uitslag.beeld,
      index: 0,
      bezig: false,
      fout: uitslag.fout ?? null,
    })
  },

  /* ---------------- muziek ---------------- */

  spelen: (index) => {
    const s = get()
    const el = element()

    if (s.bron === 'radio') {
      const r = s.radio ?? s.radios[0]
      if (!r) { set({ fout: 'Er is geen station gekozen.' }); return }
      set({ radio: r, fout: null })
      if (el.src !== r.url) el.src = r.url
      void el.play().catch(() => { /* de error-luisteraar meldt het */ })
      return
    }

    if (!s.nummers.length) {
      set({ fout: 'Er staat nog geen muziek in. Kies een map.' })
      return
    }

    const i = index ?? s.index
    const nummer = s.nummers[i]
    if (!nummer) return

    set({ index: i, fout: null })
    if (el.src !== nummer.adres) el.src = nummer.adres
    void el.play().catch(() => { /* de error-luisteraar meldt het */ })
  },

  pauze: () => { element().pause() },

  wissel: () => {
    const el = element()
    if (el.paused) get().spelen()
    else el.pause()
  },

  volgende: () => {
    const s = get()
    if (s.bron === 'radio') return   // een stream heeft geen volgende
    if (!s.nummers.length) return
    get().spelen(volgendeIndex(s.index, s.nummers.length, s.shuffle))
  },

  vorige: () => {
    const s = get()
    if (s.bron === 'radio') return
    if (!s.nummers.length) return
    get().spelen(vorigeIndex(s.index, s.nummers.length))
  },

  zetVolume: (v) => {
    const begrensd = Math.max(0, Math.min(1, v))
    element().volume = begrensd
    set({ volume: begrensd })
    void setMeta(SLEUTELS.volume, begrensd)
  },

  zetShuffle: (v) => {
    set({ shuffle: v })
    void setMeta(SLEUTELS.shuffle, v)
  },

  zetBron: (b) => {
    // Van bron wisselen zet de muziek stil: door elkaar spelen kan niet, en
    // stil verder gaan met het andere is verwarrend.
    element().pause()
    element().removeAttribute('src')
    set({ bron: b, speelt: false, fout: null })
    void setMeta(SLEUTELS.bron, b)
  },

  /* ---------------- radio ---------------- */

  radioToevoegen: async (r) => {
    const schoon = { naam: r.naam.trim(), url: r.url.trim() }
    if (!schoon.naam || !schoon.url) return
    const radios = [...get().radios.filter((x) => x.url !== schoon.url), schoon]
    set({ radios })
    await setMeta(SLEUTELS.radios, radios)
  },

  radioWeghalen: async (url) => {
    const radios = get().radios.filter((r) => r.url !== url)
    set({ radios, radio: get().radio?.url === url ? null : get().radio })
    await setMeta(SLEUTELS.radios, radios)
  },

  radioSpelen: (r) => {
    set({ bron: 'radio', radio: r })
    void setMeta(SLEUTELS.bron, 'radio')
    get().spelen()
  },

  /* ---------------- video ---------------- */

  schermenVernieuwen: async () => {
    set({ schermen: await schermen() })
  },

  videoOpenen: async (schermId) => {
    const uitslag = await openVideo(schermId)
    if (!uitslag.ok) { set({ fout: uitslag.reden ?? 'Het scherm ging niet open.' }); return }
    set({ videoOpen: true, fout: null })

    // Meteen iets laten zien; een zwart venster ziet uit als kapot.
    const s = get()
    if (s.videos.length) get().videoSpelen(s.videoIndex)
  },

  videoSluiten: async () => {
    await sluitVideo()
    set({ videoOpen: false })
  },

  videoSpelen: (index) => {
    const s = get()
    const video = s.videos[index]
    if (!video) return
    set({ videoIndex: index })
    void naarVideo({
      soort: 'spelen',
      adres: video.adres,
      naam: video.naam,
      gedempt: s.videoGedempt,
    })
  },

  videoVolgende: () => {
    const s = get()
    if (!s.videos.length) return
    get().videoSpelen(volgendeIndex(s.videoIndex, s.videos.length, false))
  },

  videoPauze: () => { void naarVideo({ soort: 'pauze' }) },

  videoDempen: (v) => {
    set({ videoGedempt: v })
    void naarVideo({ soort: 'dempen', gedempt: v })
  },
}))

/**
 * Het volgende videobestand laten spelen als het huidige klaar is.
 *
 * Het videovenster meldt dat via de brug, want daar staat het element. Hier
 * bepalen we wat er daarna komt -- de lijst hoort op één plek te staan.
 */
export function videoIsKlaar() {
  useSpeler.getState().videoVolgende()
}
