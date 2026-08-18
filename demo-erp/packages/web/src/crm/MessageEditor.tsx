/**
 * MessageEditor.tsx — edytor treści wiadomości z podświetlaniem podstawień.
 *
 * Problem, który rozwiązuje: człowiek dostaje gotowy tekst i nie wie, co
 * w nim napisał system, a co jest stałą częścią szablonu. Podświetlamy więc
 * wartości podstawione za znaczniki, kolorem według kategorii (osoby, dane
 * sprawy, zakres, braki, nasza firma) — widać wtedy od razu, że „Jakub
 * Kowalski” i „ZAP-2026-0003” to dane wstawione automatycznie i że to je
 * trzeba sprawdzić przed wysyłką.
 *
 * Podświetlanie działa na WARTOŚCIACH, nie na pozycjach znaków: po pierwszej
 * ręcznej korekcie offsety i tak przestają się zgadzać, a wartości nie.
 * Podgląd i pole edycji są rozdzielone, bo `textarea` nie umie kolorować
 * fragmentów tekstu, a nakładanie warstwy pod spodem rozjeżdża się przy
 * każdej zmianie czcionki czy zawijania wiersza.
 */

import { useMemo, useState } from "react";
import { TOKEN_CATEGORY_LABELS } from "@demo-erp/shared";
import type { TokenCategory } from "@demo-erp/shared";

export interface Podstawienie {
    token: string;
    value: string;
    category: TokenCategory;
}

/** Dzieli tekst na fragmenty stałe i podstawione — dłuższe wartości najpierw. */
function podziel(text: string, podstawienia: Podstawienie[]): { text: string; cat: TokenCategory | null }[] {
    const wartosci = [...podstawienia]
        .filter((p) => p.value.trim().length > 2)
        .sort((a, b) => b.value.length - a.value.length);
    if (wartosci.length === 0) return [{ text, cat: null }];

    let czesci: { text: string; cat: TokenCategory | null }[] = [{ text, cat: null }];
    for (const p of wartosci) {
        const nowe: typeof czesci = [];
        for (const cz of czesci) {
            if (cz.cat !== null || !cz.text.includes(p.value)) {
                nowe.push(cz);
                continue;
            }
            const kawalki = cz.text.split(p.value);
            kawalki.forEach((k, i) => {
                if (k !== "") nowe.push({ text: k, cat: null });
                if (i < kawalki.length - 1) nowe.push({ text: p.value, cat: p.category });
            });
        }
        czesci = nowe;
    }
    return czesci;
}

export function PodgladTresci({
                                  text,
                                  podstawienia,
                              }: {
    text: string;
    podstawienia: Podstawienie[];
}) {
    const czesci = useMemo(() => podziel(text, podstawienia), [text, podstawienia]);
    return (
        <div className="me-preview">
            {czesci.map((cz, i) =>
                cz.cat ? (
                    <mark key={i} className={`me-tok tok-${cz.cat}`} title={TOKEN_CATEGORY_LABELS[cz.cat]}>
                        {cz.text}
                    </mark>
                ) : (
                    <span key={i}>{cz.text}</span>
                ),
            )}
        </div>
    );
}

export function LegendaTokenow({ podstawienia }: { podstawienia: Podstawienie[] }) {
    const kategorie = [...new Set(podstawienia.map((p) => p.category))];
    if (kategorie.length === 0) return null;
    return (
        <p className="me-legend">
            {kategorie.map((k) => (
                <span key={k} className={`me-tok tok-${k}`}>
          {TOKEN_CATEGORY_LABELS[k]}
        </span>
            ))}
            <span className="me-legend-note">— dane podstawione przez system</span>
        </p>
    );
}

export interface MessageEditorProps {
    to: string;
    subject: string;
    body: string;
    podstawienia: Podstawienie[];
    account?: string;
    onToChange?: (v: string) => void;
    onSubjectChange: (v: string) => void;
    onBodyChange: (v: string) => void;
    readOnlyTo?: boolean;
}

export function MessageEditor({
                                  to,
                                  subject,
                                  body,
                                  podstawienia,
                                  account,
                                  onToChange,
                                  onSubjectChange,
                                  onBodyChange,
                                  readOnlyTo = false,
                              }: MessageEditorProps) {
    const [tryb, setTryb] = useState<"podglad" | "edycja">("podglad");

    return (
        <div className="me">
            <div className="me-head">
                {account && (
                    <p className="me-from">
                        <span className="me-from-l">Z konta</span> {account}
                        <span className="me-provider">Outlook</span>
                    </p>
                )}
                <div className="me-tabs">
                    <button
                        type="button"
                        className={tryb === "podglad" ? "on" : ""}
                        onClick={() => setTryb("podglad")}
                    >
                        Podgląd
                    </button>
                    <button
                        type="button"
                        className={tryb === "edycja" ? "on" : ""}
                        onClick={() => setTryb("edycja")}
                    >
                        Edycja
                    </button>
                </div>
            </div>

            <label className="dr-field">
                <span>Do</span>
                <input
                    value={to}
                    readOnly={readOnlyTo}
                    onChange={(e) => onToChange?.(e.target.value)}
                    data-assistant-id="crm-msg-to"
                />
            </label>

            <label className="dr-field">
                <span>Temat</span>
                {tryb === "edycja" ? (
                    <input
                        value={subject}
                        onChange={(e) => onSubjectChange(e.target.value)}
                        data-assistant-id="crm-msg-subject"
                    />
                ) : (
                    <PodgladTresci text={subject} podstawienia={podstawienia} />
                )}
            </label>

            <label className="dr-field">
                <span>Treść</span>
                {tryb === "edycja" ? (
                    <textarea
                        rows={12}
                        value={body}
                        onChange={(e) => onBodyChange(e.target.value)}
                        data-assistant-id="crm-msg-body"
                    />
                ) : (
                    <PodgladTresci text={body} podstawienia={podstawienia} />
                )}
            </label>

            <LegendaTokenow podstawienia={podstawienia} />
        </div>
    );
}