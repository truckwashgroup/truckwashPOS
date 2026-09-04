import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Printer, RotateCcw, Search } from 'lucide-react'
import BonWeergave from '../components/BonWeergave'
import { Dialoog, Fout, Knop, Leeg, Pil, Regel, Uitleg, Veld } from '../components/ui'
import { bonGegevens, type BonGegevens } from '../lib/bon'
import { dateTime, money } from '../lib/format'
import { printBon } from '../lib/hardware/printer'
import { bonAfgedrukt, bonMetAlles, crediteren, zoekBonnen } from '../lib/kassa'
import { openSessie } from '../lib/kas'
import { can } from '../lib/permissions'
import { useAuth } from '../store/useAuth'
import { toast } from '../store/useToasts'
import type { PosRegister, PosSale, PosSaleLine } from '../lib/types'

/* ------------------------------------------------------------------ *
 *  Bonnen terugzoeken
 *
 *  Waarvoor dit nodig is, in volgorde van hoe vaak het gebeurt: een chauffeur
 *  die zijn bon kwijt is, een klant die vraagt wat er is afgerekend, en een
 *  fout die teruggedraaid moet worden.
 *
 *  Dat laatste kan alleen met een creditbon. Een afgerekende bon wijzigen of
 *  weggooien lukt niet -- niet omdat de app het verbiedt, maar omdat de
 *  database het weigert. Zo blijft een administratie waar iemand op kan
 *  bouwen.
 * ------------------------------------------------------------------ */

export default function Bonnen({ register }: { register: PosRegister }) {
  const { operator } = useAuth()
  const [zoek, setZoek] = useState('')
  const [open, setOpen] = useState<BonGegevens | null>(null)
  const [crediteerBon, setCrediteerBon] = useState<PosSale | null>(null)

  const bonnen = useLiveQuery(() => zoekBonnen(zoek), [zoek], [] as PosSale[])

  async function bekijk(sale: PosSale) {
    const gegevens = await bonGegevens(sale.id, true)
    if (gegevens) setOpen(gegevens)
  }

  return (
    <div className="paneel">
      <div className="kaart" style={{ maxWidth: 900, margin: '0 auto' }}>
        <h3>Bonnen</h3>
        <p className="uitleg">
          Zoek op bonnummer, kenteken, klant of bedrag. Zonder zoekterm staan de
          laatste bonnen bovenaan.
        </p>

        <div style={{ position: 'relative', marginBottom: 14 }}>
          <Search
            size={16}
            style={{ position: 'absolute', left: 12, top: 16, color: 'var(--text-3)' }}
          />
          <input
            value={zoek}
            onChange={(e) => setZoek(e.target.value)}
            placeholder="Bonnummer, kenteken, klant of bedrag"
            style={{
              width: '100%', minHeight: 48, padding: '10px 12px 10px 36px',
              borderRadius: 11, border: '1px solid var(--line)',
              background: 'var(--bg-2)', color: 'var(--text)', userSelect: 'text',
            }}
          />
        </div>

        {bonnen.length === 0 ? (
          <Leeg tekst="Geen bon gevonden." />
        ) : (
          <div className="lijst">
            {bonnen.map((b) => (
              <button key={b.id} type="button" className="lijstrij" onClick={() => void bekijk(b)}>
                <div className="rek">
                  <div className="titel cijfers">{b.receiptNo}</div>
                  <div className="onder">
                    {dateTime(b.closedAt ?? b.openedAt)} · {b.operatorName}
                    {b.customerName ? ` · ${b.customerName}` : ''}
                    {b.plate ? ` · ${b.plate}` : ''}
                  </div>
                </div>
                {b.creditOf && <Pil soort="warn">credit</Pil>}
                {b.status === 'gecrediteerd' && <Pil soort="fout">gecrediteerd</Pil>}
                <span className="bedrag" style={{ fontWeight: 700 }}>
                  {money(b.totalIncl + b.rounding)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {open && (
        <Dialoog
          titel={`Bon ${open.bon.receiptNo}`}
          onSluiten={() => setOpen(null)}
          wijd
          voet={
            <>
              <Knop
                onClick={async () => {
                  const print = await printBon({ ...open, kopie: true }, register.printer)
                  if (print.ok) {
                    await bonAfgedrukt(open.bon.id)
                    toast.ok('Bon afgedrukt.')
                  } else {
                    toast.warn(print.reden ?? 'Afdrukken lukte niet')
                  }
                }}
              >
                <Printer size={17} /> Afdrukken
              </Knop>
              {open.bon.status === 'afgerekend' && can(operator, 'pos.refund') && (
                <Knop
                  soort="gevaar"
                  onClick={() => { setCrediteerBon(open.bon); setOpen(null) }}
                >
                  <RotateCcw size={17} /> Crediteren
                </Knop>
              )}
              <Knop soort="hoofd" onClick={() => setOpen(null)}>Sluiten</Knop>
            </>
          }
        >
          <div style={{ display: 'grid', gap: 18, gridTemplateColumns: '1fr auto' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Regel label="Totaal" waarde={money(open.bon.totalIncl + open.bon.rounding)} groot />
              <Regel label="Waarvan btw" waarde={money(open.bon.vatTotal)} />
              <Regel label="Kassa" waarde={open.bon.registerCode} />
              <Regel label="Medewerker" waarde={open.bon.operatorName} />
              {open.bon.status === 'gecrediteerd' && (
                <Uitleg>
                  Deze bon is gecrediteerd. Er is een creditbon die ernaar
                  verwijst; samen laten ze zien wat er gebeurd is.
                </Uitleg>
              )}
              {!can(operator, 'pos.refund') && open.bon.status === 'afgerekend' && (
                <Uitleg>
                  Crediteren vraagt het recht "Bon crediteren". Vraag een
                  leidinggevende.
                </Uitleg>
              )}
            </div>
            <BonWeergave gegevens={open} breedte={register.printer.breedte ?? 42} />
          </div>
        </Dialoog>
      )}

      {crediteerBon && (
        <Crediteren
          bon={crediteerBon}
          register={register}
          onSluiten={() => setCrediteerBon(null)}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  Crediteren
 * ------------------------------------------------------------------ */

function Crediteren({
  bon, register, onSluiten,
}: { bon: PosSale; register: PosRegister; onSluiten: () => void }) {
  const { operator } = useAuth()
  const [reden, setReden] = useState('')
  const [gekozen, setGekozen] = useState<Set<string>>(new Set())
  const [fout, setFout] = useState<string | null>(null)
  const [bezig, setBezig] = useState(false)

  const volledig = useLiveQuery(async () => bonMetAlles(bon.id), [bon.id], null)
  const regels: PosSaleLine[] = volledig?.regels ?? []

  const alles = gekozen.size === 0
  const terug = alles
    ? bon.totalIncl
    : regels.filter((r) => gekozen.has(r.id)).reduce((s, r) => s + r.totalIncl, 0)

  function wissel(id: string) {
    const nieuw = new Set(gekozen)
    nieuw.has(id) ? nieuw.delete(id) : nieuw.add(id)
    setGekozen(nieuw)
  }

  async function doeHet() {
    if (!operator) return
    if (!reden.trim()) {
      setFout('Zet erbij waarom deze bon wordt teruggedraaid.')
      return
    }

    setBezig(true)
    try {
      const sessie = await openSessie(register.id)
      const uitslag = await crediteren({
        saleId: bon.id,
        register,
        door: operator,
        reden: reden.trim(),
        regelIds: alles ? undefined : [...gekozen],
        cashSessionId: sessie?.id,
      })

      const gegevens = await bonGegevens(uitslag.bon.id)
      if (gegevens) {
        const print = await printBon(gegevens, register.printer, {
          ladeOpen: uitslag.bon.method === 'contant',
        })
        if (print.ok) await bonAfgedrukt(uitslag.bon.id)
      }

      toast.ok(`Creditbon ${uitslag.bon.receiptNo} gemaakt.`)
      onSluiten()
    } catch (e) {
      setFout(e instanceof Error ? e.message : 'Crediteren lukte niet')
    } finally {
      setBezig(false)
    }
  }

  return (
    <Dialoog
      titel={`Bon ${bon.receiptNo} crediteren`}
      onSluiten={onSluiten}
      voet={
        <>
          <Knop soort="stil" onClick={onSluiten}>Annuleren</Knop>
          <Knop soort="gevaar" disabled={bezig} onClick={() => void doeHet()}>
            {bezig ? 'Bezig…' : `${money(terug)} terug`}
          </Knop>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Uitleg>
          De oorspronkelijke bon blijft staan. Er komt een creditbon bij met
          negatieve bedragen die ernaar verwijst — zo blijft te zien wat er
          gebeurd is, en niet alleen wat er overbleef. Voorraad en strippen gaan
          terug.
        </Uitleg>

        <Veld label="Welke regels?" hint="Niets aanvinken betekent: de hele bon.">
          <div className="lijst">
            {regels.map((r) => (
              <button
                key={r.id}
                type="button"
                className="lijstrij"
                onClick={() => wissel(r.id)}
                style={{
                  borderColor: gekozen.has(r.id) ? 'var(--line-danger)' : undefined,
                  background: gekozen.has(r.id) ? 'var(--tint-danger)' : undefined,
                }}
              >
                <div className="rek">
                  <div className="titel">{r.name}</div>
                  <div className="onder">{r.qty} × {money(r.priceIncl)}</div>
                </div>
                <span className="bedrag">{money(r.totalIncl)}</span>
              </button>
            ))}
          </div>
        </Veld>

        <Veld label="Waarom" hint="Bijvoorbeeld: verkeerd artikel aangeslagen, of wasbeurt niet uitgevoerd.">
          <input value={reden} onChange={(e) => setReden(e.target.value)} autoFocus />
        </Veld>

        {bon.method === 'op-rekening' && (
          <Uitleg>
            Deze bon stond op rekening. De creditbon gaat ook op rekening en komt
            zo bij de klant op de factuur in mindering.
          </Uitleg>
        )}

        {fout && <Fout>{fout}</Fout>}
      </div>
    </Dialoog>
  )
}
