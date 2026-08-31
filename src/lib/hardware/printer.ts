import { alsTekst, bonOpmaken, type BonGegevens, type BonOpdracht } from '../bon'
import type { PrinterConfig } from '../types'

/* ------------------------------------------------------------------ *
 *  De bonprinter, van de kant van de app
 *
 *  Het echte werk (ESC/POS-bytes, TCP, Windows-share) gebeurt in
 *  electron/escpos.cjs. Een webpagina kan namelijk geen netwerkpoort openen,
 *  en dat hoort ook zo te blijven. Dit bestand is de brug ernaartoe.
 *
 *  Op een tablet is er geen brug. Daar kan de bon wel op het scherm en kan de
 *  chauffeur meelezen; afdrukken vraagt een bluetooth-printer, en dat is een
 *  ander verhaal dan dit.
 * ------------------------------------------------------------------ */

interface DesktopBrug {
  isElectron: true
  platform: string
  getVersion(): Promise<string>
  checkForUpdates(): Promise<{ ok: boolean; reason?: string }>
  installUpdate(): Promise<void>
  onUpdateStatus(cb: (p: any) => void): () => void
  notify?(title: string, body: string): Promise<boolean>
  printBon(o: BonOpdracht[], p: PrinterConfig, ladeOpen: boolean): Promise<PrintResultaat>
  proefBon(p: PrinterConfig): Promise<PrintResultaat>
  openLade(p: PrinterConfig): Promise<PrintResultaat>
  pinBetaling(o: unknown): Promise<any>
  pinAfbreken(o: unknown): Promise<any>
  /* Muziek. Zie hardware/muziek.ts; die controleert zelf of het er is, want
     op een tablet bestaat deze brug niet. */
  muziekZoeken?(): Promise<any>
  muziekStand?(apparaat: unknown): Promise<any>
  muziekBesturen?(apparaat: unknown, actie: string, waarde?: unknown): Promise<any>
}

declare global {
  interface Window { desktop?: DesktopBrug }
}

export interface PrintResultaat {
  ok: boolean
  reden?: string
}

export const kanAfdrukken = (): boolean =>
  typeof window !== 'undefined' && Boolean(window.desktop?.isElectron)

const GEEN_BRUG: PrintResultaat = {
  ok: false,
  reden: 'Afdrukken kan alleen op de Windows-kassa. Laat de bon op het scherm zien, ' +
         'of mail hem later vanuit het dashboard.',
}

/** Drukt een bon af. Geeft nooit een fout, altijd een antwoord. */
export async function printBon(
  gegevens: BonGegevens,
  printer: PrinterConfig,
  opties: { ladeOpen?: boolean } = {},
): Promise<PrintResultaat> {
  if (!kanAfdrukken()) return GEEN_BRUG
  if (printer.kind === 'geen') {
    return { ok: false, reden: 'Er is voor deze kassa geen bonprinter ingesteld.' }
  }

  try {
    return await window.desktop!.printBon(
      bonOpmaken(gegevens),
      printer,
      Boolean(opties.ladeOpen && printer.ladeViaPrinter !== false),
    )
  } catch (e) {
    return { ok: false, reden: e instanceof Error ? e.message : String(e) }
  }
}

export async function proefBon(printer: PrinterConfig): Promise<PrintResultaat> {
  if (!kanAfdrukken()) return GEEN_BRUG
  try {
    return await window.desktop!.proefBon(printer)
  } catch (e) {
    return { ok: false, reden: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * De lade opendrukken.
 *
 * Ook los van een bon nodig: wisselgeld halen, een afstorting doen, of de
 * dagafsluiting. Daarom staat het hier apart en niet alleen als bijwerking van
 * het afdrukken.
 */
export async function openLade(printer: PrinterConfig): Promise<PrintResultaat> {
  if (!kanAfdrukken()) return GEEN_BRUG
  if (printer.kind === 'geen') {
    return {
      ok: false,
      reden: 'De lade hangt aan de bonprinter, en die is niet ingesteld.',
    }
  }
  try {
    return await window.desktop!.openLade(printer)
  } catch (e) {
    return { ok: false, reden: e instanceof Error ? e.message : String(e) }
  }
}

/** De bon als platte tekst, voor het scherm. */
export function bonAlsTekst(gegevens: BonGegevens, breedte = 42): string {
  return alsTekst(bonOpmaken(gegevens), breedte)
}
