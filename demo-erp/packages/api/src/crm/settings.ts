/**
 * crm/settings.ts — ustawienia automatyzacji modułu CRM.
 *
 * Jedno miejsce na to, co w każdej firmie wygląda inaczej: treść wiadomości
 * wychodzących, czas oczekiwania przed follow-upem, deklarowany czas
 * odpowiedzi i to, które problemy mają w ogóle świecić na kafelkach.
 *
 * Reguły wykrywania problemów są przełączalne świadomie: jeśli w danej firmie
 * rysunek dosyła się zawsze później, ostrzeżenie o braku pliku uczy ludzi
 * ignorowania ostrzeżeń — a wtedy przestają działać także te ważne.
 *
 * Szablony trzymamy jako tekst ze znacznikami `{{token}}` (lista w
 * `shared/src/crm.ts`), a nie jako kod: dzięki temu treść zmienia handlowiec,
 * nie programista.
 */

import type { CrmSettings } from "@demo-erp/shared";

const STOPKA = [
    "Pozdrawiam,",
    "{{firma.nazwa}}",
    "{{firma.email}} · {{firma.telefon}}",
].join("\n");

export const crmSettings: CrmSettings = {
    mailbox: {
        provider: "outlook",
        account: "oferty@norderp.pl",
        displayName: "Dział Handlowy NordERP",
    },
    company: {
        name: "NordERP Sp. z o.o.",
        email: "oferty@norderp.pl",
        phone: "+48 95 741 20 30",
        address: "ul. Zakaszewskiego 7, 66-300 Międzyrzecz",
    },
    automation: {
        acknowledgeNewRequests: true,
        followUpAfterDays: 7,
        autoSendFollowUp: true,
        autoCloseOnRefusal: true,
        responseDays: 3,
    },
    issues: {
        deadline: true,
        address: true,
        attachments: true,
        data: true,
        assignee: true,
        value: true,
        followup: true,
    },
    templates: [
        {
            key: "acknowledgement",
            enabled: true,
            subject: "Potwierdzenie przyjęcia zapytania {{sprawa.numer}}",
            body: [
                "Dzień dobry, {{klient.osoba}},",
                "",
                "dziękujemy za przesłanie zapytania ofertowego. Sprawa została zarejestrowana",
                "pod numerem {{sprawa.numer}} ({{sprawa.budowa}}).",
                "",
                "Co dalej:",
                "· zapytanie trafia do wyceny — wstępną odpowiedź przekazujemy zwykle w ciągu {{sprawa.dni}} dni roboczych,",
                "· gdy do wyceny zabraknie danych lub rysunków, odezwiemy się z konkretną prośbą,",
                "· po przydzieleniu kosztorysanta wyślemy jego imię, nazwisko i bezpośredni kontakt.",
                "",
                "Pytania prosimy kierować na {{firma.email}} lub {{firma.telefon}},",
                "powołując się na numer {{sprawa.numer}}.",
                "",
                STOPKA,
            ].join("\n"),
        },
        {
            key: "assignment",
            enabled: true,
            subject: "Zapytanie {{sprawa.numer}} — opiekun sprawy",
            body: [
                "Dzień dobry, {{klient.osoba}},",
                "",
                "potwierdzamy przyjęcie zapytania {{sprawa.numer}} ({{sprawa.budowa}}).",
                "Sprawę prowadzi {{kosztorysant.imie}} — proszę kierować pytania bezpośrednio do niego:",
                "{{kosztorysant.email}}, tel. {{kosztorysant.telefon}}.",
                "",
                "Odezwiemy się z wyceną albo z prośbą o brakujące dane.",
                "",
                STOPKA,
            ].join("\n"),
        },
        {
            key: "missing_data",
            enabled: true,
            subject: "Zapytanie {{sprawa.numer}} — prośba o uzupełnienie danych",
            body: [
                "Dzień dobry, {{klient.osoba}},",
                "",
                "dziękujemy za zapytanie {{sprawa.numer}} ({{sprawa.budowa}}).",
                "Aby przygotować rzetelną wycenę, prosimy o uzupełnienie:",
                "",
                "{{braki.lista}}",
                "{{braki.zalaczniki}}",
                "",
                "Po otrzymaniu kompletu wrócimy z ofertą.",
                "",
                STOPKA,
            ].join("\n"),
        },
        {
            key: "address",
            enabled: true,
            subject: "Zapytanie {{sprawa.numer}} — adres miejsca dostawy",
            body: [
                "Dzień dobry, {{klient.osoba}},",
                "",
                "przygotowujemy wycenę zapytania {{sprawa.numer}} ({{sprawa.budowa}}).",
                "Do policzenia transportu i ewentualnego montażu potrzebujemy adresu budowy",
                "(ulica, numer, kod pocztowy, miejscowość).",
                "",
                "Jeśli dostawa ma iść na kilka adresów, prosimy o informację o podziale.",
                "",
                STOPKA,
            ].join("\n"),
        },
        {
            key: "attachments",
            enabled: true,
            subject: "Zapytanie {{sprawa.numer}} — prośba o dokumentację",
            body: [
                "Dzień dobry, {{klient.osoba}},",
                "",
                "do wyceny zapytania {{sprawa.numer}} ({{sprawa.budowa}}) brakuje nam plików:",
                "",
                "{{braki.zalaczniki}}",
                "",
                "Wystarczą rysunki w PDF lub DWG. Jeśli dokumentacja jest w przygotowaniu,",
                "prosimy o orientacyjny termin — zaplanujemy wycenę.",
                "",
                STOPKA,
            ].join("\n"),
        },
        {
            key: "phone",
            enabled: true,
            subject: "Zapytanie {{sprawa.numer}} — prośba o kontakt telefoniczny",
            body: [
                "Dzień dobry, {{klient.osoba}},",
                "",
                "przy zapytaniu {{sprawa.numer}} ({{sprawa.budowa}}) pojawiło się kilka pytań,",
                "które szybciej wyjaśnimy telefonicznie niż mailowo.",
                "",
                "Prosimy o numer kontaktowy i dogodną porę — oddzwoni {{kosztorysant.imie}}.",
                "Można też zadzwonić do nas: {{firma.telefon}}.",
                "",
                STOPKA,
            ].join("\n"),
        },
        {
            key: "followup",
            enabled: true,
            subject: "Follow-up: oferta {{sprawa.numer}} — {{sprawa.budowa}}",
            body: [
                "Dzień dobry, {{klient.osoba}},",
                "",
                "nawiązuję do oferty w sprawie {{sprawa.numer}} ({{sprawa.budowa}}),",
                "którą przesłaliśmy {{sprawa.dni}} dni temu.",
                "",
                "Czy oferta jest dla Państwa aktualna i czy mogę w czymś pomóc —",
                "doprecyzować zakres, termin albo warunki płatności?",
                "",
                "Jeśli rezygnują Państwo z tego zapytania, proszę o krótką informację —",
                "zamkniemy sprawę i nie będziemy przypominać.",
                "",
                STOPKA,
            ].join("\n"),
        },
        {
            key: "outsourcing",
            enabled: true,
            subject: "Zapytanie o wycenę — {{element.nazwa}} ({{sprawa.numer}})",
            body: [
                "Dzień dobry,",
                "",
                "zwracamy się z prośbą o wycenę następującego zakresu:",
                "",
                "Element: {{element.nazwa}}",
                "Ilość: {{ilosc}}",
                "Oczekiwany termin: {{sprawa.termin}}",
                "",
                "{{element.opis}}",
                "",
                "Prosimy o podanie ceny netto oraz terminu realizacji.",
                "W razie pytań technicznych prosimy o kontakt zwrotny.",
                "",
                STOPKA,
            ].join("\n"),
        },
    ],
};

export function szablon(key: CrmSettings["templates"][number]["key"]): CrmSettings["templates"][number] {
    const t = crmSettings.templates.find((x) => x.key === key);
    if (!t) throw new Error(`Brak szablonu: ${key}`);
    return t;
}

/** Reguły problemów wyłączone w ustawieniach — w formie listy identyfikatorów. */
export function wylaczoneReguly(): string[] {
    return Object.entries(crmSettings.issues)
        .filter(([, wlaczona]) => !wlaczona)
        .map(([id]) => id);
}