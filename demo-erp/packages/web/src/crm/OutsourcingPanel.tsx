/**
 * OutsourcingPanel.tsx — zapytania o wycenę do firm zewnętrznych.
 *
 * Model odpowiada temu, jak taka rozmowa wygląda naprawdę: jedno zapytanie to
 * PAKIET pozycji, a każda firma może dostać inny wycinek tego pakietu. Jedna
 * gnie i lakieruje, druga tylko gnie, trzeciej nie chcemy dawać całości —
 * i żadna nie widzi, o co pytamy pozostałe.
 *
 * Zapytania są domyślnie zwinięte: przy kilku pakietach na sprawę rozwinięta
 * lista firm zajmuje cały ekran. Zwinięty wiersz mówi to, co potrzebne do
 * decyzji — czego dotyczy, ile firm zapytano, ile odpowiedziało i która dała
 * najtaniej (🏆).
 *
 * Wybór wykonawcy jest ręczny. Najniższa cena bywa najniższa dlatego, że firma
 * czegoś nie doczytała — decyzję podejmuje człowiek, system tylko układa oferty
 * po kolei.
 */

import { useMemo, useState } from "react";
import { OUTSOURCING_PRESETS, VENDOR_STATUS_LABELS, najlepszaWycena } from "@demo-erp/shared";
import type {
    CrmRequest,
    CrmVendor,
    OutsourcingElement,
    OutsourcingItem,
    VendorInquiry,
} from "@demo-erp/shared";
import { notify } from "../ui.js";
import { ApiError } from "../api.js";
import { crmApi } from "./client.js";
import { dataGodzinaPL } from "./format.js";
import { kwotaPL } from "./BoardCard.js";

const KOLEJNOSC = { quoted: 0, sent: 1, no_reply: 2, declined: 3 } as const;

function sortujOferty(a: VendorInquiry, b: VendorInquiry): number {
    const d = KOLEJNOSC[a.status] - KOLEJNOSC[b.status];
    if (d !== 0) return d;
    if (a.status === "quoted" && b.status === "quoted") {
        return (a.quoteValue ?? 0) - (b.quoteValue ?? 0);
    }
    return a.vendorName.localeCompare(b.vendorName);
}

export function OutsourcingPanel({
                                     req,
                                     vendors,
                                     onChange,
                                 }: {
    req: CrmRequest;
    vendors: CrmVendor[];
    onChange: (r: CrmRequest) => void;
}) {
    const [nowy, setNowy] = useState(false);
    const [rozwiniete, setRozwiniete] = useState<string[]>([]);
    const [podglad, setPodglad] = useState<{ item: OutsourcingItem; zap: VendorInquiry } | null>(null);
    const [wycena, setWycena] = useState<{ item: OutsourcingItem; zap: VendorInquiry } | null>(null);

    const przelacz = (id: string): void =>
        setRozwiniete((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

    async function usun(item: OutsourcingItem): Promise<void> {
        if (!window.confirm(`Usunąć zapytanie „${item.title}” wraz z ${item.inquiries.length} wysłanymi wiadomościami?`)) {
            return;
        }
        try {
            onChange(await crmApi.removeOutsourcing(req.id, item.id));
            notify("Zapytanie usunięte", item.title);
        } catch (e) {
            notify("Nie udało się usunąć", e instanceof ApiError ? e.body.message : "Spróbuj ponownie.", "err");
        }
    }

    async function wybierz(item: OutsourcingItem, vendorId: string | null): Promise<void> {
        try {
            onChange(await crmApi.selectVendor(req.id, item.id, vendorId));
            notify(
                vendorId ? "Wykonawca wybrany" : "Cofnięto wybór",
                vendorId ? (item.inquiries.find((q) => q.vendorId === vendorId)?.vendorName ?? "") : item.title,
            );
        } catch (e) {
            notify("Nie udało się zapisać wyboru", e instanceof ApiError ? e.body.message : "Spróbuj ponownie.", "err");
        }
    }

    return (
        <>
            <section className="dr-block">
                <h4>
                    Zapytania do firm zewnętrznych ({req.outsourcing.length})
                    <button
                        type="button"
                        className="dr-h-act"
                        onClick={() => setNowy(true)}
                        data-assistant-id="crm-outsourcing-new"
                    >
                        + Nowe zapytanie
                    </button>
                </h4>

                {req.outsourcing.length === 0 && !nowy && (
                    <div className="dr-card">
                        <p className="muted">
                            Nic nie jest zlecane na zewnątrz. Dodaj zapytanie, żeby zebrać wyceny od kooperantów.
                        </p>
                    </div>
                )}

                {nowy && (
                    <FormularzZapytania
                        req={req}
                        vendors={vendors}
                        onCancel={() => setNowy(false)}
                        onSaved={(r) => {
                            onChange(r);
                            setNowy(false);
                        }}
                    />
                )}

                {req.outsourcing.map((item) => {
                    const najlepsza = najlepszaWycena(item);
                    const oferty = [...item.inquiries].sort(sortujOferty);
                    const odpowiedzi = item.inquiries.filter((i) => i.status === "quoted").length;
                    const wybrany = item.inquiries.find((q) => q.vendorId === item.selectedVendorId);
                    const otwarte = rozwiniete.includes(item.id);

                    return (
                        <article className={`os-item${otwarte ? " open" : ""}`} key={item.id}>
                            <header className="os-head">
                                <button
                                    type="button"
                                    className="os-fold"
                                    onClick={() => przelacz(item.id)}
                                    aria-expanded={otwarte}
                                >
                  <span className="os-caret" aria-hidden="true">
                    {otwarte ? "▾" : "▸"}
                  </span>
                                    <span className="os-head-t">
                    <span className="os-title">{item.title}</span>
                    <span className="os-sub">
                      {item.elements.length} {item.elements.length === 1 ? "pozycja" : "pozycji"} ·{" "}
                        {item.inquiries.length} {item.inquiries.length === 1 ? "firma" : "firm"} ·{" "}
                        {odpowiedzi} z wyceną
                        {item.deadline ? ` · termin ${item.deadline}` : ""}
                    </span>
                  </span>
                                </button>

                                <div className="os-best">
                                    {najlepsza ? (
                                        <>
                      <span className="os-best-h">
                        <span aria-hidden="true">🏆</span> Najtańsza
                      </span>
                                            <strong>{kwotaPL(najlepsza.quoteValue)}</strong>
                                            <span className="os-best-v">{najlepsza.vendorName}</span>
                                        </>
                                    ) : (
                                        <span className="os-best-h">Brak wycen</span>
                                    )}
                                </div>

                                <button type="button" className="os-x" title="Usuń zapytanie" onClick={() => void usun(item)}>
                                    ✕
                                </button>
                            </header>

                            {wybrany && (
                                <p className="os-winner">
                                    Wybrany wykonawca: <strong>{wybrany.vendorName}</strong>
                                    {wybrany.quoteValue != null ? ` · ${kwotaPL(wybrany.quoteValue)}` : ""}
                                    <button type="button" onClick={() => void wybierz(item, null)}>
                                        zmień
                                    </button>
                                </p>
                            )}

                            {otwarte && (
                                <>
                                    <ul className="os-elements">
                                        {item.elements.map((e, i) => (
                                            <li key={e.id}>
                                                <span className="os-el-n">{i + 1}.</span>
                                                <span className="os-el-t">
                          {e.title}
                                                    {e.quantity ? ` — ${e.quantity}` : ""}
                        </span>
                                                <span className="os-el-d">{e.description}</span>
                                            </li>
                                        ))}
                                    </ul>

                                    <ul className="os-list">
                                        {oferty.map((q, i) => (
                                            <WierszOferty
                                                key={q.id}
                                                item={item}
                                                zap={q}
                                                rank={q.status === "quoted" ? i + 1 : null}
                                                wybrany={item.selectedVendorId === q.vendorId}
                                                onPodglad={() => setPodglad({ item, zap: q })}
                                                onWycena={() => setWycena({ item, zap: q })}
                                                onWybierz={() => void wybierz(item, q.vendorId)}
                                                requestId={req.id}
                                            />
                                        ))}
                                    </ul>

                                    <p className="dr-meta">
                                        Wysłano {dataGodzinaPL(item.createdAt)} przez {item.createdBy}. Każda firma
                                        dostała osobną wiadomość, z własnym zakresem pozycji.
                                    </p>
                                </>
                            )}
                        </article>
                    );
                })}
            </section>

            {podglad && (
                <PodgladWiadomosci
                    item={podglad.item}
                    zap={podglad.zap}
                    requestId={req.id}
                    onClose={() => setPodglad(null)}
                />
            )}

            {wycena && (
                <FormularzWyceny
                    req={req}
                    item={wycena.item}
                    zap={wycena.zap}
                    onClose={() => setWycena(null)}
                    onSaved={(r) => {
                        onChange(r);
                        setWycena(null);
                    }}
                />
            )}
        </>
    );
}

/** Wiersz jednej firmy z możliwością rozwinięcia odpowiedzi. */
function WierszOferty({
                          item,
                          zap,
                          rank,
                          wybrany,
                          onPodglad,
                          onWycena,
                          onWybierz,
                          requestId,
                      }: {
    item: OutsourcingItem;
    zap: VendorInquiry;
    rank: number | null;
    wybrany: boolean;
    onPodglad: () => void;
    onWycena: () => void;
    onWybierz: () => void;
    requestId: string;
}) {
    const [otwarta, setOtwarta] = useState(false);
    const zakres = item.elements.filter((e) => zap.elementIds.includes(e.id));
    const maOdpowiedz = zap.replyBody != null;

    return (
        <li className={`os-row-wrap ${zap.status}${wybrany ? " wybrany" : ""}`}>
            <div className="os-row">
                <span className="os-rank">{rank === 1 ? "🏆" : (rank ?? "—")}</span>
                <button
                    type="button"
                    className="os-vendor"
                    onClick={() => maOdpowiedz && setOtwarta((v) => !v)}
                    title={maOdpowiedz ? "Pokaż pełną odpowiedź" : "Firma jeszcze nie odpowiedziała"}
                    disabled={!maOdpowiedz}
                >
                    {maOdpowiedz && (
                        <span className="os-caret" aria-hidden="true">
              {otwarta ? "▾" : "▸"}
            </span>
                    )}
                    {zap.vendorName}
                </button>
                <span className={`os-status ${zap.status}`}>{VENDOR_STATUS_LABELS[zap.status]}</span>
                <span className="os-lead">{zap.leadTimeDays != null ? `${zap.leadTimeDays} dni` : "—"}</span>
                <span className="os-price">{zap.quoteValue != null ? kwotaPL(zap.quoteValue) : "—"}</span>
                <span className="os-act">
          <button type="button" onClick={onPodglad} title="Podgląd wysłanej wiadomości">
            ✉
          </button>
          <button type="button" onClick={onWycena} title="Wpisz wycenę ręcznie">
            ✎
          </button>
          <button
              type="button"
              className={wybrany ? "wybrany" : ""}
              onClick={onWybierz}
              title="Wskaż tę firmę jako wykonawcę"
          >
            ✓
          </button>
        </span>
            </div>

            <p className="os-scope">
                Zakres: {zakres.map((e) => e.title).join(", ") || "—"}
                {zakres.length < item.elements.length && (
                    <span className="os-scope-x"> (bez {item.elements.length - zakres.length} pozycji)</span>
                )}
            </p>

            {otwarta && maOdpowiedz && (
                <div className="os-reply">
                    <p className="os-reply-h">{zap.replySubject}</p>
                    <pre>{zap.replyBody}</pre>
                    {zap.attachments.length > 0 && (
                        <ul className="os-files">
                            {zap.attachments.map((a) => (
                                <li key={a.id}>
                                    <a href={crmApi.attachmentUrl(requestId, a.id)} target="_blank" rel="noreferrer">
                                        ▤ {a.name}
                                    </a>
                                    <span>
                    {dataGodzinaPL(a.at)} · {a.sizeKb} kB
                  </span>
                                </li>
                            ))}
                        </ul>
                    )}
                    <p className="dr-meta">Odpowiedź otrzymana {dataGodzinaPL(zap.quoteAt)}.</p>
                </div>
            )}
        </li>
    );
}

function PodgladWiadomosci({
                               item,
                               zap,
                               requestId,
                               onClose,
                           }: {
    item: OutsourcingItem;
    zap: VendorInquiry;
    requestId: string;
    onClose: () => void;
}) {
    return (
        <div className="os-preview" role="dialog" aria-label="Podgląd wiadomości">
            <div className="os-preview-box">
                <header>
                    <div>
                        <p className="os-prev-to">do: {zap.to}</p>
                        <h5>{zap.subject}</h5>
                    </div>
                    <button type="button" onClick={onClose} aria-label="Zamknij podgląd">
                        ✕
                    </button>
                </header>
                <pre>{zap.body}</pre>
                {zap.attachments.length > 0 && (
                    <ul className="os-files" style={{ padding: "0 14px 8px" }}>
                        {zap.attachments.map((a) => (
                            <li key={a.id}>
                                <a href={crmApi.attachmentUrl(requestId, a.id)} target="_blank" rel="noreferrer">
                                    ▤ {a.name}
                                </a>
                                <span>{a.sizeKb} kB</span>
                            </li>
                        ))}
                    </ul>
                )}
                <p className="dr-meta">
                    Wysłano {dataGodzinaPL(zap.sentAt)} wyłącznie na powyższy adres — zakres:{" "}
                    {item.elements
                        .filter((e) => zap.elementIds.includes(e.id))
                        .map((e) => e.title)
                        .join(", ")}
                    .
                </p>
            </div>
        </div>
    );
}

// --------------------------- formularz zapytania ---------------------------

interface Pozycja {
    title: string;
    description: string;
    quantity: string;
    preset: string;
}

const PUSTA: Pozycja = { title: "", description: "", quantity: "", preset: "" };

function FormularzZapytania({
                                req,
                                vendors,
                                onCancel,
                                onSaved,
                            }: {
    req: CrmRequest;
    vendors: CrmVendor[];
    onCancel: () => void;
    onSaved: (r: CrmRequest) => void;
}) {
    const [title, setTitle] = useState(`Zapytanie kooperacyjne — ${req.projectName}`);
    const [deadline, setDeadline] = useState(req.deadline ?? "");
    const [pozycje, setPozycje] = useState<Pozycja[]>([{ ...PUSTA }]);
    const [wybrane, setWybrane] = useState<Record<string, number[]>>({});
    const [zalaczniki, setZalaczniki] = useState<{ name: string; sizeKb: number }[]>([]);
    const [subject, setSubject] = useState(`Zapytanie o wycenę — ${req.number}`);
    const [body, setBody] = useState(
        [
            "Dzień dobry,",
            "",
            "zwracamy się z prośbą o wycenę poniższego zakresu:",
            "",
            "{{elementy}}",
            "",
            "Prosimy o podanie ceny netto oraz terminu realizacji.",
            "W razie pytań technicznych prosimy o kontakt zwrotny.",
            "",
            "Pozdrawiam,",
            "Dział Handlowy",
        ].join("\n"),
    );
    const [busy, setBusy] = useState(false);
    const [bledy, setBledy] = useState<Record<string, string>>({});

    /** Podpowiedzi do pola nazwy — jedno pole, nie osobny input i osobna lista. */
    const presety = OUTSOURCING_PRESETS;

    function ustawPozycje(i: number, patch: Partial<Pozycja>): void {
        setPozycje((p) => p.map((x, n) => (n === i ? { ...x, ...patch } : x)));
    }

    /**
     * Wpisanie albo wybranie nazwy z listy. Jedno pole obsługuje oba przypadki
     * (`<input list=…>`): gdy tekst pokrywa się z gotowym zestawem, dociągamy
     * opis i podpowiadamy firmy o pasującej specjalności.
     */
    function nazwaPozycji(i: number, wartosc: string): void {
        const preset = presety.find((p) => p.title.toLowerCase() === wartosc.trim().toLowerCase());
        ustawPozycje(i, {
            title: wartosc,
            preset: preset?.id ?? "",
            ...(preset && pozycje[i]?.description.trim() === ""
                ? { description: preset.description }
                : {}),
        });
        if (!preset) return;
        const pasujace = vendors.filter((v) =>
            v.specialties.some((sp) => preset.keywords.some((k) => sp.includes(k))),
        );
        setWybrane((prev) => {
            const nowe = { ...prev };
            for (const v of pasujace) {
                const zakres = nowe[v.id] ?? [];
                if (!zakres.includes(i)) nowe[v.id] = [...zakres, i];
            }
            return nowe;
        });
    }

    function przelaczFirme(vendorId: string): void {
        setWybrane((prev) => {
            const nowe = { ...prev };
            if (nowe[vendorId]) delete nowe[vendorId];
            else nowe[vendorId] = pozycje.map((_, i) => i);
            return nowe;
        });
    }

    function przelaczZakres(vendorId: string, idx: number): void {
        setWybrane((prev) => {
            const zakres = prev[vendorId] ?? [];
            return {
                ...prev,
                [vendorId]: zakres.includes(idx) ? zakres.filter((x) => x !== idx) : [...zakres, idx],
            };
        });
    }

    const wybraneFirmy = Object.entries(wybrane);

    const podglad = useMemo(() => {
        const lista = pozycje
            .map((p, i) => `${i + 1}. ${p.title || "(bez nazwy)"}${p.quantity ? ` — ${p.quantity}` : ""}\n   ${p.description}`)
            .join("\n");
        return body.includes("{{elementy}}") ? body.replace("{{elementy}}", lista) : `${body}\n\n${lista}`;
    }, [body, pozycje]);

    function sprawdz(): boolean {
        const b: Record<string, string> = {};
        if (title.trim().length < 3) b.title = "Podaj nazwę zapytania (min. 3 znaki).";
        if (subject.trim().length < 3) b.subject = "Temat nie może być pusty.";
        if (body.trim().length < 10) b.body = "Treść wiadomości jest za krótka.";
        pozycje.forEach((p, i) => {
            if (p.title.trim().length < 2) b[`poz-${i}`] = "Podaj nazwę pozycji.";
            else if (p.description.trim().length < 3) b[`poz-${i}`] = "Opisz krótko, co ma być wycenione.";
        });
        if (wybraneFirmy.length === 0) b.vendors = "Zaznacz co najmniej jedną firmę.";
        if (wybraneFirmy.some(([, zakres]) => zakres.length === 0)) {
            b.vendors = "Każda zaznaczona firma musi mieć przynajmniej jedną pozycję.";
        }
        setBledy(b);
        return Object.keys(b).length === 0;
    }

    async function wyslij(): Promise<void> {
        if (!sprawdz()) return;
        setBusy(true);
        try {
            onSaved(
                await crmApi.addOutsourcing(req.id, {
                    title,
                    deadline,
                    subject,
                    body,
                    elements: pozycje.map((p) => ({
                        title: p.title,
                        description: p.description,
                        quantity: p.quantity,
                    })),
                    vendors: wybraneFirmy.map(([vendorId, elementIndexes]) => ({ vendorId, elementIndexes })),
                    attachments: zalaczniki,
                } as never),
            );
            notify("Zapytania wysłane", `${wybraneFirmy.length} firm — każda osobną wiadomością.`);
        } catch (e) {
            setBledy({ ogolny: e instanceof ApiError ? e.body.message : "Nie udało się wysłać zapytań." });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="dr-card os-form">
            <div className="dr-two">
                <label className="dr-field">
                    <span>Nazwa zapytania</span>
                    <input
                        value={title}
                        className={bledy.title ? "invalid" : ""}
                        onChange={(e) => setTitle(e.target.value)}
                        data-assistant-id="crm-os-title"
                    />
                    {bledy.title && <span className="field-error">{bledy.title}</span>}
                </label>
                <label className="dr-field">
                    <span>Oczekiwany termin</span>
                    <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
                </label>
            </div>

            <p className="os-pick-h">Pozycje do wyceny ({pozycje.length})</p>
            <datalist id="os-presety">
                {presety.map((p) => (
                    <option key={p.id} value={p.title} />
                ))}
            </datalist>

            {pozycje.map((p, i) => (
                <div className="os-poz" key={i}>
                    <div className="os-poz-h">
                        <span className="os-poz-n">{i + 1}</span>
                        <input
                            list="os-presety"
                            value={p.title}
                            placeholder="Wpisz nazwę albo wybierz z listy (np. Gięcie blach)"
                            className={bledy[`poz-${i}`] ? "invalid" : ""}
                            onChange={(e) => nazwaPozycji(i, e.target.value)}
                            data-assistant-id={`crm-os-poz-${i}`}
                        />
                        <input
                            className="os-poz-q"
                            value={p.quantity}
                            placeholder="Ilość"
                            onChange={(e) => ustawPozycje(i, { quantity: e.target.value })}
                        />
                        {pozycje.length > 1 && (
                            <button
                                type="button"
                                className="os-x"
                                title="Usuń pozycję"
                                onClick={() => {
                                    setPozycje((prev) => prev.filter((_, n) => n !== i));
                                    setWybrane((prev) =>
                                        Object.fromEntries(
                                            Object.entries(prev).map(([v, zakres]) => [
                                                v,
                                                zakres.filter((x) => x !== i).map((x) => (x > i ? x - 1 : x)),
                                            ]),
                                        ),
                                    );
                                }}
                            >
                                ✕
                            </button>
                        )}
                    </div>
                    <textarea
                        rows={2}
                        value={p.description}
                        placeholder="Co dokładnie ma zostać wykonane: materiał, tolerancje, wykończenie."
                        onChange={(e) => ustawPozycje(i, { description: e.target.value })}
                    />
                    {bledy[`poz-${i}`] && <span className="field-error">{bledy[`poz-${i}`]}</span>}
                </div>
            ))}

            <button type="button" className="os-add-poz" onClick={() => setPozycje((p) => [...p, { ...PUSTA }])}>
                + Dodaj pozycję
            </button>

            <p className="os-pick-h">
                Firmy i zakres zapytania ({wybraneFirmy.length})
                {bledy.vendors && <span className="field-error"> {bledy.vendors}</span>}
            </p>
            <p className="dr-meta">
                Zaznacz firmy, a przy każdej odznacz pozycje, których nie chcesz jej wysyłać. Firmy nie
                widzą siebie nawzajem ani zakresu wysłanego pozostałym.
            </p>

            <ul className="os-pick">
                {vendors.map((v) => {
                    const zaznaczona = wybrane[v.id] != null;
                    return (
                        <li key={v.id} className={zaznaczona ? "on" : ""}>
                            <label className="os-pick-main">
                                <input type="checkbox" checked={zaznaczona} onChange={() => przelaczFirme(v.id)} />
                                <span className="os-pick-n">{v.name}</span>
                                <span className="os-pick-s">{v.specialties.join(", ")}</span>
                            </label>
                            {zaznaczona && (
                                <div className="os-pick-scope">
                                    {pozycje.map((p, i) => (
                                        <label key={i} className={(wybrane[v.id] ?? []).includes(i) ? "on" : ""}>
                                            <input
                                                type="checkbox"
                                                checked={(wybrane[v.id] ?? []).includes(i)}
                                                onChange={() => przelaczZakres(v.id, i)}
                                            />
                                            {i + 1}. {p.title || "(bez nazwy)"}
                                        </label>
                                    ))}
                                </div>
                            )}
                        </li>
                    );
                })}
            </ul>

            <p className="os-pick-h">Wiadomość</p>
            <label className="dr-field">
                <span>Temat</span>
                <input
                    value={subject}
                    className={bledy.subject ? "invalid" : ""}
                    onChange={(e) => setSubject(e.target.value)}
                />
                {bledy.subject && <span className="field-error">{bledy.subject}</span>}
            </label>
            <label className="dr-field">
                <span>Treść</span>
                <textarea
                    rows={9}
                    value={body}
                    className={bledy.body ? "invalid" : ""}
                    onChange={(e) => setBody(e.target.value)}
                />
                {bledy.body && <span className="field-error">{bledy.body}</span>}
                <span className="dr-meta">
          Znacznik <code>{"{{elementy}}"}</code> zostanie zastąpiony listą pozycji — osobno dla
          każdej firmy, zgodnie z jej zakresem. Jeśli go usuniesz, lista dopisze się na końcu.
        </span>
            </label>

            <label className="dr-field">
                <span>Załączniki do zapytania</span>
                <input
                    type="file"
                    multiple
                    onChange={(e) => {
                        const pliki = Array.from(e.target.files ?? []).map((f) => ({
                            name: f.name,
                            sizeKb: Math.max(1, Math.round(f.size / 1024)),
                        }));
                        setZalaczniki((prev) => [...prev, ...pliki]);
                    }}
                    data-assistant-id="crm-os-files"
                />
                <span className="dr-meta">
          Wersja demonstracyjna zapisuje nazwę i rozmiar pliku, nie jego treść.
        </span>
            </label>
            {zalaczniki.length > 0 && (
                <ul className="os-files">
                    {zalaczniki.map((a, i) => (
                        <li key={`${a.name}-${i}`}>
                            <span>▤ {a.name}</span>
                            <span>
                {a.sizeKb} kB
                <button
                    type="button"
                    className="os-x"
                    onClick={() => setZalaczniki((prev) => prev.filter((_, n) => n !== i))}
                >
                  ✕
                </button>
              </span>
                        </li>
                    ))}
                </ul>
            )}

            <p className="os-pick-h">Podgląd wiadomości</p>
            <pre className="os-prev-body">{podglad}</pre>

            {bledy.ogolny && <p className="crm-note danger">{bledy.ogolny}</p>}
            <div className="os-form-act">
                <button type="button" className="btn ghost" onClick={onCancel}>
                    Anuluj
                </button>
                <button
                    type="button"
                    className="btn primary"
                    disabled={busy}
                    onClick={() => void wyslij()}
                    data-assistant-id="crm-os-send"
                >
                    {busy ? "Wysyłanie…" : `Wyślij do ${wybraneFirmy.length} firm`}
                </button>
            </div>
        </div>
    );
}

function FormularzWyceny({
                             req,
                             item,
                             zap,
                             onClose,
                             onSaved,
                         }: {
    req: CrmRequest;
    item: OutsourcingItem;
    zap: VendorInquiry;
    onClose: () => void;
    onSaved: (r: CrmRequest) => void;
}) {
    const [quoteValue, setQuoteValue] = useState(zap.quoteValue == null ? "" : String(zap.quoteValue));
    const [leadTimeDays, setLeadTimeDays] = useState(zap.leadTimeDays == null ? "" : String(zap.leadTimeDays));
    const [status, setStatus] = useState(zap.status);
    const [note, setNote] = useState(zap.note ?? "");
    const [busy, setBusy] = useState(false);

    const zakres: OutsourcingElement[] = item.elements.filter((e) => zap.elementIds.includes(e.id));

    return (
        <div className="os-preview" role="dialog" aria-label="Wpisz wycenę">
            <div className="os-preview-box">
                <header>
                    <div>
                        <p className="os-prev-to">{item.title}</p>
                        <h5>{zap.vendorName}</h5>
                    </div>
                    <button type="button" onClick={onClose} aria-label="Zamknij">
                        ✕
                    </button>
                </header>
                <div className="os-quote-form">
                    <p className="dr-meta">Zakres: {zakres.map((e) => e.title).join(", ")}</p>
                    <label className="dr-field">
                        <span>Status</span>
                        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                            <option value="sent">Wysłane, czeka na wycenę</option>
                            <option value="quoted">Wycena otrzymana</option>
                            <option value="declined">Odmowa</option>
                            <option value="no_reply">Brak odpowiedzi</option>
                        </select>
                    </label>
                    <div className="dr-two">
                        <label className="dr-field">
                            <span>Kwota netto (PLN)</span>
                            <input value={quoteValue} onChange={(e) => setQuoteValue(e.target.value)} placeholder="np. 38 500" />
                        </label>
                        <label className="dr-field">
                            <span>Termin (dni)</span>
                            <input value={leadTimeDays} onChange={(e) => setLeadTimeDays(e.target.value)} placeholder="np. 14" />
                        </label>
                    </div>
                    <label className="dr-field">
                        <span>Uwagi</span>
                        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="np. cena bez transportu" />
                    </label>
                    <div className="os-form-act">
                        <button type="button" className="btn ghost" onClick={onClose}>
                            Anuluj
                        </button>
                        <button
                            type="button"
                            className="btn primary"
                            disabled={busy}
                            onClick={() => {
                                setBusy(true);
                                void crmApi
                                    .recordQuote(req.id, item.id, zap.id, {
                                        quoteValue: quoteValue.trim() === "" ? null : quoteValue,
                                        leadTimeDays: leadTimeDays.trim() === "" ? null : leadTimeDays,
                                        status,
                                        note,
                                    } as never)
                                    .then(onSaved)
                                    .catch((e: unknown) =>
                                        notify(
                                            "Nie udało się zapisać wyceny",
                                            e instanceof ApiError ? e.body.message : "Spróbuj ponownie.",
                                            "err",
                                        ),
                                    )
                                    .finally(() => setBusy(false));
                            }}
                        >
                            Zapisz
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}