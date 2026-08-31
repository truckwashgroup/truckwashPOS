import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowLeft, KeyRound, ScanLine } from 'lucide-react'
import Toetsenblok, { CodeVakjes } from '../components/Toetsenblok'
import { Fout, Knop, Uitleg, Veld } from '../components/ui'
import { codeInstellen, codeProbleem, heeftCode } from '../lib/code'
import { db } from '../lib/db'
import { useScanner } from '../lib/hardware/scanner'
import { aanwezig } from '../lib/klok'
import { verifyOfflineLogin } from '../lib/offlineAuth'
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
 *
 *  En dan het geval dat hier eerst helemaal niet in zat: een kassa waar nog
 *  geen enkele code op staat. Je had een code nodig om binnen te komen, en je
 *  moest binnen zijn om een code te maken. Een nieuwe kassa zat daarmee klem.
 *
 *  Daarom kan wie dit apparaat heeft ingericht altijd binnenkomen met het
 *  wachtwoord van dat account. Dat is geen achterdeur: het is het sterkere
 *  slot van de twee. Met dat wachtwoord is de kassa immers ingericht, en de
 *  code is niet meer dan een paraaf die zegt wie er handelde.
 * ------------------------------------------------------------------ */

const CODE_LENGTE = 6

export default function Aanmelden() {
  const { apparaat, meldAan, meldAanMetBadge } = useAuth()
  const [gekozen, setGekozen] = useState<User | null>(null)
  const [metWachtwoord, setMetWachtwoord] = useState(false)
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

  /** Van wie hier al een code bekend is. */
  const metCode = useLiveQuery(async () => {
    const alles = await db.pins.toArray()
    return new Set(alles.map((p) => p.userId))
  }, [], new Set<string>())

  /* ---- badge scannen ---- */
  useScanner(async (gescand) => {
    if (!gescand.startsWith('TWB-')) return
    setBezig(true)
    const uitslag = await meldAanMetBadge(gescand)
    setBezig(false)
    if (!uitslag.ok) setFout(uitslag.fout ?? 'Deze badge werkt niet.')
  }, !metWachtwoord)

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

  /* ---------------- met het wachtwoord van het apparaat ---------------- */

  if (metWachtwoord && apparaat) {
    return (
      <MetWachtwoord
        apparaat={apparaat}
        onTerug={() => { setMetWachtwoord(false); setFout(null) }}
      />
    )
  }

  /* ---------------- naam kiezen ---------------- */

  if (!gekozen) {
    const niemandHeeftEenCode = mensen.length > 0 &&
      mensen.every((u) => !metCode.has(u.id))

    return (
      <div className="midden">
        <div className="doos wijd">
          <h1>Wie staat er achter de kassa?</h1>
          <p className="onder">
            Kies je naam en toets je persoonlijke code. Heb je een badge, scan
            hem dan — dat is sneller.
          </p>

          {fout && <div style={{ marginBottom: 14 }}><Fout>{fout}</Fout></div>}

          {niemandHeeftEenCode && (
            <div style={{ marginBottom: 16 }}>
              <Uitleg>
                Er is nog voor niemand een code ingesteld. Meld je hieronder aan
                met het wachtwoord van dit apparaat; daarna zet je codes onder
                Beheer → Codes en badges.
              </Uitleg>
            </div>
          )}

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
                    {metCode.has(u.id)
                      ? (u.personnelNumber ?? u.function ?? '')
                      : 'nog geen code'}
                    {ingeklokt.has(u.id) ? ' • ingeklokt' : ''}
                  </div>
                </button>
              ))}
            </div>
          )}

          <div
            style={{
              marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--line)',
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            }}
          >
            <Knop maat="klein" onClick={() => setMetWachtwoord(true)}>
              <KeyRound size={16} /> Aanmelden met het wachtwoord van dit apparaat
            </Knop>
            <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
              <ScanLine size={14} style={{ verticalAlign: -2, marginRight: 5 }} />
              Badge scannen kan altijd, ook vanaf dit scherm.
            </span>
          </div>
        </div>
      </div>
    )
  }

  /* ---------------- code toetsen ---------------- */

  const heeftGeenCode = !metCode.has(gekozen.id)

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
            <p className="onder" style={{ margin: 0 }}>
              {heeftGeenCode ? 'Nog geen code ingesteld' : 'Toets je persoonlijke code'}
            </p>
          </div>
        </div>

        {heeftGeenCode ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Uitleg>
              Voor {gekozen.name.split(' ')[0]} is nog geen code ingesteld. Iemand
              met het recht "Kassa beheren" zet er een onder Beheer → Codes en
              badges.
            </Uitleg>
            <Knop breed onClick={() => setMetWachtwoord(true)}>
              <KeyRound size={17} /> Aanmelden met het wachtwoord van dit apparaat
            </Knop>
          </div>
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  Aanmelden met het wachtwoord van het apparaatccount
 *
 *  Dit is de weg naar binnen als er nog geen codes zijn -- en de weg terug
 *  als iemand zijn code kwijt is.
 *
 *  Let op wat hier wél en niet kan: je komt binnen als het account waarmee de
 *  kassa is ingericht, en niet als een willekeurige collega. Met het
 *  apparaatwachtwoord op andermans naam kunnen verkopen zou de naam op de bon
 *  waardeloos maken.
 * ------------------------------------------------------------------ */

function MetWachtwoord({
  apparaat, onTerug,
}: { apparaat: User; onTerug: () => void }) {
  const { meldAan } = useAuth()
  const [wachtwoord, setWachtwoord] = useState('')
  const [fout, setFout] = useState<string | null>(null)
  const [bezig, setBezig] = useState(false)
  const [nieuweCode, setNieuweCode] = useState('')
  const [stap, setStap] = useState<'wachtwoord' | 'code'>('wachtwoord')

  const alCode = useLiveQuery(() => heeftCode(apparaat.id), [apparaat.id], false)
  const magKassa = can(apparaat, 'pos.use')

  async function controleer(e: React.FormEvent) {
    e.preventDefault()
    setFout(null)
    setBezig(true)
    try {
      const userId = await verifyOfflineLogin(apparaat.email, wachtwoord)
      if (userId !== apparaat.id) {
        setFout('Dat wachtwoord klopt niet.')
        return
      }

      /*
       * Nu een code kiezen, en daarmee naar binnen.
       *
       * Ook als er al een code staat: die is niet te lezen -- ook niet door
       * de app -- dus wie deze omweg neemt, weet hem niet. Een nieuwe zetten
       * is dan het enige dat helpt, en het scheelt dat hij deze omweg morgen
       * weer moet nemen.
       *
       * Wat we bewust níét doen is een tijdelijke code laten uitdelen door de
       * kassa. Dan zou er een code bestaan die niemand heeft gekozen, en die
       * ergens opgeschreven moet worden om te onthouden.
       */
      setStap('code')
    } finally {
      setBezig(false)
    }
  }

  async function zetEnGaVerder() {
    setFout(null)

    const probleem = codeProbleem(nieuweCode)
    if (probleem) { setFout(probleem); return }

    setBezig(true)
    try {
      await codeInstellen({
        userId: apparaat.id,
        code: nieuweCode,
        doorId: apparaat.id,
      })
      const uitslag = await meldAan(apparaat.id, nieuweCode)
      if (!uitslag.ok) {
        setFout(uitslag.fout ?? 'Aanmelden lukte niet.')
        return
      }
      toast.ok(`Code ingesteld. Vanaf nu meld je je aan met deze zes cijfers.`)
    } catch (e) {
      setFout(e instanceof Error ? e.message : 'Instellen lukte niet')
    } finally {
      setBezig(false)
    }
  }

  return (
    <div className="midden">
      <div className="doos">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <Knop soort="stil" maat="klein" onClick={onTerug}>
            <ArrowLeft size={17} />
          </Knop>
          <div>
            <h1 style={{ margin: 0, fontSize: 19 }}>{apparaat.name}</h1>
            <p className="onder" style={{ margin: 0 }}>
              {stap === 'wachtwoord'
                ? 'Het wachtwoord waarmee deze kassa is ingericht'
                : 'Kies je persoonlijke code'}
            </p>
          </div>
        </div>

        {!magKassa && (
          <div style={{ marginBottom: 14 }}>
            <Fout>
              Dit account heeft het recht "Kassa gebruiken" niet, dus er kan niet
              mee afgerekend worden. Geef het in het dashboard onder Personeel →
              Rechten.
            </Fout>
          </div>
        )}

        {stap === 'wachtwoord' ? (
          <form onSubmit={controleer} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Veld
              label="Wachtwoord"
              hint="Hetzelfde wachtwoord als in de wasstraat-app. Dit werkt ook zonder internet."
            >
              <input
                type="password"
                autoComplete="current-password"
                value={wachtwoord}
                onChange={(e) => { setWachtwoord(e.target.value); setFout(null) }}
                autoFocus
                required
              />
            </Veld>

            {fout && <Fout>{fout}</Fout>}

            <Knop soort="hoofd" breed type="submit" disabled={bezig || !magKassa}>
              {bezig ? 'Bezig…' : 'Verder'}
            </Knop>
          </form>
        ) : (
          <form
            onSubmit={(e) => { e.preventDefault(); void zetEnGaVerder() }}
            style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
          >
            <Uitleg>
              {alCode
                ? 'Kies een nieuwe code. De oude vervalt daarmee; hij was niet ' +
                  'te lezen, ook niet door de app.'
                : 'Kies zes cijfers waarmee je je vanaf nu aanmeldt.'}
              {' '}Niet zes dezelfde en geen rijtje op of af — dat is wat iedereen
              als eerste probeert.
            </Uitleg>

            <div style={{ margin: '8px 0' }}>
              <CodeVakjes waarde={nieuweCode} lengte={CODE_LENGTE} />
            </div>

            {fout && <Fout>{fout}</Fout>}

            <div style={{ display: 'grid', placeItems: 'center' }}>
              <Toetsenblok
                waarde={nieuweCode}
                onWaarde={(v) => { setNieuweCode(v); setFout(null) }}
                maxLengte={CODE_LENGTE}
                onKlaar={() => void zetEnGaVerder()}
                klaarTekst="Zet"
                klaarUit={nieuweCode.length !== CODE_LENGTE || bezig}
              />
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
