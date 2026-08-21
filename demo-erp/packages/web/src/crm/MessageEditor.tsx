/**
 * MessageEditor.tsx — edytor treści z podświetlaniem podstawień W TRAKCIE pisania.
 *
 * Problem: `textarea` nie umie kolorować fragmentów tekstu, a `contentEditable`
 * niszczy zawartość przy każdym wklejeniu i psuje historię cofania. Używamy
 * więc techniki lustra: pod przezroczystym polem tekstowym leży `div`
 * z identyczną typografią i tą samą treścią, tylko z pokolorowanymi
 * fragmentami. Kursor, zaznaczanie i przewijanie zostają natywne — kolor jest
 * warstwą pod spodem, nie zamiast pola.
 *
 * Warunek działania: obie warstwy MUSZĄ mieć ten sam krój, rozmiar, interlinię,
 * padding, obramowanie i zawijanie. Stąd wspólna klasa `.me-layer` w CSS —
 * każda różnica przesuwa tekst względem podświetlenia.
 *
 * Kolor podświetlenia odpowiada kategorii danych (osoby, sprawa, produkty,
 * braki, firma), a legenda pod polem tłumaczy, co znaczy który kolor.
 */

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { TOKEN_CATEGORY_LABELS } from "@demo-erp/shared";
import type { TokenCategory } from "@demo-erp/shared";

export interface Podstawienie {
    token: string;
    value: string;
    category: TokenCategory;
    /** Opcjonalna etykieta w legendzie — np. nazwa pozycji w outsourcingu. */
    label?: string;
}

export interface KolorowanyFragment {
    text: string;
    cat: TokenCategory | null;
    /** Dodatkowa klasa — np. numer pozycji do wyceny. */
    extra?: string;
}

/** Dzieli tekst na fragmenty stałe i podstawione — dłuższe wartości najpierw. */
export function podziel(text: string, podstawienia: Podstawienie[]): KolorowanyFragment[] {
    const wartosci = [...podstawienia]
        .filter((p) => p.value.trim().length > 2)
        .sort((a, b) => b.value.length - a.value.length);
    if (wartosci.length === 0) return [{ text, cat: null }];

    let czesci: KolorowanyFragment[] = [{ text, cat: null }];
    for (const p of wartosci) {
        const nowe: KolorowanyFragment[] = [];
        for (const cz of czesci) {
            if (cz.cat !== null || !cz.text.includes(p.value)) {
                nowe.push(cz);
                continue;
            }
            const kawalki = cz.text.split(p.value);
            kawalki.forEach((k, i) => {
                if (k !== "") nowe.push({ text: k, cat: null });
                if (i < kawalki.length - 1) nowe.push({ text: p.value, cat: p.category, extra: p.token });
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

/**
 * Pole edycji z podświetleniem pod spodem. Podświetlenie żyje w trakcie
 * pisania: gdy tekst przestaje pasować do podstawionej wartości, kolor po
 * prostu znika z tego fragmentu — bez trybów i bez przełączników.
 */
export function PoleZPodswietleniem({
                                        value,
                                        onChange,
                                        podstawienia,
                                        rows = 12,
                                        id,
                                        placeholder,
                                    }: {
    value: string;
    onChange: (v: string) => void;
    podstawienia: Podstawienie[];
    rows?: number;
    id?: string;
    placeholder?: string;
}) {
    const pole = useRef<HTMLTextAreaElement>(null);
    const lustro = useRef<HTMLDivElement>(null);
    const czesci = useMemo(() => podziel(value, podstawienia), [value, podstawienia]);

    // Lustro musi przewijać się razem z polem, inaczej kolor „odjeżdża”
    // od tekstu przy dłuższej treści.
    useLayoutEffect(() => {
        const t = pole.current;
        const m = lustro.current;
        if (!t || !m) return;
        const sync = (): void => {
            m.scrollTop = t.scrollTop;
            m.scrollLeft = t.scrollLeft;
        };
        t.addEventListener("scroll", sync);
        sync();
        return () => t.removeEventListener("scroll", sync);
    }, []);

    return (
        <div className="me-wrap">
            <div className="me-layer me-mirror" ref={lustro} aria-hidden="true">
                {czesci.map((cz, i) =>
                    cz.cat ? (
                        <mark key={i} className={`me-tok tok-${cz.cat}`}>
                            {cz.text}
                        </mark>
                    ) : (
                        <span key={i}>{cz.text}</span>
                    ),
                )}
                {/* Końcowa spacja pilnuje wysokości lustra przy pustej ostatniej linii. */}
                <span>{"\u200b"}</span>
            </div>
            <textarea
                ref={pole}
                className="me-layer me-input"
                rows={rows}
                value={value}
                placeholder={placeholder}
                onChange={(e) => onChange(e.target.value)}
                onScroll={() => {
                    if (lustro.current && pole.current) lustro.current.scrollTop = pole.current.scrollTop;
                }}
                spellCheck={false}
                data-assistant-id={id}
            />
        </div>
    );
}

/** Legenda kolorów — pionowa lista, żeby było jasne, że to objaśnienie. */
export function LegendaTokenow({ podstawienia }: { podstawienia: Podstawienie[] }) {
    const kategorie = useMemo(() => {
        const mapa = new Map<TokenCategory, string[]>();
        for (const p of podstawienia) {
            if (p.value.trim().length <= 2) continue;
            const lista = mapa.get(p.category) ?? [];
            if (!lista.includes(p.value)) lista.push(p.value);
            mapa.set(p.category, lista);
        }
        return [...mapa.entries()];
    }, [podstawienia]);

    if (kategorie.length === 0) return null;

    return (
        <div className="me-legend">
            <p className="me-legend-h">Legenda — kolory oznaczają dane wstawione przez system</p>
            <ul>
                {kategorie.map(([kat, wartosci]) => (
                    <li key={kat}>
                        <span className={`me-tok tok-${kat}`}>{TOKEN_CATEGORY_LABELS[kat]}</span>
                        <span className="me-legend-v">{wartosci.slice(0, 3).join(" · ")}</span>
                    </li>
                ))}
            </ul>
            <p className="me-legend-note">
                Po ręcznej zmianie fragmentu podświetlenie znika — to znaczy, że tekst nie pochodzi już
                z danych sprawy.
            </p>
        </div>
    );
}

export interface MessageEditorProps {
    to: string;
    cc?: string[];
    subject: string;
    body: string;
    podstawienia: Podstawienie[];
    account?: string;
    /** Adresy do podpowiedzi w polu DW (kontakty klienta). */
    dostepneKontakty?: { email: string; name: string }[];
    onToChange?: (v: string) => void;
    onCcChange?: (v: string[]) => void;
    onSubjectChange: (v: string) => void;
    onBodyChange: (v: string) => void;
    readOnlyTo?: boolean;
    /** Legenda kolorów — zbędna tam, gdzie treść pisze się od zera. */
    pokazLegende?: boolean;
    /**
     * Przełącznik „Podgląd / Edycja”. Przy treści z szablonu podgląd pokazuje
     * pełne podświetlenie podstawień, także tych, których nie da się odtworzyć
     * z samego tekstu pola — dlatego w oknach szybkich akcji jest włączony.
     */
    zTrybami?: boolean;
}

export function MessageEditor({
                                  to,
                                  cc = [],
                                  subject,
                                  body,
                                  podstawienia,
                                  account,
                                  dostepneKontakty = [],
                                  onToChange,
                                  onCcChange,
                                  onSubjectChange,
                                  onBodyChange,
                                  readOnlyTo = false,
                                  pokazLegende = true,
                                  zTrybami = false,
                              }: MessageEditorProps) {
    const [nowyCc, setNowyCc] = useState("");
    const [tryb, setTryb] = useState<"podglad" | "edycja">(zTrybami ? "podglad" : "edycja");
    const wolne = dostepneKontakty.filter((k) => k.email !== to && !cc.includes(k.email));

    return (
        <div className="me">
            {account && (
                <p className="me-from">
                    <span className="me-from-l">Z konta</span> {account}
                    <span className="me-provider">Outlook</span>
                </p>
            )}

            <label className="dr-field me-row me-row-to">
                <span>Do</span>
                <input
                    value={to}
                    readOnly={readOnlyTo}
                    onChange={(e) => onToChange?.(e.target.value)}
                    data-assistant-id="crm-msg-to"
                />
            </label>

            {onCcChange && (
                <div className="dr-field me-row me-row-cc">
                    <span>DW</span>
                    <div className="me-cc">
                        {cc.map((adres) => (
                            <span key={adres} className="me-cc-chip">
                {adres}
                                <button
                                    type="button"
                                    onClick={() => onCcChange(cc.filter((x) => x !== adres))}
                                    aria-label={`Usuń ${adres}`}
                                >
                  ✕
                </button>
              </span>
                        ))}
                        <input
                            list="me-kontakty"
                            value={nowyCc}
                            placeholder={cc.length === 0 ? "dodaj adres i naciśnij Enter" : "dodaj kolejny…"}
                            onChange={(e) => setNowyCc(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key !== "Enter" && e.key !== ",") return;
                                e.preventDefault();
                                const adres = nowyCc.trim();
                                if (adres !== "" && !cc.includes(adres)) onCcChange([...cc, adres]);
                                setNowyCc("");
                            }}
                            onBlur={() => {
                                const adres = nowyCc.trim();
                                if (adres !== "" && !cc.includes(adres)) onCcChange([...cc, adres]);
                                setNowyCc("");
                            }}
                            data-assistant-id="crm-msg-cc"
                        />
                        <datalist id="me-kontakty">
                            {wolne.map((k) => (
                                <option key={k.email} value={k.email}>
                                    {k.name}
                                </option>
                            ))}
                        </datalist>
                    </div>
                </div>
            )}

            <label className="dr-field me-row me-row-subject">
                <span>Temat</span>
                {zTrybami && tryb === "podglad" ? (
                    <PodgladTresci text={subject} podstawienia={podstawienia} />
                ) : (
                    <input
                        value={subject}
                        onChange={(e) => onSubjectChange(e.target.value)}
                        data-assistant-id="crm-msg-subject"
                    />
                )}
            </label>

            <div className="dr-field me-row me-row-body">
                <div className="me-body-head">
                    <span>Treść</span>
                    {zTrybami && (
                        <div className="me-tabs" aria-label="Tryb treści wiadomości">
                            <button type="button" className={tryb === "podglad" ? "on" : ""} onClick={() => setTryb("podglad")}>
                                Podgląd
                            </button>
                            <button type="button" className={tryb === "edycja" ? "on" : ""} onClick={() => setTryb("edycja")}>
                                Edycja
                            </button>
                        </div>
                    )}
                </div>
                {zTrybami && tryb === "podglad" ? (
                    <PodgladTresci text={body} podstawienia={podstawienia} />
                ) : (
                    <PoleZPodswietleniem
                        value={body}
                        onChange={onBodyChange}
                        podstawienia={podstawienia}
                        id="crm-msg-body"
                    />
                )}
            </div>

            {pokazLegende && <LegendaTokenow podstawienia={podstawienia} />}
        </div>
    );
}
