import { useState } from 'react'
import {
  FolderOpen, Monitor, MonitorOff, Music2, Pause, Play, Radio as RadioIcoon,
  RefreshCw, Shuffle, SkipBack, SkipForward, Trash2, Volume2, VolumeX,
} from 'lucide-react'
import { Fout, Knop, Leeg, Pil, Uitleg, Veld } from '../components/ui'
import { kanSpelen } from '../lib/hardware/speler'
import { useSpeler, type Radio } from '../store/useSpeler'

/* ------------------------------------------------------------------ *
 *  De speler
 *
 *  Hier is de kássa de bron: hij speelt zelf, en waar het geluid uitkomt
 *  bepaalt Windows. Dat is waarom een bluetooth-box hier werkt en bij het
 *  bijsturen van een ander apparaat niet -- er valt niets te besturen als je
 *  zelf de speler bent.
 *
 *  Het geluidselement staat in de store en niet in dit component, zodat de
 *  muziek doorspeelt als iemand naar het kassascherm gaat. Dat is de hele dag
 *  door, dus dat is geen detail.
 * ------------------------------------------------------------------ */

export default function Speler() {
  const s = useSpeler()
  const [blad, setBlad] = useState<'muziek' | 'radio' | 'video'>('muziek')

  if (!kanSpelen()) {
    return (
      <div className="paneel">
        <div className="kaart" style={{ maxWidth: 620 }}>
          <h3>Speler</h3>
          <Uitleg>
            Zelf muziek of video afspelen werkt alleen op de Windows-kassa. Een
            tablet mag geen mappen doorzoeken en geen venster op een tweede
            scherm openen.
          </Uitleg>
        </div>
      </div>
    )
  }

  return (
    <div className="paneel">
      <div style={{ maxWidth: 780, display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Wat er nu speelt, altijd bovenaan en altijd in beeld. */}
        <NuSpeelt />

        <div className="tabs">
          <button
            type="button"
            className={`tab ${blad === 'muziek' ? 'aan' : ''}`}
            onClick={() => setBlad('muziek')}
          >
            <Music2 size={16} /> Muziek ({s.nummers.length})
          </button>
          <button
            type="button"
            className={`tab ${blad === 'radio' ? 'aan' : ''}`}
            onClick={() => setBlad('radio')}
          >
            <RadioIcoon size={16} /> Radio
          </button>
          <button
            type="button"
            className={`tab ${blad === 'video' ? 'aan' : ''}`}
            onClick={() => setBlad('video')}
          >
            <Monitor size={16} /> Video ({s.videos.length})
          </button>
        </div>

        {blad === 'muziek' && <Muziekmap />}
        {blad === 'radio' && <Radiostations />}
        {blad === 'video' && <Videoscherm />}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  Wat er nu speelt
 * ------------------------------------------------------------------ */

function NuSpeelt() {
  const s = useSpeler()
  const nummer = s.bron === 'radio' ? s.radio : s.nummers[s.index]
  const titel = s.bron === 'radio' ? s.radio?.naam : s.nummers[s.index]?.naam

  return (
    <div className="kaart">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {s.bron === 'radio' ? <RadioIcoon size={20} /> : <Music2 size={20} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 18, fontWeight: 700, overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {titel || (s.bron === 'radio' ? 'Geen station gekozen' : 'Niets gekozen')}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
            {s.bron === 'radio'
              ? 'Radiostream — stopt als de verbinding wegvalt'
              : s.nummers.length
                ? `${s.index + 1} van ${s.nummers.length}${
                    s.nummers[s.index]?.map ? ` · ${s.nummers[s.index].map}` : ''}`
                : 'Kies een map met muziek'}
          </div>
        </div>
        {s.speelt && <Pil soort="ok">speelt</Pil>}
      </div>

      {s.fout && <div style={{ marginTop: 14 }}><Fout>{s.fout}</Fout></div>}

      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <Knop
          maat="groot"
          onClick={() => s.vorige()}
          disabled={s.bron === 'radio' || !s.nummers.length}
          style={{ flex: 1 }}
        >
          <SkipBack size={22} />
        </Knop>
        <Knop
          soort="hoofd"
          maat="groot"
          onClick={() => s.wissel()}
          disabled={!nummer && !s.nummers.length}
          style={{ flex: 2 }}
        >
          {s.speelt ? <Pause size={24} /> : <Play size={24} />}
          {s.speelt ? 'Pauze' : 'Spelen'}
        </Knop>
        <Knop
          maat="groot"
          onClick={() => s.volgende()}
          disabled={s.bron === 'radio' || !s.nummers.length}
          style={{ flex: 1 }}
        >
          <SkipForward size={22} />
        </Knop>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
        <Knop
          maat="klein"
          soort={s.volume === 0 ? 'gevaar' : 'gewoon'}
          onClick={() => s.zetVolume(s.volume === 0 ? 0.6 : 0)}
        >
          {s.volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}
        </Knop>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(s.volume * 100)}
          onChange={(e) => s.zetVolume(Number(e.target.value) / 100)}
          style={{ flex: 1, height: 40, accentColor: 'var(--brand)' }}
        />
        <span className="bedrag" style={{ width: 54, textAlign: 'right', fontWeight: 700 }}>
          {Math.round(s.volume * 100)}%
        </span>
        {s.bron === 'map' && (
          <Knop
            maat="klein"
            soort={s.shuffle ? 'groen' : 'gewoon'}
            onClick={() => s.zetShuffle(!s.shuffle)}
          >
            <Shuffle size={17} /> {s.shuffle ? 'Door elkaar' : 'Op volgorde'}
          </Knop>
        )}
      </div>

      <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--text-3)' }}>
        Het geluid gaat naar de uitgang die in Windows is ingesteld — dus ook
        naar een gekoppelde bluetooth-box. Koppelen doe je één keer in Windows,
        bij Bluetooth-apparaten.
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  Muziek uit een map
 * ------------------------------------------------------------------ */

function Muziekmap() {
  const s = useSpeler()

  return (
    <div className="kaart">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <h3 style={{ flex: 1 }}>Muziek van de kassa</h3>
        <Knop maat="klein" onClick={() => void s.mapKiezen()} disabled={s.bezig}>
          <FolderOpen size={16} /> {s.map ? 'Andere map' : 'Map kiezen'}
        </Knop>
        {s.map && (
          <Knop maat="klein" onClick={() => void s.mapVernieuwen()} disabled={s.bezig}>
            <RefreshCw size={16} />
          </Knop>
        )}
      </div>

      <p className="uitleg">
        {s.map
          ? s.map
          : 'Wijs één keer een map aan; de kassa kijkt daar twee mappen diep. Dit werkt volledig offline.'}
      </p>

      {s.bron === 'radio' && (
        <div style={{ marginBottom: 14 }}>
          <Uitleg>
            De speler staat nu op radio. Tik een nummer aan om naar de map te
            wisselen.
          </Uitleg>
        </div>
      )}

      {!s.nummers.length ? (
        <Leeg
          tekst={s.map
            ? 'Geen bruikbare bestanden gevonden. De kassa speelt mp3, m4a, aac, flac, ogg, opus en wav.'
            : 'Nog geen map gekozen.'}
        />
      ) : (
        <div className="lijst" style={{ maxHeight: 420, overflow: 'auto' }}>
          {s.nummers.map((n, i) => (
            <button
              key={n.pad}
              type="button"
              className="lijstrij"
              onClick={() => { if (s.bron !== 'map') s.zetBron('map'); s.spelen(i) }}
              style={{
                borderColor: i === s.index && s.bron === 'map' ? 'var(--line-brand)' : undefined,
                background: i === s.index && s.bron === 'map' ? 'var(--tint-brand)' : undefined,
              }}
            >
              <div className="rek">
                <div className="titel">{n.naam}</div>
                {n.map && <div className="onder">{n.map}</div>}
              </div>
              {i === s.index && s.bron === 'map' && s.speelt && <Pil soort="ok">speelt</Pil>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  Radio
 * ------------------------------------------------------------------ */

function Radiostations() {
  const s = useSpeler()
  const [naam, setNaam] = useState('')
  const [url, setUrl] = useState('')

  async function voegToe(e: React.FormEvent) {
    e.preventDefault()
    await s.radioToevoegen({ naam, url })
    setNaam('')
    setUrl('')
  }

  return (
    <div className="kaart">
      <h3>Radio</h3>
      <p className="uitleg">
        Een stream heeft internet nodig. Ligt de verbinding eruit, dan stopt de
        muziek — terwijl de rest van de kassa doorwerkt. Muziek uit een map op
        de schijf heeft dat niet.
      </p>

      <div className="lijst">
        {s.radios.map((r: Radio) => (
          <div
            key={r.url}
            className="lijstrij"
            style={{
              cursor: 'default',
              borderColor: s.radio?.url === r.url ? 'var(--line-brand)' : undefined,
              background: s.radio?.url === r.url ? 'var(--tint-brand)' : undefined,
            }}
          >
            <RadioIcoon size={17} />
            <div className="rek">
              <div className="titel">{r.naam}</div>
              <div
                className="onder"
                style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {r.url}
              </div>
            </div>
            <Knop maat="klein" onClick={() => s.radioSpelen(r)}>
              <Play size={15} /> Spelen
            </Knop>
            <Knop
              maat="klein"
              soort="gevaar"
              onClick={() => void s.radioWeghalen(r.url)}
              aria-label="Weghalen"
            >
              <Trash2 size={15} />
            </Knop>
          </div>
        ))}
        {!s.radios.length && <Leeg tekst="Nog geen stations." />}
      </div>

      <form
        onSubmit={voegToe}
        style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <h3 style={{ margin: 0, fontSize: 15 }}>Station toevoegen</h3>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 2fr' }}>
          <Veld label="Naam">
            <input value={naam} onChange={(e) => setNaam(e.target.value)} placeholder="Sky Radio" />
          </Veld>
          <Veld label="Adres van de stream" hint="Een .mp3- of .aac-stream. Een webpagina werkt niet.">
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          </Veld>
        </div>
        <Knop type="submit" maat="klein" disabled={!naam.trim() || !url.trim()}>
          Toevoegen
        </Knop>
      </form>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  Video op een tweede scherm
 * ------------------------------------------------------------------ */

function Videoscherm() {
  const s = useSpeler()
  const tweede = s.schermen.find((sc) => !sc.hoofdscherm)

  return (
    <div className="kaart">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <h3 style={{ flex: 1 }}>Video op een tweede scherm</h3>
        <Knop maat="klein" onClick={() => void s.schermenVernieuwen()}>
          <RefreshCw size={16} />
        </Knop>
      </div>

      <p className="uitleg">
        Video gaat niet over bluetooth — dat bestaat in de praktijk niet. Het
        gaat naar een scherm aan de kassa-pc, in een eigen venster dat volledig
        scherm staat.
      </p>

      {tweede ? (
        <Uitleg>
          Er is een tweede scherm: <strong>{tweede.naam}</strong> ({tweede.breedte}×{tweede.hoogte}).
          Het venster gaat daar volledig scherm open.
        </Uitleg>
      ) : (
        <Uitleg>
          Er is maar één scherm. Het venster opent gewoon in beeld; sleep het
          naar het tweede scherm en zet het daar volledig scherm (F11). Sluit
          een scherm aan en tik op het rondje hierboven om opnieuw te kijken.
        </Uitleg>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
        {s.videoOpen ? (
          <>
            <Knop soort="gevaar" onClick={() => void s.videoSluiten()}>
              <MonitorOff size={18} /> Scherm sluiten
            </Knop>
            <Knop onClick={() => s.videoPauze()}>
              <Pause size={18} /> Pauze
            </Knop>
            <Knop onClick={() => s.videoVolgende()} disabled={!s.videos.length}>
              <SkipForward size={18} /> Volgende
            </Knop>
            <Knop
              soort={s.videoGedempt ? 'gewoon' : 'groen'}
              onClick={() => s.videoDempen(!s.videoGedempt)}
            >
              {s.videoGedempt ? <VolumeX size={18} /> : <Volume2 size={18} />}
              {s.videoGedempt ? 'Zonder geluid' : 'Met geluid'}
            </Knop>
          </>
        ) : (
          <Knop
            soort="hoofd"
            onClick={() => void s.videoOpenen(tweede?.id)}
            disabled={!s.videos.length}
          >
            <Monitor size={18} /> Scherm openen
          </Knop>
        )}
      </div>

      {!s.videoGedempt && s.speelt && (
        <div style={{ marginTop: 14 }}>
          <Uitleg>
            De video heeft geluid en er speelt ook muziek. Die twee komen over
            dezelfde uitgang, dus je hoort ze door elkaar.
          </Uitleg>
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        {!s.videos.length ? (
          <Leeg
            tekst={s.map
              ? 'Geen video in de gekozen map. De kassa speelt mp4, m4v en webm.'
              : 'Kies eerst een map, onder Muziek.'}
          />
        ) : (
          <div className="lijst" style={{ maxHeight: 320, overflow: 'auto' }}>
            {s.videos.map((v, i) => (
              <button
                key={v.pad}
                type="button"
                className="lijstrij"
                onClick={() => s.videoSpelen(i)}
                disabled={!s.videoOpen}
                style={{
                  borderColor: i === s.videoIndex ? 'var(--line-brand)' : undefined,
                  background: i === s.videoIndex ? 'var(--tint-brand)' : undefined,
                }}
              >
                <Monitor size={17} />
                <div className="rek">
                  <div className="titel">{v.naam}</div>
                  {v.map && <div className="onder">{v.map}</div>}
                </div>
                {i === s.videoIndex && s.videoOpen && <Pil soort="ok">in beeld</Pil>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
