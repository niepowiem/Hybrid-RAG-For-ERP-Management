/**
 * CrmSettings.tsx — ustawienia automatyzacji modułu CRM.
 *
 * Jedno miejsce na to, co w każdej firmie wygląda inaczej: treść wiadomości
 * wychodzących, rytm follow-upów, deklarowany czas odpowiedzi i to, które
 * problemy mają w ogóle świecić na kafelkach.
 *
 * Reguły problemów są przełączalne świadomie. Jeśli w danej firmie rysunek
 * dosyła się zawsze później, ostrzeżenie o braku pliku uczy ludzi ignorowania
 * ostrzeżeń — a wtedy przestają działać także te ważne. Lepiej wyłączyć jedną
 * regułę niż stracić zaufanie do wszystkich.
 *
 * Szablony to tekst ze znacznikami `{{token}}`. Treść zmienia handlowiec,
 * nie programista; lista dostępnych znaczników jest tu obok pola edycji,
 * z kolorami odpowiadającymi kategoriom.
 */

import { useEffect, useState } from "react";
import {
    ISSUE_RULES,
    ISSUE_RULE_LABELS,
    TEMPLATE_LABELS,
    TOKENY,
    TOKEN_CATEGORY_LABELS,
    wypelnijSzablon,
} from "@demo-erp/shared";
import type { CrmSettings, MessageTemplate, TemplateKey } from "@demo-erp/shared";
import { notify } from "../../ui.js";
import { ApiError } from "../../api.js";
import { crmApi } from "../../crm/client.js";
import { PodgladTresci } from "../../crm/MessageEditor.js";

/** Przykładowe dane do podglądu szablonu — realne, żeby było widać efekt. */
const PRZYKLAD: Record<string, string> = {
    "klient.osoba": "Anna Wiśniewska",
    "klient.firma": "Hydromel Sp. z o.o.",
    "kosztorysant.imie": "Jakub Kowalski",
    "kosztorysant.email": "j.kowalski@norderp.pl",
    "kosztorysant.telefon": "+48 95 741 20 34",
    "pm.imie": "Magdalena Nowak",
    "sprawa.numer": "ZAP-2026-0001",
    "sprawa.budowa": "Hala P4 — Gliwice",
    "sprawa.termin": "2026-10-02",
    "sprawa.adres": "ul. Bojkowska 92, 44-100 Gliwice",
    "sprawa.wartosc": "125 999,99 PLN",
    "sprawa.dni": "3",
    produkty: "ramy montażowe",
    ilosc: "60 kpl.",
    "element.nazwa": "Gięcie blach 3 mm",
    "element.opis": "Gięcie wg rysunku, materiał S235JR.",
    "braki.lista": "— telefon kontaktowy\n— termin realizacji",
    "braki.zalaczniki": "— rysunek techniczny",
    "firma.nazwa": "NordERP Sp. z o.o.",
    "firma.telefon": "+48 95 741 20 30",
    "firma.email": "oferty@norderp.pl",
    "firma.adres": "ul. Zakaszewskiego 7, 66-300 Międzyrzecz",
};

export function CrmSettingsPage() {
    const [s, setS] = useState<CrmSettings | null>(null);
    const [blad, setBlad] = useState<string | null>(null);
    const [zapisywanie, setZapisywanie] = useState(false);
    const [otwarty, setOtwarty] = useState<TemplateKey | null>(null);

    useEffect(() => {
        crmApi
            .settings()
            .then(setS)
            .catch((e: unknown) =>
                setBlad(e instanceof ApiError ? e.body.message : "Nie udało się wczytać ustawień."),
            );
    }, []);

    async function zapisz(patch: Partial<CrmSettings>): Promise<void> {
        setZapisywanie(true);
        try {
            const nowe = await crmApi.saveSettings(patch);
            setS(nowe);
            notify("Ustawienia zapisane", "Zmiany obowiązują od następnej operacji.");
        } catch (e) {
            notify("Nie udało się zapisać", e instanceof ApiError ? e.body.message : "Spróbuj ponownie.", "err");
        } finally {
            setZapisywanie(false);
        }
    }

    if (blad) return <p className="crm-note danger">{blad}</p>;
    if (!s) return <p className="muted">Wczytywanie ustawień…</p>;

    const zmienSzablon = (key: TemplateKey, patch: Partial<MessageTemplate>): void =>
        setS({
            ...s,
            templates: s.templates.map((t) => (t.key === key ? { ...t, ...patch } : t)),
        });

    return (
        <section className="page crm-settings">
            <div className="page-head">
                <h1>Ustawienia automatyzacji CRM</h1>
                <span className="spacer" />
                {zapisywanie && <span className="muted">Zapisywanie…</span>}
            </div>

            <div className="card">
                <div className="section-title">Konto pocztowe</div>
                <p className="crm-note">
                    Korespondencja modułu wychodzi z jednej skrzynki działu — dzięki temu odpowiedzi klientów
                    wracają tam, gdzie widzi je cały zespół, a nie do prywatnej skrzynki jednej osoby.
                </p>
                <div className="grid">
                    <div className="f-row">
                        <label htmlFor="set-acc">Adres konta (Outlook)</label>
                        <input
                            id="set-acc"
                            value={s.mailbox.account}
                            onChange={(e) => setS({ ...s, mailbox: { ...s.mailbox, account: e.target.value } })}
                            onBlur={() => void zapisz({ mailbox: s.mailbox })}
                        />
                    </div>
                    <div className="f-row">
                        <label htmlFor="set-disp">Nazwa nadawcy</label>
                        <input
                            id="set-disp"
                            value={s.mailbox.displayName}
                            onChange={(e) => setS({ ...s, mailbox: { ...s.mailbox, displayName: e.target.value } })}
                            onBlur={() => void zapisz({ mailbox: s.mailbox })}
                        />
                    </div>
                </div>
            </div>

            <div className="card">
                <div className="section-title">Automaty</div>
                <div className="grid">
                    <div className="f-row">
                        <label htmlFor="set-fu">Follow-up po ilu dniach w „Wysłanych”</label>
                        <input
                            id="set-fu"
                            type="number"
                            min={1}
                            max={60}
                            value={s.automation.followUpAfterDays}
                            onChange={(e) =>
                                setS({
                                    ...s,
                                    automation: { ...s.automation, followUpAfterDays: Number(e.target.value) },
                                })
                            }
                            onBlur={() => void zapisz({ automation: s.automation })}
                        />
                    </div>
                    <div className="f-row">
                        <label htmlFor="set-resp">Deklarowany czas odpowiedzi (dni robocze)</label>
                        <input
                            id="set-resp"
                            type="number"
                            min={1}
                            max={30}
                            value={s.automation.responseDays}
                            onChange={(e) =>
                                setS({ ...s, automation: { ...s.automation, responseDays: Number(e.target.value) } })
                            }
                            onBlur={() => void zapisz({ automation: s.automation })}
                        />
                    </div>
                </div>

                <div className="crm-switches">
                    {(
                        [
                            ["acknowledgeNewRequests", "Potwierdzaj przyjęcie nowych zapytań"],
                            ["autoSendFollowUp", "Wysyłaj follow-up automatycznie (inaczej tylko szkic)"],
                            ["autoCloseOnRefusal", "Zamykaj sprawę po wyraźnej odmowie klienta"],
                        ] as const
                    ).map(([k, label]) => (
                        <label key={k} className="check">
                            <input
                                type="checkbox"
                                checked={s.automation[k]}
                                onChange={(e) => {
                                    const automation = { ...s.automation, [k]: e.target.checked };
                                    setS({ ...s, automation });
                                    void zapisz({ automation });
                                }}
                                data-assistant-id={`crm-set-${k}`}
                            />
                            {label}
                        </label>
                    ))}
                </div>
            </div>

            <div className="card">
                <div className="section-title">Wykrywane problemy</div>
                <p className="crm-note">
                    Wyłączona reguła przestaje świecić na kafelkach i w panelu sprawy. Jeśli któreś
                    ostrzeżenie nie pasuje do sposobu pracy, lepiej je wyłączyć niż uczyć zespół
                    ignorowania ostrzeżeń.
                </p>
                <div className="crm-switches">
                    {ISSUE_RULES.map((r) => (
                        <label key={r} className="check">
                            <input
                                type="checkbox"
                                checked={s.issues[r] ?? true}
                                onChange={(e) => {
                                    const issues = { ...s.issues, [r]: e.target.checked };
                                    setS({ ...s, issues });
                                    void zapisz({ issues });
                                }}
                                data-assistant-id={`crm-set-issue-${r}`}
                            />
                            {ISSUE_RULE_LABELS[r]}
                        </label>
                    ))}
                </div>
            </div>

            <div className="card">
                <div className="section-title">Szablony wiadomości</div>
                <p className="crm-note">
                    Znaczniki w nawiasach klamrowych system podstawia sam. Podgląd niżej pokazuje szablon
                    wypełniony przykładowymi danymi — podświetlone fragmenty to właśnie podstawienia.
                </p>

                <div className="tpl-tokens">
                    {TOKENY.map((t) => (
                        <button
                            key={t.token}
                            type="button"
                            className={`me-tok tok-${t.category}`}
                            title={`${t.label} — kliknij, aby skopiować`}
                            onClick={() => void navigator.clipboard?.writeText(`{{${t.token}}}`)}
                        >
                            {`{{${t.token}}}`}
                        </button>
                    ))}
                </div>
                <p className="crm-note">
                    Kategorie: {Object.values(TOKEN_CATEGORY_LABELS).join(" · ")}
                </p>

                {s.templates.map((t) => {
                    const podglad = wypelnijSzablon(t.body, PRZYKLAD);
                    const temat = wypelnijSzablon(t.subject, PRZYKLAD);
                    const rozwiniety = otwarty === t.key;
                    return (
                        <div className={`tpl${t.enabled ? "" : " off"}`} key={t.key}>
                            <header>
                                <button
                                    type="button"
                                    className="tpl-toggle"
                                    onClick={() => setOtwarty(rozwiniety ? null : t.key)}
                                    aria-expanded={rozwiniety}
                                >
                                    <span aria-hidden="true">{rozwiniety ? "▾" : "▸"}</span> {TEMPLATE_LABELS[t.key]}
                                </button>
                                <label className="check">
                                    <input
                                        type="checkbox"
                                        checked={t.enabled}
                                        onChange={(e) => {
                                            const templates = s.templates.map((x) =>
                                                x.key === t.key ? { ...x, enabled: e.target.checked } : x,
                                            );
                                            setS({ ...s, templates });
                                            void zapisz({ templates });
                                        }}
                                    />
                                    aktywny
                                </label>
                            </header>

                            {rozwiniety && (
                                <div className="tpl-body">
                                    <label className="dr-field">
                                        <span>Temat</span>
                                        <input
                                            value={t.subject}
                                            onChange={(e) => zmienSzablon(t.key, { subject: e.target.value })}
                                            onBlur={() => void zapisz({ templates: s.templates })}
                                        />
                                    </label>
                                    <label className="dr-field">
                                        <span>Treść</span>
                                        <textarea
                                            rows={12}
                                            value={t.body}
                                            onChange={(e) => zmienSzablon(t.key, { body: e.target.value })}
                                            onBlur={() => void zapisz({ templates: s.templates })}
                                        />
                                    </label>
                                    <p className="tpl-prev-h">Podgląd z przykładowymi danymi</p>
                                    <div className="tpl-prev">
                                        <PodgladTresci text={temat.text} podstawienia={temat.podstawienia} />
                                        <PodgladTresci text={podglad.text} podstawienia={podglad.podstawienia} />
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </section>
    );
}