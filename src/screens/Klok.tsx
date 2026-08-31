import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { AlertTriangle, Clock, LogIn, LogOut } from 'lucide-react'
import Toetsenblok from '../components/Toetsenblok'
import { Dialoog, Fout, Knop, Leeg, Pil, Uitleg, Veld } from '../components/ui'
import { duration, time } from '../lib/format'
import { herkenBadge, herkenOpNummer, normaliseerNummer, nummerProbleem } from '../lib/code'
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
 *  Personeelsnummer intoetsen, of je badge scannen. Sta je erop, dan klok je
 *  uit; sta je er niet op, dan klok je in. Eén handeling, geen keuze -- want
 *  wie 's ochtends langsloopt weet zelf welke van de twee het is.
 *
 *  De uren gaan in dezelfde tabel als in de wasstraat-app (time_entries).
 *  Daardoor is er geen "urenlijst van de kassa" die iemand later moet
 *  overtypen: wie hier inklokt staat meteen in het dashboard onder Uren.
 *
 *  Waarom dit in de kassa zit en niet alleen in de app op de telefoon: de
 *  kassa staat er altijd, hij hangt aan de stroom, en iedereen loopt er langs.
 *  Een telefoon met een lege accu is een urenstaat met een gat.
 * ------------------------------------------------------------------ */

export default function Klok() {
  const { apparaat, operator, raakAan } = useAuth()
  const locatie = apparaat?.locationId

  const [nummer, setNummer] = useState('')
  const [fout, setFout] = useState<string | null>(null)
  const [bezig, setBezig] = useState(false)
  const [gedaan, setGedaan] = useState<string | null>(null)
  const [corrigeren, setCorrigeren] = useState<Aanwezig | null>(null)

  const ingeklokt = useLiveQuery(() => aanwezig(locatie), [locatie], [] as Aanwezig[])

  /* ---- badge: scannen klokt in of uit ---- */
  useScanner(async (gescand) => {
    if (!gescand.startsWith('TWB-')) return
    const uitslag = await herkenBadge(gescand)
    if (!uitslag.ok) {
      setFout('Deze badge is niet bekend.')
      return
    }
    await wissel(uitslag.user)
  }, !corrigeren)

  /** In- of uitklokken, wat er ook aan de orde is. */
  async function wissel(user: User) {
    raakAan()
    const open = await openDienst(user.id)

    if (open) {
      const gesloten = await uitklokken(user.id)
      const gewerkt = gesloten && gesloten.end ? gesloten.end - gesloten.start : 0
      const tekst = `${user.name.split(' ')[0]} is uitgeklokt — ${duration(gewerkt)} gewerkt.`
      toast.ok(tekst)
      setGedaan(tekst)
    } else {
      const { alOpen } = await inklokken(user, locatie)
      const tekst = `${user.name.split(' ')[0]} is ingeklokt.`
      if (!alOpen) {
        toast.ok(tekst)
        setGedaan(tekst)
      }
    }

    setNummer('')
    setFout(null)
  }

  async function probeer() {
    const probleem = nummerProbleem(nummer)
    if (probleem) { setFout(probleem); return }

    setBezig(true)
    const uitslag = await herkenOpNummer(nummer)
    setBezig(false)

    if (!uitslag.ok) {
      setFout(
        uitslag.reden === 'geblokkeerd'
          ? `Te vaak misgetoetst. Probeer het over ${
              Math.ceil((uitslag.wachtMs ?? 0) / 1000)} seconden weer.`
          : uitslag.reden === 'inactief'
            ? 'Deze medewerker staat niet meer op de loonlijst.'
            : uitslag.reden === 'dubbel'
              ? `Dit nummer staat bij meer dan één medewerker (${
                  (uitslag.namen ?? []).join(', ')}). Laat het in het dashboard rechtzetten.`
              : 'Dat personeelsnummer is niet bekend op deze vestiging.',
      )
      setNummer('')
      return
    }

    await wissel(uitslag.user)
  }

  const schoon = normaliseerNummer(nummer)

  return (
    <div className="paneel">
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 380px)' }}>
        <div className="kaart">
          <h3>Nu aan het werk</h3>
          <p className="uitleg">
            Wie hier staat, staat ook in het dashboard onder Uren. Er is geen
            tweede urenlijst.
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
          <p className="uitleg">
            Toets je personeelsnummer, of scan je badge. Sta je op de lijst, dan
            klok je uit.
          </p>

          <div style={{ margin: '14px 0', textAlign: 'center' }}>
            <div
              className="cijfers"
              style={{
                fontSize: 34, fontWeight: 800, letterSpacing: 3, minHeight: 44,
                color: schoon ? 'var(--text)' : 'var(--text-3)',
              }}
            >
              {schoon || '––––'}
            </div>
          </div>

          {fout && <div style={{ marginBottom: 12 }}><Fout>{fout}</Fout></div>}

          {!fout && gedaan && (
            <div style={{ marginBottom: 12 }}>
              <Uitleg>{gedaan}</Uitleg>
            </div>
          )}

          <div style={{ display: 'grid', placeItems: 'center' }}>
            <Toetsenblok
              waarde={nummer}
              onWaarde={(v) => { setNummer(v); setFout(null); setGedaan(null) }}
              maxLengte={24}
              onKlaar={() => void probeer()}
              klaarTekst={<LogIn size={18} />}
              klaarUit={!schoon || bezig}
            />
          </div>
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
