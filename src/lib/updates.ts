import { create } from 'zustand'
import { Capacitor } from '@capacitor/core'
import {
  ApkUpdater, kijkOfErEenUpdateIs, type Beschikbaar,
} from './hardware/apkUpdate'

/* ------------------------------------------------------------------ *
 *  Automatische updates
 *
 *  Windows  Electron + electron-updater. De kassa kijkt bij het starten en
 *           daarna elk half uur of er een nieuwere release op GitHub staat,
 *           downloadt die op de achtergrond en installeert bij het afsluiten.
 *  Android  Dezelfde release, andere weg: de app vraagt GitHub welke versie
 *           de laatste is, haalt de APK op en geeft die aan Android om te
 *           installeren. Zie hardware/apkUpdate.ts en ApkUpdater.java.
 *
 *  Eén release voor beide, dus. Geen tweede plek om bundels te hosten, geen
 *  abonnement, en geen versienummers die uit elkaar kunnen lopen.
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
  /**
   * Op Android: of deze app een installatie mag starten. Staat standaard uit
   * en is een instelling per app, dus we vragen het en zeggen het erbij.
   */
  magInstalleren: boolean
  /** Het gedownloade bestand, klaar om te installeren. */
  bestand: string | null
  init: () => Promise<void>
  check: () => Promise<void>
  install: () => Promise<void>
  /** Android: de systeeminstelling openen waar de gebruiker het toestaat. */
  toestemmingVragen: () => Promise<void>
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

export const useUpdates = create<UpdateStore>((set, get) => ({
  channel: detectChannel(),
  state: 'idle',
  version: APP_VERSION,
  newVersion: null,
  percent: 0,
  message: null,
  magInstalleren: true,
  bestand: null,

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
      try {
        // De versie uit de APK zelf, niet die uit de webbundel: bij een
        // half gelukte update kunnen die verschillen, en dan wil je weten
        // wat er daadwerkelijk geïnstalleerd is.
        const { versie } = await ApkUpdater.huidigeVersie()
        if (versie) set({ version: versie })
      } catch { /* oudere bouw zonder de plugin: dan de webversie */ }

      try {
        const { mag } = await ApkUpdater.mogelijk()
        set({ magInstalleren: mag })
      } catch { /* niet kritiek */ }

      // De voortgang komt uit Java, per hele procent.
      try {
        await ApkUpdater.addListener('voortgang', ({ percent }) =>
          set({ state: 'downloading', percent }))
      } catch { /* niet kritiek */ }

      // Bij het opstarten meteen kijken. Niet blokkerend: de kassa moet
      // open kunnen zonder op GitHub te wachten.
      void get().check()
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
      let nieuwer: Beschikbaar | null = null
      try {
        nieuwer = await kijkOfErEenUpdateIs(get().version)
      } catch {
        set({ state: 'error', message: 'Kon niet bij GitHub komen.' })
        return
      }

      if (!nieuwer) {
        set({ state: 'up-to-date' })
        return
      }

      set({ state: 'available', newVersion: nieuwer.versie, message: null })

      /*
       * Downloaden doen we meteen, installeren niet. Vier megabyte over de
       * wifi van een wasstraat mag op de achtergrond gebeuren; een tablet
       * die midden in een transactie vraagt of hij mag herstarten, niet.
       */
      try {
        set({ state: 'downloading', percent: 0 })
        const { pad } = await ApkUpdater.download({
          url: nieuwer.url,
          versie: nieuwer.versie,
          grootte: nieuwer.grootte,
        })
        set({ state: 'ready', percent: 100, bestand: pad })
      } catch (e) {
        set({
          state: 'error',
          message: e instanceof Error ? e.message : String(e),
        })
      }
      return
    }

    set({ state: 'up-to-date', message: 'De webversie laadt altijd de nieuwste build.' })
  },

  install: async () => {
    const { channel, bestand, magInstalleren } = get()

    if (channel === 'windows' && window.desktop) {
      return void window.desktop.installUpdate()
    }

    if (channel === 'mobile') {
      if (!bestand) {
        set({ state: 'error', message: 'Er staat geen download klaar.' })
        return
      }
      if (!magInstalleren) {
        // Zonder toestemming mislukt de installatie stil. Dus eerst vragen.
        await get().toestemmingVragen()
        return
      }
      try {
        await ApkUpdater.installeren({ pad: bestand })
      } catch (e) {
        set({ state: 'error', message: e instanceof Error ? e.message : String(e) })
      }
      return
    }

    window.location.reload()
  },

  toestemmingVragen: async () => {
    try {
      await ApkUpdater.toestemmingVragen()
      // Na de omweg langs de instellingen opnieuw kijken; de gebruiker komt
      // hier terug zonder dat de app het merkt.
      const { mag } = await ApkUpdater.mogelijk()
      set({ magInstalleren: mag })
    } catch (e) {
      set({ state: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  },
}))
