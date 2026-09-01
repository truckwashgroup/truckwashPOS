import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  ArrowDownToLine, ArrowUpFromLine, Banknote, Lock, Unlock,
} from 'lucide-react'
import Toetsenblok, { alsBedrag, naarBedrag } from '../components/Toetsenblok'
import { Dialoog, Fout, Knop, Leeg, Pil, Regel, Uitleg, Veld } from '../components/ui'
import { dateTime, money, time } from '../lib/format'
import Muntenbord from '../components/Muntenbord'
import { type Munten, muntenBedrag } from '../lib/munten'
import { openLade } from '../lib/hardware/printer'
import {
  afsluitingen, kasMutatie, kasOpenen, kasSluiten, kasStand, openSessie,
  type KasStand,
} from '../lib/kas'
import { can } from '../lib/permissions'
import { useAuth } from '../store/useAuth'
import { toast } from '../store/useToasts'
import type { CashMoveKind, PosRegister } from '../lib/types'

/* ------------------------------------------------------------------ *
 *  De kassadag
 *
 *  's Ochtends de lade open met wisselgeld, 's avonds tellen en dicht. Wat
 *  ertussen zit is de omzet, per betaalwijze.
 *
 *  Het scherm laat het verschil pas zien nadat er geteld is. Anders tel je
 *  naar het getal toe dat de kassa noemt, en dan telt niemand meer echt.
 * ------------------------------------------------------------------ */

export default function Dagafsluiting({ register }: { register: PosRegister }) {
  const { operator } = useAuth()
  const [openen, setOpenen] = useState(false)
  const [sluiten, setSluiten] = useState(false)
  const [mutatie, setMutatie] = useState<CashMoveKind | null>(null)

  const sessie = useLiveQuery(() => openSessie(register.id), [register.id], null)
  const stand = useLiveQuery(
    async () => (sessie ? kasStand(sessie.id) : null), [sessie?.id, sessie?.updatedAt], null)
  const eerder = useLiveQuery(() => afsluitingen(register.id), [register.id], [])

  const magKas = can(operator, 'pos.cash')

  return (
    <div className="paneel">
      {!sessie ? (
        <div className="kaart" style={{ maxWidth: 620 }}>
          <h3>De kas staat dicht</h3>
          <p className="uitleg">
            Open de kas met het wisselgeld dat erin zit. Vanaf dat moment horen
            de contante bonnen bij deze kassadag, en aan het eind is er iets om
            tegen te tellen.
          </p>
          <Knop soort="hoofd" maat="groot" onClick={() => setOpenen(true)}>
            <Unlock size={20} /> Kas openen
          </Knop>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 380px)' }}>
          <div className="kaart">
            <h3>Kassadag sinds {dateTime(sessie.openedAt)}</h3>
            <p className="uitleg">
              Geopend door {sessie.openedByName} met {money(sessie.startFloat)} wisselgeld.
            </p>

            {stand && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 }}>
                <Regel label={`Bonnen (${stand.aantalBonnen})`} waarde={money(stand.omzetIncl)} />
                {stand.aantalCredit > 0 && (
                  <Regel label={`Waarvan creditbonnen (${stand.aantalCredit})`} waarde="" />
                )}
                <Regel label="Waarvan btw" waarde={money(stand.btw)} />
                <div style={{ height: 10 }} />
                <Regel label="Contant" waarde={money(stand.contant)} />
                <Regel label="Pin" waarde={money(stand.pin)} />
                <Regel label="Op rekening" waarde={money(stand.opRekening)} />
                {stand.metKaart !== 0 && <Regel label="Met kaart" waarde={money(stand.metKaart)} />}
                {stand.afronding !== 0 && (
                  <Regel label="Afronding contant" waarde={money(stand.afronding)} />
                )}
                <div style={{ height: 10 }} />
                <Regel label="Wisselgeld bij de start" waarde={money(sessie.startFloat)} />
                {stand.inleg !== 0 && <Regel label="Ingelegd" waarde={money(stand.inleg)} />}
                {stand.afstorting !== 0 && <Regel label="Afgestort" waarde={money(stand.afstorting)} />}
                <div style={{ borderTop: '1px solid var(--line)', paddingTop: 8, marginTop: 4 }}>
                  <Regel label="Hoort in de lade te liggen" waarde={money(stand.verwachtContant)} groot />
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
              <Knop maat="klein" onClick={() => void openLade(register.printer)}>
                <Banknote size={16} /> Lade openen
              </Knop>
              <Knop maat="klein" onClick={() => setMutatie('inleg')}>
                <ArrowDownToLine size={16} /> Inleggen
              </Knop>
              <Knop maat="klein" onClick={() => setMutatie('afstorting')}>
                <ArrowUpFromLine size={16} /> Afstorten
              </Knop>
              {magKas && (
                <Knop soort="hoofd" onClick={() => setSluiten(true)}>
                  <Lock size={17} /> Kas afsluiten
                </Knop>
              )}
            </div>

            {!magKas && (
              <div style={{ marginTop: 14 }}>
                <Uitleg>
                  Afsluiten vraagt het recht "Lade en dagafsluiting". Vraag een
                  leidinggevende; tellen doen jullie samen.
                </Uitleg>
              </div>
            )}
          </div>

          <div className="kaart">
            <h3>Geld erin en eruit</h3>
            {!stand?.mutaties.length ? (
              <Leeg tekst="Nog niets bij- of afgestort." />
            ) : (
              <div className="lijst">
                {stand.mutaties.map((m) => (
                  <div key={m.id} className="lijstrij" style={{ cursor: 'default' }}>
                    <div className="rek">
                      <div className="titel">{m.reason}</div>
                      <div className="onder">{time(m.at)} · {m.userName}</div>
                    </div>
                    <span className="bedrag" style={{ fontWeight: 700 }}>{money(m.amount)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {eerder.length > 0 && (
        <div className="kaart" style={{ marginTop: 16 }}>
          <h3>Eerdere afsluitingen</h3>
          <table className="tabel">
            <thead>
              <tr>
                <th>Afgesloten</th>
                <th>Door</th>
                <th className="rechts">Bonnen</th>
                <th className="rechts">Contant</th>
                <th className="rechts">Pin</th>
                <th className="rechts">Op rekening</th>
                <th className="rechts">Verschil</th>
              </tr>
            </thead>
            <tbody>
              {eerder.map((s) => (
                <tr key={s.id}>
                  <td>{s.closedAt ? dateTime(s.closedAt) : ''}</td>
                  <td>{s.closedByName}</td>
                  <td className="rechts">{s.salesCount}</td>
                  <td className="rechts">{money(s.cashTotal)}</td>
                  <td className="rechts">{money(s.pinTotal)}</td>
                  <td className="rechts">{money(s.invoiceTotal)}</td>
                  <td className="rechts">
                    {s.difference === 0 || s.difference == null ? (
                      <Pil soort="ok">klopt</Pil>
                    ) : (
                      <Pil soort={Math.abs(s.difference) < 1 ? 'warn' : 'fout'}>
                        {money(s.difference)}
                      </Pil>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openen && operator && (
        <KasOpenen
          register={register}
          onSluiten={() => setOpenen(false)}
        />
      )}

      {mutatie && sessie && operator && (
        <Mutatie
          kind={mutatie}
          sessionId={sessie.id}
          onSluiten={() => setMutatie(null)}
        />
      )}

      {sluiten && stand && operator && (
        <KasSluiten stand={stand} onSluiten={() => setSluiten(false)} />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function KasOpenen({
  register, onSluiten,
}: { register: PosRegister; onSluiten: () => void }) {
  const { operator } = useAuth()
  const [cijfers, setCijfers] = useState('')

  async function open() {
    if (!operator) return
    const { alOpen } = await kasOpenen({
      register, door: operator, startbedrag: naarBedrag(cijfers),
    })
    toast[alOpen ? 'warn' : 'ok'](
      alOpen ? 'Er stond al een kas open; die is gebruikt.' : 'Kas geopend.')
    onSluiten()
  }

  return (
    <Dialoog
      titel="Kas openen"
      onSluiten={onSluiten}
      voet={
        <>
          <Knop soort="stil" onClick={onSluiten}>Annuleren</Knop>
          <Knop soort="hoofd" onClick={() => void open()}>Kas openen</Knop>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 18, gridTemplateColumns: '1fr auto' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Veld label="Wisselgeld in de lade" hint="Wat er nu aan munten en briefjes in zit.">
            <div className="bedrag" style={{ fontSize: 32, fontWeight: 800 }}>
              € {cijfers ? alsBedrag(cijfers) : '0,00'}
            </div>
          </Veld>
          <Uitleg>
            Dit bedrag is geen omzet. Het staat apart, zodat de telling
            's avonds klopt zonder dat iemand het eraf moet rekenen.
          </Uitleg>
        </div>
        <Toetsenblok waarde={cijfers} onWaarde={setCijfers} maxLengte={7} />
      </div>
    </Dialoog>
  )
}

/* ------------------------------------------------------------------ */

function Mutatie({
  kind, sessionId, onSluiten,
}: { kind: CashMoveKind; sessionId: string; onSluiten: () => void }) {
  const { operator } = useAuth()
  const [cijfers, setCijfers] = useState('')
  const [reden, setReden] = useState('')
  const [fout, setFout] = useState<string | null>(null)

  const titel = kind === 'inleg' ? 'Geld inleggen'
    : kind === 'afstorting' ? 'Geld afstorten' : 'Correctie'

  async function bewaar() {
    if (!operator) return
    try {
      await kasMutatie({
        sessionId, kind, bedrag: naarBedrag(cijfers), reden, door: operator,
      })
      toast.ok(`${titel} vastgelegd.`)
      onSluiten()
    } catch (e) {
      setFout(e instanceof Error ? e.message : 'Vastleggen lukte niet')
    }
  }

  return (
    <Dialoog
      titel={titel}
      onSluiten={onSluiten}
      voet={
        <>
          <Knop soort="stil" onClick={onSluiten}>Annuleren</Knop>
          <Knop
            soort="hoofd"
            disabled={!naarBedrag(cijfers) || !reden.trim()}
            onClick={() => void bewaar()}
          >
            Vastleggen
          </Knop>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 18, gridTemplateColumns: '1fr auto' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Veld label="Bedrag">
            <div className="bedrag" style={{ fontSize: 32, fontWeight: 800 }}>
              € {cijfers ? alsBedrag(cijfers) : '0,00'}
            </div>
          </Veld>
          <Veld
            label="Waarom"
            hint={kind === 'afstorting'
              ? 'Bijvoorbeeld: naar de kluis, of meegegeven aan de geldophaaldienst.'
              : 'Bijvoorbeeld: wisselgeld bijgehaald.'}
          >
            <input value={reden} onChange={(e) => setReden(e.target.value)} autoFocus />
          </Veld>
          {fout && <Fout>{fout}</Fout>}
        </div>
        <Toetsenblok waarde={cijfers} onWaarde={setCijfers} maxLengte={7} />
      </div>
    </Dialoog>
  )
}

/* ------------------------------------------------------------------ *
 *  Tellen en afsluiten
 * ------------------------------------------------------------------ */

function KasSluiten({
  stand, onSluiten,
}: { stand: KasStand; onSluiten: () => void }) {
  const { operator } = useAuth()
  const [geteldeMunten, setGeteldeMunten] = useState<Munten>({})
  const [note, setNote] = useState('')
  const [gezien, setGezien] = useState(false)
  const [fout, setFout] = useState<string | null>(null)

  /*
   * Aantikken in plaats van intikken.
   *
   * Hier stond een rij invoervelden waarin je per coupure een aantal typte.
   * Dat werkt, en het heeft hetzelfde gat als bij de kluis: een 3 en een 4
   * liggen naast elkaar op een blok, en beide getallen zien er even
   * geloofwaardig uit. Nu is het hetzelfde bord als bij de kluis -- en dat
   * betekent ook dat er in de hele app één manier is om geld te tellen.
   */
  const geteld = muntenBedrag(geteldeMunten)
  const verschil = Math.round((geteld - stand.verwachtContant) * 100) / 100

  async function sluit() {
    if (!operator) return
    try {
      const { verschil: v } = await kasSluiten({
        sessionId: stand.sessie.id, door: operator, geteld, note: note.trim() || undefined,
      })
      toast.ok(v === 0
        ? 'Kas afgesloten en de telling klopt.'
        : `Kas afgesloten met een verschil van ${money(v)}.`)
      onSluiten()
    } catch (e) {
      setFout(e instanceof Error ? e.message : 'Afsluiten lukte niet')
    }
  }

  return (
    <Dialoog
      titel="Kas tellen en afsluiten"
      onSluiten={onSluiten}
      wijd
      voet={
        <>
          <Knop soort="stil" onClick={onSluiten}>Annuleren</Knop>
          {!gezien ? (
            <Knop soort="hoofd" onClick={() => setGezien(true)} disabled={geteld <= 0}>
              Telling vergelijken
            </Knop>
          ) : (
            <Knop soort="hoofd" onClick={() => void sluit()}>Kas afsluiten</Knop>
          )}
        </>
      }
    >
      <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
        <div>
          <h3 style={{ marginTop: 0 }}>Tel de lade</h3>
          <p className="uitleg">
            Tik aan wat er in de lade ligt. Het verwachte bedrag zie je pas na
            het tellen — anders tel je naar een getal toe.
          </p>

          <Muntenbord waarde={geteldeMunten} onWaarde={setGeteldeMunten} />
        </div>

        <div>
          <h3 style={{ marginTop: 0 }}>Uitkomst</h3>

          {!gezien ? (
            <Uitleg>
              Tel eerst de lade. Daarna laat de kassa zien wat er had moeten
              liggen en wat het verschil is.
            </Uitleg>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Regel label="Geteld" waarde={money(geteld)} />
              <Regel label="Verwacht" waarde={money(stand.verwachtContant)} />
              <div
                className="kaart"
                style={{
                  background: verschil === 0 ? 'var(--tint-ok)'
                    : Math.abs(verschil) < 1 ? 'var(--tint-warn)' : 'var(--tint-danger)',
                  borderColor: verschil === 0 ? 'var(--line-ok)'
                    : Math.abs(verschil) < 1 ? 'var(--line-warn)' : 'var(--line-danger)',
                }}
              >
                <div style={{ fontSize: 13, color: 'var(--text-2)' }}>Verschil</div>
                <div className="bedrag" style={{ fontSize: 36, fontWeight: 800 }}>
                  {money(verschil)}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 6 }}>
                  {verschil === 0 ? 'De telling klopt precies.'
                    : verschil > 0 ? 'Er ligt meer in de lade dan verwacht.'
                      : 'Er ligt minder in de lade dan verwacht.'}
                </div>
              </div>

              <Veld
                label="Toelichting"
                hint="Bij een verschil hoort een verklaring. Die blijft bij de afsluiting staan."
              >
                <input value={note} onChange={(e) => setNote(e.target.value)} />
              </Veld>

              <Uitleg>
                Na het afsluiten staat deze telling vast. Bonnen die nog in de
                wachtrij stonden en later binnenkomen veranderen het opgeslagen
                verschil niet — je kunt dus altijd nazien wat er die avond is
                vastgesteld.
              </Uitleg>

              {fout && <Fout>{fout}</Fout>}
            </div>
          )}
        </div>
      </div>
    </Dialoog>
  )
}
