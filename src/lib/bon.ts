import { db } from './db'
import { splits } from './geld'
import type { Location, PosPayment, PosSale, PosSaleLine } from './types'
import { PAY_LABELS } from './types'

/* ------------------------------------------------------------------ *
 *  De bon opmaken
 *
 *  Eén opmaak, twee bestemmingen: het scherm en de bonprinter. Die twee mogen
 *  niet uit elkaar lopen -- wat de klant op het scherm ziet en wat er uit de
 *  printer komt hoort hetzelfde te zijn, inclusief de centen.
 *
 *  Daarom levert dit bestand geen tekst maar een lijstje opdrachten. Het
 *  scherm zet ze om in regels tekst, de printer in ESC/POS-bytes. Wie de
 *  opmaak wil veranderen, doet dat hier één keer.
 *
 *  Wat er verplicht op een bon staat (Belastingdienst, kleine ondernemer):
 *  wie de verkoper is, de datum, wat er verkocht is, het bedrag, en de btw
 *  uitgesplitst per tarief. Dat laatste is de reden dat de staffel er staat
 *  ook als er maar één tarief op de bon voorkomt.
 * ------------------------------------------------------------------ */

export type BonOpdracht =
  | { soort: 'midden'; tekst: string; groot?: boolean; vet?: boolean }
  | { soort: 'links'; tekst: string; vet?: boolean }
  | { soort: 'paar'; links: string; rechts: string; vet?: boolean }
  | { soort: 'streep' }
  | { soort: 'leeg' }
  | { soort: 'qr'; data: string; onder?: string }

export interface BonGegevens {
  bon: PosSale
  regels: PosSaleLine[]
  betalingen: PosPayment[]
  locatie?: Location
  /** Kaarten die op deze bon verkocht zijn; hun code komt op de bon. */
  kaarten?: { code: string; kind: string; credits: number }[]
  /** Een tweede afdruk is geen nieuwe bon; dat hoort erop te staan. */
  kopie?: boolean
}

const geld = (n: number) => {
  const teken = n < 0 ? '-' : ''
  return teken + Math.abs(n).toFixed(2).replace('.', ',')
}

const aantal = (n: number) =>
  Number.isInteger(n) ? String(n) : n.toFixed(2).replace('.', ',')

function datumTijd(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}`
}

/* ------------------------------------------------------------------ */

export function bonOpmaken(g: BonGegevens): BonOpdracht[] {
  const { bon, regels, betalingen } = g
  const uit: BonOpdracht[] = []

  /* ---- kop ---- */
  uit.push({ soort: 'midden', tekst: 'TRUCKWASH1 GROUP', groot: true, vet: true })
  if (g.locatie) {
    uit.push({ soort: 'midden', tekst: g.locatie.name })
    uit.push({ soort: 'midden', tekst: g.locatie.address })
    uit.push({ soort: 'midden', tekst: `${g.locatie.postcode} ${g.locatie.city}` })
    if (g.locatie.phone) uit.push({ soort: 'midden', tekst: g.locatie.phone })
  }
  uit.push({ soort: 'leeg' })

  if (bon.creditOf) {
    uit.push({ soort: 'midden', tekst: 'CREDITBON', groot: true, vet: true })
    uit.push({ soort: 'leeg' })
  }
  if (g.kopie) {
    uit.push({ soort: 'midden', tekst: '** KOPIE **', vet: true })
    uit.push({ soort: 'leeg' })
  }

  /* ---- wie, wat, wanneer ---- */
  uit.push({ soort: 'paar', links: 'Bon', rechts: bon.receiptNo || '(niet afgerekend)' })
  uit.push({ soort: 'paar', links: 'Datum', rechts: datumTijd(bon.closedAt ?? bon.openedAt) })
  uit.push({ soort: 'paar', links: 'Kassa', rechts: bon.registerCode })
  uit.push({ soort: 'paar', links: 'Medewerker', rechts: bon.operatorName })
  if (bon.customerName) uit.push({ soort: 'paar', links: 'Klant', rechts: bon.customerName })
  if (bon.plate) uit.push({ soort: 'paar', links: 'Kenteken', rechts: bon.plate })

  uit.push({ soort: 'streep' })

  /* ---- de regels ---- */
  for (const r of regels) {
    const korting = r.discountPct ? ` -${r.discountPct}%` : ''
    if (r.qty === 1 && !korting) {
      uit.push({ soort: 'paar', links: r.name, rechts: geld(r.totalIncl) })
    } else {
      uit.push({ soort: 'links', tekst: r.name })
      uit.push({
        soort: 'paar',
        links: `  ${aantal(r.qty)} x ${geld(r.priceIncl)}${korting}`,
        rechts: geld(r.totalIncl),
      })
    }
    if (r.note) uit.push({ soort: 'links', tekst: `  ${r.note}` })
  }

  uit.push({ soort: 'streep' })

  /* ---- totalen ---- */
  if (bon.discountIncl) {
    uit.push({ soort: 'paar', links: 'Korting', rechts: geld(-bon.discountIncl) })
  }
  uit.push({
    soort: 'paar',
    links: 'TOTAAL',
    rechts: geld(bon.totalIncl + bon.rounding),
    vet: true,
  })
  if (bon.rounding) {
    uit.push({ soort: 'paar', links: 'Afronding contant', rechts: geld(bon.rounding) })
    uit.push({ soort: 'paar', links: 'Waarvan omzet', rechts: geld(bon.totalIncl) })
  }

  /* ---- btw per tarief ---- */
  const staffel = new Map<number, { excl: number; btw: number }>()
  for (const r of regels) {
    const deel = splits(r.totalIncl, r.vatPct)
    const s = staffel.get(r.vatPct) ?? { excl: 0, btw: 0 }
    s.excl += deel.excl
    s.btw += deel.btw
    staffel.set(r.vatPct, s)
  }

  uit.push({ soort: 'leeg' })
  uit.push({ soort: 'links', tekst: 'BTW-specificatie' })
  for (const [pct, s] of [...staffel.entries()].sort((a, b) => b[0] - a[0])) {
    uit.push({
      soort: 'paar',
      links: `  ${pct}% over ${geld(s.excl)}`,
      rechts: geld(s.btw),
    })
  }
  uit.push({ soort: 'paar', links: 'Totaal excl. btw', rechts: geld(bon.totalExcl) })

  /* ---- betaald ---- */
  uit.push({ soort: 'streep' })
  for (const b of betalingen) {
    uit.push({ soort: 'paar', links: PAY_LABELS[b.method], rechts: geld(b.amount) })
    if (b.method === 'contant' && b.received != null) {
      uit.push({ soort: 'paar', links: '  Ontvangen', rechts: geld(b.received) })
      if (b.changeGiven) {
        uit.push({ soort: 'paar', links: '  Wisselgeld', rechts: geld(b.changeGiven) })
      }
    }
    if (b.method === 'pin' && b.terminalRef) {
      uit.push({ soort: 'links', tekst: `  ${b.cardBrand ?? 'Pin'} — ${b.terminalRef}` })
    }
  }

  if (bon.method === 'op-rekening') {
    uit.push({ soort: 'leeg' })
    uit.push({ soort: 'links', tekst: 'Op rekening. U ontvangt hiervoor een factuur.' })
  }

  /* ---- verkochte kaarten ---- */
  for (const kaart of g.kaarten ?? []) {
    uit.push({ soort: 'leeg' })
    uit.push({ soort: 'streep' })
    uit.push({
      soort: 'midden',
      tekst: kaart.kind === 'strippenkaart'
        ? `WASKAART — ${kaart.credits} beurten`
        : 'WASABONNEMENT',
      vet: true,
    })
    uit.push({ soort: 'midden', tekst: kaart.code })
    uit.push({ soort: 'qr', data: kaart.code, onder: 'Bewaar deze bon als kaart' })
  }

  /* ---- voet ---- */
  uit.push({ soort: 'leeg' })
  uit.push({ soort: 'midden', tekst: 'Bedankt en goede reis' })
  if (bon.note && !bon.creditOf) uit.push({ soort: 'midden', tekst: bon.note })
  if (bon.creditOf) {
    uit.push({ soort: 'midden', tekst: bon.note ?? 'Creditbon' })
  }
  uit.push({ soort: 'leeg' })

  return uit
}

/* ------------------------------------------------------------------ *
 *  Naar tekst, voor het scherm en voor een printer die alleen tekst kan
 * ------------------------------------------------------------------ */

export function alsTekst(opdrachten: BonOpdracht[], breedte = 42): string {
  const regels: string[] = []

  for (const o of opdrachten) {
    switch (o.soort) {
      case 'leeg':
        regels.push('')
        break
      case 'streep':
        regels.push('-'.repeat(breedte))
        break
      case 'midden': {
        const t = o.tekst.slice(0, breedte)
        const ruimte = Math.max(0, Math.floor((breedte - t.length) / 2))
        regels.push(' '.repeat(ruimte) + t)
        break
      }
      case 'links':
        regels.push(o.tekst.slice(0, breedte))
        break
      case 'paar': {
        const rechts = o.rechts
        const ruimte = breedte - rechts.length
        // Past de linkerkant niet, dan knippen we die af -- het bedrag
        // afknippen zou de bon onbruikbaar maken.
        const links = o.links.length > ruimte - 1
          ? o.links.slice(0, Math.max(0, ruimte - 2)) + '…'
          : o.links
        regels.push(links + ' '.repeat(Math.max(1, breedte - links.length - rechts.length)) + rechts)
        break
      }
      case 'qr':
        regels.push(`[QR ${o.data}]`)
        if (o.onder) regels.push(o.onder)
        break
    }
  }

  return regels.join('\n')
}

/* ------------------------------------------------------------------ *
 *  Ophalen wat er op de bon moet
 * ------------------------------------------------------------------ */

export async function bonGegevens(saleId: string, kopie = false): Promise<BonGegevens | null> {
  const bon = await db.sales.get(saleId)
  if (!bon) return null

  const regels = (await db.saleLines.where('saleId').equals(saleId).toArray())
    .sort((a, b) => a.lineNo - b.lineNo)
  const betalingen = await db.payments.where('saleId').equals(saleId).toArray()
  const locatie = bon.locationId ? await db.locations.get(bon.locationId) : undefined

  const kaarten = (await db.subscriptions.where('soldSaleId').equals(saleId).toArray())
    .map((k) => ({ code: k.code, kind: k.kind, credits: k.creditsTotal }))

  return { bon, regels, betalingen, locatie, kaarten, kopie }
}
