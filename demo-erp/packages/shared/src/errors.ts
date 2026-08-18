/**
 * errors.ts — centralny rejestr błędów.
 *
 * Jedno źródło prawdy w trzech rolach naraz:
 *   1. API rzuca AppError z kodem stąd — nigdy new Error("cokolwiek"),
 *   2. UI pokazuje messageUser dosłownie stąd,
 *   3. asystent AI dostanie ten plik jako korpus wiedzy o błędach.
 * Dzięki temu komunikat w aplikacji i wyjaśnienie asystenta nigdy się nie rozjadą.
 *
 * ErrorCode jest unią stringów, nie enumem: Record<ErrorCode, ErrorDef>
 * wymusza wtedy kompletność rejestru na etapie kompilacji — dodasz kod
 * bez opisu i TypeScript się nie skompiluje.
 */

export type ErrorCode =
    | "ERR-1001"
    | "ERR-1002"
    | "ERR-1003"
    | "ERR-1004"
    | "ERR-1005"
    | "ERR-1006"
    | "ERR-2001"
    | "ERR-3001"
    | "ERR-4001"
    | "ERR-4002"
    | "ERR-4003"
    | "ERR-4004"
    | "ERR-5001"
    | "ERR-5002"
    | "ERR-5003"
    | "ERR-6001"
    | "ERR-6002"
    | "ERR-5201"
    | "ERR-5202"
    | "ERR-7001"
    | "ERR-7002"
    | "ERR-7003"
    | "ERR-7004"
    | "ERR-8001"
    | "ERR-8002"
    | "ERR-8101"
    | "ERR-8102"
    | "ERR-9001"
    | "ERR-9002"
    | "ERR-9003"
    | "ERR-9004"
    | "ERR-9005"
    | "ERR-9006"
    | "ERR-9007"
    | "ERR-9008"
    | "ERR-9009"
    | "ERR-9010"
    | "ERR-9011"
    | "ERR-9012"
    | "ERR-9013"
    | "ERR-9014"
    | "ERR-9015"
    | "ERR-9016"
    | "ERR-9017"
    | "ERR-9018";

export interface ErrorDef {
  code: ErrorCode;
  httpStatus: number;
  /** Pokazywany użytkownikowi w UI — pisany od razu tak, jak ma go
   *  powtórzyć asystent. */
  messageUser: string;
  /** Do logów i devtools. */
  messageDev: string;
  /** Możliwe przyczyny — czyta je asystent, wyjaśniając błąd. */
  causes: string[];
  /** Co użytkownik może z tym zrobić. */
  resolution: string[];
  /** Id procedur asystenta rozwiązujących ten błąd (proc.modul.nazwa). */
  resolutionRefs?: string[];
  isKnownBug: boolean;
}

export const ERRORS: Record<ErrorCode, ErrorDef> = {
  "ERR-1001": {
    code: "ERR-1001",
    httpStatus: 404,
    messageUser: "Nie znaleziono dokumentu o podanym identyfikatorze.",
    messageDev: "Document not found",
    causes: [
      "Dokument został usunięty",
      "Link prowadzi do dokumentu z innego środowiska",
    ],
    resolution: ["Wróć do listy dokumentów i otwórz dokument ponownie"],
    isKnownBug: false,
  },
  "ERR-1002": {
    code: "ERR-1002",
    httpStatus: 409,
    messageUser:
        "Ten dokument jest już zatwierdzony i nie można go edytować.",
    messageDev: "Document is not in draft status",
    causes: [
      "Dokument został zatwierdzony — po zatwierdzeniu dokument jest zamknięty",
      "Ktoś inny zatwierdził dokument w trakcie Twojej edycji",
    ],
    resolution: [
      "Jeśli trzeba coś poprawić, utwórz nowy dokument korygujący ruch",
    ],
    resolutionRefs: ["proc.magazyn.edycja-szkicu"],
    isKnownBug: false,
  },
  "ERR-1003": {
    code: "ERR-1003",
    httpStatus: 422,
    messageUser: "Nie można zatwierdzić dokumentu bez pozycji.",
    messageDev: "Cannot confirm a document with no lines",
    causes: ["Dokument nie ma żadnej pozycji z produktem i ilością"],
    resolution: [
      "Dodaj co najmniej jedną pozycję: wybierz produkt i podaj ilość, potem zatwierdź ponownie",
    ],
    resolutionRefs: ["proc.magazyn.zatwierdzenie"],
    isKnownBug: false,
  },
  "ERR-1004": {
    code: "ERR-1004",
    httpStatus: 422,
    messageUser:
        "Na magazynie źródłowym nie ma wystarczającej ilości produktu, aby zatwierdzić ten dokument.",
    messageDev: "Insufficient stock on source warehouse",
    causes: [
      "Ilość na dokumencie przekracza aktualny stan magazynowy produktu",
      "Stan zmienił się od czasu utworzenia dokumentu — inny dokument wydał ten produkt wcześniej",
    ],
    resolution: [
      "Sprawdź aktualny stan w widoku Stany magazynowe",
      "Zmniejsz ilość na pozycji albo najpierw przyjmij brakującą ilość dokumentem PZ",
    ],
    resolutionRefs: ["proc.magazyn.sprawdzenie-stanu", "proc.magazyn.przyjecie-pz"],
    isKnownBug: false,
  },
  "ERR-1005": {
    code: "ERR-1005",
    httpStatus: 422,
    messageUser:
        "Przesunięcie MM musi mieć różne magazyny: źródłowy i docelowy.",
    messageDev: "MM requires distinct source and target warehouses",
    causes: ["Wybrano ten sam magazyn w polu źródłowym i docelowym"],
    resolution: ["Zmień jeden z magazynów tak, aby były różne"],
    resolutionRefs: ["proc.magazyn.przesuniecie-mm"],
    isKnownBug: false,
  },
  "ERR-1006": {
    code: "ERR-1006",
    httpStatus: 422,
    messageUser:
        "Produkt na pozycji jest nieaktywny lub nie istnieje w kartotece.",
    messageDev: "Line references unknown or inactive product",
    causes: [
      "Produkt został dezaktywowany po dodaniu go do dokumentu",
      "Pozycja wskazuje na produkt usunięty z kartoteki",
    ],
    resolution: [
      "Usuń tę pozycję albo wybierz aktywny produkt z listy",
      "Jeśli produkt powinien być aktywny, sprawdź jego status w kartotece Produkty",
    ],
    isKnownBug: false,
  },
  "ERR-2001": {
    code: "ERR-2001",
    httpStatus: 404,
    messageUser: "Nie znaleziono produktu o podanym identyfikatorze.",
    messageDev: "Product not found",
    causes: ["Produkt został usunięty z kartoteki"],
    resolution: ["Wróć do listy produktów"],
    isKnownBug: false,
  },
  "ERR-3001": {
    code: "ERR-3001",
    httpStatus: 403,
    messageUser:
        "Tylko kierownik może zatwierdzać przesunięcia międzymagazynowe (MM).",
    messageDev: "Role not permitted to confirm MM documents",
    causes: [
      "Zalogowana rola to magazynier, a zatwierdzanie MM wymaga roli kierownik",
    ],
    resolution: [
      "Poproś kierownika o zatwierdzenie dokumentu",
      "Dokument pozostaje w statusie Szkic — nic nie przepadło",
    ],
    resolutionRefs: ["proc.magazyn.zatwierdzenie"],
    isKnownBug: false,
  },
  // ------------------------- inwentaryzacja (4xxx) -------------------------
  "ERR-4001": {
    code: "ERR-4001",
    httpStatus: 409,
    messageUser:
        "Dla tego magazynu istnieje już otwarta inwentaryzacja. Zamknij ją, zanim rozpoczniesz nową.",
    messageDev: "Open stocktake already exists for warehouse",
    causes: [
      "Poprzednia inwentaryzacja tego magazynu nie została zamknięta",
      "Ktoś inny rozpoczął inwentaryzację równolegle",
    ],
    resolution: [
      "Otwórz istniejący arkusz z listy i dokończ liczenie",
      "Po zamknięciu arkusza możesz rozpocząć nową inwentaryzację",
    ],
    resolutionRefs: ["proc.inwentaryzacja.zamkniecie"],
    isKnownBug: false,
  },
  "ERR-4002": {
    code: "ERR-4002",
    httpStatus: 422,
    messageUser:
        "Nie można zamknąć inwentaryzacji — nie wszystkie pozycje zostały policzone.",
    messageDev: "Stocktake has uncounted lines",
    causes: [
      "Co najmniej jedna pozycja arkusza ma puste pole Policzono",
    ],
    resolution: [
      "Uzupełnij ilość policzoną dla każdej pozycji arkusza, potem zamknij ponownie",
    ],
    resolutionRefs: ["proc.inwentaryzacja.wprowadzenie-liczen"],
    isKnownBug: false,
  },
  "ERR-4003": {
    code: "ERR-4003",
    httpStatus: 403,
    messageUser: "Tylko kierownik może zamknąć inwentaryzację.",
    messageDev: "Role not permitted to close stocktake",
    causes: [
      "Zalogowana rola to magazynier, a zamknięcie arkusza wymaga roli kierownik",
    ],
    resolution: [
      "Poproś kierownika o zamknięcie arkusza",
      "Arkusz pozostaje otwarty — wpisane liczenia nie przepadają",
    ],
    resolutionRefs: ["proc.inwentaryzacja.zamkniecie"],
    isKnownBug: false,
  },
  "ERR-4004": {
    code: "ERR-4004",
    httpStatus: 409,
    messageUser:
        "Inwentaryzacja jest zamknięta — nie można już zmieniać liczeń.",
    messageDev: "Stocktake is closed",
    causes: ["Arkusz został zamknięty przez kierownika"],
    resolution: [
      "Zamknięty arkusz jest tylko do odczytu; różnice koryguje się dokumentami PZ lub WZ",
    ],
    isKnownBug: false,
  },

  // ------------------------ zamówienia zakupu (5xxx) -----------------------
  "ERR-5001": {
    code: "ERR-5001",
    httpStatus: 422,
    messageUser: "Nie można wysłać zamówienia bez pozycji.",
    messageDev: "Cannot send a purchase order with no lines",
    causes: ["Zamówienie nie ma żadnej pozycji z produktem i ilością"],
    resolution: [
      "Dodaj co najmniej jedną pozycję: wybierz produkt i podaj ilość, potem wyślij ponownie",
    ],
    resolutionRefs: ["proc.zakupy.utworzenie-zamowienia"],
    isKnownBug: false,
  },
  "ERR-5002": {
    code: "ERR-5002",
    httpStatus: 422,
    messageUser:
        "Dostawca jest nieaktywny — nie można wysłać do niego zamówienia.",
    messageDev: "Supplier is inactive",
    causes: [
      "Kontrahent został dezaktywowany w kartotece po utworzeniu zamówienia",
    ],
    resolution: [
      "Wybierz innego dostawcę albo poproś o aktywację kontrahenta w kartotece",
    ],
    isKnownBug: false,
  },
  "ERR-5003": {
    code: "ERR-5003",
    httpStatus: 409,
    messageUser:
        "Ta operacja nie jest dostępna w bieżącym statusie zamówienia.",
    messageDev: "Operation not allowed in current purchase order status",
    causes: [
      "Wysłać można tylko zamówienie w statusie Szkic",
      "Przyjąć dostawę można tylko z zamówienia w statusie Zamówione",
    ],
    resolution: [
      "Sprawdź status zamówienia na liście i wykonaj operację właściwą dla tego statusu",
    ],
    resolutionRefs: ["proc.zakupy.wyslanie-zamowienia", "proc.zakupy.przyjecie-dostawy"],
    isKnownBug: false,
  },

  // -------------------------- lokalizacje (6xxx) ---------------------------
  "ERR-6001": {
    code: "ERR-6001",
    httpStatus: 409,
    messageUser:
        "Lokalizacja o tym kodzie już istnieje w wybranym magazynie.",
    messageDev: "Location code already exists in warehouse",
    causes: [
      "Kod lokalizacji musi być unikalny w obrębie magazynu, a podany kod jest już zajęty",
    ],
    resolution: [
      "Użyj innego kodu albo odszukaj istniejącą lokalizację na liście",
    ],
    resolutionRefs: ["proc.lokalizacje.wyszukanie-lokalizacji"],
    isKnownBug: false,
  },
  "ERR-6002": {
    code: "ERR-6002",
    httpStatus: 409,
    messageUser:
        "Nie można dezaktywować lokalizacji, która występuje na pozycjach dokumentów.",
    messageDev: "Location is referenced by document lines",
    causes: [
      "Pozycje istniejących dokumentów wskazują tę lokalizację jako miejsce składowania",
    ],
    resolution: [
      "Lokalizacja z historią pozostaje aktywna — zamiast dezaktywacji przestań jej używać na nowych dokumentach",
    ],
    isKnownBug: false,
  },
  // -------------------- faktura zakupu (52xx, moduł Zakupy) ----------------
  "ERR-5201": {
    code: "ERR-5201",
    httpStatus: 409,
    messageUser:
        "Numer faktury od tego dostawcy już istnieje w systemie.",
    messageDev: "Duplicate supplier invoice number",
    causes: [
      "Faktura o tym numerze zewnętrznym została już zarejestrowana dla tego dostawcy",
    ],
    resolution: [
      "Sprawdź, czy faktura nie została już wprowadzona wcześniej",
      "Jeśli to korekta, użyj numeru z oznaczeniem korekty nadanego przez dostawcę",
    ],
    resolutionRefs: ["proc.zakupy.rejestracja-faktury"],
    isKnownBug: false,
  },
  "ERR-5202": {
    code: "ERR-5202",
    httpStatus: 409,
    messageUser:
        "Faktura jest już zaksięgowana i nie można jej edytować.",
    messageDev: "Purchase invoice is already booked",
    causes: ["Faktura została zaksięgowana — po zaksięgowaniu jest zamknięta"],
    resolution: [
      "Zaksięgowaną fakturę koryguje się osobnym dokumentem korekty",
    ],
    isKnownBug: false,
  },

  // ------------------------- zamówienia sprzedaży (7xxx) -------------------
  "ERR-7001": {
    code: "ERR-7001",
    httpStatus: 422,
    messageUser: "Nie można potwierdzić zamówienia bez pozycji.",
    messageDev: "Cannot confirm a sales order with no lines",
    causes: ["Zamówienie nie ma żadnej pozycji z produktem i ilością"],
    resolution: [
      "Dodaj co najmniej jedną pozycję: wybierz produkt i podaj ilość, potem potwierdź ponownie",
    ],
    resolutionRefs: ["proc.sprzedaz.utworzenie-zamowienia"],
    isKnownBug: false,
  },
  "ERR-7002": {
    code: "ERR-7002",
    httpStatus: 422,
    messageUser:
        "Odbiorca jest nieaktywny — nie można potwierdzić dla niego zamówienia.",
    messageDev: "Customer is inactive",
    causes: [
      "Kontrahent został dezaktywowany w kartotece po utworzeniu zamówienia",
    ],
    resolution: [
      "Wybierz innego odbiorcę albo poproś o aktywację kontrahenta w kartotece",
    ],
    isKnownBug: false,
  },
  "ERR-7003": {
    code: "ERR-7003",
    httpStatus: 409,
    messageUser:
        "Ta operacja nie jest dostępna w bieżącym statusie zamówienia sprzedaży.",
    messageDev: "Operation not allowed in current sales order status",
    causes: [
      "Potwierdzić można tylko zamówienie w statusie Szkic",
      "Zrealizować można tylko zamówienie w statusie Potwierdzone",
    ],
    resolution: [
      "Sprawdź status zamówienia na liście i wykonaj operację właściwą dla tego statusu",
    ],
    resolutionRefs: ["proc.sprzedaz.potwierdzenie-zamowienia", "proc.sprzedaz.realizacja-zamowienia"],
    isKnownBug: false,
  },
  "ERR-7004": {
    code: "ERR-7004",
    httpStatus: 422,
    messageUser:
        "Nie można zrealizować zamówienia — na magazynie brakuje towaru na co najmniej jednej pozycji.",
    messageDev: "Insufficient stock to fulfil sales order",
    causes: [
      "Zamawiana ilość przekracza aktualny stan magazynowy produktu",
      "Stan zmienił się od potwierdzenia zamówienia",
    ],
    resolution: [
      "Sprawdź aktualne stany w widoku Stany magazynowe",
      "Zrealizuj zamówienie częściowo albo domów brakujący towar zamówieniem zakupu",
    ],
    resolutionRefs: ["proc.magazyn.sprawdzenie-stanu", "proc.zakupy.utworzenie-zamowienia"],
    isKnownBug: false,
  },

  // ---------------------------- kartoteki (8xxx) ---------------------------
  // 80xx to produkty, 81xx to kontrahenci. Oba rodzaje działają tak samo:
  // duplikat kodu blokuje zapis, a rekord użyty w obrocie blokuje wycofanie.
  "ERR-8001": {
    code: "ERR-8001",
    httpStatus: 409,
    messageUser:
        "Produkt o tym indeksie już istnieje. Indeks musi być unikalny w całej kartotece.",
    messageDev: "Duplicate product SKU",
    causes: [
      "W kartotece jest już produkt o takim indeksie — być może wycofany i ukryty filtrem",
      "Indeks wpisano inną wielkością liter, a system porównuje je bez rozróżniania",
    ],
    resolution: [
      "Zaznacz pokaż nieaktywne i sprawdź, czy produkt nie został wcześniej wycofany",
      "Jeśli produkt istnieje i jest wycofany, przywróć go zamiast zakładać nowy",
    ],
    resolutionRefs: ["proc.magazyn.wyszukanie-produktu", "proc.magazyn.wycofanie-produktu"],
    isKnownBug: false,
  },
  "ERR-8002": {
    code: "ERR-8002",
    httpStatus: 409,
    messageUser:
        "Nie można wycofać produktu, który występuje na pozycjach dokumentów.",
    messageDev: "Product is referenced by document, order, invoice or stocktake lines",
    causes: [
      "Indeks występuje na pozycji dokumentu, zamówienia, faktury albo arkusza inwentaryzacji",
      "System pilnuje spójności historii obrotu",
    ],
    resolution: [
      "Produkt z historią pozostaje aktywny — zamiast wycofania przestań go dodawać do nowych dokumentów",
      "Sprawdź, na których dokumentach występuje, filtrując listę dokumentów",
    ],
    resolutionRefs: ["proc.magazyn.wyszukanie-dokumentu"],
    isKnownBug: false,
  },
  "ERR-8101": {
    code: "ERR-8101",
    httpStatus: 409,
    messageUser: "Kontrahent o tym kodzie już istnieje. Kod musi być unikalny.",
    messageDev: "Duplicate counterparty code",
    causes: [
      "W kartotece jest już kontrahent o takim kodzie — być może nieaktywny",
      "Kod wpisano inną wielkością liter, a system porównuje je bez rozróżniania",
    ],
    resolution: [
      "Wyszukaj kontrahenta po kodzie i sprawdź, czy nie został wcześniej dezaktywowany",
      "Nadaj nowemu kontrahentowi inny kod, zachowując prefiks DOS, ODB albo KON",
    ],
    resolutionRefs: ["proc.sprzedaz.wyszukanie-kontrahenta", "proc.sprzedaz.dodanie-kontrahenta"],
    isKnownBug: false,
  },
  "ERR-8102": {
    code: "ERR-8102",
    httpStatus: 409,
    messageUser:
        "Nie można dezaktywować kontrahenta użytego na dokumentach lub zamówieniach.",
    messageDev: "Counterparty is referenced by documents, orders or invoices",
    causes: [
      "Kontrahent figuruje na dokumencie PZ lub WZ, zamówieniu albo fakturze",
      "System chroni historię obrotu przed osieroceniem powiązań",
    ],
    resolution: [
      "Kontrahent z historią pozostaje aktywny — po prostu nie wybieraj go na nowych dokumentach",
      "Sprawdź, na których dokumentach występuje, filtrując listę dokumentów",
    ],
    resolutionRefs: ["proc.magazyn.wyszukanie-dokumentu"],
    isKnownBug: false,
  },
  // ------------------------------- CRM -----------------------------------

  "ERR-9001": {
    code: "ERR-9001",
    httpStatus: 404,
    messageUser: "Nie znaleziono zapytania CRM o podanym identyfikatorze.",
    messageDev: "CRM request not found",
    causes: [
      "Zapytanie zostało usunięte lub scalone z innym",
      "Link prowadzi do zapytania z innego środowiska",
    ],
    resolution: ["Wróć do listy zapytań i otwórz pozycję ponownie"],
    isKnownBug: false,
  },
  "ERR-9002": {
    code: "ERR-9002",
    httpStatus: 400,
    messageUser:
        "Przeniesienie zapytania na etap „Przegrane” wymaga wskazania przyczyny.",
    messageDev: "Lost stage requires a reason",
    causes: [
      "Etap zmieniono przeciągnięciem karty na kanbanie, bez wypełnienia formularza przyczyny",
    ],
    resolution: [
      "Otwórz szczegóły zapytania i wybierz przyczynę przegranej",
      "Dla przyczyny „Inna” uzupełnij dodatkowo opis",
    ],
    isKnownBug: false,
  },
  "ERR-9003": {
    code: "ERR-9003",
    httpStatus: 404,
    messageUser: "Nie znaleziono wiadomości w skrzynce zapytań.",
    messageDev: "Inbox message not found",
    causes: ["Wiadomość została pominięta i usunięta z widoku"],
    resolution: ["Odśwież skrzynkę przyciskiem „Sprawdź teraz”"],
    isKnownBug: false,
  },
  "ERR-9004": {
    code: "ERR-9004",
    httpStatus: 409,
    messageUser:
        "Na podstawie tej wiadomości utworzono już zapytanie CRM.",
    messageDev: "Inbox message already converted",
    causes: ["Akcję wykonano dwukrotnie, np. w dwóch otwartych zakładkach"],
    resolution: ["Otwórz powiązane zapytanie z widoku wiadomości"],
    isKnownBug: false,
  },
  "ERR-9005": {
    code: "ERR-9005",
    httpStatus: 502,
    messageUser:
        "Nie udało się pobrać wiadomości ze skrzynki. Spróbuj ponownie za chwilę.",
    messageDev: "Mailbox adapter failure (mock)",
    causes: [
      "Symulowana awaria połączenia ze skrzynką w wersji demonstracyjnej",
      "Docelowo: brak odpowiedzi serwera IMAP lub wygasłe poświadczenia",
    ],
    resolution: [
      "Uruchom pobieranie ponownie przyciskiem „Sprawdź teraz”",
      "Automatyczne pobieranie i tak spróbuje ponownie w kolejnym cyklu",
    ],
    isKnownBug: false,
  },
  "ERR-9006": {
    code: "ERR-9006",
    httpStatus: 403,
    messageUser: "Tylko kierownik może przydzielać zapytania pracownikom.",
    messageDev: "Role not permitted to assign CRM requests",
    causes: ["Aktywny kontekst uprawnień to magazynier"],
    resolution: [
      "Zmień kontekst uprawnień na „Kierownik” w panelu nawigacji",
    ],
    isKnownBug: false,
  },
  "ERR-9007": {
    code: "ERR-9007",
    httpStatus: 404,
    messageUser: "Nie znaleziono pracownika wskazanego dla kolumny.",
    messageDev: "Employee not found for board column",
    causes: ["Pracownik został usunięty lub podano nieistniejący identyfikator"],
    resolution: ["Wybierz pracownika z listy zamiast wpisywać identyfikator ręcznie"],
    isKnownBug: false,
  },
  "ERR-9008": {
    code: "ERR-9008",
    httpStatus: 409,
    messageUser: "Ten kosztorysant ma już własną kolumnę na tablicy.",
    messageDev: "Duplicate estimator column",
    causes: ["Kolumna dla wybranego pracownika istnieje"],
    resolution: [
      "Użyj istniejącej kolumny pracownika",
      "Aby rozdzielić pracę, dodaj kolumnę własną z inną nazwą",
    ],
    isKnownBug: false,
  },
  "ERR-9009": {
    code: "ERR-9009",
    httpStatus: 404,
    messageUser: "Nie znaleziono kolumny tablicy.",
    messageDev: "Board column not found",
    causes: ["Kolumna została usunięta przez innego użytkownika"],
    resolution: ["Odśwież tablicę i powtórz operację"],
    isKnownBug: false,
  },
  "ERR-9010": {
    code: "ERR-9010",
    httpStatus: 409,
    messageUser: "Kolumny systemowej „Nowe” ani „Przegrane” nie można usunąć.",
    messageDev: "Attempt to delete system column",
    causes: ["Kolumny systemowe są punktem wejścia i archiwum tablicy"],
    resolution: ["Usuwaj wyłącznie kolumny kosztorysantów i kolumny własne"],
    isKnownBug: false,
  },
  "ERR-9011": {
    code: "ERR-9011",
    httpStatus: 404,
    messageUser: "Nie znaleziono klienta w kartotece.",
    messageDev: "CRM client not found",
    causes: ["Klient został usunięty lub podano nieistniejący identyfikator"],
    resolution: ["Wybierz klienta z listy rozwijanej w panelu szczegółów"],
    isKnownBug: false,
  },
  "ERR-9012": {
    code: "ERR-9012",
    httpStatus: 404,
    messageUser: "Ten pracownik nie figuruje na liście kosztorysantów zapytania.",
    messageDev: "Employee not in request assignee list",
    causes: ["Kosztorysant został już usunięty przez innego użytkownika"],
    resolution: ["Odśwież widok zapytania i powtórz operację"],
    isKnownBug: false,
  },
  "ERR-9013": {
    code: "ERR-9013",
    httpStatus: 404,
    messageUser: "Nie znaleziono firmy zewnętrznej na liście kooperantów.",
    messageDev: "Vendor not found",
    causes: ["Firma została usunięta z rejestru kooperantów"],
    resolution: ["Wybierz firmę z listy w oknie wysyłki zapytania"],
    isKnownBug: false,
  },
  "ERR-9014": {
    code: "ERR-9014",
    httpStatus: 404,
    messageUser: "Nie znaleziono elementu zlecanego na zewnątrz ani jego zapytania.",
    messageDev: "Outsourcing item or vendor inquiry not found",
    causes: ["Element został usunięty przez innego użytkownika"],
    resolution: ["Odśwież panel outsourcingu i powtórz operację"],
    isKnownBug: false,
  },
  "ERR-9015": {
    code: "ERR-9015",
    httpStatus: 404,
    messageUser: "Nie znaleziono załącznika w tym zapytaniu.",
    messageDev: "Attachment not found in request",
    causes: ["Załącznik został usunięty", "Nieaktualny widok zapytania"],
    resolution: ["Odśwież zakładkę załączników"],
    isKnownBug: false,
  },
  "ERR-9016": {
    code: "ERR-9016",
    httpStatus: 404,
    messageUser: "Nie znaleziono osoby kontaktowej w kartotece klienta.",
    messageDev: "Client contact not found",
    causes: ["Kontakt został usunięty przez innego użytkownika"],
    resolution: ["Odśwież panel osób kontaktowych i powtórz operację"],
    isKnownBug: false,
  },
  "ERR-9017": {
    code: "ERR-9017",
    httpStatus: 409,
    messageUser: "Nie można usunąć jedynej osoby kontaktowej klienta.",
    messageDev: "Cannot delete the last client contact",
    causes: ["Klient bez kontaktu wypadłby z całej korespondencji"],
    resolution: [
      "Dodaj nową osobę kontaktową, a dopiero potem usuń poprzednią",
      "Aby wymienić dane, użyj edycji kontaktu zamiast usuwania",
    ],
    isKnownBug: false,
  },
  "ERR-9018": {
    code: "ERR-9018",
    httpStatus: 400,
    messageUser: "Każda zapytana firma musi mieć przypisany co najmniej jeden element do wyceny.",
    messageDev: "Vendor inquiry with empty element scope",
    causes: ["Odznaczono wszystkie pozycje dla wybranej firmy"],
    resolution: [
      "Zaznacz firmie przynajmniej jedną pozycję",
      "Albo usuń firmę z listy zapytanych",
    ],
    isKnownBug: false,
  },
};
/** Błąd biznesowy niosący kod z rejestru + opcjonalne szczegóły. */
export class AppError extends Error {
  readonly def: ErrorDef;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, details?: Record<string, unknown>) {
    super(ERRORS[code].messageDev);
    this.name = "AppError";
    this.def = ERRORS[code];
    this.details = details;
  }
}

/** Kształt błędu na drucie — to samo widzi UI i asystent. */
export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}