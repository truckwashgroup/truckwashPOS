import { veiligeAfbeelding } from './afbeelding'
import { can } from './permissions'
import type { InventoryItem, PosProduct, User } from './types'

/* ------------------------------------------------------------------ *
 *  Een artikel dat aan de voorraad hangt
 *
 *  Sinds Trucksupply de artikelen beheert, staat de helft van wat de kassa
 *  over een artikel weet niet meer in pos_products maar in inventory_items:
 *  de foto die de leverancier erbij zette, de eenheid, en de stand. De kassa
 *  leest die tabel al -- hij boekt er voorraad op af -- maar liet er niets van
 *  zien.
 *
 *  Wat hier staat is het samenvoegen van die twee, en niets anders. Los gezet
 *  zodat de zelftest erbij kan: het is precies het soort rekenwerk dat stil
 *  fout gaat. Een foto die niet gevonden wordt, geeft een leeg vakje dat er
 *  uitziet als "hier hoort niets" in plaats van "hier hoort iets".
 * ------------------------------------------------------------------ */

/** Wordt dit artikel door de leverancier beheerd? */
export const uitDeVoorraad = (p: Pick<PosProduct, 'inventoryItemId'>): boolean =>
  Boolean(p.inventoryItemId)

/**
 * De foto die bij dit artikel hoort.
 *
 * Eerst de foto op het product zelf: die heeft iemand aan de kassa met opzet
 * gekozen, en dat gaat voor. Staat die er niet, dan die van het
 * voorraadartikel -- zo staat de foto die Trucksupply toevoegde meteen op het
 * kassascherm zonder dat Beheer hem nog eens hoeft te zetten.
 *
 * Beide gaan langs veiligeAfbeelding: het is een data-URI uit de database, en
 * "alleen afbeeldingen" is een regel die je opschrijft in plaats van aanneemt.
 */
export function artikelFoto(
  p: Pick<PosProduct, 'image' | 'inventoryItemId'>,
  voorraad: Map<string, InventoryItem>,
): string | null {
  const eigen = veiligeAfbeelding(p.image)
  if (eigen) return eigen
  if (!p.inventoryItemId) return null
  return veiligeAfbeelding(voorraad.get(p.inventoryItemId)?.image)
}

export interface VoorraadStand {
  stand: number
  minimum: number
  eenheid: string
  /** Onder het minimum: Trucksupply heeft hier al een mail over gehad. */
  onderMinimum: boolean
  /** Helemaal op. Dan is het niet meer te verkopen, en dat hoort te blijken. */
  leeg: boolean
}

/**
 * Wat er van dit artikel op de vestiging ligt.
 *
 * Null als het artikel niet aan de voorraad hangt -- een wasbeurt of een
 * strippenkaart heeft geen stand, en dan hoort er ook geen getal te staan.
 *
 * Waarom dit op het kassascherm staat: de balie hoeft er niets aan te doen
 * (Trucksupply krijgt automatisch bericht als iets onder het minimum zakt),
 * maar wie iets niet kan verkopen hoort te kunnen zien waarom. Zonder dit is
 * een leeg schap een verrassing bij het afrekenen.
 */
export function artikelVoorraad(
  p: Pick<PosProduct, 'inventoryItemId'>,
  voorraad: Map<string, InventoryItem>,
): VoorraadStand | null {
  if (!p.inventoryItemId) return null
  const item = voorraad.get(p.inventoryItemId)
  if (!item) return null

  const stand = Number(item.stock ?? 0)
  const minimum = Number(item.minStock ?? 0)

  return {
    stand,
    minimum,
    eenheid: item.unit || 'stuk',
    onderMinimum: minimum > 0 && stand < minimum,
    leeg: stand <= 0,
  }
}

/**
 * "14 op voorraad", zonder de eenheid.
 *
 * Die eenheid stond er eerst wel, en op de eerste afdruk stond "14 fles op
 * voorraad" -- geen Nederlands, en het liep de tegel uit. Meervoud maken van
 * een eenheid die de leverancier zelf intikt gaat niet: fles/flessen lukt,
 * maar stuk, doos, rol, liter en 5L hebben elk hun eigen regel of geen.
 *
 * En aan de kassa is het getal wat telt. De eenheid staat op de tegel al bij
 * het artikel, en in de tooltip staat het minimum erbij.
 */
export function voorraadTekst(v: VoorraadStand): string {
  if (v.leeg) return 'niet op voorraad'
  return `${v.stand} op voorraad`
}

/**
 * Een lijst voorraadartikelen als kaart op id.
 *
 * Eén keer maken en dan opzoeken, in plaats van per tegel door de lijst
 * lopen. Met twintig artikelen maakt dat niets uit; met tweehonderd op een
 * tablet wel.
 */
export function voorraadKaart(items: InventoryItem[]): Map<string, InventoryItem> {
  return new Map(items.map((i) => [i.id, i]))
}

/* ------------------------------------------------------------------ *
 *  Mag dit apparaat artikelen bewaren?
 *
 *  Dit gaat over het apparaat en niet over wie er achter de kassa staat, en
 *  dat onderscheid is de hele reden dat deze functie bestaat.
 *
 *  De beveiligingsregel op pos_products is mag_kassa_beheren() -- management,
 *  of het losse recht pos.manage. Een gekoppelde kassa heeft een eigen
 *  inlogaccount met de rol employee en één recht: hours.clock. Die mag dus
 *  niets aan artikelen wijzigen.
 *
 *  In de app werd alleen gekeken of degene die er staat pos.manage heeft. Een
 *  manager aan de kassa kon dus een prijs intikken, op Opslaan drukken, en
 *  een bevestiging krijgen -- terwijl de database het weigerde. Sinds versie
 *  0.10.0 blijft die wijziging in de wachtrij staan en komt er een melding
 *  aan de balie, dus stil gaat het niet meer. Maar een scherm dat invoer
 *  aanneemt die de server weigert, hoort die invoer niet aan te nemen.
 *
 *  Dit is dezelfde regel als in de database, toegepast op het account van het
 *  apparaat. Bij een kassa die nog met een medewerkersaccount is ingericht is
 *  dat dat account, en dan werkt het zoals het altijd werkte.
 * ------------------------------------------------------------------ */

export function apparaatMagArtikelen(apparaat: User | null): boolean {
  return can(apparaat, 'pos.manage')
}
