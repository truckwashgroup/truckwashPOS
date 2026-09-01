/**
 * Een melding die de app overleeft.
 *
 * Het punt: als de kassa dicht is, draait er geen JavaScript. Een setTimeout
 * in de app gaat dus mee de deur uit. Wil je over dertig seconden een melding
 * en de app intussen afsluiten, dan moet er iets anders blijven staan.
 *
 * Wat hier gebeurt: we starten een los PowerShell-proces dat wacht en daarna
 * de melding toont. Dat proces is `detached` en `unref`'d -- het hangt niet
 * meer aan de kassa, dus het blijft leven als de kassa afsluit. Geen
 * geplande taak in Windows, dus er blijft ook niets slingeren als je het
 * uitzet.
 *
 * Waarom geen schtasks: dat rekent in hele minuten. "Over dertig seconden"
 * is er niet in uit te drukken, en dat is precies wat je wil kunnen testen.
 *
 * Waarom -EncodedCommand: de titel en de tekst komen van de gebruiker en gaan
 * een PowerShell-opdracht in. Met base64 (UTF-16LE, wat PowerShell wil) is er
 * geen aanhalingsteken meer dat de opdracht kan openbreken. Het scheelt een
 * hele klasse fouten -- en een gat.
 */

const { spawn } = require('node:child_process')

/**
 * Tekst veilig in een PowerShell-string zetten.
 *
 * Enkele aanhalingstekens in PowerShell nemen niets letterlijk behalve een
 * aanhalingsteken zelf, en dat verdubbel je. Verder hoeft er niets: een dollar
 * of een backtick doet binnen enkele aanhalingstekens niets.
 */
function psTekst(waarde) {
  return "'" + String(waarde ?? '').replace(/'/g, "''") + "'"
}

/**
 * Het script dat straks draait.
 *
 * Twee manieren om een melding te tonen, en de tweede is de vangnet:
 *
 *   1. Een echte Windows-toast (WinRT). Die ziet eruit zoals elke andere
 *      melding en blijft in het meldingencentrum staan.
 *   2. Een ballon bij de klok (NotifyIcon uit .NET). Minder mooi, maar werkt
 *      op elke Windows zonder iets te installeren.
 *
 * Zonder dat vangnet zou je op een machine waar de toast niet aanslaat niets
 * zien -- en dan weet je niet of het aan de melding of aan het wachten lag.
 */
function bouwScript({ seconden, titel, tekst }) {
  const t = psTekst(titel)
  const b = psTekst(tekst)

  return `
$ErrorActionPreference = 'Stop'
Start-Sleep -Seconds ${Number(seconden)}

$titel = ${t}
$tekst = ${b}

$gelukt = $false
try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
  $sjabloon = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
    [Windows.UI.Notifications.ToastTemplateType]::ToastText02)

  $regels = $sjabloon.GetElementsByTagName('text')
  $regels.Item(0).AppendChild($sjabloon.CreateTextNode($titel)) | Out-Null
  $regels.Item(1).AppendChild($sjabloon.CreateTextNode($tekst)) | Out-Null

  $melding = [Windows.UI.Notifications.ToastNotification]::new($sjabloon)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($melding)
  $gelukt = $true
} catch {
  $gelukt = $false
}

if (-not $gelukt) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $icoon = New-Object System.Windows.Forms.NotifyIcon
  $icoon.Icon = [System.Drawing.SystemIcons]::Information
  $icoon.BalloonTipTitle = $titel
  $icoon.BalloonTipText = $tekst
  $icoon.Visible = $true
  $icoon.ShowBalloonTip(20000)
  Start-Sleep -Seconds 12
  $icoon.Dispose()
}
`.trim()
}

/** Naar base64 zoals PowerShell het wil: UTF-16 little endian. */
function naarEncodedCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64')
}

/**
 * Een melding inplannen.
 *
 * Geeft terug wanneer hij verwacht wordt, zodat het scherm dat kan laten zien
 * in plaats van "hij komt wel".
 */
function plan({ seconden, titel, tekst }) {
  const wacht = Math.max(1, Math.min(3600, Math.round(Number(seconden) || 0)))

  if (process.platform !== 'win32') {
    return {
      ok: false,
      reden: 'Dit werkt alleen op Windows. Op een tablet plant Android de melding zelf.',
    }
  }

  const script = bouwScript({
    seconden: wacht,
    titel: titel || 'Truckwash1 Kassa',
    tekst: tekst || 'Dit is een testmelding.',
  })

  try {
    const kind = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle', 'Hidden',
        '-EncodedCommand', naarEncodedCommand(script),
      ],
      {
        detached: true,      // hangt niet meer aan de kassa
        stdio: 'ignore',     // geen pijp die de ouder in leven houdt
        windowsHide: true,
      },
    )

    // Loslaten: zonder dit blijft Node wachten tot het kind klaar is, en dan
    // sluit de kassa niet af zolang de melding nog niet geweest is.
    kind.unref()

    return {
      ok: true,
      seconden: wacht,
      om: new Date(Date.now() + wacht * 1000).toISOString(),
    }
  } catch (e) {
    return { ok: false, reden: String(e && e.message ? e.message : e) }
  }
}

module.exports = {
  plan,
  // Voor de zelftest: de stukken die zonder Windows te controleren zijn.
  _intern: { psTekst, bouwScript, naarEncodedCommand },
}
