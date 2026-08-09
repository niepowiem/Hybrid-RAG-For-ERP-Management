/**
 * driver.ts — silnik podświetlania i autopilota.
 *
 * Dwie funkcje publiczne, obie działające na tych samych danych:
 *   highlight(anchor)  — obrysuj element (krok 4)
 *   runAutopilot(steps) — wykonaj kroki za użytkownika (krok 5)
 *
 * Kotwice (data-assistant-id) pochodzą wprost z YAML-a i nigdy nie przechodzą
 * przez model językowy. Dlatego autopilot nie może kliknąć w element, którego
 * nie ma w dokumentacji — to zabezpieczenie architektoniczne, nie promptowe.
 */

import type { AssistantStep } from "@demo-erp/shared";

const Z_HIGHLIGHT = 40;
const Z_CURSOR = 90;

// --------------------------- znajdowanie elementu --------------------------

export function findAnchor(anchor: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-assistant-id="${CSS.escape(anchor)}"]`);
}

/** Czeka, aż element pojawi się w DOM — po nawigacji React montuje z opóźnieniem. */
function waitForAnchor(anchor: string, timeoutMs = 3000): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const found = findAnchor(anchor);
    if (found) return resolve(found);

    const start = Date.now();
    const obs = new MutationObserver(() => {
      const el = findAnchor(anchor);
      if (el) {
        obs.disconnect();
        resolve(el);
      } else if (Date.now() - start > timeoutMs) {
        obs.disconnect();
        resolve(null);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      obs.disconnect();
      resolve(findAnchor(anchor));
    }, timeoutMs);
  });
}

// ------------------------------ podświetlanie ------------------------------

let ramka: HTMLDivElement | null = null;
let ukryjTimer: number | null = null;

function ensureRamka(): HTMLDivElement {
  if (!ramka) {
    ramka = document.createElement("div");
    ramka.className = "assistant-highlight";
    ramka.style.zIndex = String(Z_HIGHLIGHT);
    document.body.appendChild(ramka);
  }
  return ramka;
}

export function clearHighlight(): void {
  if (ramka) ramka.style.opacity = "0";
}

/**
 * Obrysowuje element i przewija do niego. Zwraca false, jeśli elementu nie ma
 * na bieżącym ekranie — wtedy interfejs może powiedzieć "przejdź najpierw tam".
 */
export async function highlight(anchor: string, ttlMs = 4000): Promise<boolean> {
  const el = await waitForAnchor(anchor, 1200);
  if (!el) return false;

  el.scrollIntoView({ behavior: "smooth", block: "center" });

  // Pozycja liczona po przewinięciu — dlatego krótkie opóźnienie.
  await new Promise((r) => setTimeout(r, 320));

  const r = el.getBoundingClientRect();
  const box = ensureRamka();
  box.style.top = `${r.top - 4}px`;
  box.style.left = `${r.left - 4}px`;
  box.style.width = `${r.width + 8}px`;
  box.style.height = `${r.height + 8}px`;
  box.style.opacity = "1";

  if (ukryjTimer) window.clearTimeout(ukryjTimer);
  if (ttlMs > 0) ukryjTimer = window.setTimeout(clearHighlight, ttlMs);
  return true;
}

// -------------------------------- kursor -----------------------------------

let kursor: HTMLDivElement | null = null;

function ensureKursor(): HTMLDivElement {
  if (!kursor) {
    kursor = document.createElement("div");
    kursor.className = "assistant-cursor";
    kursor.style.zIndex = String(Z_CURSOR);
    kursor.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2l7 18 2.5-7.5L21 10z" fill="#16181b" stroke="#fff" stroke-width="1.4"/></svg>`;
    document.body.appendChild(kursor);
  }
  return kursor;
}

/** Płynne przesunięcie kursora do punktu. Czas zależny od dystansu. */
function moveKursor(x: number, y: number): Promise<void> {
  const c = ensureKursor();
  const teraz = c.getBoundingClientRect();
  const dist = Math.hypot(x - teraz.left, y - teraz.top);
  const czas = Math.min(900, Math.max(350, dist * 1.1));

  c.style.opacity = "1";
  c.style.transition = `transform ${czas}ms cubic-bezier(0.33, 0, 0.2, 1)`;
  c.style.transform = `translate(${x}px, ${y}px)`;
  return new Promise((r) => setTimeout(r, czas + 60));
}

function klikniecieWizualne(): Promise<void> {
  const c = ensureKursor();
  c.classList.add("klik");
  return new Promise((r) =>
    setTimeout(() => {
      c.classList.remove("klik");
      r();
    }, 260),
  );
}

export function hideKursor(): void {
  if (kursor) kursor.style.opacity = "0";
}

// ---------------------------- wypełnianie pól ------------------------------

/**
 * Ustawia wartość pola tak, żeby React to zauważył.
 *
 * TO JEST NAJWIĘKSZA PUŁAPKA CAŁEGO AUTOPILOTA. React podmienia setter
 * właściwości `value` na własny i śledzi zmiany przez niego. Zwykłe
 * `input.value = "x"` zmienia DOM, ale React o tym nie wie — jego stan
 * zostaje stary, a przy pierwszym przerysowaniu wartość wraca.
 *
 * Rozwiązanie: sięgamy po ORYGINALNY setter z prototypu HTMLInputElement,
 * wywołujemy go bezpośrednio, a potem ręcznie emitujemy zdarzenie `input`,
 * które React nasłuchuje.
 */
function setReactValue(el: HTMLElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;

  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);

  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Dla <select>: model zna etykietę, nie wartość techniczną. Szukamy opcji. */
function selectByLabel(el: HTMLSelectElement, label: string): boolean {
  const szukane = label.toLowerCase();
  const opcja = Array.from(el.options).find(
    (o) => o.text.toLowerCase().includes(szukane) || o.value.toLowerCase() === szukane,
  );
  if (!opcja) return false;
  setReactValue(el, opcja.value);
  return true;
}

// ------------------------------- autopilot ---------------------------------

export interface AutopilotHandle {
  stop: () => void;
}

export interface AutopilotCallbacks {
  onStep?: (index: number, step: AssistantStep) => void;
  onDone?: (wykonane: number, przerwane: boolean) => void;
  onError?: (index: number, powod: string) => void;
}

let stopSignal = false;

/** Przerwanie w dowolnym momencie — Escape albo klik użytkownika. */
export function stopAutopilot(): void {
  stopSignal = true;
}

/**
 * Wykonuje kroki po kolei, pokazując co robi.
 *
 * Kroki bez pola `action` są tylko podświetlane — autopilot pokazuje,
 * gdzie kliknąć, ale nie klika. Dzięki temu ta sama lista kroków obsługuje
 * tryb "prowadź mnie" i tryb "zrób za mnie", bez osobnych danych.
 */
export async function runAutopilot(
  steps: AssistantStep[],
  navigate: (route: string) => void,
  cb: AutopilotCallbacks = {},
): Promise<void> {
  stopSignal = false;
  document.body.classList.add("assistant-driving");

  let wykonane = 0;
  try {
    for (let i = 0; i < steps.length; i++) {
      if (stopSignal) break;
      const step = steps[i];
      if (!step) continue;
      cb.onStep?.(i, step);

      const akcja = step.action;

      if (akcja?.kind === "navigate") {
        navigate(akcja.route);
        await new Promise((r) => setTimeout(r, 500));
        wykonane++;
        continue;
      }

      const anchor = akcja && "anchor" in akcja ? akcja.anchor : step.anchor;
      if (!anchor) {
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }

      const el = await waitForAnchor(anchor, 5000);
      if (!el) {
        cb.onError?.(
          i,
          `nie znalazłem elementu "${anchor}" na tym ekranie. ` +
            `Możliwe, że poprzedni krok nie przeniósł mnie we właściwe miejsce.`,
        );
        break;
      }

      el.scrollIntoView({ behavior: "smooth", block: "center" });
      await new Promise((r) => setTimeout(r, 340));

      const r = el.getBoundingClientRect();
      await moveKursor(r.left + r.width / 2, r.top + r.height / 2);
      await highlight(anchor, 0);

      if (!akcja) {
        // Krok bez akcji — pokazujemy, gdzie kliknąć, ale nie klikamy.
        // Tak zachowują się kroki wskazujące pola, których wartości
        // nie znamy (np. "wpisz swoją ilość").
        await new Promise((r) => setTimeout(r, 1100));
        continue;
      }

      await klikniecieWizualne();

      if (akcja.kind === "click") {
        el.click();
        // Kliknięcie w nawigację albo zakładkę przerysowuje ekran.
        // React montuje nowe elementy asynchronicznie, więc dajemy mu chwilę,
        // zanim zaczniemy szukać kotwicy kolejnego kroku.
        await new Promise((r) => setTimeout(r, 450));
      } else if (akcja.kind === "fill") {
        el.focus();
        setReactValue(el, akcja.value);
      } else if (akcja.kind === "select") {
        if (!(el instanceof HTMLSelectElement)) {
          cb.onError?.(i, `Element ${anchor} nie jest listą wyboru`);
          break;
        }
        if (!selectByLabel(el, akcja.label)) {
          const dostepne = Array.from(el.options)
            .map((o) => o.text)
            .filter((t) => t && !t.startsWith("—"))
            .slice(0, 4)
            .join(", ");
          cb.onError?.(i, `Nie ma opcji "${akcja.label}". Dostępne: ${dostepne}`);
          break;
        }
        // Zmiana wartości pola może odsłonić lub ukryć inne pola
        // (np. wybór MM wyłącza pole Kontrahent).
        await new Promise((r) => setTimeout(r, 400));
      }

      wykonane++;
      await new Promise((r) => setTimeout(r, 620));
    }
  } finally {
    document.body.classList.remove("assistant-driving");
    hideKursor();
    clearHighlight();
    cb.onDone?.(wykonane, stopSignal);
  }
}
