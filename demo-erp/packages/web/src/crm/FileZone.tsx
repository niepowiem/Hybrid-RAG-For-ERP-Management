/**
 * FileZone.tsx — dołączanie plików przeciągnięciem albo z okna wyboru.
 *
 * Jedna kontrolka na oba sposoby: przeciąganie jest szybsze, gdy plik leży na
 * pulpicie, a okno wyboru niezbędne, gdy trzeba go poszukać w drzewie
 * katalogów. Rozdzielanie tego na dwa osobne elementy („przeciągnij tutaj”
 * obok „wybierz plik”) zmusza do decyzji, zanim wiadomo, co się wybiera.
 *
 * Wersja demonstracyjna zapisuje nazwę i rozmiar pliku, nie jego treść —
 * mówimy o tym wprost pod polem, zamiast udawać przesyłanie.
 */

import { useRef, useState } from "react";

export interface PlikMeta {
    name: string;
    sizeKb: number;
}

/** Duża, jednoznaczna ikona spinacza — ma się rzucać w oczy. */
function IkonaSpinacza() {
    return (
        <svg className="fz-svg" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
            <path
                d="M21.5 9.5 12 19a3.2 3.2 0 0 0 4.5 4.5l9.8-9.8a5.6 5.6 0 0 0-8-8L8 15.2a8 8 0 0 0 11.3 11.3l7.4-7.4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
            />
        </svg>
    );
}

export function StrefaPlikow({
                                 pliki,
                                 onChange,
                                 naglowek,
                                 hint = "Wersja demonstracyjna zapisuje nazwę i rozmiar pliku, nie jego treść.",
                                 compact = false,
                             }: {
    pliki: PlikMeta[];
    onChange: (p: PlikMeta[]) => void;
    naglowek?: string;
    hint?: string;
    /** Zwarta odmiana do pola rozmowy — nadal obsługuje kliknięcie i drag-and-drop. */
    compact?: boolean;
}) {
    const [nad, setNad] = useState(false);
    const input = useRef<HTMLInputElement>(null);

    const dodaj = (lista: FileList | null): void => {
        const nowe = Array.from(lista ?? []).map((f) => ({
            name: f.name,
            sizeKb: Math.max(1, Math.round(f.size / 1024)),
        }));
        if (nowe.length > 0) onChange([...pliki, ...nowe]);
    };

    return (
        <div className={`fz${compact ? " compact" : ""}`}>
            <div
                className={`fz-drop${nad ? " nad" : ""}`}
                onDragOver={(e) => {
                    e.preventDefault();
                    setNad(true);
                }}
                onDragLeave={() => setNad(false)}
                onDrop={(e) => {
                    e.preventDefault();
                    setNad(false);
                    dodaj(e.dataTransfer.files);
                }}
                onClick={() => input.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        input.current?.click();
                    }
                }}
                data-assistant-id="crm-filezone"
            >
                <IkonaSpinacza />
                <span className="fz-text">
          {naglowek && <strong className="fz-h">{naglowek}</strong>}
                    <span>
            {compact ? "Upuść pliki lub wybierz z dysku" : <>Przeciągnij pliki tutaj albo <u>wybierz z dysku</u></>}
          </span>
        </span>
                <input
                    ref={input}
                    type="file"
                    multiple
                    hidden
                    onChange={(e) => {
                        dodaj(e.target.files);
                        e.target.value = "";
                    }}
                />
            </div>

            {pliki.length > 0 && (
                <ul className="fz-list">
                    {pliki.map((p, i) => (
                        <li key={`${p.name}-${i}`}>
                            <span className="fz-n">▤ {p.name}</span>
                            <span className="fz-s">{p.sizeKb} kB</span>
                            <button
                                type="button"
                                onClick={() => onChange(pliki.filter((_, n) => n !== i))}
                                aria-label={`Usuń ${p.name}`}
                            >
                                ✕
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {hint && <p className="dr-meta">{hint}</p>}
        </div>
    );
}
