/**
 * Haalt de gedeelde kern uit de wasstraat-app hierheen.
 *
 * De kassa en het dashboard zijn twee apps met één administratie. Een deel van
 * de code hoort dus in beide precies hetzelfde te zijn: het domeinmodel van
 * personeel en wasbeurten, de rechten, en de laag die met Supabase praat.
 *
 * Dat is bewust een kopie en geen gedeeld pakket -- de twee apps hebben ieder
 * hun eigen releaseritme, en een gedeeld pakket betekent dat je voor elke
 * kleine wijziging drie repositories moet uitbrengen. De prijs van een kopie
 * is dat hij stil kan gaan afwijken, en dit script is er om die prijs niet te
 * betalen:
 *
 *   node scripts/kern-bijwerken.cjs             (kijkt alleen, wijzigt niets)
 *   node scripts/kern-bijwerken.cjs --schrijf   (haalt de wijzigingen hierheen)
 *
 * Standaard zoekt hij het dashboard naast deze map. Staat het elders:
 *
 *   node scripts/kern-bijwerken.cjs --dashboard=D:/projecten/dashboard
 */

const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const args = process.argv.slice(2)
const schrijf = args.includes('--schrijf')
const opgegeven = args.find((a) => a.startsWith('--dashboard='))
const dashboard = opgegeven
  ? opgegeven.slice('--dashboard='.length)
  : path.resolve(root, '..', 'dashboard')

/** Bestanden die letterlijk hetzelfde horen te zijn. */
const LETTERLIJK = [
  'src/lib/api/types.ts',
  'src/lib/offlineAuth.ts',
  'src/lib/format.ts',
  'src/lib/trail.ts',
  'src/lib/notify.ts',
  'src/lib/permissions.ts',
  'src/lib/theme.ts',
]

/**
 * Uit het domeinmodel van het dashboard nemen we alleen over wat de kassa ook
 * echt nodig heeft. Wasbeurten ja, cursussen nee.
 *
 * Let op waar een type zelf op leunt. Deze lijst is met de hand bijgehouden,
 * dus als er in het dashboard een veld bij komt dat naar een type verwijst dat
 * hier niet staat, valt de bouw om met "Cannot find name". Dat gebeurde bij
 * Location.openingHours: het veld kwam mee, de drie types eronder niet.
 * Vervelend maar eerlijk -- het valt hardop om en niet stil.
 */
const TYPES = [
  'Role', 'ROLE_LABELS', 'ROLE_ORDER', 'User',
  'LocationKind', 'Location', 'Company',
  // Waar Location.openingHours op leunt. De kassa gebruikt ze nergens zelf,
  // maar zonder deze drie is Location niet te compileren.
  'Weekdag', 'Venster', 'Openingstijden',
  'WashStatus', 'ServiceKind', 'SERVICES', 'WashJob',
  'InventoryItem', 'StockMovement', 'TimeEntry',
  'Permission', 'PermissionMeta', 'PERMISSIONS',
  'TrailEntry',
]

const KOP = `/* ------------------------------------------------------------------ *
 *  GEDEELD MET DE WASSTRAAT-APP -- niet met de hand wijzigen
 *
 *  Dit bestand is overgenomen uit src/lib/types.ts van het dashboard. De
 *  kassa en het dashboard schrijven in dezelfde tabellen, dus als deze
 *  definities uit elkaar lopen gaan er gegevens verloren die niemand mist
 *  totdat de boekhouder ernaar vraagt.
 *
 *  Bijwerken:  node scripts/kern-bijwerken.cjs --schrijf
 * ------------------------------------------------------------------ */

`

/**
 * Knipt één top-level declaratie uit een bestand, met het commentaar dat
 * eboven staat.
 *
 * Werkt op de opmaak van dit project: declaraties beginnen op kolom 0 met
 * `export`, en lopen door tot de volgende die op kolom 0 begint. Dat is genoeg
 * en het scheelt een parser -- gaat de opmaak ooit om, dan valt dit script
 * hardop om in plaats van stil iets halfs op te leveren.
 */
function knip(bron, naam) {
  const regels = bron.split(/\r?\n/)
  const begin = regels.findIndex((r) =>
    new RegExp(`^export (?:interface|type|const) ${naam}\\b`).test(r))
  if (begin === -1) throw new Error(`${naam} niet gevonden in het dashboard`)

  // Commentaar dat direct boven de declaratie staat hoort erbij.
  let kop = begin
  while (kop > 0) {
    const vorige = regels[kop - 1].trim()
    const isCommentaar =
      vorige.startsWith('/**') || vorige.startsWith('/*') ||
      vorige.startsWith('*') || vorige.startsWith('//') ||
      vorige.endsWith('*/')
    if (!isCommentaar) break
    kop--
    // Een blok-commentaar in één keer meenemen.
    if (vorige.startsWith('/*')) break
  }

  let eind = begin + 1
  while (eind < regels.length) {
    const r = regels[eind]
    if (/^export\b/.test(r) || /^\/\* -{10}/.test(r)) break
    eind++
  }

  /*
   * Commentaar aan het eind hoort bij de VOLGENDE declaratie.
   *
   * De lus hierboven stopt pas bij het volgende `export`, dus alles wat
   * daartussen staat komt mee -- ook de uitleg die boven dat volgende type
   * hoort. Dat gaf twee kwalen tegelijk. Wordt het volgende type ook
   * overgenomen, dan staat zijn uitleg er twee keer (een keer als staart van
   * de vorige, een keer als kop van zichzelf). Wordt het NIET overgenomen,
   * dan blijft zijn uitleg als weeskind achter boven het type dat er
   * toevallig achter kwam -- zo stond "Een foto bij een vestiging" ineens
   * boven WashStatus.
   *
   * Dus: lege regels en een commentaarblok aan de staart eraf. De sluitende
   * `}` of de laatste regel code is het einde van deze declaratie.
   */
  let laatste = eind - 1
  while (laatste > begin) {
    const r = regels[laatste].trim()
    const isRuisAanHetEind =
      r === '' || r.startsWith('/*') || r.startsWith('*') ||
      r.startsWith('//') || r.endsWith('*/')
    if (!isRuisAanHetEind) break
    laatste--
  }
  eind = laatste + 1

  return regels.slice(kop, eind).join('\n').trimEnd()
}

/* ------------------------------------------------------------------ */

if (!fs.existsSync(dashboard)) {
  console.error(`Het dashboard staat niet op ${dashboard}.`)
  console.error('Geef het pad mee met --dashboard=...')
  process.exit(1)
}

let afwijkend = 0

function vergelijk(doelPad, nieuw, label) {
  const volledig = path.join(root, doelPad)
  const oud = fs.existsSync(volledig) ? fs.readFileSync(volledig, 'utf8') : null

  if (oud === nieuw) {
    console.log(`  gelijk    ${label}`)
    return
  }

  afwijkend++
  if (schrijf) {
    fs.mkdirSync(path.dirname(volledig), { recursive: true })
    fs.writeFileSync(volledig, nieuw, 'utf8')
    console.log(`  bijgewerkt ${label}`)
  } else {
    console.log(`  WIJKT AF  ${label}${oud === null ? ' (bestaat hier niet)' : ''}`)
  }
}

console.log(`\nKern vergelijken met ${dashboard}\n`)

for (const rel of LETTERLIJK) {
  const bron = path.join(dashboard, rel)
  if (!fs.existsSync(bron)) {
    console.log(`  ONTBREEKT ${rel} staat niet in het dashboard`)
    afwijkend++
    continue
  }
  vergelijk(rel, fs.readFileSync(bron, 'utf8'), rel)
}

const dashboardTypes = fs.readFileSync(
  path.join(dashboard, 'src', 'lib', 'types.ts'), 'utf8')

const stukken = TYPES.map((naam) => knip(dashboardTypes, naam))
vergelijk('src/lib/gedeeldeTypes.ts', KOP + stukken.join('\n\n') + '\n',
  'src/lib/gedeeldeTypes.ts (uit types.ts)')

console.log()
if (afwijkend === 0) {
  console.log('De kern is gelijk aan die van het dashboard.\n')
} else if (schrijf) {
  console.log(`${aantalBestanden(afwijkend)} bijgewerkt. Draai daarna: npm run build\n`)
} else {
  console.log(
    `${aantalBestanden(afwijkend)} wijkt af. Overnemen: ` +
    'node scripts/kern-bijwerken.cjs --schrijf\n')
  process.exitCode = 1
}

function aantalBestanden(n) {
  return n === 1 ? '1 bestand' : `${n} bestanden`
}
