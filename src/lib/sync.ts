import { create } from 'zustand'
import { api, type PushChange } from './api'
import {
  GeenRechten, GeenSessie, OntbrekendeKolom, OntbrekendeTabel,
} from './api/supabaseApi'
import { db, getMeta, setMeta } from './db'
import { logLive } from './trail'
import { vatWachtrij, type VastStand } from './wachtrij'
import type { EntityName, OutboxRecord, SyncOp, SyncState } from './types'

/* ------------------------------------------------------------------ *
 *  Offline-first sync-engine
 *
 *  Overgenomen uit de wasstraat-app, waar hij zich bewezen heeft, met de
 *  tabellen van de kassa erin.
 *
 *  Schrijven  -> altijd eerst lokaal (Dexie) + een regel in de outbox.
 *  Verbinding -> de outbox wordt op volgorde naar de server geduwd, daarna
 *                worden serverwijzigingen opgehaald.
 *  Offline    -> niets gaat verloren; de outbox blijft staan en wordt
 *                automatisch verwerkt zodra er weer verbinding is.
 *
 *  Bij een kassa is dat laatste geen bijzaak. Een bon die is afgerekend en
 *  afgedrukt is klaar voor de klant, ook als de server onbereikbaar is. De
 *  omzet staat dan in de outbox en komt later alsnog binnen -- daarom staat
 *  het aantal wachtende wijzigingen ook altijd in beeld.
 * ------------------------------------------------------------------ */

export const LAST_SYNC = 'lastSyncAt'
const MAX_TRIES = 8
const BATCH = 50

/**
 * Synchroniseren heeft alleen zin met een sessie. Een backend geeft een
 * niet-ingelogd apparaat terecht niets terug; zou de kassa dan toch de teller
 * bijwerken, dan denkt hij na het inloggen dat hij bij is en blijft de cache
 * leeg.
 */
let enabled = false

export function setSyncEnabled(v: boolean) {
  enabled = v
  if (v) scheduleFlush(150)
}

interface SyncStore extends SyncState {
  /**
   * Wat er vastzit omdat de server het weigert om iets wat los van het record
   * staat. Dit is wat er aan de balie in beeld komt; zie wachtrij.ts.
   */
  vast: VastStand
  setOnline: (v: boolean) => void
  refreshPending: () => Promise<void>
  sync: (opts?: { silent?: boolean }) => Promise<void>
}

export const useSync = create<SyncStore>((set, get) => ({
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  syncing: false,
  pending: 0,
  lastSyncAt: null,
  lastError: null,
  vast: { totaal: 0, vast: 0, uren: 0, sindsMs: null, reden: null, entiteiten: [] },

  setOnline: (v) => set({ online: v }),

  /*
   * Het aantal wachtende wijzigingen, en wat daarvan vastzit.
   *
   * Die tweede is nieuw en de reden dat deze functie nu de hele wachtrij
   * uitleest in plaats van hem te tellen. Dat kost een fractie meer -- de
   * wachtrij van een kassa is kort -- en het levert het enige op waaraan aan
   * de balie te zien is dat er uren blijven hangen.
   */
  refreshPending: async () => {
    const rijen = await db.outbox.toArray()
    set({ pending: rijen.length, vast: vatWachtrij(rijen) })
  },

  sync: async (opts) => {
    if (!enabled || get().syncing) return
    set({ syncing: true, lastError: opts?.silent ? get().lastError : null })
    const begin = Date.now()
    try {
      const reachable = await api.ping()
      if (!reachable) throw new Error('Geen verbinding')
      set({ online: true })

      const geduwd = await pushOutbox()
      const { serverTime, opgehaald } = await pullChanges()

      await setMeta(LAST_SYNC, serverTime)
      set({ lastSyncAt: serverTime, lastError: null })

      logLive('sync', `Ronde klaar — ${geduwd} verstuurd, ${opgehaald} opgehaald`, {
        duur: Date.now() - begin,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({ lastError: msg, online: navigator.onLine && !msg.includes('verbinding') })
      logLive('netwerk', `Synchroniseren mislukt: ${msg}`, {
        duur: Date.now() - begin,
        detail: e instanceof Error ? e.stack : undefined,
      })
    } finally {
      set({ syncing: false })
      await get().refreshPending()
    }
  },
}))

/* ------------------------------------------------------------------ *
 *  Outbox
 * ------------------------------------------------------------------ */

export async function enqueue(
  entity: EntityName,
  op: SyncOp,
  recordId: string,
  payload: unknown,
) {
  // Nieuwere wijziging op hetzelfde record vervangt de oude (laatste wint).
  const existing = await db.outbox.where('recordId').equals(recordId).toArray()
  const stale = existing.filter((r) => r.entity === entity).map((r) => r.id!)
  if (stale.length) await db.outbox.bulkDelete(stale)

  await db.outbox.add({
    entity, op, recordId, payload,
    createdAt: Date.now(),
    tries: 0,
  })
  await useSync.getState().refreshPending()
  void scheduleFlush()
}

/**
 * De volgorde waarin tabellen naar de server gaan.
 *
 * Records verwijzen naar elkaar: een bonregel hangt aan een bon, een bon aan
 * een kassa, een strippenkaart aan de bon waarop hij verkocht is. Komt het
 * kind eerder aan dan de ouder, dan weigert de server het -- en niet eens met
 * een duidelijke melding, want de beveiligingsregel wordt eerder beoordeeld
 * dan de verwijzing. Je krijgt dan te horen dat je ergens niet bij mag, over
 * iets wat er nog niet is.
 *
 * Op de volgorde van de wachtrij kun je niet bouwen: die volgt de klok, en
 * twee handelingen in dezelfde milliseconde staan in willekeurige volgorde.
 * Daarom leggen we hem hier expliciet vast: ouders eerst.
 */
export const PUSH_ORDER: EntityName[] = [
  'registers', 'products',
  // De wasopdracht gaat vóór de bon: verkoop je een wasbeurt aan de balie,
  // dan maakt de kassa er een opdracht voor de wasstraat bij.
  'washJobs',
  'cashSessions', 'sales', 'saleLines', 'payments',
  // De kaart verwijst naar de bon waarop hij verkocht is.
  'subscriptions', 'subscriptionUses',
  'cashMoves',
  // De kluisboeking verwijst naar de kassadag waar het geld uit kwam, dus
  // komt hij daarna. Kluizen zelf maakt de kassa niet aan; die komen uit het
  // dashboard, en daarom staat 'safes' hier niet.
  'safeMoves',
  'timeEntries', 'inventory', 'stockMovements',
  'pins',
  // Dit apparaat meldt alleen van zijn eigen regel dat hij er nog is.
  'devices',
]

const RANG = new Map(PUSH_ORDER.map((e, i) => [e, i]))

async function pushOutbox(): Promise<number> {
  let totaal = 0
  for (;;) {
    const batch = await db.outbox.orderBy('createdAt').limit(BATCH).toArray()
    if (!batch.length) return totaal

    // Ouders voor kinderen. Binnen een tabel blijft de volgorde van de
    // wachtrij staan; sorteren in JavaScript is stabiel.
    const gesorteerd = [...batch].sort(
      (a, b) => (RANG.get(a.entity) ?? 99) - (RANG.get(b.entity) ?? 99))

    const changes: PushChange[] = gesorteerd.map((r) => ({
      entity: r.entity,
      op: r.op,
      recordId: r.recordId,
      payload: r.payload,
    }))

    try {
      await api.push(changes)
      await db.outbox.bulkDelete(batch.map((r) => r.id!))
      totaal += batch.length
    } catch (e) {
      /*
       * Eén record dat de server weigert mag niet de hele wachtrij
       * blokkeren -- anders staat een verkeerde voorraadmutatie het
       * doorzetten van een dag omzet in de weg.
       *
       * Dus proberen we ze nu stuk voor stuk. Wat erdoor komt is weg; wat
       * blijft weigeren krijgt een teller, en gaat er na acht pogingen uit
       * met een regel in het logboek.
       */
      const mislukt = await pushPerStuk(gesorteerd)
      await useSync.getState().refreshPending()
      throw mislukt ?? e
    }
    await useSync.getState().refreshPending()
  }
}

/**
 * Zegt deze fout iets over dít record, of over de omstandigheden?
 *
 * Dat onderscheid is de kern van dit bestand, en het ontbreken ervan kostte een
 * inklokking. Het apparaataccount miste een recht, de database weigerde de
 * urenregel, en deze functie deed wat hij bij elke fout deed: acht keer
 * proberen en dan weggooien. Aan de balie was niets te zien -- de medewerker
 * had "is ingeklokt" gelezen en stond onder "Nu aan het werk".
 *
 * Deze vier weigeringen zeggen niets over het record. Onder dezelfde
 * omstandigheden wordt álles geweigerd: er mist een recht, er mist een tabel,
 * er mist een kolom, of er is geen sessie. Nog eens proberen maakt dat niet
 * beter, en na de achtste keer is er werk weg om een reden die er los van
 * staat.
 *
 * Ze blijven daarom staan. Voor altijd, als het moet -- tot de rechten kloppen
 * of het schema bij is. Een wachtrij die volloopt is een probleem dat je ziet;
 * omzet en uren die stil verdwijnen is een probleem dat je pas maanden later
 * ziet, en dan niet meer kunt herstellen.
 */
function gaatNietOverDitRecord(e: unknown): boolean {
  return e instanceof GeenRechten
    || e instanceof GeenSessie
    || e instanceof OntbrekendeTabel
    || e instanceof OntbrekendeKolom
}

/** Duwt elk record apart. Geeft de eerste fout terug, of null als alles lukte. */
export async function pushPerStuk(batch: OutboxRecord[]): Promise<Error | null> {
  let eerste: Error | null = null

  for (const r of batch) {
    try {
      await api.push([{
        entity: r.entity, op: r.op, recordId: r.recordId, payload: r.payload,
      }])
      await db.outbox.delete(r.id!)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      eerste ??= e instanceof Error ? e : new Error(msg)

      if (gaatNietOverDitRecord(e)) {
        /*
         * `tries` blijft staan, en dat is niet hetzelfde als "niets bijhouden".
         *
         * De wasstraat-app telt hier wel door en gooit dan alsnog niet weg,
         * omdat er een continue tussen staat. Dat werkt, maar het leunt op de
         * volgorde van twee stukjes code: haalt iemand die continue ooit weg,
         * dan staat de teller al op veertig en is het record bij de eerstvolgende
         * gewone fout meteen weg. Bij uren en omzet is dat een te dun slot.
         *
         * Dus houden we het apart bij. `tries` betekent hier één ding:
         * pogingen die tot weggooien leiden.
         */
        await db.outbox.update(r.id!, {
          geweigerd: (r.geweigerd ?? 0) + 1,
          lastError: msg,
        })
        continue
      }

      const tries = r.tries + 1
      if (tries >= MAX_TRIES) {
        await db.outbox.delete(r.id!)
        /*
         * Zichtbaar maken dat er iets is weggegooid. Bij een kassa is dit
         * ernstiger dan elders: een bon die de server nooit haalt, is omzet
         * die nergens staat. Vandaar ook de regel in het logboek, die in het
         * dashboard onder Ontwikkeling terugkomt.
         */
        console.warn(
          `[sync] ${r.entity}/${r.recordId} is na ${MAX_TRIES} pogingen ` +
          `opgegeven en weggegooid. Laatste fout: ${msg}`)
        logLive('netwerk', `Opgegeven: ${r.entity}/${r.recordId}`, { detail: msg })
      } else {
        await db.outbox.update(r.id!, { tries, lastError: msg })
      }
    }
  }

  return eerste
}

/* ------------------------------------------------------------------ *
 *  Pull
 * ------------------------------------------------------------------ */

const TABLE_OF: Record<EntityName, () => any> = {
  locations: () => db.locations,
  users: () => db.users,
  companies: () => db.companies,
  washJobs: () => db.washJobs,
  inventory: () => db.inventory,
  timeEntries: () => db.timeEntries,
  stockMovements: () => db.stockMovements,
  registers: () => db.registers,
  products: () => db.products,
  sales: () => db.sales,
  saleLines: () => db.saleLines,
  payments: () => db.payments,
  cashSessions: () => db.cashSessions,
  cashMoves: () => db.cashMoves,
  subscriptions: () => db.subscriptions,
  subscriptionUses: () => db.subscriptionUses,
  pins: () => db.pins,
  safes: () => db.safes,
  safeMoves: () => db.safeMoves,
  devices: () => db.devices,
}

async function pullChanges(): Promise<{ serverTime: number; opgehaald: number }> {
  const since = await getMeta<number>(LAST_SYNC, 0)
  const result = await api.pull(since)
  let opgehaald = 0

  // Records die nog in de outbox staan niet overschrijven: lokaal is nieuwer.
  const queued = new Set((await db.outbox.toArray()).map((r) => r.entity + ':' + r.recordId))

  for (const [entity, rows] of Object.entries(result.changes) as [EntityName, any[]][]) {
    if (!rows?.length) continue
    const keep = rows.filter((r) => !queued.has(entity + ':' + r.id))
    if (keep.length) {
      await TABLE_OF[entity]().bulkPut(keep)
      opgehaald += keep.length
      logLive('sync', `${keep.length}x ${entity} opgehaald`)
    }
  }

  return { serverTime: result.serverTime, opgehaald }
}

/* ------------------------------------------------------------------ *
 *  Automatiek
 * ------------------------------------------------------------------ */

let flushTimer: ReturnType<typeof setTimeout> | null = null

/** Kort uitgesteld synchroniseren, zodat vijf artikelen achter elkaar
 *  aanslaan niet vijf netwerkrondes veroorzaakt. */
export function scheduleFlush(delay = 1200) {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    if (useSync.getState().online) void useSync.getState().sync({ silent: true })
  }, delay)
}

/*
 * Hoe vaak we kijken.
 *
 * Een kassa hoeft niet elke vijf seconden te weten wat het dashboard doet,
 * maar wél snel genoeg dat een wasopdracht die net is ingepland aan de balie
 * te vinden is. Een halve minuut is daarvoor ruim; de wachtrij wordt
 * bovendien meteen geduwd bij elke handeling.
 */
const POLL_MS = 30_000

let pollTimer: ReturnType<typeof setInterval> | null = null
let started = false

export function startSyncEngine() {
  if (started) return
  started = true

  const goOnline = () => {
    useSync.getState().setOnline(true)
    void useSync.getState().sync({ silent: true })
  }
  const goOffline = () => useSync.getState().setOnline(false)

  window.addEventListener('online', goOnline)
  window.addEventListener('offline', goOffline)

  pollTimer = setInterval(() => {
    if (useSync.getState().online) void useSync.getState().sync({ silent: true })
  }, POLL_MS)

  // Terug in beeld -> direct bijwerken
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && useSync.getState().online) {
      void useSync.getState().sync({ silent: true })
    }
  })

  void (async () => {
    const last = await getMeta<number | null>(LAST_SYNC, null)
    useSync.setState({ lastSyncAt: last })
    await useSync.getState().refreshPending()
    await useSync.getState().sync({ silent: true })
  })()
}

export function stopSyncEngine() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  started = false
}
