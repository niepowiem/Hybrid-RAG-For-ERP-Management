/**
 * crm/format.ts — formatowanie dat i etykiet w module CRM.
 *
 * Osobno od komponentów, bo tych samych funkcji używają dashboard, lista,
 * tablica i kalendarz — a rozjazd w formacie daty między widokami wygląda
 * w systemie ERP na błąd danych, nie na drobiazg stylistyczny.
 */

import { CRM_STAGES, dzisiajISO } from "@demo-erp/shared";
import type { CrmFollowUp, CrmRequest, CrmStage } from "@demo-erp/shared";

export const dataPL = (iso: string | null | undefined): string =>
    iso == null || iso === "" ? "—" : iso.slice(0, 10).split("-").reverse().join(".");

export const dataGodzinaPL = (iso: string | null | undefined): string => {
  if (iso == null || iso === "") return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return dataPL(iso);
  return d.toLocaleString("pl-PL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

/** Różnica w dniach względem dziś: ujemna = przeszłość. */
export function dniOdDzis(dataISO: string): number {
  const dzis = Date.parse(`${dzisiajISO()}T00:00:00Z`);
  const cel = Date.parse(`${dataISO.slice(0, 10)}T00:00:00Z`);
  return Math.round((cel - dzis) / 86_400_000);
}

/** „dziś”, „jutro”, „za 3 dni”, „5 dni po terminie”. */
export function terminOpis(dataISO: string): string {
  const d = dniOdDzis(dataISO);
  if (d === 0) return "dziś";
  if (d === 1) return "jutro";
  if (d === -1) return "wczoraj";
  return d > 0 ? `za ${d} dni` : `${Math.abs(d)} dni po terminie`;
}

/** Sygnał na liście: pilne, przeterminowane, spokojne. */
export function poziomTerminu(dataISO: string): "d" | "w" | "o" {
  const d = dniOdDzis(dataISO);
  if (d < 0) return "d";
  if (d <= 2) return "w";
  return "o";
}

export const czasWzgledny = (iso: string | null): string => {
  if (iso == null) return "brak kontaktu";
  const dni = Math.round((Date.now() - Date.parse(iso)) / 86_400_000);
  if (dni <= 0) return "dziś";
  if (dni === 1) return "wczoraj";
  return `${dni} dni temu`;
};

/** Kolejność etapów — używane przy sortowaniu listy i układzie tablicy. */
export const indeksEtapu = (s: CrmStage): number => CRM_STAGES.indexOf(s);

export const otwarteFollowUpy = (r: CrmRequest): CrmFollowUp[] =>
    r.followUps.filter((f) => f.status === "planned" || f.status === "overdue");

export const maPrzeterminowany = (r: CrmRequest): boolean =>
    otwarteFollowUpy(r).some((f) => f.date < dzisiajISO());