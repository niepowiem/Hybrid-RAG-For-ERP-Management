/**
 * mock.ts — atrapa backendu asystenta.
 *
 * Dopasowanie po słowach kluczowych, zero AI. Istnieje po to, żeby oddzielić
 * klasy problemów: dopóki odpowiedź jest natychmiastowa i deterministyczna,
 * każda usterka, którą zobaczysz, jest na pewno usterką interfejsu, a nie
 * modelu, wyszukiwania czy sieci.
 *
 * Kotwice (`anchor`) to prawdziwe data-assistant-id z UI — zweryfikowane
 * względem komponentów.
 *
 * Atrapa MUSI pokrywać wszystkie pola kontraktu (`why`, akcje `ask`, plan
 * naprawczy). Inaczej nowych funkcji nie da się rozwijać offline i wychodzą
 * dopiero na integracji z backendem.
 */

import type { AssistantReply, AssistantStep } from "@demo-erp/shared";

interface MockCase {
  /** Wystarczy jedno trafienie, żeby przypadek zadziałał. */
  keywords: string[];
  reply: Omit<AssistantReply, "refused">;
}

const CASES: MockCase[] = [
  {
    keywords: ["przyj", "pz", "dostaw", "przywioz", "przyjecie", "przyjęcie"],
    reply: {
      text: "Aby przyjąć towar na magazyn, wystaw dokument PZ i zatwierdź go.",
      steps: [
        {
          text: "Przejdź do Dokumenty w menu bocznym",
          anchor: "nav.documents",
          why: "Wszystkie dokumenty magazynowe — PZ, WZ i MM — powstają w tym jednym miejscu.",
          action: { kind: "click", anchor: "nav.documents" },
        },
        {
          text: "Kliknij Nowy dokument",
          anchor: "btn.document-new",
          why: "Otwiera pusty formularz. Numer dokument dostanie dopiero po zapisaniu.",
          action: { kind: "click", anchor: "btn.document-new" },
        },
        {
          text: "W polu Typ dokumentu wybierz PZ — Przyjęcie zewnętrzne",
          anchor: "field.document-type",
          why: "Typ decyduje, czy dokument zwiększy czy zmniejszy stan magazynu.",
          note: "Po zapisaniu typu nie da się zmienić",
          action: { kind: "select", anchor: "field.document-type", label: "PZ" },
        },
        {
          text: "W polu Dostawca wybierz kontrahenta, od którego przyjmujesz towar",
          anchor: "field.counterparty",
          note: "Pole jest wymagane dla PZ i WZ, przy MM jest nieaktywne",
          action: {
            kind: "ask",
            anchor: "field.counterparty",
            inputType: "select",
            label: "Od którego dostawcy przyjmujesz towar?",
            hint: "Lista pokazuje tylko dostawców — odbiorcy są ukryci.",
          },
        },
        {
          text: "W sekcji Magazyny wybierz Magazyn docelowy",
          anchor: "field.warehouse-to",
          why: "Magazyn docelowy to miejsce, na którym wzrośnie stan po zatwierdzeniu.",
          action: {
            kind: "ask",
            anchor: "field.warehouse-to",
            inputType: "select",
            label: "Na który magazyn przyjmujesz towar?",
          },
        },
        {
          text: "Przejdź na zakładkę Pozycje",
          anchor: "tab.lines",
          why: "Nagłówek opisuje dokument, a pozycje mówią, jaki towar i ile go przyjmujesz.",
          action: { kind: "click", anchor: "tab.lines" },
        },
        {
          text: "Kliknij Dodaj pozycję",
          anchor: "btn.line-add",
          action: { kind: "click", anchor: "btn.line-add" },
        },
        {
          text: "Wpisz przyjmowaną ilość",
          anchor: "field.line-quantity",
          why: "Ilość wprost przekłada się na stan magazynowy po zatwierdzeniu.",
          note: "Cena podpowiada się z kartoteki produktu",
          action: {
            kind: "ask",
            anchor: "field.line-quantity",
            inputType: "number",
            label: "Ile sztuk przyjmujesz?",
            hint: "Ilość w jednostce z kartoteki produktu.",
          },
        },
        {
          text: "Kliknij Zatwierdź dokument",
          anchor: "btn.document-confirm",
          why: "Dopiero zatwierdzenie zmienia stany. Szkic można jeszcze poprawić.",
          action: { kind: "click", anchor: "btn.document-confirm" },
        },
      ],
      sources: ["proc.magazyn.przyjecie-pz"],
    },
  },
  {
    keywords: ["stan", "ile mam", "zapas", "minimum", "czerwon", "brakuje", "braki"],
    reply: {
      text: "Aktualne stany znajdziesz w widoku Stany magazynowe. Ilość podświetlona na czerwono oznacza stan poniżej minimum zdefiniowanego dla produktu.",
      steps: [
        {
          text: "Przejdź do Stany magazynowe w menu bocznym",
          anchor: "nav.stock",
          why: "Stan liczony jest z zatwierdzonych dokumentów — to widok, nie osobna kartoteka.",
          action: { kind: "click", anchor: "nav.stock" },
        },
        {
          text: "Wpisz indeks lub nazwę produktu w pole wyszukiwania",
          anchor: "field.filter-search",
          action: {
            kind: "ask",
            anchor: "field.filter-search",
            inputType: "text",
            label: "Którego produktu szukasz?",
            hint: "Wpisz indeks (np. SR-M8-100) albo fragment nazwy.",
          },
        },
        {
          text: "Aby zobaczyć tylko braki, zaznacz filtr tylko poniżej minimum",
          anchor: "field.filter-low",
          why: "Filtr pokazuje wyłącznie pozycje wymagające uzupełnienia zapasu.",
          action: { kind: "click", anchor: "field.filter-low" },
        },
      ],
      sources: ["proc.magazyn.sprawdzenie-stanu", "concept.stan-magazynowy"],
    },
  },
  {
    keywords: ["mm", "przesun", "przesuń", "transfer", "miedzymagazyn", "międzymagazyn"],
    reply: {
      text: "Przesunięcie międzymagazynowe wystawia się dokumentem MM. Magazyny źródłowy i docelowy muszą być różne, a zatwierdzić dokument może wyłącznie kierownik.",
      steps: [
        {
          text: "Przejdź do Dokumenty i kliknij Nowy dokument",
          anchor: "btn.document-new",
          action: { kind: "click", anchor: "btn.document-new" },
        },
        {
          text: "W polu Typ dokumentu wybierz MM — Przesunięcie międzymagazynowe",
          anchor: "field.document-type",
          action: { kind: "select", anchor: "field.document-type", label: "MM" },
        },
        {
          text: "W sekcji Magazyny wybierz Magazyn źródłowy",
          anchor: "field.warehouse-from",
          action: {
            kind: "ask",
            anchor: "field.warehouse-from",
            inputType: "select",
            label: "Z którego magazynu przesuwasz towar?",
          },
        },
        {
          text: "Wybierz inny Magazyn docelowy",
          anchor: "field.warehouse-to",
          note: "Pole Kontrahent jest przy MM nieaktywne — to normalne",
          why: "Magazyny muszą być różne, inaczej system odrzuci dokument błędem ERR-1005.",
          action: {
            kind: "ask",
            anchor: "field.warehouse-to",
            inputType: "select",
            label: "Na który magazyn przesuwasz towar?",
            hint: "Musi być inny niż magazyn źródłowy.",
          },
        },
        {
          text: "Na zakładce Pozycje dodaj pozycje i kliknij Zapisz szkic",
          anchor: "btn.document-save",
          action: { kind: "click", anchor: "btn.document-save" },
        },
        {
          text: "Jako kierownik otwórz szkic i kliknij Zatwierdź dokument",
          anchor: "btn.document-confirm",
          note: "Rolę zmienisz w panelu bocznym w polu Kontekst uprawnień",
          why: "MM zatwierdza wyłącznie kierownik — magazynier dostanie ERR-3001.",
          action: { kind: "click", anchor: "btn.document-confirm" },
        },
      ],
      sources: ["proc.magazyn.przesuniecie-mm", "ERR-3001"],
    },
  },
  {
    // Odpowiedź wyjaśniająca — bez kroków. Sprawdza, czy czat poprawnie
    // renderuje sam tekst, bez listy numerowanej.
    keywords: ["err-3001", "3001", "kierownik", "uprawnien", "uprawnień", "nie moge zatwierdzic", "nie mogę zatwierdzić"],
    reply: {
      text: "Błąd ERR-3001 oznacza, że przesunięcia międzymagazynowe (MM) może zatwierdzać wyłącznie kierownik. Dokument pozostaje w statusie Szkic — nic nie przepadło. Poproś kierownika o zatwierdzenie albo zmień kontekst uprawnień w panelu bocznym.",
      steps: [],
      sources: ["ERR-3001", "concept.role-magazynowe"],
    },
  },
];

/**
 * Kroki naprawcze zwracane przez atrapę na dowolny kod błędu.
 * Prawdziwy backend dobiera je do konkretnego kodu przez graf.
 */
const RECOVERY_STEPS: AssistantStep[] = [
  {
    text: "Przejdź do Stany magazynowe w menu bocznym",
    anchor: "nav.stock",
    why: "Zanim poprawimy dokument, sprawdzamy, ile towaru faktycznie jest na stanie.",
    action: { kind: "click", anchor: "nav.stock" },
  },
  {
    text: "Wpisz indeks lub nazwę produktu w pole wyszukiwania",
    anchor: "field.filter-search",
    action: {
      kind: "ask",
      anchor: "field.filter-search",
      inputType: "text",
      label: "Którego produktu dotyczy problem?",
      hint: "Wpisz indeks (np. SR-M8-100) albo fragment nazwy.",
    },
  },
];

const REFUSAL =
    "Nie mam tego w dokumentacji, którą obejmuje prototyp. Znam moduł magazynowy: przyjęcia PZ, wydania WZ, przesunięcia MM, stany magazynowe i kartoteki. Spróbuj zapytać o jedną z tych rzeczy.";

/** Normalizacja: małe litery bez polskich znaków — użytkownik i tak pisze różnie. */
function normalize(s: string): string {
  return s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
}

export async function askMock(question: string): Promise<AssistantReply> {
  // Opóźnienie tylko dla realizmu interfejsu — chcemy zobaczyć wskaźnik
  // pisania i sprawdzić, czy blokada pola działa.
  await new Promise((r) => setTimeout(r, 550 + Math.random() * 350));

  const q = normalize(question);
  const hit = CASES.find((c) => c.keywords.some((k) => q.includes(normalize(k))));

  if (!hit) {
    return { text: REFUSAL, steps: [], sources: [], refused: true };
  }
  return { ...hit.reply, refused: false };
}

/** Plan naprawczy w trybie atrapy. Zawsze ten sam, niezależnie od kodu błędu. */
export async function recoverMock(_code: string): Promise<AssistantStep[]> {
  await new Promise((r) => setTimeout(r, 400));
  return RECOVERY_STEPS;
}