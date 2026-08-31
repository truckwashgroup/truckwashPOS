import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Banknote, Check, CreditCard, FileText, Printer, Ticket, X,
} from 'lucide-react'
import Toetsenblok, { alsBedrag, naarBedrag } from '../components/Toetsenblok'
import BonWeergave from '../components/BonWeergave'
import { Dialoog, Fout, Knop, Leeg, Pil, Regel, Uitleg, Veld } from '../components/ui'
import { bonGegevens, type BonGegevens } from '../lib/bon'
import { db } from '../lib/db'
import { money } from '../lib/format'
import { afrondenContant, centen, openstaand, wisselgeld } from '../lib/geld'
import { openLade, printBon } from '../lib/hardware/printer'
import { pinnen } from '../lib/hardware/terminal'
import { beoordeel, zoekKaarten, type KaartMetSaldo } from '../lib/kaarten'
import { afrekenen as bonAfrekenen, bonAfgedrukt, type AfgerekendeBon } from '../lib/kassa'
import { kasOpenen, openSessie } from '../lib/kas'
import { useAuth } from '../store/useAuth'
import { useMandje } from '../store/useMandje'
import { toast } from '../store/useToasts'
import type { DeelBetaling, PosRegister, User } from '../lib/types'

/* ------------------------------------------------------------------ *
 *  Afrekenen
 *
 *  Eén dialoog, vier manieren van betalen, en ze mogen door elkaar: een
 *  chauffeur die de was op de rekening zet en de koffie contant afrekent is
 *  geen uitzondering. Wat er nog open staat blijft daarom altijd in beeld.
 *
 *  De regel die alles bepaalt: afrekenen gebeurt lokaal en is klaar voordat
 *  het netwerk erbij komt. Pas als de bon vaststaat gaat er iets naar de
 *  printer, de lade en de wachtrij.
 * ------------------------------------------------------------------ */

type Stap = 'kiezen' | 'contant' | 'pin' | 'rekening' | 'kaart' | 'klaar'

export default function Afrekenen({
  register, operator, onSluiten,
}: { register: PosRegister; operator: User; onSluiten: () => void }) {
  const mandje = useMandje()
  const { raakAan } = useAuth()

  const [stap, setStap] = useState<Stap>('kiezen')
  const [betalingen, setBetalingen] = useState<DeelBetaling[]>([])
  /**
   * De contante afronding hoort bij de bon, niet bij een betaling: het is één
   * bedrag per bon, ook als er twee keer contant wordt bijgelegd.
   */
  const [afronding, setAfronding] = useState(0)
  const [bezig, setBezig] = useState(false)
  const [fout, setFout] = useState<string | null>(null)
  const [resultaat, setResultaat] = useState<AfgerekendeBon | null>(null)
  const [bon, setBon] = useState<BonGegevens | null>(null)

  const totaal = mandje.totalen.incl
  const nogOpen = openstaand(totaal, betalingen)
  const contantDeel = afrondenContant(nogOpen)

  function voegToe(betaling: DeelBetaling) {
    setBetalingen((b) => [...b, betaling])
    setStap('kiezen')
    setFout(null)
    raakAan()
  }

  function haalWeg(index: number) {
    const eruit = betalingen[index]
    setBetalingen(betalingen.filter((_, j) => j !== index))
    if (eruit?.method === 'contant') setAfronding(0)

    /*
     * Een kaartbetaling zette de wasbeurten op nul. Halen we hem weg, dan
     * moeten die prijzen weer terug -- anders geeft de kassa een gratis
     * wasbeurt weg zonder dat er een strip vanaf gaat.
     */
    if (eruit?.method === 'abonnement') {
      for (const r of mandje.regels) {
        if (r.kind === 'wasbeurt' && r.discountPct === 100) mandje.kortingZetten(r.id, 0)
      }
    }
  }

  /* ---------------- de bon vastleggen ---------------- */

  async function rondAf() {
    if (bezig) return
    setBezig(true)
    setFout(null)

    try {
      /*
       * Contant geld hoort in een kassadag te vallen, anders is het aan het
       * eind van de dag niet te tellen. Staat er geen lade open, dan openen we
       * er een met nul wisselgeld en zeggen dat erbij. Dat is beter dan
       * contant geld dat nergens bij hoort, en beter dan een chauffeur laten
       * wachten op een dagafsluiting.
       */
      const heeftContant = betalingen.some((b) => b.method === 'contant')
      let sessieId = (await openSessie(register.id))?.id

      if (heeftContant && !sessieId) {
        const { sessie } = await kasOpenen({ register, door: operator, startbedrag: 0 })
        sessieId = sessie.id
        toast.warn('Er stond geen kas open; er is een kassadag geopend met €0 wisselgeld.')
      }

      const uitslag = await bonAfrekenen({
        register,
        door: operator,
        regels: mandje.regels,
        betalingen,
        klant: { companyId: mandje.klantId, name: mandje.klantNaam },
        plate: mandje.kenteken,
        afronding,
        cashSessionId: sessieId,
        hervatId: mandje.hervatId,
      })

      setResultaat(uitslag)
      setStap('klaar')

      const gegevens = await bonGegevens(uitslag.bon.id)
      setBon(gegevens)

      if (uitslag.nietIngepland > 0) {
        toast.warn(
          `${uitslag.nietIngepland} wasbeurt(en) zijn verkocht maar niet in de ` +
          'wasstraat ingepland: er is geen klant bekend. Stel onder Beheer een ' +
          'klant voor losse ritten in.',
        )
      }

      // Bon en lade. Mislukken mag: de verkoop staat al vast.
      if (gegevens && register.printer.automatisch !== false) {
        const print = await printBon(gegevens, register.printer, { ladeOpen: heeftContant })
        if (print.ok) {
          await bonAfgedrukt(uitslag.bon.id)
        } else if (print.reden) {
          toast.warn(print.reden)
        }
      } else if (heeftContant) {
        await openLade(register.printer)
      }

      mandje.legen()
    } catch (e) {
      setFout(e instanceof Error ? e.message : 'Afrekenen lukte niet')
    } finally {
      setBezig(false)
    }
  }

  /* ---------------- klaar ---------------- */

  if (stap === 'klaar' && resultaat) {
    const contant = resultaat.betalingen.find((b) => b.method === 'contant')
    const terug = contant?.changeGiven ?? 0

    return (
      <Dialoog
        titel={`Bon ${resultaat.bon.receiptNo}`}
        onSluiten={onSluiten}
        wijd
        voet={
          <>
            {bon && (
              <Knop
                onClick={async () => {
                  const print = await printBon({ ...bon, kopie: true }, register.printer)
                  if (print.ok) toast.ok('Bon afgedrukt.')
                  else toast.warn(print.reden ?? 'Afdrukken lukte niet')
                }}
              >
                <Printer size={17} /> Nog een keer afdrukken
              </Knop>
            )}
            <Knop soort="hoofd" onClick={onSluiten}>Volgende klant</Knop>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 18, gridTemplateColumns: '1fr auto' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {terug > 0 && (
              <div
                className="kaart"
                style={{ background: 'var(--tint-brand)', borderColor: 'var(--line-brand)' }}
              >
                <div style={{ fontSize: 13, color: 'var(--text-2)' }}>Wisselgeld</div>
                <div className="bedrag" style={{ fontSize: 40, fontWeight: 800 }}>
                  {money(terug)}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 6 }}>
                  {wisselgeld(terug).map((w) => `${w.aantal}× ${money(w.coupure)}`).join(' · ')}
                </div>
              </div>
            )}

            <Regel
              label="Totaal"
              waarde={money(resultaat.bon.totalIncl + resultaat.bon.rounding)}
              groot
            />

            {resultaat.wasopdrachten.length > 0 && (
              <Uitleg>
                {resultaat.wasopdrachten.length === 1
                  ? 'De wasbeurt staat in de wachtrij van de wasstraat.'
                  : `${resultaat.wasopdrachten.length} wasbeurten staan in de wachtrij van de wasstraat.`}
              </Uitleg>
            )}

            {resultaat.kaarten.length > 0 && (
              <div className="kaart">
                <h3>Verkochte kaarten</h3>
                {resultaat.kaarten.map((k) => (
                  <div key={k.code} style={{ marginTop: 8 }}>
                    <div className="cijfers" style={{ fontWeight: 700, fontSize: 17 }}>{k.code}</div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
                      {k.kind === 'strippenkaart' ? `${k.credits} beurten` : 'abonnement'}
                      {' · staat met een QR-code op de bon'}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {bon && <BonWeergave gegevens={bon} breedte={register.printer.breedte ?? 42} />}
        </div>
      </Dialoog>
    )
  }

  /* ---------------- betalen ---------------- */

  const kaartGebruikt = betalingen.some((b) => b.method === 'abonnement')

  return (
    <Dialoog
      titel="Afrekenen"
      onSluiten={onSluiten}
      voet={
        stap === 'kiezen' ? (
          <>
            <Knop soort="stil" onClick={onSluiten}>Terug naar de bon</Knop>
            <Knop
              soort="hoofd"
              disabled={nogOpen > 0 || !betalingen.length || bezig}
              onClick={() => void rondAf()}
            >
              {bezig ? 'Bezig…' : 'Bon afronden'}
            </Knop>
          </>
        ) : (
          <Knop soort="stil" onClick={() => { setStap('kiezen'); setFout(null) }}>Terug</Knop>
        )
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="kaart">
          <Regel label="Totaal" waarde={money(totaal)} />
          {betalingen.map((b, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <span style={{ flex: 1, fontSize: 13, color: 'var(--text-2)' }}>
                {b.method === 'contant' ? 'Contant'
                  : b.method === 'pin' ? 'Pin'
                    : b.method === 'op-rekening' ? 'Op rekening' : 'Kaart of abonnement'}
                {b.terminalRef ? ` · ${b.terminalRef}` : ''}
              </span>
              <span className="bedrag">{money(b.amount)}</span>
              <Knop soort="stil" maat="klein" onClick={() => haalWeg(i)} aria-label="Weghalen">
                <X size={15} />
              </Knop>
            </div>
          ))}
          <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            <Regel label="Nog te betalen" waarde={money(nogOpen)} groot />
          </div>
        </div>

        {fout && <Fout>{fout}</Fout>}

        {stap === 'kiezen' && (
          nogOpen <= 0 ? (
            <Uitleg>
              De bon is volledig betaald. Rond hem af — dan gaat hij naar de
              printer en naar de administratie.
            </Uitleg>
          ) : (
            <div className="rooster">
              <Knop maat="groot" onClick={() => setStap('contant')}>
                <Banknote size={22} /> Contant
              </Knop>
              <Knop maat="groot" onClick={() => setStap('pin')}>
                <CreditCard size={22} /> Pin
              </Knop>
              <Knop maat="groot" onClick={() => setStap('rekening')}>
                <FileText size={22} /> Op rekening
              </Knop>
              <Knop maat="groot" onClick={() => setStap('kaart')} disabled={kaartGebruikt}>
                <Ticket size={22} /> Kaart
              </Knop>
            </div>
          )
        )}

        {stap === 'contant' && (
          <Contant
            open={nogOpen}
            afgerond={contantDeel}
            onKlaar={(ontvangen, teBetalen, terug, verschil) => {
              setAfronding(verschil)
              voegToe({
                method: 'contant',
                amount: teBetalen,
                received: ontvangen,
                changeGiven: terug,
              })
            }}
          />
        )}

        {stap === 'pin' && (
          <PinBetaling
            bedrag={nogOpen}
            register={register}
            onKlaar={(bedrag, ref, brand) =>
              voegToe({ method: 'pin', amount: bedrag, terminalRef: ref, cardBrand: brand })}
            onFout={setFout}
          />
        )}

        {stap === 'rekening' && (
          <OpRekening
            bedrag={nogOpen}
            klantId={mandje.klantId}
            klantNaam={mandje.klantNaam}
            onKlaar={(bedrag) => voegToe({ method: 'op-rekening', amount: bedrag })}
          />
        )}

        {stap === 'kaart' && (
          <MetKaart
            klantId={mandje.klantId}
            onKlaar={(subscriptionId) => {
              /*
               * Een kaart is vooruitbetaald: de omzet is geboekt toen de kaart
               * werd verkocht. Dus gaat de wasbeurt hier voor nul de bon op en
               * gaat er een strip af -- twee keer omzet boeken voor één
               * wasbeurt zou de cijfers van de vestiging opblazen.
               */
              for (const r of mandje.regels) {
                if (r.kind === 'wasbeurt') mandje.kortingZetten(r.id, 100)
              }
              voegToe({ method: 'abonnement', amount: 0, subscriptionId })
            }}
          />
        )}
      </div>
    </Dialoog>
  )
}

/* ------------------------------------------------------------------ *
 *  Contant
 * ------------------------------------------------------------------ */

function Contant({
  open, afgerond, onKlaar,
}: {
  open: number
  afgerond: { teBetalen: number; verschil: number }
  onKlaar: (ontvangen: number, teBetalen: number, terug: number, verschil: number) => void
}) {
  const [cijfers, setCijfers] = useState('')
  const ontvangen = cijfers ? naarBedrag(cijfers) : 0
  const terug = centen(Math.max(0, ontvangen - afgerond.teBetalen))

  // Alleen bedragen aanbieden waarmee je kunt betalen; kleinere zijn zinloos.
  const snel = [afgerond.teBetalen, 10, 20, 50, 100]
    .filter((n, i, arr) => n >= afgerond.teBetalen && arr.indexOf(n) === i)

  return (
    <div style={{ display: 'grid', gap: 18, gridTemplateColumns: '1fr auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Regel label="Te betalen (afgerond op 5 cent)" waarde={money(afgerond.teBetalen)} groot />
        {afgerond.verschil !== 0 && (
          <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
            Afronding {money(afgerond.verschil)}: er zijn geen munten van één en
            twee cent. De omzet op de bon blijft {money(open)}.
          </div>
        )}

        <Veld label="Ontvangen">
          <div className="bedrag" style={{ fontSize: 30, fontWeight: 800 }}>
            € {cijfers ? alsBedrag(cijfers) : '0,00'}
          </div>
        </Veld>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {snel.map((n) => (
            <Knop key={n} maat="klein" onClick={() => setCijfers(String(Math.round(n * 100)))}>
              {money(n)}
            </Knop>
          ))}
        </div>

        {ontvangen >= afgerond.teBetalen && ontvangen > 0 && (
          <div
            className="kaart"
            style={{ background: 'var(--tint-ok)', borderColor: 'var(--line-ok)' }}
          >
            <div style={{ fontSize: 13, color: 'var(--text-2)' }}>Wisselgeld</div>
            <div className="bedrag" style={{ fontSize: 32, fontWeight: 800 }}>{money(terug)}</div>
          </div>
        )}

        <Knop
          soort="hoofd"
          maat="groot"
          breed
          disabled={ontvangen < afgerond.teBetalen}
          onClick={() => onKlaar(ontvangen, afgerond.teBetalen, terug, afgerond.verschil)}
        >
          <Check size={20} /> Contant ontvangen
        </Knop>
      </div>

      <Toetsenblok waarde={cijfers} onWaarde={setCijfers} maxLengte={8} />
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  Pin
 * ------------------------------------------------------------------ */

function PinBetaling({
  bedrag, register, onKlaar, onFout,
}: {
  bedrag: number
  register: PosRegister
  onKlaar: (bedrag: number, ref?: string, brand?: string) => void
  onFout: (f: string) => void
}) {
  const [wachten, setWachten] = useState(true)
  const [handmatig, setHandmatig] = useState(false)
  const [ref, setRef] = useState('')

  useEffect(() => {
    let afgebroken = false
    void (async () => {
      const uitslag = await pinnen({ bedrag, config: register.terminal })
      if (afgebroken) return
      setWachten(false)

      if (uitslag.handmatig) {
        setHandmatig(true)
        if (uitslag.reden) onFout(uitslag.reden)
        return
      }
      if (uitslag.ok) {
        onKlaar(bedrag, uitslag.ref, uitslag.brand)
        return
      }
      onFout(uitslag.reden ?? 'De betaling is niet gelukt.')
      setHandmatig(true)
    })()
    return () => { afgebroken = true }
    // Eén keer bij het openen; het bedrag verandert niet meer terwijl de
    // terminal bezig is.

  }, [])

  if (wachten) {
    return (
      <div className="kaart" style={{ textAlign: 'center' }}>
        <div className="bedrag" style={{ fontSize: 44, fontWeight: 800 }}>{money(bedrag)}</div>
        <p className="uitleg" style={{ marginTop: 10 }}>Bezig met de betaalterminal…</p>
      </div>
    )
  }

  if (!handmatig) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="kaart" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 13, color: 'var(--text-3)' }}>
          Toets dit bedrag op de pinautomaat
        </div>
        <div className="bedrag" style={{ fontSize: 48, fontWeight: 800, letterSpacing: -1 }}>
          {money(bedrag)}
        </div>
      </div>

      <Veld
        label="Bonnummer van de pinautomaat"
        hint="Niet verplicht. Wel handig als een betaling later teruggezocht moet worden."
      >
        <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="bijv. 004512" />
      </Veld>

      <div style={{ display: 'flex', gap: 10 }}>
        <Knop
          soort="groen"
          maat="groot"
          style={{ flex: 1 }}
          onClick={() => onKlaar(bedrag, ref.trim() || undefined)}
        >
          <Check size={20} /> Betaling gelukt
        </Knop>
        <Knop
          soort="gevaar"
          maat="groot"
          style={{ flex: 1 }}
          onClick={() => onFout('De pinbetaling is niet gelukt. Kies een andere betaalwijze.')}
        >
          <X size={20} /> Niet gelukt
        </Knop>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  Op rekening
 * ------------------------------------------------------------------ */

function OpRekening({
  bedrag, klantId, klantNaam, onKlaar,
}: {
  bedrag: number
  klantId?: string
  klantNaam?: string
  onKlaar: (bedrag: number) => void
}) {
  if (!klantId) {
    return (
      <Uitleg>
        Op rekening kan alleen op naam van een klant. Kies eerst een klant op de
        bon — dan komt deze bon in het dashboard bij die klant te staan.
      </Uitleg>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="kaart">
        <div style={{ fontSize: 13, color: 'var(--text-3)' }}>Op rekening van</div>
        <div style={{ fontSize: 20, fontWeight: 700 }}>{klantNaam}</div>
        <div className="bedrag" style={{ fontSize: 30, fontWeight: 800, marginTop: 8 }}>
          {money(bedrag)}
        </div>
      </div>
      <Uitleg>
        Er wordt nu niets afgerekend en de lade blijft dicht. De bon gaat mee
        naar het dashboard en komt daar bij deze klant te staan.
      </Uitleg>
      <Knop soort="hoofd" maat="groot" breed onClick={() => onKlaar(bedrag)}>
        <Check size={20} /> Op rekening zetten
      </Knop>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  Kaart of abonnement
 * ------------------------------------------------------------------ */

function MetKaart({
  klantId, onKlaar,
}: {
  klantId?: string
  onKlaar: (subscriptionId: string) => void
}) {
  const mandje = useMandje()
  const [zoek, setZoek] = useState('')
  const [gekozen, setGekozen] = useState<KaartMetSaldo | null>(null)

  const wasbeurten = mandje.regels.filter((r) => r.kind === 'wasbeurt')
  const dienst = wasbeurten[0]?.washService

  const kaarten = useLiveQuery(async () => {
    const gevonden = zoek.trim()
      ? await zoekKaarten(zoek)
      : klantId
        ? await db.subscriptions.where('companyId').equals(klantId).toArray()
        : []
    return Promise.all(gevonden.slice(0, 20).map((k) => beoordeel(k, dienst)))
  }, [zoek, klantId, dienst], [] as KaartMetSaldo[])

  if (!wasbeurten.length) {
    return (
      <Uitleg>
        Een kaart of abonnement geldt voor wasbeurten. Er staat geen wasbeurt op
        deze bon, dus er is niets om af te boeken.
      </Uitleg>
    )
  }

  if (gekozen) {
    const strippen = wasbeurten.reduce((n, r) => n + Math.max(1, Math.round(r.qty)), 0)

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="kaart">
          <div className="cijfers" style={{ fontSize: 19, fontWeight: 700 }}>
            {gekozen.kaart.code}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 4 }}>
            {gekozen.kaart.customerName ?? gekozen.kaart.plate ?? 'kaart'}
            {gekozen.kaart.kind === 'strippenkaart'
              ? ` · ${gekozen.saldo} beurten over`
              : ' · abonnement'}
          </div>
        </div>

        <Uitleg>
          {gekozen.kaart.kind === 'strippenkaart'
            ? `Er ${strippen === 1 ? 'gaat één beurt' : `gaan ${strippen} beurten`} van de kaart af.`
            : 'Dit valt binnen het abonnement.'}
          {' '}De wasbeurt komt voor € 0,00 op de bon — hij is al betaald toen de
          kaart werd verkocht.
        </Uitleg>

        <div style={{ display: 'flex', gap: 10 }}>
          <Knop soort="stil" onClick={() => setGekozen(null)}>Andere kaart</Knop>
          <Knop
            soort="hoofd"
            maat="groot"
            style={{ flex: 1 }}
            onClick={() => onKlaar(gekozen.kaart.id)}
          >
            <Check size={20} /> Met deze kaart betalen
          </Knop>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Veld
        label="Kaartcode, kenteken of klant"
        hint="Scannen werkt ook: de code staat als QR op de bon waarop de kaart is verkocht."
      >
        <input value={zoek} onChange={(e) => setZoek(e.target.value)} autoFocus />
      </Veld>

      <div className="lijst">
        {kaarten.map((k) => (
          <button
            key={k.kaart.id}
            type="button"
            className="lijstrij"
            disabled={!k.geldig}
            onClick={() => setGekozen(k)}
            style={{ opacity: k.geldig ? 1 : 0.55 }}
          >
            <div className="rek">
              <div className="titel cijfers">{k.kaart.code}</div>
              <div className="onder">
                {k.kaart.customerName ?? k.kaart.plate ?? ''}
                {k.reden ? ` · ${k.reden}` : ''}
              </div>
            </div>
            {k.kaart.kind === 'strippenkaart'
              ? <Pil soort={k.geldig ? 'ok' : 'fout'}>{k.saldo} over</Pil>
              : <Pil soort={k.geldig ? 'ok' : 'fout'}>abonnement</Pil>}
          </button>
        ))}
        {kaarten.length === 0 && (
          <Leeg
            tekst={zoek
              ? 'Geen kaart gevonden.'
              : 'Zoek een kaart op code, kenteken of klant, of scan hem.'}
          />
        )}
      </div>
    </div>
  )
}
