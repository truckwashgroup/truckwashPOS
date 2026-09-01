/* ------------------------------------------------------------------ *
 *  Domeinmodel van de kassa
 *
 *  Wat de kassa deelt met de wasstraat-app staat in gedeeldeTypes.ts en wordt
 *  daar letterlijk uit overgenomen. Hier staat wat alleen de kassa kent.
 *
 *  Twee keuzes die de rest verklaren:
 *
 *  1. Prijzen zijn inclusief btw. Dat is wat op het bord staat en wat de
 *     chauffeur betaalt. Het bedrag exclusief rekenen we eruit terug. Doe je
 *     het andersom, dan wijkt de bon een cent van het prijskaartje af en gaat
 *     de discussie daarover.
 *
 *  2. Bedragen zijn hele centen, opgeslagen als getal in euro's met twee
 *     decimalen. Elke berekening gaat via de functies in geld.ts, die na
 *     iedere stap op centen afronden. Optellen van halve centen is precies
 *     hoe een kassa aan het eind van de dag een euro mist.
 * ------------------------------------------------------------------ */

export * from './gedeeldeTypes'

import type { ServiceKind } from './gedeeldeTypes'
/*
 * Alleen als type. munten.ts haalt centen() uit geld.ts, en geld.ts haalt
 * zijn typen hier weg: een gewone import zou een kringetje zijn dat pas bij
 * het bouwen opvalt. Een type verdwijnt bij het compileren, dus die kan wel.
 */
import type { Munten } from './munten'

/* ------------------------------------------------------------------ *
 *  De kassa zelf
 * ------------------------------------------------------------------ */

/** Waar de bon uitkomt. */
export interface PrinterConfig {
  /**
   * 'netwerk'  -- ESC/POS over TCP, meestal poort 9100. Meest betrouwbaar.
   * 'windows'  -- een als Windows-printer gedeelde bonprinter; wij sturen de
   *               ruwe ESC/POS-bytes naar die wachtrij.
   * 'geen'     -- niet afdrukken, alleen op het scherm laten zien.
   */
  kind: 'netwerk' | 'windows' | 'geen'
  host?: string
  port?: number
  /** Naam van de Windows-printer of de share, bijv. 'EPSON TM-T20III' */
  share?: string
  /** Tekens per regel. 58mm-papier is 32, 80mm is 42 of 48. */
  breedte?: number
  /** Lade opendrukken via de printer na een contante betaling. */
  ladeViaPrinter?: boolean
  /** Bon automatisch afdrukken na afrekenen, of alleen op verzoek. */
  automatisch?: boolean
}

/** Naar welke betaalterminal het bedrag gaat. */
export interface TerminalConfig {
  /**
   * 'handmatig' betekent: de kassa laat het bedrag zien, iemand toetst het op
   * de pinautomaat in en bevestigt hier dat het gelukt is. Zonder contract bij
   * een betaalprovider is dat de enige eerlijke optie -- en het is precies wat
   * de meeste kleine kassa's doen.
   */
  provider: 'handmatig' | 'ccv' | 'adyen' | 'sumup'
  /** Adres van de terminal in het netwerk (CCV, Adyen). */
  host?: string
  port?: number
  /** Terminal-id of poi-id zoals de provider die uitgeeft. */
  terminalId?: string
  /**
   * De sleutel hoort NIET hier. Hij staat in de instellingen van dit apparaat
   * (buiten de gesynchroniseerde tabel), zodat hij niet met elke kassa
   * meereist. Dit veld zegt alleen of er een sleutel is ingevuld.
   */
  sleutelIngesteld?: boolean
}

export interface PosRegister {
  id: string
  locationId?: string
  /** Kort en uniek; het bonnummer begint hiermee. Bijv. KAS-UTR-1 */
  code: string
  name: string
  device?: string
  printer: PrinterConfig
  terminal: TerminalConfig
  /** Hoogste bonnummer dat de server van deze kassa gezien heeft. */
  lastSeq: number
  active: boolean
  updatedAt: number
}

/* ------------------------------------------------------------------ *
 *  Wat er te koop is
 * ------------------------------------------------------------------ */

export type ProductKind = 'artikel' | 'wasbeurt' | 'strippenkaart' | 'abonnement' | 'overig'

export const PRODUCT_KIND_LABELS: Record<ProductKind, string> = {
  artikel: 'Artikel',
  wasbeurt: 'Wasbeurt',
  strippenkaart: 'Strippenkaart',
  abonnement: 'Abonnement',
  overig: 'Overig',
}

/** De btw-tarieven die in Nederland gelden. */
export const BTW_TARIEVEN = [21, 9, 0] as const

export interface PosProduct {
  id: string
  /** Leeg = op alle vestigingen te koop. */
  locationId?: string
  code: string
  barcode?: string
  name: string
  groupName: string
  unit: string
  priceIncl: number
  vatPct: number
  kind: ProductKind
  /** Bij een wasbeurt: welk type uit de wasstraat-app. */
  washService?: ServiceKind
  /** Bij een strippenkaart: hoeveel beurten erop komen. */
  credits?: number
  /** Bij een abonnement: hoeveel dagen het geldig is. */
  validDays?: number
  /** Verkoop boekt hier voorraad af. */
  inventoryItemId?: string
  sort: number
  color?: string
  /**
   * Een foto, als data-URI.
   *
   * In de rij en niet achter een URL, want de kassa moet het zonder internet
   * doen -- een foto achter een adres is een grijs vlak zodra de lijn eruit
   * ligt. De kassa verkleint elke foto vóór het opslaan; zie afbeelding.ts voor
   * de grenzen en waarom ze er zijn.
   */
  image?: string
  active: boolean
  updatedAt: number
}

/* ------------------------------------------------------------------ *
 *  De bon
 * ------------------------------------------------------------------ */

export type SaleStatus = 'open' | 'geparkeerd' | 'afgerekend' | 'geannuleerd' | 'gecrediteerd'

export type PayMethod = 'contant' | 'pin' | 'op-rekening' | 'abonnement'

export const PAY_LABELS: Record<PayMethod, string> = {
  contant: 'Contant',
  pin: 'Pin',
  'op-rekening': 'Op rekening',
  abonnement: 'Kaart of abonnement',
}

export interface PosSale {
  id: string
  registerId?: string
  registerCode: string
  locationId?: string
  /** KAS-UTR-1-20260831-0042 */
  receiptNo: string
  seq: number
  status: SaleStatus
  /** Het dossier-id van wie verkocht, niet het inlogaccount van het apparaat. */
  operatorId?: string
  operatorName: string
  customerCompanyId?: string
  customerName?: string
  plate?: string
  /** De koppeling met de wasstraat: deze bon rekent die wasopdracht af. */
  washJobId?: string
  totalIncl: number
  totalExcl: number
  vatTotal: number
  discountIncl: number
  /** Contant wordt op vijf cent afgerond; dit is het verschil. */
  rounding: number
  /** Leeg zolang de bon openstaat; 'gemengd' bij meer dan één betaalwijze. */
  method?: PayMethod | 'gemengd'
  /** Bij een creditbon: welke bon wordt teruggedraaid. */
  creditOf?: string
  cashSessionId?: string
  openedAt: number
  closedAt?: number
  printed: boolean
  note?: string
  updatedAt: number
}

export interface PosSaleLine {
  id: string
  saleId: string
  lineNo: number
  productId?: string
  name: string
  kind: ProductKind
  qty: number
  priceIncl: number
  vatPct: number
  discountPct: number
  totalIncl: number
  totalExcl: number
  vatAmount: number
  washJobId?: string
  note?: string
  updatedAt: number
}

export interface PosPayment {
  id: string
  saleId: string
  method: PayMethod
  amount: number
  /** Contant: wat er in de lade ging en wat eruit terug moest. */
  received?: number
  changeGiven?: number
  /** Pin: wat de betaalterminal terugmeldde. */
  terminalRef?: string
  terminalStatus?: string
  cardBrand?: string
  subscriptionId?: string
  at: number
  updatedAt: number
}

/* ------------------------------------------------------------------ *
 *  De kassadag
 * ------------------------------------------------------------------ */

export interface PosCashSession {
  id: string
  registerId?: string
  registerCode: string
  locationId?: string
  openedBy?: string
  openedByName: string
  openedAt: number
  startFloat: number
  closedBy?: string
  closedByName?: string
  closedAt?: number
  counted?: number
  expected?: number
  difference?: number
  cashTotal: number
  pinTotal: number
  invoiceTotal: number
  salesCount: number
  status: 'open' | 'gesloten'
  note?: string
  updatedAt: number
}

export type CashMoveKind = 'inleg' | 'afstorting' | 'correctie'

export interface PosCashMove {
  id: string
  sessionId: string
  kind: CashMoveKind
  amount: number
  reason: string
  userId?: string
  userName: string
  at: number
  updatedAt: number
}

/* ------------------------------------------------------------------ *
 *  De kluis
 *
 *  Naast de lade staat op elke vestiging een kluis. Het verschil met de lade
 *  is niet alleen waar het geld ligt maar ook hoe erover geboekt wordt: bij de
 *  kluis worden briefjes en munten geteld, geen bedragen ingetikt. Zie
 *  munten.ts voor waarom, en kluis.ts voor het rekenwerk.
 * ------------------------------------------------------------------ */

export interface PosSafe {
  id: string
  locationId?: string
  name: string
  active: boolean
  note?: string
  updatedAt: number
}

/**
 * Waar het geld heen ging, en dus welke kant het op gaat.
 *
 * De richting zit hierin en niet in het teken van het bedrag. Een min die
 * iemand zelf moet intikken, is een min die iemand ooit vergeet.
 */
export type KluisSoort =
  /* erin */
  | 'afstorting'   // uit de kassalade naar de kluis
  | 'van-bank'     // wisselgeld opgehaald bij de bank
  | 'inleg'        // iets anders wat erin gaat
  /* eruit */
  | 'wisselgeld'   // uit de kluis naar de kassalade
  | 'naar-bank'    // afgestort bij de bank
  | 'uitgave'      // contant betaald: boodschappen, een monteur
  /* het ijkpunt */
  | 'telling'

export const KLUIS_LABELS: Record<KluisSoort, string> = {
  afstorting: 'Afstorting uit de kassa',
  'van-bank': 'Opgehaald bij de bank',
  inleg: 'Inleg',
  wisselgeld: 'Wisselgeld naar de kassa',
  'naar-bank': 'Afgestort bij de bank',
  uitgave: 'Contante uitgave',
  telling: 'Telling',
}

/** Welke kant het op gaat. Een telling heeft geen richting; die zet het saldo. */
export const KLUIS_TEKEN: Record<KluisSoort, 1 | -1 | 0> = {
  afstorting: 1,
  'van-bank': 1,
  inleg: 1,
  wisselgeld: -1,
  'naar-bank': -1,
  uitgave: -1,
  telling: 0,
}

export interface PosSafeMove {
  id: string
  safeId: string
  locationId?: string
  soort: KluisSoort
  /** Wat er fysiek bewoog, altijd positieve aantallen. Bij een telling leeg. */
  coins: Munten
  /** Alleen bij een telling: de volledige samenstelling zoals geteld. */
  counted?: Munten
  /** Het bedrag met teken, afgeleid uit coins en soort. */
  amount: number
  /** Alleen bij een telling. */
  expected?: number
  difference?: number
  /** Als het geld van of naar de kassalade ging. */
  sessionId?: string
  registerId?: string
  reason: string
  userId?: string
  userName: string
  at: number
  updatedAt: number
}

/* ------------------------------------------------------------------ *
 *  Dit apparaat
 *
 *  Een kassa wordt gekoppeld met een code die het kantoor uitdeelt, en staat
 *  daarna in een lijst. Vanuit die lijst kan hij ook weer op slot: dit is de
 *  regel waar de kassa bij elke synchronisatie naar kijkt.
 * ------------------------------------------------------------------ */

export type ApparaatStatus = 'actief' | 'geblokkeerd' | 'ingetrokken'

export interface PosDevice {
  id: string
  registerId?: string
  locationId?: string
  /** Wat dit apparaat van zichzelf weet; blijft staan na herinstalleren. */
  deviceKey: string
  name: string
  platform: string
  appVersion?: string
  authUserId?: string
  profileId?: string
  status: ApparaatStatus
  pairedAt: number
  lastSeenAt?: number
  /** Wanneer de kassa zichzelf gewist heeft na een intrekking. */
  wipedAt?: number
  note?: string
  updatedAt: number
}

/* ------------------------------------------------------------------ *
 *  Kaarten en abonnementen
 * ------------------------------------------------------------------ */

export interface PosSubscription {
  id: string
  locationId?: string
  companyId?: string
  customerName?: string
  plate?: string
  /** Scanbare code op de kaart. */
  code: string
  kind: 'strippenkaart' | 'abonnement'
  creditsTotal: number
  validFrom?: number
  validTo?: number
  /** Waarvoor de kaart geldt; leeg = elke wasbeurt. */
  washService?: ServiceKind
  soldSaleId?: string
  active: boolean
  note?: string
  updatedAt: number
}

/**
 * Eén afboeking van een kaart.
 *
 * Het saldo is geen veld maar een som: kaart min alle afboekingen. Twee
 * kassa's die tegelijk offline een strip gebruiken zouden anders elkaars
 * saldo overschrijven.
 */
export interface PosSubscriptionUse {
  id: string
  subscriptionId: string
  saleId?: string
  credits: number
  userId?: string
  userName: string
  at: number
  updatedAt: number
}

/* ------------------------------------------------------------------ *
 *  De persoonlijke code
 * ------------------------------------------------------------------ */

export interface PosPin {
  id: string
  userId: string
  salt: string
  hash: string
  iterations: number
  /** Scanbare badge, als alternatief voor het intoetsen. */
  badgeToken?: string
  mustChange: boolean
  setBy?: string
  updatedAt: number
}

/* ------------------------------------------------------------------ *
 *  Synchronisatie
 * ------------------------------------------------------------------ */

export type EntityName =
  /* meelezen uit de wasstraat-app */
  | 'locations' | 'users' | 'companies' | 'washJobs' | 'inventory'
  /* wegschrijven naar de wasstraat-app */
  | 'timeEntries' | 'stockMovements'
  /* eigen tabellen */
  | 'registers' | 'products' | 'sales' | 'saleLines' | 'payments'
  | 'cashSessions' | 'cashMoves' | 'subscriptions' | 'subscriptionUses'
  | 'pins' | 'safes' | 'safeMoves' | 'devices'

export type SyncOp = 'put' | 'delete'

export interface OutboxRecord {
  id?: number
  entity: EntityName
  op: SyncOp
  recordId: string
  payload: unknown
  createdAt: number
  tries: number
  lastError?: string
}

export interface SyncState {
  online: boolean
  syncing: boolean
  pending: number
  lastSyncAt: number | null
  lastError: string | null
}

/* ------------------------------------------------------------------ *
 *  Het mandje
 *
 *  Wat er nu op de toonbank ligt. Dit is geen tabel: zolang er niet is
 *  afgerekend hoort het bij dit apparaat. Wel staat het in de lokale cache,
 *  zodat een kassa die halverwege uitvalt niets kwijt is.
 * ------------------------------------------------------------------ */

export interface MandjeRegel {
  /** Eigen id, want hetzelfde artikel kan twee keer met een andere korting op de bon staan. */
  id: string
  productId?: string
  name: string
  kind: ProductKind
  qty: number
  priceIncl: number
  vatPct: number
  discountPct: number
  /** Bij een wasbeurt uit de wasstraat-app. */
  washJobId?: string
  /** Bij een strippenkaart of abonnement dat verkocht wordt. */
  credits?: number
  validDays?: number
  washService?: ServiceKind
  inventoryItemId?: string
  note?: string
}

/** Wat er tijdens het afrekenen al betaald is. */
export interface DeelBetaling {
  method: PayMethod
  amount: number
  received?: number
  changeGiven?: number
  terminalRef?: string
  terminalStatus?: string
  cardBrand?: string
  subscriptionId?: string
}
