import { useEffect, useState } from 'react'
import {
  Cast, Pause, Play, Search, SkipBack, SkipForward, Speaker, Volume2, VolumeX,
} from 'lucide-react'
import { Fout, Knop, Leeg, Pil, Uitleg } from '../components/ui'
import {
  bestuur, gekozenApparaat, haalStand, kanMuziek, kiesApparaat, zoekApparaten,
  type MuziekApparaat, type MuziekStand,
} from '../lib/hardware/muziek'
import { useAuth } from '../store/useAuth'
import { toast } from '../store/useToasts'

/* ------------------------------------------------------------------ *
 *  Muziek
 *
 *  Bijsturen, niet beheren: pauze, volgende, volume. Dat is wat je aan een
 *  balie doet -- je pakt de kassa erbij omdat het te hard staat of omdat
 *  iemand het nummer zat is. Kiezen wát er speelt gebeurt op het apparaat
 *  waar het vandaan komt.
 *
 *  Het gaat over het eigen netwerk (UPnP): geen account, geen sleutel, geen
 *  internet. Ligt de verbinding met buiten eruit, dan werkt dit nog steeds --
 *  net als de rest van de kassa.
 * ------------------------------------------------------------------ */

/** Hoe vaak we vragen wat er speelt terwijl het scherm openstaat. */
const RITME_MS = 5000

export default function Muziek() {
  const { raakAan } = useAuth()
  const [apparaat, setApparaat] = useState<MuziekApparaat | null>(null)
  const [geladen, setGeladen] = useState(false)
  const [stand, setStand] = useState<MuziekStand | null>(null)
  const [zoeken, setZoeken] = useState(false)
  const [gevonden, setGevonden] = useState<MuziekApparaat[] | null>(null)
  const [google, setGoogle] = useState<string[]>([])
  const [zoekfout, setZoekfout] = useState<string | null>(null)
  const [schuif, setSchuif] = useState<number | null>(null)

  /* ---- wat er gekozen is ---- */
  useEffect(() => {
    void (async () => {
      setApparaat(await gekozenApparaat())
      setGeladen(true)
    })()
  }, [])

  /* ---- wat er speelt, zolang dit scherm openstaat ---- */
  useEffect(() => {
    if (!apparaat) return

    let gestopt = false
    const kijk = async () => {
      const s = await haalStand(apparaat)
      if (gestopt) return
      setStand(s)
      // De schuif niet overschrijven terwijl iemand hem vasthoudt.
      setSchuif((huidig) => (huidig === null ? null : huidig))
    }

    void kijk()
    const tik = setInterval(kijk, RITME_MS)
    return () => { gestopt = true; clearInterval(tik) }
  }, [apparaat?.id])

  async function zoek() {
    setZoeken(true)
    setZoekfout(null)
    const uitslag = await zoekApparaten()
    setZoeken(false)
    setGevonden(uitslag.apparaten)
    setGoogle(uitslag.google)
    if (uitslag.fout) setZoekfout(uitslag.fout)
  }

  async function kies(a: MuziekApparaat | null) {
    await kiesApparaat(a)
    setApparaat(a)
    setStand(null)
    setGevonden(null)
    if (a) toast.ok(`${a.naam} is gekozen.`)
  }

  async function doe(actie: Parameters<typeof bestuur>[1], waarde?: number | boolean) {
    if (!apparaat) return
    raakAan()
    const uitslag = await bestuur(apparaat, actie, waarde)
    if (!uitslag.ok) {
      toast.warn(uitslag.reden ?? 'Dat lukte niet.')
      return
    }
    // Meteen opnieuw kijken: anders staat de knop nog een paar seconden op de
    // oude stand en denk je dat er niets gebeurde.
    setStand(await haalStand(apparaat))
  }

  if (!geladen) return <div className="paneel"><Leeg tekst="Even kijken…" /></div>

  /* ---------------- nog niets gekozen ---------------- */

  if (!apparaat) {
    return (
      <div className="paneel">
        <div className="kaart" style={{ maxWidth: 680 }}>
          <h3>Muziek</h3>
          <p className="uitleg">
            De kassa kan de muziek bijsturen die op een speaker in het netwerk
            speelt: pauze, volgende, volume. Dat gaat over het eigen netwerk —
            geen account, geen abonnement, en het werkt ook als het internet
            eruit ligt.
          </p>

          {!kanMuziek() && (
            <Uitleg>
              Dit werkt alleen op de Windows-kassa. Een tablet mag geen
              netwerkopdrachten naar een speaker sturen.
            </Uitleg>
          )}

          {kanMuziek() && (
            <>
              <Knop soort="hoofd" onClick={() => void zoek()} disabled={zoeken}>
                <Search size={18} /> {zoeken ? 'Zoeken…' : 'Zoeken op het netwerk'}
              </Knop>

              {zoekfout && <div style={{ marginTop: 14 }}><Fout>{zoekfout}</Fout></div>}

              {gevonden !== null && (
                <div style={{ marginTop: 18 }}>
                  {gevonden.length === 0 ? (
                    <Uitleg>
                      Niets gevonden. Drie dingen die dat verklaren, in de
                      volgorde waarin ze meestal de oorzaak zijn:
                      <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                        <li>
                          de kassa en de speaker hangen niet op hetzelfde
                          netwerk (gastnetwerk, of een andere wifi);
                        </li>
                        <li>
                          de Windows-firewall houdt het antwoord tegen — dit
                          gaat over UDP, en dat wordt vaak geblokkeerd;
                        </li>
                        <li>
                          de speaker spreekt geen UPnP. Een Bluetooth-box of
                          een kabelspeaker kan van buitenaf niet bestuurd
                          worden; die heeft geen netwerkadres.
                        </li>
                      </ul>
                      {/*
                        Een Echo hoort hier expliciet bij te staan. Hij wordt
                        niet gevonden en dat is verwacht -- Amazon heeft nooit
                        een lokale API uitgebracht, alles gaat via hun cloud.
                        Zonder deze regel gaat iemand hier over een half jaar
                        naar een fout zoeken die er niet is.
                      */}
                      <div style={{ marginTop: 10 }}>
                        Staat er een <strong>Alexa of Echo</strong>? Die wordt
                        niet gevonden, en dat klopt: hij spreekt geen UPnP.
                        Bijsturen doe je daar met je stem — "Alexa, pauze" —
                        en dat werkt zonder dat de kassa erbij hoeft.
                      </div>
                    </Uitleg>
                  ) : (
                    <>
                      <h3>Gevonden</h3>
                      <div className="lijst">
                        {gevonden.map((a) => (
                          <button
                            key={a.id}
                            type="button"
                            className="lijstrij"
                            onClick={() => void kies(a)}
                          >
                            <Speaker size={18} />
                            <div className="rek">
                              <div className="titel">{a.naam}</div>
                              <div className="onder">
                                {[a.merk, a.model].filter(Boolean).join(' ')}
                                {a.volumeUrl ? '' : ' · volume niet instelbaar'}
                              </div>
                            </div>
                            <Pil soort="ok">kiezen</Pil>
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  {google.length > 0 && (
                    <div style={{ marginTop: 16 }}>
                      <Uitleg>
                        <Cast size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
                        Er staat ook iets van Google op het netwerk
                        ({google.join(', ')}) — een Chromecast of Nest. Die
                        spreekt geen UPnP maar een eigen protocol, dus de kassa
                        kan er nu niets mee. Laat het weten als dít het apparaat
                        is dat je gebruikt; dan bouw ik het erbij.
                      </Uitleg>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  /* ---------------- besturen ---------------- */

  const volume = schuif ?? stand?.volume ?? null
  const nummer = stand?.nummer

  return (
    <div className="paneel">
      <div className="kaart" style={{ maxWidth: 680 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Speaker size={20} />
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0 }}>{apparaat.naam}</h3>
            <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
              {[apparaat.merk, apparaat.model].filter(Boolean).join(' ')}
            </div>
          </div>
          {stand && !stand.fout && (
            <Pil soort={stand.speelt ? 'ok' : 'gewoon'}>
              {stand.speelt ? 'speelt' : 'staat stil'}
            </Pil>
          )}
        </div>

        {stand?.fout && (
          <div style={{ marginTop: 16 }}>
            <Fout>
              Geen contact met {apparaat.naam}: {stand.fout}
              <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                <Knop maat="klein" onClick={() => void zoek()}>Opnieuw zoeken</Knop>
                <Knop maat="klein" soort="stil" onClick={() => void kies(null)}>
                  Ander apparaat
                </Knop>
              </div>
            </Fout>
          </div>
        )}

        {/* Wat er speelt. Leeg laten is beter dan "onbekend" verzinnen. */}
        <div
          style={{
            marginTop: 18, padding: '16px 18px', borderRadius: 'var(--radius)',
            background: 'var(--bg-2)', border: '1px solid var(--line)',
            minHeight: 74,
          }}
        >
          {nummer?.titel ? (
            <>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{nummer.titel}</div>
              <div style={{ fontSize: 13.5, color: 'var(--text-3)', marginTop: 3 }}>
                {[nummer.artiest, nummer.album].filter(Boolean).join(' · ')}
                {nummer.positie && nummer.duur
                  ? ` — ${nummer.positie} / ${nummer.duur}`
                  : ''}
              </div>
            </>
          ) : (
            <div style={{ color: 'var(--text-3)', fontSize: 14 }}>
              {stand?.fout
                ? 'Niet op te vragen.'
                : 'Dit apparaat vertelt niet wat er speelt.'}
            </div>
          )}
        </div>

        {/* De knoppen. Groot, want dit wordt met een duim aangetikt. */}
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <Knop maat="groot" onClick={() => void doe('vorige')} style={{ flex: 1 }}>
            <SkipBack size={22} />
          </Knop>
          <Knop
            soort="hoofd"
            maat="groot"
            onClick={() => void doe(stand?.speelt ? 'pauze' : 'spelen')}
            style={{ flex: 2 }}
          >
            {stand?.speelt ? <Pause size={24} /> : <Play size={24} />}
            {stand?.speelt ? 'Pauze' : 'Spelen'}
          </Knop>
          <Knop maat="groot" onClick={() => void doe('volgende')} style={{ flex: 1 }}>
            <SkipForward size={22} />
          </Knop>
        </div>

        {/* Volume, als het apparaat het toelaat. */}
        {apparaat.volumeUrl && volume !== null && (
          <div style={{ marginTop: 18 }}>
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8,
              }}
            >
              <Knop
                maat="klein"
                soort={stand?.gedempt ? 'gevaar' : 'gewoon'}
                onClick={() => void doe('dempen', !stand?.gedempt)}
              >
                {stand?.gedempt ? <VolumeX size={17} /> : <Volume2 size={17} />}
                {stand?.gedempt ? 'Gedempt' : 'Geluid aan'}
              </Knop>
              <span
                className="bedrag"
                style={{ marginLeft: 'auto', fontSize: 20, fontWeight: 800 }}
              >
                {volume}%
              </span>
            </div>

            <input
              type="range"
              min={0}
              max={100}
              value={volume}
              onChange={(e) => setSchuif(Number(e.target.value))}
              /*
                Pas versturen als de schuif wordt losgelaten. Bij elke beweging
                een opdracht sturen geeft tientallen verzoeken per seconde, en
                dan loopt een Sonos achter of hapert hij.
              */
              onMouseUp={() => { if (schuif !== null) { void doe('volume', schuif); setSchuif(null) } }}
              onTouchEnd={() => { if (schuif !== null) { void doe('volume', schuif); setSchuif(null) } }}
              style={{ width: '100%', height: 40, accentColor: 'var(--brand)' }}
            />

            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              {[10, 25, 40, 60].map((n) => (
                <Knop key={n} maat="klein" onClick={() => void doe('volume', n)}>
                  {n}%
                </Knop>
              ))}
            </div>
          </div>
        )}

        {apparaat.volumeUrl === '' && (
          <div style={{ marginTop: 16 }}>
            <Uitleg>
              Dit apparaat laat het volume niet van buitenaf instellen. Pauze en
              volgende werken wel.
            </Uitleg>
          </div>
        )}

        <div
          style={{
            marginTop: 20, paddingTop: 14, borderTop: '1px solid var(--line)',
            display: 'flex', gap: 10,
          }}
        >
          <Knop maat="klein" soort="stil" onClick={() => void kies(null)}>
            Ander apparaat kiezen
          </Knop>
        </div>
      </div>
    </div>
  )
}
