import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { CloudOff, Lock, RefreshCw, Trash2 } from 'lucide-react'
import { Knop, Uitleg } from './ui'
import { huidigeRegister } from '../lib/kassa'
import { intrekkingStand } from '../lib/koppelen'
import { useSync } from '../lib/sync'
import { useAuth } from '../store/useAuth'
import type { PosDevice } from '../lib/types'

/* ------------------------------------------------------------------ *
 *  Op slot gezet vanaf het dashboard
 *
 *  Twee standen, en het verschil ertussen is de kern van de hele opzet.
 *
 *  Geblokkeerd  De kassa gaat op slot maar blijft synchroniseren. Precies wat
 *               je wil als een tablet kwijt is terwijl de omzet van vandaag er
 *               nog op staat: niemand kan er meer mee verkopen, en de bonnen
 *               die erop stonden komen alsnog binnen.
 *
 *  Ingetrokken  Het apparaat gaat eruit. Maar niet meteen: eerst moet de
 *               wachtrij leeg. Een kassa die zich wist met een bon in de
 *               wachtrij gooit omzet weg, en die staat dan nergens meer --
 *               niet in de kassa en niet in de administratie.
 *
 *  Daarom is wissen hier geen knop die het gewoon doet, maar een knop die
 *  wacht tot de wachtrij leeg is en dat ook laat zien. Zolang er iets in staat
 *  blijft de kassa proberen te versturen.
 *
 *  Waarom dit schreeuwt
 *  --------------------
 *
 *  Dit was een net kaartje in de huisstijl: een slotje van 34 pixels, een kop
 *  van 24, en een alinea uitleg in grijs. Gemeld met: "als ik een kassa
 *  blokkeer, dan moet je aan de kassa dit ook echt zien."
 *
 *  Dat is terecht, want de aanleiding om te blokkeren is nooit iets kleins --
 *  een tablet die kwijt is, een kassa waar iets mee aan de hand is. Wie er dan
 *  voor staat moet in één oogopslag begrijpen dat dit geen storing is maar een
 *  besluit, en dat er niets aan te doen valt zonder het kantoor. Een net
 *  kaartje leest als "er ging iets mis, probeer het opnieuw", en dan gaat
 *  iemand herstarten, opnieuw koppelen, of het apparaat wegzetten.
 *
 *  Dus: bloedrood over het hele scherm, waarschuwingsstrepen, en één woord dat
 *  je van de andere kant van de balie leest. Niet mooi, met opzet.
 *
 *  Wat hier bewust níet gebeurt: geluid. Een kassa die begint te piepen op een
 *  wasstraat waar mensen werken, wordt uitgezet of in een kast gelegd -- en dan
 *  is het apparaat pas echt kwijt, en stopt ook het versturen van wat er nog
 *  op staat.
 * ------------------------------------------------------------------ */

export default function OpSlot({ apparaat }: { apparaat: PosDevice }) {
  const { pending, syncing, online, lastError, sync } = useSync()
  const { ontkoppel } = useAuth()
  const [bezig, setBezig] = useState(false)
  const [fout, setFout] = useState<string | null>(null)

  const ingetrokken = apparaat.status === 'ingetrokken'

  /*
   * Welke kassa dit is, in de woorden van het kantoor.
   *
   * Hier stond apparaat.registerId, en dat is een interne sleutel: op de
   * eerste afdruk stond er "Windows-kassa · reg_demo". Wie dat voorleest aan
   * de telefoon komt niet verder -- in het dashboard heet diezelfde kassa
   * KAS-AAL-1. Vandaar de code en de naam uit de cache, en de id alleen als
   * die er niet zijn.
   */
  const register = useLiveQuery(huidigeRegister, [], undefined)

  /*
   * Bij een intrekking wist de kassa zichzelf zodra de wachtrij leeg is,
   * zonder dat iemand erop hoeft te drukken. Dat is de bedoeling van "op
   * afstand eruit gooien": het kantoor doet iets, en op de kassa gebeurt het.
   * De knop eronder is er voor het geval iemand niet wil wachten.
   *
   * Dit loopt sinds deze versie via ontkoppel() van de store en niet meer via
   * wisApparaat(). Dat laatste maakte alleen de gegevens leeg; de sessie bij
   * Supabase, de bewaarde inlog en de synchronisatie bleven staan. Een apparaat
   * dat eruit gegooid was hield dus een geldige inlog op het account van die
   * kassa -- en dat is precies wat "eruit gooien" niet mag betekenen.
   */
  useEffect(() => {
    if (!ingetrokken) return
    let gestopt = false

    const kijk = async () => {
      const { klaar } = await intrekkingStand()
      if (gestopt || !klaar) return
      const uitslag = await ontkoppel({ melden: true })
      if (!uitslag.ok && !gestopt) setFout(uitslag.reden ?? null)
    }

    void kijk()
    const tik = setInterval(kijk, 5000)
    return () => { gestopt = true; clearInterval(tik) }
  }, [ingetrokken])

  async function wisNu() {
    setBezig(true)
    setFout(null)
    const uitslag = await ontkoppel({ melden: true })
    if (!uitslag.ok) setFout(uitslag.reden ?? 'Wissen lukte niet.')
    setBezig(false)
  }

  return (
    <div className={`opslot ${ingetrokken ? 'eruit' : 'dicht'}`}>
      {/*
        Geen themaknop hier. Dit scherm is geen plek waar je iets instelt, en
        een knop die wél werkt terwijl de rest op slot staat, nodigt uit tot
        zoeken naar meer knoppen die werken.
      */}
      <div className="strepen" aria-hidden />

      <div className="kern">
        <div className="opslot-icoon">
          {ingetrokken ? <Trash2 size={40} /> : <Lock size={40} />}
        </div>

        <h1>{ingetrokken ? 'Eruit gehaald' : 'Geblokkeerd'}</h1>

        {/*
          Wélke kassa. Op een vestiging met drie kassa's is "deze kassa" niet
          genoeg om het kantoor te kunnen bellen.
        */}
        <p className="waar">
          {register
            ? `${register.code} · ${register.name}`
            : apparaat.name || 'Deze kassa'}
        </p>

        <p className="wat">
          {ingetrokken
            ? 'Het kantoor heeft dit apparaat ingetrokken. De kassa stuurt eerst ' +
              'alles wat nog in de wachtrij staat naar de administratie, logt zich ' +
              'daarna volledig uit en wist zich. Daarna is er een nieuwe ' +
              'koppelcode nodig.'
            : 'Het kantoor heeft deze kassa op slot gezet. Er kan niet mee ' +
              'verkocht en niet mee geklokt worden.'}
        </p>

        {!ingetrokken && (
          <p className="wat rustig">
            Dit is geen storing en er valt hier niets te herstellen —
            herstarten of opnieuw koppelen helpt niet. Bel het kantoor; alleen
            daar kan hij weer aangezet worden. Wat er nog op stond wordt
            intussen wel verstuurd, dus die omzet is niet weg.
          </p>
        )}

        <div className="stand">
          <span className="pil">
            {online ? <RefreshCw size={13} /> : <CloudOff size={13} />}
            {pending > 0 ? `${pending} wacht nog` : 'wachtrij leeg'}
          </span>
          <Knop maat="klein" onClick={() => void sync()} disabled={syncing}>
            <RefreshCw size={15} /> {syncing ? 'Bezig…' : 'Nu versturen'}
          </Knop>
        </div>

        {lastError && (
          <div style={{ maxWidth: 520 }}>
            <Uitleg>De laatste poging lukte niet: {lastError}</Uitleg>
          </div>
        )}

        {ingetrokken && (
          pending > 0 ? (
            <div style={{ maxWidth: 520 }}>
              <Uitleg>
                Zodra de wachtrij leeg is, wist de kassa zichzelf. Blijft dat
                hangen omdat er geen verbinding is, zet de kassa dan aan een
                netwerk waar hij bij de administratie kan — er staat omzet op
                die nergens anders bestaat.
              </Uitleg>
            </div>
          ) : (
            <Knop soort="gevaar" onClick={() => void wisNu()} disabled={bezig}>
              <Trash2 size={16} /> {bezig ? 'Bezig…' : 'Nu wissen en uitloggen'}
            </Knop>
          )
        )}

        {fout && (
          <div style={{ maxWidth: 520 }}>
            <Uitleg>{fout}</Uitleg>
          </div>
        )}
      </div>

      <div className="strepen" aria-hidden />
    </div>
  )
}
