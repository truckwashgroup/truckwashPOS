import { useEffect, useState, type ReactElement } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  AlertTriangle, Clock, CloudOff, ListMusic, Lock, LogOut, Moon,
  Music, Receipt, RefreshCw, Settings, ShoppingCart, Sun, Wallet,
} from 'lucide-react'
import logo from './assets/kassa-icoon.png'
import Toasts from './components/Toasts'
import { Knop, Pil, ThemaKnop } from './components/ui'
import Aanmelden from './screens/Aanmelden'
import Beheer from './screens/Beheer'
import Bonnen from './screens/Bonnen'
import Dagafsluiting from './screens/Dagafsluiting'
import Kassa from './screens/Kassa'
import Kluis from './screens/Kluis'
import Koppelen from './screens/Koppelen'
import Klok from './screens/Klok'
import Muziek from './screens/Muziek'
import Speler from './screens/Speler'
import VideoScherm from './components/VideoScherm'
import OpSlot from './components/OpSlot'
import { time } from './lib/format'
import { useTheme } from './lib/theme'
import { huidigeRegister } from './lib/kassa'
import { apparaatGezien, huidigApparaat } from './lib/koppelen'
import { can } from './lib/permissions'
import { magOpKassa } from './lib/code'
import { db } from './lib/db'
import { toast } from './store/useToasts'
import { startSyncEngine, useSync } from './lib/sync'
import { vastKort } from './lib/wachtrij'
import { useUpdates } from './lib/updates'
import { useAutomatischInstalleren } from './components/Updatemelding'
import { startAfmeldKlok, useAuth } from './store/useAuth'
import { useMandje } from './store/useMandje'
import { useSpeler, videoIsKlaar } from './store/useSpeler'

/* ------------------------------------------------------------------ *
 *  Het raamwerk
 *
 *  Drie poorten, en ze staan in deze volgorde met een reden:
 *
 *  1. Is dit apparaat gekoppeld? Zonder koppeling is er niets te doen -- dan
 *     weet de kassa niet welke vestiging dit is en mag hij niets ophalen.
 *     Tussen die poort en de volgende zit nog een tussenstand: het kantoor kan
 *     dit apparaat op slot zetten of eruit gooien, en dan komt er niemand
 *     langs -- ook niet om te klokken.
 *  2. Wie staat erachter? Zonder naam geen bon, want een bon zonder
 *     medewerker is een bon waar niemand voor staat.
 *  3. Daarna het gewone werk.
 *
 *  Klokken is de uitzondering: dat mag vanaf poort 2. Iemand die alleen komt
 *  inklokken hoeft niet eerst kassabediende te worden.
 * ------------------------------------------------------------------ */

type Blad = 'kassa' | 'klok' | 'bonnen' | 'kas' | 'kluis' | 'muziek' | 'speler' | 'beheer'

/**
 * Dit venster is het tweede scherm, niet de kassa.
 *
 * Het videovenster laadt dezelfde bundel met ?scherm=video erachter. Zo is er
 * één app om te onderhouden in plaats van twee, en die vlag is het enige
 * verschil.
 */
function isVideoVenster(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('scherm') === 'video'
  } catch {
    return false
  }
}

export default function App() {
  if (isVideoVenster()) return <VideoScherm />
  return <Kassascherm />
}

function Kassascherm() {
  const { apparaat, operator, booting, restore, meldAf } = useAuth()
  const mandje = useMandje()
  const updates = useUpdates()
  const [blad, setBlad] = useState<Blad>('kassa')
  const [alleenKlok, setAlleenKlok] = useState(false)

  const register = useLiveQuery(huidigeRegister, [], undefined)

  /*
   * Wat het kantoor van dit apparaat vindt. Undefined is "nog niet gekeken";
   * dat onderscheid is nodig, want een kassa die nog niet gesynchroniseerd
   * heeft mag niet op slot gaan omdat de lijst nog leeg is.
   */
  const apparaatRegel = useLiveQuery(huidigApparaat, [], undefined)

  /*
   * Bijwerken zonder dat iemand ernaar hoeft te vragen.
   *
   * Dit staat hier en niet in een van de poorten hieronder, want het moet
   * blijven lopen: een kassa die nog niet gekoppeld is of die op slot staat,
   * hoort net zo goed bij te werken. Wat het aan een herstart in de weg legt
   * -- iemand achter de kassa, iets in het mandje, een lopende verzending --
   * staat in updateMoment.ts.
   */
  useAutomatischInstalleren()

  /* ---- opstarten ---- */
  useEffect(() => {
    void restore()
    void mandje.herstel()
    void updates.init()
    void useSpeler.getState().herstel()
    startAfmeldKlok()

    /*
     * Het videovenster meldt dat een video klaar is. Dat besluit valt hier,
     * want de lijst staat hier -- niet in het venster dat alleen weergeeft.
     */
    return window.desktop?.spelerOpVideoKlaar?.(videoIsKlaar)
  }, [])

  useEffect(() => {
    if (apparaat) startSyncEngine()
  }, [apparaat])

  /*
   * Mag wie er nu achter de kassa staat er nog steeds staan?
   *
   * Zonder dit hield een ingetrokken recht pas op bij de volgende aanmelding,
   * of na vijf minuten stilte. Iemand die de hele middag doorverkoopt, merkt
   * daar niets van -- en dat is precies het geval waarin het uitmaakt.
   *
   * Dit leest de lokale cache, en die wordt sinds deze versie ook opgeruimd
   * (zie verwijderWatWegIs in sync.ts). Trekt het kantoor iets in, dan is dat
   * hier binnen een synchronisatieronde bekend.
   */
  const magNog = useLiveQuery(async () => {
    if (!operator) return true
    const rij = await db.users.get(operator.id)
    if (!rij || !rij.active) return false
    return magOpKassa(rij, register?.locationId, 'pos.use').ok
  }, [operator?.id, register?.locationId], true)

  useEffect(() => {
    if (!operator || magNog !== false) return
    meldAf()
    setAlleenKlok(false)
    toast.warn(
      `${operator.name.split(' ')[0]} is afgemeld: het kantoor heeft de ` +
      'toegang tot deze kassa ingetrokken. Inklokken kan nog wel.')
  }, [magNog, operator?.id])

  /*
   * Bijhouden dat dit apparaat er nog is, zodat het in de lijst van het
   * kantoor niet dood lijkt. Meer mag een kassa van zijn eigen regel niet
   * veranderen -- blokkeren en intrekken gebeurt in het dashboard, en dat
   * houdt de database ook echt tegen.
   */
  useEffect(() => {
    if (!apparaat) return
    /*
     * De versie gaat mee, en die komt uit de updatestore en niet uit de
     * webbundel: op Windows kent electron het nummer van de installatie en op
     * Android staat het in de APK. Bij een half gelukte update wijken die af
     * van de bundel, en dan is juist het echte nummer wat je wilt zien.
     */
    const melden = () => void apparaatGezien(useUpdates.getState().version)
    melden()
    const tik = setInterval(melden, 15 * 60_000)
    return () => clearInterval(tik)
  }, [apparaat?.id, updates.version])

  /* Een nieuwe medewerker begint op het kassascherm, niet waar de vorige
     gebleven was. */
  useEffect(() => {
    if (operator) { setBlad('kassa'); setAlleenKlok(false) }
  }, [operator?.id])

  if (booting || register === undefined) {
    return (
      <div className="midden">
        <ThemaKnop />
        <div style={{ textAlign: 'center', color: 'var(--text-3)' }}>
          <img src={logo} alt="" style={{ height: 44, borderRadius: 8, marginBottom: 14 }} />
          <div>Kassa wordt gestart…</div>
        </div>
      </div>
    )
  }

  /* ---- poort 1: gekoppeld? ---- */
  if (!apparaat || !register) {
    return (
      <>
        <Koppelen />
        {/*
          Zonder dit is elke melding tijdens het koppelen onzichtbaar.
          Meldingen komen rechtsonder in beeld, en die hoek bestond in deze
          poort niet -- dus leek een geweigerde code op "er gebeurt niets als
          ik op de knop druk". Dat is het ergste soort fout: er is wel een
          uitleg, hij komt alleen nergens aan.
        */}
        <Toasts />
      </>
    )
  }

  /* ---- poort 1b: mag dit apparaat nog? ----
   *
   * Alleen op slot bij een regel die er echt is en die het zegt. Staat er nog
   * niets in de cache, dan doet de kassa gewoon zijn werk: een kassa die op
   * slot gaat omdat de eerste synchronisatie nog loopt, is erger dan een kassa
   * die een minuut te lang open staat.
   */
  if (apparaatRegel && apparaatRegel.status !== 'actief') {
    return (
      <>
        <OpSlot apparaat={apparaatRegel} />
        <Toasts />
      </>
    )
  }

  /* ---- poort 2: wie staat erachter? ---- */
  if (!operator && !alleenKlok) {
    return (
      <>
        <Aanmelden onAlleenKlok={() => setAlleenKlok(true)} />
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
        {!alleenKlok && blad === 'kluis' && <Kluis register={register} />}
        {!alleenKlok && blad === 'muziek' && <Muziek />}
        {!alleenKlok && blad === 'speler' && <Speler />}
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
  const { online, syncing, pending, lastError, vast, sync } = useSync()
  const { actief, thema, setThema } = useTheme()
  const updates = useUpdates()
  const [klok, setKlok] = useState(Date.now())

  // De tijd op de kassa hoort te lopen; iemand kijkt erop.
  useEffect(() => {
    const t = setInterval(() => setKlok(Date.now()), 20_000)
    return () => clearInterval(t)
  }, [])

  /*
   * De kluis staat er alleen als deze medewerker erbij mag.
   *
   * Een tab die je wel ziet maar niet in kunt, is een uitnodiging om te vragen
   * waarom niet -- en aan een balie is dat een gesprek dat niemand wil hebben
   * met een chauffeur die staat te wachten. Wie het recht heeft, ziet hem;
   * wie hem mist en denkt dat hij erbij hoort, weet bij wie hij moet zijn.
   */
  /*
   * Een update is nieuws, geen alarm.
   *
   * Hier stond een pil "versie 0.10.1 klaar" in de balk. Dat werkte precies
   * één keer goed: zodra er ook iets anders bij kwam -- een vastgelopen
   * wachtrij bijvoorbeeld -- was de balk vol en schoof de Beheer-tab buiten
   * bereik. Je kon dus niet meer bij het scherm waar je die update installeert.
   *
   * Nu staat er een stip op Beheer, want daar zit het onder Versie. Dat is
   * zichtbaar, kost geen breedte, en het zit niemand in de weg die iets anders
   * aan het doen is.
   */
  const updateKlaar = updates.state === 'ready' || updates.state === 'available'

  const tabs: { id: Blad; label: string; icoon: ReactElement; stip?: boolean }[] = [
    { id: 'kassa', label: 'Kassa', icoon: <ShoppingCart size={16} /> },
    { id: 'klok', label: 'Klok', icoon: <Clock size={16} /> },
    { id: 'bonnen', label: 'Bonnen', icoon: <Receipt size={16} /> },
    { id: 'kas', label: 'Kas', icoon: <Wallet size={16} /> },
    ...(can(operator, 'pos.safe')
      ? [{ id: 'kluis' as Blad, label: 'Kluis', icoon: <Lock size={16} /> }]
      : []),
    { id: 'muziek', label: 'Muziek', icoon: <Music size={16} /> },
    { id: 'speler', label: 'Speler', icoon: <ListMusic size={16} /> },
    { id: 'beheer', label: 'Beheer', icoon: <Settings size={16} />, stip: updateKlaar },
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
              title={t.stip
                ? `Versie ${updates.newVersion ?? ''} staat klaar — onder Versie`
                : undefined}
            >
              {t.icoon} {t.label}
              {t.stip && <span className="tabstip" aria-label="update klaar" />}
            </button>
          ))}
        </div>
      )}

      <div className="rek" />

      {/*
        Vastgelopen werk krijgt een eigen pil, en die is rood.

        Waarom niet in de bestaande pil erbij: "12 wacht" en "1 klokregel vast"
        zijn twee verschillende dingen. Het eerste gaat over en het tweede niet
        -- en juist dat verschil moet te zien zijn zonder erop te klikken. Hij
        brengt je naar de Klok, want daar staat het hele verhaal.
      */}
      {vastKort(vast) && (
        <button
          type="button"
          className="pil fout"
          onClick={() => onBlad('klok')}
          title="Klik voor wat er vastzit en wat eraan te doen valt"
          style={{ cursor: 'pointer' }}
        >
          <AlertTriangle size={13} /> {vastKort(vast)}
        </button>
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

      {/* Wijkt op een smal scherm; zie kassa.css. De tijd staat ook rechtsonder
          op elke bon, en op de kassa hangt meestal een klok aan de muur. */}
      <span className="pil cijfers tijd">{time(klok)}</span>

      {operator && (
        <button type="button" className="pil" onClick={onAfmelden} style={{ cursor: 'pointer' }}>
          <LogOut size={13} /> {operator.name.split(' ')[0]}
        </button>
      )}
    </div>
  )
}
