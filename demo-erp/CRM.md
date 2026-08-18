# Moduł CRM — zapytania ofertowe

Moduł obsługuje ścieżkę od wiadomości przychodzącej do zamkniętego zapytania:
odbiór poczty → klasyfikacja → wyodrębnienie danych → wykrycie duplikatu →
zapytanie w lejku → follow-upy → wygrana albo przegrana z przyczyną.

Wersja demonstracyjna. Skrzynka pocztowa jest atrapą, dane żyją w pamięci
procesu API i znikają po restarcie — tak samo jak reszta `demo-erp`.

---

## 1. Uruchomienie

```bash
cd demo-erp
npm install
npm run dev
```

- interfejs: <http://localhost:5173> → grupa **CRM** w nawigacji po lewej
- API: <http://localhost:3001>

Osobno: `npm run dev:api`, `npm run dev:web`.
Kontrola typów: `npm run typecheck`. Produkcyjny build frontu: `npm run build -w @demo-erp/web`.

Rola użytkownika jest przełączana w prawym górnym rogu i idzie do API nagłówkiem
`x-user-role`. Przydzielanie opiekuna wymaga roli **Kierownik**.

### Ścieżka przez demo (5 minut)

1. **Pulpit CRM** — 8 wskaźników, lejek, panel skrzynki, najbliższe kontakty.
2. **Skrzynka zapytań** — kliknij „Sprawdź teraz”. Pojawi się 5–6 wiadomości:
   dwie zamienią się w zapytania automatycznie, dwie zostaną pominięte
   (newsletter, potwierdzenie płatności), jedna trafi do weryfikacji.
   Zostaw zakładkę otwartą — kolejne wiadomości dochodzą po 25, 55, 90 i 130
   sekundach od startu API, w tym **duplikat** zapytania od Hydromel.
3. **Tablica zapytań** — kolumny to LUDZIE („Nowe”, kolumna każdego
   kosztorysanta, kolumny własne, „Przegrane”), a etap sprawy widać na szynie
   przy lewej krawędzi kafelka. Przeciągnij kartę do kolumny kosztorysanta —
   to jest przydzielenie sprawy. Upuszczenie na „Przegrane” otwiera okno
   wyboru przyczyny; bez przyczyny karta zostaje na miejscu. Przycisk
   „+ Kolumna” dodaje kolumnę kosztorysanta albo własną.
4. **Zapytania** → dowolny numer → widok szczegółów: dane, załączniki, wiadomość
   źródłowa, follow-upy, wygenerowane wiadomości, historia aktywności.
   Przycisk „Poproś o uzupełnienie danych” tworzy treść z listy braków.
5. **Kalendarz kontaktów** — follow-upy pogrupowane: przeterminowane, dziś,
   jutro, w tym tygodniu, później.

---

## 2. Architektura

```
packages/shared/src/crm.ts        model, słowniki, walidacja, funkcje oceny
packages/api/src/crm/
  mock-mailbox.ts                 ATRAPA: surowe wiadomości
  clients.ts                      kartoteka klientów (dopasowanie po e-mailu)
  mailbox.ts                      MailboxAdapter + MockMailboxAdapter  ← punkt podmiany
  classify.ts                     zapytanie ofertowe / pozostałe
  extract.ts                      wyodrębnianie danych z treści
  duplicates.ts                   wykrywanie duplikatów
  messages.ts                     generowanie i „wysyłka” wiadomości  ← punkt podmiany
  pipeline.ts                     pobierz → sklasyfikuj → wyodrębnij → utwórz
  store.ts                        dane demo w pamięci                 ← punkt podmiany
  routes.ts                       endpointy /api/crm/*
packages/web/src/crm/             klient HTTP, serwis odpytywania, hooki, komponenty
  BoardCard.tsx                   kafelek tablicy (szyna etapów, problemy, puls)
  RequestDrawer.tsx               panel szczegółów wysuwany z prawej
packages/web/src/pages/crm/       7 widoków
packages/web/src/crm.css          warstwa wizualna modułu
```

Zasada, którą warto zachować przy rozbudowie: **pobieranie poczty nie wie nic
o interfejsie, a interfejs nie wie nic o poczcie**. UI rozmawia wyłącznie z
`/api/crm/*`. Podmiana atrapy na prawdziwy IMAP nie dotyka ani jednego pliku
w `packages/web`.

### Model danych

`CrmRequest` (zapytanie) — dane klienta, opis, produkty, ilość, termin, źródło,
etap, opiekun, scoring, wymagane i otrzymane załączniki, przyczyna przegranej,
follow-upy, wiadomości, historia aktywności, `sourceMessageId`.

Etapy: `new → contact → offer_prep → offer_sent → negotiation → won | lost`.

**Status kompletności i podpowiedź scoringu nie są polami w bazie** — liczą je
funkcje czyste `ocenKompletnosc()` i `sugerowanyScoring()` w `shared/src/crm.ts`,
używane zarówno przez API, jak i przez interfejs. Nie ma jak się rozjechać.
Scoring wpisany ręcznie jest polem i nadpisuje podpowiedź.

### Endpointy

| Metoda | Ścieżka | Uwagi |
|---|---|---|
| GET | `/api/crm/employees` | lista pracowników |
| GET, POST | `/api/crm/requests` | lista, utworzenie ręczne |
| GET, PUT | `/api/crm/requests/:id` | szczegóły, edycja |
| POST | `/api/crm/requests/:id/stage` | zmiana etapu (przegrana wymaga przyczyny) |
| POST | `/api/crm/requests/:id/assign` | tylko rola `kierownik` |
| POST | `/api/crm/requests/:id/score` | scoring 0–100 |
| POST | `/api/crm/requests/:id/followups` | + `/:fid/done`, `/:fid/skip` |
| POST | `/api/crm/requests/:id/messages/missing-data` | wygenerowanie prośby |
| POST | `/api/crm/requests/:id/messages/:mid/send` | „wysyłka” (mock) |
| GET | `/api/crm/mailbox` | stan skrzynki i wiadomości |
| POST | `/api/crm/mailbox/poll` | wymuszenie pobrania |
| POST | `/api/crm/mailbox/messages/:id/category` | zmiana kategorii |
| POST | `/api/crm/mailbox/messages/:id/accept` | utworzenie zapytania mimo ostrzeżenia |
| POST | `/api/crm/mailbox/messages/:id/reject` | odrzucenie |
| POST | `/api/crm/mailbox/messages/:id/review` | oznaczenie do weryfikacji |
| GET | `/api/crm/board` | kolumny, zapytania, klienci, pracownicy |
| GET | `/api/crm/clients` | kartoteka klientów |
| POST, DELETE | `/api/crm/board/columns[/:cid]` | dodanie i usunięcie kolumny |
| POST | `/api/crm/requests/:id/column` | przeniesienie karty (= przypisanie sprawy) |
| PATCH | `/api/crm/requests/:id` | edycja pól z panelu szczegółów |
| POST | `/api/crm/requests/:id/stage-note` | notatka przy etapie |
| POST | `/api/crm/requests/:id/seen` | wygaszenie pulsowania „nowego” |

Nowe kody błędów w `shared/src/errors.ts` (pula `ERR-9xxx`, ta sama konwencja,
co reszta systemu — komunikat, przyczyny, sposób naprawy):

`ERR-9001` brak zapytania · `ERR-9002` przegrana bez przyczyny ·
`ERR-9003` brak wiadomości · `ERR-9004` wiadomość już przetworzona ·
`ERR-9005` awaria pobierania poczty · `ERR-9006` przydzielanie tylko dla kierownika ·
`ERR-9007` brak pracownika dla kolumny · `ERR-9008` kosztorysant ma już kolumnę ·
`ERR-9009` brak kolumny · `ERR-9010` próba usunięcia kolumny systemowej ·
`ERR-9011` brak klienta w kartotece

Skrypt `npm run kb:generate` rozpoznaje prefiks `ERR-9` i oznacza te karty
modułem `crm`, więc asystent dostaje wiedzę o CRM bez ręcznej synchronizacji.

---

## 3. Jak działa atrapa skrzynki

`MockMailboxAdapter` czyta tablicę z `mock-mailbox.ts` i zachowuje się jak
serwer pocztowy, z którym coś może pójść nie tak:

- **Odpytywanie co 30 s.** `packages/web/src/crm/poller.ts` trzyma jeden
  interwał na całą aplikację (nie jeden na komponent) i rozsyła stan do
  subskrybentów. Odlicza też sekundy do następnego sprawdzenia.
- **Wiadomości dochodzą stopniowo.** Pole `deliverAfterSec` decyduje, po ilu
  sekundach od startu API wiadomość „przychodzi”: 0, 25, 55, 90, 130. Dzięki
  temu automatyczne odpytywanie ma co znaleźć na oczach widza. Prawdziwy
  adapter tego pola nie będzie miał.
- **Symulowane opóźnienie** 500–1400 ms i **8% szans na awarię** pobierania
  (pierwsze pobranie zawsze się udaje). Awaria to `ERR-9005`: pasek stanu robi
  się czerwony, wcześniejsze wiadomości zostają na miejscu, następny cykl
  próbuje ponownie. Bez tego nie dałoby się pokazać, jak interfejs znosi
  niedostępność poczty.
- **Deduplikacja po `Message-ID`.** Zbiór `znanePobrania` w `store.ts`
  gwarantuje, że ta sama wiadomość nie zostanie pobrana dwa razy.
- **Daty względem dnia uruchomienia.** Wiadomości i zapytania demo mają daty
  liczone od `Date.now()`, więc follow-upy zawsze pokazują komplet stanów:
  przeterminowane, dzisiejsze i przyszłe.

Zestaw 9 wiadomości pokrywa wszystkie ścieżki: zapytanie kompletne z dwoma
załącznikami, zapytanie z brakami (bez telefonu i terminu), newsletter,
potwierdzenie płatności, jednozdaniowa wiadomość bez danych, duplikat
wcześniejszego zapytania, oferta szkoleń, RFQ z trzema załącznikami.

### Klasyfikacja

`classify.ts` — punktacja słów kluczowych. Frazy za („zapytanie ofertowe”,
„prośba o wycenę”, „RFQ”, „termin realizacji”) i przeciw („newsletter”,
„subskrypcja”, „potwierdzamy zapłatę”, „faktura”). Temat waży podwójnie,
próg wynosi 4 punkty. Wynik zawiera uzasadnienie, które widać w interfejsie —
operator wie, dlaczego wiadomość trafiła tam, gdzie trafiła, i może zmienić
kategorię jednym kliknięciem.

### Wyodrębnianie danych

`extract.ts` — osobna heurystyka na każde pole: telefon (formaty polskie),
adres (ulica + kod pocztowy), nazwa firmy (formy prawne i przedrostki, w razie
niepowodzenia domena nadawcy, z odrzuceniem domen publicznych), termin, ilość,
opis, produkty. Każde pole może zwrócić `null` — brak danych jest normalnym
stanem, nie błędem, i przekłada się na status kompletności.

### Duplikaty

`duplicates.ts` — punktacja podobieństwa: adres e-mail nadawcy (0,45), nazwa
firmy, opis i temat (współczynnik Dice’a na bigramach). Próg 0,6, okno 30 dni.
Przy trafieniu wiadomość dostaje status „do weryfikacji” i opis powodu,
a zapytanie **nie powstaje automatycznie** — decyzję podejmuje człowiek
przyciskiem „Utwórz mimo to”.

### Reguła scoringu (demonstracyjna)

Baza 40 pkt, +20 za komplet danych albo +10 za dane częściowe, +10 za
załączniki, +10 za znany termin, +10 za znaną ilość, +10 za etap co najmniej
„Oferta wysłana”, −10 za brak telefonu. Zakres 0–100. Docelowo w tym miejscu
powinien znaleźć się model albo reguła uzgodniona z działem handlowym —
funkcja jest jednym punktem zmiany.

---

## 3a. Tablica zapytań — zasady projektowe

Tablica ma wytrzymać sto kafelków naraz. Wszystkie decyzje wynikają z tego
jednego założenia.

### Kolumny to ludzie, nie etapy

Klasyczny kanban ustawia kolumny wzdłuż etapów procesu. Tutaj kolumny
odpowiadają na pytanie „kto się tym zajmuje”, a etap siedzi na kafelku.
Dzięki temu jedna tablica odpowiada naraz na dwa pytania, a przydzielenie
sprawy jest tym samym gestem co przeciągnięcie karty — nie ma osobnego
formularza, o którym można zapomnieć.

- **Nowe** — wszystko, co wpadło z poczty; karty pulsują, dopóki ktoś ich nie
  tknie.
- **Kolumny kosztorysantów** — upuszczenie karty ustawia `assigneeId` i, jeśli
  sprawa była na etapie „Nowe”, przesuwa ją na „Kontakt”.
- **Kolumny własne** — np. „Wstrzymane”, „Do weryfikacji”; nie przypisują
  spraw, służą do porządkowania pracy.
- **Przegrane** — kolumna systemowa; wymaga przyczyny przy upuszczeniu.

Kolumny „Nowe” i „Przegrane” są nieusuwalne. Usunięcie innej kolumny nie
kasuje kart — wracają do „Nowych” ze zdjętym przypisaniem i wpisem w historii.

### Anatomia kafelka

```
│ ← szyna 6 etapów        23.07.2026            68%   ← pilność, data, szansa
│ (!)  ← znacznik         Hala P4 — Gliwice            ← nazwa budowy
│                         Hydromel Sp. z o.o.          ← klient
│                         ─────────────────
│                         ↳ Jan Kowalski · kosztorysant
│                         125 999,99 PLN         [⤢]  ← wycena, szczegóły
├─────────────────────────────────────────────────────
│ Brak adresu budowy                    [Poproś o adres]  ← pasek problemu
```

Szyna po lewej ma sześć segmentów (`new`, `contact`, `offer_prep`,
`offer_sent`, `negotiation`, `won`). „Przegrane” celowo nie jest segmentem:
to zakończenie procesu, nie kolejny krok. Segment, na którym coś blokuje
pracę, zapala się na bursztynowo albo czerwono, a obok pojawia się znacznik
„!” z dymkiem wyliczającym wszystkie problemy sprawy.

### Problemy i szybkie akcje

Wykrywa je jedna funkcja czysta `wykryjProblemy()` w `shared/src/crm.ts`,
wspólna dla API i interfejsu — kafelek, dymek i panel szczegółów pokazują
dokładnie to samo. Wynik jest posortowany wagą; pierwszy element steruje
kolorem szyny i treścią paska na dole karty.

| Problem | Waga | Szybka akcja |
|---|---|---|
| Termin dostawy blisko / minął | ostrzeżenie / błąd | Zaplanuj kontakt |
| Brak adresu budowy | błąd | Poproś o adres |
| Brak wymaganych załączników | ostrzeżenie | Poproś o pliki |
| Brak specyfikacji, ilości lub telefonu | błąd / ostrzeżenie | Poproś o dane |
| Bez kosztorysanta od 3 dni | ostrzeżenie | Przypisz |
| Brak wartości wyceny na etapie ofertowym | ostrzeżenie | Wpisz wartość |
| Zaległy zaplanowany kontakt | ostrzeżenie | Otwórz kontakty |

Akcje „Poproś o…” generują gotową treść wiadomości i zostawiają ją w stanie
„do wysłania” — wysyłkę zatwierdza człowiek.

### Pulsowanie

Trzy stany, żadnego więcej. Gdyby migało cokolwiek jeszcze, przestałoby to
cokolwiek znaczyć.

- **niebieski** — nowe zapytanie, którego nikt nie otworzył ani nie przydzielił;
  gaśnie po kliknięciu w kartę lub przeciągnięciu jej do kosztorysanta,
- **bursztynowy** — do terminu dostawy zostało 6–14 dni,
- **czerwony** — 5 dni i mniej albo termin już minął; wygrywa z niebieskim,
  bo czerwień musi wygrywać z zaproszeniem do pracy.

Przy ustawieniu systemowym „ogranicz animacje” pulsowanie zamienia się w stałą
obwódkę w tym samym kolorze — sygnał zostaje, ruch znika.

### Pilność jest liczona, nie wpisywana

Kropka w lewym górnym rogu wynika z terminu, wieku sprawy bez przypisania
i wagi wyceny (`pilnosc()`). Ręczne pole priorytetu w takich systemach po
miesiącu przestaje odpowiadać rzeczywistości, bo nikt go nie aktualizuje.
Jeśli pilność ma być decyzją człowieka, wystarczy dodać pole do
`CrmRequestSchema` i podmienić jedno wywołanie w `BoardCard.tsx`.

### Panel szczegółów

Wysuwa się z prawej krawędzi (Escape zamyka), bo praca na tablicy jest ciągła:
sprawdzam kartę, poprawiam wartość, wracam do przeciągania. Przeładowanie
widoku gubiłoby kontekst i pozycję przewinięcia.

Zawiera: szynę etapów z notatką osobną dla każdego etapu, klienta z listy
rozwijanej, jego dane kontaktowe w wyszarzonym boksie, adres budowy,
załączniki, datę wpłynięcia obok terminu dostawy, wartość wyceny, suwak
pewności wygranej, project managera, kosztorysanta, notatki ogólne oraz
zakładki „Wiadomości” i „Historia”.

**Podział na edytowalne i nieedytowalne jest celowy.** Wszystko, co należy do
SPRAWY, zmienia się w miejscu. Dane KLIENTA są tylko do odczytu — należą do
kartoteki i poprawione stąd rozjechałyby się z pozostałymi zapytaniami tego
samego klienta. Zmienić można natomiast to, KTÓRY klient jest przypisany do
sprawy. Adres budowy jest edytowalny, bo należy do zapytania, nie do klienta.

---

## 4. Co jest mockiem

| Element | Stan | Gdzie |
|---|---|---|
| Skrzynka pocztowa | atrapa, 9 wiadomości w kodzie | `api/src/crm/mock-mailbox.ts` |
| Wysyłka wiadomości | zapis do pamięci, znacznik „wysłano” | `api/src/crm/messages.ts` |
| Klasyfikacja | reguły słownikowe, bez uczenia maszynowego | `api/src/crm/classify.ts` |
| Ekstrakcja danych | wyrażenia regularne | `api/src/crm/extract.ts` |
| Baza danych | tablice w pamięci procesu | `api/src/crm/store.ts` |
| Załączniki | metadane (nazwa, rozmiar, rodzaj), bez plików | — |
| Uwierzytelnianie | rola z nagłówka, jak w reszcie demo | `api/src/routes.ts` |

Wszystko poza tą tabelą jest prawdziwe: walidacja, przejścia etapów, historia
aktywności, wykrywanie duplikatów, ocena kompletności, filtrowanie, sortowanie.

---

## 5. Podłączenie prawdziwej poczty

Cały kontakt ze światem zewnętrznym przechodzi przez jeden interfejs:

```ts
export interface MailboxAdapter {
  readonly name: string;
  fetchNew(known: Set<string>): Promise<RawMail[]>;
}
```

Kroki:

1. `npm i imapflow mailparser -w @demo-erp/api`
2. Napisz `ImapMailboxAdapter` w nowym pliku `api/src/crm/imap-mailbox.ts`:
   połącz się, pobierz wiadomości nowsze niż ostatnie sprawdzenie, sparsuj
   `mailparser`em, odfiltruj te, których `messageId` jest już w `known`,
   zwróć tablicę `RawMail`. Pole `deliverAfterSec` pomiń.
3. W `api/src/crm/mailbox.ts` podmień ostatnią linię:

   ```ts
   export const mailboxAdapter: MailboxAdapter =
     process.env.IMAP_HOST ? new ImapMailboxAdapter() : new MockMailboxAdapter();
   ```

4. Załączniki: dziś zapisywane są same metadane. Dołóż zapis treści do storage
   i uzupełnij `CrmAttachment.url`.
5. Wysyłka: w `messages.ts` funkcja `wyslijMock()` ma opisany punkt podmiany —
   wprowadź interfejs `MailSender` i implementację na `nodemailer`.
   Sygnatura i historia aktywności zostają bez zmian.
6. Trwałość: `store.ts` to tablice `crmRequests`, `crmEmployees`, `crmMessages`.
   Zamiana na repozytorium bazodanowe dotyka wyłącznie tego pliku i miejsc,
   gdzie `routes.ts` sięga do tablic — schematy Zod z `shared` nadają się na
   definicje tabel bez przepisywania.

Interfejs użytkownika nie wymaga żadnej zmiany na żadnym z tych kroków.

---

## 6. Przyjęte założenia i świadome uproszczenia

- Kompletność i podpowiedź scoringu liczone funkcjami czystymi, a nie
  przechowywane — dwa źródła prawdy zawsze się w końcu rozjeżdżają.
- Przydzielanie opiekuna zastrzeżone dla kierownika, przez analogię do
  zatwierdzania dokumentów MM (`ERR-3001`) w module magazynowym.
- Upuszczenie karty na „Przegrane” otwiera okno przyczyny zamiast odrzucić
  operację — odmowa po wykonanym geście byłaby wrogim zachowaniem.
- Tablica ma alternatywę klawiaturową: karta jest przyciskiem (Enter otwiera
  panel), a zmiana kosztorysanta w panelu przenosi kartę do jego kolumny. Samo
  przeciąganie myszą wykluczałoby część użytkowników.
- Dane klienta są tylko do odczytu z poziomu zapytania — edycja kartoteki to
  osobny ekran, poza zakresem tej wersji.
- Brak realnego przesyłania plików — załączniki to metadane.
- Dane demo obejmują 12 zapytań i 12 klientów: wszystkie etapy, scoring 15–95%,
  komplet i braki danych, przegrane z różnymi przyczynami, follow-upy
  przeterminowane, dzisiejsze i przyszłe, oraz pełny zestaw sygnałów tablicy —
  karta z terminem za 3 dni (czerwone pulsowanie), dwie z terminem w granicach
  dwóch tygodni (bursztyn) i trzy nietknięte w „Nowych” (niebieski).
