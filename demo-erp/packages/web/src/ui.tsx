/**
 * ui.tsx — drobne elementy wspólne: powiadomienia, pasek wypełnienia,
 * sortowanie kolumn.
 *
 * Powiadomienia bez kontekstu Reacta — mikroskopijna szyna zdarzeń wystarcza,
 * a każdy komponent może je wywołać jednym importem.
 */

import { useEffect, useState } from "react";

// ------------------------------ powiadomienia ------------------------------

export interface Toast { id: number; title: string; detail?: string; kind: "ok" | "err"; }

let toastId = 0;
const listeners = new Set<(t: Toast[]) => void>();
let toasts: Toast[] = [];

function emit(): void {
  for (const l of listeners) l([...toasts]);
}

export function notify(title: string, detail?: string, kind: "ok" | "err" = "ok"): void {
  const t: Toast = { id: ++toastId, title, detail, kind };
  toasts = [...toasts, t];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    emit();
  }, 4500);
}

export function Toasts() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    listeners.add(setItems);
    return () => { listeners.delete(setItems); };
  }, []);
  if (items.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind === "err" ? "err" : ""}`}>
          <div className="t">{t.title}</div>
          {t.detail && <div className="d">{t.detail}</div>}
        </div>
      ))}
    </div>
  );
}

// --------------------------- pasek wypełnienia -----------------------------

/**
 * Komórka z ilością i paskiem tła pokazującym pokrycie względem minimum.
 * Minimum wypada w połowie szerokości i jest oznaczone kreską — dzięki temu
 * jednym rzutem oka widać, czy pozycja jest pod progiem, tuż nad nim,
 * czy z zapasem. Kolor wyłącznie semantyczny, nigdy akcentowy.
 */
export function QuantityBar({ value, min, unit }: { value: number; min: number; unit?: string }) {
  const scale = Math.max(min * 2, value, 1);
  const pct = Math.min((value / scale) * 100, 100);
  const minPct = Math.min((min / scale) * 100, 100);
  const level: "d" | "w" | "o" = value < min ? "d" : value < min * 1.25 ? "w" : "o";
  const title =
    level === "d" ? `Poniżej minimum (${min}${unit ? " " + unit : ""})`
    : level === "w" ? `Blisko minimum (${min}${unit ? " " + unit : ""})`
    : `Powyżej minimum (${min}${unit ? " " + unit : ""})`;

  return (
    <td className="num mono bar-cell" title={title}>
      <span className={`fill ${level}`} style={{ width: `${pct}%` }} />
      {min > 0 && <span className="min-mark" style={{ left: `${minPct}%` }} />}
      <span className={`v ${level}`}>{value}</span>
    </td>
  );
}

// ------------------------------- sortowanie --------------------------------

export type SortDir = "asc" | "desc";
export interface SortState { key: string; dir: SortDir; }

export function useSort(initial: SortState) {
  const [sort, setSort] = useState<SortState>(initial);
  const toggle = (key: string): void =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  return { sort, toggle };
}

export function SortTh({
  label, sortKey, sort, toggle, num,
}: { label: string; sortKey: string; sort: SortState; toggle: (k: string) => void; num?: boolean }) {
  const active = sort.key === sortKey;
  return (
    <th
      className={`sortable ${num ? "num" : ""} ${active ? "sorted" : ""}`}
      onClick={() => toggle(sortKey)}
      title="Kliknij, aby sortować"
    >
      {label}
      <span className="arrow">{active ? (sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
    </th>
  );
}

export function cmp(a: unknown, b: unknown, dir: SortDir): number {
  const sign = dir === "asc" ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return (a - b) * sign;
  return String(a ?? "").localeCompare(String(b ?? ""), "pl") * sign;
}
