import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { AlertTriangle, Clock, LogIn, LogOut } from 'lucide-react'
import Toetsenblok, { CodeVakjes } from '../components/Toetsenblok'
import { Dialoog, Fout, Knop, Leeg, Pil, Uitleg, Veld } from '../components/ui'
import { db } from '../lib/db'
import { duration, time } from '../lib/format'
import { herken, herkenBadge } from '../lib/code'
import { useScanner } from '../lib/hardware/scanner'
import {
  aanwezig, dienstCorrigeren, inklokken, openDienst, uitklokken, vandaagGewerkt,
  wekelijkGewerkt, type Aanwezig,
} from '../lib/klok'
import { can } from '../lib/permissions'
import { useAuth } from '../store/useAuth'
import { toast } from '../store/useToasts'
import type { User } from '../lib/types'

/* ------------------------------------------------------------------ *
 *  Klokken
 *
 *  De uren gaan in dezelfde tabel als in de wasstraat-app. Wie hier inklokt
 *  staat meteen in het dashboard onder Uren, en de leidinggevende keurt ze
 *  daar goed. Geen tweede urenlijst, geen overtypen.
 *
 *  Waarom dit in de kassa zit en niet alleen in de app op de telefoon: de
 *  kassa staat er altijd, hij hangt aan de stroom, en iedereen loopt er langs.
 *  Een telefoon met een lege accu is een urenstaat met een gat.
 * ------------------------------------------------------------------ */

const CODE_LENGTE = 6

export default function Klok() {
  const { apparaat, operator, raakAan } = useAuth()
  const locatie = apparaat?.locationId

  const [kiezen, setKiezen] = useState<User | null>(null)
  const [code, setCode] = useState('')
  const [fout, setFout] = useState<string | null>(null)
  const [bezig, setBezig] = useState(false)
  const [corrigeren, setCorrigeren] = useState<Aanwezig | null>(null)

  const ingeklokt = useLiveQuery(() => aanwezig(locatie), [locatie], [] as Aanwezig[])

  const mensen = useLiveQuery(async () => {
    const alles = await db.users.toArray()
    return alles
      .filter((u) => u.active && (!locatie || !u.locationId || u.locationId === locatie || u.allLocations))
      .sort((a, b) => a.name.localeCompare(b.name, 'nl'))
  }, [locatie], [] as User[])

  /* ---- badge: scannen klokt in of uit ---- */
  useScanner(async (gescand) => {
    if (!gescand.startsWith('TWB-')) return
    const uitslag = await herkenBadge(gescand)
    if (!uitslag.ok) {
      setFout('Deze badge is niet bekend.')
      return
    }
    await wissel(uitslag.user)
  }, !kiezen && !corrigeren)

  /** In- of uitklokken, wat er ook aan de orde is. */
  async function wissel(user: User) {
    raakAan()
    const open = await openDienst(user.id)

    if (open) {
      const gesloten = await uitklokken(user.id)
      const gewerkt = gesloten && gesloten.end ? gesloten.end - gesloten.start : 0
      toast.ok(`${user.name.split(' ')[0]} is uitgeklokt — ${duration(gewerkt)} gewerkt.`)
    } else {
      const { alOpen } = await inklokken(user, locatie)
      if (!alOpen) toast.ok(`${user.name.split(' ')[0]} is ingeklokt.`)
    }

    setKiezen(null)
    setCode('')
    setFout(null)
  }

  /** Klokken met de code, voor wie geen badge heeft. */
  async function metCode() {
    if (!kiezen || code.length !== CODE_LENGTE) return
    setBezig(true)
    const uitslag = await herken(kiezen.id, code)
    setBezig(false)

    if (!uitslag.ok) {
      setFout(
        uitslag.reden === 'geblokkeerd'
          ? `Te vaak misgetoetst. Probeer het over ${
              Math.ceil((uitslag.wachtMs ?? 0) / 1000)} seconden weer.`
          : uitslag.reden === 'geen-code'
            ? 'Voor deze medewerker is nog geen code ingesteld.'
            : 'Die code klopt niet.',
      )
      setCode('')
      return
    }

    await wissel(uitslag.user)
  }

  /* ---------------- code toetsen ---------------- */

  if (kiezen) {
    const open = ingeklokt.find((a) => a.user.id === kiezen.id)

    return (
      <div className="paneel">
        <div style={{ maxWidth: 420, margin: '0 auto' }}>
          <div className="kaart">
            <h3>{kiezen.name}</h3>
            <p className="uitleg">
              {open
                ? `Ingeklokt om ${time(open.entry.start)}. Toets je code om uit te klokken.`
                : 'Toets je code om in te klokken.'}
            </p>

            <div style={{ margin: '18px 0' }}>
              <CodeVakjes waarde={code} lengte={CODE_LENGTE} />
            </div>

            {fout && <div style={{ marginBottom: 14 }}><Fout>{fout}</Fout></div>}

            <div style={{ display: 'grid', placeItems: 'center' }}>
              <Toetsenblok
                waarde={code}
                onWaarde={(v) => { setCode(v); setFout(null) }}
                maxLengte={CODE_LENGTE}
                onKlaar={() => void metCode()}
                klaarTekst={open ? 'Uit' : 'In'}
                klaarUit={code.length !== CODE_LENGTE || bezig}
              />
            </div>

            <div style={{ marginTop: 16 }}>
              <Knop
                soort="stil"
                breed
                onClick={() => { setKiezen(null); setCode(''); setFout(null) }}
              >
                Terug
              </Knop>
            </div>
          </div>
        </div>
      </div>
    )
  }

  /* ---------------- overzicht ---------------- */

  return (
    <div className="paneel">
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
        <div className="kaart">
          <h3>Nu aan het werk</h3>
          <p className="uitleg">
            Wie hier staat, staat ook in het dashboard onder Uren. Scannen met een
            badge klokt in of uit; zonder badge kies je hiernaast je naam.
          </p>

          {ingeklokt.length === 0 ? (
            <Leeg tekst="Er is nog niemand ingeklokt." />
          ) : (
            <div className="lijst">
              {ingeklokt.map((a) => (
                <div key={a.entry.id} className="lijstrij" style={{ cursor: 'default' }}>
                  <div className="rek">
                    <div className="titel">{a.user.name}</div>
                    <div className="onder">
                      sinds {time(a.entry.start)} · {duration(Date.now() - a.entry.start)}
                    </div>
                  </div>
                  {a.vergeten ? (
                    <>
                      <Pil soort="warn">
                        <AlertTriangle size={13} /> vergeten?
                      </Pil>
                      {can(operator, 'hours.approve') && (
                        <Knop maat="klein" onClick={() => setCorrigeren(a)}>Rechtzetten</Knop>
                      )}
                    </>
                  ) : (
                    <Knop maat="klein" onClick={() => void wissel(a.user)}>
                      <LogOut size={15} /> Uit
                    </Knop>
                  )}
                </div>
              ))}
            </div>
          )}

          {ingeklokt.some((a) => a.vergeten) && (
            <div style={{ marginTop: 14 }}>
              <Uitleg>
                Een dienst van meer dan zestien uur is bijna altijd een vergeten
                uitklok. De kassa sluit hem niet zelf af — dan zou hij uren
                verzinnen die niemand heeft gemaakt. Iemand met het recht "Uren
                goedkeuren" zet de werkelijke eindtijd.
              </Uitleg>
            </div>
          )}
        </div>

        <div className="kaart">
          <h3>In- of uitklokken</h3>
          <p className="uitleg">Kies je naam en toets je persoonlijke code.</p>

          {mensen.length === 0 ? (
            <Leeg tekst="De kassa heeft nog geen personeel opgehaald." />
          ) : (
            <div className="mensen">
              {mensen.map((u) => {
                const open = ingeklokt.find((a) => a.user.id === u.id)
                return (
                  <button
                    key={u.id}
                    type="button"
                    className={`mens ${open ? 'ingeklokt' : ''}`}
                    onClick={() => { setKiezen(u); setFout(null); setCode('') }}
                  >
                    <div className="naam">{u.name}</div>
                    <div className="nr">
                      {open
                        ? <><LogOut size={12} style={{ verticalAlign: -2 }} /> sinds {time(open.entry.start)}</>
                        : <><LogIn size={12} style={{ verticalAlign: -2 }} /> {u.personnelNumber ?? ''}</>}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {operator && <MijnUren user={operator} />}

      {corrigeren && (
        <Corrigeren
          aanwezig={corrigeren}
          doorNaam={operator?.name ?? 'onbekend'}
          onSluiten={() => setCorrigeren(null)}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  Wat er voor mij op staat
 * ------------------------------------------------------------------ */

function MijnUren({ user }: { user: User }) {
  const vandaag = useLiveQuery(() => vandaagGewerkt(user.id), [user.id], 0)
  const week = useLiveQuery(() => wekelijkGewerkt(user.id), [user.id], 0)

  return (
    <div className="kaart" style={{ marginTop: 16 }}>
      <h3>
        <Clock size={16} style={{ verticalAlign: -3, marginRight: 7 }} />
        Jouw uren
      </h3>
      <div style={{ display: 'flex', gap: 28, marginTop: 10 }}>
        <div>
          <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>Vandaag</div>
          <div className="bedrag" style={{ fontSize: 26, fontWeight: 800 }}>{duration(vandaag)}</div>
        </div>
        <div>
          <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>Deze week</div>
          <div className="bedrag" style={{ fontSize: 26, fontWeight: 800 }}>{duration(week)}</div>
        </div>
        {user.contractHours ? (
          <div>
            <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>Contract</div>
            <div className="bedrag" style={{ fontSize: 26, fontWeight: 800 }}>
              {user.contractHours}u
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  Een vergeten uitklok rechtzetten
 * ------------------------------------------------------------------ */

function Corrigeren({
  aanwezig: a, doorNaam, onSluiten,
}: { aanwezig: Aanwezig; doorNaam: string; onSluiten: () => void }) {
  const [eind, setEind] = useState(() => {
    const d = new Date(a.entry.start)
    d.setHours(d.getHours() + 8)
    return naarInvoer(d.getTime())
  })
  const [reden, setReden] = useState('')

  async function bewaar() {
    if (!reden.trim()) {
      toast.error('Zet erbij waarom deze dienst wordt bijgesteld.')
      return
    }
    const tijd = new Date(eind).getTime()
    if (!Number.isFinite(tijd) || tijd <= a.entry.start) {
      toast.error('De eindtijd moet na de begintijd liggen.')
      return
    }

    await dienstCorrigeren({
      entryId: a.entry.id,
      end: tijd,
      note: reden.trim(),
      doorNaam,
    })
    toast.ok('Dienst rechtgezet. Hij staat nu zo in het dashboard.')
    onSluiten()
  }

  return (
    <Dialoog
      titel={`Dienst van ${a.user.name}`}
      onSluiten={onSluiten}
      voet={
        <>
          <Knop soort="stil" onClick={onSluiten}>Annuleren</Knop>
          <Knop soort="hoofd" onClick={() => void bewaar()}>Rechtzetten</Knop>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Uitleg>
          Deze dienst staat sinds {new Date(a.entry.start).toLocaleString('nl-NL')} open.
          Zet de werkelijke eindtijd; wie het deed en waarom komt bij de dienst te
          staan, zodat het op de loonstrook geen vraag oplevert.
        </Uitleg>

        <Veld label="Werkelijke eindtijd">
          <input type="datetime-local" value={eind} onChange={(e) => setEind(e.target.value)} />
        </Veld>

        <Veld label="Waarom" hint="Bijvoorbeeld: vergeten uit te klokken, ploeg eindigde om 17:00.">
          <input value={reden} onChange={(e) => setReden(e.target.value)} />
        </Veld>
      </div>
    </Dialoog>
  )
}

/** Van epoch naar de waarde die een datetime-local-veld wil. */
function naarInvoer(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
