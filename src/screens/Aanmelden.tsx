import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowLeft, KeyRound, ScanLine } from 'lucide-react'
import Toetsenblok from '../components/Toetsenblok'
import { Fout, Knop, Uitleg, Veld, Waarschuwing } from '../components/ui'
import { normaliseerNummer, nummerProbleem, nummersNakijken } from '../lib/code'
import { useScanner } from '../lib/hardware/scanner'
import { verifyOfflineLogin } from '../lib/offlineAuth'
import { can } from '../lib/permissions'
import { useAuth } from '../store/useAuth'
import { toast } from '../store/useToasts'
import type { User } from '../lib/types'

/* ------------------------------------------------------------------ *
 *  Wie staat er achter de kassa?
 *
 *  Je personeelsnummer intoetsen, en je bent binnen. Eén handeling, en het
 *  nummer staat al in het dossier -- niets extra's om uit te delen of kwijt te
 *  raken. Wie een badge heeft, scant die.
 *
 *  Wat hier met opzet níét staat: een lijst met namen en nummers. Die stond er
 *  eerst, om een naam te kiezen vóór de code. Nu het nummer zélf de code is,
 *  zou zo'n lijst iedereens inlog op het scherm zetten.
 *
 *  De weg terug voor wie vastloopt -- geen nummer in het dossier, of twee
 *  mensen met hetzelfde nummer -- is het wachtwoord waarmee de kassa is
 *  ingericht. Dat is het sterkere slot van de twee en het werkt ook offline.
 * ------------------------------------------------------------------ */

export default function Aanmelden() {
  const { apparaat, meldAan, meldAanMetBadge } = useAuth()
  const [nummer, setNummer] = useState('')
  const [metWachtwoord, setMetWachtwoord] = useState(false)
  const [fout, setFout] = useState<string | null>(null)
  const [bezig, setBezig] = useState(false)

  const controle = useLiveQuery(
    () => nummersNakijken(apparaat?.locationId),
    [apparaat?.locationId],
    { zonderNummer: [] as User[], dubbel: [] as { nummer: string; namen: string[] }[] },
  )

  /* ---- badge scannen ---- */
  useScanner(async (gescand) => {
    if (!gescand.startsWith('TWB-')) return
    setBezig(true)
    const uitslag = await meldAanMetBadge(gescand)
    setBezig(false)
    if (!uitslag.ok) setFout(uitslag.fout ?? 'Deze badge werkt niet.')
  }, !metWachtwoord)

  async function probeer() {
    const probleem = nummerProbleem(nummer)
    if (probleem) { setFout(probleem); return }

    setBezig(true)
    const uitslag = await meldAan(nummer)
    setBezig(false)

    if (uitslag.ok) {
      setNummer('')
      setFout(null)
    } else {
      setFout(uitslag.fout ?? 'Dat nummer is niet bekend.')
      setNummer('')
    }
  }

  if (metWachtwoord && apparaat) {
    return (
      <MetWachtwoord
        apparaat={apparaat}
        onTerug={() => { setMetWachtwoord(false); setFout(null) }}
      />
    )
  }

  const schoon = normaliseerNummer(nummer)

  return (
    <div className="midden">
      <div className="doos">
        <h1>Personeelsnummer</h1>
        <p className="onder">
          Toets je personeelsnummer en druk op OK. Heb je een badge, scan hem
          dan — dat is sneller.
        </p>

        <div style={{ margin: '20px 0', textAlign: 'center' }}>
          <div
            className="cijfers"
            style={{
              fontSize: 40, fontWeight: 800, letterSpacing: 4, minHeight: 52,
              color: schoon ? 'var(--text)' : 'var(--text-3)',
            }}
          >
            {/*
              Het nummer staat open in beeld en niet als stipjes. Het is geen
              geheim -- het staat op elk rooster -- en aan een balie is zien
              wat je hebt ingetoetst belangrijker dan het verbergen van iets
              wat toch al bekend is.
            */}
            {schoon || '––––'}
          </div>
        </div>

        {fout && <div style={{ marginBottom: 14 }}><Fout>{fout}</Fout></div>}

        {/*
          Twee dingen maken aanmelden onmogelijk, en ze zijn hier te zien
          voordat iemand ermee vastloopt.
        */}
        {controle.dubbel.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <Waarschuwing>
              {controle.dubbel.length === 1
                ? `Nummer ${controle.dubbel[0].nummer} staat bij meer dan één medewerker (${controle.dubbel[0].namen.join(', ')}).`
                : `${controle.dubbel.length} nummers staan bij meer dan één medewerker.`}
              {' '}Zolang dat zo is, kan met dat nummer niemand aanmelden — de bon
              zou op de verkeerde naam komen. Rechtzetten gebeurt in het
              dashboard, onder Personeel.
            </Waarschuwing>
          </div>
        )}

        <div style={{ display: 'grid', placeItems: 'center' }}>
          <Toetsenblok
            waarde={nummer}
            onWaarde={(v) => { setNummer(v); setFout(null) }}
            maxLengte={24}
            onKlaar={() => void probeer()}
            klaarTekst="OK"
            klaarUit={!schoon || bezig}
          />
        </div>

        <div
          style={{
            marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--line)',
            display: 'flex', flexDirection: 'column', gap: 10,
          }}
        >
          <Knop maat="klein" onClick={() => setMetWachtwoord(true)}>
            <KeyRound size={16} /> Aanmelden met het wachtwoord van dit apparaat
          </Knop>
          <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
            <ScanLine size={14} style={{ verticalAlign: -2, marginRight: 5 }} />
            Badge scannen kan altijd, ook vanaf dit scherm.
          </span>
          {controle.zonderNummer.length > 0 && (
            <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
              {controle.zonderNummer.length === 1
                ? 'Eén medewerker heeft nog geen personeelsnummer'
                : `${controle.zonderNummer.length} medewerkers hebben nog geen personeelsnummer`}
              {' '}en kan zich dus niet aanmelden. Dat staat in het dashboard onder
              Personeel.
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  Aanmelden met het wachtwoord van het apparaataccount
 *
 *  De weg naar binnen als er met het nummer niets te beginnen valt. Je komt
 *  binnen als het account waarmee de kassa is ingericht -- niet op de naam van
 *  een collega, want dan was de naam op de bon niets meer waard.
 * ------------------------------------------------------------------ */

function MetWachtwoord({
  apparaat, onTerug,
}: { apparaat: User; onTerug: () => void }) {
  const { meldAan } = useAuth()
  const [wachtwoord, setWachtwoord] = useState('')
  const [fout, setFout] = useState<string | null>(null)
  const [bezig, setBezig] = useState(false)

  const magKassa = can(apparaat, 'pos.use')
  const eigenNummer = (apparaat.personnelNumber ?? '').trim()

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

      if (!eigenNummer) {
        setFout(
          'Het wachtwoord klopt, maar dit account heeft zelf geen ' +
          'personeelsnummer. Zet er een in het dashboard onder Personeel; ' +
          'zonder nummer kan de kassa niet vastleggen wie er verkocht.',
        )
        return
      }

      const uitslag = await meldAan(eigenNummer)
      if (!uitslag.ok) {
        setFout(uitslag.fout ?? 'Aanmelden lukte niet.')
        return
      }
      toast.ok(`Welkom, ${apparaat.name.split(' ')[0]}.`)
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
              Het wachtwoord waarmee deze kassa is ingericht
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
            {bezig ? 'Bezig…' : 'Aanmelden'}
          </Knop>
        </form>

        {eigenNummer && (
          <div style={{ marginTop: 16 }}>
            <Uitleg>
              Voor de volgende keer: jouw personeelsnummer is genoeg om binnen te
              komen. Deze omweg is er voor als dat niet werkt.
            </Uitleg>
          </div>
        )}
      </div>
    </div>
  )
}
