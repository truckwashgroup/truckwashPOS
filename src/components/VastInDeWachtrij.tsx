import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Knop } from './ui'
import { dateTime } from '../lib/format'
import { useSync } from '../lib/sync'
import { vastVerhaal } from '../lib/wachtrij'

/* ------------------------------------------------------------------ *
 *  Er zit iets vast in de wachtrij
 *
 *  De aanleiding: een inklokking verdween omdat de server hem weigerde op de
 *  rechten, en pushPerStuk las dat als "dit record is stuk" -- acht pogingen en
 *  weg. Dat is in sync.ts rechtgezet: zulke weigeringen gooien niets meer weg.
 *
 *  Maar daarmee was het maar half opgelost. Een regel die voor altijd in de
 *  wachtrij blijft staan is net zo onzichtbaar als een regel die weg is, en bij
 *  uren is onzichtbaar het echte probleem: wie zijn uren kwijtraakt hoort dat
 *  vandaag te merken. Dan weet hij nog hoe lang hij er stond. Aan het eind van
 *  de maand is het zijn woord tegen een lege urenstaat.
 *
 *  Vandaar dat dit een blok in beeld is en geen wegschuivend melding rechtsonder:
 *  het moet blijven staan tot het over is.
 * ------------------------------------------------------------------ */

export default function VastInDeWachtrij() {
  const { vast, syncing, sync } = useSync()

  const verhaal = vastVerhaal(vast)
  if (!verhaal) return null

  return (
    <div className="vastdoos">
      <div className="vastdoos-kop">
        <AlertTriangle size={18} />
        <span>
          {vast.uren > 0
            ? 'Er staan uren die de administratie nog niet heeft'
            : 'Er staat werk dat de administratie nog niet heeft'}
        </span>
      </div>

      <p>{verhaal}</p>

      {vast.reden && (
        <p className="vastdoos-reden">
          Wat de server zegt: {vast.reden}
        </p>
      )}

      <div className="vastdoos-voet">
        <Knop maat="klein" onClick={() => void sync()} disabled={syncing}>
          <RefreshCw size={15} /> {syncing ? 'Bezig…' : 'Nu opnieuw proberen'}
        </Knop>
        {vast.sindsMs && (
          <span>staat vast sinds {dateTime(vast.sindsMs)}</span>
        )}
      </div>
    </div>
  )
}
