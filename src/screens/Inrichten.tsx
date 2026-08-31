import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Monitor, Plus, RefreshCw } from 'lucide-react'
import Voorportaal from '../components/Voorportaal'
import { Fout, Knop, Uitleg, Veld, Waarschuwing } from '../components/ui'
import { db, uid } from '../lib/db'
import {
  bewaarRegister, kassaCodeOpschonen, kassaCodeProbleem, kiesRegister,
} from '../lib/kassa'
import { can } from '../lib/permissions'
import { useSync } from '../lib/sync'
import { useAuth } from '../store/useAuth'
import { toast } from '../store/useToasts'
import type { PosRegister } from '../lib/types'

/* ------------------------------------------------------------------ *
 *  De kassa inrichten
 *
 *  Twee stappen, en ze gebeuren één keer per apparaat:
 *
 *  1. Inloggen met een account uit de wasstraat-app. Daarmee weet de kassa
 *     welke vestiging dit is en wat hij mag ophalen.
 *  2. Kiezen welke kassa dit apparaat is. Het bonnummer begint met die code,
 *     dus twee apparaten op dezelfde kassa gaat niet.
 *
 *  Daarna blijft dit staan, ook na een herstart en ook zonder internet. Wie er
 *  achter de kassa staat is een andere vraag; die stelt Aanmelden.
 *
 *  Elke melding in dit scherm staat in het scherm zelf, niet in een
 *  wegschuivend blokje rechtsonder. Dit is het enige punt waar iemand nog
 *  niets van de app weet: iets wat niet lukt moet hier hardop zeggen waarom.
 * ------------------------------------------------------------------ */

export default function Inrichten() {
  const { apparaat, login, busy, error } = useAuth()

  return apparaat ? <KassaKiezen /> : <Aanmelden login={login} busy={busy} error={error} />
}

/* ------------------------------------------------------------------ */

function Aanmelden({
  login, busy, error,
}: {
  login: (email: string, wachtwoord: string) => Promise<boolean>
  busy: boolean
  error: string | null
}) {
  const [email, setEmail] = useState('')
  const [wachtwoord, setWachtwoord] = useState('')

  async function verstuur(e: React.FormEvent) {
    e.preventDefault()
    await login(email, wachtwoord)
  }

  return (
    <Voorportaal ondertitel="Kassa inrichten">
      <form onSubmit={verstuur}>
        <h2>Dit apparaat inrichten</h2>
        <p className="onder">
          Eén keer, met internet. Daarna weet de kassa welke vestiging dit is en
          werkt hij ook offline.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Veld
            label="E-mailadres"
            hint="Hetzelfde account als in de wasstraat-app."
          >
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </Veld>

          <Veld label="Wachtwoord">
            <input
              type="password"
              autoComplete="current-password"
              value={wachtwoord}
              onChange={(e) => setWachtwoord(e.target.value)}
              required
            />
          </Veld>

          {error && <Fout>{error}</Fout>}

          <Knop soort="hoofd" breed type="submit" disabled={busy}>
            {busy ? 'Bezig…' : 'Kassa inrichten'}
          </Knop>
        </div>
      </form>
    </Voorportaal>
  )
}

/* ------------------------------------------------------------------ */

function KassaKiezen() {
  const { apparaat, logout } = useAuth()
  const { syncing, pending, lastError, online, sync } = useSync()
  const [waarschuwing, setWaarschuwing] = useState<string | null>(null)
  const [fout, setFout] = useState<string | null>(null)
  const [nieuw, setNieuw] = useState(false)

  const registers = useLiveQuery(async () => {
    const alles = await db.registers.toArray()
    return alles
      .filter((r) => r.active)
      .sort((a, b) => a.code.localeCompare(b.code, 'nl'))
  }, [], [] as PosRegister[])

  const mag = can(apparaat, 'pos.manage')

  async function kies(id: string) {
    setFout(null)
    try {
      const { waarschuwing: w } = await kiesRegister(id)
      if (w) setWaarschuwing(w)
    } catch (e) {
      setFout(e instanceof Error ? e.message : 'Deze kassa kiezen lukte niet.')
    }
  }

  return (
    <Voorportaal breed ondertitel="Welke kassa is dit?">
      <div>
        <h2>Welke kassa is dit?</h2>
        <p className="onder">
          Het bonnummer begint met de code van de kassa. Staat er al een apparaat
          op deze kassa, dan geven beide dezelfde bonnummers en blijft de tweede
          in de wachtrij hangen — geef zo'n tweede apparaat een eigen kassa.
        </p>

        {fout && <div style={{ marginBottom: 16 }}><Fout>{fout}</Fout></div>}

        {waarschuwing && (
          <div style={{ marginBottom: 16 }}>
            <Waarschuwing>{waarschuwing}</Waarschuwing>
          </div>
        )}

        {/*
          Als de eerste synchronisatie strandde, is de lijst leeg om een reden
          die niets met kassa's te maken heeft. Dat hoort hier te staan en niet
          in een logboek.
        */}
        {lastError && (
          <div style={{ marginBottom: 16 }}>
            <Fout>
              De kassa kon de gegevens niet ophalen: {lastError}
              <div style={{ marginTop: 10 }}>
                <Knop maat="klein" onClick={() => void sync()} disabled={syncing}>
                  <RefreshCw size={15} /> {syncing ? 'Bezig…' : 'Opnieuw proberen'}
                </Knop>
              </div>
            </Fout>
          </div>
        )}

        {!lastError && !online && (
          <div style={{ marginBottom: 16 }}>
            <Waarschuwing>
              Geen verbinding. Inrichten kan alleen met internet, want de kassa
              moet weten welke kassa's er al zijn.
            </Waarschuwing>
          </div>
        )}

        {registers.length === 0 ? (
          <div className="leeg">
            Er staat nog geen kassa in de database.
            {mag ? ' Maak er hieronder een aan.' : ' Laat het management er een aanmaken.'}
          </div>
        ) : (
          <div className="rooster">
            {registers.map((r) => (
              <button key={r.id} type="button" className="tegel" onClick={() => void kies(r.id)}>
                <div>
                  <div className="naam">{r.name || r.code}</div>
                  <div className="sub">{r.code}</div>
                </div>
                <div className="sub">
                  <Monitor size={14} style={{ verticalAlign: -2, marginRight: 5 }} />
                  {r.device ? 'in gebruik op een apparaat' : 'vrij'}
                </div>
              </button>
            ))}
          </div>
        )}

        {mag ? (
          <div style={{ marginTop: 18 }}>
            {nieuw ? (
              <NieuweKassa onKlaar={() => setNieuw(false)} />
            ) : (
              <Knop onClick={() => setNieuw(true)}>
                <Plus size={17} /> Nieuwe kassa aanmaken
              </Knop>
            )}
          </div>
        ) : (
          <div style={{ marginTop: 18 }}>
            <Uitleg>
              Een kassa aanmaken vraagt het recht "Kassa beheren". Dat deelt het
              management uit in het dashboard, onder Personeel → Rechten.
            </Uitleg>
          </div>
        )}

        <div style={{ marginTop: 22, borderTop: '1px solid var(--line)', paddingTop: 16 }}>
          <Knop soort="stil" maat="klein" onClick={() => void logout()}>
            Ander account gebruiken
          </Knop>
          {pending > 0 && (
            <span style={{ marginLeft: 12, fontSize: 12.5, color: 'var(--text-3)' }}>
              {pending} wijziging(en) wachten nog op verzending
            </span>
          )}
        </div>
      </div>
    </Voorportaal>
  )
}

/* ------------------------------------------------------------------ */

function NieuweKassa({ onKlaar }: { onKlaar: () => void }) {
  const { apparaat } = useAuth()
  const [ruweCode, setRuweCode] = useState('')
  const [naam, setNaam] = useState('')
  const [locatie, setLocatie] = useState(apparaat?.locationId ?? '')
  const [fout, setFout] = useState<string | null>(null)
  const [bezig, setBezig] = useState(false)

  const locaties = useLiveQuery(() => db.locations.toArray(), [], [])

  // Wat er van de ingetikte code overblijft. Meteen te zien, zodat niemand
  // zich hoeft af te vragen waarom "Balie 1" niet mag.
  const code = kassaCodeOpschonen(ruweCode)
  const probleem = ruweCode ? kassaCodeProbleem(code) : null

  async function maak(e: React.FormEvent) {
    e.preventDefault()
    setFout(null)

    const bezwaar = kassaCodeProbleem(code)
    if (bezwaar) { setFout(bezwaar); return }

    setBezig(true)
    try {
      const bestaat = (await db.registers.toArray()).some((r) => r.code === code)
      if (bestaat) {
        setFout(
          `Er is al een kassa met code ${code}. Kies die hierboven als dit dat ` +
          'apparaat is, of neem een andere code.',
        )
        return
      }

      const register = await bewaarRegister({
        id: uid('kassa'),
        locationId: locatie || undefined,
        code,
        name: naam.trim() || code,
        printer: { kind: 'geen', breedte: 42, ladeViaPrinter: true, automatisch: true },
        terminal: { provider: 'handmatig' },
        lastSeq: 0,
        active: true,
        updatedAt: Date.now(),
      })

      await kiesRegister(register.id)
      toast.ok(`Kassa ${code} aangemaakt.`)
      onKlaar()
    } catch (e) {
      setFout(e instanceof Error ? e.message : 'De kassa aanmaken lukte niet.')
    } finally {
      setBezig(false)
    }
  }

  return (
    <form
      onSubmit={maak}
      style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 460 }}
    >
      <Veld
        label="Code"
        hint="Kort en uniek. Hiermee beginnen de bonnummers, bijvoorbeeld KAS-UTR-1."
      >
        <input
          value={ruweCode}
          onChange={(e) => { setRuweCode(e.target.value); setFout(null) }}
          placeholder="KAS-UTR-1"
          autoFocus
        />
      </Veld>

      {ruweCode && (
        code !== ruweCode.toUpperCase().trim() || probleem ? (
          <div style={{ fontSize: 13, color: probleem ? 'var(--text-danger)' : 'var(--text-2)' }}>
            {probleem
              ? probleem
              : <>Wordt opgeslagen als <strong className="cijfers">{code}</strong> —
                  spaties en punten worden streepjes, want dit staat in elk bonnummer.</>}
          </div>
        ) : null
      )}

      <Veld label="Naam">
        <input value={naam} onChange={(e) => setNaam(e.target.value)} placeholder="Balie Utrecht" />
      </Veld>

      <Veld
        label="Vestiging"
        hint={locaties.length === 0
          ? 'Er zijn nog geen vestigingen opgehaald. Dat mag: je kunt dit later onder Beheer zetten.'
          : 'Bepaalt welke artikelen, wasopdrachten en medewerkers deze kassa ziet.'}
      >
        <select value={locatie} onChange={(e) => setLocatie(e.target.value)}>
          <option value="">— geen vestiging —</option>
          {locaties.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      </Veld>

      {fout && <Fout>{fout}</Fout>}

      <div style={{ display: 'flex', gap: 10 }}>
        <Knop soort="hoofd" type="submit" disabled={bezig || !code || Boolean(probleem)}>
          {bezig ? 'Bezig…' : 'Aanmaken en gebruiken'}
        </Knop>
        <Knop soort="stil" onClick={onKlaar}>Annuleren</Knop>
      </div>
    </form>
  )
}
