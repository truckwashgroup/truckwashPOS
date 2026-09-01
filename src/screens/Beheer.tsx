import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import QRCode from 'qrcode'
import {
  BadgeCheck, Banknote, Bell, CreditCard, Download, KeyRound, Package, Plus,
  Printer, RefreshCw, Settings, Trash2,
} from 'lucide-react'
import { Dialoog, Fout, Knop, Leeg, Pil, Uitleg, Veld, Waarschuwing } from '../components/ui'
import { db, uid } from '../lib/db'
import { money } from '../lib/format'
import { badgeIntrekken, badgeMaken, nummersNakijken } from '../lib/code'
import { kanAfdrukken, openLade, proefBon } from '../lib/hardware/printer'
import { TERMINAL_LABELS } from '../lib/hardware/terminal'
import { bewaarRegister, losseKlant } from '../lib/kassa'
import { can } from '../lib/permissions'
import { BEWEGING_LABELS, THEMA_LABELS, useTheme } from '../lib/theme'
import {
  kanPlannen, planMelding, soortApparaat, type MeldingUitslag,
} from '../lib/hardware/melding'
import { enqueue, useSync } from '../lib/sync'
import { useUpdates } from '../lib/updates'
import { useAuth } from '../store/useAuth'
import { toast } from '../store/useToasts'
import {
  BTW_TARIEVEN, PRODUCT_KIND_LABELS, SERVICES,
  type Company, type InventoryItem, type PosProduct, type PosRegister,
  type ProductKind, type ServiceKind, type User,
} from '../lib/types'

/* ------------------------------------------------------------------ *
 *  Beheer
 *
 *  Wat hier staat verandert zelden, maar als het moet, moet het snel: een
 *  prijs die omhoog gaat, een nieuwe medewerker die een code nodig heeft, een
 *  printer die vervangen is.
 *
 *  Wat hier níét staat: personeel toevoegen, rollen geven, klanten beheren.
 *  Dat gebeurt in het dashboard. Twee plekken waar hetzelfde kan is één plek
 *  te veel.
 * ------------------------------------------------------------------ */

type Blad = 'artikelen' | 'codes' | 'kassa' | 'over'

export default function Beheer({ register }: { register: PosRegister }) {
  const { operator } = useAuth()
  const [blad, setBlad] = useState<Blad>('artikelen')

  const mag = can(operator, 'pos.manage')

  if (!mag) {
    return (
      <div className="paneel">
        <div className="kaart" style={{ maxWidth: 620 }}>
          <h3>Beheer</h3>
          <Uitleg>
            Artikelen, prijzen, codes en de printerinstellingen zijn voor wie het
            recht "Kassa beheren" heeft. Het management deelt dat uit in het
            dashboard onder Personeel → Rechten.
          </Uitleg>
        </div>
      </div>
    )
  }

  return (
    <div className="paneel">
      <div className="tabs" style={{ marginBottom: 16 }}>
        <button
          type="button"
          className={`tab ${blad === 'artikelen' ? 'aan' : ''}`}
          onClick={() => setBlad('artikelen')}
        >
          <Package size={16} /> Artikelen
        </button>
        <button
          type="button"
          className={`tab ${blad === 'codes' ? 'aan' : ''}`}
          onClick={() => setBlad('codes')}
        >
          <KeyRound size={16} /> Nummers en badges
        </button>
        <button
          type="button"
          className={`tab ${blad === 'kassa' ? 'aan' : ''}`}
          onClick={() => setBlad('kassa')}
        >
          <Settings size={16} /> Deze kassa
        </button>
        <button
          type="button"
          className={`tab ${blad === 'over' ? 'aan' : ''}`}
          onClick={() => setBlad('over')}
        >
          <Download size={16} /> Versie
        </button>
      </div>

      {blad === 'artikelen' && <Artikelen register={register} />}
      {blad === 'codes' && <Codes />}
      {blad === 'kassa' && <DezeKassa register={register} />}
      {blad === 'over' && (
        <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
          <Over />
          <Weergave />
          <Testmelding />
        </div>
      )}
    </div>
  )
}

/* ================================================================== *
 *  Artikelen
 * ================================================================== */

function Artikelen({ register }: { register: PosRegister }) {
  const [bewerken, setBewerken] = useState<PosProduct | null>(null)

  const producten = useLiveQuery(async () => {
    const alles = await db.products.toArray()
    return alles.sort((a, b) =>
      (a.groupName || '').localeCompare(b.groupName || '', 'nl') ||
      a.sort - b.sort ||
      a.name.localeCompare(b.name, 'nl'))
  }, [], [] as PosProduct[])

  function nieuw() {
    setBewerken({
      id: uid('art'),
      locationId: register.locationId,
      code: '',
      name: '',
      groupName: 'Shop',
      unit: 'stuk',
      priceIncl: 0,
      vatPct: 21,
      kind: 'artikel',
      sort: 100,
      active: true,
      updatedAt: Date.now(),
    })
  }

  return (
    <div className="kaart">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <h3 style={{ flex: 1 }}>Artikelen</h3>
        <Knop maat="klein" onClick={nieuw}><Plus size={16} /> Nieuw</Knop>
      </div>
      <p className="uitleg">
        Prijzen zijn inclusief btw — dat is wat op het bord staat en wat de
        chauffeur betaalt. Hangt een artikel aan de voorraad, dan boekt elke
        verkoop het daar af, net zoals in de wasstraat-app.
      </p>

      {producten.length === 0 ? (
        <Leeg tekst="Nog geen artikelen. Maak er een aan met de knop hierboven." />
      ) : (
        <table className="tabel">
          <thead>
            <tr>
              <th>Naam</th>
              <th>Groep</th>
              <th>Soort</th>
              <th className="rechts">Prijs</th>
              <th className="rechts">Btw</th>
              <th>Barcode</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {producten.map((p) => (
              <tr
                key={p.id}
                onClick={() => setBewerken(p)}
                style={{ cursor: 'pointer', opacity: p.active ? 1 : 0.5 }}
              >
                <td>{p.name}</td>
                <td>{p.groupName}</td>
                <td>{PRODUCT_KIND_LABELS[p.kind]}</td>
                <td className="rechts">{money(p.priceIncl)}</td>
                <td className="rechts">{p.vatPct}%</td>
                <td className="cijfers">{p.barcode ?? ''}</td>
                <td className="rechts">{!p.active && <Pil>uit</Pil>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {bewerken && (
        <ArtikelBewerken
          product={bewerken}
          onSluiten={() => setBewerken(null)}
        />
      )}
    </div>
  )
}

function ArtikelBewerken({
  product, onSluiten,
}: { product: PosProduct; onSluiten: () => void }) {
  const [p, setP] = useState<PosProduct>(product)
  const [fout, setFout] = useState<string | null>(null)

  const voorraad = useLiveQuery(() => db.inventory.toArray(), [], [] as InventoryItem[])
  const locaties = useLiveQuery(() => db.locations.toArray(), [], [])

  const zet = <K extends keyof PosProduct>(k: K, v: PosProduct[K]) => setP({ ...p, [k]: v })

  async function bewaar() {
    if (!p.name.trim()) { setFout('Een artikel heeft een naam nodig.'); return }
    if (!(p.priceIncl >= 0)) { setFout('De prijs kan niet negatief zijn.'); return }
    if (p.kind === 'strippenkaart' && !(p.credits && p.credits > 0)) {
      setFout('Zet erbij hoeveel beurten er op de kaart komen.'); return
    }
    if (p.kind === 'abonnement' && !(p.validDays && p.validDays > 0)) {
      setFout('Zet erbij hoeveel dagen het abonnement geldig is.'); return
    }
    if (p.kind === 'wasbeurt' && !p.washService) {
      setFout('Kies welke wasbeurt dit is, zodat de wasstraat weet wat er moet gebeuren.')
      return
    }

    const rij = { ...p, name: p.name.trim(), updatedAt: Date.now() }
    await db.products.put(rij)
    await enqueue('products', 'put', rij.id, rij)
    toast.ok('Artikel opgeslagen.')
    onSluiten()
  }

  return (
    <Dialoog
      titel={product.name || 'Nieuw artikel'}
      onSluiten={onSluiten}
      wijd
      voet={
        <>
          <Knop soort="stil" onClick={onSluiten}>Annuleren</Knop>
          <Knop soort="hoofd" onClick={() => void bewaar()}>Opslaan</Knop>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 14, gridTemplateColumns: '1fr 1fr' }}>
        <Veld label="Naam"><input value={p.name} onChange={(e) => zet('name', e.target.value)} /></Veld>
        <Veld label="Groep" hint="Bepaalt onder welk tabblad hij op het kassascherm staat.">
          <input value={p.groupName} onChange={(e) => zet('groupName', e.target.value)} />
        </Veld>

        <Veld label="Prijs inclusief btw">
          <input
            className="cijfers"
            value={String(p.priceIncl)}
            onChange={(e) => zet('priceIncl', Number(e.target.value.replace(',', '.')) || 0)}
          />
        </Veld>
        <Veld label="Btw-tarief">
          <select value={p.vatPct} onChange={(e) => zet('vatPct', Number(e.target.value))}>
            {BTW_TARIEVEN.map((t) => <option key={t} value={t}>{t}%</option>)}
          </select>
        </Veld>

        <Veld label="Soort">
          <select
            value={p.kind}
            onChange={(e) => zet('kind', e.target.value as ProductKind)}
          >
            {Object.entries(PRODUCT_KIND_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </Veld>

        {p.kind === 'wasbeurt' && (
          <Veld label="Welke wasbeurt" hint="Hiermee komt de opdracht in de wachtrij van de wasstraat.">
            <select
              value={p.washService ?? ''}
              onChange={(e) => zet('washService', (e.target.value || undefined) as ServiceKind)}
            >
              <option value="">— kies —</option>
              {Object.entries(SERVICES).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </Veld>
        )}

        {p.kind === 'strippenkaart' && (
          <Veld label="Aantal beurten op de kaart">
            <input
              className="cijfers"
              value={String(p.credits ?? '')}
              onChange={(e) => zet('credits', Number(e.target.value) || undefined)}
            />
          </Veld>
        )}

        {p.kind === 'abonnement' && (
          <Veld label="Geldig hoeveel dagen">
            <input
              className="cijfers"
              value={String(p.validDays ?? '')}
              onChange={(e) => zet('validDays', Number(e.target.value) || undefined)}
            />
          </Veld>
        )}

        <Veld label="Artikelnummer"><input value={p.code} onChange={(e) => zet('code', e.target.value)} /></Veld>
        <Veld label="Barcode" hint="Scannen zoekt hierop. Leeg laten mag.">
          <input
            className="cijfers"
            value={p.barcode ?? ''}
            onChange={(e) => zet('barcode', e.target.value || undefined)}
          />
        </Veld>

        <Veld label="Voorraadartikel" hint="Verkoop boekt hier af. Leeg laten voor diensten.">
          <select
            value={p.inventoryItemId ?? ''}
            onChange={(e) => zet('inventoryItemId', e.target.value || undefined)}
          >
            <option value="">— geen voorraad —</option>
            {voorraad.map((i) => (
              <option key={i.id} value={i.id}>{i.name} ({i.stock} {i.unit})</option>
            ))}
          </select>
        </Veld>

        <Veld label="Vestiging" hint="Leeg = op alle vestigingen te koop.">
          <select
            value={p.locationId ?? ''}
            onChange={(e) => zet('locationId', e.target.value || undefined)}
          >
            <option value="">Alle vestigingen</option>
            {locaties.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </Veld>

        <Veld label="Plaats op het scherm" hint="Lage nummers staan vooraan.">
          <input
            className="cijfers"
            value={String(p.sort)}
            onChange={(e) => zet('sort', Number(e.target.value) || 100)}
          />
        </Veld>

        <Veld label="In gebruik">
          <select
            value={p.active ? 'ja' : 'nee'}
            onChange={(e) => zet('active', e.target.value === 'ja')}
          >
            <option value="ja">Ja, staat op het kassascherm</option>
            <option value="nee">Nee, verborgen</option>
          </select>
        </Veld>
      </div>

      {fout && <div style={{ marginTop: 14 }}><Fout>{fout}</Fout></div>}
    </Dialoog>
  )
}

/* ================================================================== *
 *  Nummers en badges
 *
 *  Het personeelsnummer is de inlogcode van de kassa. Dat nummer staat in het
 *  dossier en wordt in het dashboard gezet, onder Personeel -- niet hier. Twee
 *  plekken waar hetzelfde kan is één te veel, en een nummer dat op twee
 *  plekken gezet kan worden gaat uit elkaar lopen.
 *
 *  Wat hier wél staat: of er iets aan die nummers mankeert, en de badges.
 * ================================================================== */

function Codes() {
  const { apparaat } = useAuth()
  const [gekozen, setGekozen] = useState<User | null>(null)

  const locatie = apparaat?.locationId

  const mensen = useLiveQuery(async () => {
    const alles = await db.users.toArray()
    return alles
      .filter((u) => u.active &&
        (!locatie || !u.locationId || u.locationId === locatie || u.allLocations))
      .sort((a, b) => a.name.localeCompare(b.name, 'nl'))
  }, [locatie], [] as User[])

  const badges = useLiveQuery(async () => {
    const alles = await db.pins.toArray()
    return new Map(alles.filter((p) => p.badgeToken).map((p) => [p.userId, p.badgeToken!]))
  }, [], new Map<string, string>())

  const controle = useLiveQuery(
    () => nummersNakijken(locatie),
    [locatie],
    { zonderNummer: [] as User[], dubbel: [] as { nummer: string; namen: string[] }[] },
  )

  return (
    <div className="kaart">
      <h3>Nummers en badges</h3>
      <p className="uitleg">
        Met zijn personeelsnummer meldt een medewerker zich aan de kassa en klokt
        hij in. Zijn naam komt daarmee op de bon en zijn uren gaan naar het
        dashboard. Een badge doet hetzelfde, maar sneller.
      </p>

      <Uitleg>
        Het nummer zelf zet je in het dashboard, onder Personeel. Hier zie je
        alleen of er iets aan mankeert — want een medewerker zonder nummer, of
        twee met hetzelfde, kan niet aanmelden.
      </Uitleg>

      {controle.dubbel.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <Fout>
            <strong>Dubbele nummers.</strong> Met deze nummers kan niemand
            aanmelden — de kassa zou moeten gokken op wiens naam de bon komt.
            <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
              {controle.dubbel.map((d) => (
                <li key={d.nummer}>
                  <span className="cijfers">{d.nummer}</span> — {d.namen.join(', ')}
                </li>
              ))}
            </ul>
          </Fout>
        </div>
      )}

      {controle.zonderNummer.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <Waarschuwing>
            <strong>Nog geen nummer.</strong> Deze medewerkers kunnen zich niet
            aanmelden en niet inklokken: {controle.zonderNummer.map((u) => u.name).join(', ')}.
          </Waarschuwing>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        {mensen.length === 0 ? (
          <Leeg tekst="De kassa heeft nog geen personeel opgehaald." />
        ) : (
          <div className="lijst">
            {mensen.map((u) => {
              const nummer = (u.personnelNumber ?? '').trim()
              return (
                <button
                  key={u.id}
                  type="button"
                  className="lijstrij"
                  onClick={() => setGekozen(u)}
                >
                  <div className="rek">
                    <div className="titel">{u.name}</div>
                    <div className="onder">
                      {nummer
                        ? <span className="cijfers">{nummer}</span>
                        : 'geen personeelsnummer'}
                      {u.function ? ` · ${u.function}` : ''}
                    </div>
                  </div>
                  {badges.has(u.id) && <Pil soort="info"><BadgeCheck size={13} /> badge</Pil>}
                  {nummer ? <Pil soort="ok">kan aanmelden</Pil> : <Pil soort="warn">kan niet aanmelden</Pil>}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {gekozen && (
        <BadgeBeheren user={gekozen} onSluiten={() => setGekozen(null)} />
      )}
    </div>
  )
}

function BadgeBeheren({
  user, onSluiten,
}: { user: User; onSluiten: () => void }) {
  const [qr, setQr] = useState<string | null>(null)
  const [code, setCode] = useState<string | null>(null)

  const rij = useLiveQuery(
    () => db.pins.where('userId').equals(user.id).first(), [user.id], undefined)

  useEffect(() => {
    if (!rij?.badgeToken) { setQr(null); setCode(null); return }
    setCode(rij.badgeToken)
    void QRCode.toDataURL(rij.badgeToken, { width: 220, margin: 1 })
      .then(setQr)
      .catch(() => setQr(null))
  }, [rij?.badgeToken])

  const nummer = (user.personnelNumber ?? '').trim()

  return (
    <Dialoog titel={user.name} onSluiten={onSluiten}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div>
          <h3 style={{ marginTop: 0 }}>Personeelsnummer</h3>
          {nummer ? (
            <div className="cijfers" style={{ fontSize: 26, fontWeight: 800 }}>{nummer}</div>
          ) : (
            <Waarschuwing>
              Deze medewerker heeft geen personeelsnummer en kan zich dus niet
              aanmelden. Zet er een in het dashboard, onder Personeel.
            </Waarschuwing>
          )}
          <p className="uitleg" style={{ marginTop: 8, marginBottom: 0 }}>
            Wijzigen gebeurt in het dashboard. Hier staat het alleen om na te
            kijken.
          </p>
        </div>

        <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>Badge</h3>
          <p className="uitleg">
            Een badge is een gescande code op een kaartje of sleutelhanger. Druk
            de QR-code af en lamineer hem. Scannen is sneller dan tikken, en op
            een sleutelhanger raak je hem minder makkelijk kwijt dan een nummer
            uit je hoofd.
          </p>

          {qr ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <img
                src={qr}
                alt="Badge"
                style={{ width: 200, borderRadius: 10, background: '#fff', padding: 8 }}
              />
              <div className="cijfers" style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {code}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Knop
                  maat="klein"
                  onClick={async () => {
                    await badgeMaken(user.id)
                    toast.ok('Nieuwe badge aangemaakt; de oude werkt niet meer.')
                  }}
                >
                  <RefreshCw size={15} /> Nieuwe badge
                </Knop>
                <Knop
                  soort="gevaar"
                  maat="klein"
                  onClick={async () => {
                    await badgeIntrekken(user.id)
                    toast.ok('Badge ingetrokken.')
                  }}
                >
                  <Trash2 size={15} /> Intrekken
                </Knop>
              </div>
            </div>
          ) : (
            <Knop
              onClick={async () => {
                try {
                  await badgeMaken(user.id)
                  toast.ok('Badge aangemaakt.')
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : 'Badge maken lukte niet')
                }
              }}
            >
              <BadgeCheck size={17} /> Badge aanmaken
            </Knop>
          )}
        </div>
      </div>
    </Dialoog>
  )
}

/* ================================================================== *
 *  Deze kassa
 * ================================================================== */

function DezeKassa({ register }: { register: PosRegister }) {
  const [r, setR] = useState<PosRegister>(register)
  const [losse, setLosse] = useState<string>('')

  const klanten = useLiveQuery(() => db.companies.toArray(), [], [] as Company[])

  useEffect(() => { void losseKlant.get().then((v) => setLosse(v ?? '')) }, [])

  const printer = r.printer ?? { kind: 'geen' as const }
  const terminal = r.terminal ?? { provider: 'handmatig' as const }

  async function bewaar() {
    await bewaarRegister(r)
    await losseKlant.set(losse || null)
    toast.ok('Instellingen opgeslagen.')
  }

  return (
    <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
      <div className="kaart">
        <h3><Printer size={16} style={{ verticalAlign: -3, marginRight: 7 }} /> Bonprinter</h3>
        <p className="uitleg">
          Een printer met een eigen netwerkadres is het betrouwbaarst: geen
          driver, geen wachtrij, geen Windows ertussen. Hangt hij aan de USB,
          deel hem dan in Windows en vul de sharenaam in.
        </p>

        {!kanAfdrukken() && (
          <div style={{ marginBottom: 14 }}>
            <Uitleg>
              Afdrukken werkt alleen op de Windows-kassa. Op een tablet kan de bon
              wel op het scherm.
            </Uitleg>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Veld label="Verbinding">
            <select
              value={printer.kind}
              onChange={(e) => setR({
                ...r,
                printer: { ...printer, kind: e.target.value as typeof printer.kind },
              })}
            >
              <option value="geen">Geen printer — alleen op het scherm</option>
              <option value="netwerk">Netwerk (ESC/POS, poort 9100)</option>
              <option value="windows">Windows-printer (gedeeld)</option>
            </select>
          </Veld>

          {printer.kind === 'netwerk' && (
            <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '2fr 1fr' }}>
              <Veld label="IP-adres">
                <input
                  className="cijfers"
                  value={printer.host ?? ''}
                  onChange={(e) => setR({ ...r, printer: { ...printer, host: e.target.value } })}
                  placeholder="192.168.1.50"
                />
              </Veld>
              <Veld label="Poort">
                <input
                  className="cijfers"
                  value={String(printer.port ?? 9100)}
                  onChange={(e) => setR({
                    ...r, printer: { ...printer, port: Number(e.target.value) || 9100 },
                  })}
                />
              </Veld>
            </div>
          )}

          {printer.kind === 'windows' && (
            <Veld
              label="Naam van de gedeelde printer"
              hint="Precies zoals hij in Windows gedeeld staat, bijvoorbeeld BONPRINTER. Een volledig pad (\\PC\NAAM) mag ook."
            >
              <input
                value={printer.share ?? ''}
                onChange={(e) => setR({ ...r, printer: { ...printer, share: e.target.value } })}
              />
            </Veld>
          )}

          <Veld label="Tekens per regel" hint="58mm-papier is 32, 80mm is 42 of 48.">
            <select
              value={String(printer.breedte ?? 42)}
              onChange={(e) => setR({
                ...r, printer: { ...printer, breedte: Number(e.target.value) },
              })}
            >
              <option value="32">32 (58 mm)</option>
              <option value="42">42 (80 mm)</option>
              <option value="48">48 (80 mm, klein)</option>
            </select>
          </Veld>

          <Veld label="Bon automatisch afdrukken">
            <select
              value={printer.automatisch === false ? 'nee' : 'ja'}
              onChange={(e) => setR({
                ...r, printer: { ...printer, automatisch: e.target.value === 'ja' },
              })}
            >
              <option value="ja">Ja, na elk afrekenen</option>
              <option value="nee">Nee, alleen op verzoek</option>
            </select>
          </Veld>

          <Veld label="Lade openen via de printer" hint="De meeste kassalades hangen achter op de bonprinter.">
            <select
              value={printer.ladeViaPrinter === false ? 'nee' : 'ja'}
              onChange={(e) => setR({
                ...r, printer: { ...printer, ladeViaPrinter: e.target.value === 'ja' },
              })}
            >
              <option value="ja">Ja</option>
              <option value="nee">Nee, geen lade</option>
            </select>
          </Veld>

          <div style={{ display: 'flex', gap: 10 }}>
            <Knop
              maat="klein"
              onClick={async () => {
                const uit = await proefBon(printer)
                if (uit.ok) toast.ok('Proefbon verstuurd.')
                else toast.error(uit.reden ?? 'Afdrukken lukte niet')
              }}
            >
              <Printer size={16} /> Proefbon
            </Knop>
            <Knop
              maat="klein"
              onClick={async () => {
                const uit = await openLade(printer)
                if (uit.ok) toast.ok('Lade geopend.')
                else toast.error(uit.reden ?? 'Lade openen lukte niet')
              }}
            >
              <Banknote size={16} /> Lade testen
            </Knop>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="kaart">
          <h3><CreditCard size={16} style={{ verticalAlign: -3, marginRight: 7 }} /> Pinautomaat</h3>
          <p className="uitleg">
            Met de hand intoetsen werkt altijd: de kassa laat het bedrag groot in
            beeld zien en jij bevestigt dat het gelukt is. Een echte koppeling
            vraagt gegevens van de betaalprovider.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Veld label="Provider">
              <select
                value={terminal.provider}
                onChange={(e) => setR({
                  ...r,
                  terminal: { ...terminal, provider: e.target.value as typeof terminal.provider },
                })}
              >
                {Object.entries(TERMINAL_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </Veld>

            {terminal.provider !== 'handmatig' && (
              <>
                <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '2fr 1fr' }}>
                  <Veld label="Adres van de terminal">
                    <input
                      className="cijfers"
                      value={terminal.host ?? ''}
                      onChange={(e) => setR({ ...r, terminal: { ...terminal, host: e.target.value } })}
                      placeholder="192.168.1.60"
                    />
                  </Veld>
                  <Veld label="Poort">
                    <input
                      className="cijfers"
                      value={String(terminal.port ?? '')}
                      onChange={(e) => setR({
                        ...r, terminal: { ...terminal, port: Number(e.target.value) || undefined },
                      })}
                    />
                  </Veld>
                </div>
                <Veld label="Terminal-id">
                  <input
                    value={terminal.terminalId ?? ''}
                    onChange={(e) => setR({
                      ...r, terminal: { ...terminal, terminalId: e.target.value },
                    })}
                  />
                </Veld>
                <Uitleg>
                  De koppeling zelf staat klaar in electron/terminal.cjs maar is nog
                  niet ingericht: daarvoor is een contract bij de provider nodig,
                  met een sleutel. Tot die tijd valt de kassa terug op met de hand
                  intoetsen, en zegt hij dat ook.
                </Uitleg>
              </>
            )}
          </div>
        </div>

        <div className="kaart">
          <h3>Klant voor losse ritten</h3>
          <p className="uitleg">
            Een wasopdracht hoort in de database bij een klant. Verkoop je een
            wasbeurt aan een losse chauffeur, dan valt hij hieronder — anders komt
            hij niet in de wachtrij van de wasstraat en is de bon het enige bewijs.
          </p>
          <Veld label="Bedrijf">
            <select value={losse} onChange={(e) => setLosse(e.target.value)}>
              <option value="">— niet ingesteld —</option>
              {klanten.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Veld>
          <p className="uitleg" style={{ marginTop: 10, marginBottom: 0 }}>
            Staat er geen geschikt bedrijf tussen? Maak in het dashboard een klant
            aan met de naam "Losse ritten".
          </p>
        </div>

        <div className="kaart">
          <h3>Kassa</h3>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr' }}>
            <Veld label="Code" hint="Hiermee beginnen de bonnummers. Wijzigen begint een nieuwe reeks.">
              <input value={r.code} onChange={(e) => setR({ ...r, code: e.target.value.toUpperCase() })} />
            </Veld>
            <Veld label="Naam">
              <input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} />
            </Veld>
          </div>
        </div>

        <Knop soort="hoofd" breed onClick={() => void bewaar()}>Instellingen opslaan</Knop>
      </div>
    </div>
  )
}

/* ================================================================== *
 *  Een melding voor later
 *
 *  Om te kunnen próberen of meldingen op dit apparaat werken -- en dan het
 *  geval dat telt: als de app dicht is. Dat is namelijk het enige moment
 *  waarop een melding ergens goed voor is; draait de app, dan kijk je toch al
 *  naar het scherm.
 *
 *  Waarom dit een knop in de app is en geen aantekening in een handleiding:
 *  of meldingen doorkomen hangt af van het apparaat, van Windows-instellingen
 *  en op Android van twee aparte rechten. Dat weet je pas als je het doet.
 * ================================================================== */

function Testmelding() {
  const [seconden, setSeconden] = useState('30')
  const [tekst, setTekst] = useState('')
  const [bezig, setBezig] = useState(false)
  const [uitslag, setUitslag] = useState<MeldingUitslag | null>(null)

  const soort = soortApparaat()

  async function plan() {
    setBezig(true)
    setUitslag(null)
    const n = Number(seconden)
    const u = await planMelding({
      seconden: Number.isFinite(n) ? n : 30,
      tekst: tekst.trim() || undefined,
    })
    setUitslag(u)
    setBezig(false)
  }

  return (
    <div className="kaart">
      <h3>
        <Bell size={16} style={{ verticalAlign: -3, marginRight: 7 }} />
        Melding uitproberen
      </h3>
      <p className="uitleg">
        Zet een melding klaar voor straks en sluit de kassa daarna af. Komt hij
        alsnog, dan werken meldingen op dit apparaat — en dat is het enige geval
        dat telt.
      </p>

      {!kanPlannen() ? (
        <Uitleg>
          In de browser kan dit niet: een pagina die dicht is krijgt geen melding
          zonder een pushdienst erachter. Probeer het op de Windows-kassa of op
          de tablet.
        </Uitleg>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '110px 1fr' }}>
            <Veld label="Over hoeveel seconden">
              <input
                className="cijfers"
                inputMode="numeric"
                value={seconden}
                onChange={(e) => setSeconden(e.target.value.replace(/\D/g, ''))}
              />
            </Veld>
            <Veld label="Tekst" hint="Leeg laten mag; dan staat er een standaardtekst.">
              <input
                value={tekst}
                onChange={(e) => setTekst(e.target.value)}
                placeholder="Kas tellen"
              />
            </Veld>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {[10, 30, 60, 300].map((n) => (
              <Knop key={n} maat="klein" onClick={() => setSeconden(String(n))}>
                {n < 60 ? `${n} sec` : `${n / 60} min`}
              </Knop>
            ))}
          </div>

          <Knop soort="hoofd" onClick={() => void plan()} disabled={bezig || !seconden}>
            <Bell size={17} /> {bezig ? 'Bezig…' : 'Melding klaarzetten'}
          </Knop>

          {uitslag && (uitslag.ok ? (
            <Uitleg>
              <strong>Staat klaar.</strong> Verwacht om{' '}
              {uitslag.om
                ? new Date(uitslag.om).toLocaleTimeString('nl-NL', {
                    hour: '2-digit', minute: '2-digit', second: '2-digit',
                  })
                : 'straks'}.
              {uitslag.hint ? ` ${uitslag.hint}` : ''}
            </Uitleg>
          ) : (
            <Fout>{uitslag.reden ?? 'Klaarzetten lukte niet.'}</Fout>
          ))}

          <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
            {soort === 'windows'
              ? 'Op Windows blijft een los proces staan dat wacht en dan de melding ' +
                'toont. Er wordt niets geïnstalleerd en er blijft niets slingeren.'
              : 'Op Android houdt het besturingssysteem de melding zelf bij, zoals ' +
                'bij een wekker. Meldingen moeten wel toegestaan zijn, en op ' +
                'Android 12 en later ook exacte alarmen.'}
          </div>
        </div>
      )}
    </div>
  )
}

/* ================================================================== *
 *  Weergave
 *
 *  De keuze staat op dit apparaat en niet in het dossier: een kassa bij een
 *  raam en een kassa in een hal hebben allebei hun eigen stand nodig, ook al
 *  staat er dezelfde medewerker achter.
 * ================================================================== */

function Weergave() {
  const { thema, beweging, actief, setThema, setBeweging } = useTheme()

  return (
    <div className="kaart">
      <h3>Weergave</h3>
      <p className="uitleg">
        Nu actief: {actief === 'donker' ? 'donker' : 'licht'}. Snel wisselen kan
        ook met het zon- of maantje in de balk bovenaan.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
        {(Object.keys(THEMA_LABELS) as (keyof typeof THEMA_LABELS)[]).map((k) => (
          <button
            key={k}
            type="button"
            className="lijstrij"
            onClick={() => setThema(k)}
            style={{
              borderColor: thema === k ? 'var(--line-brand)' : undefined,
              background: thema === k ? 'var(--tint-brand)' : undefined,
            }}
          >
            <div className="rek">
              <div className="titel">{THEMA_LABELS[k].label}</div>
              <div className="onder">{THEMA_LABELS[k].hint}</div>
            </div>
            {thema === k && <Pil soort="merk">aan</Pil>}
          </button>
        ))}
      </div>

      <h3 style={{ marginTop: 22 }}>Beweging</h3>
      <p className="uitleg">
        Op een oudere tablet kost bewegen merkbaar rekenkracht, en aan een kassa
        is snel belangrijker dan mooi.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
        {(Object.keys(BEWEGING_LABELS) as (keyof typeof BEWEGING_LABELS)[]).map((k) => (
          <button
            key={k}
            type="button"
            className="lijstrij"
            onClick={() => setBeweging(k)}
            style={{
              borderColor: beweging === k ? 'var(--line-brand)' : undefined,
              background: beweging === k ? 'var(--tint-brand)' : undefined,
            }}
          >
            <div className="rek">
              <div className="titel">{BEWEGING_LABELS[k].label}</div>
              <div className="onder">{BEWEGING_LABELS[k].hint}</div>
            </div>
            {beweging === k && <Pil soort="merk">aan</Pil>}
          </button>
        ))}
      </div>
    </div>
  )
}

/* ================================================================== *
 *  Versie
 * ================================================================== */


function Over() {
  const {
    channel, state, version, newVersion, percent, message,
    magInstalleren, check, install, toestemmingVragen,
  } = useUpdates()
  const { lastSyncAt, pending, online } = useSync()

  return (
    <div className="kaart" style={{ maxWidth: 620 }}>
      <h3>Versie en updates</h3>
      <p className="uitleg">
        {channel === 'mobile'
          ? 'De kassa kijkt bij het starten of er een nieuwere versie op GitHub ' +
            'staat en haalt die op de achtergrond op. Installeren doe je hier, ' +
            'na de dagafsluiting — daarbij vraagt Android één keer om ' +
            'bevestiging.'
          : 'Op Windows kijkt de kassa bij het starten en elk half uur of er een ' +
            'nieuwere versie op GitHub staat, en downloadt die op de achtergrond. ' +
            'Installeren gebeurt bij het afsluiten — of hier, na de dagafsluiting.'}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-3)' }}>Deze versie</span>
          <strong className="cijfers">{version}</strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-3)' }}>Soort installatie</span>
          <span>{channel === 'windows' ? 'Windows' : channel === 'mobile' ? 'Tablet' : 'Web'}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-3)' }}>Verbinding</span>
          <span>{online ? 'online' : 'offline'}{pending ? ` · ${pending} in de wachtrij` : ''}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-3)' }}>Laatst bijgewerkt</span>
          <span>{lastSyncAt ? new Date(lastSyncAt).toLocaleString('nl-NL') : 'nog niet'}</span>
        </div>
      </div>

      {state === 'downloading' && (
        <p className="uitleg" style={{ marginTop: 14 }}>Downloaden… {percent}%</p>
      )}

      {/*
        Op Android mag een app alleen een installatie starten als de gebruiker
        dat per app heeft toegestaan. Staat dat uit, dan mislukt het
        installeren zonder melding -- dus zeggen we het vóórdat er iemand op
        de knop drukt, en niet erna.
      */}
      {channel === 'mobile' && !magInstalleren && (
        <div style={{ marginTop: 14 }}>
          <Uitleg>
            Android moet deze app eenmalig toestaan om een update te installeren.
            Zonder dat lukt het downloaden wel en het installeren niet.
            <div style={{ marginTop: 10 }}>
              <Knop maat="klein" onClick={() => void toestemmingVragen()}>
                Instelling openen
              </Knop>
            </div>
          </Uitleg>
        </div>
      )}
      {state === 'ready' && (
        <div style={{ marginTop: 14 }}>
          <Uitleg>
            Versie {newVersion} staat klaar. Installeren duurt een halve minuut en
            sluit de kassa even af — doe het na de dagafsluiting.
          </Uitleg>
        </div>
      )}
      {message && <p className="uitleg" style={{ marginTop: 10 }}>{message}</p>}

      <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
        <Knop onClick={() => void check()} disabled={state === 'checking'}>
          <RefreshCw size={17} /> {state === 'checking' ? 'Kijken…' : 'Kijk of er een update is'}
        </Knop>
        {state === 'ready' && (
          <Knop soort="hoofd" onClick={() => void install()}>
            <Download size={17} /> Nu installeren
          </Knop>
        )}
      </div>
    </div>
  )
}
