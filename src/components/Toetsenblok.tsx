import { useEffect, type ReactNode } from 'react'
import { Delete } from 'lucide-react'

/* ------------------------------------------------------------------ *
 *  Het toetsenblok
 *
 *  Voor codes en voor bedragen. Twee dingen die het bruikbaar maken aan een
 *  kassa:
 *
 *  1. Het fysieke toetsenbord werkt altijd mee. Wie liever tikt dan tapt is
 *     sneller, en aan een kassa met een numeriek blok is dat de meeste mensen.
 *
 *  2. Bedragen worden van rechts naar links ingevoerd, zoals op elke
 *     pinautomaat: 1250 wordt 12,50. Niemand toetst een komma in.
 * ------------------------------------------------------------------ */

interface Props {
  waarde: string
  onWaarde: (v: string) => void
  /** Meer dan dit aantal cijfers kan er niet in. */
  maxLengte?: number
  onKlaar?: () => void
  /** Tekst of icoon op de OK-toets. */
  klaarTekst?: ReactNode
  klaarUit?: boolean
  /** Toetsenbord van het apparaat ook laten meedoen. */
  toetsenbord?: boolean
}

export default function Toetsenblok({
  waarde, onWaarde, maxLengte = 12, onKlaar,
  klaarTekst = 'OK', klaarUit, toetsenbord = true,
}: Props) {
  function cijfer(c: string) {
    if (waarde.length >= maxLengte) return
    // Voorloopnullen hebben geen betekenis en maken het lezen lastiger.
    onWaarde((waarde + c).replace(/^0+(?=\d)/, ''))
  }

  function wis() {
    onWaarde(waarde.slice(0, -1))
  }

  useEffect(() => {
    if (!toetsenbord) return

    function opToets(e: KeyboardEvent) {
      // In een invoerveld doet het toetsenbord zijn eigen werk.
      const doel = e.target as HTMLElement | null
      if (doel && ['INPUT', 'TEXTAREA', 'SELECT'].includes(doel.tagName)) return

      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); cijfer(e.key); return }
      if (e.key === 'Backspace') { e.preventDefault(); wis(); return }
      if (e.key === 'Enter' && onKlaar && !klaarUit) { e.preventDefault(); onKlaar() }
    }

    window.addEventListener('keydown', opToets)
    return () => window.removeEventListener('keydown', opToets)
  })

  return (
    <div className="toetsen">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((c) => (
        <button key={c} type="button" className="toets" onClick={() => cijfer(c)}>{c}</button>
      ))}
      <button type="button" className="toets wis" onClick={wis} aria-label="Wissen">
        <Delete size={20} />
      </button>
      <button type="button" className="toets" onClick={() => cijfer('0')}>0</button>
      {onKlaar ? (
        <button type="button" className="toets klaar" onClick={onKlaar} disabled={klaarUit}>
          {klaarTekst}
        </button>
      ) : (
        <button type="button" className="toets" onClick={() => cijfer('00')}>00</button>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  Hulpmiddelen voor bedragen
 * ------------------------------------------------------------------ */

/** Van ingetoetste cijfers naar een bedrag: '1250' -> 12.5 */
export const naarBedrag = (cijfers: string): number =>
  cijfers ? Number(cijfers) / 100 : 0

/** En terug, om te laten zien wat er staat: 12.5 -> '12,50' */
export const alsBedrag = (cijfers: string): string =>
  naarBedrag(cijfers).toFixed(2).replace('.', ',')

/** Vakjes voor een code, zodat je ziet hoeveel cijfers er al in zitten. */
export function CodeVakjes({ waarde, lengte }: { waarde: string; lengte: number }) {
  return (
    <div className="codevakjes">
      {Array.from({ length: lengte }).map((_, i) => (
        <div key={i} className={`codevakje ${i < waarde.length ? 'vol' : ''}`}>
          {i < waarde.length ? '•' : ''}
        </div>
      ))}
    </div>
  )
}
