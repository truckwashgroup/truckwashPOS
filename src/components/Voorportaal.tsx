import type { ReactNode } from 'react'
import logo from '../assets/kassa-icoon.png'
import { ThemaKnop } from './ui'
import { useUpdates } from '../lib/updates'

/* ------------------------------------------------------------------ *
 *  Het voorportaal
 *
 *  De schermen die je ziet vóórdat de kassa openstaat: inrichten, aanmelden,
 *  en de klok voor wie alleen komt in- of uitklokken.
 *
 *  Waarom hier een eigen indeling voor is: dit waren losse kaartjes van 520
 *  pixels in het midden van een venster van veertienhonderd. Dat is niet fout,
 *  maar het ziet eruit als iets wat nog niet af is -- en dit is precies het
 *  scherm dat een chauffeur over de balie heen ziet.
 *
 *  Nu is het één vlak dat het scherm gebruikt: links het merk, rechts waar je
 *  iets doet. Wordt het venster smal -- een tablet in staande stand -- dan valt
 *  de linkerkant weg en blijft alleen het werk over. Dat is de goede kant om te
 *  laten vallen.
 * ------------------------------------------------------------------ */

export default function Voorportaal({
  children,
  /**
   * Voor inhoud die niet in een kolom van 420 past, zoals de lijst met kassa's.
   * Dan wordt het merk een smalle balk bovenaan in plaats van een halve pagina.
   */
  breed,
  /** Wat er onder het merk staat. Eén regel, geen verhaal. */
  ondertitel = 'Kassa',
}: {
  children: ReactNode
  breed?: boolean
  ondertitel?: string
}) {
  const { version } = useUpdates()

  if (breed) {
    return (
      <div className="voorportaal breed">
        <ThemaKnop />
        <header>
          <img src={logo} alt="" />
          <div>
            <strong>Truckwash1</strong>
            <span>{ondertitel}</span>
          </div>
        </header>
        <div className="werk">
          <div className="inhoud">{children}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="voorportaal">
      <ThemaKnop />

      <div className="merk">
        <div className="merkinhoud">
          <img src={logo} alt="" />
          <h1>
            Truckwash1
            <span>{ondertitel}</span>
          </h1>
          <p>
            Afrekenen en klokken op één plek. Werkt door als het internet
            eruit ligt — wat er dan afgerekend wordt, gaat later alsnog de deur
            uit.
          </p>
        </div>
        <div className="voet">versie {version}</div>
      </div>

      <div className="werk">
        <div className="inhoud">{children}</div>
      </div>
    </div>
  )
}
