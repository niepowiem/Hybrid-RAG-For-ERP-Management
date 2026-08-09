/**
 * AssistantBubble.tsx — pływający czat asystenta.
 *
 * MONTOWANY POZA <Routes> w App.tsx. To nie jest szczegół stylistyczny:
 * gdyby siedział wewnątrz routingu, każda zmiana ekranu odmontowałaby
 * komponent i historia rozmowy by zniknęła. Asystent musi przeżyć nawigację,
 * bo od kroku 4 sam będzie po niej prowadził użytkownika.
 *
 * Stan trzymany lokalnie (useState) — bąbelek jest samowystarczalny.
 * Komunikacja wyłącznie przez client.ts, więc podmiana atrapy na backend
 * nie dotknie tego pliku.
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AssistantReply, Role } from "@demo-erp/shared";
import { askAssistant } from "./client.js";
import { getAssistantContext } from "./context.js";
import { clearHighlight, highlight, runAutopilot, stopAutopilot } from "./driver.js";
import { getRole } from "../api.js";

interface Message {
  id: number;
  role: "user" | "assistant";
  /** Wypełnione dla wiadomości użytkownika. */
  text?: string;
  /** Wypełnione dla odpowiedzi asystenta — pełna struktura, nie sam tekst. */
  reply?: AssistantReply;
}

const SUGGESTIONS = [
  "Jak przyjąć towar na magazyn?",
  "Gdzie sprawdzę stany?",
  "Jak zrobić przesunięcie MM?",
];

let msgId = 0;

export function AssistantBubble() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [driving, setDriving] = useState(false);
  const [krok, setKrok] = useState<number | null>(null);
  const navigate = useNavigate();

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Autoprzewijanie do najnowszej wiadomości. Bez tego nowe odpowiedzi
  // chowają się pod dolną krawędzią panelu.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  // Kursor w polu zaraz po otwarciu — użytkownik ma pisać, nie klikać.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Escape zamyka panel. Standard, którego ludzie odruchowo próbują.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function send(text: string): Promise<void> {
    const question = text.trim();
    if (!question || busy) return;

    setMessages((m) => [...m, { id: ++msgId, role: "user", text: question }]);
    setInput("");
    setBusy(true);

    try {
      // Kontekst z UI: ekran, pola formularza, ostatni błąd, rola.
      // To on odróżnia asystenta w aplikacji od zwykłego czatu.
      const context = getAssistantContext(getRole() as Role);
      const reply = await askAssistant({ question, context });
      setMessages((m) => [...m, { id: ++msgId, role: "assistant", reply }]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        {
          id: ++msgId,
          role: "assistant",
          reply: {
            text: "Nie udało się połączyć z asystentem. Spróbuj ponownie za chwilę.",
            steps: [],
            sources: [],
            refused: true,
          },
        },
      ]);
      console.error(e);
    } finally {
      setBusy(false);
    }
  }

  /** Tryb "prowadź mnie": podświetla kolejne elementy, nic nie klika. */
  async function pokazKroki(reply: AssistantReply): Promise<void> {
    setDriving(true);
    try {
      for (let i = 0; i < reply.steps.length; i++) {
        const a = reply.steps[i]?.anchor;
        if (!a) continue;
        setKrok(i);
        const ok = await highlight(a, 0);
        if (!ok) break;
        await new Promise((r) => setTimeout(r, 1400));
      }
    } finally {
      clearHighlight();
      setKrok(null);
      setDriving(false);
    }
  }

  /** Tryb autopilota: te same kroki, ale z akcjami i kursorem. */
  async function wykonaj(reply: AssistantReply): Promise<void> {
    setDriving(true);
    await runAutopilot(reply.steps, navigate, {
      onStep: (i) => setKrok(i),
      onError: (i, powod) => {
        setMessages((m) => [
          ...m,
          {
            id: ++msgId,
            role: "assistant",
            reply: { text: `Zatrzymałem się na kroku ${i + 1}: ${powod}`, steps: [], sources: [], refused: true },
          },
        ]);
      },
      onDone: () => {
        setKrok(null);
        setDriving(false);
      },
    });
  }

  if (!open) {
    return (
      <button
        className="assistant-launcher"
        data-assistant-id="btn.assistant-open"
        onClick={() => setOpen(true)}
        aria-label="Otwórz asystenta"
        title="Asystent — zapytaj, jak coś zrobić"
      >
        <span className="ico" aria-hidden="true">✦</span>
        Asystent
      </button>
    );
  }

  return (
    <section className="assistant-panel" aria-label="Asystent systemu">
      <header className="assistant-head">
        <div className="title">
          <span className="ico" aria-hidden="true">✦</span>
          Asystent
          <span className="tag">moduł magazynowy</span>
        </div>
        <div className="head-actions">
          {messages.length > 0 && (
            <button
              className="icon-btn"
              onClick={() => setMessages([])}
              title="Wyczyść rozmowę"
              aria-label="Wyczyść rozmowę"
            >
              ⟲
            </button>
          )}
          <button
            className="icon-btn"
            data-assistant-id="btn.assistant-close"
            onClick={() => setOpen(false)}
            title="Zamknij (Esc)"
            aria-label="Zamknij asystenta"
          >
            ✕
          </button>
        </div>
      </header>

      <div className="assistant-log" ref={listRef} role="log" aria-live="polite">
        {messages.length === 0 && (
          <div className="assistant-intro">
            <p>
              Zapytaj, jak wykonać zadanie w module magazynowym. Odpowiem krokami
              opartymi na dokumentacji systemu.
            </p>
            <div className="chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip-btn" onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="msg user">
              {m.text}
            </div>
          ) : (
            <div key={m.id} className={`msg bot ${m.reply?.refused ? "refused" : ""}`}>
              <p className="lead">{m.reply?.text}</p>

              {m.reply && m.reply.steps.length > 0 && (
                <ol className="steps">
                  {m.reply.steps.map((s, i) => (
                    <li key={i} className={krok === i ? "aktywny" : ""}>
                      {s.text}
                      {s.note && <span className="note">{s.note}</span>}
                    </li>
                  ))}
                </ol>
              )}

              {m.reply && m.reply.steps.length > 0 && (
                <div className="msg-actions">
                  <button
                    className="sm"
                    disabled={driving}
                    onClick={() => void pokazKroki(m.reply!)}
                  >
                    Pokaż mi to
                  </button>
                  <button
                    className="sm primary"
                    disabled={driving}
                    onClick={() => void wykonaj(m.reply!)}
                  >
                    Zrób za mnie
                  </button>
                </div>
              )}

              {m.reply && m.reply.sources.length > 0 && (
                <div className="sources" title="Dokumenty, na których oparta jest odpowiedź">
                  {m.reply.sources.map((s) => (
                    <span key={s} className="src">{s}</span>
                  ))}
                </div>
              )}
            </div>
          ),
        )}

        {busy && (
          <div className="msg bot typing" aria-label="Asystent pisze">
            <span /><span /><span />
          </div>
        )}
      </div>

      {driving && (
        <div className="assistant-driving-bar">
          <span>Asystent pokazuje krok {(krok ?? 0) + 1}…</span>
          <button className="sm" onClick={() => stopAutopilot()}>Zatrzymaj</button>
        </div>
      )}

      <div className="assistant-input">
        <textarea
          ref={inputRef}
          data-assistant-id="field.assistant-question"
          value={input}
          rows={1}
          placeholder="Zapytaj, jak coś zrobić…"
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter wysyła, Shift+Enter łamie linię. Bez preventDefault
            // pole zachowywałoby się nieprzewidywalnie.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
            // Klawisze nie mogą uciekać do globalnych skrótów formularza
            // (F2 zapis, F3 zatwierdzenie, Insert nowa pozycja).
            e.stopPropagation();
          }}
        />
        <button
          className="primary"
          data-assistant-id="btn.assistant-send"
          disabled={busy || input.trim() === ""}
          onClick={() => void send(input)}
        >
          Wyślij
        </button>
      </div>
    </section>
  );
}
