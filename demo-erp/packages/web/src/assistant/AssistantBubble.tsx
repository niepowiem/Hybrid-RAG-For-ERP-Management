/**
 * AssistantBubble.tsx — panel asystenta w prawym dolnym rogu.
 *
 * Interfejs czatu: log wiadomości użytkownika i asystenta. Każda odpowiedź
 * z krokami dostaje dwa przyciski, obsługiwane tą samą listą kroków:
 *   "Pokaż mi to"  — podświetla kolejne elementy, niczego nie klikając
 *   "Zrób za mnie" — autopilot wykonuje kroki, pyta o wartości, których nie zna,
 *                    i naprawia błędy, które napotka
 *
 * UWAGA przy modyfikacjach: `onAsk` z drivera zwraca Promise, które rozstrzyga
 * dopiero użytkownik. Autopilot fizycznie stoi w tym czasie — dlatego `resolve`
 * trzymamy w stanie komponentu, a nie w zmiennej lokalnej.
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AssistantAction, AssistantReply, AssistantStep, AssistantTurn } from "@demo-erp/shared";
import { getRole } from "../api.js";
import { askAssistant, recoverFromError } from "./client.js";
import { getAssistantContext } from "./context.js";
import { anchorRect, clearHighlight, highlight, runAutopilot, stopAutopilot } from "./driver.js";
import type { AnchorRect } from "./driver.js";
import { AssistantTip } from "./AssistantTip.js";

type AskAction = Extract<AssistantAction, { kind: "ask" }>;
type ManualAction = Extract<AssistantAction, { kind: "manual" }>;

interface Wiadomosc {
  rola: "user" | "bot";
  tresc: string;
  reply?: AssistantReply;
}

interface Pytanie {
  action: AskAction;
  opcje?: string[];
  rect: AnchorRect | null;
  resolve: (wartosc: string | null) => void;
}

/** Prośba o samodzielne wykonanie czynności. Autopilot stoi do rozstrzygnięcia. */
interface Reczne {
  action: ManualAction;
  rect: AnchorRect | null;
  resolve: (kontynuuj: boolean) => void;
}

/** Pasywne wyjaśnienie przy elemencie, bez interakcji. */
interface Info {
  title: string;
  hint?: string;
  rect: AnchorRect | null;
}

const PODPOWIEDZI = [
  "Jak przyjąć towar na magazyn?",
  "Gdzie sprawdzę stan produktu?",
  "Jak zrobić przesunięcie MM?",
];

export function AssistantBubble() {
  const navigate = useNavigate();

  const [otwarty, setOtwarty] = useState(false);
  const [tekst, setTekst] = useState("");
  const [ladowanie, setLadowanie] = useState(false);
  const [log, setLog] = useState<Wiadomosc[]>([]);

  // Indeks wiadomości i kroku, który autopilot właśnie wykonuje.
  const [aktywny, setAktywny] = useState<{ msg: number; krok: number } | null>(null);
  const [narracja, setNarracja] = useState<string | null>(null);

  // Dymek przy elemencie. Trzy stany wykluczają się nawzajem -- autopilot
  // w danej chwili albo tłumaczy, albo pyta o wartość, albo czeka na czynność.
  const [info, setInfo] = useState<Info | null>(null);
  const [pytanie, setPytanie] = useState<Pytanie | null>(null);
  const [reczne, setReczne] = useState<Reczne | null>(null);
  const [jedzie, setJedzie] = useState(false);

  // Krok, na którym autopilot się zatrzymał. Pozwala wznowić od tego miejsca
  // zamiast powtarzać całą procedurę od początku.
  const [wznowOd, setWznowOd] = useState<{ msg: number; krok: number } | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (otwarty) inputRef.current?.focus();
  }, [otwarty]);

  // Autoscroll do najnowszej wiadomości.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [log, narracja, pytanie]);

  // Escape przerywa autopilota z dowolnego miejsca strony — użytkownik musi
  // móc odzyskać kontrolę bez celowania w mały przycisk.
  useEffect(() => {
    const naKlawisz = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && jedzie) stopAutopilot();
    };

    window.addEventListener("keydown", naKlawisz);
    return () => window.removeEventListener("keydown", naKlawisz);
  }, [jedzie]);

  const kontekst = (): Record<string, unknown> =>
      getAssistantContext(getRole()) as unknown as Record<string, unknown>;

  /**
   * Historia rozmowy w kształcie oczekiwanym przez backend.
   *
   * Parujemy wiadomość użytkownika z następującą po niej odpowiedzią. Kroki
   * odsyłamy razem z ich `id` — po nim serwer rozwiązuje pytanie "wyjaśnij
   * krok 4" na konkretny węzeł grafu, zamiast zgadywać po treści.
   */
  const historia = (): AssistantTurn[] => {
    const tury: AssistantTurn[] = [];

    for (let i = 0; i < log.length - 1; i++) {
      const pytanieUzytkownika = log[i];
      const odpowiedzBota = log[i + 1];

      if (pytanieUzytkownika?.rola !== "user" || odpowiedzBota?.rola !== "bot") continue;

      tury.push({
        question: pytanieUzytkownika.tresc,
        text: odpowiedzBota.tresc,
        sources: odpowiedzBota.reply?.sources ?? [],
        steps: (odpowiedzBota.reply?.steps ?? []).map((s) => ({ id: s.id, text: s.text })),
      });
    }

    // Kilka ostatnich tur wystarcza, a każda kosztuje tokeny w żądaniu.
    return tury.slice(-3);
  };

  async function wyslij(pytanieTekst?: string): Promise<void> {
    const tresc = (pytanieTekst ?? tekst).trim();
    if (!tresc || ladowanie || jedzie) return;

    const poprzednieTury = historia();

    setTekst("");
    setNarracja(null);
    setLog((l) => [...l, { rola: "user", tresc }]);
    setLadowanie(true);

    try {
      // Historię pobieramy PRZED dopisaniem bieżącego pytania do logu --
      // inaczej ostatnia tura byłaby niekompletna (pytanie bez odpowiedzi).
      const reply = await askAssistant(tresc, kontekst(), poprzednieTury);
      setLog((l) => [...l, { rola: "bot", tresc: reply.text, reply }]);
    } finally {
      setLadowanie(false);
    }
  }

  /** Tryb "Pokaż mi to": podświetla kolejne kroki, niczego nie klikając. */
  async function pokazMiTo(msgIndex: number, steps: AssistantStep[]): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step?.anchor) continue;

      setAktywny({ msg: msgIndex, krok: i });
      setNarracja(step.why ?? null);

      const znaleziony = await highlight(step.anchor, 1600);

      // Ten sam dymek co przy autopilocie — tryb "Pokaż mi to" ma tłumaczyć
      // tak samo, tylko bez klikania.
      if (znaleziony && step.why) {
        setInfo({ title: step.why, rect: anchorRect(step.anchor) });
      }

      if (!znaleziony) {
        setNarracja(`Elementu "${step.anchor}" nie ma na tym ekranie — wykonaj wcześniejsze kroki.`);
        break;
      }

      await new Promise((r) => setTimeout(r, 1400));
    }

    setAktywny(null);
    setInfo(null);
    clearHighlight();
  }

  /** Tryb "Zrób za mnie": pełny autopilot z pytaniami i naprawą błędów. */
  async function zrobZaMnie(msgIndex: number, steps: AssistantStep[], odKroku = 0): Promise<void> {
    setJedzie(true);
    setNarracja(null);
    setWznowOd(null);

    // Autopilot kończy się przez onDone także po błędzie. Bez tej flagi komunikat
    // "Gotowe" nadpisywał wyjaśnienie, dlaczego naprawdę przerwał.
    let bladKroku: number | null = null;

    await runAutopilot(steps, navigate, {
      onStep: (i) => setAktywny({ msg: msgIndex, krok: i }),

      onNarrate: (_, why) => setNarracja(why),

      onTip: (dane) => setInfo(dane),

      // Callback zamieniony na Promise: renderujemy dymek, a autopilot
      // czeka, aż użytkownik kliknie Wpisz albo Przerwij.
      onAsk: (_, action, opcje, rect) =>
          new Promise<string | null>((resolve) => {
            // Dymek informacyjny ustępuje miejsca kontrolce — dwa dymki naraz
            // przy tym samym elemencie zasłaniałyby się nawzajem.
            setInfo(null);
            setPytanie({ action, opcje, rect, resolve });
          }),

      onManual: (_, action, rect) =>
          new Promise<boolean>((resolve) => {
            setInfo(null);
            setReczne({ action, rect, resolve });
          }),

      onRecover: async (kod, proba) => {
        setNarracja(`Napotkałem błąd ${kod}. Szukam sposobu naprawy…`);
        return recoverFromError(kod, kontekst(), proba);
      },

      onError: (i, powod) => {
        bladKroku = i;
        setNarracja(`Zatrzymałem się na kroku ${i + 1}: ${powod}`);
      },

      onDone: (wykonane, przerwane) => {
        setJedzie(false);
        setAktywny(null);
        setPytanie(null);
        setReczne(null);
        setInfo(null);

        if (bladKroku !== null) {
          // Komunikatu z onError NIE nadpisujemy -- to on mówi, co poszło nie tak.
          setWznowOd({ msg: msgIndex, krok: bladKroku });
          return;
        }

        if (przerwane) {
          setNarracja(`Przerwano po ${wykonane} krokach.`);
          setWznowOd({ msg: msgIndex, krok: wykonane });
        } else if (wykonane > 0) {
          setNarracja(`Gotowe — wykonałem ${wykonane} kroków.`);
        } else {
          setNarracja(null);
        }
      },
    }, odKroku);
  }

  if (!otwarty) {
    return (
        <button
            className="assistant-launcher"
            data-assistant-id="btn.assistant-open"
            aria-label="Otwórz asystenta"
            onClick={() => setOtwarty(true)}
        >
          <span className="ico">✳</span>
          Asystent
        </button>
    );
  }

  return (
      <div className="assistant-panel" role="dialog" aria-label="Asystent">
        <div className="assistant-head">
        <span className="title">
          <span className="ico">✳</span>
          Asystent
          <span className="tag">graf wiedzy</span>
        </span>
          <span className="head-actions">
          <button
              className="icon-btn"
              aria-label="Wyczyść rozmowę"
              disabled={jedzie}
              onClick={() => {
                setLog([]);
                setNarracja(null);
              }}
          >
            ⟲
          </button>
          <button
              className="icon-btn"
              data-assistant-id="btn.assistant-close"
              aria-label="Zamknij asystenta"
              onClick={() => {
                stopAutopilot();
                clearHighlight();
                setOtwarty(false);
              }}
          >
            ✕
          </button>
        </span>
        </div>

        <div className="assistant-log" ref={logRef}>
          {log.length === 0 && (
              <div className="assistant-intro">
                <p>Zapytaj o procedurę, błąd albo pojęcie z systemu. Pokażę kroki i mogę je wykonać.</p>
                <div className="chips">
                  {PODPOWIEDZI.map((p) => (
                      <button key={p} className="chip-btn" onClick={() => void wyslij(p)}>
                        {p}
                      </button>
                  ))}
                </div>
              </div>
          )}

          {log.map((m, msgIndex) => {
            if (m.rola === "user") {
              return (
                  <div key={msgIndex} className="msg user">
                    {m.tresc}
                  </div>
              );
            }

            const kroki = m.reply?.steps ?? [];
            const ostatnia = msgIndex === log.length - 1;

            return (
                <div key={msgIndex} className={`msg bot${m.reply?.refused ? " refused" : ""}`}>
                  <p className="lead">{m.tresc}</p>

                  {kroki.length > 0 && (
                      <ol className="steps">
                        {kroki.map((s, i) => (
                            <li
                                key={`${i}-${s.text}`}
                                className={
                                  aktywny?.msg === msgIndex && aktywny.krok === i ? "aktywny" : undefined
                                }
                            >
                              {/* Klik w treść kroku wypełnia pole pytaniem o ten krok.
                          Odkrywalne bez instrukcji: użytkownik i tak próbuje
                          kliknąć w to, czego nie rozumie. */}
                              <button
                                  className="krok-pytaj"
                                  title="Zapytaj o ten krok"
                                  onClick={() => {
                                    setTekst(`Wyjaśnij krok ${i + 1}`);
                                    inputRef.current?.focus();
                                  }}
                              >
                                {s.text}
                              </button>
                              {s.why && <span className="why">{s.why}</span>}
                              {s.note && <span className="note">{s.note}</span>}
                              {s.action?.kind === "ask" && <span className="ask-tag">zapyta o wartość</span>}
                            </li>
                        ))}
                      </ol>
                  )}

                  {/* Przyciski tylko przy NAJNOWSZEJ odpowiedzi: starsze plany
                  odnoszą się do stanu ekranu sprzed kilku operacji. */}
                  {/* Przyciski przy KAŻDEJ odpowiedzi z krokami, nie tylko ostatniej:
                  użytkownik może wrócić do wcześniejszej procedury bez zadawania
                  tego samego pytania od nowa. */}
                  {kroki.length > 0 && !jedzie && !pytanie && !reczne && (
                      <div className="msg-actions">
                        <button className="sm" onClick={() => void pokazMiTo(msgIndex, kroki)}>
                          Pokaż mi to
                        </button>
                        <button className="sm primary" onClick={() => void zrobZaMnie(msgIndex, kroki)}>
                          Zrób za mnie
                        </button>
                        {wznowOd?.msg === msgIndex && wznowOd.krok > 0 && (
                            <button
                                className="sm"
                                onClick={() => void zrobZaMnie(msgIndex, kroki, wznowOd.krok)}
                            >
                              Wznów od kroku {wznowOd.krok + 1}
                            </button>
                        )}
                      </div>
                  )}

                  {m.reply && m.reply.sources.length > 0 && (
                      <div className="sources">
                        {m.reply.sources.map((s) => (
                            <span key={s} className="src">
                      {s}
                    </span>
                        ))}
                      </div>
                  )}
                </div>
            );
          })}

          {ladowanie && (
              <div className="msg bot typing">
                <span />
                <span />
                <span />
              </div>
          )}

          {narracja && <div className="assistant-narration">{narracja}</div>}

        </div>

        {jedzie && (
            <div className="assistant-driving-bar">
              <span>Wykonuję kroki…</span>
              <button className="sm" onClick={stopAutopilot}>
                Przerwij (Esc)
              </button>
            </div>
        )}

        {/* Dymek przy elemencie. Renderowany POZA logiem, bo pozycjonuje się
          względem okna, a nie panelu. Kolejność ma znaczenie: pytanie i prośba
          o czynność mają pierwszeństwo przed samym wyjaśnieniem. */}
        {pytanie && (
            <AssistantTip
                tryb="ask"
                action={pytanie.action}
                opcje={pytanie.opcje}
                rect={pytanie.rect}
                onResolve={(v) => {
                  pytanie.resolve(v);
                  setPytanie(null);
                }}
            />
        )}

        {!pytanie && reczne && (
            <AssistantTip
                tryb="manual"
                action={reczne.action}
                rect={reczne.rect}
                onResolve={(ok) => {
                  reczne.resolve(ok);
                  setReczne(null);
                }}
            />
        )}

        {!pytanie && !reczne && info && (
            <AssistantTip tryb="info" title={info.title} hint={info.hint} rect={info.rect} />
        )}

        <div className="assistant-input">
        <textarea
            ref={inputRef}
            data-assistant-id="field.assistant-question"
            rows={2}
            placeholder="O co chcesz zapytać?"
            value={tekst}
            disabled={jedzie}
            onChange={(e) => setTekst(e.target.value)}
            onKeyDown={(e) => {
              // Enter wysyła, Shift+Enter robi nową linię — jak w każdym czacie.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void wyslij();
              }
            }}
        />
          <button
              className="primary sm"
              data-assistant-id="btn.assistant-send"
              disabled={ladowanie || jedzie || !tekst.trim()}
              onClick={() => void wyslij()}
          >
            Wyślij
          </button>
        </div>
      </div>
  );
}