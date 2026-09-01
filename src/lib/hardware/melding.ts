import { Capacitor } from '@capacitor/core'

/* ------------------------------------------------------------------ *
 *  Een melding die het afsluiten van de app overleeft
 *
 *  Dit is niet hetzelfde als een melding tonen. Een melding tonen doet de app
 *  zelf, en dat kan alleen zolang hij draait. Hier gaat het om: zet iets klaar
 *  voor straks, sluit de app, en krijg het alsnog.
 *
 *  Dat vraagt op elk platform iets anders, en het verschil is wezenlijk:
 *
 *  Windows  Er is niets dat dit voor je bijhoudt. De kassa start daarom een
 *           los proces dat wacht en daarna de melding toont -- dat proces
 *           hangt niet aan de app en blijft dus staan als de kassa afsluit.
 *
 *  Android  Het besturingssysteem houdt het bij (AlarmManager). Dat is hoe een
 *           wekker ook werkt: de app hoeft er niet voor te draaien. Wel moet
 *           de gebruiker meldingen hebben toegestaan, en op Android 12 en
 *           later ook "exacte alarmen" -- anders komt hij, maar niet op tijd.
 *
 *  Waarom dit er is: zonder een knop om het te proberen weet je niet of
 *  meldingen op dit apparaat werken. En dat wil je weten vóórdat je erop gaat
 *  vertrouwen voor iets dat telt.
 * ------------------------------------------------------------------ */

export interface MeldingUitslag {
  ok: boolean
  /** Wanneer hij verwacht wordt. */
  om?: string
  seconden?: number
  reden?: string
  /** Wat de gebruiker nu moet doen om het te bewijzen. */
  hint?: string
}

const opWindows = (): boolean =>
  typeof window !== 'undefined' && Boolean(window.desktop?.isElectron)

const opAndroid = (): boolean => {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

export const kanPlannen = (): boolean => opWindows() || opAndroid()

/** Welk soort apparaat, voor de uitleg in het scherm. */
export const soortApparaat = (): 'windows' | 'android' | 'web' =>
  opWindows() ? 'windows' : opAndroid() ? 'android' : 'web'

/* ------------------------------------------------------------------ *
 *  Android
 * ------------------------------------------------------------------ */

async function androidPlugin() {
  // Via een variabele, zodat de webbouw niet omvalt als de plugin er niet is.
  const spec = '@capacitor/local-notifications'
  const mod = await import(/* @vite-ignore */ spec)
  return (mod as any).LocalNotifications
}

async function planAndroid(
  seconden: number,
  titel: string,
  tekst: string,
): Promise<MeldingUitslag> {
  let plugin: any
  try {
    plugin = await androidPlugin()
  } catch {
    return {
      ok: false,
      reden: 'De meldingen-plugin zit niet in deze versie van de app.',
    }
  }

  try {
    const rechten = await plugin.requestPermissions()
    if (rechten?.display !== 'granted') {
      return {
        ok: false,
        reden: 'Meldingen zijn voor deze app niet toegestaan. Zet ze aan bij de ' +
               'app-instellingen van Android.',
      }
    }
  } catch {
    /* oudere Android vraagt niets; dan gaan we door */
  }

  const om = new Date(Date.now() + seconden * 1000)

  try {
    await plugin.schedule({
      notifications: [
        {
          // Een vast nummer: een tweede test vervangt de eerste in plaats van
          // er een stapel meldingen van te maken.
          id: 8801,
          title: titel,
          body: tekst,
          schedule: {
            at: om,
            // Ook als het toestel in slaapstand staat. Zonder dit schuift
            // Android hem op tot het volgende moment dat hij toch wakker is,
            // en dan lijkt het alsof hij niet komt.
            allowWhileIdle: true,
          },
        },
      ],
    })
  } catch (e) {
    return { ok: false, reden: e instanceof Error ? e.message : String(e) }
  }

  return {
    ok: true,
    seconden,
    om: om.toISOString(),
    hint: 'Sluit de app nu helemaal af (via de app-wisselaar). Android houdt de ' +
          'melding zelf bij en toont hem op tijd.',
  }
}

/* ------------------------------------------------------------------ *
 *  Windows
 * ------------------------------------------------------------------ */

async function planWindows(
  seconden: number,
  titel: string,
  tekst: string,
): Promise<MeldingUitslag> {
  const brug = window.desktop as unknown as {
    meldingPlannen?(o: { seconden: number; titel: string; tekst: string }): Promise<MeldingUitslag>
  }

  if (typeof brug?.meldingPlannen !== 'function') {
    return {
      ok: false,
      reden: 'Deze versie van de kassa kan nog geen melding voor later plannen.',
    }
  }

  const uitslag = await brug.meldingPlannen({ seconden, titel, tekst })
  if (!uitslag.ok) return uitslag

  return {
    ...uitslag,
    hint: 'Sluit de kassa nu af. De melding komt van een los proces dat blijft ' +
          'staan, dus hij komt ook als de kassa dicht is.',
  }
}

/* ------------------------------------------------------------------ */

export async function planMelding(opts: {
  seconden: number
  titel?: string
  tekst?: string
}): Promise<MeldingUitslag> {
  const seconden = Math.max(1, Math.min(3600, Math.round(opts.seconden || 0)))
  const titel = opts.titel?.trim() || 'Truckwash1 Kassa'
  const tekst = opts.tekst?.trim() ||
    `Testmelding, ${seconden} seconden na het instellen.`

  if (opAndroid()) return planAndroid(seconden, titel, tekst)
  if (opWindows()) return planWindows(seconden, titel, tekst)

  return {
    ok: false,
    reden: 'In de browser kan dit niet: een webpagina die dicht is, krijgt geen ' +
           'melding zonder een pushdienst erachter. Probeer het op de ' +
           'Windows-kassa of op de tablet.',
  }
}
