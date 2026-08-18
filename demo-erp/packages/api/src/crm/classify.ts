/**
 * classify.ts — klasyfikacja pobranej wiadomości.
 *
 * Dwie kategorie: „Zapytanie ofertowe” albo „Pozostała wiadomość”.
 * W wersji demonstracyjnej decyduje prosty licznik słów kluczowych — jawny,
 * powtarzalny i możliwy do wytłumaczenia użytkownikowi. To miejsce jest
 * przygotowane pod podmianę na model językowy: sygnatura funkcji przyjmuje
 * temat i treść, a zwraca kategorię wraz z uzasadnieniem, więc panel
 * wiadomości nie zmieni się ani o linijkę.
 */

import type { MailCategory } from "@demo-erp/shared";

export interface ClassificationResult {
  category: MailCategory;
  /** 0–1, do pokazania „na ile system jest pewny”. */
  confidence: number;
  /** Trafione przesłanki — pokazywane w szczegółach wiadomości. */
  reasons: string[];
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

export function classifyMail(subject: string, body: string): ClassificationResult {
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

  return { category, confidence, reasons: reasons.slice(0, 5) };
}