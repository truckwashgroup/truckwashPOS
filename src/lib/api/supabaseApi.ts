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
  safes: 'pos_safes',
  safeMoves: 'pos_safe_moves',
  devices: 'pos_devices',
}

/** Kolommen waarvan de naam niet simpelweg de snake_case-variant is. */
const OVERRIDES: Partial<Record<EntityName, Record<string, string>>> = {
  // "end" is een gereserveerd woord in SQL
  timeEntries: { start: 'started_at', end: 'ended_at' },
  users: { function: 'job_title' },
}

/* ------------------------------------------------------------------ *
 *  Tabellen die de kassa alleen mag bijwerken, niet aanmaken
 *
 *  Twee rijen in de database horen bij dit apparaat en worden door iemand
 *  anders gemaakt: zijn kassa (door het kantoor) en zijn eigen regel in de
 *  apparatenlijst (door de serverfunctie bij het koppelen). De kassa mag daar
 *  bepaalde velden in bijwerken -- de printerinstelling, en dat hij er nog is
 *  -- en verder niets.
 *
 *  De beveiligingsregels zijn daarop ingericht: er staat voor deze twee alleen
 *  een UPDATE-regel voor het eigen apparaat, en geen INSERT-regel.
 *
 *  En daar ging het mis. De kassa stuurde alles als upsert, want dat is voor
 *  alle andere tabellen precies goed: een bon die opnieuw wordt aangeboden mag
 *  niet stuklopen op "bestaat al". Maar een upsert is voor Postgres een INSERT
 *  met een uitweg, en die wordt eerst tegen de INSERT-regel gehouden. Die
 *  bestaat niet, dus kwam er "new row violates row-level security policy for
 *  table pos_devices" terug -- een melding over een nieuwe rij, terwijl er
 *  niets nieuws was.
 *
 *  Voor deze twee sturen we daarom een gewone update. Dat is ook wat het is.
 * ------------------------------------------------------------------ */

export const ALLEEN_BIJWERKEN: EntityName[] = ['registers', 'devices']

/**
 * Tabellen waarvan we bij de eerste synchronisatie niet de hele historie
 * ophalen. Ze groeien met elke bon; de kassa heeft alleen de recente nodig.
 */
const JOURNAAL: EntityName[] = [
  'sales', 'saleLines', 'payments', 'cashSessions', 'cashMoves',
  'subscriptionUses', 'timeEntries', 'stockMovements', 'washJobs',
  /*
   * De kluis hoort hier ook bij, en met een kanttekening: het saldo wordt
   * vanaf de laatste telling opgeteld. Valt die telling buiten de horizon,
   * dan mist de kassa zijn ijkpunt. Zestig dagen zonder een kluis te tellen
   * is bij een kassa geen normale gang van zaken -- en het scherm zegt het
   * er hardop bij als er lang niet geteld is.
   */
  'safeMoves',
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
export function magNiet(error: { code?: string } | null): boolean {
  return error?.code === 'PGRST301' || error?.code === '42501'
}

/* ------------------------------------------------------------------ *
 *  Vier soorten weigering die niets over het record zeggen
 *
 *  Dit stond in de kassa niet, en in de wasstraat-app wel. Het verschil kostte
 *  een inklokking.
 *
 *  Wat er gebeurde: het apparaataccount miste een recht, de database weigerde
 *  de urenregel, en pushPerStuk deed wat hij bij elke fout doet -- acht keer
 *  proberen en dan weggooien. Aan de balie was niets te zien: de medewerker had
 *  "is ingeklokt" gezien en stond onder "Nu aan het werk". Dat de regel de
 *  server nooit gehaald had, bleek pas bij de urenstaat.
 *
 *  De fout was niet dat er geweigerd werd -- dat hoort een keer te gebeuren.
 *  De fout was dat de kassa die weigering las als "dit record is stuk". Een
 *  weigering op rechten, een ontbrekende tabel, een ontbrekende kolom of een
 *  verlopen sessie zeggen alle vier niets over dít record: onder dezelfde
 *  omstandigheden wordt álles geweigerd. Acht keer opnieuw proberen maakt dat
 *  niet beter, en na de achtste keer is er werk weg om een reden die niets met
 *  dat werk te maken had.
 *
 *  Deze vier krijgen daarom een eigen soort, en sync.ts gooit ze nooit weg.
 * ------------------------------------------------------------------ */

/** De tabel bestaat nog niet: het schema loopt achter op de app. */
export function tabelOntbreekt(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  // 42P01 komt van Postgres, PGRST205/PGRST106 van de laag ervoor.
  if (['42P01', 'PGRST205', 'PGRST106'].includes(error.code ?? '')) return true
  return /(relation|table).{0,40}(does not exist|not found)/i.test(error.message ?? '')
}

/** De kolom bestaat nog niet. Zelfde soort probleem als een tabel. */
export function kolomOntbreekt(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  if (error.code === 'PGRST204') return true
  return /could not find the .* column/i.test(error.message ?? '')
}

export class OntbrekendeTabel extends Error {
  constructor(readonly tabel: string) {
    super(
      `De tabel "${tabel}" bestaat nog niet in de database. ` +
      'Draai supabase/setup.sql opnieuw; de wijziging blijft zolang in de wachtrij staan.',
    )
  }
}

export class OntbrekendeKolom extends Error {
  constructor(readonly tabel: string, boodschap?: string) {
    super(
      `De tabel "${tabel}" mist een kolom die de kassa meestuurt: ${boodschap ?? ''} `.trim() +
      ' Draai supabase/setup.sql opnieuw; de wijziging blijft zolang in de wachtrij staan.',
    )
  }
}

/**
 * Er is geen geldige sessie meer bij de server.
 *
 * Bij een kassa gebeurt dat vaker dan elders: het apparaat staat dagen aan,
 * gaat een weekend uit, of hangt aan een lijn die er af en toe uit ligt. Zonder
 * sessie gaat elk verzoek als onbekende bezoeker naar de database, en die
 * weigert dan terecht alles -- met een melding over beveiligingsregels, die
 * naar de verkeerde kant wijst.
 */
export class GeenSessie extends Error {
  constructor() {
    super(
      'Deze kassa is niet meer ingelogd bij de server. Wat in de wachtrij ' +
      'staat blijft staan tot dat weer lukt.',
    )
  }
}

/**
 * De database weigert dit op zijn beveiligingsregels.
 *
 * Dit is de fout die de inklokking kostte. Hij gaat niet over dit record maar
 * over rechten, en rechten worden niet beter van acht keer hetzelfde proberen.
 */
export class GeenRechten extends Error {
  constructor(readonly tabel: string, boodschap: string) {
    super(
      `De database weigert dit voor "${tabel}": ${boodschap} ` +
      'Dat gaat over rechten, niet over dit record -- het blijft in de ' +
      'wachtrij staan.',
    )
  }
}

/**
 * Is er een bruikbare sessie?
 *
 * getSession() vernieuwt zelf een verlopen toegangssleutel zolang de
 * vernieuwsleutel nog geldig is, dus dit is tegelijk de plek waar dat gebeurt.
 * Een opgeslagen sessie is namelijk niet hetzelfde als een geldige sessie: de
 * toegangssleutel verloopt na een uur, en wat er dan nog ligt is papier.
 */
export async function heeftSessie(): Promise<boolean> {
  if (!supabaseConfigured) return false
  try {
    const { data } = await supabase().auth.getSession()
    const sessie = data.session
    if (!sessie) return false

    // Een halve minuut marge: de sleutel moet de rit naar de server nog halen.
    const verlooptOver = (sessie.expires_at ?? 0) * 1000 - Date.now()
    if (verlooptOver > 30_000) return true

    const { data: vers } = await supabase().auth.refreshSession()
    return !!vers.session
  } catch {
    return false
  }
}

/** Zet een antwoord van de database om in de fout die erbij hoort. */
function weiger(tabel: string, context: string, error: { code?: string; message: string }): never {
  if (tabelOntbreekt(error)) throw new OntbrekendeTabel(tabel)
  if (kolomOntbreekt(error)) throw new OntbrekendeKolom(tabel, error.message)
  if (magNiet(error)) throw new GeenRechten(tabel, error.message)
  fail(context, error)
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
    /*
     * Eerst kijken of er een sessie is.
     *
     * Zonder deze regel komt een verlopen sessie terug als een weigering op de
     * beveiligingsregels -- en dan zoekt iemand naar een rechtenprobleem dat er
     * niet is. Bovendien vernieuwt heeftSessie() de sleutel als dat nog kan,
     * dus in de meeste gevallen lost dit het meteen op.
     */
    if (!(await heeftSessie())) throw new GeenSessie()

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
        if (error) weiger(table, `verwijderen in ${table}`, error)
      }

      const upserts = list
        .filter((c) => c.op === 'put')
        .map((c) => toRow(entity, c.payload as Record<string, unknown>))

      if (upserts.length && ALLEEN_BIJWERKEN.includes(entity)) {
        /*
         * Eén voor één bijwerken op id, en niet als upsert. Zie de uitleg bij
         * ALLEEN_BIJWERKEN: een upsert is een INSERT, en die mag de kassa hier
         * niet -- ook niet als de rij al bestaat.
         *
         * Raakt het niets omdat de rij aan de serverkant weg is, dan is dat
         * geen fout: het kantoor heeft die kassa of dat apparaat dan
         * verwijderd, en dan hoort de kassa hem niet opnieuw neer te zetten.
         */
        for (const rij of upserts) {
          const { id, ...velden } = rij as { id?: string } & Record<string, unknown>
          if (!id) continue
          const { error } = await supabase().from(table).update(velden).eq('id', id)
          if (error) weiger(table, `bijwerken in ${table}`, error)
        }
      } else if (upserts.length) {
        const { error } = await supabase().from(table).upsert(upserts, { onConflict: 'id' })
        if (error) weiger(table, `opslaan in ${table}`, error)
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
