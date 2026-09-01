import { Minus, RotateCcw } from 'lucide-react'
import { money } from '../lib/format'
import {
  type Coupure, type MuntCode, type Munten, MUNTSOORTEN, muntenAantal,
  muntenBedrag,
} from '../lib/munten'

/* ------------------------------------------------------------------ *
 *  Briefjes en munten aantikken
 *
 *  Dit is het onderdeel waar de kluis om draait: je tikt aan wat je in je hand
 *  hebt, en de kassa telt het bedrag uit. Er wordt nergens een bedrag
 *  ingetypt.
 *
 *  Waarom dat het verschil maakt: een bedrag intikken kan fout zonder dat
 *  iemand het merkt. Een 3 en een 4 liggen op een cijferblok naast elkaar, en
 *  340 en 240 zien er allebei even geloofwaardig uit. Briefjes aantikken kan
 *  ook fout, maar dan zie je het: er staat dan "2x €100" terwijl je er drie in
 *  je hand hebt.
 *
 *  Twee keuzes in de vormgeving die daaruit volgen:
 *
 *  1. Het aantal staat groot op het vakje, niet in een invoerveld ernaast. Wat
 *     je hebt aangetikt hoort van een meter afstand te lezen zijn, want je
 *     staat met geld in je handen en niet met je neus op het scherm.
 *
 *  2. Is er een voorraad meegegeven, dan gaat het vakje op slot zodra je alles
 *     hebt aangetikt wat er ligt. Zo kan er niet meer uit de kluis dan erin
 *     zit -- en hoeft niemand daar zelf op te letten.
 * ------------------------------------------------------------------ */

interface Props {
  waarde: Munten
  onWaarde: (m: Munten) => void
  /**
   * Wat er beschikbaar is. Meegeven bij alles wat ergens uit gáát; weglaten
   * bij tellen en bij geld dat van buiten komt.
   */
  voorraad?: Munten
  /** Wat er onder het bord staat. Standaard het totaal. */
  voet?: 'totaal' | 'geen'
  /** Alleen briefjes of alleen munten, als het scherm smal is. */
  alleen?: 'biljetten' | 'munten'
}

export default function Muntenbord({
  waarde, onWaarde, voorraad, voet = 'totaal', alleen,
}: Props) {
  const soorten = MUNTSOORTEN.filter((c) =>
    !alleen || (alleen === 'biljetten' ? c.soort === 'biljet' : c.soort === 'munt'))

  const biljetten = soorten.filter((c) => c.soort === 'biljet')
  const munten = soorten.filter((c) => c.soort === 'munt')

  function zet(code: MuntCode, aantal: number) {
    const uit = { ...waarde }
    if (aantal <= 0) delete uit[code]
    else uit[code] = aantal
    onWaarde(uit)
  }

  const totaal = muntenBedrag(waarde)
  const stuks = muntenAantal(waarde)

  return (
    <div className="muntbord">
      {biljetten.length > 0 && (
        <>
          <div className="muntkop">Briefjes</div>
          <div className="muntrij">
            {biljetten.map((c) => (
              <Vak key={c.code} coupure={c} waarde={waarde} voorraad={voorraad} onZet={zet} />
            ))}
          </div>
        </>
      )}

      {munten.length > 0 && (
        <>
          <div className="muntkop">Munten</div>
          <div className="muntrij">
            {munten.map((c) => (
              <Vak key={c.code} coupure={c} waarde={waarde} voorraad={voorraad} onZet={zet} />
            ))}
          </div>
        </>
      )}

      {voet === 'totaal' && (
        <div className="muntvoet">
          <div>
            <div className="muntvoet-bedrag cijfers">{money(totaal)}</div>
            <div className="muntvoet-sub">
              {stuks === 0
                ? 'nog niets aangetikt'
                : `${stuks} ${stuks === 1 ? 'briefje of munt' : 'briefjes en munten'}`}
            </div>
          </div>
          <button
            type="button"
            className="muntwis"
            onClick={() => onWaarde({})}
            disabled={stuks === 0}
          >
            <RotateCcw size={15} /> Opnieuw
          </button>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function Vak({
  coupure, waarde, voorraad, onZet,
}: {
  coupure: Coupure
  waarde: Munten
  voorraad?: Munten
  onZet: (code: MuntCode, aantal: number) => void
}) {
  const aantal = waarde[coupure.code] ?? 0
  const beschikbaar = voorraad ? (voorraad[coupure.code] ?? 0) : null
  const vol = beschikbaar !== null && aantal >= beschikbaar
  const leeg = beschikbaar === 0

  return (
    /*
     * De klasse heet muntvak-zonder en niet 'leeg'. Dat scheelt een middag:
     * .leeg bestaat al in de app -- het is de doos met "er is hier niets" --
     * en die heeft padding van veertig pixels. Elk vakje waar niets van in de
     * kluis lag werd daardoor twee keer zo hoog, en dan staat het hele bord
     * scheef zonder dat er iets fout is aan het bord.
     */
    <div className={`muntvak ${aantal > 0 ? 'muntvak-aan' : ''} ${leeg ? 'muntvak-zonder' : ''}`}>
      <button
        type="button"
        className="muntvak-op"
        onClick={() => onZet(coupure.code, aantal + 1)}
        disabled={vol}
        title={leeg
          ? `Er ligt geen ${coupure.label}`
          : vol
            ? `Meer dan ${beschikbaar} is er niet`
            : `Eén ${coupure.label} erbij`}
      >
        <span className="muntvak-label">{coupure.label}</span>
        <span className="muntvak-aantal cijfers">{aantal > 0 ? aantal : ''}</span>
        {/*
          Wat er ligt, klein onder het knopje. Niet alleen informatief: dit is
          wat verklaart waarom een vakje niet meer meegeeft, en zonder die
          uitleg lijkt een uitgeschakeld knopje een storing.
        */}
        {beschikbaar !== null && (
          <span className="muntvak-voorraad">
            {beschikbaar === 0 ? 'geen' : `${beschikbaar - aantal} over`}
          </span>
        )}
      </button>

      {/*
        De min zit apart en klein. Erbij doen gebeurt de hele tijd, eraf halen
        af en toe -- en een even groot minknopje ernaast is precies hoe je per
        ongeluk aftrekt terwijl je wilde optellen.
      */}
      <button
        type="button"
        className="muntvak-af"
        onClick={() => onZet(coupure.code, aantal - 1)}
        disabled={aantal === 0}
        aria-label={`Eén ${coupure.label} eraf`}
      >
        <Minus size={13} />
      </button>
    </div>
  )
}
