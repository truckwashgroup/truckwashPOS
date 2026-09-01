import Dexie, { type Table } from 'dexie'
import type {
  Company, InventoryItem, Location, OutboxRecord, PosCashMove, PosCashSession,
  PosDevice, PosPayment, PosPin, PosProduct, PosRegister, PosSafe, PosSafeMove,
  PosSale, PosSaleLine, PosSubscription, PosSubscriptionUse, StockMovement,
  TimeEntry, User, WashJob,
} from './types'

/**
 * De lokale cache van de kassa.
 *
 * Alles wat het scherm toont komt hieruit, nooit rechtstreeks van de server.
 * Dat is bij een kassa geen luxe maar de kern: de rij achter de balie wacht
 * niet op een internetverbinding. Afrekenen, bon afdrukken en lade openen
 * gebeuren volledig lokaal; de synchronisatie loopt erachteraan.
 *
 * De eerste vijf tabellen zijn een leeskopie uit de wasstraat-app: personeel,
 * vestigingen, klanten, wasopdrachten en voorraad. Daar schrijft de kassa
 * niets in -- behalve uren en voorraadmutaties, die horen juist thuis in de
 * administratie van het dashboard.
 */
class KassaDB extends Dexie {
  /* --- meegelezen uit de wasstraat-app --- */
  locations!: Table<Location, string>
  users!: Table<User, string>
  companies!: Table<Company, string>
  washJobs!: Table<WashJob, string>
  inventory!: Table<InventoryItem, string>

  /* --- door de kassa aangevuld, in tabellen van het dashboard --- */
  timeEntries!: Table<TimeEntry, string>
  stockMovements!: Table<StockMovement, string>

  /* --- eigen tabellen --- */
  registers!: Table<PosRegister, string>
  products!: Table<PosProduct, string>
  sales!: Table<PosSale, string>
  saleLines!: Table<PosSaleLine, string>
  payments!: Table<PosPayment, string>
  cashSessions!: Table<PosCashSession, string>
  cashMoves!: Table<PosCashMove, string>
  subscriptions!: Table<PosSubscription, string>
  subscriptionUses!: Table<PosSubscriptionUse, string>
  pins!: Table<PosPin, string>

  /* --- de kluis en dit apparaat, vanaf versie 2 --- */
  safes!: Table<PosSafe, string>
  safeMoves!: Table<PosSafeMove, string>
  devices!: Table<PosDevice, string>

  outbox!: Table<OutboxRecord, number>
  meta!: Table<{ key: string; value: unknown }, string>

  constructor() {
    super('truckwash-kassa')
    this.version(1).stores({
      locations: 'id, code, active, updatedAt',
      users: 'id, email, active, personnelNumber, locationId, updatedAt',
      companies: 'id, name, updatedAt',
      washJobs: 'id, status, companyId, plate, locationId, scheduledAt, updatedAt',
      inventory: 'id, name, locationId, updatedAt',

      timeEntries: 'id, userId, start, locationId, updatedAt',
      stockMovements: 'id, itemId, at',

      registers: 'id, code, locationId, active, updatedAt',
      // Op barcode wordt gezocht bij elke scan, op groep bij het opbouwen van
      // het scherm. Beide dus een index.
      products: 'id, code, barcode, groupName, kind, locationId, active, sort, updatedAt',
      sales: 'id, status, receiptNo, locationId, cashSessionId, operatorId, washJobId, closedAt, updatedAt',
      saleLines: 'id, saleId, updatedAt',
      payments: 'id, saleId, method, at, updatedAt',
      cashSessions: 'id, registerId, status, locationId, openedAt, updatedAt',
      cashMoves: 'id, sessionId, at, updatedAt',
      subscriptions: 'id, code, companyId, plate, locationId, soldSaleId, active, updatedAt',
      subscriptionUses: 'id, subscriptionId, saleId, at, updatedAt',
      pins: 'id, userId, badgeToken, updatedAt',

      outbox: '++id, entity, recordId, createdAt',
      meta: 'key',
    })

    /*
     * Versie 2: de kluis en de lijst met apparaten.
     *
     * Alleen de nieuwe tabellen staan hier. Dexie houdt de rest van versie 1
     * vast, dus een kassa die al draait raakt niets kwijt -- en dat is bij
     * een kassa het enige dat telt: in de outbox kan omzet staan.
     */
    this.version(2).stores({
      safes: 'id, locationId, active, updatedAt',
      safeMoves: 'id, safeId, sessionId, soort, at, updatedAt',
      devices: 'id, registerId, locationId, status, updatedAt',
    })
  }
}

export const db = new KassaDB()

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const row = await db.meta.get(key)
  return row ? (row.value as T) : fallback
}

export async function setMeta(key: string, value: unknown) {
  await db.meta.put({ key, value })
}

/**
 * Een tijdstip dat nooit twee keer hetzelfde is op dit apparaat.
 *
 * Date.now() geeft hele milliseconden, en twee handelingen achter elkaar vallen
 * daar makkelijk binnen. Bij een bon maakt dat niets uit -- die staat op zijn
 * bonnummer. Bij de kluis wel: het saldo wordt opgeteld vanaf de laatste
 * telling, dus als een boeking dezelfde tijdstempel heeft als die telling, is er
 * geen manier meer om te zien wat er eerder was. Dan valt die boeking uit het
 * saldo, zonder foutmelding en met een bedrag dat niet klopt.
 *
 * Dit loopt daarom altijd door. Bij drukte gaat de klok een paar milliseconden
 * voor op de echte; dat is een prijs die niemand merkt.
 */
let laatsteTijd = 0

export function tijdstempel(): number {
  laatsteTijd = Math.max(Date.now(), laatsteTijd + 1)
  return laatsteTijd
}

export function uid(prefix = ''): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return prefix ? `${prefix}_${raw}` : raw
}
