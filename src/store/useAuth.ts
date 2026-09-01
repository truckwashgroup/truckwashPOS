import { create } from 'zustand'
import { api, backendError, supabaseSignOut } from '../lib/api'
import { db, getMeta, setMeta } from '../lib/db'
import { rememberOfflineLogin, verifyOfflineLogin } from '../lib/offlineAuth'
import { storageGet, storageRemove, storageSet } from '../lib/storage'
import { LAST_SYNC, setSyncEnabled, useSync } from '../lib/sync'
import { herkenBadge, herkenOpNummer } from '../lib/code'
import {
  bewaardeInlog, inlogBewaren, koppelMetCode, wisApparaat,
  type KoppelUitslag,
} from '../lib/koppelen'
import type { User } from '../lib/types'

/* ------------------------------------------------------------------ *
 *  Wie is wie aan de kassa
 *
 *  Er zijn twee soorten "ingelogd", en dat onderscheid is de kern van dit
 *  bestand:
 *
 *  Het apparaat  De kassa zelf is ingelogd met één account. Dat bepaalt wat
 *                de kassa uit de database mag halen: artikelen, personeel van
 *                deze vestiging, wasopdrachten. Dit gebeurt één keer bij het
 *                inrichten en blijft daarna staan, ook na een herstart.
 *
 *  De medewerker Wie er op dit moment achter de kassa staat. Dat wisselt de
 *                hele dag door, en dat is precies waarom het niet aan het
 *                apparaataccount kan hangen. Hij meldt zich met zijn
 *                personeelsnummer of zijn badge; zijn naam komt op de bon en
 *                zijn uren gaan naar het dashboard.
 *
 *  De medewerker valt er na een tijd stilte vanzelf af. Zonder dat zou de
 *  volgende chauffeur worden afgerekend op naam van iemand die al naar huis
 *  is, en dan is de bon niet meer waard dan een kladje.
 * ------------------------------------------------------------------ */

const SESSION_KEY = 'kassa.sessie'
const CACHE_OWNER = 'cacheOwner'

/** Na zoveel stilte moet de medewerker zich opnieuw melden. */
export const AFMELD_NA_MS = 5 * 60_000

interface AuthStore {
  /** Het account waarmee dit apparaat is ingericht. */
  apparaat: User | null
  /** Wie er nu achter de kassa staat. */
  operator: User | null
  booting: boolean
  busy: boolean
  error: string | null
  /** Wanneer de operator voor het laatst iets deed. */
  laatsteActie: number

  restore: () => Promise<void>
  /**
   * Dit apparaat koppelen met een eenmalige code.
   *
   * Vervangt het inloggen met een medewerkersaccount. Zie lib/koppelen.ts voor
   * waarom dat beter is dan iemands wachtwoord op een tablet achter de balie.
   */
  koppel: (code: string) => Promise<KoppelUitslag>
  /**
   * Dit apparaat helemaal loskoppelen, zodat er een nieuwe code in kan.
   *
   * Meer dan uitloggen: ook de gegevens van deze vestiging gaan eruit. Een
   * kassa die naar een andere vestiging verhuist mag daar niet met de
   * artikelen en het personeel van de vorige aankomen.
   */
  ontkoppel: (opties?: { forceren?: boolean }) => Promise<{ ok: boolean; reden?: string }>
  login: (email: string, password: string) => Promise<boolean>
  logout: () => Promise<void>

  meldAan: (nummer: string) => Promise<{ ok: boolean; fout?: string }>
  meldAanMetBadge: (token: string) => Promise<{ ok: boolean; fout?: string }>
  meldAf: () => void
  raakAan: () => void
}

/**
 * Zorgt dat de lokale cache bij dit account hoort.
 *
 * Wordt de kassa op een ander account gezet, dan moeten de gegevens van het
 * vorige weg: een andere vestiging heeft andere artikelen en ander personeel,
 * en die door elkaar zien is erger dan even wachten op een nieuwe
 * synchronisatie.
 *
 * De outbox blijft staan. Daar kan omzet in zitten die nog verstuurd moet
 * worden, en die gooit niemand weg.
 */
async function cacheKlaarzetten(userId: string) {
  const vorige = await getMeta<string | null>(CACHE_OWNER, null)

  if (vorige && vorige !== userId) {
    await Promise.all([
      db.users.clear(), db.companies.clear(), db.washJobs.clear(),
      db.inventory.clear(), db.locations.clear(),
      db.registers.clear(), db.products.clear(),
      db.sales.clear(), db.saleLines.clear(), db.payments.clear(),
      db.cashSessions.clear(), db.cashMoves.clear(),
      db.subscriptions.clear(), db.subscriptionUses.clear(),
      db.pins.clear(), db.timeEntries.clear(), db.stockMovements.clear(),
      db.safes.clear(), db.safeMoves.clear(), db.devices.clear(),
    ])
  }

  await setMeta(CACHE_OWNER, userId)
  await setMeta(LAST_SYNC, 0)
  useSync.setState({ lastSyncAt: null })
}

export const useAuth = create<AuthStore>((set, get) => ({
  apparaat: null,
  operator: null,
  booting: true,
  busy: false,
  error: null,
  laatsteActie: Date.now(),

  restore: async () => {
    try {
      const raw = await storageGet(SESSION_KEY)
      if (raw) {
        const sessie = JSON.parse(raw) as { userId: string }
        const user = await db.users.get(sessie.userId)
        if (user && user.active) {
          set({ apparaat: user })
          setSyncEnabled(true)
          return
        }
        await storageRemove(SESSION_KEY)
      }

      /*
       * Geen sessie, maar wel bewaarde inloggegevens van dit apparaat.
       *
       * Dat gebeurt als de opslag is opgeschoond of als de kassa lang uit
       * heeft gestaan. Zonder dit stond er dan een koppelscherm terwijl het
       * apparaat gewoon gekoppeld is -- en dan moet iemand op zaterdagochtend
       * het kantoor bellen voor een nieuwe code. Zie lib/koppelen.ts voor
       * waarom die gegevens hier mogen staan.
       */
      const inlog = await bewaardeInlog()
      if (inlog) {
        const gelukt = await get().login(inlog.email, inlog.wachtwoord)
        if (gelukt) {
          set({ error: null })
          return
        }
      }
    } catch {
      /* corrupte sessie: dan koppelt iemand de kassa opnieuw */
    } finally {
      set({ booting: false })
    }
  },

  koppel: async (code) => {
    set({ busy: true, error: null })
    try {
      const uitslag = await koppelMetCode(code)
      if (!uitslag.ok || !uitslag.inlog) {
        set({ busy: false, error: uitslag.reden ?? 'Koppelen lukte niet.' })
        return uitslag
      }

      /*
       * Bewaren vóór het inloggen, niet erna. Loopt het inloggen mis op iets
       * tijdelijks -- een lijn die net wegvalt -- dan is de code al opgebruikt
       * en zou het apparaat zonder deze regel voorgoed vastzitten. Nu probeert
       * hij het bij de volgende start gewoon opnieuw.
       */
      await inlogBewaren(uitslag.inlog)

      const gelukt = await get().login(uitslag.inlog.email, uitslag.inlog.wachtwoord)
      if (!gelukt) {
        set({ busy: false })
        return {
          ok: false,
          reden: get().error ??
            'De kassa is gekoppeld, maar inloggen lukte niet. Start de kassa ' +
            'opnieuw; hij probeert het dan zelf nog een keer.',
        }
      }

      set({ busy: false, error: null })
      return uitslag
    } catch (e) {
      const reden = e instanceof Error ? e.message : 'Koppelen mislukte.'
      set({ busy: false, error: reden })
      return { ok: false, reden }
    }
  },

  login: async (email, password) => {
    if (backendError) {
      set({ error: backendError })
      return false
    }

    set({ busy: true, error: null })
    try {
      let userId: string | null = null

      try {
        const res = await api.login(email, password)
        if (!res) {
          set({ error: 'E-mailadres of wachtwoord klopt niet.', busy: false })
          return false
        }
        userId = res.userId
        await storageSet(SESSION_KEY, JSON.stringify({ userId, at: Date.now() }))
        await rememberOfflineLogin(email, password, userId)
        await cacheKlaarzetten(userId)

        if (res.profile) await db.users.put(res.profile as unknown as User)
        setSyncEnabled(true)

        /*
         * Hier wachten we wél op de eerste synchronisatie, anders dan in het
         * dashboard. Een kassa zonder artikelen en zonder personeel is geen
         * kassa, en dit gebeurt één keer bij het inrichten -- niet elke
         * ochtend.
         */
        await useSync.getState().sync({ silent: true })
      } catch {
        // Geen verbinding: terugvallen op wat dit apparaat eerder leerde.
        userId = await verifyOfflineLogin(email, password)
        if (!userId) {
          set({
            error:
              'Geen verbinding, en deze kassa is nog niet eerder met dit account ' +
              'ingericht. Richt hem één keer met internet in.',
            busy: false,
          })
          return false
        }
        await storageSet(SESSION_KEY, JSON.stringify({ userId, at: Date.now() }))
        setSyncEnabled(true)
      }

      const user = await db.users.get(userId)
      if (!user) {
        set({
          error:
            'Inloggen lukte, maar er hangt geen dossier aan dit account. Bij een ' +
            'gekoppelde kassa hoort dat er te zijn: laat het kantoor dit apparaat ' +
            'intrekken en opnieuw koppelen met een nieuwe code.',
          busy: false,
        })
        return false
      }
      if (!user.active) {
        await storageRemove(SESSION_KEY)
        await supabaseSignOut()
        setSyncEnabled(false)
        set({ error: 'Dit account is geblokkeerd. Neem contact op met het kantoor.', busy: false })
        return false
      }

      set({ apparaat: user, busy: false, error: null })
      return true
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Inloggen mislukt', busy: false })
      return false
    }
  },

  ontkoppel: async (opties) => {
    /*
     * De volgorde is niet vrij.
     *
     * Eerst wissen, en dan pas de sessie weggooien: wisApparaat kan nog willen
     * versturen (bij een intrekking) en dat kan niet meer zonder sessie. En als
     * wissen wordt geweigerd omdat er nog een wachtrij staat, moet de kassa
     * gewoon door kunnen -- dan is er niets gebeurd.
     */
    const uitslag = await wisApparaat({ forceren: opties?.forceren })
    if (!uitslag.ok) return uitslag

    setSyncEnabled(false)
    await storageRemove(SESSION_KEY)
    await supabaseSignOut()
    set({ apparaat: null, operator: null, error: null })
    return { ok: true }
  },

  logout: async () => {
    setSyncEnabled(false)
    await storageRemove(SESSION_KEY)
    await supabaseSignOut()
    set({ apparaat: null, operator: null, error: null })
  },

  /* ---------------- de medewerker ---------------- */

  meldAan: async (nummer) => {
    const uitslag = await herkenOpNummer(nummer)
    if (uitslag.ok) {
      set({ operator: uitslag.user, laatsteActie: Date.now() })
      return { ok: true }
    }

    const fout =
      uitslag.reden === 'geblokkeerd'
        ? `Te vaak misgetoetst. Probeer het over ${
            Math.ceil((uitslag.wachtMs ?? 0) / 1000)} seconden weer.`
        : uitslag.reden === 'inactief'
          ? 'Deze medewerker staat niet meer op de loonlijst.'
          : uitslag.reden === 'dubbel'
            // Dit is geen fout van wie er staat, dus zeggen we wat er aan de
            // hand is en waar het rechtgezet wordt.
            ? `Dit nummer staat bij meer dan één medewerker (${
                (uitslag.namen ?? []).join(', ')}). Laat het in het dashboard ` +
              'onder Personeel rechtzetten; zolang het dubbel staat, komt de ' +
              'bon op de verkeerde naam.'
            : 'Dat personeelsnummer is niet bekend op deze vestiging.'

    return { ok: false, fout }
  },

  meldAanMetBadge: async (token) => {
    const uitslag = await herkenBadge(token)
    if (uitslag.ok) {
      set({ operator: uitslag.user, laatsteActie: Date.now() })
      return { ok: true }
    }
    return {
      ok: false,
      fout: uitslag.reden === 'inactief'
        ? 'Deze medewerker staat niet meer op de loonlijst.'
        : 'Deze badge is niet bekend.',
    }
  },

  meldAf: () => set({ operator: null }),

  raakAan: () => {
    if (get().operator) set({ laatsteActie: Date.now() })
  },
}))

/**
 * Zet de klok die de medewerker afmeldt na een tijd stilte.
 *
 * Bewust niet op elke muisbeweging kijken maar één keer per tien seconden: de
 * kassa heeft zijn rekenkracht nodig voor het scherm, niet voor het bijhouden
 * van hoe stil het is.
 */
export function startAfmeldKlok() {
  setInterval(() => {
    const { operator, laatsteActie, meldAf } = useAuth.getState()
    if (operator && Date.now() - laatsteActie > AFMELD_NA_MS) meldAf()
  }, 10_000)
}
