import { useEffect, useState } from 'react'
import { CloudOff, Lock, RefreshCw, Trash2 } from 'lucide-react'
import { Knop, Uitleg } from './ui'
import { ThemaKnop } from './ui'
import { apparaatWissen, intrekkingStand } from '../lib/koppelen'
import { useSync } from '../lib/sync'
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
 * ------------------------------------------------------------------ */

export default function OpSlot({ apparaat }: { apparaat: PosDevice }) {
  const { pending, syncing, online, lastError, sync } = useSync()
  const [bezig, setBezig] = useState(false)
  const [fout, setFout] = useState<string | null>(null)

  const ingetrokken = apparaat.status === 'ingetrokken'

  /*
   * Bij een intrekking wist de kassa zichzelf zodra de wachtrij leeg is,
   * zonder dat iemand erop hoeft te drukken. Dat is de bedoeling van "op
   * afstand eruit gooien": het kantoor doet iets, en op de kassa gebeurt het.
   * De knop eronder is er voor het geval iemand niet wil wachten.
   */
  useEffect(() => {
    if (!ingetrokken) return
    let gestopt = false

    const kijk = async () => {
      const { klaar } = await intrekkingStand()
      if (gestopt || !klaar) return
      const uitslag = await apparaatWissen()
      if (!uitslag.ok && !gestopt) setFout(uitslag.reden ?? null)
    }

    void kijk()
    const tik = setInterval(kijk, 5000)
    return () => { gestopt = true; clearInterval(tik) }
  }, [ingetrokken])

  async function wisNu() {
    setBezig(true)
    setFout(null)
    const uitslag = await apparaatWissen()
    if (!uitslag.ok) setFout(uitslag.reden ?? 'Wissen lukte niet.')
    setBezig(false)
  }

  return (
    <div className="opslot">
      <ThemaKnop />

      <div className="opslot-icoon">
        {ingetrokken ? <Trash2 size={34} /> : <Lock size={34} />}
      </div>

      <h2>
        {ingetrokken
          ? 'Deze kassa is eruit gehaald'
          : 'Deze kassa staat op slot'}
      </h2>

      <p>
        {ingetrokken
          ? 'Het kantoor heeft dit apparaat ingetrokken. De kassa stuurt eerst ' +
            'alles wat nog in de wachtrij staat naar de administratie en wist ' +
            'zich daarna zelf. Daarna is er een nieuwe koppelcode nodig.'
          : 'Het kantoor heeft dit apparaat geblokkeerd. Er kan niet mee verkocht ' +
            'worden, maar de kassa blijft zijn wachtrij versturen — wat er nog ' +
            'op stond komt dus alsnog binnen. Laat het kantoor hem weer aanzetten.'}
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
        <span className="pil">
          {online ? <RefreshCw size={13} /> : <CloudOff size={13} />}
          {pending > 0 ? `${pending} wacht nog` : 'wachtrij leeg'}
        </span>
        <Knop maat="klein" onClick={() => void sync()} disabled={syncing}>
          <RefreshCw size={15} /> {syncing ? 'Bezig…' : 'Nu versturen'}
        </Knop>
      </div>

      {lastError && (
        <div style={{ maxWidth: 480 }}>
          <Uitleg>De laatste poging lukte niet: {lastError}</Uitleg>
        </div>
      )}

      {ingetrokken && (
        <>
          {pending > 0 ? (
            <div style={{ maxWidth: 480 }}>
              <Uitleg>
                Zodra de wachtrij leeg is, wist de kassa zichzelf. Blijft dat
                hangen omdat er geen verbinding is, zet de kassa dan aan een
                netwerk waar hij bij de administratie kan — er staat omzet op
                die nergens anders bestaat.
              </Uitleg>
            </div>
          ) : (
            <Knop soort="gevaar" onClick={() => void wisNu()} disabled={bezig}>
              <Trash2 size={16} /> {bezig ? 'Bezig…' : 'Nu wissen'}
            </Knop>
          )}
        </>
      )}

      {fout && (
        <div style={{ maxWidth: 480 }}>
          <Uitleg>{fout}</Uitleg>
        </div>
      )}
    </div>
  )
}
