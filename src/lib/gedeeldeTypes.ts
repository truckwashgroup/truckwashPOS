/* ------------------------------------------------------------------ *
 *  GEDEELD MET DE WASSTRAAT-APP -- niet met de hand wijzigen
 *
 *  Dit bestand is overgenomen uit src/lib/types.ts van het dashboard. De
 *  kassa en het dashboard schrijven in dezelfde tabellen, dus als deze
 *  definities uit elkaar lopen gaan er gegevens verloren die niemand mist
 *  totdat de boekhouder ernaar vraagt.
 *
 *  Bijwerken:  node scripts/kern-bijwerken.cjs --schrijf
 * ------------------------------------------------------------------ */

export type Role =
  | 'employee' | 'supervisor' | 'technician' | 'customer' | 'management' | 'developer'

export const ROLE_LABELS: Record<Role, string> = {
  employee: 'Werknemer',
  supervisor: 'Leidinggevende',
  technician: 'Technische dienst',
  customer: 'Klant',
  management: 'Management',
  developer: 'Ontwikkelaar',
}

export const ROLE_ORDER: Role[] =
  ['employee', 'supervisor', 'technician', 'customer', 'management', 'developer']

export interface User {
  id: string
  email: string
  /** Alleen voor de mock-backend. Echte backend hasht dit serverside. */
  password: string
  name: string
  roles: Role[]
  /** Gekoppeld klantaccount (alleen relevant voor rol 'customer') */
  companyId?: string
  hourlyRate?: number
  active: boolean
  updatedAt: number

  /* --- personeelsdossier --- */

  /** Intern personeelsnummer, bijv. TW-014 */
  personnelNumber?: string
  phone?: string
  /** Contracturen per week */
  contractHours?: number
  /** Datum in dienst (epoch ms) */
  startDate?: number
  /** Datum uit dienst, leeg zolang iemand in dienst is */
  endDate?: number
  function?: string
  notes?: string
  /**
   * Het inlogaccount waaraan dit dossier hangt. Leeg betekent: wel op de
   * loonlijst, nog geen toegang tot de app.
   */
  authId?: string

  /**
   * Afwijkingen op wat de rollen standaard toestaan. Hiermee stel je per
   * persoon precies bij wat wel en niet mag -- ook bij een leidinggevende,
   * zonder dat je daar een nieuwe rol voor hoeft te verzinnen.
   */
  grants?: Permission[]
  revokes?: Permission[]

  /** Onder welke leidinggevende deze medewerker valt */
  supervisorId?: string

  /* --- locaties --- */

  /** De vestiging waar deze persoon werkt */
  locationId?: string
  /**
   * Locaties waar deze persoon leiding over heeft. Een leidinggevende met
   * twee vestigingen heeft zijn rechten alleen daar, niet elders.
   */
  manages?: string[]
  /** Hoofdkantoor: ziet en mag alles, op alle vestigingen */
  allLocations?: boolean
}

export type LocationKind = 'vestiging' | 'hoofdkantoor'

export interface Location {
  id: string
  /** Korte code, bijv. TW-UTR */
  code: string
  name: string
  kind: LocationKind
  address: string
  postcode: string
  city: string
  phone?: string
  /** Vestigingsmanager */
  managerId?: string
  managerName?: string
  /** Aantal wasstraten op deze locatie */
  bays: number
  active: boolean
  updatedAt: number
}

export interface Company {
  id: string
  name: string
  contact: string
  email: string
  phone: string
  city: string
  /** Afgesproken tarief per wasbeurt-type, override op standaardprijs */
  contractDiscountPct: number
  updatedAt: number
}

export type WashStatus = 'gepland' | 'wachtrij' | 'bezig' | 'gereed' | 'geannuleerd'

export type ServiceKind = 'buitenwas' | 'binnenwas' | 'combi' | 'tankreiniging' | 'polish'

export const SERVICES: Record<ServiceKind, { label: string; minutes: number; price: number }> = {
  buitenwas: { label: 'Buitenwas', minutes: 25, price: 65 },
  binnenwas: { label: 'Cabine binnen', minutes: 35, price: 55 },
  combi: { label: 'Combi (buiten + cabine)', minutes: 50, price: 110 },
  tankreiniging: { label: 'Tankreiniging', minutes: 90, price: 245 },
  polish: { label: 'Polijsten / coating', minutes: 180, price: 480 },
}

export interface WashJob {
  id: string
  ticket: string
  locationId: string
  companyId: string
  companyName: string
  plate: string
  service: ServiceKind
  status: WashStatus
  /** user.id van de werknemer */
  assignedTo?: string
  assignedName?: string
  scheduledAt: number
  startedAt?: number
  completedAt?: number
  priceExcl: number
  notes?: string
  createdBy: string
  updatedAt: number
}

export interface InventoryItem {
  id: string
  /** Voorraad wordt per vestiging bijgehouden */
  locationId: string
  name: string
  unit: string
  stock: number
  minStock: number
  pricePerUnit: number
  supplier: string
  updatedAt: number
}

export interface StockMovement {
  id: string
  locationId?: string
  itemId: string
  itemName: string
  /** negatief = verbruik, positief = ontvangst */
  qty: number
  reason: string
  jobId?: string
  userId: string
  userName: string
  at: number
}

export interface TimeEntry {
  id: string
  locationId?: string
  userId: string
  userName: string
  jobId?: string
  start: number
  end?: number
  note?: string
  updatedAt: number
}

export type Permission =
  /* wasopdrachten */
  | 'jobs.view' | 'jobs.claim' | 'jobs.edit' | 'jobs.assign' | 'jobs.cancel'
  /* planning */
  | 'planning.view' | 'planning.edit'
  /* rooster */
  | 'roster.viewOwn' | 'roster.viewTeam' | 'roster.edit' | 'roster.publish'
  /* uren */
  | 'hours.own' | 'hours.viewTeam' | 'hours.approve'
  /* voorraad */
  | 'inventory.view' | 'inventory.adjust' | 'inventory.manage'
  /* kosten */
  | 'expenses.submit' | 'expenses.viewTeam' | 'expenses.approve'
  /* personeel */
  | 'staff.view' | 'staff.create' | 'staff.edit' | 'staff.permissions' | 'staff.pay'
  /* klanten */
  | 'customers.view' | 'customers.manage'
  /* financieel */
  | 'finance.view' | 'finance.export'
  /* berichten */
  | 'notify.send' | 'notify.broadcast'
  /* opleiding */
  | 'learning.take' | 'learning.assign' | 'learning.manage'
  /* techniek */
  | 'assets.view' | 'assets.manage'
  | 'faults.report' | 'faults.view' | 'faults.triage'
  | 'workorders.view' | 'workorders.create' | 'workorders.assign' | 'workorders.complete'
  | 'maintenance.view' | 'maintenance.manage'
  /* locaties */
  | 'locations.view' | 'locations.manage' | 'locations.all'
  /* meldingen aan de ontwikkelaar */
  | 'dev.report' | 'dev.tickets' | 'dev.respond' | 'dev.logs'
  /* overleg */
  | 'chat.use' | 'chat.manage' | 'chat.moderate'
  /* aanmeldingen */
  | 'signups.view' | 'signups.decide'
  /* postbus */
  | 'mail.read' | 'mail.send'
  /* kassa */
  | 'pos.use' | 'pos.discount' | 'pos.refund' | 'pos.cash' | 'pos.manage'
  /* beheer */
  | 'admin.settings' | 'admin.audit'

export interface PermissionMeta {
  key: Permission
  group: string
  label: string
  /** Wat dit recht in de praktijk betekent */
  hint: string
  /** Gevoelig: vraagt een extra bevestiging bij het toekennen */
  sensitive?: boolean
}

export const PERMISSIONS: PermissionMeta[] = [
  { key: 'jobs.view',         group: 'Wasstraat',  label: 'Wasopdrachten zien',   hint: 'De dagplanning en de wachtrij bekijken.' },
  { key: 'jobs.claim',        group: 'Wasstraat',  label: 'Wagens oppakken',      hint: 'Een wasbeurt aan zichzelf toewijzen en gereed melden.' },
  { key: 'jobs.edit',         group: 'Wasstraat',  label: 'Wasopdracht wijzigen', hint: 'Behandeling, tijd of opmerking aanpassen.' },
  { key: 'jobs.assign',       group: 'Wasstraat',  label: 'Wagens toewijzen',     hint: 'Bepalen wie welke wagen doet.' },
  { key: 'jobs.cancel',       group: 'Wasstraat',  label: 'Annuleren',            hint: 'Een wasbeurt schrappen.' },

  { key: 'planning.view',     group: 'Planning',   label: 'Volledige planning',   hint: 'Alle wasbeurten zien, ook van andere dagen.' },
  { key: 'planning.edit',     group: 'Planning',   label: 'Planning wijzigen',    hint: 'Wasbeurten verplaatsen en statussen zetten.' },

  { key: 'roster.viewOwn',    group: 'Rooster',    label: 'Eigen rooster',        hint: 'De eigen diensten bekijken.' },
  { key: 'roster.viewTeam',   group: 'Rooster',    label: 'Teamrooster',          hint: 'Het rooster van het hele team bekijken.' },
  { key: 'roster.edit',       group: 'Rooster',    label: 'Rooster maken',        hint: 'Diensten inplannen, wijzigen en verwijderen.' },
  { key: 'roster.publish',    group: 'Rooster',    label: 'Rooster publiceren',   hint: 'Een concept definitief maken en iedereen berichten.' },

  { key: 'hours.own',         group: 'Uren',       label: 'Eigen uren',           hint: 'In- en uitklokken, eigen registraties zien.' },
  { key: 'hours.viewTeam',    group: 'Uren',       label: 'Uren van het team',    hint: 'Zien hoeveel het team gewerkt heeft.' },
  { key: 'hours.approve',     group: 'Uren',       label: 'Uren goedkeuren',      hint: 'Registraties accorderen voor de verloning.' },

  { key: 'inventory.view',    group: 'Voorraad',   label: 'Voorraad zien',        hint: 'Standen en verbruik bekijken.' },
  { key: 'inventory.adjust',  group: 'Voorraad',   label: 'Verbruik boeken',      hint: 'Materiaal afboeken en leveringen bijboeken.' },
  { key: 'inventory.manage',  group: 'Voorraad',   label: 'Artikelen beheren',    hint: 'Artikelen toevoegen, prijzen en minima wijzigen.' },

  { key: 'expenses.submit',   group: 'Kosten',     label: 'Bon indienen',         hint: 'Zelf kosten ter goedkeuring aanbieden.' },
  { key: 'expenses.viewTeam', group: 'Kosten',     label: 'Bonnen van het team',  hint: 'Zien wat het team heeft ingediend.' },
  { key: 'expenses.approve',  group: 'Kosten',     label: 'Bonnen goedkeuren',    hint: 'Kosten accorderen of afkeuren.', sensitive: true },

  { key: 'staff.view',        group: 'Personeel',  label: 'Personeel zien',       hint: 'De medewerkerslijst en dossiers bekijken.' },
  { key: 'staff.create',      group: 'Personeel',  label: 'Medewerker toevoegen', hint: 'Nieuwe personeelsdossiers aanmaken.' },
  { key: 'staff.edit',        group: 'Personeel',  label: 'Gegevens wijzigen',    hint: 'Naam, functie en contracturen aanpassen.' },
  { key: 'staff.permissions', group: 'Personeel',  label: 'Rechten toekennen',    hint: 'Bepalen wat anderen mogen.', sensitive: true },
  { key: 'staff.pay',         group: 'Personeel',  label: 'Loongegevens zien',    hint: 'Uurtarieven en loonkosten inzien.', sensitive: true },

  { key: 'customers.view',    group: 'Klanten',    label: 'Klanten zien',         hint: 'Klantgegevens en contracten bekijken.' },
  { key: 'customers.manage',  group: 'Klanten',    label: 'Klanten beheren',      hint: 'Klanten toevoegen en kortingen wijzigen.' },

  { key: 'finance.view',      group: 'Financieel', label: 'Cijfers zien',         hint: 'Omzet, kosten en marge inzien.', sensitive: true },
  { key: 'finance.export',    group: 'Financieel', label: 'Exporteren',           hint: 'Overzichten downloaden of afdrukken.' },

  { key: 'notify.send',       group: 'Berichten',  label: 'Bericht sturen',       hint: 'Een melding sturen naar losse medewerkers.' },
  { key: 'notify.broadcast',  group: 'Berichten',  label: 'Iedereen berichten',   hint: 'Een melding naar een hele groep sturen.' },

  { key: 'learning.take',     group: 'Opleiding',  label: 'Cursussen volgen',     hint: 'De e-learning doorlopen.' },
  { key: 'learning.assign',   group: 'Opleiding',  label: 'Cursussen toewijzen',  hint: 'Bepalen wie wat moet doen en voortgang volgen.' },
  { key: 'learning.manage',   group: 'Opleiding',  label: 'Cursussen beheren',    hint: 'Lesmateriaal en toetsvragen aanpassen.' },

  { key: 'assets.view',        group: 'Techniek',  label: 'Installaties zien',    hint: 'Het machinepark en de gegevens per apparaat bekijken.' },
  { key: 'assets.manage',      group: 'Techniek',  label: 'Installaties beheren', hint: 'Apparaten toevoegen, wijzigen en QR-labels maken.' },
  { key: 'faults.report',      group: 'Techniek',  label: 'Storing melden',       hint: 'Een defect doorgeven, ook door een QR-code te scannen.' },
  { key: 'faults.view',        group: 'Techniek',  label: 'Storingen zien',       hint: 'Alle meldingen op je vestigingen bekijken.' },
  { key: 'faults.triage',      group: 'Techniek',  label: 'Storingen beoordelen', hint: 'Urgentie bepalen, toewijzen en afhandelen.' },
  { key: 'workorders.view',    group: 'Techniek',  label: 'Werkbonnen zien',      hint: 'De werkbonnen van je vestigingen bekijken.' },
  { key: 'workorders.create',  group: 'Techniek',  label: 'Werkbon maken',        hint: 'Zelf een werkbon aanmaken.' },
  { key: 'workorders.assign',  group: 'Techniek',  label: 'Werkbon toewijzen',    hint: 'Bepalen wie welke klus doet en wanneer.' },
  { key: 'workorders.complete', group: 'Techniek', label: 'Werkbon afronden',     hint: 'Uren, onderdelen en resultaat vastleggen.' },
  { key: 'maintenance.view',   group: 'Techniek',  label: 'Onderhoud zien',       hint: "De onderhoudsschema's en wat er openstaat." },
  { key: 'maintenance.manage', group: 'Techniek',  label: 'Onderhoud beheren',    hint: "Schema's en intervallen instellen." },

  { key: 'locations.view',    group: 'Locaties',   label: 'Locaties zien',        hint: 'De vestigingen en hun gegevens bekijken.' },
  { key: 'locations.manage',  group: 'Locaties',   label: 'Locaties beheren',     hint: 'Vestigingen toevoegen en wijzigen.', sensitive: true },
  { key: 'locations.all',     group: 'Locaties',   label: 'Alle vestigingen',     hint: 'Niet beperkt tot de eigen vestiging, maar overal bij.', sensitive: true },

  { key: 'dev.report',        group: 'Ontwikkeling', label: 'Melding maken',      hint: 'Een probleem of wens doorgeven aan de ontwikkelaar.' },
  { key: 'dev.tickets',       group: 'Ontwikkeling', label: 'Alle meldingen zien', hint: 'Het volledige ticketoverzicht van iedereen.', sensitive: true },
  { key: 'dev.respond',       group: 'Ontwikkeling', label: 'Reageren en afhandelen', hint: 'Antwoorden op meldingen en de status bijwerken.', sensitive: true },
  { key: 'dev.logs',          group: 'Ontwikkeling', label: 'Logboek zien',       hint: 'Foutmeldingen en gebeurtenissen uit de app.', sensitive: true },

  { key: 'chat.use',          group: 'Overleg',    label: 'Meedoen aan het overleg', hint: 'Kanalen lezen en berichten plaatsen.' },
  { key: 'chat.manage',       group: 'Overleg',    label: 'Kanalen beheren',      hint: 'Kanalen aanmaken, hernoemen en archiveren.' },
  { key: 'chat.moderate',     group: 'Overleg',    label: 'Berichten verwijderen', hint: 'Ook berichten van anderen weghalen.', sensitive: true },

  { key: 'signups.view',      group: 'Aanmeldingen', label: 'Aanmeldingen zien',  hint: 'Zien wie zich via de app heeft aangemeld.' },
  { key: 'signups.decide',    group: 'Aanmeldingen', label: 'Aanmelding afhandelen', hint: 'Iemand toelaten als medewerker of klant, of afwijzen.', sensitive: true },

  { key: 'mail.read',         group: 'Postbus',    label: 'Post lezen',           hint: 'Binnengekomen e-mail en wat er is verstuurd.', sensitive: true },
  { key: 'mail.send',         group: 'Postbus',    label: 'Post versturen',       hint: 'Zelf een mail opstellen naar een adres naar keuze.', sensitive: true },

  { key: 'pos.use',           group: 'Kassa',      label: 'Kassa gebruiken',      hint: 'Afrekenen aan de kassa en de bon afdrukken.' },
  { key: 'pos.discount',      group: 'Kassa',      label: 'Korting geven',        hint: 'Een regel of de hele bon afprijzen.' },
  { key: 'pos.refund',        group: 'Kassa',      label: 'Bon crediteren',       hint: 'Een afgerekende bon terugdraaien met een creditbon.', sensitive: true },
  { key: 'pos.cash',          group: 'Kassa',      label: 'Lade en dagafsluiting', hint: 'Kas openen, tellen, afstorten en de dag afsluiten.', sensitive: true },
  { key: 'pos.manage',        group: 'Kassa',      label: 'Kassa beheren',        hint: "Artikelen, prijzen, kaarten, codes en de printerinstellingen.", sensitive: true },

  { key: 'admin.settings',    group: 'Beheer',     label: 'Instellingen',         hint: 'Tarieven, openingstijden en app-instellingen.', sensitive: true },
  { key: 'admin.audit',       group: 'Beheer',     label: 'Logboek',              hint: 'Zien wie wat heeft gewijzigd.', sensitive: true },
]

/** Eén handeling uit het spoor van de laatste vijftien minuten. */
export interface TrailEntry {
  at: number
  kind: 'pagina' | 'actie' | 'fout' | 'sync' | 'melding'
  text: string
}
