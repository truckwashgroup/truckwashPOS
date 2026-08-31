import type { ApiAdapter } from './types'
import { supabaseApi, supabaseConfigured, configError } from './supabaseApi'

/**
 * De kassa praat met dezelfde database als de wasstraat-app en heeft geen
 * testbackend. Dat is een bewuste keuze: een kassa die "iets" laat zien
 * zonder dat er een administratie achter hangt is gevaarlijker dan een kassa
 * die weigert te starten.
 */
export const api: ApiAdapter = supabaseApi

export const usingSupabase = supabaseConfigured

/** Waarom er niet ingelogd kan worden, of null als alles klopt. */
export const backendError: string | null = supabaseConfigured
  ? null
  : configError ??
    'Er is nog geen verbinding met de database ingesteld. Zet VITE_SUPABASE_URL ' +
    'en VITE_SUPABASE_ANON_KEY in het .env-bestand en start de kassa opnieuw.'

export type { ApiAdapter, PushChange, PullResult } from './types'
export { supabase, supabaseSignOut } from './supabaseApi'
