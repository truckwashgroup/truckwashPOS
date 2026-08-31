/**
 * De betaalterminal.
 *
 * Een pinautomaat aansturen betekent: een bedrag naar het apparaat sturen, de
 * chauffeur laten pinnen, en wachten op ja of nee. Elke provider doet dat
 * anders, en voor alle drie de gangbare (CCV, Adyen, SumUp) geldt hetzelfde:
 * je hebt een contract en gegevens van die provider nodig voordat er ook maar
 * één cent over de lijn kan.
 *
 * Zolang die gegevens er niet zijn, is er precies één eerlijke manier van
 * werken, en dat is ook hoe de meeste kleine kassa's het doen:
 *
 *   handmatig  De kassa laat het bedrag zien. Iemand toetst het op de
 *              pinautomaat in, de chauffeur pint, en aan de kassa wordt
 *              bevestigd dat het gelukt is. Het bonnummer van de
 *              pinautomaat kan erbij.
 *
 * Dat is geen noodgreep: het werkt, het is controleerbaar, en de kassa weet
 * altijd wat er betaald is. Wat het niet doet, is voorkomen dat iemand zich
 * vertikt in het bedrag.
 *
 * ------------------------------------------------------------------------
 * Aansluiten van een echte terminal
 *
 * De drie providers hieronder staan klaar met hun protocol erbij beschreven.
 * Wat er nog voor nodig is:
 *
 *   CCV     Een terminal met de "CCV Pay lokaal"-koppeling aan, plus het
 *           IP-adres van het apparaat. Protocol: JSON over HTTP naar de
 *           terminal zelf (poort 8080), of OPI/Nexo over TCP bij oudere
 *           modellen. CCV levert de documentatie bij het contract.
 *   Adyen   Terminal API, "local terminal API" over HTTPS naar het IP van de
 *           terminal, met een API-sleutel en een POI-id. Werkt ook via de
 *           cloud, maar dan is de kassa afhankelijk van internet -- en dat is
 *           precies wat we hier niet willen.
 *   SumUp   Geen lokale koppeling voor Windows; alleen via hun app op een
 *           telefoon of tablet. Op een Windows-kassa is dat dus altijd
 *           handmatig.
 *
 * De sleutel hoort niet in de gesynchroniseerde instellingen (die reizen mee
 * naar elke kassa) maar in de lokale instellingen van dit apparaat. Vandaar
 * dat hij hier als parameter binnenkomt en nergens wordt bewaard.
 * ------------------------------------------------------------------------
 */

const NIET_INGERICHT = (provider) => ({
  ok: false,
  handmatig: true,
  reden:
    `De koppeling met ${provider} is nog niet ingericht. Er zijn gegevens van ` +
    `${provider} voor nodig (adres van de terminal, terminal-id en een sleutel). ` +
    'Toets het bedrag intussen met de hand op de pinautomaat in en bevestig ' +
    'het hier.',
})

/**
 * Een betaling starten.
 *
 * Geeft altijd een antwoord terug, nooit een uitzondering: een pinautomaat die
 * niet reageert mag de kassa niet vastzetten. Er staat een chauffeur te
 * wachten, en die kan altijd contant betalen.
 */
async function betaal(opdracht) {
  const provider = (opdracht.provider || 'handmatig').toLowerCase()
  const bedrag = Number(opdracht.bedrag || 0)

  if (!(bedrag > 0)) {
    return { ok: false, reden: 'Er is geen bedrag om te pinnen.' }
  }

  switch (provider) {
    case 'handmatig':
      // De kassa handelt dit zelf af: bedrag laten zien, iemand bevestigt.
      return { ok: true, handmatig: true }

    case 'ccv':
      // Hier komt de POST naar http://<host>:8080/pos met het bedrag in
      // centen, en daarna het pollen op de status tot 'success' of 'failure'.
      return NIET_INGERICHT('CCV')

    case 'adyen':
      // Hier komt het Terminal-API-verzoek (PaymentRequest) naar
      // https://<host>/nexo, ondertekend met de API-sleutel.
      return NIET_INGERICHT('Adyen')

    case 'sumup':
      return {
        ok: false,
        handmatig: true,
        reden:
          'SumUp heeft geen koppeling voor een Windows-kassa. Reken af in de ' +
          'SumUp-app en bevestig het bedrag hier.',
      }

    default:
      return { ok: false, reden: `Onbekende betaalprovider: ${provider}` }
  }
}

/** Een lopende betaling afbreken. */
async function afbreken(opdracht) {
  const provider = (opdracht.provider || 'handmatig').toLowerCase()
  if (provider === 'handmatig' || provider === 'sumup') return { ok: true }
  return NIET_INGERICHT(provider.toUpperCase())
}

module.exports = { betaal, afbreken }
