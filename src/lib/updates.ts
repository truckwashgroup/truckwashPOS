import { create } from 'zustand'
import { Capacitor } from '@capacitor/core'

/* ------------------------------------------------------------------ *
 *  Automatische updates
 *
 *  Windows  Electron + electron-updater. De kassa kijkt bij het starten en
 *           daarna elk half uur of er een nieuwere release op GitHub staat,
 *           downloadt die op de achtergrond en installeert bij het afsluiten.
 *  Android  Capacitor. De APK werk je met de hand bij, of via OTA als de
 *           Capgo-plugin is toegevoegd.
 *
 *  Waarom niet meteen installeren als het klaar is: dit is een kassa. Een
 *  herstart midden in een transactie is erger dan een dag met de vorige
 *  versie werken. Dus: downloaden mag altijd, installeren doet iemand na de
 *  dagafsluiting -- of het gebeurt vanzelf bij het afsluiten.
 * ------------------------------------------------------------------ */

export type UpdateState =
  | 'idle' | 'checking' | 'up-to-date' | 'available'
  | 'downloading' | 'ready' | 'error'

interface UpdateStore {
  channel: 'windows' | 'mobile' | 'web'
  state: UpdateState
  version: string
  newVersion: string | null
  percent: number
  message: string | null
  init: () => Promise<void>
  check: () => Promise<void>
  install: () => Promise<void>
}

/**
 * De versie komt uit package.json, ingebakken tijdens het bouwen (zie
 * vite.config.ts). Met de hand bijhouden gaat mis: dan staat er in de app een
 * ander nummer dan waar de updater op vergelijkt.
 */
const APP_VERSION = __APP_VERSION__

function detectChannel(): UpdateStore['channel'] {
  if (typeof window !== 'undefined' && window.desktop?.isElectron) return 'windows'
  if (Capacitor.isNativePlatform()) return 'mobile'
  return 'web'
}

async function loadCapgo(): Promise<any | null> {
  try {
    // Bewust via een variabele: de plugin is optioneel en hoeft niet
    // geïnstalleerd te zijn om de app te kunnen bouwen.
    const spec = '@capgo/capacitor-updater'
    const mod = await import(/* @vite-ignore */ spec)
    return (mod as any).CapacitorUpdater ?? null
  } catch {
    return null
  }
}

export const useUpdates = create<UpdateStore>((set, get) => ({
  channel: detectChannel(),
  state: 'idle',
  version: APP_VERSION,
  newVersion: null,
  percent: 0,
  message: null,

  init: async () => {
    const channel = detectChannel()
    set({ channel })

    if (channel === 'windows' && window.desktop) {
      try {
        set({ version: await window.desktop.getVersion() })
      } catch { /* niet kritiek */ }

      window.desktop.onUpdateStatus((p: any) => {
        switch (p.state) {
          case 'checking': set({ state: 'checking', message: null }); break
          case 'available': set({ state: 'available', newVersion: p.version }); break
          case 'up-to-date': set({ state: 'up-to-date' }); break
          case 'downloading': set({ state: 'downloading', percent: p.percent ?? 0 }); break
          case 'ready': set({ state: 'ready', newVersion: p.version, percent: 100 }); break
          case 'error': set({ state: 'error', message: p.message ?? 'Onbekende fout' }); break
        }
      })
      return
    }

    if (channel === 'mobile') {
      const updater = await loadCapgo()
      if (!updater) return
      try {
        // Meldt aan de plugin dat de bundel goed opstart; anders draait hij
        // terug naar de vorige.
        await updater.notifyAppReady()
        const info = await updater.current()
        set({ version: info?.bundle?.version ?? APP_VERSION })
        updater.addListener?.('downloadComplete', () => set({ state: 'ready', percent: 100 }))
        updater.addListener?.('download', (e: any) =>
          set({ state: 'downloading', percent: e?.percent ?? 0 }))
      } catch { /* niet kritiek */ }
    }
  },

  check: async () => {
    const { channel } = get()
    set({ state: 'checking', message: null })

    if (channel === 'windows' && window.desktop) {
      const res = await window.desktop.checkForUpdates()
      if (!res.ok) {
        set({
          state: res.reason === 'dev' ? 'up-to-date' : 'error',
          message: res.reason === 'dev'
            ? 'Ontwikkelmodus — updates uitgeschakeld'
            : res.reason ?? null,
        })
      }
      return
    }

    if (channel === 'mobile') {
      const updater = await loadCapgo()
      if (!updater) {
        set({
          state: 'up-to-date',
          message: 'Op de tablet werk je de app bij met een nieuwe APK.',
        })
        return
      }
      try {
        const latest = await updater.getLatest()
        if (latest?.url) {
          set({ state: 'downloading', percent: 0, newVersion: latest.version ?? null })
          const bundle = await updater.download({ url: latest.url, version: latest.version })
          await updater.set(bundle)
          set({ state: 'ready', percent: 100 })
        } else {
          set({ state: 'up-to-date' })
        }
      } catch (e) {
        set({ state: 'error', message: e instanceof Error ? e.message : String(e) })
      }
      return
    }

    set({ state: 'up-to-date', message: 'De webversie laadt altijd de nieuwste build.' })
  },

  install: async () => {
    const { channel } = get()
    if (channel === 'windows' && window.desktop) return void window.desktop.installUpdate()
    if (channel === 'mobile') {
      const updater = await loadCapgo()
      if (updater) return void updater.reload()
    }
    window.location.reload()
  },
}))
