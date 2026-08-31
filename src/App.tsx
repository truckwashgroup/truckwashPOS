import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Clock, CloudOff, Download, LogOut, Moon, Receipt, RefreshCw, Settings,
  ShoppingCart, Sun, Wallet,
} from 'lucide-react'
import logo from './assets/kassa-icoon.png'
import Toasts from './components/Toasts'
import { Knop, Pil } from './components/ui'
import Aanmelden from './screens/Aanmelden'
import Beheer from './screens/Beheer'
import Bonnen from './screens/Bonnen'
import Dagafsluiting from './screens/Dagafsluiting'
import Inrichten from './screens/Inrichten'
import Kassa from './screens/Kassa'
import Klok from './screens/Klok'
import { time } from './lib/format'
import { useTheme } from './lib/theme'
import { huidigeRegister } from './lib/kassa'
import { startSyncEngine, useSync } from './lib/sync'
import { useUpdates } from './lib/updates'
import { startAfmeldKlok, useAuth } from './store/useAuth'
import { useMandje } from './store/useMandje'

/* ------------------------------------------------------------------ *
 *  Het raamwerk
 *
 *  Drie poorten, en ze staan in deze volgorde met een reden:
 *
 *  1. Is dit apparaat ingericht? Zonder account en zonder kassa is er niets
 *     te doen -- dan weet de kassa niet welke vestiging dit is.
 *  2. Wie staat erachter? Zonder naam geen bon, want een bon zonder
 *     medewerker is een bon waar niemand voor staat.
 *  3. Daarna het gewone werk.
 *
 *  Klokken is de uitzondering: dat mag vanaf poort 2. Iemand die alleen komt
 *  inklokken hoeft niet eerst kassabediende te worden.
 * ------------------------------------------------------------------ */

type Blad = 'kassa' | 'klok' | 'bonnen' | 'kas' | 'beheer'

export default function App() {
  const { apparaat, operator, booting, restore, meldAf } = useAuth()
  const mandje = useMandje()
  const updates = useUpdates()
  const [blad, setBlad] = useState<Blad>('kassa')
  const [alleenKlok, setAlleenKlok] = useState(false)

  const register = useLiveQuery(() => huidigeRegister(), [], undefined)

  /* ---- opstarten ---- */
  useEffect(() => {
    void restore()
    void mandje.herstel()
    void updates.init()
    startAfmeldKlok()
  }, [])

  useEffect(() => {
    if (apparaat) startSyncEngine()
  }, [apparaat])

  /* Een nieuwe medewerker begint op het kassascherm, niet waar de vorige
     gebleven was. */
  useEffect(() => {
    if (operator) { setBlad('kassa'); setAlleenKlok(false) }
  }, [operator?.id])

  if (booting || register === undefined) {
    return (
      <div className="midden">
        <div style={{ textAlign: 'center', color: 'var(--text-3)' }}>
          <img src={logo} alt="" style={{ height: 44, borderRadius: 8, marginBottom: 14 }} />
          <div>Kassa wordt gestart…</div>
        </div>
      </div>
    )
  }

  /* ---- poort 1: ingericht? ---- */
  if (!apparaat || !register) {
    return (
      <>
        <Inrichten />
        {/*
          Zonder dit is elke melding tijdens het inrichten onzichtbaar.
          Meldingen komen rechtsonder in beeld, en die hoek bestond in deze
          poort niet -- dus leek een geweigerde kassacode op "er gebeurt
          niets als ik op de knop druk". Dat is het ergste soort fout: er is
          wel een uitleg, hij komt alleen nergens aan.
        */}
        <Toasts />
      </>
    )
  }

  /* ---- poort 2: wie staat erachter? ---- */
  if (!operator && !alleenKlok) {
    return (
      <>
        <Aanmelden />
        <div
          style={{
            position: 'fixed', bottom: 22, left: 0, right: 0,
            display: 'flex', justifyContent: 'center',
          }}
        >
          <Knop soort="stil" onClick={() => setAlleenKlok(true)}>
            <Clock size={17} /> Alleen in- of uitklokken
          </Knop>
        </div>
        <Toasts />
      </>
    )
  }

  /* ---- het gewone werk ---- */
  return (
    <div className="app">
      <Balk
        register={register}
        blad={alleenKlok ? 'klok' : blad}
        onBlad={setBlad}
        alleenKlok={alleenKlok}
        onTerug={() => setAlleenKlok(false)}
        onAfmelden={() => { meldAf(); setAlleenKlok(false) }}
      />

      <div className="werkvlak">
        {(alleenKlok || blad === 'klok') && <Klok />}
        {!alleenKlok && blad === 'kassa' && <Kassa register={register} />}
        {!alleenKlok && blad === 'bonnen' && <Bonnen register={register} />}
        {!alleenKlok && blad === 'kas' && <Dagafsluiting register={register} />}
        {!alleenKlok && blad === 'beheer' && <Beheer register={register} />}
      </div>

      <Toasts />
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  De balk bovenaan
 * ------------------------------------------------------------------ */

function Balk({
  register, blad, onBlad, alleenKlok, onTerug, onAfmelden,
}: {
  register: { code: string; name: string }
  blad: Blad
  onBlad: (b: Blad) => void
  alleenKlok: boolean
  onTerug: () => void
  onAfmelden: () => void
}) {
  const { operator } = useAuth()
  const { online, syncing, pending, lastError, sync } = useSync()
  const { actief, thema, setThema } = useTheme()
  const updates = useUpdates()
  const [klok, setKlok] = useState(Date.now())

  // De tijd op de kassa hoort te lopen; iemand kijkt erop.
  useEffect(() => {
    const t = setInterval(() => setKlok(Date.now()), 20_000)
    return () => clearInterval(t)
  }, [])

  const tabs: { id: Blad; label: string; icoon: JSX.Element }[] = [
    { id: 'kassa', label: 'Kassa', icoon: <ShoppingCart size={16} /> },
    { id: 'klok', label: 'Klok', icoon: <Clock size={16} /> },
    { id: 'bonnen', label: 'Bonnen', icoon: <Receipt size={16} /> },
    { id: 'kas', label: 'Kas', icoon: <Wallet size={16} /> },
    { id: 'beheer', label: 'Beheer', icoon: <Settings size={16} /> },
  ]

  return (
    <div className="balk">
      <div className="merk">
        <img src={logo} alt="" />
        <span className="cijfers">{register.code}</span>
      </div>

      {alleenKlok ? (
        <Knop maat="klein" soort="stil" onClick={onTerug}>Terug naar aanmelden</Knop>
      ) : (
        <div className="tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tab ${blad === t.id ? 'aan' : ''}`}
              onClick={() => onBlad(t.id)}
            >
              {t.icoon} {t.label}
            </button>
          ))}
        </div>
      )}

      <div className="rek" />

      {updates.state === 'ready' && (
        <Pil soort="merk">
          <Download size={13} /> versie {updates.newVersion} klaar
        </Pil>
      )}

      <button
        type="button"
        className="pil"
        onClick={() => void sync()}
        title={lastError ?? 'Nu bijwerken'}
        style={{ cursor: 'pointer' }}
      >
        {syncing
          ? <RefreshCw size={13} className="draait" />
          : online ? <RefreshCw size={13} /> : <CloudOff size={13} />}
        {pending > 0
          ? `${pending} wacht`
          : online ? 'bij' : 'offline'}
      </button>

      {/*
        Licht en donker in één tik. Aan een balie wisselt het licht met het
        weer, niet met een voorkeur -- dus hoort dit binnen bereik te staan
        en niet drie schermen diep. De volledige keuze (inclusief "volg het
        systeem") staat onder Beheer.
      */}
      <button
        type="button"
        className="pil"
        onClick={() => setThema(actief === 'donker' ? 'licht' : 'donker')}
        title={thema === 'systeem'
          ? 'Volgt nu je systeem — tik om vast te zetten'
          : actief === 'donker' ? 'Naar licht' : 'Naar donker'}
        style={{ cursor: 'pointer' }}
        aria-label="Licht of donker"
      >
        {actief === 'donker' ? <Moon size={13} /> : <Sun size={13} />}
      </button>

      <span className="pil cijfers">{time(klok)}</span>

      {operator && (
        <button type="button" className="pil" onClick={onAfmelden} style={{ cursor: 'pointer' }}>
          <LogOut size={13} /> {operator.name.split(' ')[0]}
        </button>
      )}
    </div>
  )
}
