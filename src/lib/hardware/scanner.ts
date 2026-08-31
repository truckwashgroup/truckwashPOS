import { useEffect, useRef } from 'react'

/* ------------------------------------------------------------------ *
 *  De barcodescanner
 *
 *  Een scanner meldt zich bij Windows aan als toetsenbord. Hij "typt" de code
 *  en drukt op Enter. Er is dus niets te koppelen -- maar je moet wel
 *  onderscheiden of er getypt of gescand wordt, want anders slaat elke
 *  ingetoetste letter aan als artikel.
 *
 *  Het verschil is de snelheid. Een mens haalt geen dertig tekens per seconde;
 *  een scanner haalt niets anders. Daarom kijken we naar de tijd tussen twee
 *  aanslagen: komt alles binnen dertig milliseconde van elkaar en eindigt het
 *  met Enter, dan was het een scan.
 *
 *  En als er in een invoerveld gewerkt wordt, blijven we ervan af. Iemand die
 *  een kenteken intoetst is geen scanner.
 * ------------------------------------------------------------------ */

const MAX_PAUZE_MS = 30
const MIN_LENGTE = 4

/** Staat de cursor in een veld waar iemand zelf aan het typen is? */
function inEenVeld(doel: EventTarget | null): boolean {
  const el = doel as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/**
 * Luistert naar de scanner zolang het scherm openstaat.
 *
 * `actief` uit zetten is handig bij een dialoog waar niet gescand mag worden --
 * dan blijft de scanner stil in plaats van dat de code ergens anders belandt.
 */
export function useScanner(
  opGescand: (code: string) => void,
  actief = true,
) {
  const buffer = useRef('')
  const laatste = useRef(0)
  const callback = useRef(opGescand)
  callback.current = opGescand

  useEffect(() => {
    if (!actief) return

    function opToets(e: KeyboardEvent) {
      const nu = Date.now()
      const pauze = nu - laatste.current
      laatste.current = nu

      // Te lang stil: dit is een nieuwe reeks, wat er stond was getypt.
      if (pauze > MAX_PAUZE_MS) buffer.current = ''

      if (e.key === 'Enter') {
        const code = buffer.current
        buffer.current = ''
        if (code.length >= MIN_LENGTE) {
          // Een scan in een invoerveld hoort ook aan te slaan -- de kassière
          // die net een kenteken typte en dan scant, verwacht dat het werkt.
          // Alleen de Enter zelf houden we tegen, anders verstuurt hij ook
          // nog het formulier.
          e.preventDefault()
          callback.current(code)
        }
        return
      }

      // Alleen losse tekens; Shift, Ctrl en pijltjes doen niet mee.
      if (e.key.length !== 1) return
      if (e.ctrlKey || e.altKey || e.metaKey) return

      // Wordt er in een veld getypt op menselijke snelheid, dan laten we het
      // veld zijn werk doen en houden we alleen mee wat er staat.
      if (inEenVeld(e.target) && pauze > MAX_PAUZE_MS) {
        buffer.current = e.key
        return
      }

      buffer.current += e.key
    }

    window.addEventListener('keydown', opToets, true)
    return () => window.removeEventListener('keydown', opToets, true)
  }, [actief])
}
