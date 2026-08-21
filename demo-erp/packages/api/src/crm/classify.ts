/**
 * classify.ts — klasyfikacja pobranej wiadomości.
 *
 * Dwie kategorie: „Zapytanie ofertowe” albo „Pozostała wiadomość”.
 * Podstawową decyzję podejmuje binarny klasyfikator stacking na DGX Spark.
 * Reguły lokalne są wyłącznie diagnostycznym fallbackiem: ich użycie zawsze
 * kieruje wiadomość do ręcznej weryfikacji.
 */

import type { MailCategory } from "@demo-erp/shared";
import {
  classifyWithDgx,
  DgxClassifierError,
  isDgxClassifierConfigured,
} from "./ai-gateway.js";

export interface ClassificationResult {
  category: MailCategory;
  /** 0–1, do pokazania „na ile system jest pewny”. */
  confidence: number;
  /** Trafione przesłanki — pokazywane w szczegółach wiadomości. */
  reasons: string[];
  source: "dgx" | "heuristic";
  threshold: number | null;
  modelName: string | null;
  modelVersion: string | null;
  latencyMs: number;
  usedFallback: boolean;
  fallbackReason: string | null;
}

/** Frazy przemawiające za zapytaniem ofertowym; waga w drugim polu. */
const ZA: [string, number][] = [
  ["zapytanie ofertowe", 4],
  ["rfq", 4],
  ["prośba o wycenę", 4],
  ["prosze o wycene", 3],
  ["proszę o wycenę", 3],
  ["proszę o ofertę", 3],
  ["prosimy o ofertę", 3],
  ["prosimy o wycenę", 3],
  ["zapytanie o cenę", 3],
  ["zapytanie", 2],
  ["wycena", 2],
  ["oferta", 1],
  ["cena", 1],
  ["dostępność", 1],
  ["termin realizacji", 2],
  ["ilość", 1],
  ["szt.", 1],
  ["kpl", 1],
];

/** Frazy przemawiające przeciw — korespondencja obsługowa i marketing. */
const PRZECIW: [string, number][] = [
  ["newsletter", 5],
  ["subskrypcj", 4],
  ["promocja", 3],
  ["rabaty", 2],
  ["potwierdzamy zapłatę", 5],
  ["potwierdzenie płatności", 5],
  ["faktura", 3],
  ["przelew", 3],
  ["szkolen", 3],
  ["przedstawić naszą ofertę", 4],
  ["reprezentuję firmę", 3],
  ["współprac", 1],
];

const norm = (s: string): string => s.toLowerCase();

export function classifyMailHeuristic(subject: string, body: string): ClassificationResult {
  const started = performance.now();
  // Temat waży podwójnie: to on niesie intencję nadawcy.
  const t = norm(subject);
  const b = norm(body);

  let punkty = 0;
  const reasons: string[] = [];

  for (const [fraza, waga] of ZA) {
    const wT = t.includes(fraza) ? waga * 2 : 0;
    const wB = b.includes(fraza) ? waga : 0;
    if (wT + wB > 0) {
      punkty += wT + wB;
      reasons.push(`fraza „${fraza}”${wT > 0 ? " w temacie" : ""}`);
    }
  }
  for (const [fraza, waga] of PRZECIW) {
    const wT = t.includes(fraza) ? waga * 2 : 0;
    const wB = b.includes(fraza) ? waga : 0;
    if (wT + wB > 0) {
      punkty -= wT + wB;
      reasons.push(`fraza wykluczająca „${fraza}”`);
    }
  }

  const category: MailCategory = punkty >= 4 ? "inquiry" : "other";
  const confidence = Math.min(1, Math.abs(punkty) / 12);

  return {
    category,
    confidence,
    reasons: reasons.slice(0, 5),
    source: "heuristic",
    threshold: null,
    modelName: "Reguły lokalne",
    modelVersion: null,
    latencyMs: performance.now() - started,
    usedFallback: false,
    fallbackReason: null,
  };
}

/**
 * Pierwszy etap pipeline'u: model stacking na DGX, z regułami jako
 * bezpiecznym fallbackiem. Awaria DGX nie zatrzymuje pobierania poczty, ale
 * wynik jest jawnie oznaczony i status połączenia pozostaje widoczny w UI.
 */
export async function classifyMail(
    subject: string,
    body: string,
    context: { messageId: string; attachments: string[] },
): Promise<ClassificationResult> {
  if (!isDgxClassifierConfigured()) {
    const fallback = classifyMailHeuristic(subject, body);
    const fallbackReason = "Klasyfikator AI nie jest skonfigurowany.";
    return {
      ...fallback,
      reasons: [fallbackReason, ...fallback.reasons].slice(0, 5),
      usedFallback: true,
      fallbackReason,
    };
  }
  try {
    const result = await classifyWithDgx({ subject, body, ...context });
    return {
      category: result.category,
      confidence: result.confidence,
      reasons: [`model ${result.modelVersion}`],
      source: "dgx",
      threshold: result.threshold,
      modelName: result.modelName,
      modelVersion: result.modelVersion,
      latencyMs: result.latencyMs,
      usedFallback: false,
      fallbackReason: null,
    };
  } catch (error) {
    const fallback = classifyMailHeuristic(subject, body);
    const fallbackReason = error instanceof DgxClassifierError
        ? error.message
        : "Klasyfikator DGX zwrócił nieoczekiwany błąd.";
    return {
      ...fallback,
      reasons: [fallbackReason, ...fallback.reasons].slice(0, 5),
      usedFallback: true,
      fallbackReason,
    };
  }
}
