import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { logLive } from './lib/trail'
import './styles/kassa.css'

/*
 * Een kassa die omvalt en een wit scherm laat zien is erger dan een kassa met
 * een foutmelding: bij dat laatste weet iemand tenminste dat hij contant moet
 * afrekenen en de bon met de hand moet schrijven. Vandaar dat we alles wat
 * ongemerkt zou verdwijnen in het logboek zetten -- datzelfde logboek dat in
 * het dashboard onder Ontwikkeling terugkomt.
 */
window.addEventListener('error', (e) => {
  logLive('fout', e.message, { detail: e.error instanceof Error ? e.error.stack : undefined })
})

window.addEventListener('unhandledrejection', (e) => {
  const reden = e.reason
  logLive('fout', reden instanceof Error ? reden.message : String(reden), {
    detail: reden instanceof Error ? reden.stack : undefined,
  })
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
