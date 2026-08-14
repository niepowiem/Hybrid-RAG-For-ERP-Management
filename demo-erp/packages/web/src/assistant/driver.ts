/**
 * driver.ts — silnik podświetlania i autopilota.
 *
 * Trzy funkcje publiczne, wszystkie działające na tych samych danych:
 *   highlight(anchor)   — obrysuj element
 *   runAutopilot(steps) — wykonaj kroki za użytkownika
 *   stopAutopilot()     — przerwij w dowolnym momencie
 *
 * Kotwice (data-assistant-id) pochodzą wprost z YAML-a i nigdy nie przechodzą
 * przez model językowy. Dlatego autopilot nie może kliknąć w element, którego
 * nie ma w dokumentacji — to zabezpieczenie architektoniczne, nie promptowe.
 *
 * Autopilot ma trzy tryby zachowania na krok:
 *   - krok bez akcji            -> tylko podświetla, nie klika
 *   - krok z akcją wykonywalną  -> klika/wpisuje/wybiera
 *   - krok z akcją `ask`        -> zatrzymuje się i pyta użytkownika o wartość
 *
 * Po każdej akcji sprawdza banner błędu. Gdy błąd się pojawi, prosi backend
 * o plan naprawczy i wplata go w kolejkę PRZED pozostałymi krokami.
 */

import type { AssistantAction, AssistantStep } from "@demo-erp/shared";

const Z_HIGHLIGHT = 40;
/** Dymek nad podświetleniem, pod kursorem — inaczej kursor chowałby się za nim. */
const Z_TIP = 85;
const Z_CURSOR = 90;

/** Ile razy autopilot spróbuje naprawić TEN SAM kod błędu, zanim się podda. */
const MAX_NAPRAW_NA_KOD = 2;

/** Ile czasu użytkownik dostaje na przeczytanie wyjaśnienia kroku. */
const CZAS_NARRACJI_MS = 1600;

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

const widoczny = (el: Element): boolean => {
  const r = (el as HTMLElement).getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};

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

// ------------------------------ pozycja dymka -------------------------------
// Dymek renderuje React (AssistantTip), a nie ten plik. Powód: ma zawierać
// pola i przyciski, a mieszanie ręcznie budowanego DOM z drzewem Reacta kończy
// się elementami, których React nie widzi i nie sprząta.
//
// Driver dostarcza tylko WSPÓŁRZĘDNE elementu; resztą zajmuje się komponent.

export interface AnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Prostokąt elementu w układzie okna. null, gdy elementu nie ma na ekranie. */
export function anchorRect(anchor: string | undefined): AnchorRect | null {
  const el = anchor ? findAnchor(anchor) : null;

  if (!el) return null;

  const r = el.getBoundingClientRect();

  return { top: r.top, left: r.left, width: r.width, height: r.height };
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

/**
 * Realne opcje listy wyboru, do pokazania użytkownikowi przy akcji `ask`.
 * Odfiltrowujemy placeholder "— wybierz —", bo to nie jest wybór.
 */
export function opcjeSelecta(el: HTMLElement): string[] | undefined {
  if (!(el instanceof HTMLSelectElement)) return undefined;

  return Array.from(el.options)
      .map((o) => o.text.trim())
      .filter((t) => t.length > 0 && !t.startsWith("—"));
}

// ------------------------------ wykrywanie błędu ---------------------------

/**
 * Kod błędu z bannera, jeśli jest widoczny na ekranie.
 *
 * Banner renderuje ErrorBanner z App.tsx i utrzymuje się do następnej operacji,
 * więc samo "jest banner" nie znaczy "właśnie wystąpił błąd" — porównanie
 * z poprzednim odczytem robi runAutopilot.
 */
export function odczytajKodBledu(): string | null {
  const banner = document.querySelector('[data-assistant-id="banner.error"]');
  if (!banner || !widoczny(banner)) return null;

  const kod = banner.querySelector(".code")?.textContent?.trim();
  return kod || null;
}

// ------------------------------- autopilot ---------------------------------

export interface AutopilotHandle {
  stop: () => void;
}

export interface AutopilotCallbacks {
  /** Autopilot zaczyna krok. Dobre miejsce na podświetlenie go w liście. */
  onStep?: (index: number, step: AssistantStep) => void;

  /**
   * Wyjaśnienie, po co jest ten krok (pole `why`). Pokazywane PRZED akcją.
   * Autopilot czeka CZAS_NARRACJI_MS, żeby dało się to przeczytać.
   */
  onNarrate?: (index: number, why: string, step: AssistantStep) => void;

  /**
   * Dymek przy elemencie: pokaż (obiekt) albo schowaj (null).
   *
   * Osobno od `onNarrate`, bo narracja trafia do panelu asystenta, a dymek
   * stoi przy elemencie — użytkownik patrzy tam, gdzie dzieje się akcja,
   * i tekstu w rogu ekranu po prostu nie widzi.
   */
  onTip?: (info: { title: string; hint?: string; rect: AnchorRect | null } | null) => void;

  /**
   * Autopilot pyta o wartość i CZEKA na odpowiedź. Zwróć wpisaną wartość
   * albo null, jeśli użytkownik anulował — wtedy przebieg się kończy.
   *
   * @param opcje realne opcje z <select> na stronie; undefined dla pól tekstowych
   */
  onAsk?: (
      index: number,
      action: Extract<AssistantAction, { kind: "ask" }>,
      opcje: string[] | undefined,
      rect: AnchorRect | null,
  ) => Promise<string | null>;

  /**
   * Autopilot prosi użytkownika o samodzielne wykonanie czynności i CZEKA.
   * Zwróć true, żeby ruszyć dalej, false, żeby przerwać.
   */
  onManual?: (
      index: number,
      action: Extract<AssistantAction, { kind: "manual" }>,
      rect: AnchorRect | null,
  ) => Promise<boolean>;

  /**
   * Po kroku pojawił się błąd. Zwróć kroki naprawcze (z /assistant/recover),
   * a autopilot wplecie je w kolejkę. Zwróć null, żeby przerwać.
   */
  onRecover?: (kod: string, proba: number) => Promise<AssistantStep[] | null>;

  /** Coś poszło nie tak i dalej nie idziemy. Komunikat dla użytkownika. */
  onError?: (index: number, powod: string) => void;

  onDone?: (wykonane: number, przerwane: boolean) => void;
}

let stopSignal = false;

/** Przerwanie w dowolnym momencie — Escape albo klik użytkownika. */
export function stopAutopilot(): void {
  stopSignal = true;
}

/**
 * Wykonuje kroki po kolei, pokazując co robi.
 *
 * Kroki bez pola `action` są tylko podświetlane — autopilot pokazuje, gdzie
 * kliknąć, ale nie klika. Dzięki temu ta sama lista kroków obsługuje tryb
 * "prowadź mnie" i tryb "zrób za mnie", bez osobnych danych.
 *
 * @param steps kroki z AssistantReply. Kopiujemy je do własnej kolejki, bo
 *   plan naprawczy jest w nią wplatany — mutowanie tablicy wywołującego
 *   zmieniałoby listę, którą użytkownik widzi w dymku.
 */
export async function runAutopilot(
    steps: AssistantStep[],
    navigate: (route: string) => void,
    cb: AutopilotCallbacks = {},
    odKroku = 0,
): Promise<void> {
  stopSignal = false;
  document.body.classList.add("assistant-driving");

  const kolejka: AssistantStep[] = [...steps];

  // Ile razy próbowaliśmy naprawić dany kod. Bez tego naprawa, która sama
  // wywołuje ten sam błąd, kręci się w kółko.
  const proby = new Map<string, number>();

  // Banner potrafi zostać na ekranie z poprzedniej operacji użytkownika.
  // Zapamiętujemy stan startowy, żeby reagować tylko na NOWY błąd.
  let ostatniKod: string | null = odczytajKodBledu();

  let wykonane = 0;

  try {
    // Start od wskazanego kroku: gdy autopilot się zatrzyma, użytkownik
    // wznawia od miejsca przerwania zamiast powtarzać wszystko od początku.
    for (let i = Math.max(0, Math.min(odKroku, kolejka.length - 1)); i < kolejka.length; i++) {
      if (stopSignal) break;

      const step = kolejka[i];
      if (!step) continue;

      cb.onStep?.(i, step);

      // --- narracja: po co jest ten krok ---
      // Dymek pokazujemy PO podświetleniu elementu (niżej), żeby stanął we
      // właściwym miejscu. Tutaj tylko powiadamiamy panel.
      if (step.why) cb.onNarrate?.(i, step.why, step);

      const akcja = step.action;

      // --- nawigacja: jedyna akcja bez elementu na stronie ---
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

      // Wyjaśnienie przy elemencie. Dla akcji `ask` drugi wiersz to podpowiedź,
      // co w to pole wpisać — użytkownik czyta ją zanim zobaczy kontrolkę.
      // Tytuł dymka: wyjaśnienie kroku, a gdy go nie ma — pytanie z akcji `ask`.
      // Wyjaśnienie pokazujemy TYLKO przy krokach, które autopilot wykona sam.
      // Przy 'ask' i 'manual' dymek i tak zamieni się w kontrolkę z tym samym
      // tekstem, więc osobne czekanie tylko wydłużałoby przebieg.
      const interaktywna = akcja?.kind === "ask" || akcja?.kind === "manual";

      if (step.why && !interaktywna) {
        cb.onTip?.({ title: step.why, rect: anchorRect(anchor) });

        await new Promise((rr) => setTimeout(rr, CZAS_NARRACJI_MS));
        if (stopSignal) break;
      }

      if (!akcja) {
        // Krok bez akcji — pokazujemy, gdzie kliknąć, ale nie klikamy.
        // Tak zachowują się kroki wskazujące pola, których wartości nie znamy.
        await new Promise((r) => setTimeout(r, 1100));
        continue;
      }

      // --- czynność wykonywana przez użytkownika ---
      if (akcja.kind === "manual") {
        if (!cb.onManual) {
          cb.onError?.(i, "ten krok musisz wykonać samodzielnie, ale interfejs nie umie o to poprosić");
          break;
        }

        const kontynuuj = await cb.onManual(i, akcja, anchorRect(anchor));
        if (!kontynuuj) break;

        wykonane++;

        // Użytkownik mógł kliknąć coś, co wywołało błąd — sprawdzamy tak samo
        // jak po własnej akcji autopilota.
        const poManualu = await obsluzBlad(i, kolejka, proby, ostatniKod, cb);
        if (poManualu.przerwij) break;
        ostatniKod = poManualu.kod;

        continue;
      }

      // --- przerwanie na wartość od użytkownika ---
      if (akcja.kind === "ask") {
        if (!cb.onAsk) {
          cb.onError?.(i, "ten krok wymaga wartości od Ciebie, ale interfejs nie umie o nią zapytać");
          break;
        }

        // Opcje bierzemy z ŻYWEGO selecta: korpus wiedzy nie zna listy
        // kontrahentów ani produktów i nie powinien jej znać.
        const wartosc = await cb.onAsk(i, akcja, opcjeSelecta(el), anchorRect(anchor));

        if (wartosc === null) {
          // Anulowanie to świadoma decyzja użytkownika, nie awaria.
          break;
        }

        await klikniecieWizualne();

        if (el instanceof HTMLSelectElement) {
          if (!selectByLabel(el, wartosc)) {
            cb.onError?.(i, `Nie ma opcji "${wartosc}" na liście`);
            break;
          }
          await new Promise((r) => setTimeout(r, 400));
        } else {
          el.focus();
          setReactValue(el, wartosc);
        }

        wykonane++;
        await new Promise((r) => setTimeout(r, 620));

        // Wpisanie wartości może wywołać walidację — sprawdzamy błąd jak po akcji.
        const wynik = await obsluzBlad(i, kolejka, proby, ostatniKod, cb);
        if (wynik.przerwij) break;
        ostatniKod = wynik.kod;

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
          const dostepne = (opcjeSelecta(el) ?? []).slice(0, 4).join(", ");
          cb.onError?.(i, `Nie ma opcji "${akcja.label}". Dostępne: ${dostepne}`);
          break;
        }
        // Zmiana wartości pola może odsłonić lub ukryć inne pola
        // (np. wybór MM wyłącza pole Kontrahent).
        await new Promise((r) => setTimeout(r, 400));
      }

      wykonane++;
      await new Promise((r) => setTimeout(r, 620));

      // --- wykrycie i naprawa błędu ---
      const wynik = await obsluzBlad(i, kolejka, proby, ostatniKod, cb);
      if (wynik.przerwij) break;
      ostatniKod = wynik.kod;
    }
  } finally {
    document.body.classList.remove("assistant-driving");
    hideKursor();
    cb.onTip?.(null);
    clearHighlight();
    cb.onDone?.(wykonane, stopSignal);
  }
}

/**
 * Sprawdza, czy po kroku pojawił się NOWY błąd, i próbuje go naprawić.
 *
 * Kroki naprawcze wplatamy zaraz za bieżącym krokiem, więc pętla wykona je
 * przed resztą planu, a potem wróci do przerwanego miejsca.
 *
 * @returns przerwij — czy zakończyć przebieg; kod — nowy stan bannera
 */
async function obsluzBlad(
    i: number,
    kolejka: AssistantStep[],
    proby: Map<string, number>,
    poprzedniKod: string | null,
    cb: AutopilotCallbacks,
): Promise<{ przerwij: boolean; kod: string | null }> {
  const kod = odczytajKodBledu();

  // Brak bannera albo ten sam co przed krokiem = nic nowego się nie stało.
  if (!kod || kod === poprzedniKod) return { przerwij: false, kod };

  if (!cb.onRecover) {
    cb.onError?.(i, `wystąpił błąd ${kod}`);
    return { przerwij: true, kod };
  }

  const proba = (proby.get(kod) ?? 0) + 1;
  proby.set(kod, proba);

  if (proba > MAX_NAPRAW_NA_KOD) {
    cb.onError?.(i, `błąd ${kod} powtórzył się mimo naprawy — przerywam`);
    return { przerwij: true, kod };
  }

  const naprawa = await cb.onRecover(kod, proba);

  if (!naprawa || naprawa.length === 0) {
    cb.onError?.(i, `wystąpił błąd ${kod} i nie mam procedury, która go naprawia`);
    return { przerwij: true, kod };
  }

  kolejka.splice(i + 1, 0, ...naprawa);

  // Zerujemy zapamiętany kod: jeśli naprawa nie zadziała i ten SAM błąd
  // wyskoczy ponownie, ma zostać wykryty jako nowy. Bez tego druga próba
  // przechodziła bez śladu ("kod === poprzedniKod") i autopilot spokojnie
  // kończył plan mimo nienaprawionego błędu. Przed pętlą chroni licznik 'proby'.
  return { przerwij: false, kod: null };
}