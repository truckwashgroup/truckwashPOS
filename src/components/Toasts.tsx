import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'
import { useToasts } from '../store/useToasts'

/**
 * Meldingen rechtsonder.
 *
 * Zonder animatiebibliotheek: een kassa laadt liever snel dan mooi, en een
 * blokje dat in beeld schuift kan CSS ook.
 */
const ICONS = {
  ok: <CheckCircle2 size={18} color="var(--ok)" />,
  warn: <AlertTriangle size={18} color="var(--warn)" />,
  error: <XCircle size={18} color="var(--danger)" />,
  info: <Info size={18} color="var(--info)" />,
}

export default function Toasts() {
  const { items, dismiss } = useToasts()

  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} onClick={() => dismiss(t.id)}>
          {ICONS[t.tone]}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  )
}
