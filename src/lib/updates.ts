import { create } from 'zustand'
import { Capacitor } from '@capacitor/core'
import {
  ApkUpdater, kijkOfErEenUpdateIs, type Beschikbaar,
} from './hardware/apkUpdate'
import { UITSTEL_MS } from './updateMoment'

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
 *  versie werken. Dus: downloaden mag altijd, installeren gebeurt als de
 *  kassa vrij is -- zie updateMoment.ts voor wanneer dat is.
 *
 *  Dat installeren zat eerst onder Beheer -> Versie, en Beheer zit achter een
 *  aanmelding. Een kassa waar niemand achter staat installeerde dus nooit
 *  iets, en dat is juist de kassa die het het langst niet doet. Het gebeurt nu
 *  aan de voorkant, op het aanmeldscherm, zonder aanmelden.
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
  /**
   * Tot wanneer iemand het installeren heeft weggeklikt, of null.
   *
   * Alleen in het geheugen, met opzet: na een herstart is de update er toch
   * al, en een uitstel dat een reboot overleeft is een uitstel dat niemand
   * meer terugvindt.
   */
  uitgesteldTot: number | null
  /**
   * Of er al een installatie loopt.
   *
   * Zonder deze vlag probeert de voorkant het elke seconde opnieuw zodra de
   * kassa vrij is -- en op Windows betekent dat quitAndInstall in een lus.
   */
  installeert: boolean
  init: () => Promise<void>
  check: () => Promise<void>
  install: () => Promise<void>
  uitstellen: (msVanaf?: number) => void
  /** Android: de systeeminstelling openen waar de gebruiker het toestaat. */
  toestemmingVragen: () => Promise<void>
}

/**
 * De versie komt uit package.json, ingebakken tijdens het bouwen (zie
 * vite.config.ts). Met de hand bijhouden gaat mis: dan staat er in de app een
 * ander nummer dan waar de updater op vergelijkt.
 */
const APP_VERSION = __APP_VERSION__

/* ------------------------------------------------------------------ *
 *  Hoe stil het scherm is
 *
 *  Nodig om te weten of de kassa staat te wachten of dat er net iemand voor
 *  staat. Bewust een gewone variabele en geen veld in de store: dit wordt bij
 *  elke aanraking bijgewerkt, en een store die bij elke aanraking verandert
 *  laat elk scherm dat hem leest opnieuw tekenen. Wie de stand nodig heeft,
 *  vraagt hem -- en dat is alleen zo terwijl er een update klaarstaat.
 * ------------------------------------------------------------------ */

let laatsteAanraking = Date.now()

/** Iemand heeft het scherm aangeraakt of een toets ingedrukt. */
export const geraakt = () => { laatsteAanraking = Date.now() }

/** Hoe lang het scherm onaangeroerd is, in milliseconden. */
export const stilMs = () => Date.now() - laatsteAanraking

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
  uitgesteldTot: null,
  installeert: false,

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

      /*
       * Bij het opstarten meteen kijken, en daarna elk half uur -- hetzelfde
       * ritme als electron op Windows aanhoudt.
       *
       * Eerst gebeurde dit alleen bij het opstarten. Een tablet achter een
       * balie gaat maanden niet uit, dus die keek één keer en daarna nooit
       * meer. Dat is precies de kassa waar dit voor bedoeld was.
       *
       * Niet blokkerend: de kassa moet open kunnen zonder op GitHub te
       * wachten.
       */
      void get().check()
      setInterval(() => {
        // Niet opnieuw gaan kijken terwijl er al iets klaarstaat: dan zet de
        // check de stand terug op 'checking' en verdwijnt de melding aan de
        // voorkant halverwege een aftelling.
        const { state } = get()
        if (state === 'ready' || state === 'downloading') return
        void get().check()
      }, 30 * 60_000)
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
    const { channel, bestand, magInstalleren, installeert } = get()
    if (installeert) return

    if (channel === 'windows' && window.desktop) {
      set({ installeert: true })
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
        set({ installeert: true })
        await ApkUpdater.installeren({ pad: bestand })
      } catch (e) {
        // Weer vrijgeven: Android kan de bevestiging afgewezen hebben, en dan
        // moet de knop het opnieuw kunnen doen.
        set({
          installeert: false,
          state: 'error',
          message: e instanceof Error ? e.message : String(e),
        })
      }
      return
    }

    window.location.reload()
  },

  /**
   * "Straks."
   *
   * Vier uur is de standaard: dat is een dienst. Wie de kassa aanzet om iets
   * op te zoeken hoort niet halverwege een herstart te krijgen, en wie het
   * echt nu wil kan nog steeds op Installeren drukken.
   */
  uitstellen: (msVanaf = UITSTEL_MS) => set({ uitgesteldTot: Date.now() + msVanaf }),

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
