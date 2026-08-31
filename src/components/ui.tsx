import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { X } from 'lucide-react'

/* ------------------------------------------------------------------ *
 *  Bouwstenen
 *
 *  Klein gehouden met opzet. De vormgeving staat in kassa.css; deze
 *  onderdelen geven alleen de juiste klassen mee. Zo blijft de opmaak op één
 *  plek en hoeft niemand door React te zoeken om een knop groter te maken.
 * ------------------------------------------------------------------ */

type KnopSoort = 'gewoon' | 'hoofd' | 'stil' | 'gevaar' | 'groen'
type KnopMaat = 'klein' | 'normaal' | 'groot'

interface KnopProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  soort?: KnopSoort
  maat?: KnopMaat
  breed?: boolean
}

export function Knop({
  soort = 'gewoon', maat = 'normaal', breed, className = '', children, ...rest
}: KnopProps) {
  const klassen = [
    'knop',
    soort !== 'gewoon' ? soort : '',
    maat !== 'normaal' ? maat : '',
    breed ? 'breed' : '',
    className,
  ].filter(Boolean).join(' ')

  return <button type="button" className={klassen} {...rest}>{children}</button>
}

export function Pil({
  soort = 'gewoon', children,
}: { soort?: 'gewoon' | 'ok' | 'warn' | 'fout' | 'info' | 'merk'; children: ReactNode }) {
  return <span className={`pil ${soort === 'gewoon' ? '' : soort}`}>{children}</span>
}

export function Kaart({
  titel, uitleg, children, actie,
}: { titel?: string; uitleg?: string; children: ReactNode; actie?: ReactNode }) {
  return (
    <section className="kaart">
      {(titel || actie) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: uitleg ? 2 : 12 }}>
          {titel && <h3 style={{ flex: 1 }}>{titel}</h3>}
          {actie}
        </div>
      )}
      {uitleg && <p className="uitleg">{uitleg}</p>}
      {children}
    </section>
  )
}

interface VeldProps {
  label?: string
  hint?: string
  children: ReactNode
}

export function Veld({ label, hint, children }: VeldProps) {
  return (
    <div className="veld">
      {label && <label>{label}</label>}
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  )
}

export function Dialoog({
  titel, onSluiten, children, wijd, voet,
}: {
  titel: string
  onSluiten: () => void
  children: ReactNode
  wijd?: boolean
  voet?: ReactNode
}) {
  return (
    <div
      className="sluier"
      onClick={(e) => { if (e.target === e.currentTarget) onSluiten() }}
    >
      <div className={`dialoog ${wijd ? 'wijd' : ''}`} role="dialog" aria-label={titel}>
        <header>
          <h2 style={{ flex: 1 }}>{titel}</h2>
          <Knop soort="stil" maat="klein" onClick={onSluiten} aria-label="Sluiten">
            <X size={18} />
          </Knop>
        </header>
        <div style={{ marginTop: 14 }}>{children}</div>
        {voet && (
          <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
            {voet}
          </div>
        )}
      </div>
    </div>
  )
}

export function Leeg({ tekst }: { tekst: string }) {
  return <div className="leeg">{tekst}</div>
}

export function Fout({ children }: { children: ReactNode }) {
  return <div className="foutdoos">{children}</div>
}

export function Waarschuwing({ children }: { children: ReactNode }) {
  return <div className="waarschuwdoos">{children}</div>
}

export function Uitleg({ children }: { children: ReactNode }) {
  return <div className="infodoos">{children}</div>
}

/** Een rij met een label links en een waarde rechts. */
export function Regel({
  label, waarde, groot,
}: { label: ReactNode; waarde: ReactNode; groot?: boolean }) {
  return (
    <div className={`totaalrij ${groot ? 'groot' : ''}`}>
      <span className="label">{label}</span>
      <span className="waarde bedrag">{waarde}</span>
    </div>
  )
}
