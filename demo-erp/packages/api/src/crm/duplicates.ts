/**
 * duplicates.ts — wykrywanie powtórzonych zapytań.
 *
 * Klient, który nie dostał odpowiedzi w dwa dni, wysyła to samo drugi raz —
 * i to jest normalne. Nienormalne byłoby założenie dwóch spraw w CRM
 * i dwie oferty na to samo. Dlatego przy podejrzeniu duplikatu system nie
 * tworzy zapytania z automatu, tylko odkłada wiadomość do weryfikacji
 * i pokazuje, z czym ją skojarzył.
 */

import { podobienstwo } from "@demo-erp/shared";
import type { CrmRequest, ExtractedData } from "@demo-erp/shared";

export interface DuplicateHit {
  requestId: string;
  number: string;
  /** 0–1; im wyżej, tym pewniej to samo zapytanie. */
  score: number;
  reasons: string[];
}

/** Powyżej tego progu wiadomość trafia do weryfikacji zamiast do CRM. */
export const PROG_DUPLIKATU = 0.6;

export function znajdzDuplikat(
    requests: CrmRequest[],
    dane: {
      fromEmail: string;
      subject: string;
      extracted: ExtractedData | null;
    },
): DuplicateHit | null {
  const kandydaci: DuplicateHit[] = [];

  for (const r of requests) {
    // Zapytania zamknięte dawno temu nie blokują nowej sprawy od tego samego
    // klienta — po wygranej czy przegranej kolejny mail to zwykle nowy temat.
    const wiek = (Date.now() - Date.parse(r.createdAt)) / 86_400_000;
    if ((r.stage === "won" || r.stage === "lost") && wiek > 14) continue;

    let score = 0;
    const reasons: string[] = [];

    if (r.email.toLowerCase() === dane.fromEmail.toLowerCase()) {
      score += 0.45;
      reasons.push("ten sam adres e-mail nadawcy");
    }

    const firma = dane.extracted?.companyName;
    if (firma) {
      const s = podobienstwo(firma, r.companyName);
      if (s > 0.7) {
        score += 0.25 * s;
        reasons.push(`podobna nazwa firmy (${Math.round(s * 100)}%)`);
      }
    }

    const opis = dane.extracted?.description ?? "";
    if (opis) {
      const s = podobienstwo(opis, r.description);
      if (s > 0.45) {
        score += 0.3 * s;
        reasons.push(`podobny opis zapytania (${Math.round(s * 100)}%)`);
      }
    }

    const s = podobienstwo(dane.subject, r.description);
    if (s > 0.4) {
      score += 0.2 * s;
      reasons.push(`temat zbieżny z opisem zapytania (${Math.round(s * 100)}%)`);
    }

    if (score > 0) {
      kandydaci.push({ requestId: r.id, number: r.number, score: Math.min(1, score), reasons });
    }
  }

  kandydaci.sort((a, b) => b.score - a.score);
  const najlepszy = kandydaci[0];
  return najlepszy && najlepszy.score >= PROG_DUPLIKATU ? najlepszy : null;
}