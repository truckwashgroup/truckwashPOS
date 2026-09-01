import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  ArrowDownToLine, ArrowUpFromLine, Banknote, Landmark, Lock, Receipt,
  ScanLine, Wallet,
} from 'lucide-react'
import Muntenbord from '../components/Muntenbord'
import { Dialoog, Fout, Knop, Leeg, Regel, Uitleg, Veld, Waarschuwing } from '../components/ui'
import { dateTime, money } from '../lib/format'
import { kasStand, openSessie } from '../lib/kas'
import {
  afstortenNaarKluis, kluisBoeken, kluisStand, kluisTellen, kluisVanLocatie,
  telHerinnering, wisselgeldUitKluis, type KluisStand,
} from '../lib/kluis'
import { type Munten, muntenBedrag, muntenLijst, muntenTekst } from '../lib/munten'
import { can } from '../lib/permissions'
import { useAuth } from '../store/useAuth'
import { toast } from '../store/useToasts'
import { KLUIS_LABELS, type KluisSoort, type PosRegister } from '../lib/types'

/* ------------------------------------------------------------------ *
 *  De kluis
 *
 *  Eén scherm met twee kanten, want dat is hoe het geld loopt: er staat een
 *  kluis en er staat een lade, en de hele dag gaat er geld tussen die twee
 *  heen en weer. Wie afstort wil weten wat er in de lade zat; wie wisselgeld
 *  haalt wil weten wat er in de kluis ligt.
 *
 *  Alles gaat via aantikken. Er staat in dit scherm geen enkel veld waarin je
 *  een bedrag intikt -- zie Muntenbord voor waarom dat het punt is en niet een
 *  aardigheidje.
 *
 *  Wie hier binnen mag, mag het met het recht "Kluis" (pos.safe). Dat heeft
 *  het management standaard; verder deelt het management het uit in het
 *  dashboard. Dat is bewust strenger dan de lade: de lade telt iemand die er
 *  die dag achter staat, de kluis is van het bedrijf.
 * ------------------------------------------------------------------ */

type Handeling = KluisSoort | null

export default function Kluis({ register }: { register: PosRegister }) {
  const { operator, raakAan } = useAuth()
  const [handeling, setHandeling] = useState<Handeling>(null)

  const mag = can(operator, 'pos.safe')

  const kluis = useLiveQuery(
    () => kluisVanLocatie(register.locationId), [register.locationId], undefined)

  const stand = useLiveQuery(
    async () => (kluis ? kluisStand(kluis.id) : null), [kluis?.id], undefined)

  /* De lade ernaast: wat er nu in de kassa hoort te liggen. */
  const lade = useLiveQuery(async () => {
    const sessie = await openSessie(register.id)
    return sessie ? kasStand(sessie.id) : null
  }, [register.id], undefined)

  useEffect(() => { if (handeling) raakAan() }, [handeling])

  if (!mag) {
    return (
      <div className="paneel">
        <div className="kaart" style={{ maxWidth: 560 }}>
          <h3><Lock size={17} style={{ verticalAlign: -3, marginRight: 8 }} /> De kluis</h3>
          <Uitleg>
            Hiervoor is het recht <strong>Kluis</strong> nodig. Dat heeft het
            management, en het management kan het in het dashboard aan iemand
            anders toekennen onder Personeel → Rechten.
            <div style={{ marginTop: 10 }}>
              Voor de lade van deze kassa hoef je hier niet te zijn: tellen,
              afstorten en de dag afsluiten staan onder <strong>Kas</strong>.
            </div>
          </Uitleg>
        </div>
      </div>
    )
  }

  if (kluis === undefined || stand === undefined) {
    return <div className="paneel"><Leeg tekst="Even kijken…" /></div>
  }

  if (!kluis) {
    return (
      <div className="paneel">
        <div className="kaart" style={{ maxWidth: 620 }}>
          <h3>Nog geen kluis</h3>
          <p className="uitleg">
            Voor deze vestiging staat er geen kluis in de database. Kluizen
            worden niet op de kassa aangemaakt maar in het dashboard — anders
            maakt een kassa met een verkeerd ingestelde vestiging een tweede
            kluis aan, en verdwijnt het geld in een administratie waar niemand
            naar kijkt.
          </p>
          <Uitleg>
            Heeft deze kassa wel een vestiging? Dat is te zien onder Beheer. Is
            de vestiging pas net aangemaakt, dan komt de kluis mee met de
            volgende synchronisatie.
          </Uitleg>
        </div>
      </div>
    )
  }

  const herinnering = telHerinnering(stand)

  return (
    <div className="paneel">
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))' }}>

        {/* ---------------- de kluis ---------------- */}

        <div className="kaart">
          <h3>
            <Lock size={16} style={{ verticalAlign: -3, marginRight: 8 }} />
            {kluis.name}
          </h3>

          <div className="kluisbedrag cijfers">{money(stand?.bedrag ?? 0)}</div>
          <div className="kluissub">
            {stand?.laatsteTelling
              ? `Geteld op ${dateTime(stand.laatsteTelling.at)} door ${
                  stand.laatsteTelling.userName}, en ${stand.sindsTelling} ` +
                `${stand.sindsTelling === 1 ? 'boeking' : 'boekingen'} daarna`
              : 'Nog nooit geteld'}
          </div>

          {herinnering && (
            <div style={{ marginTop: 12 }}><Waarschuwing>{herinnering}</Waarschuwing></div>
          )}

          <Samenstelling munten={stand?.munten ?? {}} />
        </div>

        {/* ---------------- de lade ---------------- */}

        <div className="kaart">
          <h3>
            <Wallet size={16} style={{ verticalAlign: -3, marginRight: 8 }} />
            In de kassa
          </h3>

          {lade === undefined ? (
            <Leeg tekst="Even kijken…" />
          ) : !lade ? (
            <>
              {/*
                Geen bedrag maar een woord. Hier stond een streepje op de plek
                van het bedrag, en dat las als een streep door het scherm --
                alsof er iets kapot was in plaats van dicht.
              */}
              <div className="kluisbedrag" style={{ color: 'var(--text-3)', fontSize: 26 }}>
                Lade dicht
              </div>
              <div className="kluissub">Er staat geen kassadag open op {register.code}</div>
              <div style={{ marginTop: 12 }}>
                <Uitleg>
                  Zolang de lade dicht is, kan er niets van of naar de kassa.
                  Open de kassadag onder <strong>Kas</strong>; dan weet de kassa
                  waar een afstorting vanaf moet.
                </Uitleg>
              </div>
            </>
          ) : (
            <>
              <div className="kluisbedrag cijfers">{money(lade.verwachtContant)}</div>
              <div className="kluissub">
                Wat er in de lade van {register.code} hoort te liggen
              </div>

              <div style={{ marginTop: 14 }}>
                <Regel label="Wisselgeld bij het openen" waarde={money(lade.sessie.startFloat)} />
                <Regel label="Contant afgerekend" waarde={money(lade.contant)} />
                {lade.inleg !== 0 && (
                  <Regel label="Erbij gelegd" waarde={money(lade.inleg)} />
                )}
                {lade.afstorting !== 0 && (
                  <Regel label="Afgestort" waarde={money(lade.afstorting)} />
                )}
                <Regel label="Hoort in de lade" waarde={money(lade.verwachtContant)} groot />
              </div>

              {/*
                Dit is een bedrag en geen samenstelling, en dat is geen
                nalatigheid. De lade wordt geteld bij de dagafsluiting; wat er
                tussendoor precies aan briefjes in ligt, weet de kassa niet --
                daar komt de hele dag wisselgeld uit. Zou hier een
                samenstelling staan, dan stond er een getal dat niets betekent.
              */}
              <Uitleg>
                Van de lade weet de kassa het bedrag, niet de briefjes: daar
                gaat de hele dag wisselgeld uit. Wat er precies in ligt, blijkt
                bij het tellen onder Kas.
              </Uitleg>
            </>
          )}
        </div>
      </div>

      {/* ---------------- wat je kunt doen ---------------- */}

      <div className="kaart" style={{ marginTop: 16 }}>
        <h3>Geld verplaatsen</h3>
        <p className="uitleg">
          Elke handeling tikt de briefjes en munten aan die je in je handen
          hebt. Er is nergens een bedrag om in te tikken — het bedrag volgt
          uit wat je aantikt, en dat is precies de bedoeling.
        </p>

        <div className="kluisknoppen">
          <HandelingKnop
            icoon={<ArrowDownToLine size={19} />}
            titel="Afstorten uit de kassa"
            uitleg="Uit de lade naar de kluis"
            onClick={() => setHandeling('afstorting')}
          />
          <HandelingKnop
            icoon={<ArrowUpFromLine size={19} />}
            titel="Wisselgeld halen"
            uitleg="Uit de kluis naar de lade"
            onClick={() => setHandeling('wisselgeld')}
          />
          <HandelingKnop
            icoon={<Landmark size={19} />}
            titel="Naar de bank"
            uitleg="Uit de kluis, meegegeven of gestort"
            onClick={() => setHandeling('naar-bank')}
          />
          <HandelingKnop
            icoon={<Banknote size={19} />}
            titel="Van de bank"
            uitleg="Wisselgeld opgehaald, in de kluis"
            onClick={() => setHandeling('van-bank')}
          />
          <HandelingKnop
            icoon={<Receipt size={19} />}
            titel="Contante uitgave"
            uitleg="Uit de kluis, met een bonnetje"
            onClick={() => setHandeling('uitgave')}
          />
          <HandelingKnop
            icoon={<ScanLine size={19} />}
            titel="Kluis tellen"
            uitleg="Vaststellen wat er ligt"
            onClick={() => setHandeling('telling')}
          />
        </div>
      </div>

      {/* ---------------- de historie ---------------- */}

      <Historie stand={stand} />

      {handeling === 'telling' && stand && (
        <Tellen kluis={stand.kluis} onKlaar={() => setHandeling(null)} />
      )}

      {handeling && handeling !== 'telling' && stand && (
        <Verplaatsen
          soort={handeling}
          stand={stand}
          register={register}
          onKlaar={() => setHandeling(null)}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function HandelingKnop({
  icoon, titel, uitleg, onClick,
}: { icoon: React.ReactNode; titel: string; uitleg: string; onClick: () => void }) {
  return (
    <button type="button" className="kluisknop" onClick={onClick}>
      <span className="kluisknop-icoon">{icoon}</span>
      <span className="rek">
        <span className="kluisknop-titel">{titel}</span>
        <span className="kluisknop-uitleg">{uitleg}</span>
      </span>
    </button>
  )
}

/** Wat er in de kluis ligt, per briefje en munt. */
function Samenstelling({ munten }: { munten: Munten }) {
  const lijst = muntenLijst(munten)

  if (!lijst.length) {
    return (
      <div style={{ marginTop: 14 }}>
        <Leeg tekst="Volgens de administratie ligt er niets in de kluis." />
      </div>
    )
  }

  /*
   * Een negatief aantal hoort niet te kunnen: de app houdt tegen dat er meer
   * uit gaat dan erin zit. Kan het toch, dan is er offline op twee kassa's
   * tegelijk iets uit gehaald -- en dan moet dat hier hardop staan in plaats
   * van als een min tussen de rest.
   */
  const negatief = lijst.filter((r) => r.aantal < 0)

  return (
    <div style={{ marginTop: 14 }}>
      <table className="tabel">
        <tbody>
          {lijst.map((r) => (
            <tr key={r.coupure.code}>
              <td style={{ width: 78 }}>{r.coupure.label}</td>
              <td className="cijfers" style={{ width: 54, textAlign: 'right', fontWeight: 700 }}>
                {r.aantal}x
              </td>
              <td className="rechts">{money(r.bedrag)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {negatief.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Fout>
            Er staat een negatief aantal in de administratie
            ({muntenTekst(Object.fromEntries(negatief.map((r) => [r.coupure.code, r.aantal])))}).
            Dat kan alleen als er op twee plekken tegelijk iets uit de kluis is
            gehaald terwijl er geen verbinding was. Tel de kluis: dan klopt het
            weer, en blijft het verschil zichtbaar.
          </Fout>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  Geld verplaatsen
 * ------------------------------------------------------------------ */

function Verplaatsen({
  soort, stand, register, onKlaar,
}: {
  soort: Exclude<KluisSoort, 'telling'>
  stand: KluisStand
  register: PosRegister
  onKlaar: () => void
}) {
  const { operator } = useAuth()
  const [munten, setMunten] = useState<Munten>({})
  const [reden, setReden] = useState('')
  const [fout, setFout] = useState<string | null>(null)
  const [bezig, setBezig] = useState(false)

  const uitDeKluis = soort === 'wisselgeld' || soort === 'naar-bank' || soort === 'uitgave'
  const bedrag = muntenBedrag(munten)

  /*
   * Bij een afstorting komt het geld uit de lade. Daar weet de kassa geen
   * samenstelling van (zie de kaart hierboven), dus is er niets om het bord
   * mee te begrenzen -- alleen het bedrag, en dat controleren we bij het
   * boeken.
   */
  const voorraad = uitDeKluis ? stand.munten : undefined

  async function boek() {
    if (!operator) return
    setFout(null)
    setBezig(true)
    try {
      if (soort === 'afstorting') {
        const { bedrag: b } = await afstortenNaarKluis({
          kluis: stand.kluis, register, munten, door: operator, reden: reden.trim() || undefined,
        })
        toast.ok(`${money(b)} afgestort in de kluis.`)
      } else if (soort === 'wisselgeld') {
        const { bedrag: b } = await wisselgeldUitKluis({
          kluis: stand.kluis, register, munten, door: operator, reden: reden.trim() || undefined,
        })
        toast.ok(`${money(b)} wisselgeld naar ${register.code}.`)
      } else {
        await kluisBoeken({
          kluis: stand.kluis, soort, munten, door: operator, reden: reden.trim() || undefined,
        })
        toast.ok(`${KLUIS_LABELS[soort]}: ${money(bedrag)} geboekt.`)
      }
      onKlaar()
    } catch (e) {
      setFout(e instanceof Error ? e.message : 'Boeken lukte niet.')
    } finally {
      setBezig(false)
    }
  }

  const redenHint: Record<string, string> = {
    afstorting: 'Bijvoorbeeld: einde ochtenddienst.',
    wisselgeld: 'Bijvoorbeeld: munten voor de zaterdag.',
    'naar-bank': 'Bijvoorbeeld: meegegeven aan de geldophaaldienst, of zelf gestort.',
    'van-bank': 'Bijvoorbeeld: rollen munten opgehaald.',
    uitgave: 'Waar het aan besteed is. Bewaar het bonnetje.',
  }

  return (
    <Dialoog
      titel={KLUIS_LABELS[soort]}
      onSluiten={onKlaar}
      wijd
      voet={
        <>
          <Knop soort="stil" onClick={onKlaar}>Annuleren</Knop>
          <Knop
            soort="hoofd"
            onClick={() => void boek()}
            disabled={bezig || bedrag <= 0 || (soort === 'uitgave' && !reden.trim())}
          >
            {bezig ? 'Bezig…' : `${money(bedrag)} boeken`}
          </Knop>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 18, gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1fr)' }}>
        <div>
          <p className="uitleg" style={{ marginTop: 0 }}>
            {soort === 'afstorting' &&
              `Tik aan wat je uit de lade van ${register.code} haalt. Het gaat er ` +
              'daar af en hier bij, in één keer.'}
            {soort === 'wisselgeld' &&
              `Tik aan wat je meeneemt naar ${register.code}. Meer dan er in de ` +
              'kluis ligt kan niet — die vakjes geven niet mee.'}
            {soort === 'naar-bank' &&
              'Tik aan wat de kluis uit gaat. Wat je meegeeft, hoort te kloppen ' +
              'met wat de bank straks bijschrijft.'}
            {soort === 'van-bank' &&
              'Tik aan wat er in de kluis gaat.'}
            {soort === 'uitgave' &&
              'Tik aan wat er uit de kluis gaat, en schrijf erbij waarvoor. ' +
              'Zonder toelichting is een contante uitgave later niet te plaatsen.'}
          </p>

          <Muntenbord waarde={munten} onWaarde={setMunten} voorraad={voorraad} />
        </div>

        <div>
          <Veld label="Toelichting" hint={redenHint[soort]}>
            <input value={reden} onChange={(e) => setReden(e.target.value)} />
          </Veld>

          <div style={{ marginTop: 16 }}>
            <Regel label="Bedrag" waarde={money(bedrag)} groot />
            <Regel label="Aangetikt" waarde={muntenTekst(munten)} />
          </div>

          {uitDeKluis && (
            <div style={{ marginTop: 16 }}>
              <Regel label="In de kluis nu" waarde={money(stand.bedrag)} />
              <Regel label="Daarna" waarde={money(stand.bedrag - bedrag)} />
            </div>
          )}

          {soort === 'afstorting' && (
            <div style={{ marginTop: 16 }}>
              <Regel label="In de kluis nu" waarde={money(stand.bedrag)} />
              <Regel label="Daarna" waarde={money(stand.bedrag + bedrag)} />
            </div>
          )}

          {fout && <div style={{ marginTop: 14 }}><Fout>{fout}</Fout></div>}
        </div>
      </div>
    </Dialoog>
  )
}

/* ------------------------------------------------------------------ *
 *  Tellen
 * ------------------------------------------------------------------ */

function Tellen({
  kluis, onKlaar,
}: { kluis: KluisStand['kluis']; onKlaar: () => void }) {
  const { operator } = useAuth()
  const [geteld, setGeteld] = useState<Munten>({})
  const [note, setNote] = useState('')
  const [gezien, setGezien] = useState<{ verwacht: number; verschil: number } | null>(null)
  const [fout, setFout] = useState<string | null>(null)

  const bedrag = muntenBedrag(geteld)

  async function vergelijk() {
    const stand = await kluisStand(kluis.id)
    const verwacht = stand?.bedrag ?? 0
    setGezien({ verwacht, verschil: Math.round((bedrag - verwacht) * 100) / 100 })
  }

  async function leggeVast() {
    if (!operator) return
    try {
      const { verschil } = await kluisTellen({
        kluis, geteld, door: operator, note: note.trim() || undefined,
      })
      toast.ok(verschil === 0
        ? 'Kluis geteld en het klopt.'
        : `Kluis geteld met een verschil van ${money(verschil)}.`)
      onKlaar()
    } catch (e) {
      setFout(e instanceof Error ? e.message : 'Vastleggen lukte niet.')
    }
  }

  return (
    <Dialoog
      titel="Kluis tellen"
      onSluiten={onKlaar}
      wijd
      voet={
        <>
          <Knop soort="stil" onClick={onKlaar}>Annuleren</Knop>
          {!gezien ? (
            <Knop soort="hoofd" onClick={() => void vergelijk()} disabled={bedrag <= 0}>
              Vergelijken
            </Knop>
          ) : (
            <Knop soort="hoofd" onClick={() => void leggeVast()}>Telling vastleggen</Knop>
          )}
        </>
      }
    >
      <div style={{ display: 'grid', gap: 18, gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1fr)' }}>
        <div>
          {/*
            Wat er hoort te liggen staat er pas ná het tellen, net als bij de
            lade. Zie je het getal ervoor, dan tel je naar dat getal toe --
            niet omdat iemand oneerlijk is maar omdat een mens zo werkt.
          */}
          <p className="uitleg" style={{ marginTop: 0 }}>
            Tik aan wat er in de kluis ligt. Wat er hoort te liggen zie je pas
            als je op Vergelijken drukt — anders tel je naar een getal toe.
          </p>

          <Muntenbord waarde={geteld} onWaarde={setGeteld} />
        </div>

        <div>
          <Regel label="Geteld" waarde={money(bedrag)} groot />

          {gezien && (
            <div style={{ marginTop: 16 }}>
              <Regel label="Hoorde er te liggen" waarde={money(gezien.verwacht)} />
              <Regel label="Verschil" waarde={money(gezien.verschil)} groot />

              {gezien.verschil === 0 ? (
                <div style={{ marginTop: 12 }}>
                  <Uitleg>Het klopt precies.</Uitleg>
                </div>
              ) : (
                <div style={{ marginTop: 12 }}>
                  <Waarschuwing>
                    {gezien.verschil > 0
                      ? `Er ligt ${money(gezien.verschil)} méér dan de administratie zegt.`
                      : `Er ligt ${money(-gezien.verschil)} minder dan de administratie zegt.`}
                    <div style={{ marginTop: 8 }}>
                      Het verschil wordt vastgelegd en niet weggerekend. Vanaf
                      deze telling is de getelde stand het saldo.
                    </div>
                  </Waarschuwing>
                </div>
              )}
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <Veld
              label="Toelichting"
              hint="Bij een verschil: wat je erover weet. Dat is later het enige aanknopingspunt."
            >
              <input value={note} onChange={(e) => setNote(e.target.value)} />
            </Veld>
          </div>

          {fout && <div style={{ marginTop: 14 }}><Fout>{fout}</Fout></div>}
        </div>
      </div>
    </Dialoog>
  )
}

/* ------------------------------------------------------------------ *
 *  Wat er gebeurd is
 * ------------------------------------------------------------------ */

function Historie({ stand }: { stand: KluisStand | null }) {
  const [alles, setAlles] = useState(false)
  if (!stand) return null

  const lijst = alles ? stand.boekingen : stand.boekingen.slice(0, 12)

  return (
    <div className="kaart" style={{ marginTop: 16 }}>
      <h3>Wat er gebeurd is</h3>
      <p className="uitleg">
        Een kluisboeking staat vast: de database weigert hem te wijzigen of te
        wissen. Een vergissing zet je recht met een tegenboeking of met een
        telling — dan blijft te zien wat er gebeurd is.
      </p>

      {lijst.length === 0 ? (
        <Leeg tekst="Er is nog niets in of uit de kluis geboekt." />
      ) : (
        <table className="tabel">
          <thead>
            <tr>
              <th>Wanneer</th>
              <th>Wat</th>
              <th>Briefjes en munten</th>
              <th>Door</th>
              <th className="rechts">Bedrag</th>
            </tr>
          </thead>
          <tbody>
            {lijst.map((m) => (
              <tr key={m.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{dateTime(m.at)}</td>
                <td>
                  {KLUIS_LABELS[m.soort]}
                  {m.reason && m.reason !== KLUIS_LABELS[m.soort] && (
                    <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{m.reason}</div>
                  )}
                </td>
                <td style={{ fontSize: 12.5 }}>
                  {m.soort === 'telling' ? muntenTekst(m.counted) : muntenTekst(m.coins)}
                </td>
                <td>{m.userName}</td>
                <td className="rechts">
                  {m.soort === 'telling' ? (
                    <span style={{
                      color: (m.difference ?? 0) === 0 ? 'var(--text-3)' : 'var(--text-warn)',
                    }}>
                      {money(muntenBedrag(m.counted))}
                      {(m.difference ?? 0) !== 0 && (
                        <div style={{ fontSize: 12 }}>
                          verschil {money(m.difference ?? 0)}
                        </div>
                      )}
                    </span>
                  ) : (
                    <span style={{ color: m.amount < 0 ? 'var(--text-danger)' : 'var(--text-ok)' }}>
                      {money(m.amount)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {stand.boekingen.length > 12 && (
        <div style={{ marginTop: 12 }}>
          <Knop maat="klein" soort="stil" onClick={() => setAlles(!alles)}>
            {alles ? 'Alleen de laatste twaalf' : `Alle ${stand.boekingen.length} boekingen`}
          </Knop>
        </div>
      )}
    </div>
  )
}
