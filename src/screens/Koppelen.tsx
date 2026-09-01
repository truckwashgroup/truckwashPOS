import { useEffect, useRef, useState } from 'react'
import { KeyRound, RefreshCw } from 'lucide-react'
import Toetsenblok from '../components/Toetsenblok'
import Voorportaal from '../components/Voorportaal'
import { Fout, Knop, Uitleg, Waarschuwing } from '../components/ui'
import { backendError } from '../lib/api'
import { koppelcodeOpschonen, koppelcodeProbleem } from '../lib/koppelen'
import { useAuth } from '../store/useAuth'

/* ------------------------------------------------------------------ *
 *  Dit apparaat koppelen
 *
 *  Het eerste scherm van een nieuwe kassa, en meestal het enige dat iemand
 *  ervan ziet. Eén veld, één code.
 *
 *  Waarom hier geen e-mailadres en wachtwoord meer staat: dan stond er op elke
 *  tablet achter de balie iemands wachtwoord, en wist het kantoor niet welke
 *  apparaten er meededen. Nu maakt het kantoor de kassa aan, zet er een code
 *  bij, en krijgt dit apparaat zijn eigen inlog. Zie lib/koppelen.ts.
 *
 *  De code wordt aangetikt en niet in een invoerveld getypt. Een kassa is een
 *  aanraakscherm, en een schermtoetsenbord dat over het veld heen schuift is
 *  precies het soort ding waar iemand op een maandagochtend op vastloopt.
 *  Staat er een echt toetsenbord bij -- op de Windows-kassa meestal wel --
 *  dan werkt dat ook: letters, cijfers, backspace en enter.
 * ------------------------------------------------------------------ */

const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ'

export default function Koppelen() {
  const { koppel, busy, error } = useAuth()
  const [ruw, setRuw] = useState('')
  const [eigenFout, setEigenFout] = useState<string | null>(null)

  const code = koppelcodeOpschonen(ruw)
  const probleem = code ? koppelcodeProbleem(code) : null
  const klaar = code.length === 8 && !probleem

  /*
   * Meelezen op het toetsenbord: letters én cijfers, backspace en enter.
   *
   * Het toetsenblok kan dat zelf ook, maar dan alleen cijfers -- en dan zouden
   * we twee luisteraars hebben die allebei een cijfer toevoegen. Vandaar dat
   * het toetsenblok hieronder met toetsenbord={false} staat: één plek die
   * meeleest, en dat is deze.
   *
   * De verzendfunctie gaat via een ref. Zonder dat leest deze luisteraar de
   * versie van bij het opstarten, en die weet nog niet dat er acht tekens
   * staan -- dan doet Enter niets en denk je dat de toets kapot is.
   */
  const verzenden = useRef<() => void>(() => {})

  useEffect(() => {
    function toets(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const doel = e.target as HTMLElement | null
      if (doel && ['INPUT', 'TEXTAREA', 'SELECT'].includes(doel.tagName)) return

      if (e.key === 'Backspace') {
        e.preventDefault()
        setRuw((v) => v.slice(0, -1))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        verzenden.current()
        return
      }
      const teken = e.key.toUpperCase()
      if (teken.length === 1 && /[A-Z0-9]/.test(teken)) {
        e.preventDefault()
        setRuw((v) => (koppelcodeOpschonen(v).length >= 8 ? v : v + teken))
      }
    }
    window.addEventListener('keydown', toets)
    return () => window.removeEventListener('keydown', toets)
  }, [])

  async function verstuur() {
    setEigenFout(null)
    const bezwaar = koppelcodeProbleem(code)
    if (bezwaar) { setEigenFout(bezwaar); return }
    const uitslag = await koppel(code)
    if (!uitslag.ok) setRuw('')
  }

  verzenden.current = () => { if (klaar && !busy) void verstuur() }

  /** K7QJ4M2P wordt K7QJ-4M2P: zo lees je hem over van een scherm. */
  const netjes = code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code

  return (
    <Voorportaal breed ondertitel="Kassa koppelen">
      <div>
        <h2>Deze kassa koppelen</h2>
        <p className="onder">
          Vraag het kantoor om een koppelcode voor deze kassa. Die staat in het
          dashboard onder Kassa&apos;s, geldt één keer en verloopt.
        </p>

        {backendError && (
          <div style={{ marginBottom: 16 }}><Fout>{backendError}</Fout></div>
        )}

        <div className="koppelvak cijfers">
          {netjes || <span className="koppelvak-leeg">– – – –  – – – –</span>}
        </div>

        {probleem && code.length >= 8 && (
          <div style={{ marginTop: 12 }}><Waarschuwing>{probleem}</Waarschuwing></div>
        )}

        {(error || eigenFout) && (
          <div style={{ marginTop: 12 }}><Fout>{eigenFout ?? error}</Fout></div>
        )}

        <div style={{ marginTop: 14, display: 'grid', gap: 14, gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
          <div>
            <div className="muntkop">Letters</div>
            <div className="letterbord">
              {LETTERS.split('').map((l) => (
                <button
                  key={l}
                  type="button"
                  className="letter"
                  onClick={() => setRuw((v) => (koppelcodeOpschonen(v).length >= 8 ? v : v + l))}
                  disabled={code.length >= 8}
                >
                  {l}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 8 }}>
              De I, de L en de O staan er niet bij, en de 0 en de 1 ook niet.
              Die worden bij het overtypen door elkaar gehaald, dus zitten ze
              niet in een koppelcode.
            </div>
          </div>

          <Toetsenblok
            waarde={code}
            onWaarde={setRuw}
            maxLengte={8}
            toetsenbord={false}
            onKlaar={() => void verstuur()}
            klaarTekst={busy ? '…' : 'OK'}
            klaarUit={!klaar || busy}
          />
        </div>

        <div style={{ marginTop: 18 }}>
          <Knop
            soort="hoofd"
            breed
            onClick={() => void verstuur()}
            disabled={busy || !klaar}
          >
            {busy
              ? <><RefreshCw size={17} className="draait" /> Koppelen…</>
              : <><KeyRound size={17} /> Kassa koppelen</>}
          </Knop>
        </div>

        <div style={{ marginTop: 18 }}>
          <Uitleg>
            Koppelen gaat één keer en vraagt internet. Daarna werkt de kassa ook
            zonder verbinding: afrekenen, bon afdrukken en de lade openen
            gebeuren op dit apparaat, en de administratie loopt erachteraan.
          </Uitleg>
        </div>
      </div>
    </Voorportaal>
  )
}
