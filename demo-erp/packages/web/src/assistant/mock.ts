/**
 * mock.ts — atrapa backendu asystenta.
 *
 * Dopasowanie po słowach kluczowych, zero AI. Istnieje po to, żeby oddzielić
 * klasy problemów: dopóki odpowiedź jest natychmiastowa i deterministyczna,
 * każda usterka, którą zobaczysz, jest na pewno usterką interfejsu, a nie
 * modelu, wyszukiwania czy sieci.
 *
 * Kotwice (`anchor`) to prawdziwe data-assistant-id z UI — zweryfikowane
 * względem komponentów. Dzięki temu w kroku 4 podświetlanie zadziała
 * bez zmiany danych.
 *
 * W kroku 3 podmienimy implementację `askAssistant` w client.ts;
 * ten plik zostanie jako fallback offline i materiał do testów.
 */

import type { AssistantReply } from "@demo-erp/shared";

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
        { text: "Przejdź do Dokumenty w menu bocznym", anchor: "nav.documents" },
        { text: "Kliknij Nowy dokument", anchor: "btn.document-new" },
        { text: "W polu Typ dokumentu wybierz PZ — Przyjęcie zewnętrzne", anchor: "field.document-type" },
        {
          text: "W polu Dostawca wybierz kontrahenta, od którego przyjmujesz towar",
          anchor: "field.counterparty",
          note: "Pole jest wymagane dla PZ i WZ, przy MM jest nieaktywne",
        },
        { text: "W sekcji Magazyny wybierz Magazyn docelowy", anchor: "field.warehouse-to" },
        { text: "Przejdź na zakładkę Pozycje", anchor: "tab.lines" },
        {
          text: "Kliknij Dodaj pozycję, wybierz produkt, wpisz ilość i cenę",
          anchor: "btn.line-add",
          note: "Cena podpowiada się z kartoteki produktu",
        },
        { text: "Kliknij Zatwierdź dokument", anchor: "btn.document-confirm" },
      ],
      sources: ["proc.magazyn.przyjecie-pz"],
    },
  },
  {
    keywords: ["stan", "ile mam", "zapas", "minimum", "czerwon", "brakuje", "braki"],
    reply: {
      text: "Aktualne stany znajdziesz w widoku Stany magazynowe. Ilość podświetlona na czerwono oznacza stan poniżej minimum zdefiniowanego dla produktu.",
      steps: [
        { text: "Przejdź do Stany magazynowe w menu bocznym", anchor: "nav.stock" },
        { text: "Wpisz indeks lub nazwę produktu w pole wyszukiwania", anchor: "field.filter-search" },
        {
          text: "Aby zobaczyć tylko braki, zaznacz filtr tylko poniżej minimum",
          anchor: "field.filter-low",
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
        { text: "Przejdź do Dokumenty i kliknij Nowy dokument", anchor: "btn.document-new" },
        { text: "W polu Typ dokumentu wybierz MM — Przesunięcie międzymagazynowe", anchor: "field.document-type" },
        { text: "W sekcji Magazyny wybierz Magazyn źródłowy", anchor: "field.warehouse-from" },
        {
          text: "Wybierz inny Magazyn docelowy",
          anchor: "field.warehouse-to",
          note: "Pole Kontrahent jest przy MM nieaktywne — to normalne",
        },
        { text: "Na zakładce Pozycje dodaj pozycje i kliknij Zapisz szkic", anchor: "btn.document-save" },
        {
          text: "Jako kierownik otwórz szkic i kliknij Zatwierdź dokument",
          anchor: "btn.document-confirm",
          note: "Rolę zmienisz w panelu bocznym w polu Kontekst uprawnień",
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
