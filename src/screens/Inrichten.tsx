import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Monitor, Plus } from 'lucide-react'
import logo from '../assets/logo.webp'
import { Fout, Knop, Veld, Waarschuwing } from '../components/ui'
import { db, uid } from '../lib/db'
import { bewaarRegister, kiesRegister } from '../lib/kassa'
import { can } from '../lib/permissions'
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
    <div className="midden">
      <form className="doos" onSubmit={verstuur}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <img src={logo} alt="" style={{ height: 40, borderRadius: 7 }} />
          <div>
            <h1 style={{ margin: 0, fontSize: 20 }}>Truckwash1 Kassa</h1>
            <p className="onder" style={{ margin: 0 }}>Dit apparaat inrichten</p>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Veld
            label="E-mailadres"
            hint="Hetzelfde account als in de wasstraat-app. Eén keer met internet, daarna werkt de kassa ook offline."
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
    </div>
  )
}

/* ------------------------------------------------------------------ */

function KassaKiezen() {
  const { apparaat, logout } = useAuth()
  const [waarschuwing, setWaarschuwing] = useState<string | null>(null)
  const [nieuw, setNieuw] = useState(false)

  const registers = useLiveQuery(async () => {
    const alles = await db.registers.toArray()
    return alles
      .filter((r) => r.active)
      .sort((a, b) => a.code.localeCompare(b.code, 'nl'))
  }, [], [] as PosRegister[])

  const mag = can(apparaat, 'pos.manage')

  async function kies(id: string) {
    try {
      const { waarschuwing: w } = await kiesRegister(id)
      if (w) setWaarschuwing(w)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Kiezen lukte niet')
    }
  }

  return (
    <div className="midden">
      <div className="doos wijd">
        <h1>Welke kassa is dit?</h1>
        <p className="onder">
          Het bonnummer begint met de code van de kassa. Staat er al een apparaat
          op deze kassa, dan geven beide dezelfde bonnummers en blijft de tweede
          in de wachtrij hangen — geef zo'n tweede apparaat een eigen kassa.
        </p>

        {waarschuwing && (
          <div style={{ marginBottom: 16 }}>
            <Waarschuwing>{waarschuwing}</Waarschuwing>
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
              <button key={r.id} type="button" className="tegel" onClick={() => kies(r.id)}>
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

        {mag && (
          <div style={{ marginTop: 18 }}>
            {nieuw ? (
              <NieuweKassa onKlaar={() => setNieuw(false)} />
            ) : (
              <Knop onClick={() => setNieuw(true)}>
                <Plus size={17} /> Nieuwe kassa aanmaken
              </Knop>
            )}
          </div>
        )}

        <div style={{ marginTop: 22, borderTop: '1px solid var(--line)', paddingTop: 16 }}>
          <Knop soort="stil" maat="klein" onClick={() => void logout()}>
            Ander account gebruiken
          </Knop>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function NieuweKassa({ onKlaar }: { onKlaar: () => void }) {
  const { apparaat } = useAuth()
  const [code, setCode] = useState('')
  const [naam, setNaam] = useState('')
  const [locatie, setLocatie] = useState(apparaat?.locationId ?? '')

  const locaties = useLiveQuery(() => db.locations.toArray(), [], [])

  async function maak(e: React.FormEvent) {
    e.preventDefault()
    const schoon = code.trim().toUpperCase()
    if (!/^[A-Z0-9-]{3,20}$/.test(schoon)) {
      toast.error('Een code bestaat uit letters, cijfers en streepjes, 3 tot 20 tekens.')
      return
    }

    const bestaat = (await db.registers.toArray()).some((r) => r.code === schoon)
    if (bestaat) {
      toast.error(`Er is al een kassa met code ${schoon}.`)
      return
    }

    const register = await bewaarRegister({
      id: uid('kassa'),
      locationId: locatie || undefined,
      code: schoon,
      name: naam.trim() || schoon,
      printer: { kind: 'geen', breedte: 42, ladeViaPrinter: true, automatisch: true },
      terminal: { provider: 'handmatig' },
      lastSeq: 0,
      active: true,
      updatedAt: Date.now(),
    })

    await kiesRegister(register.id)
    toast.ok(`Kassa ${schoon} aangemaakt.`)
    onKlaar()
  }

  return (
    <form
      onSubmit={maak}
      style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 420 }}
    >
      <Veld label="Code" hint="Kort en uniek. Hiermee beginnen de bonnummers, bijvoorbeeld KAS-UTR-1.">
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="KAS-UTR-1" required />
      </Veld>
      <Veld label="Naam">
        <input value={naam} onChange={(e) => setNaam(e.target.value)} placeholder="Balie Utrecht" />
      </Veld>
      <Veld label="Vestiging">
        <select value={locatie} onChange={(e) => setLocatie(e.target.value)}>
          <option value="">— kies een vestiging —</option>
          {locaties.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      </Veld>
      <div style={{ display: 'flex', gap: 10 }}>
        <Knop soort="hoofd" type="submit">Aanmaken en gebruiken</Knop>
        <Knop soort="stil" onClick={onKlaar}>Annuleren</Knop>
      </div>
    </form>
  )
}
