/**
 * crm/store.ts — dane modułu CRM w pamięci procesu.
 *
 * Ta sama zasada co w store.ts magazynu: restart procesu przywraca stan
 * startowy, więc każda próba generalna zaczyna od tego samego układu.
 *
 * Daty follow-upów i ostatnich kontaktów liczone są WZGLĘDEM DNIA URUCHOMIENIA
 * (helper `dzien`). Inaczej po tygodniu od nagrania demo wszystkie terminy
 * byłyby przeterminowane i widok kalendarza przestałby cokolwiek pokazywać.
 */

import type {
  CrmActivity,
  CrmAttachment,
  CrmClient,
  CrmContact,
  CrmColumn,
  CrmEmployee,
  CrmFollowUp,
  CrmMessage,
  CrmRequest,
  InboxMessage,
  MailboxState,
  StageNote,
} from "@demo-erp/shared";

let seq = 0;
export const nextCrmId = (): string => `crm-${++seq}`;

let licznikZapytan = 0;
export function nextCrmNumber(): string {
  licznikZapytan += 1;
  return `ZAP-2026-${String(licznikZapytan).padStart(4, "0")}`;
}

/** Data przesunięta o `offset` dni względem dziś, w formacie YYYY-MM-DD. */
export const dzien = (offset: number): string =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** Znacznik czasu przesunięty o `offset` dni względem teraz. */
export const chwila = (offset: number, godzina = 9): string => {
  const d = new Date(Date.now() + offset * 86_400_000);
  d.setUTCHours(godzina, 15, 0, 0);
  return d.toISOString();
};

// ------------------------------ pracownicy --------------------------------

export const crmEmployees: CrmEmployee[] = [
  { id: "e-1", phone: "+48 95 741 20 31", name: "Magdalena Nowak", initials: "MN", email: "m.nowak@norderp.pl", role: "kierownik", active: true },
  { id: "e-2", phone: "+48 95 741 20 34", name: "Jakub Kowalski", initials: "JK", email: "j.kowalski@norderp.pl", role: "handlowiec", active: true },
  { id: "e-3", phone: "+48 95 741 20 35", name: "Ewa Lis", initials: "EL", email: "e.lis@norderp.pl", role: "handlowiec", active: true },
  { id: "e-4", phone: "+48 95 741 20 36", name: "Rafał Duda", initials: "RD", email: "r.duda@norderp.pl", role: "ofertowanie", active: true },
  { id: "e-5", phone: "+48 95 741 20 39", name: "Serwis IT", initials: "IT", email: "it@norderp.pl", role: "administrator", active: true },
];

// -------------------------- pomocniki danych demo --------------------------

const akt = (offset: number, kind: CrmActivity["kind"], text: string, user = "system"): CrmActivity => ({
  id: nextCrmId(),
  at: chwila(offset),
  kind,
  text,
  user,
});

const fu = (
    offset: number,
    time: string,
    type: CrmFollowUp["type"],
    note: string,
    status: CrmFollowUp["status"],
): CrmFollowUp => ({
  id: nextCrmId(),
  date: dzien(offset),
  time,
  type,
  note,
  status,
  doneAt: status === "done" ? chwila(offset) : null,
});

// ----------------------------- zapytania CRM -------------------------------

/**
 * Pola tablicy (budowa, klient, wycena, kolumna) dokładamy warstwą niżej —
 * patrz `DANE_TABLICY` pod spodem. Dzięki temu opis samego zapytania czyta się
 * dalej jak zapytanie, a nie jak rekord bazy z dwudziestoma kolumnami.
 */
type ZapytanieBazowe = Omit<
    CrmRequest,
    | "projectName"
    | "clientId"
    | "siteAddress"
    | "quoteValue"
    | "projectManagerId"
    | "columnId"
    | "columnEnteredAt"
    | "seenAt"
    | "stageNotes"
    | "notes"
    | "outsourcing"
    | "assigneeIds"
    | "attachments"
    | "messages"
> & {
  // Pola opisujące pochodzenie plików i autorstwo wiadomości dokładamy niżej
  // w `uzupelnij()` — w treści zapytań demo tylko by hałasowały.
  attachments: Omit<CrmAttachment, "source" | "at" | "fromName" | "messageId" | "messageSubject">[];
  messages: Omit<CrmMessage, "direction" | "authorName" | "contactId" | "sentFrom" | "templateKey">[];
};

const zapytaniaBazowe: ZapytanieBazowe[] = [
  {
    id: "r-1",
    number: nextCrmNumber(),
    companyName: "Stalmex Sp. z o.o.",
    contactName: "Anna Wiśniewska",
    email: "a.wisniewska@stalmex.pl",
    phone: "+48 601 224 118",
    address: "ul. Hutnicza 14, 40-241 Katowice",
    description:
        "Wykonanie konstrukcji wsporczych wg rysunku, materiał S235JR, ocynk ogniowy.",
    products: "konstrukcje wsporcze wg rysunku, ocynk ogniowy",
    quantity: "40 kpl.",
    deadline: dzien(44),
    source: "email",
    createdAt: chwila(-9),
    assigneeId: "e-2",
    stage: "offer_prep",
    score: 78,
    requiredAttachments: ["drawing", "specification"],
    attachments: [
      { id: nextCrmId(), name: "rysunek-wspornik-A3.pdf", kind: "drawing", sizeKb: 812 },
      { id: nextCrmId(), name: "specyfikacja-materialowa.xlsx", kind: "specification", sizeKb: 64 },
    ],
    lastContactAt: chwila(-3),
    lostReason: null,
    lostReasonNote: null,
    sourceMessageId: "m-1",
    followUps: [
      fu(-3, "10:00", "phone", "Potwierdzenie zakresu ocynku.", "done"),
      fu(2, "09:30", "email", "Wysłać wycenę wstępną.", "planned"),
    ],
    messages: [],
    activity: [
      akt(-9, "created", "Zapytanie utworzone automatycznie z wiadomości e-mail.", "system"),
      akt(-9, "mail_fetched", "Pobrano wiadomość „Zapytanie ofertowe — konstrukcja wsporcza, 40 kpl.”.", "system"),
      akt(-8, "assignee_changed", "Przypisano do: Jakub Kowalski.", "mnowak"),
      akt(-3, "stage_changed", "Etap zmieniony: Kontakt → Przygotowanie oferty.", "jkowalski"),
      akt(-3, "followup_done", "Wykonano follow-up: telefon.", "jkowalski"),
    ],
  },
  {
    id: "r-2",
    number: nextCrmNumber(),
    companyName: "PPHU Technoserwis",
    contactName: "Marek Zieliński",
    email: "m.zielinski@technoserwis.com.pl",
    phone: "12 345 67 89",
    address: null,
    description: "Wycena łożysk 6204-2RS oraz uszczelek gumowych 30x3.",
    products: "łożyska 6204-2RS, uszczelki gumowe 30x3",
    quantity: "200 szt. + 500 szt.",
    deadline: null,
    source: "email",
    createdAt: chwila(-7),
    assigneeId: "e-3",
    stage: "offer_sent",
    score: 64,
    requiredAttachments: [],
    attachments: [],
    lastContactAt: chwila(-2),
    lostReason: null,
    lostReasonNote: null,
    sourceMessageId: "m-2",
    followUps: [fu(-1, "12:00", "phone", "Dopytać o decyzję po ofercie.", "planned")],
    messages: [
      {
        id: nextCrmId(),
        kind: "assignment",
        to: "m.zielinski@technoserwis.com.pl",
        subject: "Państwa zapytanie ZAP-2026-0002 — opiekun sprawy",
        body: "Dzień dobry,\n\npotwierdzamy przyjęcie zapytania. Opiekunem sprawy jest Ewa Lis.\n\nPozdrawiamy,\nDział Handlowy",
        createdAt: chwila(-7),
        sentAt: chwila(-7),
      },
    ],
    activity: [
      akt(-7, "created", "Zapytanie utworzone automatycznie z wiadomości e-mail.", "system"),
      akt(-7, "assignee_changed", "Przypisano do: Ewa Lis.", "mnowak"),
      akt(-7, "message_sent", "Wysłano wiadomość: Informacja o opiekunie zapytania.", "system"),
      akt(-2, "stage_changed", "Etap zmieniony: Przygotowanie oferty → Oferta wysłana.", "elis"),
    ],
  },
  {
    id: "r-3",
    number: nextCrmNumber(),
    companyName: "Zakład Mechaniczny Nowak",
    contactName: "Katarzyna Nowak",
    email: "k.nowak@nowak-mechanika.pl",
    phone: "668 900 121",
    address: "ul. Przemysłowa 8, 44-100 Gliwice",
    description: "Blacha stalowa S235 gr. 2 mm, około 1,5 tony. Pytanie o cenę i dostępność.",
    products: "blacha stalowa S235 gr. 2 mm",
    quantity: "1,5 tony",
    deadline: dzien(3),
    source: "email",
    createdAt: chwila(-6),
    assigneeId: "e-2",
    stage: "negotiation",
    score: 82,
    requiredAttachments: ["specification"],
    attachments: [
      { id: nextCrmId(), name: "zestawienie-formatek.pdf", kind: "specification", sizeKb: 240 },
    ],
    lastContactAt: chwila(-1),
    lostReason: null,
    lostReasonNote: null,
    sourceMessageId: "m-3",
    followUps: [fu(1, "14:00", "meeting", "Spotkanie online — ustalenie rabatu ilościowego.", "planned")],
    messages: [],
    activity: [
      akt(-6, "created", "Zapytanie utworzone automatycznie z wiadomości e-mail.", "system"),
      akt(-5, "score_changed", "Scoring zmieniony: 70% → 82%.", "jkowalski"),
      akt(-1, "stage_changed", "Etap zmieniony: Oferta wysłana → Negocjacje.", "jkowalski"),
    ],
  },
  {
    id: "r-4",
    number: nextCrmNumber(),
    companyName: "Elektro-Hurt S.A.",
    contactName: "Tomasz Baran",
    email: "t.baran@elektro-hurt.pl",
    phone: "+48 22 512 44 90",
    address: "ul. Marynarska 22, 02-674 Warszawa",
    description: "Okablowanie hali produkcyjnej: kabel YDY 3x1,5 oraz osprzęt wg specyfikacji.",
    products: "kabel YDY 3x1,5 mm², osprzęt elektryczny",
    quantity: "2400 m",
    deadline: dzien(59),
    source: "manual",
    createdAt: chwila(-14),
    assigneeId: "e-4",
    stage: "won",
    score: 95,
    requiredAttachments: ["specification", "drawing"],
    attachments: [
      { id: nextCrmId(), name: "specyfikacja-osprzetu.pdf", kind: "specification", sizeKb: 430 },
      { id: nextCrmId(), name: "rzut-hali.dwg", kind: "drawing", sizeKb: 2140 },
    ],
    lastContactAt: chwila(-4),
    lostReason: null,
    lostReasonNote: null,
    sourceMessageId: null,
    followUps: [fu(-4, "11:00", "meeting", "Podpisanie umowy.", "done")],
    messages: [],
    activity: [
      akt(-14, "created", "Zapytanie utworzone ręcznie.", "mnowak"),
      akt(-12, "assignee_changed", "Przypisano do: Rafał Duda.", "mnowak"),
      akt(-4, "stage_changed", "Etap zmieniony: Negocjacje → Wygrane.", "rduda"),
    ],
  },
  {
    id: "r-5",
    number: nextCrmNumber(),
    companyName: "Metalpol Handel",
    contactName: "Grzegorz Sowa",
    email: "g.sowa@metalpol.pl",
    phone: "+48 48 362 11 40",
    address: "ul. Żeromskiego 12, 26-600 Radom",
    description: "Farba proszkowa RAL 9005 — zapytanie na dostawy kwartalne.",
    products: "farba proszkowa RAL 9005",
    quantity: "600 kg",
    deadline: dzien(-6),
    source: "manual",
    createdAt: chwila(-25),
    assigneeId: "e-3",
    stage: "lost",
    score: 30,
    requiredAttachments: [],
    attachments: [],
    lastContactAt: chwila(-8),
    lostReason: "price",
    lostReasonNote: null,
    sourceMessageId: null,
    followUps: [fu(-8, "15:00", "email", "Przypomnienie o ofercie.", "done")],
    messages: [],
    activity: [
      akt(-25, "created", "Zapytanie utworzone ręcznie.", "elis"),
      akt(-8, "stage_changed", "Etap zmieniony: Negocjacje → Przegrane.", "elis"),
      akt(-8, "lost_reason_changed", "Przyczyna przegranej: Za wysoka cena.", "elis"),
    ],
  },
  {
    id: "r-6",
    number: nextCrmNumber(),
    companyName: "PROMECH Sp. z o.o.",
    contactName: "Dział Zakupów",
    email: "zakupy@promech.eu",
    phone: null,
    address: "ul. Fabryczna 3, 26-600 Radom",
    description: "Obudowy blaszane malowane proszkowo RAL 9005.",
    products: "obudowy blaszane malowane proszkowo",
    quantity: "120 szt.",
    deadline: dzien(30),
    source: "manual",
    createdAt: chwila(-5),
    assigneeId: null,
    stage: "new",
    score: 55,
    requiredAttachments: ["drawing", "photos"],
    attachments: [
      { id: nextCrmId(), name: "obudowa-rys-wykonawczy.pdf", kind: "drawing", sizeKb: 1180 },
    ],
    lastContactAt: null,
    lostReason: null,
    lostReasonNote: null,
    sourceMessageId: null,
    followUps: [fu(-2, "09:00", "email", "Poprosić o zdjęcia referencyjne.", "planned")],
    messages: [],
    activity: [akt(-5, "created", "Zapytanie utworzone ręcznie.", "mnowak")],
  },
  {
    id: "r-7",
    number: nextCrmNumber(),
    companyName: "Adamczyk Piotr",
    contactName: "Piotr Adamczyk",
    email: "p.adamczyk84@gmail.com",
    phone: null,
    address: null,
    description: "Zapytanie o możliwość wykonania kilku elementów. Brak szczegółów.",
    products: null,
    quantity: null,
    deadline: null,
    source: "email",
    createdAt: chwila(-4),
    assigneeId: null,
    stage: "new",
    score: 20,
    requiredAttachments: ["specification"],
    attachments: [],
    lastContactAt: null,
    lostReason: null,
    lostReasonNote: null,
    sourceMessageId: "m-4",
    followUps: [],
    messages: [
      {
        id: nextCrmId(),
        kind: "missing_data",
        to: "p.adamczyk84@gmail.com",
        subject: "Uzupełnienie zapytania ZAP-2026-0007",
        body: "Dzień dobry,\n\ndziękujemy za zapytanie. Aby przygotować wycenę, prosimy o uzupełnienie:\n— specyfikacja produktu lub usługi\n— informacja o ilości\n— numer telefonu\n\nPozdrawiamy,\nDział Handlowy",
        createdAt: chwila(-3),
        sentAt: null,
      },
    ],
    activity: [
      akt(-4, "created", "Zapytanie utworzone automatycznie z wiadomości e-mail.", "system"),
      akt(-3, "message_generated", "Wygenerowano wiadomość: Prośba o uzupełnienie danych.", "mnowak"),
    ],
  },
  {
    id: "r-8",
    number: nextCrmNumber(),
    companyName: "Termika Instalacje Sp. z o.o.",
    contactName: "Beata Górska",
    email: "b.gorska@termika-instalacje.pl",
    phone: "+48 71 340 55 12",
    address: "ul. Krucza 5, 53-411 Wrocław",
    description: "Zestaw kołnierzy i uszczelnień do modernizacji węzła cieplnego.",
    products: "kołnierze DN80, uszczelnienia grafitowe",
    quantity: "60 kpl.",
    deadline: dzien(12),
    source: "manual",
    createdAt: chwila(-11),
    assigneeId: "e-2",
    stage: "contact",
    score: 58,
    requiredAttachments: ["specification"],
    attachments: [],
    lastContactAt: chwila(-9),
    lostReason: null,
    lostReasonNote: null,
    sourceMessageId: null,
    followUps: [fu(-5, "10:30", "phone", "Ponaglić o specyfikację węzła.", "planned")],
    messages: [],
    activity: [
      akt(-11, "created", "Zapytanie utworzone ręcznie.", "jkowalski"),
      akt(-9, "stage_changed", "Etap zmieniony: Nowe → Kontakt.", "jkowalski"),
    ],
  },
  {
    id: "r-9",
    number: nextCrmNumber(),
    companyName: "Agromech Serwis",
    contactName: "Wojciech Bąk",
    email: "w.bak@agromech-serwis.pl",
    phone: "515 220 907",
    address: "ul. Polna 41, 09-400 Płock",
    description: "Filtry powietrza D40 i olej hydrauliczny HL-46 — dostawa serwisowa.",
    products: "filtr powietrza D40, olej hydrauliczny HL-46",
    quantity: "80 szt. / 400 l",
    deadline: dzien(9),
    source: "manual",
    createdAt: chwila(-16),
    assigneeId: "e-3",
    stage: "offer_sent",
    score: 71,
    requiredAttachments: [],
    attachments: [{ id: nextCrmId(), name: "zapytanie-agromech.pdf", kind: "pdf", sizeKb: 155 }],
    lastContactAt: chwila(-6),
    lostReason: null,
    lostReasonNote: null,
    sourceMessageId: null,
    followUps: [fu(3, "08:30", "reoffer", "Ponowić ofertę z rabatem 3%.", "planned")],
    messages: [],
    activity: [
      akt(-16, "created", "Zapytanie utworzone ręcznie.", "elis"),
      akt(-6, "stage_changed", "Etap zmieniony: Przygotowanie oferty → Oferta wysłana.", "elis"),
    ],
  },
  {
    id: "r-10",
    number: nextCrmNumber(),
    companyName: "Budomax Konstrukcje",
    contactName: "Łukasz Pawlak",
    email: "l.pawlak@budomax.pl",
    phone: "+48 32 700 18 22",
    address: "ul. Chorzowska 108, 40-101 Katowice",
    description: "Barierki ochronne i podesty technologiczne — zapytanie przetargowe.",
    products: "barierki ochronne, podesty technologiczne",
    quantity: "180 mb",
    deadline: dzien(-15),
    source: "manual",
    createdAt: chwila(-38),
    assigneeId: "e-4",
    stage: "lost",
    score: 45,
    requiredAttachments: ["drawing"],
    attachments: [{ id: nextCrmId(), name: "przetarg-rys-zbiorczy.pdf", kind: "drawing", sizeKb: 990 }],
    lastContactAt: chwila(-18),
    lostReason: "competitor",
    lostReasonNote: null,
    sourceMessageId: null,
    followUps: [],
    messages: [],
    activity: [
      akt(-38, "created", "Zapytanie utworzone ręcznie.", "rduda"),
      akt(-18, "stage_changed", "Etap zmieniony: Negocjacje → Przegrane.", "rduda"),
      akt(-18, "lost_reason_changed", "Przyczyna przegranej: Wybrano konkurencję.", "rduda"),
    ],
  },
  {
    id: "r-11",
    number: nextCrmNumber(),
    companyName: "Polkom Automatyka",
    contactName: "Sylwia Rak",
    email: "s.rak@polkom-automatyka.pl",
    phone: null,
    address: null,
    description: "Szafy sterownicze — zapytanie wstępne, brak dokumentacji.",
    products: null,
    quantity: null,
    deadline: null,
    source: "manual",
    createdAt: chwila(-21),
    assigneeId: "e-2",
    stage: "lost",
    score: 15,
    requiredAttachments: ["specification", "drawing"],
    attachments: [],
    lastContactAt: chwila(-19),
    lostReason: "incomplete_data",
    lostReasonNote: null,
    sourceMessageId: null,
    followUps: [],
    messages: [],
    activity: [
      akt(-21, "created", "Zapytanie utworzone ręcznie.", "jkowalski"),
      akt(-19, "lost_reason_changed", "Przyczyna przegranej: Niekompletne dane.", "jkowalski"),
    ],
  },
  {
    id: "r-12",
    number: nextCrmNumber(),
    companyName: "Vetro Systemy Sp. z o.o.",
    contactName: "Michał Cichoń",
    email: "m.cichon@vetro-systemy.pl",
    phone: "+48 61 855 22 30",
    address: "ul. Dąbrowskiego 77, 60-529 Poznań",
    description:
        "Dostawa kompletów złącznych M8 do montażu fasad. Zapytanie na kontrakt roczny.",
    products: "śruby M8 x 100 DIN 933, nakrętki M8 DIN 934",
    quantity: "50 000 szt.",
    deadline: dzien(70),
    source: "manual",
    createdAt: chwila(-2),
    assigneeId: null,
    stage: "new",
    score: 68,
    requiredAttachments: ["form"],
    attachments: [{ id: nextCrmId(), name: "formularz-zapytania.docx", kind: "form", sizeKb: 58 }],
    lastContactAt: null,
    lostReason: null,
    lostReasonNote: null,
    sourceMessageId: null,
    followUps: [fu(0, "16:00", "email", "Wysłać potwierdzenie przyjęcia zapytania.", "planned")],
    messages: [],
    activity: [akt(-2, "created", "Zapytanie utworzone ręcznie.", "mnowak")],
  },
];

// ------------------------------ kartoteka klientów -------------------------

/**
 * Klienci są osobnym bytem, bo ten sam klient przysyła wiele zapytań.
 * Z poziomu zapytania widać ich dane, ale się ich nie edytuje — poprawka
 * literówki w jednej sprawie nie może po cichu zmieniać danych w pozostałych.
 */
/** Klienci demo — kontakt główny plus, u części firm, kontakty dodatkowe. */
const klienciBazowi: Omit<CrmClient, "contacts">[] = [
  { id: "k-1", name: "Stalmex Sp. z o.o.", contactName: "Anna Wiśniewska", email: "a.wisniewska@stalmex.pl", phone: "+48 601 224 118", address: "ul. Hutnicza 14, 40-241 Katowice", nip: "634-101-22-88" },
  { id: "k-2", name: "PPHU Technoserwis", contactName: "Marek Zieliński", email: "m.zielinski@technoserwis.com.pl", phone: "12 345 67 89", address: "ul. Wielicka 60, 30-552 Kraków", nip: "679-220-44-10" },
  { id: "k-3", name: "Zakład Mechaniczny Nowak", contactName: "Katarzyna Nowak", email: "k.nowak@nowak-mechanika.pl", phone: "668 900 121", address: "ul. Przemysłowa 8, 44-100 Gliwice", nip: "631-155-90-04" },
  { id: "k-4", name: "Elektro-Hurt S.A.", contactName: "Tomasz Baran", email: "t.baran@elektro-hurt.pl", phone: "+48 22 512 44 90", address: "ul. Marynarska 22, 02-674 Warszawa", nip: "521-330-11-77" },
  { id: "k-5", name: "Metalpol Handel", contactName: "Grzegorz Sowa", email: "g.sowa@metalpol.pl", phone: "+48 48 362 11 40", address: "ul. Żeromskiego 12, 26-600 Radom", nip: "796-201-55-31" },
  { id: "k-6", name: "PROMECH Sp. z o.o.", contactName: "Dział Zakupów", email: "zakupy@promech.eu", phone: null, address: "ul. Fabryczna 3, 26-600 Radom", nip: "796-118-70-22" },
  { id: "k-7", name: "Adamczyk Piotr", contactName: "Piotr Adamczyk", email: "p.adamczyk84@gmail.com", phone: null, address: null, nip: null },
  { id: "k-8", name: "Termika Instalacje Sp. z o.o.", contactName: "Beata Górska", email: "b.gorska@termika-instalacje.pl", phone: "+48 71 340 55 12", address: "ul. Krucza 5, 53-411 Wrocław", nip: "897-140-62-09" },
  { id: "k-9", name: "Agromech Serwis", contactName: "Wojciech Bąk", email: "w.bak@agromech-serwis.pl", phone: "515 220 907", address: "ul. Polna 41, 09-400 Płock", nip: "774-208-33-15" },
  { id: "k-10", name: "Budomax Konstrukcje", contactName: "Łukasz Pawlak", email: "l.pawlak@budomax.pl", phone: "+48 32 700 18 22", address: "ul. Chorzowska 108, 40-101 Katowice", nip: "634-277-04-61" },
  { id: "k-11", name: "Polkom Automatyka", contactName: "Sylwia Rak", email: "s.rak@polkom-automatyka.pl", phone: null, address: null, nip: "782-190-88-40" },
  { id: "k-12", name: "Vetro Systemy Sp. z o.o.", contactName: "Michał Cichoń", email: "m.cichon@vetro-systemy.pl", phone: "+48 61 855 22 30", address: "ul. Dąbrowskiego 77, 60-529 Poznań", nip: "781-166-25-93" },
];

/**
 * Kontakty dodatkowe. Po stronie klienta rzadko rozmawia się z jedną osobą:
 * zakupy przysyłają zapytanie, technolog dosyła rysunki, a o cenę pyta ktoś
 * trzeci — i to widać potem w historii korespondencji.
 */
const KONTAKTY_DODATKOWE: Record<string, CrmContact[]> = {
  "k-1": [
    { id: "kt-1a", name: "Rafał Sikora", email: "r.sikora@stalmex.pl", phone: "+48 601 900 442", role: "Technolog" },
    { id: "kt-1b", name: "Ewa Duda", email: "e.duda@stalmex.pl", phone: null, role: "Księgowość" },
  ],
  "k-3": [
    { id: "kt-3a", name: "Marcin Nowak", email: "m.nowak@nowak-mechanika.pl", phone: "668 900 122", role: "Kierownik budowy" },
  ],
  "k-4": [
    { id: "kt-4a", name: "Iwona Krzemień", email: "i.krzemien@elektro-hurt.pl", phone: "+48 22 512 44 91", role: "Zakupy" },
  ],
  "k-8": [
    { id: "kt-8a", name: "Paweł Ozga", email: "p.ozga@termika-instalacje.pl", phone: null, role: "Projektant" },
  ],
};

export const crmClients: CrmClient[] = klienciBazowi.map((k) => ({
  ...k,
  contacts: [
    { id: `${k.id}-c1`, name: k.contactName, email: k.email, phone: k.phone, role: "Kontakt główny" },
    ...(KONTAKTY_DODATKOWE[k.id] ?? []),
  ],
}));

let licznikKlientow = crmClients.length;
export const nextClientId = (): string => `k-${++licznikKlientow}`;

// ------------------------------ kolumny tablicy ----------------------------

/**
 * Układ startowy: wpływ, kosztorysanci, weryfikacja i archiwum przegranych.
 * Kolumny kosztorysantów mają `employeeId` — upuszczenie karty na taką kolumnę
 * jest przypisaniem sprawy, więc tablica nie ma osobnego pola „opiekun”.
 */
export const crmColumns: CrmColumn[] = [
  { id: "col-new", title: "Nowe", kind: "new", color: "blue", employeeId: null, order: 0, removable: false },
  { id: "col-e2", title: "Jakub Kowalski", kind: "estimator", color: "default", employeeId: "e-2", order: 1, removable: true },
  { id: "col-e3", title: "Ewa Lis", kind: "estimator", color: "default", employeeId: "e-3", order: 2, removable: true },
  { id: "col-e4", title: "Rafał Duda", kind: "estimator", color: "default", employeeId: "e-4", order: 3, removable: true },
  { id: "col-hold", title: "Wstrzymane", kind: "custom", color: "orange", employeeId: null, order: 4, removable: true },
  { id: "col-sent", title: "Wysłane", kind: "sent", color: "gold", employeeId: null, order: 5, removable: false },
  { id: "col-followup", title: "Follow-up", kind: "followup", color: "purple", employeeId: null, order: 6, removable: false },
  { id: "col-won", title: "Wygrane", kind: "won", color: "green", employeeId: null, order: 7, removable: false },
  { id: "col-lost", title: "Przegrane", kind: "lost", color: "red", employeeId: null, order: 8, removable: false },
];

let licznikKolumn = 0;
export const nextColumnId = (): string => `col-x${++licznikKolumn}`;

// ------------------------- dane tablicy dla zapytań demo -------------------

type DaneTablicy = Pick<
    CrmRequest,
    | "projectName"
    | "clientId"
    | "siteAddress"
    | "quoteValue"
    | "projectManagerId"
    | "columnId"
    | "columnEnteredAt"
    | "seenAt"
    | "stageNotes"
    | "notes"
>;

const notatka = (stage: CrmRequest["stage"], text: string, user: string): StageNote => ({
  stage,
  text,
  at: chwila(-2),
  user,
});

const DANE_TABLICY: Record<string, DaneTablicy> = {
  "r-1": {
    projectName: "Hala P4 — Gliwice",
    clientId: "k-1",
    siteAddress: "ul. Bojkowska 92, 44-100 Gliwice",
    quoteValue: 125_999.99,
    projectManagerId: "e-1",
    columnId: "col-e2",
    columnEnteredAt: chwila(-2),
    seenAt: chwila(-8),
    stageNotes: [notatka("offer_prep", "Ocynk liczony u podwykonawcy — czekam na cenę do czwartku.", "jkowalski")],
    notes: "Klient stały, płatność zawsze w terminie.",
  },
  "r-2": {
    projectName: "Linia montażowa L2",
    clientId: "k-2",
    siteAddress: "ul. Wielicka 60, 30-552 Kraków",
    quoteValue: 89_500,
    projectManagerId: "e-1",
    columnId: "col-sent",
    // Dziewięć dni bez reakcji — przy pierwszym otwarciu tablicy automat
    // przeniesie tę kartę do „Follow-up” i wyśle przypomnienie.
    columnEnteredAt: chwila(-9),
    seenAt: chwila(-7),
    stageNotes: [notatka("offer_sent", "Oferta wysłana bez rysunku łożyskowania — do uzupełnienia.", "elis")],
    notes: "",
  },
  "r-3": {
    projectName: "Osiedle Wiślane B3",
    clientId: "k-3",
    siteAddress: "ul. Rybnicka 210, 44-100 Gliwice",
    quoteValue: 215_300,
    projectManagerId: "e-1",
    columnId: "col-e2",
    columnEnteredAt: chwila(-2),
    seenAt: chwila(-6),
    stageNotes: [notatka("negotiation", "Klient prosi o rabat 4% przy płatności z góry.", "jkowalski")],
    notes: "Negocjacje prowadzi bezpośrednio właściciel.",
  },
  "r-4": {
    projectName: "Terminal C — Warszawa",
    clientId: "k-4",
    siteAddress: "ul. Żwirki i Wigury 1, 00-906 Warszawa",
    quoteValue: 306_000,
    projectManagerId: "e-1",
    columnId: "col-won",
    columnEnteredAt: chwila(-2),
    seenAt: chwila(-14),
    stageNotes: [notatka("won", "Zamówienie potwierdzone mailem, umowa w podpisie.", "rduda")],
    notes: "",
  },
  "r-5": {
    projectName: "Magazyn Radom II",
    clientId: "k-5",
    siteAddress: "ul. Żeromskiego 12, 26-600 Radom",
    quoteValue: 72_500,
    projectManagerId: "e-1",
    columnId: "col-lost",
    columnEnteredAt: chwila(-2),
    seenAt: chwila(-25),
    stageNotes: [notatka("lost", "Konkurencja zeszła o 9% poniżej naszej ceny materiału.", "elis")],
    notes: "",
  },
  "r-6": {
    projectName: "Obudowy RAL 9005",
    clientId: "k-6",
    siteAddress: null,
    quoteValue: null,
    projectManagerId: null,
    columnId: "col-new",
    columnEnteredAt: chwila(-2),
    seenAt: null,
    stageNotes: [],
    notes: "",
  },
  "r-7": {
    projectName: "Zapytanie bez opisu",
    clientId: "k-7",
    siteAddress: null,
    quoteValue: null,
    projectManagerId: null,
    columnId: "col-new",
    columnEnteredAt: chwila(-2),
    seenAt: null,
    stageNotes: [],
    notes: "Wiadomość jednozdaniowa, wymaga kontaktu telefonicznego.",
  },
  "r-8": {
    projectName: "Węzeł cieplny Krucza",
    clientId: "k-8",
    siteAddress: "ul. Krucza 5, 53-411 Wrocław",
    quoteValue: 41_800,
    projectManagerId: "e-1",
    columnId: "col-e2",
    columnEnteredAt: chwila(-2),
    seenAt: chwila(-11),
    stageNotes: [notatka("contact", "Umówiona wizyta na budowie w przyszłym tygodniu.", "jkowalski")],
    notes: "",
  },
  "r-9": {
    projectName: "Suszarnia Płock",
    clientId: "k-9",
    siteAddress: "ul. Polna 41, 09-400 Płock",
    quoteValue: 158_400,
    projectManagerId: "e-1",
    columnId: "col-sent",
    columnEnteredAt: chwila(-3),
    seenAt: chwila(-16),
    stageNotes: [notatka("offer_sent", "Klient prosił o wariant z podajnikiem — policzone osobno.", "elis")],
    notes: "",
  },
  "r-10": {
    projectName: "Chorzowska Business Park",
    clientId: "k-10",
    siteAddress: "ul. Chorzowska 108, 40-101 Katowice",
    quoteValue: 264_000,
    projectManagerId: "e-1",
    columnId: "col-lost",
    columnEnteredAt: chwila(-2),
    seenAt: chwila(-38),
    stageNotes: [notatka("lost", "Inwestor wstrzymał etap konstrukcyjny na czas nieokreślony.", "rduda")],
    notes: "",
  },
  "r-11": {
    projectName: "Automatyka Polkom",
    clientId: "k-11",
    siteAddress: null,
    quoteValue: null,
    projectManagerId: null,
    columnId: "col-lost",
    columnEnteredAt: chwila(-2),
    seenAt: chwila(-21),
    stageNotes: [notatka("lost", "Trzy próby kontaktu bez odpowiedzi.", "jkowalski")],
    notes: "",
  },
  "r-12": {
    projectName: "Fasada Vetro — Poznań",
    clientId: "k-12",
    siteAddress: "ul. Dąbrowskiego 77, 60-529 Poznań",
    quoteValue: null,
    projectManagerId: null,
    columnId: "col-new",
    columnEnteredAt: chwila(-2),
    seenAt: null,
    stageNotes: [],
    notes: "",
  },
};

/**
 * Domyślne uzupełnienie zapytań demo: pliki z pierwotnej wiadomości oznaczamy
 * jako otrzymane od klienta, a wiadomości bez wskazanego autora jako wysłane
 * przez dział handlowy. Dodatki (oferty, odpowiedzi klienta) dokładane są
 * niżej, w `DODATKI`.
 */
export const crmRequests: CrmRequest[] = zapytaniaBazowe.map((r) => {
  const dane = DANE_TABLICY[r.id];
  if (!dane) throw new Error(`Brak danych tablicy dla zapytania ${r.id}`);
  // Wątek zaczyna się od wiadomości klienta — także w danych demo, inaczej
  // korespondencja wyglądałaby, jakby zapytanie wzięło się znikąd, a
  // załączniki nie miałyby przy czym wisieć.
  const idPierwotnej = `${r.id}-in0`;
  const tematPierwotnej = `Zapytanie ofertowe — ${r.products ?? r.description.slice(0, 40)}`;
  const pierwotna: CrmMessage = {
    id: idPierwotnej,
    kind: "incoming",
    direction: "in",
    authorName: r.contactName,
    contactId: null,
    to: "Dział Handlowy",
    subject: tematPierwotnej,
    body: `Dzień dobry,\n\n${r.description}\n\n${r.quantity ? `Ilość: ${r.quantity}\n` : ""}${
        r.deadline ? `Termin: ${r.deadline}\n` : ""
    }\nPozdrawiam,\n${r.contactName}\n${r.companyName}`,
    createdAt: r.createdAt,
    sentAt: r.createdAt,
    sentFrom: null,
    templateKey: null,
  };

  const attachments: CrmAttachment[] = r.attachments.map((a) => ({
    ...a,
    source: "client",
    at: r.createdAt,
    fromName: r.contactName,
    messageId: idPierwotnej,
    messageSubject: tematPierwotnej,
  }));
  const messages: CrmMessage[] = [
    pierwotna,
    ...r.messages.map((m) => ({
      ...m,
      direction: "out" as const,
      authorName: "Dział Handlowy",
      contactId: null,
      sentFrom: "oferty@norderp.pl",
      templateKey: null,
    })),
  ];
  return {
    ...r,
    ...dane,
    outsourcing: [],
    attachments,
    messages,
    assigneeIds: r.assigneeId ? [r.assigneeId] : [],
    columnEnteredAt: dane.columnEnteredAt,
  };
});

// ---------------------------- skrzynka wiadomości --------------------------

/**
 * Wiadomości historyczne — te, które „przyszły” zanim uruchomiono demo.
 * Nowe dokłada adapter przy każdym pobraniu.
 */
const wiadomosciBazowe: (Omit<InboxMessage, "attachments"> & {
  attachments: Omit<CrmAttachment, "source" | "at" | "fromName" | "messageId" | "messageSubject">[];
})[] = [
  {
    id: "m-1",
    externalId: "<2026080901@stalmex.pl>",
    from: "Anna Wiśniewska",
    fromEmail: "a.wisniewska@stalmex.pl",
    subject: "Zapytanie ofertowe — konstrukcja wsporcza, 40 kpl.",
    receivedAt: chwila(-9, 7),
    body:
        "Dzień dobry,\n\nzwracamy się z zapytaniem ofertowym na wykonanie konstrukcji wsporczych\nwg załączonego rysunku. Ilość: 40 kpl. Materiał S235JR, ocynk ogniowy.\n\nTermin realizacji: do " +
        dzien(44) +
        ".\n\nStalmex Sp. z o.o.\nul. Hutnicza 14, 40-241 Katowice\nTel: +48 601 224 118\n\nAnna Wiśniewska",
    attachments: [
      { id: nextCrmId(), name: "rysunek-wspornik-A3.pdf", kind: "drawing", sizeKb: 812 },
      { id: nextCrmId(), name: "specyfikacja-materialowa.xlsx", kind: "specification", sizeKb: 64 },
    ],
    status: "processed",
    category: "inquiry",
    categoryManual: false,
    extracted: {
      companyName: "Stalmex Sp. z o.o.",
      contactName: "Anna Wiśniewska",
      email: "a.wisniewska@stalmex.pl",
      phone: "+48 601 224 118",
      address: "ul. Hutnicza 14, 40-241 Katowice",
      description: "Wykonanie konstrukcji wsporczych wg rysunku, materiał S235JR, ocynk ogniowy.",
      products: "konstrukcje wsporcze wg rysunku",
      quantity: "40 kpl.",
      deadline: dzien(44),
      attachments: ["rysunek-wspornik-A3.pdf", "specyfikacja-materialowa.xlsx"],
    },
    crmRequestId: "r-1",
    duplicateOfId: null,
    note: null,
    fetchedAt: chwila(-9, 7),
  },
  {
    id: "m-2",
    externalId: "<2026081001@technoserwis.com.pl>",
    from: "Marek Zieliński",
    fromEmail: "m.zielinski@technoserwis.com.pl",
    subject: "Prośba o wycenę — łożyska i uszczelnienia",
    receivedAt: chwila(-7, 8),
    body:
        "Dzień dobry,\n\nproszę o wycenę łożysk 6204-2RS oraz uszczelek gumowych 30x3.\nIlość: 200 szt. łożysk i 500 szt. uszczelek.\n\nPPHU Technoserwis\ntel. 12 345 67 89\n\nMarek Zieliński",
    attachments: [],
    status: "processed",
    category: "inquiry",
    categoryManual: false,
    extracted: {
      companyName: "PPHU Technoserwis",
      contactName: "Marek Zieliński",
      email: "m.zielinski@technoserwis.com.pl",
      phone: "12 345 67 89",
      address: null,
      description: "Wycena łożysk 6204-2RS oraz uszczelek gumowych 30x3.",
      products: "łożyska 6204-2RS, uszczelki gumowe 30x3",
      quantity: "200 szt.",
      deadline: null,
      attachments: [],
    },
    crmRequestId: "r-2",
    duplicateOfId: null,
    note: null,
    fetchedAt: chwila(-7, 8),
  },
  {
    id: "m-3",
    externalId: "<2026081002@nowak-mechanika.pl>",
    from: "Katarzyna Nowak",
    fromEmail: "k.nowak@nowak-mechanika.pl",
    subject: "Zapytanie o cenę blachy S235 2mm",
    receivedAt: chwila(-6, 10),
    body:
        "Witam,\n\ninteresuje mnie blacha stalowa S235 gr. 2 mm, około 1,5 tony.\nProszę o informację o cenie i dostępności.\n\nZakład Mechaniczny Nowak\nul. Przemysłowa 8, 44-100 Gliwice\nkom. 668 900 121",
    attachments: [
      { id: nextCrmId(), name: "zestawienie-formatek.pdf", kind: "specification", sizeKb: 240 },
    ],
    status: "processed",
    category: "inquiry",
    categoryManual: false,
    extracted: {
      companyName: "Zakład Mechaniczny Nowak",
      contactName: "Katarzyna Nowak",
      email: "k.nowak@nowak-mechanika.pl",
      phone: "668 900 121",
      address: "ul. Przemysłowa 8, 44-100 Gliwice",
      description: "Blacha stalowa S235 gr. 2 mm, około 1,5 tony.",
      products: "blacha stalowa S235 gr. 2 mm",
      quantity: "1,5 tony",
      deadline: null,
      attachments: ["zestawienie-formatek.pdf"],
    },
    crmRequestId: "r-3",
    duplicateOfId: null,
    note: null,
    fetchedAt: chwila(-6, 10),
  },
  {
    id: "m-4",
    externalId: "<2026081101@gmail.com>",
    from: "Piotr Adamczyk",
    fromEmail: "p.adamczyk84@gmail.com",
    subject: "zapytanie",
    receivedAt: chwila(-4, 14),
    body: "Dzień dobry, chciałbym zapytać o możliwość wykonania kilku elementów.\nProszę o kontakt.",
    attachments: [],
    status: "needs_review",
    category: "inquiry",
    categoryManual: false,
    extracted: {
      companyName: null,
      contactName: "Piotr Adamczyk",
      email: "p.adamczyk84@gmail.com",
      phone: null,
      address: null,
      description: "chciałbym zapytać o możliwość wykonania kilku elementów.",
      products: null,
      quantity: null,
      deadline: null,
      attachments: [],
    },
    crmRequestId: "r-7",
    duplicateOfId: null,
    note: "Nie rozpoznano nazwy firmy ani specyfikacji — zapytanie utworzone, wymaga weryfikacji.",
    fetchedAt: chwila(-4, 14),
  },
  {
    id: "m-5",
    externalId: "<2026081102@hurtstal.pl>",
    from: "HurtStal Newsletter",
    fromEmail: "newsletter@hurtstal.pl",
    subject: "Newsletter lipcowy — nowości w ofercie",
    receivedAt: chwila(-4, 6),
    body: "Zapraszamy do zapoznania się z nowościami w naszej ofercie.\n\nAby zrezygnować z subskrypcji, kliknij tutaj.",
    attachments: [],
    status: "skipped",
    category: "other",
    categoryManual: false,
    extracted: null,
    crmRequestId: null,
    duplicateOfId: null,
    note: "Zaklasyfikowano jako korespondencję marketingową.",
    fetchedAt: chwila(-4, 6),
  },
];

/** Identyfikatory ze skrzynki, które już widzieliśmy — klucz deduplikacji. */
/** Pliki z wiadomości są z definicji plikami od klienta. */
export const inboxMessages: InboxMessage[] = wiadomosciBazowe.map((m) => ({
  ...m,
  attachments: m.attachments.map((a) => ({
    ...a,
    source: "client" as const,
    at: m.receivedAt,
    fromName: m.from,
    messageId: m.externalId,
    messageSubject: m.subject,
  })),
}));

/**
 * Dodatki do danych demo: wysłane oferty (nasze pliki) i odpowiedzi klientów.
 * Trzymane osobno, bo pokazują ruch W OBIE strony — bez nich zakładka
 * „Wiadomości” i panel „Załączniki” wyglądałyby na jednostronne.
 */
const DODATKI: Record<
    string,
    { attachments?: CrmAttachment[]; messages?: CrmMessage[] }
> = {
  "r-2": {
    attachments: [
      {
        id: "za-2a",
        name: "oferta-ZAP-2026-0002-v2.pdf",
        kind: "pdf",
        sizeKb: 486,
        source: "own",
        at: chwila(-9, 11),
        fromName: "Ewa Lis",
        messageId: "m-2a",
        messageSubject: "Oferta ZAP-2026-0002 — linia montażowa L2",
      },
    ],
    messages: [
      {
        id: "m-2a",
        kind: "custom",
        direction: "out",
        authorName: "Ewa Lis",
        contactId: "k-2-c1",
        to: "m.zielinski@technoserwis.com.pl",
        subject: "Oferta ZAP-2026-0002 — linia montażowa L2",
        body: "Dzień dobry,\n\nw załączeniu oferta na linię montażową L2 wraz z harmonogramem.\nOferta ważna 30 dni.\n\nPozdrawiam,\nEwa Lis",
        createdAt: chwila(-9, 11),
        sentAt: chwila(-9, 11),
        sentFrom: "oferty@norderp.pl",
        templateKey: null,
      },
      {
        id: "m-2b",
        kind: "incoming",
        direction: "in",
        authorName: "Rafał Sikora",
        contactId: null,
        to: "Ewa Lis",
        subject: "Re: Oferta ZAP-2026-0002 — pytanie techniczne",
        body: "Dzień dobry,\n\nczy pozycja 4 obejmuje montaż na miejscu, czy tylko dostawę?\nPytam z ramienia działu technicznego.\n\nRafał Sikora",
        createdAt: chwila(-8, 9),
        sentAt: chwila(-8, 9),
        sentFrom: "oferty@norderp.pl",
        templateKey: null,
      },
    ],
  },
  "r-1": {
    attachments: [
      {
        id: "za-1a",
        name: "wstepna-kalkulacja.xlsx",
        kind: "specification",
        sizeKb: 118,
        source: "own",
        at: chwila(-4, 15),
        fromName: "Jakub Kowalski",
        messageId: null,
        messageSubject: null,
      },
    ],
    messages: [
      {
        id: "m-1a",
        kind: "incoming",
        direction: "in",
        authorName: "Ewa Duda",
        contactId: null,
        to: "Jakub Kowalski",
        subject: "Re: ZAP-2026-0001 — dane do faktury",
        body: "Dzień dobry,\n\nprzesyłam dane do faktury; fakturę proszę kierować na adres księgowości.\n\nEwa Duda",
        createdAt: chwila(-3, 10),
        sentAt: chwila(-3, 10),
        sentFrom: "oferty@norderp.pl",
        templateKey: null,
      },
    ],
  },
  "r-9": {
    attachments: [
      {
        id: "za-9a",
        name: "oferta-ZAP-2026-0009.pdf",
        kind: "pdf",
        sizeKb: 512,
        source: "own",
        at: chwila(-3, 12),
        fromName: "Ewa Lis",
        messageId: null,
        messageSubject: "Oferta ZAP-2026-0009 — suszarnia Płock",
      },
    ],
  },
};

for (const [id, d] of Object.entries(DODATKI)) {
  const r = crmRequests.find((x) => x.id === id);
  if (!r) continue;
  if (d.attachments) r.attachments.push(...d.attachments);
  if (d.messages) r.messages.push(...d.messages);
}

export const znanePobrania = new Set<string>(inboxMessages.map((m) => m.externalId));

export const mailboxState: MailboxState = {
  lastCheckedAt: null,
  lastResult: null,
  lastError: null,
  newCount: 0,
  totalFetched: inboxMessages.length,
  pollIntervalSec: 30,
};