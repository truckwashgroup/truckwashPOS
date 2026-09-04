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

### Alleen op je eigen vestiging

Wie op één vestiging staat, meldt zich alleen aan op de kassa van die
vestiging. Wie overal mag werken (`allLocations` in het dossier), mag elke
kassa. En wie leiding heeft over een vestiging, mag daar ook.

Dat gold niet vanzelf. De kassa haalt het personeel van zijn eigen vestiging
op, maar de beveiligingsregels laten ook dossiers **zonder** vestiging door —
die zijn "voor iedereen" — en wie een nummer intoetste dat in de cache stond,
kwam erin. Iemand van Asten die op de kassa in Rotterdam inklokt, komt met zijn
uren op de verkeerde vestiging terecht, en dat merkt niemand tot iemand ze
naast elkaar legt. Met één vestiging viel dat niet op; met achttien wel.

De melding noemt naam en vestiging: *"Aad van Asten staat op Asten en kan daar
aanmelden."* Niet "je mag hier niet" — daar probeert iemand het nog drie keer
mee, en als het niet klopt weet hij ook niet wat er in het dashboard verkeerd
staat.

> **Geen vestiging in het dossier betekent geen toegang.** Dat is streng en met
> opzet: juist die dossiers staan bij élke kassa in de cache, dus dat was de
> opening. In het dashboard is het onder Personeel in tien seconden rechtgezet,
> en de kassa zegt dat er ook zo bij.

Een kassa die zelf geen vestiging heeft, toetst niets — een kassa op slot
zetten om ontbrekende gegevens is erger dan het gat dat het dicht.

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

In het dashboard, onder **Personeel → Rechten**, staan zes nieuwe rechten:

| Recht | Wat het toestaat | Standaard bij |
|---|---|---|
| `pos.use` | Afrekenen en de bon afdrukken | iedere werknemer |
| `pos.discount` | Korting geven en prijzen aanpassen | leidinggevende |
| `pos.refund` | Een afgerekende bon crediteren | leidinggevende |
| `pos.cash` | Kas openen, tellen en de dag afsluiten | leidinggevende |
| `pos.safe` | De kluis: afstorten, wisselgeld, tellen | management |
| `pos.manage` | Artikelen, prijzen, codes en de printer | management |

**Wie geen `pos.use` heeft, komt niet achter de kassa.** Dat stond hier al,
maar werd tot versie 0.14.0 nergens getoetst: wie een nummer intoetste dat in
de cache stond, kwam erin. Nu wordt het gecontroleerd bij het aanmelden én bij
de badge, en wordt iemand die het recht halverwege verliest binnen een
synchronisatieronde afgemeld.

Inklokken vraagt dit recht met opzet niet. Iedereen op de vloer klokt in, ook
wie niet achter de kassa mag staan — zou het klokscherm `pos.use` vragen, dan
kan de helft van het personeel zijn uren niet kwijt.

De kluis staat bewust een stap hoger dan de lade. De lade telt wie er die dag
achter staat; de kluis is van het bedrijf. Wie het recht niet heeft, ziet de tab
Kluis niet — een tab die je wel ziet maar niet in kunt, is aan een balie een
gesprek dat niemand wil hebben met een chauffeur die staat te wachten.

### 3. De kassa zelf

```bash
cp .env.example .env      # zelfde twee waarden als in de dashboard-repo
npm install
npm run electron:dev      # of: npm run dev  voor alleen de browser
```

Bij de eerste start vraagt de kassa om één ding: een **koppelcode** van acht
tekens. Die maakt het kantoor aan in het dashboard, bij de kassa waar dit
apparaat op komt te staan.

Hoe dat loopt:

1. **Dashboard** — vestiging aanmaken (als die er nog niet is), dan een kassa met
   een korte unieke code (`KAS-UTR-1`; daarmee beginnen de bonnummers), dan een
   koppelcode bij die kassa.
2. **Kassa** — code intikken. Meer niet. Het apparaat krijgt zijn eigen inlog en
   staat vanaf dat moment in de lijst met apparaten.

Een koppelcode werkt **één keer** en verloopt. Er staat geen e-mailadres en geen
wachtwoord van een mens meer op een tablet achter de balie.

### Op afstand op slot of eruit

Vanuit het dashboard, bij het apparaat:

| Wat je doet | Wat de kassa doet |
|---|---|
| **Blokkeren** | Gaat op slot: er kan niet mee verkocht en niet mee geklokt worden. Blijft wél synchroniseren, dus wat er nog op stond komt alsnog binnen. Weer aanzetten kan. |
| **Intrekken** | Stuurt eerst zijn wachtrij leeg, logt zich daarna volledig uit, wist zich en meldt dat terug (`wiped_at`). Daarna is er een nieuwe code nodig. |

Die twee stappen bij het intrekken zijn er met een reden. Trek je de inlog er
direct onderuit, dan kan de omzet die nog op dat apparaat stond nergens meer
aankomen — en die staat dan nergens. Zolang er iets in de wachtrij staat, laat
de kassa dat groot in beeld zien in plaats van zich te wissen.

**Wat de kassa laat zien.** Het hele scherm, in de kleur, met
waarschuwingsstrepen en één woord op 64 pixels: **GEBLOKKEERD** of **ERUIT
GEHAALD**, met de code van de kassa eronder zodat je weet welke je aan de
telefoon hebt. Er is niets anders meer te bedienen — nul toetsen, nul
tabbladen; de zelftest meet dat per afdruk.

Dat was eerst een net kaartje in de huisstijl: een slotje van 34 pixels en een
alinea in grijs. Zo'n kaartje leest als "er ging iets mis, probeer het opnieuw",
en dan gaat iemand herstarten of opnieuw koppelen. Blokkeren is nooit iets
kleins — een tablet die kwijt is, een kassa waar iets mee aan de hand is — dus
hoort het te lezen als een besluit en niet als een storing.

Geen geluid, met opzet: een kassa die begint te piepen op een wasstraat waar
mensen werken wordt uitgezet of in een kast gelegd, en dan stopt ook het
versturen van wat er nog op staat.

**"Volledig uitloggen" is letterlijk.** Bij een intrekking ging alleen de lokale
cache leeg. Wat bleef staan: de sessie bij Supabase, de bewaarde inloggegevens,
het apparaat in het geheugen van de app, en de synchronisatie die met dat
account bleef draaien — en dus gegevens terughaalde in een cache die net gewist
was. Een tablet die eruit gegooid was, hield daarmee een geldige inlog op het
account van die kassa.

Er is nu één weg naar buiten (`useAuth.ontkoppel`), en de knop aan de balie en
de intrekking op afstand lopen hem beide. Twee deuren waarvan er één de helft
deed, is hoe dit is ontstaan. Afdeling 24 van de zelftest loopt alle vijf de
dingen na, plus de rem: met een bon in de wachtrij gaat er niets weg en blijft
hij versturen.

### Deze kassa ontkoppelen

**Beheer → Deze kassa → Kassa ontkoppelen.** Maakt dit apparaat los, zodat er
een nieuwe koppelcode in kan. Vraagt het recht `pos.manage`.

Dit is iets anders dan afmelden. Afmelden gaat over wie er achter de kassa
staat en wisselt de hele dag; ontkoppelen gaat over het apparaat, en dan gaat
ook de leeskopie van deze vestiging eruit — een kassa die naar Rotterdam
verhuist mag daar niet aankomen met de artikelen, het personeel en de kluis van
Utrecht.

De wachtrij gaat voor. Staat er nog iets in, dan is de knop uit, met "Nu
versturen" ernaast: daarin kan omzet zitten die nergens anders bestaat. Kan een
kassa de server echt niet meer bereiken, dan zit er een tweede weg onder die
vraagt om de code van de kassa letterlijk in te tikken. Wat er dan in de
wachtrij stond is weg, en er komt een regel in het logboek.

Wat blijft staan is het kenmerk van dit apparaat. Daardoor herkent de server hem
na een nieuwe code als hetzelfde apparaat in plaats van als een tweede op
dezelfde kassa — en dat laatste weigert de database.

> **Twee apparaten nooit op dezelfde kassa.** De bonnummering loopt op het
> apparaat door, dus twee kassa's met dezelfde code delen dezelfde nummers uit.
> Dit houdt de database nu tegen (`pos_devices`, één actief apparaat per kassa) —
> eerder was het alleen een waarschuwing. Moet er een tweede apparaat aan
> dezelfde balie, geef dat een eigen kassa.

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

#### Artikelen van Trucksupply

De leverancier beheert de artikelen in het dashboard. Wat daar staat komt via
`inventory_items` in de kassa terecht, en een serverfunctie zet het in
`pos_products` — niemand tikt een artikel twee keer in.

Op het kassascherm betekent dat:

- **De foto komt van het artikel** als er geen eigen productfoto is. Zet je er
  hier zelf een, dan gaat die voor: die heeft iemand aan de kassa met opzet
  gekozen.
- **De voorraadstand staat op de tegel** bij alles wat aan de voorraad hangt.
  Grijs lees je langs, geel is onder het minimum (Trucksupply heeft daar al
  bericht van), rood is op. De balie hoeft er niets aan te doen, maar wie iets
  niet kan verkopen hoort te kunnen zien waarom.
- **Een artikel dat de leverancier uitzet, verdwijnt van het scherm.** Een bon
  die er al mee bezig was kan gewoon af — anders staat er een chauffeur met een
  fles in zijn hand die niet meer af te rekenen valt.

**Beheer → Artikelen is alleen lezen.** Je ziet wat er in de cache staat, met
de foto, de prijs, de barcode en de voorraadstand erbij — genoeg om aan de
balie na te kijken waarom iets niet te vinden of niet te verkopen is. Boven de
lijst staat hoeveel artikelen er zijn opgehaald, hoeveel er een foto hebben en
wanneer dat voor het laatst is bijgewerkt: dat is wat je wil weten *vóórdat* de
lijn eruit ligt.

Er valt daar niets te wijzigen, en dat is een keuze en geen beperking waar we
tegenaan liepen:

1. De database staat het een kassa-account niet toe (`pos_products` vraagt
   `mag_kassa_beheren()`). Een scherm dat invoer aanneemt die de server weigert,
   is een scherm dat liegt.
2. En het is gevaarlijker dan alleen vergeefs. De kassa heeft een kopie van elk
   artikel. Zou hij die terugsturen, dan overschrijft een kassa die een dag uit
   heeft gestaan de prijs die gisteren is gezet — laatste schrijver wint. Eén
   tablet in een hoek kan zo een prijswijziging ongedaan maken zonder dat
   iemand het ziet.

Daarom staat `products` op de lijst van tabellen die de kassa **nooit**
verstuurt (`NOOIT_STUREN` in `sync.ts`). Een wijziging die er toch in belandt,
wordt niet in de wachtrij gezet, en wat er nog stond wordt bij het opstarten
opgeruimd — met een regel in het logboek. Dat is met opzet de enige plek waar
de kassa iets uit de wachtrij gooit: die rijen zouden er anders voor altijd
blijven staan, want de server weigert ze en de regels rond rechten gooien ze
juist niet weg.

> **Badges hebben hetzelfde.** `pos_pins` vraagt ook `mag_kassa_beheren()`. Een
> badge die op een gekoppelde kassa wordt aangemaakt werkt alleen op dát
> apparaat en op geen enkele andere — en dat merk je pas als iemand een andere
> balie binnenloopt. Die knoppen staan daarom uit, met de reden erbij.

#### Een foto bij het artikel

Onder het formulier van een artikel staat **Foto**. Op een tablet opent die knop
meteen de camera; op de Windows-kassa kies je een bestand.

Dat is geen opsmuk. Aan een balie zoek je niet op naam maar op hoe iets
eruitziet: twee flessen ruitenwisservloeistof van hetzelfde merk verschillen
een letter in de naam en een kleur op het etiket, en wie er de hele dag staat
kiest op die kleur. Zodra één artikel een foto heeft, krijgen alle tegels in dat
lijstje dezelfde vorm — anders wordt het rooster een trap.

De foto gaat **in de artikelrij** mee en niet in een bestandsopslag achter een
URL. Dat is met opzet: de kassa moet het zonder internet doen, en een foto
achter een adres is een grijs vlak zodra de lijn eruit ligt. De prijs daarvan is
grootte, en die wordt hier betaald: wat uit een tabletcamera komt is
megabytes, wat een tegel nodig heeft is tienden van een kilobyte. Elke foto
wordt daarom op het apparaat verkleind tot maximaal 400 pixels op de lange
zijde en samengeperst tot onder 48 kB, met de kwaliteit stap voor stap omlaag
tot het past. Lukt dat niet, dan zegt de kassa dat in plaats van hem alsnog op
te slaan. De database heeft er een tweede rem onder (150 kB per rij).

### 5. Klant voor losse ritten

Een wasopdracht hoort in de database bij een klant, en dat veld mag niet leeg
zijn. Verkoop je een wasbeurt aan een losse chauffeur, dan is er geen klant.
Maak daarom in het dashboard één bedrijf aan (bijvoorbeeld "Losse ritten") en
wijs dat aan onder **Beheer → Deze kassa**. Zonder die instelling wordt de
wasbeurt gewoon verkocht, maar komt hij niet in de wachtrij — dan is de bon het
enige bewijs.

---

## De kluis

Naast de lade van de kassa staat op elke vestiging een kluis. De kassa houdt
allebei bij, en het scherm **Kluis** laat ze naast elkaar zien: wat er in de
kluis ligt en wat er in de lade hoort te liggen.

### Er wordt geteld, niet ingetikt

Dat is de kern van dit scherm en geen aardigheidje. Wie 340 euro afstort, legt
drie briefjes van honderd en twee van twintig neer. Tikt hij "340" in, dan is er
achteraf geen manier om te zien dat er 240 lag — een 3 en een 4 liggen naast
elkaar op een cijferblok, en beide getallen zien er even geloofwaardig uit.
Aantikken kan ook fout, maar dan zie je het: er staat "2x € 100" terwijl je er
drie in je hand hebt.

Er staat in het hele kluisscherm dus geen enkel veld waarin je een bedrag
intikt. Ook het tellen van de lade bij de dagafsluiting gaat zo — één manier om
geld te tellen in de hele app.

### Wat je kunt doen

| Handeling | Waar het geld heen gaat |
|---|---|
| **Afstorten uit de kassa** | Lade → kluis. Boekt in één keer bij de kluis en af van de kassadag. |
| **Wisselgeld halen** | Kluis → lade. Andere kant op, ook in één keer. |
| **Naar de bank** | Kluis → bank of geldophaaldienst. |
| **Van de bank** | Rollen munten opgehaald. |
| **Contante uitgave** | Uit de kluis, met een verplichte toelichting. |
| **Kluis tellen** | Vaststellen wat er ligt. |

Wat de kluis uit gaat, kan niet meer zijn dan er ligt: die vakjes geven niet
mee, en eronder staat hoeveel er nog over is. Er wordt niet gewisseld — vijf
briefjes van tien is hetzelfde bedrag als één van vijftig, maar niet hetzelfde
als wat je in je hand hebt.

Van de **lade** kent de kassa het bedrag en niet de briefjes: daar gaat de hele
dag wisselgeld uit. Wat er precies in ligt, blijkt bij het tellen onder Kas.

### De telling is het ijkpunt

Het saldo van de kluis is geen veld maar een som: vanaf de laatste telling
optellen. Dat is dezelfde keuze als bij het saldo van een strippenkaart, en om
dezelfde reden — twee mensen die offline tegelijk iets uit de kluis halen zouden
elkaars saldo overschrijven; regels bij elkaar optellen kan niet fout gaan.

Bij een telling zie je wat er hoorde te liggen **pas nadat** je hebt geteld.
Anders tel je naar een getal toe; niet omdat iemand oneerlijk is, maar omdat een
mens zo werkt.

Het verschil wordt vastgelegd en niet weggerekend. Een kluis die elke maand tien
euro mist, is iets anders dan een kluis die klopt, en dat verschil hoort
zichtbaar te blijven.

### Een boeking staat vast

De database weigert een kluisboeking te wijzigen of te verwijderen — net als bij
een afgerekende bon. Een vergissing zet je recht met een tegenboeking of met een
telling. Dan blijft te zien wat er gebeurd is, en dat is precies wat een
kasadministratie moet kunnen.

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

### Als er een update klaarstaat

**Hij installeert zichzelf, aan de voorkant, zonder dat iemand inlogt.**

Dat is sinds 0.15.0 zo, en de reden is de vorige opzet: installeren stond onder
**Beheer → Versie**, en Beheer zit achter een aanmelding. Een kassa waar
niemand achter staat — of waar degene die er staat geen beheerrecht heeft —
werkte dus nooit bij. En dat is precies de kassa die het het langst niet doet:
de tablet bij de tankzuil waar één keer per week iemand komt. Op Windows was er
nog een tweede weg (electron installeert bij het afsluiten), maar een kassa die
maanden aanstaat sluit nooit af.

Op het aanmeldscherm staat nu onderin de versie, een link om te kijken of er
een nieuwe is, en — als er een klaarstaat — wat er gaat gebeuren, met **Nu
installeren** en **Straks** erbij. Dat werkt ook op een kassa die nog niet
gekoppeld is.

Wanneer hij het zelf doet ([`src/lib/updateMoment.ts`](src/lib/updateMoment.ts),
afdeling 22 van de zelftest):

| voorwaarde | waarom |
| --- | --- |
| niemand aangemeld | anders verdwijnt het scherm onder de handen van iemand die afrekent |
| niets in het mandje | de bon overleeft een herstart wel, de chauffeur die ernaar kijkt niet |
| niets aan het versturen | de wachtrij gaat niet verloren, maar een ronde afmaken is goedkoper dan hem overdoen |
| 45 seconden niets aangeraakt | iemand die zijn personeelsnummer intikt is niet "niemand" |

Die laatste is de belangrijkste, want de andere drie zijn toestanden en deze is
een moment.

Op **Android gaat het nooit vanzelf**, en dat is geen keuze van ons: het
systeem zet altijd zijn eigen bevestiging voor een installatie. Zou de kassa
daar uit zichzelf beginnen, dan staat er op een onbeheerde tablet een
systeemvenster over het aanmeldscherm, en de eerste die langskomt ziet niet
zijn kassa maar een vraag van Android — en drukt op Annuleren. Daar doet de
knop op het aanmeldscherm dus het werk, en die vraagt geen aanmelding.

Waar het staat is gemeten en niet bedacht. Eerst stond het onder het
toetsenblok; op een breedbeeldscherm van 850 hoog zakte het daar uit beeld
(toetsenblok, twee knoppen en twee regels uitleg vullen die kolom al). Nu staat
het onderin de merkkolom, die leeg is, en op een smal scherm — waar die kolom
wegvalt — in een eigen rij onder het werk. De zelftest meet per afdruk of alle
twaalf toetsen te raken zijn en of de melding binnen het venster valt.

Onder Beheer staat nog wel een stip op het tabblad, en daar staat ook de
uitleg. Verder niets: een update is nieuws en geen alarm.

**Nakijken of het werkt.** In het dashboard staat onder Kassa's bij elk
apparaat de versie die het draait. Die kolom bestond al (`pos_devices.app_version`)
maar bleef altijd leeg: bij het koppelen stuurde de kassa
`import.meta.env.VITE_APP_VERSION` mee, en die variabele bestaat nergens — geen
foutmelding, alleen een veld dat nooit gevuld raakte. En `apparaatGezien()` hield
alleen `last_seen_at` bij, ook als de versie ondertussen veranderd was.

Vanaf 0.16.0 meldt de kassa zijn versie mee, en een versieverandering wacht het
uur van die melding niet uit: na een update herstart hij, en dan is dat de
eerste ronde. Staat er in het dashboard "versie onbekend", dan draait die kassa
iets ouder dan 0.16.0.

Er stond eerder een pil "versie 0.10.1 klaar" in de balk bovenaan. Dat werkte
precies één keer goed — zodra er iets bij kwam, bijvoorbeeld een vastgelopen
wachtrij, was de balk vol en schoof Beheer buiten bereik. Je kon dan dus niet
meer bij het scherm waar je die update installeert.

De tabbladen wikkelen nu naar een tweede regel in plaats van te schuiven. Dat
kost hoogte, maar alleen als het niet past, en elke tab blijft raakbaar — op
een aanraakscherm is een strook die je eerst moet verschuiven geen tabblad
meer. Op een smal scherm valt de tijd weg; die staat ook op elke bon.

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

### Wat er nooit stil mag verdwijnen

De wachtrij probeert een wijziging acht keer en geeft hem daarna op. Dat is de
juiste keuze voor een record dat echt stuk is — anders blijft één kapotte regel
alles erachter tegenhouden.

Maar vier weigeringen zeggen niets over het record:

| Weigering | Wat het betekent |
|---|---|
| **rechten** | de database weigert het op de beveiligingsregels |
| **geen sessie** | de kassa is niet meer ingelogd bij de server |
| **tabel bestaat niet** | het schema loopt achter op de app |
| **kolom bestaat niet** | idem |

Onder die omstandigheden wordt *alles* geweigerd. Nog eens proberen maakt dat
niet beter, en na de achtste keer is er werk weg om een reden die er los van
staat. Die vier verbruiken daarom geen pogingen en worden **nooit** weggegooid —
ze blijven staan tot het klopt, en gaan dan alsnog mee.

Dat is geen theorie: het ging één keer mis. Het apparaataccount miste een recht,
de database weigerde een inklokking, en die verdween na acht rondes. Aan de balie
was niets te zien — de medewerker had "is ingeklokt" gelezen en stond onder "Nu
aan het werk". Dat de regel de server nooit gehaald had, bleek pas bij de
urenstaat.

De teller die de weigeringen bijhoudt (`geweigerd`) staat los van `tries`, en met
opzet: die tweede leidt tot weggooien en de eerste nooit. Eén veld voor beide
zou betekenen dat het slot op de volgorde van twee stukjes code leunt.

### En het is aan de balie te zien

Zodra er iets vastzit, staat er rechts in de balk een rode pil — *1 klokregel
vast* — die naar het klokscherm brengt. Daar staat boven "Nu aan het werk" wat
er vastzit, sinds wanneer, wat de server erover zegt, en wat er nu te doen valt.

Uren worden bij naam genoemd en de rest niet. Dat is een keuze: een bon die
vastzit is een probleem van de zaak, een inklokking die vastzit is het loon van
degene die ernaar kijkt. Wie zijn uren kwijtraakt hoort dat vandaag te merken —
dan weet hij nog hoe lang hij er stond. Aan het eind van de maand is het zijn
woord tegen een lege urenstaat.

In die melding staat expliciet dat er niets is weggegooid. Zonder die regel leest
hij als "je uren zijn kwijt", en gaat iemand ze op een briefje bijhouden terwijl
ze er nog zijn.

Een wijziging die gewoon nog niet verstuurd is, geeft géén waarschuwing. Dat
verschil is belangrijk: stond er een melding zodra de kassa een seconde offline
is, dan leert iedereen hem wegkijken.

---

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
npm run selftest        # 189 controles: rekenwerk, nummers, afrekenen, kas, bon, muziek, speler
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

1. bij het opstarten **en daarna elk half uur** aan GitHub vragen wat de
   laatste release is;
2. is die nieuwer, dan de APK op de achtergrond ophalen;
3. melden dat er een versie klaarstaat — op het aanmeldscherm, met een knop.

Dat halfuur was er niet: de tablet keek alleen bij het opstarten. Een tablet
achter een balie gaat maanden niet uit, dus die keek één keer en daarna nooit
meer — precies de kassa waar dit voor bedoeld was.

Installeren gebeurt als iemand op die knop tikt. Dat hoeft niet iemand met
beheerrechten te zijn en er hoeft niemand voor in te loggen; zie *Als er een
update klaarstaat*. Vanzelf kan het op Android niet, en een tablet die midden
in een transactie vraagt of hij mag herstarten zou ook niemand willen.

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
