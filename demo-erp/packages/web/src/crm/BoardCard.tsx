/**
 * BoardCard.tsx — kafelek zapytania na tablicy.
 *
 * Projekt podporządkowany jednemu założeniu: na ekranie może być sto takich
 * kafelków naraz. Stąd stała wysokość wiersza, jeden krój i ostry limit
 * kolorów — kolor pojawia się tam, gdzie coś wymaga reakcji (szyna etapu,
 * pasek problemu, ikona kalendarza). Tło można dodatkowo pokolorować w
 * ustawieniach tablicy, ale domyślnie kafelek bez problemów jest szary
 * i nudny, dzięki czemu te z problemem widać z drugiego końca sali.
 *
 * Trzy rzeczy, które wyglądają na drobiazgi, a nie są:
 *  - pasek problemu idzie przez CAŁĄ szerokość kafelka, pod szyną etapów;
 *    ucięty przy szynie czytał się jak element etapu, a nie sprawy,
 *  - dymek problemu renderujemy w `position: fixed`, bo w kolumnie z
 *    przewijaniem każdy inny sposób kończy się przycięciem komunikatu,
 *  - dymek ma kolor wagi problemu: czerwony błąd → czerwony dymek.
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
    autorWiadomosci,
    nieprzeczytane,
    CRM_PIPELINE,
    CRM_STAGE_LABELS,
    CRM_STAGE_MICRO,
    URGENCY_LABELS,
    pilnosc,
    pulsKafelka,
    wykryjProblemy,
} from "@demo-erp/shared";
import type { CrmEmployee, CrmIssue, CrmRequest } from "@demo-erp/shared";
import type { ColorMode } from "./boardPrefs.js";
import { czasWzgledny, dataPL } from "./format.js";
import { getUserId } from "../api.js";

export const kwotaPL = (v: number | null): string =>
    v == null
        ? "—"
        : `${v.toLocaleString("pl-PL", {
            minimumFractionDigits: v % 1 === 0 ? 0 : 2,
            maximumFractionDigits: 2,
        })} PLN`;

/** Ikona kalendarza przy dacie wpłynięcia; kolor niesie pilność sprawy. */
function IkonaKalendarza({ className, title }: { className: string; title: string }) {
    return (
        <svg className={className} viewBox="0 0 14 14" aria-hidden="true" focusable="false">
            <title>{title}</title>
            <rect x="1.5" y="2.5" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path d="M1.5 5.5h11" stroke="currentColor" strokeWidth="1.2" />
            <path d="M4.5 1v2.4M9.5 1v2.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
    );
}

/** Szyna etapów: sześć segmentów, zapalone do bieżącego etapu włącznie. */
function StageRail({ req, problem }: { req: CrmRequest; problem: CrmIssue | undefined }) {
    const idx = CRM_PIPELINE.indexOf(req.stage as (typeof CRM_PIPELINE)[number]);
    const przegrane = req.stage === "lost";

    return (
        <div className="bc-rail" aria-hidden="true">
            {CRM_PIPELINE.map((s, i) => {
                const zrobiony = !przegrane && idx >= 0 && i <= idx;
                const problemTu = problem?.stage === s;
                const klasa = problemTu
                    ? problem?.severity === "error"
                        ? "bc-seg err"
                        : "bc-seg warn"
                    : zrobiony
                        ? "bc-seg on"
                        : "bc-seg";
                return <span key={s} className={klasa} title={CRM_STAGE_LABELS[s]} />;
            })}
        </div>
    );
}

/**
 * Dymek z listą problemów. Pozycjonowany `fixed` względem znacznika, bo
 * kolumna tablicy przewija się i ma `overflow`, a komunikat przycięty przy
 * krawędzi karty jest gorszy niż jego brak — sugeruje, że system coś mówi,
 * ale nie wiadomo co.
 */
function IssuePopover({ issues, anchor }: { issues: CrmIssue[]; anchor: DOMRect }) {
    const box = useRef<HTMLDivElement>(null);
    const [poz, setPoz] = useState({ left: anchor.right + 8, top: anchor.top - 4 });

    useLayoutEffect(() => {
        const el = box.current;
        if (!el) return;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        // Jeśli po prawej nie ma miejsca, dymek przeskakuje na lewo od znacznika.
        const left =
            anchor.right + 8 + w > window.innerWidth - 8 ? Math.max(8, anchor.left - w - 8) : anchor.right + 8;
        const top = Math.min(Math.max(8, anchor.top - 4), window.innerHeight - h - 8);
        setPoz({ left, top });
    }, [anchor]);

    const waga = issues.some((i) => i.severity === "error") ? "error" : "warn";

    return (
        <div ref={box} className={`bc-pop ${waga}`} role="tooltip" style={{ left: poz.left, top: poz.top }}>
            <p className="bc-pop-h">
                {issues.length === 1 ? "Problem sprawy" : `Problemy sprawy (${issues.length})`}
            </p>
            <ul>
                {issues.map((i) => (
                    <li key={i.id} className={`${i.severity}${i.waitingSince ? " waiting" : ""}`}>
                        <strong>{i.title}.</strong> {i.message}
                        {i.waitingSince && <small>Prośbę wysłano {czasWzgledny(i.waitingSince)}.</small>}
                    </li>
                ))}
            </ul>
        </div>
    );
}

function IssueMarker({ issues }: { issues: CrmIssue[] }) {
    const [anchor, setAnchor] = useState<DOMRect | null>(null);
    const btn = useRef<HTMLButtonElement>(null);

    const pokaz = useCallback(() => {
        if (btn.current) setAnchor(btn.current.getBoundingClientRect());
    }, []);

    if (issues.length === 0) return null;
    const najwazniejszy = issues[0]!;

    return (
        <>
            <button
                ref={btn}
                type="button"
                className={`bc-marker ${najwazniejszy.severity}`}
                aria-label={`Problemy sprawy: ${issues.length}. ${najwazniejszy.message}`}
                onMouseEnter={pokaz}
                onMouseLeave={() => setAnchor(null)}
                onFocus={pokaz}
                onBlur={() => setAnchor(null)}
                onClick={(e) => e.stopPropagation()}
                data-assistant-id={`crm-issue-marker-${najwazniejszy.id}`}
            >
                !
            </button>
            {anchor && <IssuePopover issues={issues} anchor={anchor} />}
        </>
    );
}

/** Klasa tła kafelka według wybranego trybu kolorowania. */
function klasaKoloru(req: CrmRequest, mode: ColorMode, employees: CrmEmployee[]): string {
    switch (mode) {
        case "urgency":
            return `tint-u-${pilnosc(req)}`;
        case "stage":
            return `tint-s-${req.stage}`;
        case "assignee": {
            if (!req.assigneeId) return "tint-a-none";
            const i = employees.findIndex((e) => e.id === req.assigneeId);
            return `tint-a-${i < 0 ? "none" : i % 6}`;
        }
        case "value": {
            const v = req.quoteValue ?? 0;
            if (v >= 250_000) return "tint-v-3";
            if (v >= 100_000) return "tint-v-2";
            if (v > 0) return "tint-v-1";
            return "tint-v-0";
        }
        default:
            return "";
    }
}

/**
 * Ikona nowej korespondencji. Kolor mówi, od kogo przyszła, bo to zmienia
 * pilność: pismo klienta wymaga odpowiedzi, pismo kierownika trzeba przeczytać,
 * a notatka kolegi zwykle tylko odnotować.
 */
function IkonaPoczty({ rodzaj }: { rodzaj: "klient" | "kierownik" | "wspolpracownik" }) {
    const tytul =
        rodzaj === "klient"
            ? "Nowa wiadomość od klienta"
            : rodzaj === "kierownik"
                ? "Nowa wiadomość od kierownika lub project managera"
                : "Nowa wiadomość od innego kosztorysanta";
    return (
        <span className={`bc-mail ${rodzaj}`} title={tytul} aria-label={tytul}>
      <svg viewBox="0 0 16 12" aria-hidden="true" focusable="false">
        <rect x="1" y="1" width="14" height="10" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M1.5 1.7 8 6.5l6.5-4.8" fill="none" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    </span>
    );
}

/** Zegar dla zapytania, które zbyt długo czeka bez przypisania. */
function IkonaOczekiwania({ dni }: { dni: number }) {
    const tytul = `Zapytanie czeka w kolumnie Nowe już ${dni} dni`;
    return (
        <span className="bc-age" title={tytul} aria-label={tytul}>
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 4.6v3.7l2.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </span>
    );
}

export interface BoardCardProps {
    req: CrmRequest;
    /** Wszyscy kosztorysanci sprawy, w kolejności wejścia. */
    przypisani: CrmEmployee[];
    employees: CrmEmployee[];
    colorMode: ColorMode;
    wylaczoneReguly: string[];
    onOpen: (id: string) => void;
    onAction: (req: CrmRequest, issue: CrmIssue) => void;
    onDragStart: (id: string) => void;
    onDragEnd: () => void;
    dragging: boolean;
}

export function BoardCard({
                              req,
                              przypisani,
                              employees,
                              colorMode,
                              wylaczoneReguly,
                              onOpen,
                              onAction,
                              onDragStart,
                              onDragEnd,
                              dragging,
                          }: BoardCardProps) {
    const jaId = getUserId();
    const issues = wykryjProblemy(req, undefined, wylaczoneReguly);
    const puls = pulsKafelka(req);
    const pil = pilnosc(req);
    const wejscieDoNowych = Date.parse(req.columnEnteredAt || req.createdAt);
    const dniWNowych = req.columnId === "col-new" && Number.isFinite(wejscieDoNowych)
        ? Math.floor((Date.now() - wejscieDoNowych) / 86_400_000)
        : 0;
    const zalegleNowe = dniWNowych > 14;
    /**
     * Najnowsza nieprzeczytana wiadomość decyduje o ikonie. Sama ikona wystarczy —
     * kafelek z nową pocztą już nie pulsuje, bo migotanie zarezerwowane jest dla
     * terminów i nowych zapytań; trzeci powód do migania odbierał znaczenie
     * dwóm pierwszym.
     */
    const nowe = nieprzeczytane(req.messages, jaId);
    const ostatniaNowa = nowe.at(-1);
    const nowaPoczta: "klient" | "kierownik" | "wspolpracownik" | null = ostatniaNowa
        ? (() => {
            const a = autorWiadomosci(ostatniaNowa, jaId, employees);
            return a === "klient" || a === "kierownik" || a === "wspolpracownik" ? a : null;
        })()
        : null;

    const glowny = issues[0];
    // Czy o to samo już prosiliśmy? Przycisk ma o tym mówić, ale nie blokować —
    // ponowienie bywa właśnie tym, co trzeba zrobić.
    const kluczSzablonu: Record<string, string> = {
        email_address: "address",
        email_attachments: "attachments",
        email_data: "missing_data",
    };
    const szukanyKlucz = glowny?.action ? kluczSzablonu[glowny.action] : undefined;
    const juzWyslano = szukanyKlucz
        ? [...req.messages].reverse().find((m) => m.templateKey === szukanyKlucz && m.sentAt)
        : undefined;

    return (
        <article
            className={`bc puls-${puls} ${klasaKoloru(req, colorMode, employees)}${
                dragging ? " ciagniete" : ""
            }`}
            draggable
            onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", req.id);
                e.dataTransfer.effectAllowed = "move";
                onDragStart(req.id);
            }}
            onDragEnd={onDragEnd}
            onClick={() => onOpen(req.id)}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpen(req.id);
                }
            }}
            tabIndex={0}
            role="button"
            aria-label={`${req.projectName}, ${req.companyName}, ${kwotaPL(req.quoteValue)}${
                nowaPoczta ? ", nowa wiadomość" : ""
            }`}
            data-assistant-id={`crm-card-${req.number}`}
        >
            <div className="bc-main">
                <StageRail req={req} problem={glowny} />

                <div className="bc-body">
                    <div className="bc-top">
                        <IkonaKalendarza className={`bc-cal ${pil}`} title={URGENCY_LABELS[pil]} />
                        <span
                            className={`bc-date${zalegleNowe ? " stale" : ""}`}
                            title={zalegleNowe ? `Bez przypisania od ${dniWNowych} dni` : undefined}
                        >
                          {dataPL(req.createdAt)}
                        </span>
                        {zalegleNowe && <IkonaOczekiwania dni={dniWNowych} />}
                        {issues.length > 0 && <IssueMarker issues={issues} />}
                        {nowaPoczta && <IkonaPoczty rodzaj={nowaPoczta} />}
                        <span className={`bc-score ${req.score >= 60 ? "hi" : req.score >= 35 ? "mid" : "lo"}`}>
              {req.score}%
            </span>
                    </div>

                    <h3 className="bc-project">{req.projectName}</h3>
                    <p className="bc-company">{req.companyName}</p>

                    <div className="bc-sep" />

                    {/* Lista, nie jedno nazwisko: kafelek pokazuje wszystkich, którzy
              mieli styczność ze sprawą, a ostatni jest bieżącym opiekunem. */}
                    <div className="bc-people">
                        {przypisani.length === 0 ? (
                            <p className="bc-person muted">Bez przypisania</p>
                        ) : (
                            przypisani.map((e, i) => (
                                <p
                                    key={e.id}
                                    className={`bc-person${i === przypisani.length - 1 ? " biezacy" : " wczesniejszy"}`}
                                    title={i === przypisani.length - 1 ? "Bieżący kosztorysant" : "Wcześniej prowadził sprawę"}
                                >
                                    <span className="bc-arrow">↳</span> {e.name}
                                    {i === przypisani.length - 1 ? " · kosztorysant" : ""}
                                </p>
                            ))
                        )}
                    </div>

                    <div className="bc-bottom">
                        <span className="bc-value">{kwotaPL(req.quoteValue)}</span>
                        <span className="bc-stage-now">{CRM_STAGE_MICRO[req.stage]}</span>
                        <button
                            type="button"
                            className="bc-details"
                            title="Pokaż szczegóły"
                            aria-label={`Szczegóły zapytania ${req.number}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                onOpen(req.id);
                            }}
                            data-assistant-id={`crm-card-details-${req.number}`}
                        >
                            ⤢
                        </button>
                    </div>
                </div>
            </div>

            {glowny && (
                <div className={`bc-issue ${glowny.severity}${glowny.waitingSince ? " waiting" : ""}`} onClick={(e) => e.stopPropagation()}>
          <span className="bc-issue-ico" aria-hidden="true">
            {glowny.severity === "error" ? "!" : "△"}
          </span>
                    <span className="bc-issue-text" title={glowny.message}>
            {glowny.title}
          </span>
                    {glowny.waitingSince && (
                        <span className="bc-issue-wait">prośbę wysłano {czasWzgledny(glowny.waitingSince)}</span>
                    )}
                    {issues.length > 1 && <span className="bc-issue-more">+{issues.length - 1}</span>}
                    {glowny.action && (
                        <button
                            type="button"
                            className={`bc-issue-act${juzWyslano ? " wyslano" : ""}${glowny.waitingSince ? " waiting" : ""}`}
                            onClick={() => onAction(req, glowny)}
                            title={
                                juzWyslano
                                    ? `Prośbę wysłano już ${czasWzgledny(juzWyslano.sentAt)} — kliknij, aby zobaczyć i ewentualnie ponowić.`
                                    : undefined
                            }
                            data-assistant-id={`crm-card-action-${glowny.id}`}
                        >
                            {juzWyslano ? `✓ Wysłano ${czasWzgledny(juzWyslano.sentAt)}` : glowny.actionLabel}
                        </button>
                    )}
                </div>
            )}
        </article>
    );
}
