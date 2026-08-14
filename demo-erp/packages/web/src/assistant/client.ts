/**
 * client.ts — klient HTTP asystenta.
 *
 * Cienka warstwa nad fetch. Celowo NIE korzysta z `request()` z api.ts:
 * tamten na każdy błąd woła `zglosBlad()`, co zapisuje awarię do sondy
 * kontekstu. Gdyby asystent robił to samo, jego własny błąd sieciowy trafiłby
 * do kontekstu jako "ostatni błąd użytkownika" i przy następnym pytaniu
 * asystent zacząłby odpowiadać na swoją własną awarię.
 */

import type {
  AssistantRecoverRequest,
  AssistantReply,
  AssistantRequest,
  AssistantStep,
} from "@demo-erp/shared";
import { askMock, recoverMock } from "./mock.js";

/**
 * Zmienne środowiskowe Vite, odczytane bez zależności od typów `vite/client`.
 *
 * Rzutowanie zamiast `import.meta.env` wprost: gdy w projekcie nie ma
 * `/// <reference types="vite/client" />`, TypeScript zgłasza
 * "Property 'env' does not exist on type 'ImportMeta'". Rzutowanie działa
 * niezależnie od tego, czy referencja jest podpięta.
 */
const ENV: Record<string, string | undefined> =
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

/**
 * Ścieżki są WZGLĘDNE, bo vite.config.ts proxuje /assistant na localhost:8000.
 * Adres bezwzględny omijałby proxy i wpadał w CORS, a w produkcji wskazywałby
 * na maszynę dewelopera. Nadpisuj tylko wtedy, gdy backend stoi gdzie indziej.
 */
export const ASSISTANT_URL: string = ENV.VITE_ASSISTANT_URL ?? "";

/** Tryb atrapy: front działa bez uruchomionego backendu. */
export const USE_MOCK: boolean = ENV.VITE_ASSISTANT_MOCK === "1";

/** Odpowiedź awaryjna, gdy backend nie odpowiada. Front nigdy nie dostaje null. */
const BLAD_SIECI: AssistantReply = {
  text: "Nie mogę połączyć się z asystentem. Sprawdź, czy backend działa (uvicorn app.api_n:app --port 8000).",
  steps: [],
  sources: [],
  refused: true,
};

async function post<T>(sciezka: string, body: unknown, timeoutMs = 60_000): Promise<T | null> {
  // AbortController zamiast czekania w nieskończoność: przy zdalnym modelu
  // odpowiedź potrafi trwać kilkadziesiąt sekund, ale nie minuty.
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(`${ASSISTANT_URL}${sciezka}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      console.error(`Asystent: ${sciezka} zwróciło ${res.status}`);
      return null;
    }

    return (await res.json()) as T;
  } catch (e) {
    console.error(`Asystent: ${sciezka} nie odpowiedziało`, e);
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Pytanie użytkownika -> odpowiedź asystenta.
 *
 * @param question treść pytania
 * @param context wynik getAssistantContext() — im więcej wie asystent o sytuacji,
 *   tym krótszy plan pokaże (pomija kroki, które użytkownik już wykonał)
 */
export async function askAssistant(
    question: string,
    context: Record<string, unknown>,
): Promise<AssistantReply> {
  if (USE_MOCK) return askMock(question);

  const body: AssistantRequest = { question, context };
  const reply = await post<AssistantReply>("/assistant/ask", body);

  return reply ?? BLAD_SIECI;
}

/**
 * Plan naprawczy dla błędu napotkanego przez autopilota.
 *
 * Zwraca same kroki, bo tego potrzebuje driver. Odmowa (`refused`) i pusta
 * lista kroków są równoważne: autopilot ma się wtedy zatrzymać.
 *
 * @param attempt która to próba naprawy TEGO kodu — serwer odmawia powyżej
 *   limitu, żeby naprawa wywołująca ten sam błąd nie zapętliła się
 */
export async function recoverFromError(
    code: string,
    context: Record<string, unknown>,
    attempt: number,
): Promise<AssistantStep[] | null> {
  if (USE_MOCK) return recoverMock(code);

  const body: AssistantRecoverRequest = { code, context, attempt };

  // Krótszy timeout niż przy zwykłym pytaniu: autopilot stoi z zamrożonym
  // ekranem, więc długie czekanie wygląda jak zawieszenie aplikacji.
  const reply = await post<AssistantReply>("/assistant/recover", body, 30_000);

  if (!reply || reply.refused || reply.steps.length === 0) return null;

  return reply.steps;
}

/** Czy backend odpowiada i ile kroków ma w indeksie. Do diagnostyki w konsoli. */
export async function checkAssistant(): Promise<{ ok: boolean; steps?: number }> {
  if (USE_MOCK) return { ok: true };

  try {
    const res = await fetch(`${ASSISTANT_URL}/assistant/health`);
    if (!res.ok) return { ok: false };

    const data = (await res.json()) as { steps_indexed?: number };
    return { ok: true, steps: data.steps_indexed };
  } catch {
    return { ok: false };
  }
}