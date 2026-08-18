/**
 * AssistantTip.tsx — dymek przy podświetlanym elemencie.
 *
 * Jedyne miejsce, w którym użytkownik rozmawia z autopilotem w trakcie pracy.
 * Panel asystenta z boku zostaje dla czatu i listy kroków — wpisywanie wartości
 * odbywa się TUTAJ, przy polu, którego dotyczy.
 *
 * Trzy tryby, wybierane po polu `tryb`:
 *   "info"   — samo wyjaśnienie, po co jest ten krok. Znika samo.
 *   "ask"    — pytanie o wartość: kontrolka, propozycje do kliknięcia, potwierdzenie.
 *   "manual" — prośba o samodzielne wykonanie czynności, z przyciskiem Kontynuuj.
 *
 * Opcje list wyboru NIE pochodzą z korpusu wiedzy — czyta je driver z żywego
 * <select> na stronie i przekazuje w `opcje`. Korpus nie zna listy klientów
 * ani produktów i nie powinien jej znać: każde dodanie kontrahenta wymagałoby
 * wtedy ponownego ingestu.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import type { AssistantAction } from "@demo-erp/shared";
import type { AnchorRect } from "./driver.js";

type AskAction = Extract<AssistantAction, { kind: "ask" }>;
type ManualAction = Extract<AssistantAction, { kind: "manual" }>;

/** Odstęp między elementem a dymkiem oraz margines od krawędzi okna. */
const LUZ = 10;
const MARGINES = 8;

export type TipProps =
  | { tryb: "info"; title: string; hint?: string; rect: AnchorRect | null }
  | {
      tryb: "ask";
      action: AskAction;
      opcje?: string[];
      rect: AnchorRect | null;
      onResolve: (wartosc: string | null) => void;
    }
  | {
      tryb: "manual";
      action: ManualAction;
      rect: AnchorRect | null;
      onResolve: (kontynuuj: boolean) => void;
    };

/**
 * Propozycje wyliczane po stronie frontu, bo zależą od CHWILI, a nie od korpusu.
 * Data w YAML-u zestarzałaby się następnego dnia.
 */
function propozycjeDaty(): { label: string; value: string }[] {
  const iso = (dni: number): string => {
    const d = new Date();
    d.setDate(d.getDate() + dni);
    return d.toISOString().slice(0, 10);
  };

  return [
    { label: "dziś", value: iso(0) },
    { label: "za tydzień", value: iso(7) },
    { label: "za 14 dni", value: iso(14) },
  ];
}

export function AssistantTip(props: TipProps) {
  const { rect } = props;

  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement>(null);

  const [wartosc, setWartosc] = useState("");
  const [pozycja, setPozycja] = useState<{ top: number; left: number } | null>(null);

  // useLayoutEffect, nie useEffect: pozycję liczymy PO zmierzeniu dymka, ale
  // PRZED malowaniem. Inaczej widać przeskok z rogu ekranu na miejsce docelowe.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;

    const w = box.offsetWidth;
    const h = box.offsetHeight;

    if (!rect) {
      // Krok bez elementu na ekranie (np. nawigacja) — dymek na środku u góry,
      // żeby wyjaśnienie nie przepadło.
      setPozycja({ top: 24, left: Math.max(MARGINES, (window.innerWidth - w) / 2) });
      return;
    }

    // Przy dolnej krawędzi okna dymek pod elementem wyszedłby poza widok.
    const zmiesciSiePod = rect.top + rect.height + LUZ + h < window.innerHeight;

    setPozycja({
      top: zmiesciSiePod
        ? rect.top + rect.height + LUZ
        : Math.max(MARGINES, rect.top - h - LUZ),
      left: Math.min(Math.max(MARGINES, rect.left), window.innerWidth - w - MARGINES),
    });
  }, [rect, props.tryb, wartosc]);

  // Fokus od razu: autopilot i tak stoi, więc użytkownik ma pisać,
  // a nie szukać myszą, gdzie kliknąć.
  useEffect(() => {
    if (props.tryb === "ask") inputRef.current?.focus();
  }, [props.tryb]);

  const styl = {
    top: pozycja?.top ?? -9999,
    left: pozycja?.left ?? -9999,
    // Dopóki nie znamy pozycji, dymek jest przezroczysty — inaczej mignąłby
    // w lewym górnym rogu przed przeskoczeniem na miejsce.
    opacity: pozycja ? 1 : 0,
  };

  // --------------------------------- INFO ---------------------------------

  if (props.tryb === "info") {
    return (
      <div ref={boxRef} className="assistant-tip" style={styl} data-assistant-id="assistant.tip">
        <div className="tip-main">{props.title}</div>
        {props.hint && <div className="tip-hint">{props.hint}</div>}
      </div>
    );
  }

  // -------------------------------- MANUAL --------------------------------

  if (props.tryb === "manual") {
    return (
      <div
        ref={boxRef}
        className="assistant-tip interaktywny"
        style={styl}
        data-assistant-id="assistant.manual"
      >
        <div className="tip-main">{props.action.label}</div>
        {props.action.hint && <div className="tip-hint">{props.action.hint}</div>}

        <div className="tip-actions">
          <button
            className="primary sm"
            data-assistant-id="btn.assistant-manual-continue"
            onClick={() => props.onResolve(true)}
          >
            Kontynuuj
          </button>
          <button
            className="sm"
            data-assistant-id="btn.assistant-manual-cancel"
            onClick={() => props.onResolve(false)}
          >
            Przerwij
          </button>
        </div>
      </div>
    );
  }

  // ---------------------------------- ASK ---------------------------------

  const { action, opcje, onResolve } = props;

  const zatwierdz = (v?: string): void => {
    const finalna = (v ?? wartosc).trim();
    if (finalna) onResolve(finalna);
  };

  const naKlawisz = (e: KeyboardEvent): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      zatwierdz();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onResolve(null);
    }
  };

  const listaOpcji = action.inputType === "select" ? (opcje ?? []) : [];

  // Trzy źródła propozycji, w kolejności od najbardziej wiarygodnego:
  // opcje z żywej strony, propozycje autorskie z korpusu, wyliczone daty.
  const propozycje: { label: string; value: string }[] =
    action.inputType === "select"
      ? []
      : [
          ...(action.suggestions ?? []).map((v) => ({ label: v, value: v })),
          ...(action.inputType === "date" ? propozycjeDaty() : []),
        ];

  return (
    <div
      ref={boxRef}
      className="assistant-tip interaktywny"
      style={styl}
      data-assistant-id="assistant.ask"
    >
      <div className="tip-main">{action.label}</div>
      {action.hint && <div className="tip-hint">{action.hint}</div>}

      {action.inputType === "select" ? (
        <select
          ref={inputRef as RefObject<HTMLSelectElement>}
          data-assistant-id="field.assistant-ask-value"
          value={wartosc}
          onChange={(e) => setWartosc(e.target.value)}
          onKeyDown={naKlawisz}
        >
          <option value="">— wybierz —</option>
          {listaOpcji.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          ref={inputRef as RefObject<HTMLInputElement>}
          data-assistant-id="field.assistant-ask-value"
          // 'date' i 'number' dają natywną kontrolkę i walidację przeglądarki —
          // taniej niż pisać własną, a użytkownik zna te widgety.
          type={action.inputType === "text" ? "text" : action.inputType}
          value={wartosc}
          onChange={(e) => setWartosc(e.target.value)}
          onKeyDown={naKlawisz}
        />
      )}

      {propozycje.length > 0 && (
        <div className="tip-suggestions">
          {propozycje.map((p) => (
            <button
              key={p.value}
              className="chip-btn"
              // Klik od razu zatwierdza: propozycja jest gotową odpowiedzią,
              // a dodatkowe potwierdzenie tylko dokładałoby kliknięcie.
              onClick={() => zatwierdz(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      {action.inputType === "select" && listaOpcji.length === 0 && (
        <div className="tip-warn">
          Lista na tym ekranie jest pusta — może trzeba najpierw wypełnić
          wcześniejsze pole.
        </div>
      )}

      <div className="tip-actions">
        <button
          className="primary sm"
          data-assistant-id="btn.assistant-ask-confirm"
          disabled={!wartosc.trim()}
          onClick={() => zatwierdz()}
        >
          Wpisz
        </button>
        <button
          className="sm"
          data-assistant-id="btn.assistant-ask-cancel"
          onClick={() => onResolve(null)}
        >
          Przerwij
        </button>
      </div>
    </div>
  );
}
