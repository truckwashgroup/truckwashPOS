import type { EntityName, SyncOp } from '../types'

export interface PushChange {
  entity: EntityName
  op: SyncOp
  recordId: string
  payload: unknown
}

export interface PullResult {
  /** Per entiteit alle records die na `since` zijn gewijzigd */
  changes: Partial<Record<EntityName, unknown[]>>
  serverTime: number
}

/**
 * Elke backend (mock, Supabase, eigen Node-server) implementeert dit.
 * De rest van de app kent alleen deze interface.
 */
export interface ApiAdapter {
  readonly name: string
  /**
   * Retourneert null bij foute inloggegevens.
   *
   * `profile` is het personeelsdossier van deze gebruiker. Door dat meteen
   * mee te geven kan de app direct doorlopen, in plaats van te wachten tot
   * de volledige synchronisatie klaar is.
   */
  login(email: string, password: string): Promise<{
    userId: string
    token: string
    profile?: Record<string, unknown>
  } | null>
  /** Duwt lokale wijzigingen naar de server. Gooit bij netwerkfout. */
  push(changes: PushChange[]): Promise<void>
  /** Haalt serverwijzigingen op sinds timestamp */
  pull(since: number): Promise<PullResult>
  /**
   * Alle id's die dit apparaat op dit moment mag zien voor deze tabel.
   *
   * Nodig omdat pull() alleen vertelt wat er is bijgekomen of gewijzigd, en
   * nooit wat er weg is. Een dossier waarvan de rollen worden weggehaald valt
   * uit het zicht van de kassa -- en bleef daardoor voor altijd in de lokale
   * cache staan, met de oude rollen en de oude vestiging. Zie sync.ts.
   */
  zichtbareIds(entity: EntityName): Promise<string[]>
  /** Snelle bereikbaarheidscheck */
  ping(): Promise<boolean>
}
