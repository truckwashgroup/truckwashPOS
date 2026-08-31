# Truckwash1 Kassa

Kassasysteem met klokin voor Truckwash1 Group. Werkt door zonder internet en
praat met dezelfde database als de [wasstraat-app](https://github.com/truckwashgroup/truckwash-dashboard).

- **Windows** — Electron, met automatische updates via GitHub Releases
- **Android-tablet** — dezelfde app als APK, via Capacitor

---

## Waarom dit één administratie is en geen tweede

De kassa is een aparte app, maar geen aparte boekhouding. Hij schrijft in
dezelfde Supabase-database als het dashboard. Dat betekent:

| Wat | Waar het heen gaat |
|---|---|
| Een medewerker die inklokt | `time_entries` — zichtbaar in het dashboard onder **Uren** |
| Een wasbeurt die aan de balie verkocht wordt | `wash_jobs`, status `wachtrij` — de wasser ziet hem in zijn eigen app |
| Een wasopdracht die aan de balie betaald wordt | dezelfde `wash_jobs`, status `gereed` |
| Een artikel dat verkocht wordt | `stock_movements` + de nieuwe voorraadstand |
| Een bon op rekening | `pos_sales` op naam van het bedrijf, klaar om te factureren |
| Wie wat mag | `profiles.roles` en `profiles.grants` — precies dezelfde rechten |

Eén persoon, één personeelsnummer, één urenstaat. Niets om over te typen.

### Het personeelsnummer is de inlogcode

Aan één kassa werken meerdere mensen. Er zijn dus twee soorten "ingelogd":

- **Het apparaat** is ingericht met één account uit de wasstraat-app. Dat
  bepaalt welke vestiging dit is en wat de kassa mag ophalen. Eén keer instellen.
- **De medewerker** toetst zijn **personeelsnummer** in, of scant zijn badge.
  Zijn naam komt op de bon, zijn uren gaan naar het dashboard, en na vijf
  minuten stilte valt hij er vanzelf af.

Er is dus geen tweede code om uit te delen of kwijt te raken: het nummer staat
al in het dossier. De lengte doet niet mee — drie cijfers of acht, met of zonder
letters ervoor. Het nummer wordt gezet in het **dashboard, onder Personeel**;
niet in de kassa, want een nummer dat op twee plekken gezet kan worden gaat uit
elkaar lopen.

Intoetsen mag op drie manieren, want een cijfertoetsenbord kan geen letters:
`TW-014`, `TW014` en `014` vinden alle drie dezelfde persoon.

> **Wat dit wel en niet is.** Een personeelsnummer is geen geheim: het staat op
> roosters en urenlijsten. Wie het nummer van een collega kent, kan zich als die
> persoon aanmelden. Het nummer zegt dus *wie er handelde*, niet *dat het echt
> die persoon was*. Daarom staat er een rem op het gokken (vijf pogingen, dan een
> minuut wachten) en komt het nummer nergens in de app in beeld waar iemand het
> kan aflezen. Bij de gegevens komt niemand ermee — dat doet het apparaataccount.

Twee dingen maken aanmelden onmogelijk, en de kassa zegt ze allebei vóórdat
iemand ermee vastloopt: een medewerker **zonder** nummer, en twee mensen met
**hetzelfde** nummer. Dat laatste weigert de kassa bewust — gokken welke van de
twee bedoeld is, betekent een bon en een urenstaat op de verkeerde naam.

Kom je nergens in (geen nummer, of een dubbel nummer), dan is er
**"Aanmelden met het wachtwoord van dit apparaat"** onderaan het aanmeldscherm.
Dat werkt ook offline.

### Badges

Een badge is een QR-code op een kaartje of sleutelhanger; scannen is sneller dan
tikken. Aanmaken en afdrukken gebeurt onder **Beheer → Nummers en badges**, door
iemand met het recht *Kassa beheren*. Een badge is niet sterker dan het nummer —
wie hem kan scannen, kan ook het nummer intoetsen — maar wel sneller.

---

## Eerste keer opzetten

### 1. Het databaseschema bijwerken

De kassatabellen (`pos_*`) zitten in de migratie
`supabase/migrations/0012_kassa.sql` **van de dashboard-repo** — daar woont het
hele schema, zodat er één bron van waarheid is.

```bash
cd ../dashboard
node scripts/build-setup-sql.cjs     # bouwt supabase/setup.sql
node scripts/sqltest.mjs             # draait alles tegen een echte Postgres
```

Plak daarna `supabase/setup.sql` in de SQL Editor van Supabase en druk op Run.
Opnieuw draaien mag: het maakt niets dubbel aan en gooit niets weg.

### 2. Rechten uitdelen

In het dashboard, onder **Personeel → Rechten**, staan vijf nieuwe rechten:

| Recht | Wat het toestaat | Standaard bij |
|---|---|---|
| `pos.use` | Afrekenen en de bon afdrukken | iedere werknemer |
| `pos.discount` | Korting geven en prijzen aanpassen | leidinggevende |
| `pos.refund` | Een afgerekende bon crediteren | leidinggevende |
| `pos.cash` | Kas openen, tellen en de dag afsluiten | leidinggevende |
| `pos.manage` | Artikelen, prijzen, codes en de printer | management |

Wie geen `pos.use` heeft, staat niet in de lijst bij het aanmelden.

### 3. De kassa zelf

```bash
cp .env.example .env      # zelfde twee waarden als in de dashboard-repo
npm install
npm run electron:dev      # of: npm run dev  voor alleen de browser
```

Bij de eerste start vraagt de kassa om:

1. **een account** — hetzelfde e-mailadres en wachtwoord als in de wasstraat-app;
2. **welke kassa dit is** — of maak er een aan met een korte, unieke code
   (`KAS-UTR-1`). Daarmee beginnen de bonnummers.

> **Twee apparaten nooit op dezelfde kassa.** De bonnummering loopt op het
> apparaat door, dus twee kassa's met dezelfde code delen dezelfde nummers uit.
> De database weigert de tweede, en die omzet blijft in de wachtrij hangen. De
> kassa waarschuwt hiervoor, maar geef een tweede apparaat gewoon een eigen code.

### 4. Artikelen invoeren

Onder **Beheer → Artikelen**. Prijzen zijn **inclusief btw** — dat is wat op het
bord staat en wat de chauffeur betaalt.

Vier soorten:

- **Artikel** — koffie, ruitenwisservloeistof. Koppel hem aan een voorraadartikel
  en elke verkoop boekt daar af.
- **Wasbeurt** — kies welk type (buitenwas, combi…). Verkopen zet de opdracht in
  de wachtrij van de wasstraat.
- **Strippenkaart** — een aantal beurten vooruit betaald. De code komt als
  QR-code op de bon.
- **Abonnement** — een periode onbeperkt wassen.

### 5. Klant voor losse ritten

Een wasopdracht hoort in de database bij een klant, en dat veld mag niet leeg
zijn. Verkoop je een wasbeurt aan een losse chauffeur, dan is er geen klant.
Maak daarom in het dashboard één bedrijf aan (bijvoorbeeld "Losse ritten") en
wijs dat aan onder **Beheer → Deze kassa**. Zonder die instelling wordt de
wasbeurt gewoon verkocht, maar komt hij niet in de wachtrij — dan is de bon het
enige bewijs.

---

## Hardware

### Bonprinter (ESC/POS)

Twee manieren, en de eerste is beter:

- **Netwerk** — de printer heeft een eigen IP en luistert op poort 9100. Geen
  driver, geen wachtrij, geen Windows ertussen.
- **Windows** — de printer hangt aan de USB en is in Windows *gedeeld*
  (Printereigenschappen → Delen). De kassa kopieert de ruwe bytes naar die
  share. Zonder share is er geen pad om naartoe te kopiëren.

Stel in onder **Beheer → Deze kassa**, en druk op **Proefbon** om het te zien.
Tekens per regel: 32 voor 58mm-papier, 42 of 48 voor 80mm.

Op een Android-tablet kan de kassa niet afdrukken; de bon staat wel op het
scherm.

### Kassalade

Die hangt bij vrijwel elke opstelling achter op de bonprinter (RJ11). Openen is
dan één stuurcode naar de printer — dus geen apart apparaat, en het werkt zodra
de printer werkt. Test met **Lade testen**.

### Barcodescanner

Niets in te stellen: een scanner meldt zich als toetsenbord aan. De kassa
onderscheidt scannen van typen aan de snelheid (dertig tekens per seconde haalt
geen mens). Werkt op het kassascherm voor artikelen, en overal voor badges
(`TWB-…`) en waskaarten (`TW-…`).

### Muziek bijsturen

De kassa kan de muziek bijsturen die op een speaker in het netwerk speelt:
pauze, volgende, volume, dempen. Kiezen wát er speelt gebeurt op het apparaat
waar het vandaan komt — aan een balie wil je alleen kunnen ingrijpen.

Het gaat via **UPnP** (DLNA). Dat is één protocol voor alles: een Sonos spreekt
het, en ook de meeste soundbars, AV-receivers en smart-tv's. Geen account, geen
abonnement, geen sleutel, en geen internet — alles over het eigen netwerk. Dus
werkt het ook als de verbinding met buiten eruit ligt, net als de rest van de
kassa.

Onder **Muziek → Zoeken op het netwerk** vraagt de kassa wie er muziek kan
spelen (SSDP) en toont wat er antwoordt. Kies er een en de knoppen staan er.
De keuze blijft op dít apparaat: een speaker heeft een adres op één netwerk, en
de kassa in Rotterdam heeft niets te zoeken bij de boxen in Utrecht.

Vindt hij niets, dan zijn er drie gebruikelijke oorzaken, en die staan ook in
het scherm: kassa en speaker op verschillende netwerken, de Windows-firewall die
het UDP-antwoord tegenhoudt, of een speaker die geen UPnP spreekt (een
bluetooth- of kabelspeaker heeft geen netwerkadres en is van buitenaf niet te
besturen).

**Alexa en Echo doen niet mee**, en dat is geen omissie: Amazon heeft nooit een
lokale API voor de Echo uitgebracht — alles gaat via hun cloud. De zoekactie
vindt hem dus niet. Bijsturen doe je daar met je stem, en dat is aan een balie
sneller dan de kassa erbij pakken.

De enige officiële route die een Echo *wel* laat besturen, is Spotify Connect:
dat bestuurt niet een apparaat maar wat er op het account speelt, en werkt
daardoor op een Echo, een Chromecast en een Sonos met dezelfde code. Het vraagt
Premium, een inlog per kassa, en het loopt tegen de licentievraag aan (een
persoonlijk abonnement dekt geen muziek in een bedrijfsruimte; daarnaast gelden
Buma/Stemra en Sena). Bewust niet gebouwd — het is een beslissing, geen
bouwwerk.

**Chromecast en Google Nest doen niet mee.** Die spreken geen UPnP maar castv2,
een eigen protocol. Bovendien laat een Chromecast waarop iemand Spotify heeft
gecast zich door een derde app niet besturen. Ziet de kassa iets van Google op
het netwerk, dan zegt hij dat — dan weten we dat het de moeite waard is om erbij
te bouwen.

**Spotify Connect** zit er bewust niet in. Dat vraagt Premium, een inlog per
kassa, en muziek in een bedrijfsruimte valt buiten een persoonlijk abonnement
(los daarvan vraagt muziek in een publieke ruimte in Nederland Buma/Stemra en
Sena). Dat is een beslissing, geen bouwwerk.

### De kassa als speler (en bluetooth)

Naast het bijsturen van een ander apparaat kan de kassa het ook **zelf spelen**.
Dat onderscheid is de kern, want het bepaalt of bluetooth werkt:

| | Wie is de bron | Bluetooth? |
|---|---|---|
| **Muziek** (bijsturen, UPnP) | een speaker op het netwerk | nee — daar valt niets te besturen |
| **Speler** (zelf spelen) | de kassa | **ja** — Windows stuurt het geluid naar de box |

Bij de Speler hoeft er niets bestuurd te worden: de kassa *is* de bron, dus
pauze en volgende zijn gewoon knoppen. Waar het geluid uitkomt bepaalt Windows —
de luidspreker van de pc, een kabel naar de versterker, of een gekoppelde
bluetooth-box. Koppelen doe je één keer in Windows, bij Bluetooth-apparaten; de
kassa hoeft daar niets van te weten.

Drie bronnen:

- **Muziek van een map.** Wijs één keer een map aan; de kassa kijkt twee mappen
  diep. Werkt volledig offline. Speelt mp3, m4a, aac, flac, ogg, opus en wav —
  precies wat Chromium ook echt kan weergeven, want een ruimere lijst levert
  bestanden op die stil overgeslagen worden.
- **Radiostream.** Een of meer adressen die je zelf toevoegt. Heeft internet
  nodig, en stopt dus als de verbinding wegvalt — terwijl de rest van de kassa
  doorwerkt. Dat staat er ook bij in het scherm.
- **Video op een tweede scherm.** Een eigen venster dat op het tweede scherm
  volledig scherm opengaat, met de video's uit dezelfde map. Standaard zonder
  geluid, want anders klinkt het door de muziek heen.

> **Video gaat niet over bluetooth.** Er staat wel een videoprofiel in de
> bluetooth-specificatie, maar geen enkel apparaat dat je koopt gebruikt het.
> Beeld gaat via HDMI naar een scherm, of via een Chromecast. Dat is geen
> beperking van deze app.

Twee dingen die in de bouw belangrijk waren:

**Het geluidselement staat buiten React** (`src/store/useSpeler.ts`). Zet je een
`<audio>` in een component, dan stopt de muziek zodra iemand naar een ander
tabblad gaat — want dan wordt dat component afgebroken. Aan een kassa ga je de
hele dag heen en weer tussen afrekenen en de klok, dus dat is onbruikbaar.

**De speler mag alleen in de gekozen map kijken.** Bestanden gaan via een eigen
`speler://`-adres naar de speler, en dat adres levert alleen uit wat onder een
aangewezen map staat. Zonder die grens zou het scherm elk bestand op de schijf
kunnen opvragen — en op dit apparaat staat ook een kassa-administratie. Vijf
controles in de zelftest dekken die grens, inclusief de omweg met `..`.

### Pinautomaat

**Nu:** met de hand intoetsen. De kassa laat het bedrag groot in beeld zien, je
toetst het op de pinautomaat, en bevestigt hier dat het gelukt is. Het bonnummer
van de automaat kan erbij. Dit werkt altijd en is controleerbaar.

**Een echte koppeling** vraagt een contract bij de provider. De aansluiting
staat klaar in [`electron/terminal.cjs`](electron/terminal.cjs), met per provider
wat er nog nodig is:

| Provider | Wat het vraagt |
|---|---|
| CCV | terminal met "CCV Pay lokaal" aan, IP-adres, documentatie uit het contract |
| Adyen | Terminal API, API-sleutel en POI-id; lokaal (niet via de cloud, anders hangt de kassa aan internet) |
| SumUp | geen koppeling voor Windows — daar blijft het handmatig |

De sleutel hoort **niet** in de kassa-instellingen (die reizen mee naar elke
kassa) maar in de lokale instellingen van dat ene apparaat.

---

## Hoe het offline werkt

Alles wat het scherm toont komt uit de lokale cache (Dexie/IndexedDB), nooit
rechtstreeks van de server. Afrekenen, bonnummer, bon afdrukken en lade openen
gebeuren volledig lokaal en zijn klaar voordat het netwerk erbij komt. Wat naar
de server moet gaat in een wachtrij die automatisch leegloopt zodra er weer
verbinding is.

Het aantal wachtende wijzigingen staat altijd rechtsboven in beeld. Blijft dat
oplopen, dan is er iets aan de hand — niet met de verkoop, maar met de
verbinding.

Een paar keuzes die hieruit volgen:

- **Bonnummers** lopen op het apparaat door, niet op de server. Anders kon je
  offline niet afrekenen.
- **Het saldo van een strippenkaart** is geen veld maar een som: wat erop zat,
  min alle afboekingen. Twee kassa's die tegelijk offline een strip gebruiken
  zouden anders elkaars saldo overschrijven. De prijs: een kaart kan één keer
  over zijn saldo heen als twee kassa's tegelijk de laatste strip pakken. Dat
  valt op bij het volgende bezoek, en het is beter dan een chauffeur die niet
  weg kan.
- **Contant geld** valt altijd in een kassadag. Staat er geen kas open, dan
  opent de kassa er een met €0 wisselgeld en zegt dat erbij — beter dan contant
  geld dat nergens bij hoort.

## Een afgerekende bon staat vast

Niet omdat de app het verbiedt, maar omdat de database het weigert. Bedragen,
betaalwijze, bonnummer en tijdstip van een afgerekende bon zijn niet meer te
wijzigen, en de bon is niet te verwijderen. Terugdraaien gebeurt met een
**creditbon** die naar de oorspronkelijke verwijst; voorraad en strippen gaan
mee terug.

Dat is wat een administratie bruikbaar maakt voor een boekhouder, en het is wat
de Belastingdienst van een kassasysteem verwacht.

---

## Ontwikkelen

```bash
npm run dev             # alleen de browser, op poort 5174
npm run electron:dev    # Electron met live herladen
npm run build           # controle + typecheck + bundel
npm run selftest        # 187 controles: rekenwerk, nummers, afrekenen, kas, bon, muziek, speler
npm run kern:check      # wijkt de gedeelde kern af van het dashboard?
```

### Zien wat er op het scherm staat

```bash
npm run afdruk                                    # alle schermen
node scripts/schermafdruk.cjs --alleen=speler     # alleen wat je zoekt
```

Dit laat Electron zichzelf fotograferen: het inrichtscherm, het aanmeldscherm en
de schermen daarachter (Kassa, Klok, Kas, Muziek, Speler, Beheer), in licht en
donker, op 1366x850 en 1024x700. Het meldt zich onderweg zelf aan door een
personeelsnummer in te toetsen, en zet daarvoor nepgegevens in IndexedDB.

Dat is geen luxe. Drie fouten zijn hiermee gevonden en niet met code lezen: een
knop die over de rand van een kaart lag, een uitgeschakelde knop die modderig
olijf werd, en een toetsenblok dat voorloopnullen weghaalde — waardoor
personeelsnummer 014 stil 14 werd en niemand met een nul vooraan kon inloggen.

De afdrukken komen in `schermafdrukken/`, buiten git.

### De gedeelde kern

Een deel van de code is letterlijk hetzelfde als in het dashboard: het
domeinmodel van personeel en wasbeurten, de rechten, de Supabase-laag, het
offline inloggen. Dat is bewust een **kopie** en geen gedeeld pakket — de twee
apps hebben ieder hun eigen releaseritme, en een gedeeld pakket betekent dat je
voor elke kleine wijziging drie repositories moet uitbrengen.

De prijs van een kopie is dat hij stil kan gaan afwijken. Daarom is er een
script dat dat zichtbaar maakt:

```bash
npm run kern:check        # vergelijkt en zegt wat afwijkt
npm run kern:bijwerken    # haalt de wijzigingen hierheen
```

Het verwacht het dashboard naast deze map. Staat het elders:
`node scripts/kern-bijwerken.cjs --dashboard=D:/pad/naar/dashboard`

Deze bestanden vallen eronder:

```
src/lib/api/types.ts        src/lib/trail.ts
src/lib/offlineAuth.ts      src/lib/notify.ts
src/lib/format.ts           src/lib/permissions.ts
src/lib/gedeeldeTypes.ts    (uitgeknipt uit het types.ts van het dashboard)
```

Wat níét gedeeld is en dat ook niet hoort te zijn: `db.ts` (andere tabellen),
`sync.ts` (andere entiteiten en push-volgorde) en `api/supabaseApi.ts` (die van
de kassa pagineert door en heeft een historie-horizon, want bonnen lopen in de
tienduizenden).

### Bijwerken op een tablet

Windows en Android halen hun update uit **dezelfde release**. Alleen de weg
erheen is anders, want Android kent geen updater buiten de Play Store om — en
die is voor een app die alleen binnen dit bedrijf draait een omweg met een
wachttijd van dagen.

Wat de tablet doet:

1. bij het opstarten aan GitHub vragen wat de laatste release is;
2. is die nieuwer, dan de APK op de achtergrond ophalen;
3. melden dat er een versie klaarstaat.

Installeren gebeurt pas als iemand erop tikt, onder **Beheer → Versie**. Dat is
met opzet: een tablet die midden in een transactie vraagt of hij mag
herstarten, is erger dan een dag met de vorige versie werken.

Android vraagt daarbij één keer om bevestiging, en dat kan niet anders. Software
die zichzelf zonder vraag kan vervangen is precies wat het recht
`REQUEST_INSTALL_PACKAGES` gevaarlijk maakt. Staat dat recht nog niet aan — het
is een instelling per app en staat standaard uit — dan zegt de app dat vóórdat
je op de knop drukt, met een knop die de juiste systeempagina opent. Zonder die
melding zou het downloaden lukken en het installeren stil mislukken.

Waar het zit:

| Bestand | Wat het doet |
|---|---|
| [`src/lib/hardware/apkUpdate.ts`](src/lib/hardware/apkUpdate.ts) | vraagt GitHub om de laatste release, vergelijkt versienummers |
| [`android/.../ApkUpdater.java`](android/app/src/main/java/nl/truckwash1group/kassa/ApkUpdater.java) | downloadt, controleert de grootte, start de installatie |
| [`src/lib/updates.ts`](src/lib/updates.ts) | dezelfde store voor Windows en Android, dus het scherm hoeft het verschil niet te weten |

Het versienummer vergelijken gebeurt per onderdeel en niet als tekst — anders is
`0.10.0` ouder dan `0.9.0`. Dat gaat precies één keer mis, en dan sta je met een
tablet die weigert bij te werken zonder te zeggen waarom. De zelftest dekt het.

### Uitbrengen

```bash
npm version 0.1.1 --no-git-tag-version
git commit -am "Versie 0.1.1"
git tag v0.1.1
git push && git push --tags
```

De workflow draait eerst de zelftest, bouwt daarna de Windows-installer en de
APK, en hangt ze onder Releases. De geïnstalleerde kassa haalt zijn updates daar
vandaan: hij kijkt bij het starten en elk half uur, downloadt op de achtergrond
en installeert bij het afsluiten — of eerder, met de knop onder **Beheer →
Versie**, na de dagafsluiting.

Zet in de repo-instellingen op GitHub de secrets `VITE_SUPABASE_URL` en
`VITE_SUPABASE_ANON_KEY`. Zonder die twee bouwt hij een kassa waarin niemand kan
inloggen.

### Android-project

Staat in de repo (`android/`), met het pictogram en de eigen plugin erin. De
gebouwde webbundel staat er níét in: die maakt `cap sync` erbij.

```bash
npm run android:apk      # bouwt de APK lokaal
```

Het pictogram opnieuw maken na een wijziging aan het ontwerp:

```bash
python scripts/logo-maken.py
```

Dat schrijft alle maten in één keer: de Windows-installer, de vijf
launcher-dichtheden van Android, het adaptieve icoon (dat uit twee losse lagen
bestaat) en het opstartscherm. Sharp — dat `@capacitor/assets` normaal gebruikt —
werkt op deze machine niet door de npm 12-blokkade; PIL wel, en het is één
script minder afhankelijkheid.

> **Op deze machine:** Gradle 8.11 kan geen class files van JDK 25 lezen en
> stopt met "Unsupported class file major version 69". Er staat een Temurin JDK
> 21 in `~/.jdks/`; het pad hoort in `~/.gradle/gradle.properties` te staan,
> bewust buiten het project. En npm 12 blokkeert install-scripts, dus als
> Electron niet wil starten: `node node_modules/electron/install.js`.

---

## Wat er nog niet is

Eerlijk, zodat niemand ernaar hoeft te zoeken:

- **De pinautomaat is nog niet gekoppeld.** Er zijn gegevens van de
  betaalprovider voor nodig. Tot die tijd: met de hand intoetsen en bevestigen.
- **Afdrukken op een tablet.** Vraagt een bluetooth-printer; nu staat de bon
  daar alleen op het scherm.
- **De installatie op Android is niet op een toestel geprobeerd.** De code
  compileert en de bouw slaagt, maar downloaden en installeren zijn hier niet
  te testen zonder tablet. Kijk bij de eerste keer of het recht om te
  installeren gevraagd wordt en of de update daarna doorkomt.
- **Factureren.** De kassa zet bonnen op rekening klaar; er komt nog geen
  factuur uit. Dat hoort in het dashboard, bij Financieel.
- **Rapportage over meerdere dagen.** De kassa toont de eigen kassadag en de
  laatste afsluitingen. Omzet per week of per vestiging hoort in het dashboard,
  waar alle bonnen samenkomen.
