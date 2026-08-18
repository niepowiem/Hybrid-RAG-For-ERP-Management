/**
 * mock-mailbox.ts — atrapa zewnętrznej skrzynki pocztowej.
 *
 * To jest JEDYNE miejsce w module CRM, które udaje świat zewnętrzny.
 * Rekordy odpowiadają temu, co realny adapter IMAP/Graph zwróciłby po
 * sparsowaniu wiadomości: nadawca, temat, data, treść, nazwy załączników.
 *
 * Pole `deliverAfterSec` istnieje wyłącznie na potrzeby demonstracji:
 * wiadomość „przychodzi” dopiero po tylu sekundach od startu serwera,
 * dzięki czemu automatyczne odpytywanie co 30 s ma co znaleźć na oczach
 * widza. Prawdziwy adapter tego pola nie będzie miał.
 *
 * Zestaw dobrano tak, by jeden przebieg demonstracji pokazał wszystkie
 * ścieżki przetwarzania: zapytanie kompletne, zapytanie z brakami,
 * korespondencję do pominięcia, wiadomość nierozpoznaną i — po 25 sekundach
 * — świadomy duplikat pierwszego zapytania.
 */

export interface RawMail {
  messageId: string;
  from: string;
  fromEmail: string;
  subject: string;
  receivedAt: string;
  body: string;
  attachments: { name: string; sizeKb: number }[];
  /** Sekundy od startu procesu, po których wiadomość pojawia się w skrzynce. */
  deliverAfterSec: number;
}

/** Znacznik czasu sprzed `minut` — daty w skrzynce mają być zawsze świeże. */
const przed = (minut: number): string => new Date(Date.now() - minut * 60_000).toISOString();

const dataZa = (dni: number): string =>
    new Date(Date.now() + dni * 86_400_000).toISOString().slice(0, 10);

export const RAW_MAILBOX: RawMail[] = [
  {
    messageId: "<20260817-01@hydromel.pl>",
    from: "Anna Wiśniewska",
    fromEmail: "a.wisniewska@hydromel.pl",
    subject: "Zapytanie ofertowe — ramy montażowe, 60 kpl.",
    receivedAt: przed(215),
    body: [
      "Dzień dobry,",
      "",
      "zwracamy się z zapytaniem ofertowym na wykonanie ram montażowych",
      "wg załączonego rysunku. Ilość: 60 kpl. Materiał S235JR, ocynk ogniowy.",
      "",
      `Termin realizacji: do ${dataZa(46)}.`,
      "Prosimy o wycenę do końca tygodnia.",
      "",
      "Hydromel Sp. z o.o.",
      "ul. Hutnicza 14, 40-241 Katowice",
      "Tel: +48 601 224 118",
      "",
      "Pozdrawiam,",
      "Anna Wiśniewska",
      "Dział Zakupów",
    ].join("\n"),
    attachments: [
      { name: "rysunek-rama-A3.pdf", sizeKb: 812 },
      { name: "specyfikacja-materialowa.xlsx", sizeKb: 64 },
    ],
    deliverAfterSec: 0,
  },
  {
    messageId: "<20260817-02@alubud.com.pl>",
    from: "Marek Zieliński",
    fromEmail: "m.zielinski@alubud.com.pl",
    subject: "Prośba o wycenę — profile aluminiowe i akcesoria",
    receivedAt: przed(160),
    body: [
      "Dzień dobry,",
      "",
      "proszę o wycenę profili aluminiowych 40x40 oraz kompletów łączników.",
      "Ilość: 320 mb profili i 900 szt. łączników.",
      "",
      "ALUBUD Sp. z o.o.",
      "",
      "Pozdrawiam",
      "Marek Zieliński",
    ].join("\n"),
    attachments: [],
    deliverAfterSec: 0,
  },
  {
    messageId: "<20260817-03@newsletter.hurtstal.pl>",
    from: "HurtStal Newsletter",
    fromEmail: "newsletter@hurtstal.pl",
    subject: "Promocja sierpniowa — profile zamknięte do -18%",
    receivedAt: przed(140),
    body: [
      "Sprawdź nasze sierpniowe promocje na profile zamknięte i kątowniki.",
      "Rabaty do 18% dla stałych klientów.",
      "",
      "Aby zrezygnować z subskrypcji, kliknij tutaj.",
    ].join("\n"),
    attachments: [],
    deliverAfterSec: 0,
  },
  {
    messageId: "<20260817-04@metalpol.pl>",
    from: "Biuro Metalpol",
    fromEmail: "biuro@metalpol.pl",
    subject: "Re: Faktura FZ/2026/07/118 — potwierdzenie płatności",
    receivedAt: przed(120),
    body: [
      "Dzień dobry,",
      "",
      "potwierdzamy zapłatę faktury FZ/2026/07/118 przelewem z dnia 11.08.",
      "",
      "Pozdrawiam,",
      "Biuro Metalpol Handel",
    ].join("\n"),
    attachments: [{ name: "potwierdzenie-przelewu.pdf", sizeKb: 96 }],
    deliverAfterSec: 0,
  },
  {
    messageId: "<20260817-05@gmail.com>",
    from: "Sebastian Górny",
    fromEmail: "s.gorny91@gmail.com",
    subject: "zapytanie",
    receivedAt: przed(75),
    body: [
      "Dzień dobry, chciałbym zapytać o możliwość wykonania kilku elementów.",
      "Proszę o kontakt.",
    ].join("\n"),
    attachments: [],
    deliverAfterSec: 0,
  },
  {
    messageId: "<20260817-06@hydromel.pl>",
    from: "Anna Wiśniewska",
    fromEmail: "a.wisniewska@hydromel.pl",
    subject: "Zapytanie ofertowe — ramy montażowe, 60 kpl. (ponowna wysyłka)",
    receivedAt: przed(3),
    body: [
      "Dzień dobry,",
      "",
      "ponawiam wcześniejsze zapytanie, nie mam pewności czy doszło.",
      "Ramy montażowe wg rysunku, 60 kpl., materiał S235JR, ocynk ogniowy.",
      `Termin realizacji: do ${dataZa(46)}.`,
      "",
      "Hydromel Sp. z o.o., ul. Hutnicza 14, 40-241 Katowice",
      "Tel: +48 601 224 118",
      "",
      "Anna Wiśniewska",
    ].join("\n"),
    attachments: [{ name: "rysunek-rama-A3.pdf", sizeKb: 812 }],
    deliverAfterSec: 25,
  },
  {
    messageId: "<20260817-07@kablomex.pl>",
    from: "Tomasz Baran",
    fromEmail: "t.baran@kablomex.pl",
    subject: "Zapytanie ofertowe — okablowanie hali produkcyjnej",
    receivedAt: przed(2),
    body: [
      "Dzień dobry,",
      "",
      "prosimy o ofertę na okablowanie hali: kabel YDY 3x1,5 — 2400 m,",
      "wraz z osprzętem wg specyfikacji w załączniku.",
      "",
      `Termin realizacji: ${dataZa(60)}`,
      "",
      "KABLOMEX S.A.",
      "ul. Marynarska 22, 02-674 Warszawa",
      "tel. +48 22 512 44 90",
      "",
      "Tomasz Baran, Kierownik Projektu",
    ].join("\n"),
    attachments: [
      { name: "specyfikacja-osprzetu.pdf", sizeKb: 430 },
      { name: "rzut-hali.dwg", sizeKb: 2140 },
    ],
    deliverAfterSec: 55,
  },
  {
    // Odpowiedź na wysłaną ofertę — po jej pobraniu automat zamknie sprawę
    // ZAP-2026-0002 jako przegraną z przyczyną „rezygnacja klienta”.
    messageId: "<20260817-10@technoserwis.com.pl>",
    from: "Marek Zieliński",
    fromEmail: "m.zielinski@technoserwis.com.pl",
    subject: "Re: Oferta ZAP-2026-0002 — linia montażowa L2",
    receivedAt: przed(1),
    body: [
      "Dzień dobry,",
      "",
      "dziękuję za przygotowanie oferty i za przypomnienie.",
      "Niestety nie jesteśmy zainteresowani — wybraliśmy inną ofertę,",
      "z krótszym terminem realizacji.",
      "",
      "Pozostajemy w kontakcie przy kolejnych zapytaniach.",
      "",
      "Marek Zieliński",
      "PPHU Technoserwis",
    ].join("\n"),
    attachments: [],
    deliverAfterSec: 75,
  },
  {
    messageId: "<20260817-08@interia.pl>",
    from: "Jolanta Krupa",
    fromEmail: "j.krupa@interia.pl",
    subject: "Pytanie o współpracę",
    receivedAt: przed(2),
    body: [
      "Dzień dobry,",
      "",
      "reprezentuję firmę szkoleniową i chciałabym przedstawić naszą ofertę",
      "szkoleń BHP dla Państwa pracowników. Czy mogę przesłać materiały?",
      "",
      "Pozdrawiam,",
      "Jolanta Krupa",
    ].join("\n"),
    attachments: [],
    deliverAfterSec: 90,
  },
  {
    messageId: "<20260817-09@vulcanmetal.eu>",
    from: "Dział Zakupów VULCAN",
    fromEmail: "zakupy@vulcanmetal.eu",
    subject: "RFQ — obudowy blaszane 120 szt., zapytanie ofertowe",
    receivedAt: przed(2),
    body: [
      "Szanowni Państwo,",
      "",
      "zwracamy się z zapytaniem ofertowym na wykonanie obudów blaszanych",
      "malowanych proszkowo RAL 9005, 120 szt.",
      "Rysunki wykonawcze w załączeniu, zdjęcia referencyjne również.",
      "",
      `Termin realizacji: ${dataZa(77)}`,
      "",
      "VULCAN METAL Sp. z o.o.",
      "ul. Fabryczna 3, 26-600 Radom",
      "tel. +48 48 360 12 03",
      "",
      "Dział Zakupów",
    ].join("\n"),
    attachments: [
      { name: "obudowa-rys-wykonawczy.pdf", sizeKb: 1180 },
      { name: "referencje-foto.zip", sizeKb: 3400 },
      { name: "formularz-zapytania.docx", sizeKb: 58 },
    ],
    deliverAfterSec: 130,
  },
];