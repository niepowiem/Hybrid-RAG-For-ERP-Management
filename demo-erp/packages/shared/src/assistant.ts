/**
 * assistant.ts — kontrakt komunikacji z asystentem AI.
 *
 * Jedna struktura obsługuje cztery tryby konsumpcji:
 *   - czat czyta `text` i `steps[].text`,
 *   - podświetlanie czyta `steps[].anchor`,
 *   - autopilot czyta `steps[].action`,
 *   - narracja czyta `steps[].why`.
 * Dzięki temu nie mogą się rozjechać — nie ma czterech niezależnych
 * ścieżek danych, tylko jedna z czterema odbiorcami.
 *
 * Pole opcjonalne dodane teraz to później wypełnienie wartości; pole dodane
 * później to zmiana kontraktu i przeróbka wszystkich konsumentów.
 */

/** Typ pola, o które autopilot pyta użytkownika. Steruje kontrolką w dymku. */
export type AssistantInputType = "text" | "number" | "date" | "select";

/** Co autopilot ma fizycznie zrobić z elementem. */
export type AssistantAction =
    | { kind: "navigate"; route: string }
    | { kind: "click"; anchor: string }
    | { kind: "fill"; anchor: string; value: string }
    /**
     * Osobno od `fill`, bo przy <select> model zna etykietę ("Magazyn główny"),
     * a nie wartość techniczną ("w-1"). Mapowanie etykiety na opcję robi front,
     * który jako jedyny ma dostęp do aktualnej listy opcji.
     */
    | { kind: "select"; anchor: string; label: string }
    /**
     * Autopilot ZATRZYMUJE SIĘ i pyta użytkownika o wartość, zamiast wpisywać
     * ustaloną. Używane wszędzie, gdzie wartość zależy od użytkownika: ilość,
     * numer faktury, wybór kontrahenta.
     *
     * Dla `inputType: "select"` lista opcji NIE jest częścią kontraktu — front
     * czyta ją z żywego <select> na stronie. Korpus wiedzy nie zna listy klientów
     * ani produktów i nie powinien jej znać.
     */
    /**
     * Czynność, której autopilot NIE MOŻE wykonać za użytkownika, bo wymaga jego
     * decyzji: który wiersz tabeli otworzyć, ile pozycji wpisać. Autopilot
     * podświetla element, tłumaczy, co zrobić, i CZEKA na "Kontynuuj".
     *
     * Bez tego takie kroki były po cichu pomijane, a procedura kończyła się
     * błędem walidacji, którego nikt nie umiał powiązać z pominiętym polem.
     */
    | { kind: "manual"; anchor: string; label: string; hint?: string }
    | {
  kind: "ask";
  anchor: string;
  inputType: AssistantInputType;
  /** Pytanie zadawane użytkownikowi, np. "Ile sztuk zamawiasz?". */
  label: string;
  /** Wyjaśnienie, czym jest to pole i jak je wypełnić. */
  hint?: string;
  /**
   * Propozycje wartości do kliknięcia, np. konwencja kodu ("DOS-003").
   *
   * Dla `inputType: "select"` NIE wypełniamy tego pola — opcje front czyta
   * z żywej listy na stronie. Dla dat front dokłada propozycje wyliczone
   * (dziś, za tydzień), bo te zależą od chwili, a nie od korpusu.
   */
  suggestions?: string[];
};

export interface AssistantStep {
  /**
   * Nieprzezroczysty identyfikator kroku w grafie. Front go nie interpretuje,
   * ale odsyła w historii — dzięki temu pytanie "co znaczy krok 4" trafia
   * na konkretny węzeł, a nie na dopasowanie po treści.
   */
  id?: string;
  /** Tekst kroku — dosłownie z korpusu wiedzy, nie generowany przez model. */
  text: string;
  /** data-assistant-id elementu w UI. Cel podświetlenia i akcji. */
  anchor?: string;
  /** Co autopilot ma zrobić. Krok bez akcji jest tylko podświetlany. */
  action?: AssistantAction;
  /** Uwaga poboczna, np. warunek stosowania kroku. */
  note?: string;
  /**
   * Po co jest ten krok. Autopilot pokazuje to PRZED wykonaniem akcji, żeby
   * użytkownik rozumiał, co się dzieje, zamiast tylko patrzeć na klikanie.
   * Tak jak `text`, pochodzi z korpusu — model tego nie pisze.
   */
  why?: string;
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

/**
 * Jedna tura rozmowy, odsyłana z powrotem przy kolejnym pytaniu.
 *
 * Historia jest BEZSTANOWA po stronie serwera: to front trzyma rozmowę
 * i dołącza ją do żądania. Dzięki temu backend może działać w wielu procesach,
 * a odświeżenie strony po prostu zaczyna rozmowę od nowa — bez osieroconych sesji.
 */
export interface AssistantTurn {
  question: string;
  /** Sama odpowiedź tekstowa, bez kroków. */
  text: string;
  /** Identyfikatory dokumentów korpusu, na których oparta była odpowiedź. */
  sources: string[];
  /** Kroki poprzedniego planu — po nich rozwiązujemy "wyjaśnij krok 4". */
  steps: { id?: string; text: string }[];
}

export interface AssistantRequest {
  question: string;
  /** Stan UI: ekran, pola formularza, ostatni błąd. */
  context?: Record<string, unknown>;
  /**
   * Poprzednie tury, od najstarszej. Pozwalają doprecyzować zadanie
   * ("nie, chodziło mi o WZ") i pytać o konkretny krok instrukcji.
   * Wysyłaj kilka ostatnich, nie całą rozmowę — każda tura to tokeny.
   */
  history?: AssistantTurn[];
}

/**
 * Żądanie planu naprawczego. Wysyłane przez autopilota, gdy po wykonaniu kroku
 * na ekranie pojawi się banner błędu.
 */
export interface AssistantRecoverRequest {
  /** Kod z bannera, np. "ERR-4001". */
  code: string;
  context?: Record<string, unknown>;
  /**
   * Która to próba naprawy TEGO kodu w bieżącym przebiegu. Serwer odmawia
   * powyżej limitu — inaczej naprawa wywołująca ten sam błąd zapętla się.
   */
  attempt?: number;
}