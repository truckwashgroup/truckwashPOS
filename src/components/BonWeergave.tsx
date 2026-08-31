import { bonAlsTekst } from '../lib/hardware/printer'
import type { BonGegevens } from '../lib/bon'

/**
 * De bon op het scherm.
 *
 * Letterlijk dezelfde opmaak als die uit de printer komt -- dezelfde
 * opdrachten, dezelfde breedte, dezelfde centen. Dat is de bedoeling: wat de
 * chauffeur meeleest en wat hij meekrijgt hoort hetzelfde te zijn. Bovendien
 * kun je zo bij een storing de bon voorlezen of laten fotograferen.
 */
export default function BonWeergave({
  gegevens, breedte = 42,
}: { gegevens: BonGegevens; breedte?: number }) {
  return <pre className="bonpapier">{bonAlsTekst(gegevens, breedte)}</pre>
}
