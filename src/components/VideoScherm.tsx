import { useEffect, useRef, useState } from 'react'
import { opVideoOpdracht, type VideoOpdracht } from '../lib/hardware/speler'

/* ------------------------------------------------------------------ *
 *  Het tweede scherm
 *
 *  Dit is wat er in de wachtruimte hangt: een zwart vlak met de video erop,
 *  en niets anders. Geen balk, geen knoppen, geen kassa -- die staat aan de
 *  andere kant van de balie en bedient dit op afstand.
 *
 *  Het is dezelfde app-bundel, met een vlag in het adres (?scherm=video).
 *  Twee bundels onderhouden voor één venster is werk dat niets oplevert.
 * ------------------------------------------------------------------ */

export default function VideoScherm() {
  const video = useRef<HTMLVideoElement>(null)
  const [naam, setNaam] = useState<string | null>(null)
  const [fout, setFout] = useState<string | null>(null)

  useEffect(() => {
    const stop = opVideoOpdracht((o: VideoOpdracht) => {
      const el = video.current
      if (!el) return

      if (o.soort === 'spelen' && o.adres) {
        setFout(null)
        setNaam(o.naam ?? null)
        if (el.src !== o.adres) el.src = o.adres
        el.muted = o.gedempt ?? true
        void el.play().catch(() => {
          setFout('Deze video kon niet gespeeld worden.')
        })
        return
      }

      if (o.soort === 'pauze') {
        if (el.paused) void el.play().catch(() => {})
        else el.pause()
        return
      }

      if (o.soort === 'dempen') {
        el.muted = o.gedempt ?? true
      }
    })

    return stop
  }, [])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#000',
        display: 'grid',
        placeItems: 'center',
        overflow: 'hidden',
      }}
    >
      <video
        ref={video}
        style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
        playsInline
        /*
         * Als de video klaar is, gaat hij naar de volgende. Dat besluit valt
         * aan de kassakant, want daar staat de lijst -- dus melden we alleen
         * dat deze klaar is. De kassa stuurt dan het volgende adres.
         */
        onEnded={() => {
          window.desktop?.spelerVideoKlaar?.()
        }}
      />

      {/*
        Zolang er niets speelt: een rustig vlak in plaats van zwart. Een zwart
        scherm in een wachtruimte ziet uit als een kapot scherm.
      */}
      {!naam && !fout && (
        <div
          style={{
            position: 'absolute',
            color: '#3a4560',
            fontSize: 18,
          }}
        >
          Klaar voor beeld
        </div>
      )}

      {fout && (
        <div style={{ position: 'absolute', color: '#f4685f', fontSize: 18 }}>{fout}</div>
      )}
    </div>
  )
}
