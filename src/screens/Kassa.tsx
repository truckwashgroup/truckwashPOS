import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Building2, CreditCard, Droplets, PauseCircle, Percent, Search, Trash2, Truck,
} from 'lucide-react'
import Afrekenen from './Afrekenen'
import { Dialoog, Knop, Leeg, Pil, Regel, Veld } from '../components/ui'
import { db } from '../lib/db'
import {
  artikelFoto, artikelVoorraad, voorraadKaart, voorraadTekst,
} from '../lib/artikel'
import { money } from '../lib/format'
import { regelTotaal } from '../lib/geld'
import { useScanner } from '../lib/hardware/scanner'
import { geparkeerdeBonnen, hervatten, parkeren } from '../lib/kassa'
import { can } from '../lib/permissions'
import { useAuth } from '../store/useAuth'
import { productBijBarcode, useMandje } from '../store/useMandje'
import { toast } from '../store/useToasts'
import type {
  InventoryItem, Company, MandjeRegel, PosProduct, PosRegister, WashJob,
} from '../lib/types'
import { SERVICES } from '../lib/types'

/* ------------------------------------------------------------------ *
 *  De voorraadstand op een tegel
 *
 *  Drie standen, en het verschil ertussen is wat het bruikbaar maakt:
 *  genoeg (grijs, je leest er langs), onder het minimum (geel, er is al om
 *  bijgevuld gevraagd) en leeg (rood, dit kun je niet verkopen).
 * ------------------------------------------------------------------ */

function Voorraadpil({
  product, voorraad,
}: {
  product: PosProduct
  voorraad: Map<string, InventoryItem>
}) {
  const stand = artikelVoorraad(product, voorraad)
  if (!stand) return null

  const soort = stand.leeg ? 'leeg' : stand.onderMinimum ? 'laag' : 'genoeg'

  return (
    <span
      className={`voorraadpil ${soort}`}
      title={stand.onderMinimum && !stand.leeg
        ? `Onder het minimum van ${stand.minimum} ${stand.eenheid}. ` +
          'Trucksupply heeft daar bericht van.'
        : undefined}
    >
      {voorraadTekst(stand)}
    </span>
  )
}

/* ------------------------------------------------------------------ *
 *  Het kassascherm
 *
 *  Links de bon, rechts wat je erop kunt zetten. Die verhouding is met opzet
 *  vast: aan een kassa moet je altijd kunnen zien wat er op de bon staat, ook
 *  terwijl je zoekt. Een kassa waarbij de bon achter een tabblad zit, laat
 *  mensen dingen dubbel aanslaan.
 * ------------------------------------------------------------------ */

export default function Kassa({ register }: { register: PosRegister }) {
  const { operator, raakAan } = useAuth()
  const mandje = useMandje()
  const [groep, setGroep] = useState<string>('alles')
  const [zoek, setZoek] = useState('')
  const [bewerken, setBewerken] = useState<MandjeRegel | null>(null)
  const [afrekenen, setAfrekenen] = useState(false)
  const [klantKiezen, setKlantKiezen] = useState(false)
  const [geparkeerdOpen, setGeparkeerdOpen] = useState(false)

  const artikelen = useLiveQuery(async () => {
    const alles = await db.products.toArray()
    return alles
      .filter((p) =>
        p.active &&
        (!p.locationId || !register.locationId || p.locationId === register.locationId))
      .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'nl'))
  }, [register.locationId], [] as PosProduct[])

  /** Openstaande wasopdrachten van deze vestiging: die kun je afrekenen. */
  const wasopdrachten = useLiveQuery(async () => {
    const alles = await db.washJobs.toArray()
    return alles
      .filter((j) =>
        (j.status === 'gepland' || j.status === 'wachtrij' || j.status === 'bezig') &&
        (!register.locationId || j.locationId === register.locationId))
      .sort((a, b) => a.scheduledAt - b.scheduledAt)
      .slice(0, 60)
  }, [register.locationId], [] as WashJob[])

  const geparkeerd = useLiveQuery(
    () => geparkeerdeBonnen(register.id), [register.id], [])

  /*
   * De voorraad van deze vestiging, als kaart op id.
   *
   * De kassa las deze tabel al -- verkoop boekt er af -- maar liet er niets
   * van zien. Sinds Trucksupply de artikelen beheert staat de helft van wat
   * de kassa over een artikel weet hier: de foto, de eenheid en de stand.
   */
  const voorraad = useLiveQuery(async () => {
    const alles = await db.inventory.toArray()
    return voorraadKaart(alles.filter((i) =>
      !register.locationId || !i.locationId || i.locationId === register.locationId))
  }, [register.locationId], new Map())

  const groepen = useMemo(() => {
    const namen = new Set(artikelen.map((p) => p.groupName || 'Overig'))
    return ['alles', ...[...namen].sort((a, b) => a.localeCompare(b, 'nl'))]
  }, [artikelen])

  const zichtbaar = useMemo(() => {
    const term = zoek.trim().toLowerCase()
    return artikelen.filter((p) => {
      if (groep !== 'alles' && (p.groupName || 'Overig') !== groep) return false
      if (!term) return true
      return p.name.toLowerCase().includes(term) ||
        p.code.toLowerCase().includes(term) ||
        (p.barcode ?? '').includes(term)
    })
  }, [artikelen, groep, zoek])

  /* ---- scannen ---- */
  useScanner(async (gescand) => {
    raakAan()

    // Een badge is geen artikel; die hoort bij het aanmelden.
    if (gescand.startsWith('TWB-')) return

    // Een waskaart: die gaat mee naar het afrekenen.
    if (gescand.startsWith('TW-')) {
      const kaarten = await db.subscriptions.where('code').equals(gescand).toArray()
      if (kaarten.length) {
        toast.info(`Kaart ${gescand} gevonden — kies bij het afrekenen "Kaart of abonnement".`)
        return
      }
    }

    const product = await productBijBarcode(gescand, register.locationId)
    if (product) {
      mandje.productToevoegen(product)
      return
    }

    toast.warn(`Onbekende code: ${gescand}`)
  }, !bewerken && !afrekenen && !klantKiezen)

  /* ---- handelingen ---- */

  function tik(product: PosProduct) {
    raakAan()
    mandje.productToevoegen(product)
  }

  function wasopdrachtOpBon(job: WashJob) {
    raakAan()
    if (mandje.regels.some((r) => r.washJobId === job.id)) {
      toast.warn('Die wasopdracht staat al op de bon.')
      return
    }
    mandje.wasopdrachtToevoegen(job)
  }

  async function parkeer() {
    if (!operator || !mandje.regels.length) return
    try {
      await parkeren({
        register,
        door: operator,
        regels: mandje.regels,
        klant: { companyId: mandje.klantId, name: mandje.klantNaam },
        plate: mandje.kenteken,
      })
      mandje.legen()
      toast.ok('Bon geparkeerd.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Parkeren lukte niet')
    }
  }

  async function hervat(saleId: string) {
    const uitslag = await hervatten(saleId)
    if (!uitslag) return
    mandje.regelsZetten(uitslag.regels, {
      klantId: uitslag.bon.customerCompanyId,
      klantNaam: uitslag.bon.customerName,
      kenteken: uitslag.bon.plate,
      hervatId: uitslag.bon.id,
    })
    setGeparkeerdOpen(false)
  }

  const magKorting = can(operator, 'pos.discount')
  const totaal = mandje.totalen

  return (
    <div className="kassa">
      {/* ---------------- de bon ---------------- */}
      <div className="bonkant">
        <div className="kop">
          <div style={{ display: 'flex', gap: 8 }}>
            <Knop
              maat="klein"
              onClick={() => setKlantKiezen(true)}
              style={{ flex: 1, justifyContent: 'flex-start' }}
            >
              <Building2 size={16} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {mandje.klantNaam ?? 'Losse rit'}
              </span>
            </Knop>
          </div>
          <input
            className="cijfers"
            placeholder="Kenteken"
            value={mandje.kenteken ?? ''}
            onChange={(e) => mandje.kentekenZetten(e.target.value)}
            style={{
              minHeight: 42, padding: '8px 12px', borderRadius: 10,
              border: '1px solid var(--line)', background: 'var(--bg-2)',
              color: 'var(--text)', textTransform: 'uppercase', letterSpacing: 1,
              userSelect: 'text',
            }}
          />
        </div>

        <div className="regels">
          {mandje.regels.length === 0 ? (
            <Leeg tekst="Nog niets op de bon. Tik een artikel aan of scan een barcode." />
          ) : (
            mandje.regels.map((r) => (
              <div key={r.id} className="bonregel" onClick={() => setBewerken(r)}>
                <div className="naam">{r.name}</div>
                <div className="onder">
                  {r.qty} × {money(r.priceIncl)}
                  {r.discountPct ? ` · ${r.discountPct}% korting` : ''}
                  {` · ${r.vatPct}% btw`}
                </div>
                <div className="prijs bedrag">{money(regelTotaal(r))}</div>
              </div>
            ))
          )}
        </div>

        <div className="voet">
          {totaal.korting > 0 && <Regel label="Korting" waarde={money(-totaal.korting)} />}
          <Regel label="Waarvan btw" waarde={money(totaal.btw)} />
          <Regel label="Te betalen" waarde={money(totaal.incl)} groot />

          <div style={{ display: 'flex', gap: 8 }}>
            <Knop
              maat="klein"
              onClick={() => { mandje.legen(); toast.info('Bon leeggemaakt.') }}
              disabled={!mandje.regels.length}
            >
              <Trash2 size={16} /> Leeg
            </Knop>
            <Knop maat="klein" onClick={parkeer} disabled={!mandje.regels.length}>
              <PauseCircle size={16} /> Parkeren
            </Knop>
            {geparkeerd.length > 0 && (
              <Knop maat="klein" onClick={() => setGeparkeerdOpen(true)}>
                {geparkeerd.length} geparkeerd
              </Knop>
            )}
          </div>

          <Knop
            soort="hoofd"
            maat="groot"
            breed
            onClick={() => setAfrekenen(true)}
            disabled={!mandje.regels.length}
          >
            <CreditCard size={20} /> Afrekenen · {money(totaal.incl)}
          </Knop>
        </div>
      </div>

      {/* ---------------- wat erop kan ---------------- */}
      <div className="keuzekant">
        <div className="kop">
          <div style={{ position: 'relative', flex: '1 1 220px' }}>
            <Search
              size={16}
              style={{
                position: 'absolute', left: 12, top: 15, color: 'var(--text-3)',
                pointerEvents: 'none',
              }}
            />
            <input
              value={zoek}
              onChange={(e) => setZoek(e.target.value)}
              placeholder="Zoek artikel of scan"
              style={{
                width: '100%', minHeight: 46, padding: '10px 12px 10px 36px',
                borderRadius: 11, border: '1px solid var(--line)',
                background: 'var(--bg-2)', color: 'var(--text)', userSelect: 'text',
              }}
            />
          </div>
          <div className="groepen">
            {groepen.map((g) => (
              <button
                key={g}
                type="button"
                className={`groep ${groep === g ? 'aan' : ''}`}
                onClick={() => setGroep(g)}
              >
                {g === 'alles' ? 'Alles' : g}
              </button>
            ))}
            <button
              type="button"
              className={`groep ${groep === '__was' ? 'aan' : ''}`}
              onClick={() => setGroep('__was')}
            >
              <Truck size={14} style={{ verticalAlign: -2, marginRight: 5 }} />
              Wasstraat ({wasopdrachten.length})
            </button>
          </div>
        </div>

        <div className="inhoud">
          {groep === '__was' ? (
            wasopdrachten.length === 0 ? (
              <Leeg tekst="Er staan geen openstaande wasopdrachten voor deze vestiging." />
            ) : (
              <div className="tegels">
                {wasopdrachten.map((j) => (
                  <button
                    key={j.id}
                    type="button"
                    className="tegel wasbeurt"
                    onClick={() => wasopdrachtOpBon(j)}
                  >
                    <div>
                      <div className="naam cijfers">{j.plate}</div>
                      <div className="sub">
                        {SERVICES[j.service]?.label ?? j.service} · {j.companyName}
                      </div>
                    </div>
                    <div className="prijs bedrag">
                      {money(Math.round(j.priceExcl * 1.21 * 100) / 100)}
                    </div>
                  </button>
                ))}
              </div>
            )
          ) : zichtbaar.length === 0 ? (
            <Leeg
              tekst={
                artikelen.length === 0
                  ? 'Er staan nog geen artikelen in de kassa. Voeg ze toe onder Beheer.'
                  : 'Geen artikel gevonden.'
              }
            />
          ) : (
            /*
              Reserveer de fotoruimte alleen als er in deze lijst iets een foto
              heeft.

              Zonder die voorwaarde werd elke tegel zonder foto een lege doos:
              het rooster maakt alle tegels in een rij even hoog, dus stond de
              koffie als een halfleeg vak naast een flesje met een plaatje. En
              wie nog geen enkele foto heeft toegevoegd, hoort er ook geen
              ruimte voor te zien.
            */
            <div className={`tegels ${zichtbaar.some((p) => artikelFoto(p, voorraad)) ? 'fotos' : ''}`}>
              {zichtbaar.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`tegel ${p.kind} ${p.image ? 'metfoto' : ''}`}
                  onClick={() => tik(p)}
                >
                  {/*
                    De foto bovenaan, en de naam blijft eronder staan.
                    Alleen een plaatje zou sneller lijken, maar dan verkoop je
                    de zomerruitenwisservloeistof in januari -- de naam is wat
                    het beslist, de foto is wat het vindt.
                  */}
                  {/*
                    De foto van het product zelf gaat voor; staat die er niet,
                    dan die van het voorraadartikel. Zo staat de foto die
                    Trucksupply toevoegde meteen op het scherm zonder dat
                    iemand hem hier nog eens hoeft te zetten.
                  */}
                  {artikelFoto(p, voorraad) ? (
                    <img className="tegelfoto" src={artikelFoto(p, voorraad)!} alt="" />
                  ) : (
                    <span className="tegelfoto-leeg" aria-hidden="true">
                      {p.name.trim().slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <div>
                    <div className="naam">{p.name}</div>
                    {p.kind === 'strippenkaart' && (
                      <div className="sub">{p.credits ?? 0} beurten</div>
                    )}
                    {p.kind === 'abonnement' && (
                      <div className="sub">{p.validDays ?? 0} dagen</div>
                    )}
                    {p.kind === 'wasbeurt' && (
                      <div className="sub">
                        <Droplets size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
                        wasstraat
                      </div>
                    )}
                  </div>
                  {/*
                    De stand, als dit artikel aan de voorraad hangt.
                    De balie hoeft er niets aan te doen -- Trucksupply krijgt
                    automatisch bericht zodra iets onder het minimum zakt --
                    maar wie iets niet kan verkopen hoort te kunnen zien
                    waarom. Zonder dit is een leeg schap een verrassing bij
                    het afrekenen.
                  */}
                  <div className="tegelvoet">
                    <span className="prijs bedrag">{money(p.priceIncl)}</span>
                    <Voorraadpil product={p} voorraad={voorraad} />
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ---------------- dialogen ---------------- */}

      {bewerken && (
        <RegelBewerken
          regel={bewerken}
          magKorting={magKorting}
          onSluiten={() => setBewerken(null)}
        />
      )}

      {klantKiezen && (
        <KlantKiezen
          onSluiten={() => setKlantKiezen(false)}
          onKies={(c) => {
            mandje.klantZetten(c ? { id: c.id, naam: c.name } : {})
            setKlantKiezen(false)
          }}
        />
      )}

      {geparkeerdOpen && (
        <Dialoog titel="Geparkeerde bonnen" onSluiten={() => setGeparkeerdOpen(false)}>
          <div className="lijst">
            {geparkeerd.map((b) => (
              <button
                key={b.id}
                type="button"
                className="lijstrij"
                onClick={() => void hervat(b.id)}
              >
                <div className="rek">
                  <div className="titel">
                    {b.customerName ?? 'Losse rit'} {b.plate ? `· ${b.plate}` : ''}
                  </div>
                  <div className="onder">
                    {new Date(b.openedAt).toLocaleTimeString('nl-NL', {
                      hour: '2-digit', minute: '2-digit',
                    })} · {b.operatorName}
                  </div>
                </div>
                <span className="bedrag" style={{ fontWeight: 700 }}>{money(b.totalIncl)}</span>
              </button>
            ))}
          </div>
        </Dialoog>
      )}

      {afrekenen && operator && (
        <Afrekenen
          register={register}
          operator={operator}
          onSluiten={() => setAfrekenen(false)}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  Een regel bijstellen
 * ------------------------------------------------------------------ */

function RegelBewerken({
  regel, magKorting, onSluiten,
}: { regel: MandjeRegel; magKorting: boolean; onSluiten: () => void }) {
  const mandje = useMandje()
  const [aantal, setAantal] = useState(String(regel.qty))
  const [korting, setKorting] = useState(String(regel.discountPct))
  const [prijs, setPrijs] = useState(regel.priceIncl.toFixed(2))

  function bewaar() {
    const n = Number(aantal.replace(',', '.'))
    if (Number.isFinite(n) && n > 0) mandje.aantalZetten(regel.id, n)

    const k = Number(korting.replace(',', '.'))
    if (magKorting && Number.isFinite(k)) mandje.kortingZetten(regel.id, k)

    const p = Number(prijs.replace(',', '.'))
    if (magKorting && Number.isFinite(p) && p !== regel.priceIncl) {
      mandje.prijsZetten(regel.id, p)
    }

    onSluiten()
  }

  return (
    <Dialoog
      titel={regel.name}
      onSluiten={onSluiten}
      voet={
        <>
          <Knop
            soort="gevaar"
            onClick={() => { mandje.regelVerwijderen(regel.id); onSluiten() }}
          >
            <Trash2 size={17} /> Van de bon
          </Knop>
          <Knop soort="hoofd" onClick={bewaar}>Klaar</Knop>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Veld label="Aantal">
          <div style={{ display: 'flex', gap: 8 }}>
            <Knop onClick={() => setAantal(String(Math.max(1, Number(aantal) - 1)))}>−</Knop>
            <input
              className="cijfers"
              value={aantal}
              onChange={(e) => setAantal(e.target.value)}
              style={{ textAlign: 'center', flex: 1 }}
            />
            <Knop onClick={() => setAantal(String(Number(aantal) + 1))}>+</Knop>
          </div>
        </Veld>

        {magKorting ? (
          <>
            <Veld
              label="Korting in procenten"
              hint="Korting op deze regel. Wat er is weggegeven staat op de bon en in de dagafsluiting."
            >
              <div style={{ display: 'flex', gap: 8 }}>
                {[0, 5, 10, 15, 25].map((p) => (
                  <Knop
                    key={p}
                    maat="klein"
                    soort={Number(korting) === p ? 'groen' : 'gewoon'}
                    onClick={() => setKorting(String(p))}
                  >
                    {p}%
                  </Knop>
                ))}
                <input
                  className="cijfers"
                  value={korting}
                  onChange={(e) => setKorting(e.target.value)}
                  style={{ width: 80, textAlign: 'center' }}
                />
              </div>
            </Veld>

            <Veld label="Prijs per stuk (incl. btw)">
              <input
                className="cijfers"
                value={prijs}
                onChange={(e) => setPrijs(e.target.value)}
              />
            </Veld>
          </>
        ) : (
          <div className="infodoos">
            <Percent size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
            Korting geven en prijzen aanpassen mag met het recht "Korting geven".
            Vraag een leidinggevende.
          </div>
        )}
      </div>
    </Dialoog>
  )
}

/* ------------------------------------------------------------------ *
 *  Klant kiezen
 * ------------------------------------------------------------------ */

function KlantKiezen({
  onSluiten, onKies,
}: { onSluiten: () => void; onKies: (c: Company | null) => void }) {
  const [zoek, setZoek] = useState('')

  const klanten = useLiveQuery(async () => {
    const alles = await db.companies.toArray()
    const term = zoek.trim().toLowerCase()
    return alles
      .filter((c) => !term || c.name.toLowerCase().includes(term) ||
        c.city.toLowerCase().includes(term))
      .sort((a, b) => a.name.localeCompare(b.name, 'nl'))
      .slice(0, 40)
  }, [zoek], [] as Company[])

  return (
    <Dialoog titel="Op wiens naam?" onSluiten={onSluiten}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Veld hint="Kies een klant om op rekening te kunnen zetten of een kaart te gebruiken. Laat leeg voor een losse rit.">
          <input
            value={zoek}
            onChange={(e) => setZoek(e.target.value)}
            placeholder="Zoek op naam of plaats"
            autoFocus
          />
        </Veld>

        <Knop breed onClick={() => onKies(null)}>Losse rit (geen klant)</Knop>

        <div className="lijst">
          {klanten.map((c) => (
            <button key={c.id} type="button" className="lijstrij" onClick={() => onKies(c)}>
              <div className="rek">
                <div className="titel">{c.name}</div>
                <div className="onder">
                  {c.city}
                  {c.contractDiscountPct ? ` · ${c.contractDiscountPct}% contractkorting` : ''}
                </div>
              </div>
              {c.contractDiscountPct > 0 && <Pil soort="merk">{c.contractDiscountPct}%</Pil>}
            </button>
          ))}
          {klanten.length === 0 && <Leeg tekst="Geen klant gevonden." />}
        </div>
      </div>
    </Dialoog>
  )
}
