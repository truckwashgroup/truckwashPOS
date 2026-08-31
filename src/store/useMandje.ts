import { create } from 'zustand'
import { db, getMeta, setMeta, uid } from '../lib/db'
import { bonTotalen, type BonTotalen } from '../lib/geld'
import { SERVICES } from '../lib/types'
import type { MandjeRegel, PosProduct, WashJob } from '../lib/types'

/* ------------------------------------------------------------------ *
 *  Het mandje
 *
 *  Wat er nu op de toonbank ligt. Geen tabel in de database -- zolang er niet
 *  is afgerekend hoort het bij dit apparaat en bij deze chauffeur.
 *
 *  Wel bewaren we het lokaal, na elke wijziging. Een kassa die halverwege
 *  uitvalt of een app die opnieuw laadt hoort niet met een leeg scherm terug
 *  te komen terwijl er een halve bon lag.
 * ------------------------------------------------------------------ */

const MANDJE_KEY = 'mandje'

interface Bewaard {
  regels: MandjeRegel[]
  klantId?: string
  klantNaam?: string
  kenteken?: string
  hervatId?: string
}

interface MandjeStore extends Bewaard {
  totalen: BonTotalen

  herstel: () => Promise<void>
  productToevoegen: (product: PosProduct, aantal?: number) => void
  vrijeRegelToevoegen: (opts: { naam: string; prijsIncl: number; btwPct: number }) => void
  wasopdrachtToevoegen: (job: WashJob, prijsIncl?: number) => void
  aantalZetten: (regelId: string, aantal: number) => void
  kortingZetten: (regelId: string, pct: number) => void
  prijsZetten: (regelId: string, prijsIncl: number) => void
  regelVerwijderen: (regelId: string) => void
  klantZetten: (klant: { id?: string; naam?: string }) => void
  kentekenZetten: (kenteken: string) => void
  regelsZetten: (regels: MandjeRegel[], extra?: Partial<Bewaard>) => void
  legen: () => void
}

function opnieuwRekenen(regels: MandjeRegel[]): BonTotalen {
  return bonTotalen(regels)
}

export const useMandje = create<MandjeStore>((set, get) => {
  /** Bewaren mag achterlopen; rekenen niet. */
  function bewaar() {
    const { regels, klantId, klantNaam, kenteken, hervatId } = get()
    void setMeta(MANDJE_KEY, { regels, klantId, klantNaam, kenteken, hervatId })
  }

  function zet(regels: MandjeRegel[], extra: Partial<Bewaard> = {}) {
    set({ regels, totalen: opnieuwRekenen(regels), ...extra })
    bewaar()
  }

  return {
    regels: [],
    totalen: opnieuwRekenen([]),

    herstel: async () => {
      const bewaard = await getMeta<Bewaard | null>(MANDJE_KEY, null)
      if (!bewaard?.regels?.length) return
      set({
        regels: bewaard.regels,
        klantId: bewaard.klantId,
        klantNaam: bewaard.klantNaam,
        kenteken: bewaard.kenteken,
        hervatId: bewaard.hervatId,
        totalen: opnieuwRekenen(bewaard.regels),
      })
    },

    productToevoegen: (product, aantal = 1) => {
      const regels = [...get().regels]

      /*
       * Hetzelfde artikel nog een keer? Dan hoogt het aantal op in plaats van
       * dat er een tweede regel bij komt. Behalve als het een kaart of
       * abonnement is: daarvan wordt er per stuk één aangemaakt met zijn eigen
       * code, dus die horen apart te staan zodat je ze los kunt weghalen.
       */
      const samenvoegen = product.kind === 'artikel' || product.kind === 'overig'
      const bestaand = samenvoegen
        ? regels.find((r) => r.productId === product.id && !r.discountPct && !r.washJobId)
        : undefined

      if (bestaand) {
        bestaand.qty += aantal
      } else {
        regels.push({
          id: uid('m'),
          productId: product.id,
          name: product.name,
          kind: product.kind,
          qty: aantal,
          priceIncl: product.priceIncl,
          vatPct: product.vatPct,
          discountPct: 0,
          credits: product.credits,
          validDays: product.validDays,
          washService: product.washService,
          inventoryItemId: product.inventoryItemId,
        })
      }

      zet(regels)
    },

    vrijeRegelToevoegen: ({ naam, prijsIncl, btwPct }) => {
      zet([...get().regels, {
        id: uid('m'),
        name: naam,
        kind: 'overig',
        qty: 1,
        priceIncl: prijsIncl,
        vatPct: btwPct,
        discountPct: 0,
      }])
    },

    /**
     * Een wasopdracht uit de wasstraat-app op de bon zetten.
     *
     * De prijs in de wasstraat-app is exclusief btw (zo staat hij in
     * wash_jobs), en de kassa rekent met inclusief. Die omrekening gebeurt
     * hier, en niet ergens onderweg -- anders staat er straks een bon met een
     * cent verschil op het prijskaartje.
     */
    wasopdrachtToevoegen: (job, prijsIncl) => {
      const dienst = SERVICES[job.service]
      const incl = prijsIncl ?? Math.round(job.priceExcl * 1.21 * 100) / 100

      zet([...get().regels, {
        id: uid('m'),
        name: `${dienst?.label ?? job.service} — ${job.plate}`,
        kind: 'wasbeurt',
        qty: 1,
        priceIncl: incl,
        vatPct: 21,
        discountPct: 0,
        washJobId: job.id,
        washService: job.service,
      }], {
        kenteken: get().kenteken || job.plate,
        klantId: get().klantId || job.companyId,
        klantNaam: get().klantNaam || job.companyName,
      })
    },

    aantalZetten: (regelId, aantal) => {
      const regels = get().regels
        .map((r) => (r.id === regelId ? { ...r, qty: aantal } : r))
        // Op nul zetten is hetzelfde als weghalen; dat is wat iemand bedoelt
        // die drie keer op min drukt.
        .filter((r) => r.qty > 0)
      zet(regels)
    },

    kortingZetten: (regelId, pct) => {
      const begrensd = Math.max(0, Math.min(100, pct))
      zet(get().regels.map((r) => (r.id === regelId ? { ...r, discountPct: begrensd } : r)))
    },

    prijsZetten: (regelId, prijsIncl) => {
      zet(get().regels.map((r) =>
        (r.id === regelId ? { ...r, priceIncl: Math.max(0, prijsIncl) } : r)))
    },

    regelVerwijderen: (regelId) => {
      zet(get().regels.filter((r) => r.id !== regelId))
    },

    klantZetten: (klant) => {
      set({ klantId: klant.id, klantNaam: klant.naam })
      bewaar()
    },

    kentekenZetten: (kenteken) => {
      set({ kenteken: kenteken.toUpperCase().trim() })
      bewaar()
    },

    regelsZetten: (regels, extra) => zet(regels, extra),

    legen: () => {
      set({
        regels: [], totalen: opnieuwRekenen([]),
        klantId: undefined, klantNaam: undefined,
        kenteken: undefined, hervatId: undefined,
      })
      void setMeta(MANDJE_KEY, null)
    },
  }
})

/**
 * Zoekt een artikel bij een gescande barcode.
 *
 * Onbekende barcode geeft null terug en niet een lege regel. Een kassa die
 * "onbekend artikel, 0 euro" op de bon zet is erger dan een kassa die piept.
 */
export async function productBijBarcode(
  barcode: string,
  locationId?: string,
): Promise<PosProduct | null> {
  const code = barcode.trim()
  if (!code) return null

  const treffers = await db.products.where('barcode').equals(code).toArray()
  const bruikbaar = treffers.filter((p) =>
    p.active && (!p.locationId || !locationId || p.locationId === locationId))

  // Staat hij ook op artikelnummer? Dan mag dat ook; scanners lezen soms een
  // intern label in plaats van een EAN.
  if (!bruikbaar.length) {
    const opCode = await db.products.where('code').equals(code).toArray()
    return opCode.find((p) =>
      p.active && (!p.locationId || !locationId || p.locationId === locationId)) ?? null
  }

  // Een artikel van deze vestiging gaat voor het algemene.
  return bruikbaar.sort((a, b) => Number(Boolean(b.locationId)) - Number(Boolean(a.locationId)))[0]
}
