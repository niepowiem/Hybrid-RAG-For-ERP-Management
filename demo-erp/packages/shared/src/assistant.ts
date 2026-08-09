/**
 * assistant.ts — kontrakt komunikacji z asystentem AI.
 *
 * Jedna struktura obsługuje trzy tryby konsumpcji:
 *   - czat czyta `text` i `steps[].text`,
 *   - podświetlanie czyta `steps[].anchor`,
 *   - autopilot czyta `steps[].action`.
 * Dzięki temu nie mogą się rozjechać — nie ma trzech niezależnych
 * ścieżek danych, tylko jedna z trzema odbiorcami.
 *
 * Pola `action` i `context` są w kontrakcie od początku, mimo że wypełnimy
 * je dopiero w kolejnych krokach. Pole opcjonalne dodane teraz to później
 * wypełnienie wartości; pole dodane później to zmiana kontraktu i przeróbka
 * wszystkich konsumentów.
 */

/** Co autopilot ma fizycznie zrobić z elementem. Używane od kroku 5. */
export type AssistantAction =
  | { kind: "navigate"; route: string }
  | { kind: "click"; anchor: string }
  | { kind: "fill"; anchor: string; value: string }
  /**
   * Osobno od `fill`, bo przy <select> model zna etykietę ("Magazyn główny"),
   * a nie wartość techniczną ("w-1"). Mapowanie etykiety na opcję robi front,
   * który jako jedyny ma dostęp do aktualnej listy opcji.
   */
  | { kind: "select"; anchor: string; label: string };

export interface AssistantStep {
  /** Tekst kroku — dosłownie z korpusu wiedzy, nie generowany przez model. */
  text: string;
  /** data-assistant-id elementu w UI. Cel podświetlenia i akcji. */
  anchor?: string;
  /** Wypełniane od kroku 5. Wcześniej zawsze puste. */
  action?: AssistantAction;
  /** Uwaga poboczna, np. warunek stosowania kroku. */
  note?: string;
}

export interface AssistantReply {
  /** Zdanie wprowadzające albo pełna odpowiedź na pytanie o pojęcie. */
  text: string;
  /** Kroki procedury. Puste przy odpowiedziach wyjaśniających i odmowach. */
  steps: AssistantStep[];
  /** Identyfikatory dokumentów korpusu, na których oparta jest odpowiedź. */
  sources: string[];
  /**
   * Asystent świadomie nie zna odpowiedzi. To poprawny wynik, nie awaria —
   * odmowa jest zawsze lepsza niż wymyślona procedura.
   */
  refused: boolean;
}

export interface AssistantRequest {
  question: string;
  /** Stan UI: ekran, pola formularza, ostatni błąd. Wypełniamy w kroku 2. */
  context?: Record<string, unknown>;
}
