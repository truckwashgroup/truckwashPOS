import Dexie, { type Table } from 'dexie'
import type {
  Company, InventoryItem, Location, OutboxRecord, PosCashMove, PosCashSession,
  PosPayment, PosPin, PosProduct, PosRegister, PosSale, PosSaleLine,
  PosSubscription, PosSubscriptionUse, StockMovement, TimeEntry, User, WashJob,
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

export function uid(prefix = ''): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return prefix ? `${prefix}_${raw}` : raw
}
