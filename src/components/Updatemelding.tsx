import { useEffect, useRef, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import { geraakt, stilMs, useUpdates } from '../lib/updates'
import {
  STIL_GENOEG_MS, mogenWeInstalleren, updateBericht, type Situatie,
} from '../lib/updateMoment'
import { useAuth } from '../store/useAuth'
import { useMandje } from '../store/useMandje'
import { useSync } from '../lib/sync'

/* ------------------------------------------------------------------ *
 *  De update aan de voorkant
 *
 *  Hij stond onder Beheer -> Versie, en dat scherm zit achter een aanmelding.
 *  Een kassa waar niemand achter staat installeerde dus nooit iets -- en dat
 *  is precies de kassa die het het langst niet doet.
 *
 *  Wat hier staat is de kant die je ziet. Wanneer het mag staat in
 *  updateMoment.ts, los, zodat de zelftest die regels kan nalopen zonder een
 *  scherm te bouwen.
 *
 *  Twee dingen die bij elkaar horen en toch los staan:
 *
 *    Updatemelding             de regel op het aanmeldscherm, met een knop
 *    useAutomatischInstalleren de kassa die het zelf doet als hij vrij is
 *
 *  Ze staan los omdat de eerste alleen op de voorkant hoort en de tweede
 *  altijd moet lopen. Een kassa die net is losgekoppeld of op slot staat, mag
 *  ook nog bijwerken.
 * ------------------------------------------------------------------ */

/**
 * De stand van zaken, één keer per seconde bijgewerkt.
 *
 * Alleen tikken als er iets klaarstaat. Een interval dat de hele dag elke
 * seconde een scherm opnieuw laat tekenen is op een tablet te merken, en er is
 * negenennegentig procent van de tijd niets te zien.
 */
function useSituatie(): Situatie {
  const { channel, state, magInstalleren, uitgesteldTot } = useUpdates()
  const { operator } = useAuth()
  const regels = useMandje((m) => m.regels)
  const syncing = useSync((s) => s.syncing)
  const [, tik] = useState(0)

  const telt = state === 'ready' || state === 'downloading'

  useEffect(() => {
    if (!telt) return
    const t = setInterval(() => tik((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [telt])

  return {
    kanaal: channel,
    stand: state,
    magInstalleren,
    bezet: Boolean(operator),
    mandje: regels.length > 0,
    verstuurt: syncing,
    stilMs: stilMs(),
    uitgesteldTot,
    nu: Date.now(),
  }
}

/**
 * De kassa installeert zichzelf zodra hij vrij is.
 *
 * Dit is de hele opdracht: niemand hoeft ervoor in te loggen, en niemand hoeft
 * eraan te denken. Op Windows kan dat helemaal vanzelf. Op Android niet -- het
 * systeem zet er altijd een eigen bevestiging voor -- en daar doet de knop op
 * het aanmeldscherm het werk.
 */
export function useAutomatischInstalleren() {
  const situatie = useSituatie()
  const { install, installeert } = useUpdates()
  const gestart = useRef(false)

  useEffect(() => {
    // Aanraken bijhouden op het venster, niet op een scherm: het gaat erom of
    // er íets gebeurt, en dat kan overal zijn.
    const opts = { capture: true, passive: true } as const
    window.addEventListener('pointerdown', geraakt, opts)
    window.addEventListener('keydown', geraakt, opts)
    window.addEventListener('wheel', geraakt, opts)
    return () => {
      window.removeEventListener('pointerdown', geraakt, opts)
      window.removeEventListener('keydown', geraakt, opts)
      window.removeEventListener('wheel', geraakt, opts)
    }
  }, [])

  useEffect(() => {
    if (installeert || gestart.current) return
    if (!mogenWeInstalleren(situatie).nu) return

    /*
     * Eén keer, en dan nooit meer in deze sessie.
     *
     * quitAndInstall komt niet terug -- de app sluit af en start opnieuw op --
     * maar als dat om wat voor reden dan ook mislukt, staat de situatie een
     * seconde later nog steeds op "mag". Zonder deze rem is dat een kassa die
     * elke seconde probeert af te sluiten.
     */
    gestart.current = true
    void install()
  }, [situatie.stand, situatie.bezet, situatie.mandje, situatie.verstuurt,
      situatie.stilMs >= STIL_GENOEG_MS, situatie.uitgesteldTot, installeert])
}

/**
 * De regel op het aanmeldscherm.
 *
 * "Zichtbaar maar niet hinderlijk" was de eis. Dus: onder wat je aan het doen
 * bent, in de kleur van gewone uitleg, en niets als er niets te zeggen is. Wie
 * hem negeert, krijgt de update alsnog -- en dat is de bedoeling.
 */
export default function Updatemelding() {
  const situatie = useSituatie()
  const {
    newVersion, percent, install, uitstellen, toestemmingVragen, check, state,
  } = useUpdates()

  const bericht = updateBericht(situatie, newVersion)
  if (!bericht) return null

  return (
    <div className="updatemelding">
      <div className="regel">
        <span>{bericht.tekst}</span>
        {state === 'downloading' && (
          <span className="cijfers">{percent}%</span>
        )}
      </div>

      {state === 'downloading' && (
        <div className="balkje"><i style={{ width: `${percent}%` }} /></div>
      )}

      {(bericht.knop || bericht.uitstellen) && (
        <div className="knoppen">
          {bericht.knop === 'installeren' && (
            <button type="button" className="nu" onClick={() => void install()}>
              <Download size={14} /> Nu installeren
            </button>
          )}
          {bericht.knop === 'toestemming' && (
            <button type="button" className="nu" onClick={() => void toestemmingVragen()}>
              Toestaan
            </button>
          )}
          {bericht.uitstellen && (
            <button type="button" onClick={() => uitstellen()}>Straks</button>
          )}
        </div>
      )}

      {/*
        Handmatig kijken hoort hier ook, en niet alleen onder Beheer. Wie
        vermoedt dat een kassa achterloopt, moet dat kunnen nakijken zonder
        zich eerst aan te melden -- en op een kassa die niet gekoppeld is kan
        dat helemaal niet.
      */}
      {state !== 'downloading' && (
        <button type="button" className="kijken" onClick={() => void check()}>
          <RefreshCw size={12} /> Opnieuw kijken
        </button>
      )}
    </div>
  )
}

/**
 * Alleen de "kijk of er een update is"-regel, voor als er niets klaarstaat.
 *
 * Anders is er op het aanmeldscherm geen enkele manier om te zien welke versie
 * erop staat of om te kijken of er een nieuwe is, en dat is aan een balie waar
 * niemand beheerrechten heeft precies het gat dat we aan het dichten zijn.
 */
export function Versieregel() {
  const { version, state, check } = useUpdates()

  return (
    <div className="versieregel">
      <span>versie {version}</span>
      <button type="button" onClick={() => void check()} disabled={state === 'checking'}>
        {state === 'checking' ? 'kijken…' : 'kijk of er een update is'}
      </button>
    </div>
  )
}
