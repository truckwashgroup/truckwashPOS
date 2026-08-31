import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowLeft, ScanLine } from 'lucide-react'
import Toetsenblok, { CodeVakjes } from '../components/Toetsenblok'
import { Fout, Knop, Uitleg } from '../components/ui'
import { db } from '../lib/db'
import { useScanner } from '../lib/hardware/scanner'
import { aanwezig } from '../lib/klok'
import { can } from '../lib/permissions'
import { useAuth } from '../store/useAuth'
import { toast } from '../store/useToasts'
import type { User } from '../lib/types'

/* ------------------------------------------------------------------ *
 *  Wie staat er achter de kassa?
 *
 *  Eerst je naam, dan je code. Andersom -- eerst een code intoetsen en dan
 *  zoeken wie dat is -- kan niet: twee mensen kunnen dezelfde zes cijfers
 *  kiezen, en dan zou de kassa moeten gokken.
 *
 *  Wie een badge heeft slaat beide stappen over: scannen en hij staat erin.
 * ------------------------------------------------------------------ */

const CODE_LENGTE = 6

export default function Aanmelden() {
  const { apparaat, meldAan, meldAanMetBadge } = useAuth()
  const [gekozen, setGekozen] = useState<User | null>(null)
  const [code, setCode] = useState('')
  const [fout, setFout] = useState<string | null>(null)
  const [bezig, setBezig] = useState(false)

  const locatie = apparaat?.locationId

  const mensen = useLiveQuery(async () => {
    const alles = await db.users.toArray()
    return alles
      .filter((u) =>
        u.active &&
        // Wie hier niet werkt hoort hier ook niet af te rekenen.
        (!locatie || !u.locationId || u.locationId === locatie || u.allLocations) &&
        can(u, 'pos.use'))
      .sort((a, b) => a.name.localeCompare(b.name, 'nl'))
  }, [locatie], [] as User[])

  const ingeklokt = useLiveQuery(
    async () => new Set((await aanwezig(locatie)).map((a) => a.user.id)),
    [locatie],
    new Set<string>(),
  )

  /* ---- badge scannen ---- */
  useScanner(async (gescand) => {
    if (!gescand.startsWith('TWB-')) return
    setBezig(true)
    const uitslag = await meldAanMetBadge(gescand)
    setBezig(false)
    if (!uitslag.ok) setFout(uitslag.fout ?? 'Deze badge werkt niet.')
  })

  /* ---- code volledig? dan meteen proberen ---- */
  useEffect(() => {
    if (!gekozen || code.length !== CODE_LENGTE || bezig) return

    let afgebroken = false
    setBezig(true)
    void (async () => {
      const uitslag = await meldAan(gekozen.id, code)
      if (afgebroken) return
      setBezig(false)
      if (uitslag.ok) {
        toast.ok(`Welkom, ${gekozen.name.split(' ')[0]}.`)
      } else {
        setFout(uitslag.fout ?? 'Die code klopt niet.')
        setCode('')
      }
    })()

    return () => { afgebroken = true }
  }, [code, gekozen, bezig, meldAan])

  /* ---------------- naam kiezen ---------------- */

  if (!gekozen) {
    return (
      <div className="midden">
        <div className="doos wijd">
          <h1>Wie staat er achter de kassa?</h1>
          <p className="onder">
            Kies je naam en toets je persoonlijke code. Heb je een badge, scan
            hem dan — dat is sneller.
          </p>

          {fout && <div style={{ marginBottom: 14 }}><Fout>{fout}</Fout></div>}

          {mensen.length === 0 ? (
            <Uitleg>
              Er staat nog niemand in de lijst. Dat betekent dat de kassa nog
              geen personeel heeft opgehaald, of dat niemand op deze vestiging
              het recht "Kassa gebruiken" heeft. Dat recht deelt het management
              uit in het dashboard onder Personeel → Rechten.
            </Uitleg>
          ) : (
            <div className="mensen">
              {mensen.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className={`mens ${ingeklokt.has(u.id) ? 'ingeklokt' : ''}`}
                  onClick={() => { setGekozen(u); setFout(null); setCode('') }}
                >
                  <div className="naam">{u.name}</div>
                  <div className="nr">
                    {u.personnelNumber ?? u.function ?? ''}
                    {ingeklokt.has(u.id) ? ' • ingeklokt' : ''}
                  </div>
                </button>
              ))}
            </div>
          )}

          <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-3)', fontSize: 13 }}>
            <ScanLine size={16} /> Badge scannen kan altijd, ook vanaf dit scherm.
          </div>
        </div>
      </div>
    )
  }

  /* ---------------- code toetsen ---------------- */

  return (
    <div className="midden">
      <div className="doos">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <Knop
            soort="stil"
            maat="klein"
            onClick={() => { setGekozen(null); setCode(''); setFout(null) }}
          >
            <ArrowLeft size={17} />
          </Knop>
          <div>
            <h1 style={{ margin: 0, fontSize: 19 }}>{gekozen.name}</h1>
            <p className="onder" style={{ margin: 0 }}>Toets je persoonlijke code</p>
          </div>
        </div>

        <div style={{ margin: '22px 0' }}>
          <CodeVakjes waarde={code} lengte={CODE_LENGTE} />
        </div>

        {fout && <div style={{ marginBottom: 14 }}><Fout>{fout}</Fout></div>}

        <div style={{ display: 'grid', placeItems: 'center' }}>
          <Toetsenblok
            waarde={code}
            onWaarde={(v) => { setCode(v); setFout(null) }}
            maxLengte={CODE_LENGTE}
          />
        </div>

        <p className="onder" style={{ marginTop: 20, marginBottom: 0 }}>
          Nog geen code? Iemand met het recht "Kassa beheren" zet er een onder
          Beheer → Codes.
        </p>
      </div>
    </div>
  )
}
