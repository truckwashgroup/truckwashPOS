import type { DeelBetaling, MandjeRegel } from './types'

/* ------------------------------------------------------------------ *
 *  Rekenen met geld
 *
 *  Alle bedragen in de kassa zijn euro's met twee decimalen. In JavaScript is
 *  0.1 + 0.2 niet 0.3, dus elke tussenstap wordt hier op centen afgerond. Doe
 *  je dat niet, dan klopt de bon wel op het scherm maar mist de kas aan het
 *  eind van de dag een cent -- en dan ga je zoeken in de verkeerde hoek.
 *
 *  Twee regels waar de rest uit volgt:
 *
 *  1. De prijs inclusief btw is de waarheid. Dat is wat op het bord staat en
 *     wat er gepind wordt. Het bedrag exclusief en de btw rekenen we eruit
 *     terug, zo dat exclusief + btw altijd precies inclusief is.
 *
 *  2. Afronden gebeurt per regel, niet pas aan het eind. Anders kan een bon
 *     met tien regels een cent afwijken van de tien losse bedragen die de
 *     klant ziet staan.
 * ------------------------------------------------------------------ */

/**
 * Afronden op hele centen.
 *
 * De epsilon vangt de gevallen waarin een deling net onder de helft uitkomt
 * terwijl hij er wiskundig precies op zit: 1.005 wordt in binaire vorm
 * 1.00499999..., en zou zonder deze correctie naar beneden gaan.
 */
export function centen(bedrag: number): number {
  if (!Number.isFinite(bedrag)) return 0
  const teken = bedrag < 0 ? -1 : 1
  return teken * Math.round(Math.abs(bedrag) * 100 + Number.EPSILON * 100) / 100
}

/** Het btw-bedrag dat in een prijs inclusief btw zit. */
export function btwUitIncl(incl: number, pct: number): number {
  if (!pct) return 0
  return centen(incl - incl / (1 + pct / 100))
}

/**
 * Een bedrag inclusief btw uiteengelegd.
 *
 * `excl + btw` is hier altijd exact `incl` -- niet bij benadering. Daarom
 * wordt excl afgeleid van de btw en niet zelf afgerond: twee losse
 * afrondingen kunnen samen een cent naast het totaal uitkomen.
 */
export function splits(incl: number, pct: number): { incl: number; excl: number; btw: number } {
  const afgerond = centen(incl)
  const btw = btwUitIncl(afgerond, pct)
  return { incl: afgerond, excl: centen(afgerond - btw), btw }
}

/** Wat één regel op de bon kost, na korting. */
export function regelTotaal(regel: Pick<MandjeRegel, 'qty' | 'priceIncl' | 'discountPct'>) {
  const bruto = regel.qty * regel.priceIncl
  const korting = (regel.discountPct || 0) / 100
  return centen(bruto * (1 - korting))
}

/** Hoeveel korting er op een regel is gegeven. */
export function regelKorting(regel: Pick<MandjeRegel, 'qty' | 'priceIncl' | 'discountPct'>) {
  return centen(centen(regel.qty * regel.priceIncl) - regelTotaal(regel))
}

export interface BonTotalen {
  incl: number
  excl: number
  btw: number
  korting: number
  /** Per btw-tarief, want dat moet op de bon staan. */
  staffel: { pct: number; incl: number; excl: number; btw: number }[]
}

/** De totalen van een heel mandje. */
export function bonTotalen(regels: MandjeRegel[]): BonTotalen {
  const perTarief = new Map<number, { incl: number; excl: number; btw: number }>()
  let incl = 0
  let excl = 0
  let btw = 0
  let korting = 0

  for (const r of regels) {
    const regelIncl = regelTotaal(r)
    const deel = splits(regelIncl, r.vatPct)

    incl = centen(incl + deel.incl)
    excl = centen(excl + deel.excl)
    btw = centen(btw + deel.btw)
    korting = centen(korting + regelKorting(r))

    const staffel = perTarief.get(r.vatPct) ?? { incl: 0, excl: 0, btw: 0 }
    staffel.incl = centen(staffel.incl + deel.incl)
    staffel.excl = centen(staffel.excl + deel.excl)
    staffel.btw = centen(staffel.btw + deel.btw)
    perTarief.set(r.vatPct, staffel)
  }

  return {
    incl, excl, btw, korting,
    staffel: [...perTarief.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([pct, s]) => ({ pct, ...s })),
  }
}

/* ------------------------------------------------------------------ *
 *  Contant afronden
 *
 *  Nederland gebruikt geen munten van één en twee cent. Een contante
 *  betaling gaat naar het naaste veelvoud van vijf cent; pinnen niet. Het
 *  verschil hoort zichtbaar op de bon, want de omzet blijft het onafgeronde
 *  bedrag -- de afronding is een aparte post.
 * ------------------------------------------------------------------ */

export function afrondenContant(bedrag: number): { teBetalen: number; verschil: number } {
  const teBetalen = centen(Math.round(centen(bedrag) * 20) / 20)
  return { teBetalen, verschil: centen(teBetalen - centen(bedrag)) }
}

/* ------------------------------------------------------------------ *
 *  Wisselgeld
 * ------------------------------------------------------------------ */

/** De briefjes en munten die er zijn, van groot naar klein. */
export const COUPURES = [50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05] as const

/**
 * Hoe je een bedrag wisselgeld uitbetaalt.
 *
 * Niet omdat de kassa het moet weten, maar omdat het naast de kassa staat en
 * voorkomt dat iemand staat te rekenen met een rij achter zich.
 */
export function wisselgeld(bedrag: number): { coupure: number; aantal: number }[] {
  let rest = centen(bedrag)
  const uit: { coupure: number; aantal: number }[] = []
  for (const c of COUPURES) {
    const aantal = Math.floor(centen(rest) / c + 1e-9)
    if (aantal > 0) {
      uit.push({ coupure: c, aantal })
      rest = centen(rest - aantal * c)
    }
  }
  return uit
}

/* ------------------------------------------------------------------ *
 *  Betalingen bij elkaar
 * ------------------------------------------------------------------ */

export function betaald(betalingen: DeelBetaling[]): number {
  return betalingen.reduce((som, b) => centen(som + b.amount), 0)
}

/** Wat er nog open staat. Nooit negatief: te veel contant is wisselgeld. */
export function openstaand(teBetalen: number, betalingen: DeelBetaling[]): number {
  return Math.max(0, centen(centen(teBetalen) - betaald(betalingen)))
}

/**
 * De betaalwijze zoals hij op de bon komt.
 *
 * Eén betaling is die betaling; meer dan één is 'gemengd'. Dat laatste komt
 * vaker voor dan je denkt: een chauffeur die de was op de rekening zet en de
 * koffie contant afrekent.
 */
export function betaalwijze(betalingen: DeelBetaling[]): DeelBetaling['method'] | 'gemengd' | undefined {
  // Een kaartbetaling is nul euro en telt toch mee: dat is de betaalwijze.
  const soorten = new Set(
    betalingen
      .filter((b) => b.amount !== 0 || b.method === 'abonnement')
      .map((b) => b.method))
  if (soorten.size === 0) return undefined
  if (soorten.size === 1) return [...soorten][0]
  return 'gemengd'
}
