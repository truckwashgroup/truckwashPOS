import type { TerminalConfig } from '../types'

/* ------------------------------------------------------------------ *
 *  De pinautomaat
 *
 *  Twee manieren, en de kassa gaat met beide om:
 *
 *  Handmatig  De kassa laat het bedrag groot in beeld zien, iemand toetst het
 *             op de pinautomaat in, en bevestigt hier dat het gelukt is. Het
 *             bonnummer van de pinautomaat kan erbij, zodat de betaling later
 *             terug te vinden is.
 *
 *  Gekoppeld  De kassa stuurt het bedrag naar de terminal en wacht op het
 *             antwoord. Daarvoor zijn gegevens van de betaalprovider nodig;
 *             zolang die er niet zijn valt de kassa terug op handmatig en
 *             zegt hij waarom.
 *
 *  Belangrijk bij beide: pinnen mislukt soms, en dan moet de bon door kunnen.
 *  Een geweigerde betaling is hier dus geen fout maar een antwoord.
 * ------------------------------------------------------------------ */

export interface PinResultaat {
  ok: boolean
  /** De kassa moet zelf om bevestiging vragen. */
  handmatig?: boolean
  /** Bonnummer of transactiecode van de terminal. */
  ref?: string
  /** Maestro, VPay, Mastercard... */
  brand?: string
  reden?: string
}

const gekoppeld = (): boolean =>
  typeof window !== 'undefined' && Boolean(window.desktop?.isElectron)

/**
 * Start een pinbetaling.
 *
 * Bij 'handmatig' komt hier meteen een antwoord met `handmatig: true` terug --
 * de kassa vraagt dan zelf om bevestiging. Bij een echte koppeling wacht dit
 * op de terminal.
 */
export async function pinnen(opts: {
  bedrag: number
  config: TerminalConfig
  bonnummer?: string
}): Promise<PinResultaat> {
  const provider = opts.config?.provider ?? 'handmatig'

  if (provider === 'handmatig' || !gekoppeld()) {
    return { ok: true, handmatig: true }
  }

  try {
    const antwoord = await window.desktop!.pinBetaling({
      provider,
      bedrag: opts.bedrag,
      host: opts.config.host,
      port: opts.config.port,
      terminalId: opts.config.terminalId,
      bonnummer: opts.bonnummer,
    })
    return antwoord as PinResultaat
  } catch (e) {
    return {
      ok: false,
      handmatig: true,
      reden: e instanceof Error ? e.message : String(e),
    }
  }
}

/** Een lopende betaling afbreken, bijvoorbeeld omdat de chauffeur contant betaalt. */
export async function afbreken(config: TerminalConfig): Promise<PinResultaat> {
  const provider = config?.provider ?? 'handmatig'
  if (provider === 'handmatig' || !gekoppeld()) return { ok: true }
  try {
    return (await window.desktop!.pinAfbreken({
      provider, host: config.host, port: config.port, terminalId: config.terminalId,
    })) as PinResultaat
  } catch (e) {
    return { ok: false, reden: e instanceof Error ? e.message : String(e) }
  }
}

export const TERMINAL_LABELS: Record<TerminalConfig['provider'], string> = {
  handmatig: 'Met de hand intoetsen',
  ccv: 'CCV',
  adyen: 'Adyen',
  sumup: 'SumUp',
}
