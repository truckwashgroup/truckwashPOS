import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { ApiAdapter, PullResult, PushChange } from './types'
import type { EntityName } from '../types'

/* ------------------------------------------------------------------ *
 *  Supabase-adapter voor de kassa
 *
 *  Dezelfde vier methodes als in de wasstraat-app: login, push, pull, ping.
 *  Ook dezelfde database -- de kassa is geen tweede administratie.
 *
 *  Wat hier anders is dan in het dashboard, en waarom:
 *
 *  1. Paginering. Het dashboard haalt per tabel maximaal 2000 gewijzigde
 *     rijen op. Bij een kassa is dat te weinig: bonnen, regels en betalingen
 *     lopen in de tienduizenden, en wat buiten die 2000 valt zou stil
 *     wegvallen -- de cursor schuift namelijk toch door. Hier halen we per
 *     tabel dóór tot er niets meer komt.
 *
 *  2. Een horizon. Een kassa hoeft niet elke bon uit 2024 in zijn cache te
 *     hebben; hij moet kunnen herprinten en crediteren. Bij de eerste
 *     synchronisatie halen we van de journaaltabellen daarom alleen de
 *     laatste maanden op. De volledige historie blijft in de database en is
 *     in het dashboard te zien.
 * ------------------------------------------------------------------ */

const ENV: Record<string, string | undefined> =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}

const URL = ENV.VITE_SUPABASE_URL
const ANON = ENV.VITE_SUPABASE_ANON_KEY

/**
 * De sleutel in deze variabele belandt in de app-bundel en gaat dus mee naar
 * ieder kassa-apparaat. Dat mag alleen met de publieke sleutel: die komt niet
 * langs de beveiligingsregels heen. Een geheime sleutel doet dat wel, en die
 * weigeren we hier hardop.
 */
function keyProblem(key: string | undefined): string | null {
  if (!key) return null
  if (key.startsWith('sb_secret_') || key.startsWith('sk_')) {
    return 'Dit is een geheime sleutel (sb_secret_). Gebruik de publieke sleutel: ' +
           'Supabase -> Project Settings -> API Keys -> "publishable".'
  }
  const parts = key.split('.')
  if (parts.length === 3) {
    try {
      const pad = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4)
      const json = atob(pad.replace(/-/g, '+').replace(/_/g, '/'))
      if (JSON.parse(json).role === 'service_role') {
        return 'Dit is de service_role-sleutel. Gebruik de "anon public" sleutel.'
      }
    } catch {
      /* geen leesbare JWT: dan is het waarschijnlijk een publieke sleutel */
    }
  }
  return null
}

export const configError = keyProblem(ANON)

if (configError) {
  console.error('[Supabase] ' + configError)
}

export const supabaseConfigured = Boolean(URL && ANON) && !configError

let client: SupabaseClient | null = null

export function supabase(): SupabaseClient {
  if (!client) {
    if (!URL || !ANON) {
      throw new Error(
        'Supabase is niet ingesteld. Zet VITE_SUPABASE_URL en ' +
        'VITE_SUPABASE_ANON_KEY in je .env-bestand.',
      )
    }
    client = createClient(URL, ANON, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // De kassa draait als bestand (Electron) en als webview (tablet);
        // daar bestaat geen URL-callback om een sessie uit te lezen.
        detectSessionInUrl: false,
      },
    })
  }
  return client
}

/* ------------------------------------------------------------------ *
 *  Tabellen
 * ------------------------------------------------------------------ */

const TABLES: Record<EntityName, string> = {
  /* van de wasstraat-app */
  locations: 'locations',
  users: 'profiles',
  companies: 'companies',
  washJobs: 'wash_jobs',
  inventory: 'inventory_items',
  timeEntries: 'time_entries',
  stockMovements: 'stock_movements',
  /* van de kassa */
  registers: 'pos_registers',
  products: 'pos_products',
  sales: 'pos_sales',
  saleLines: 'pos_sale_lines',
  payments: 'pos_payments',
  cashSessions: 'pos_cash_sessions',
  cashMoves: 'pos_cash_moves',
  subscriptions: 'pos_subscriptions',
  subscriptionUses: 'pos_subscription_uses',
  pins: 'pos_pins',
}

/** Kolommen waarvan de naam niet simpelweg de snake_case-variant is. */
const OVERRIDES: Partial<Record<EntityName, Record<string, string>>> = {
  // "end" is een gereserveerd woord in SQL
  timeEntries: { start: 'started_at', end: 'ended_at' },
  users: { function: 'job_title' },
}

/**
 * Tabellen waarvan we bij de eerste synchronisatie niet de hele historie
 * ophalen. Ze groeien met elke bon; de kassa heeft alleen de recente nodig.
 */
const JOURNAAL: EntityName[] = [
  'sales', 'saleLines', 'payments', 'cashSessions', 'cashMoves',
  'subscriptionUses', 'timeEntries', 'stockMovements', 'washJobs',
]

const HORIZON_DAGEN = 60
const PAGINA = 1000

/* ------------------------------------------------------------------ *
 *  camelCase <-> snake_case
 * ------------------------------------------------------------------ */

const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
const toCamel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

export function toRow(entity: EntityName, obj: Record<string, unknown>) {
  const over = OVERRIDES[entity] ?? {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    out[over[k] ?? toSnake(k)] = v
  }
  // updated_at wordt serverzijdig gezet
  delete out.updated_at
  return out
}

export function fromRow(entity: EntityName, row: Record<string, unknown>) {
  const over = OVERRIDES[entity] ?? {}
  const back = Object.fromEntries(Object.entries(over).map(([camel, col]) => [col, camel]))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (v === null) continue // de app gebruikt undefined, niet null
    out[back[k] ?? toCamel(k)] = v
  }
  return out
}

/* ------------------------------------------------------------------ */

function fail(context: string, error: { message: string } | null): never {
  throw new Error(`${context}: ${error?.message ?? 'onbekende fout'}`)
}

/** Geen rechten op een tabel is normaal, geen storing. */
function magNiet(error: { code?: string } | null): boolean {
  return error?.code === 'PGRST301' || error?.code === '42501'
}

export const supabaseApi: ApiAdapter = {
  name: 'supabase',

  async ping() {
    if (!supabaseConfigured || !navigator.onLine) return false
    try {
      const { error } = await supabase()
        .from('companies').select('id', { head: true, count: 'exact' }).limit(1)
      // Een weigering van de beveiligingsregels betekent nog steeds: server
      // bereikbaar. En dat is het enige wat we hier willen weten.
      return !error || magNiet(error)
    } catch {
      return false
    }
  },

  async login(email, password) {
    const { data, error } = await supabase().auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    })

    if (error) {
      const wrong = error.status === 400 || /invalid login/i.test(error.message)
      if (wrong) return null
      throw new Error(error.message)
    }
    if (!data.session || !data.user) return null

    const { data: profile, error: profileError } = await supabase()
      .from('profiles')
      .select('*')
      .eq('auth_id', data.user.id)
      .maybeSingle()

    if (profileError) fail('profiel ophalen', profileError)
    if (!profile) {
      throw new Error(
        'Inloggen lukte, maar er hangt geen personeelsdossier aan dit account. ' +
        'Laat het management je toevoegen met hetzelfde e-mailadres.',
      )
    }

    return {
      userId: profile.id as string,
      token: data.session.access_token,
      profile: fromRow('users', profile as Record<string, unknown>),
    }
  },

  async push(changes: PushChange[]) {
    // Per tabel bundelen scheelt netwerkrondes.
    const byTable = new Map<EntityName, PushChange[]>()
    for (const c of changes) {
      const list = byTable.get(c.entity) ?? []
      list.push(c)
      byTable.set(c.entity, list)
    }

    for (const [entity, list] of byTable) {
      const table = TABLES[entity]

      const deletes = list.filter((c) => c.op === 'delete').map((c) => c.recordId)
      if (deletes.length) {
        const { error } = await supabase().from(table).delete().in('id', deletes)
        if (error) fail(`verwijderen in ${table}`, error)
      }

      const upserts = list
        .filter((c) => c.op === 'put')
        .map((c) => toRow(entity, c.payload as Record<string, unknown>))
      if (upserts.length) {
        const { error } = await supabase().from(table).upsert(upserts, { onConflict: 'id' })
        if (error) fail(`opslaan in ${table}`, error)
      }
    }
  },

  async pull(since: number): Promise<PullResult> {
    const changes: PullResult['changes'] = {}
    const eersteKeer = since === 0
    const horizon = Date.now() - HORIZON_DAGEN * 86_400_000

    const results = await Promise.all(
      (Object.keys(TABLES) as EntityName[]).map(async (entity) => {
        const vanaf = eersteKeer && JOURNAAL.includes(entity)
          ? Math.max(since, horizon)
          : since

        const alles: Record<string, unknown>[] = []

        /*
         * Doorhalen tot er niets meer komt. Op updated_at gesorteerd
         * pagineren is hier veilig: een rij die tijdens het ophalen wijzigt
         * schuift naar achteren en komt in een volgende ronde alsnog langs,
         * want de cursor loopt pas na deze hele ronde door.
         */
        for (let pagina = 0; ; pagina++) {
          const { data, error } = await supabase()
            .from(TABLES[entity])
            .select('*')
            .gt('updated_at', vanaf)
            .order('updated_at', { ascending: true })
            .range(pagina * PAGINA, pagina * PAGINA + PAGINA - 1)

          if (error && magNiet(error)) return [entity, [] as Record<string, unknown>[]] as const
          if (error) fail(`ophalen van ${TABLES[entity]}`, error)

          const rijen = data ?? []
          alles.push(...rijen)
          if (rijen.length < PAGINA) break
        }

        return [entity, alles.map((r) => fromRow(entity, r))] as const
      }),
    )

    for (const [entity, rows] of results) {
      if (rows.length) changes[entity] = rows
    }

    // Servertijd bepaalt de volgende cursor, niet de klok van dit apparaat.
    // Een kassa met een verkeerd ingestelde tijd zou anders wijzigingen
    // overslaan.
    const { data: serverNow } = await supabase().rpc('server_time_ms')
    return {
      changes,
      serverTime: typeof serverNow === 'number' ? serverNow : Date.now(),
    }
  },
}

/** Uitloggen bij Supabase; de lokale cache blijft staan. */
export async function supabaseSignOut() {
  if (supabaseConfigured) {
    try {
      await supabase().auth.signOut()
    } catch {
      /* offline uitloggen mag geen fout geven */
    }
  }
}
