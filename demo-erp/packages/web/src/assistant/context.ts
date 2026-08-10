/**
 * context.ts — sonda kontekstu (krok 2).
 *
 * Zbiera z żywej strony to, co asystent musi wiedzieć o sytuacji użytkownika.
 * Czyta DOM w runtime, nie analizuje kodu źródłowego — dzięki temu działa
 * niezależnie od tego, jak napisane są komponenty.
 *
 * Świadomie NIE zapisujemy wartości pól, tylko czy są wypełnione. Kontekst
 * jedzie do modelu, a wartości formularza mogą zawierać dane osobowe.
 */

import type { Role } from "@demo-erp/shared";

export interface AssistantContext {
  /** Indeks pozwala przekazać kontekst jako Record<string, unknown> w żądaniu. */
  [k: string]: unknown;
  route: string;
  routeTitle: string;
  role: Role | null;
  buildVersion: string;
  visibleActions: { id: string; label: string; disabled: boolean }[];
  form: { id: string; fields: { id: string; label: string; filled: boolean; invalid: boolean }[] } | null;
  lastError: { code: string; message: string } | null;
  strugglingWith: string | null;
}

const BUILD_VERSION = "0.4.0";

let ostatniBlad: { code: string; message: string } | null = null;
const nieudane = new Map<string, number>();

export function zglosBlad(code: string, message: string): void {
  ostatniBlad = { code, message };
}

export function wyczyscBlad(): void {
  ostatniBlad = null;
  nieudane.clear();
}

const widoczny = (el: Element): boolean => {
  const he = el as HTMLElement;
  const r = he.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};

const tekst = (el: Element): string =>
  ((el as HTMLElement).innerText ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 50);

function etykieta(el: Element): string {
  const id = el.getAttribute("id");
  if (id) {
    const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (lab) return tekst(lab);
  }
  return el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || "";
}

export function getAssistantContext(role: Role | null): AssistantContext {
  const akcje = Array.from(
    document.querySelectorAll("[data-assistant-id]"),
  )
    .filter((el) => widoczny(el) && /^(btn|nav|tab)\./.test(el.getAttribute("data-assistant-id") ?? ""))
    .slice(0, 25)
    .map((el) => ({
      id: el.getAttribute("data-assistant-id")!,
      label: el.getAttribute("aria-label") || tekst(el),
      disabled: (el as HTMLButtonElement).disabled === true,
    }));

  const karty = Array.from(document.querySelectorAll(".card")).filter(widoczny);
  const form = karty.length
      ? {
        id: "form.document",
        fields: karty.flatMap((karta) =>
            Array.from(karta.querySelectorAll("input, select, textarea"))
                .filter(widoczny)
                .map((el) => {
                  const i = el as HTMLInputElement;
                  return {
                    id: el.getAttribute("data-assistant-id") ?? el.getAttribute("id") ?? "?",
                    label: etykieta(el),
                    filled: String(i.value ?? "").trim().length > 0,
                    invalid: el.classList.contains("invalid"),
                  };
                }),
        ),
      }
      : null;

  // Trzykrotnie nieudana walidacja tego samego pola = użytkownik utknął.
  let struggling: string | null = null;
  if (form) {
    for (const f of form.fields) {
      if (f.invalid) {
        const n = (nieudane.get(f.id) ?? 0) + 1;
        nieudane.set(f.id, n);
        if (n >= 2) struggling = f.id;
      } else {
        nieudane.delete(f.id);
      }
    }
  }

  const h1 = document.querySelector("h1");

  return {
    route: window.location.pathname,
    routeTitle: h1 && widoczny(h1) ? tekst(h1) : document.title,
    role,
    buildVersion: BUILD_VERSION,
    visibleActions: akcje,
    form,
    lastError: ostatniBlad,
    strugglingWith: struggling,
  };
}
