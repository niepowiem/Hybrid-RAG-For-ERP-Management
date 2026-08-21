/**
 * SendMessageModal.tsx — okno zatwierdzania wiadomości wychodzącej.
 *
 * Jedno okno dla wszystkich sytuacji, w których system przygotował treść:
 * przypisanie kosztorysanta, szybkie akcje z kafelka („Poproś o adres”),
 * follow-up. Zasada: **nic nie wychodzi do klienta, czego człowiek nie
 * zobaczył**. System pisze, człowiek czyta, poprawia i decyduje.
 *
 * Ostrzeżenie o powtórzeniu jest tu równie ważne jak sama wysyłka: jeśli
 * o tę samą rzecz prosiliśmy już trzy dni temu, kolejna identyczna prośba
 * wygląda dla klienta jak bałagan po naszej stronie. Dlatego pokazujemy
 * poprzednią wiadomość — kto, kiedy, o co prosił i z jakimi załącznikami —
 * ale nie blokujemy wysyłki. Czasem ponowienie jest właśnie tym, co trzeba
 * zrobić.
 */

import { useState } from "react";
import {
    ATTACHMENT_KIND_LABELS,
    CRM_DATA_FIELD_LABELS,
    ocenKompletnosc,
    wypelnijSzablon,
} from "@demo-erp/shared";
import type { CrmEmployee, CrmIssue, CrmMessage, CrmRequest } from "@demo-erp/shared";
import { notify } from "../ui.js";
import { ApiError, getUserId } from "../api.js";
import { crmApi } from "./client.js";
import { Modal } from "./components.js";
import { MessageEditor } from "./MessageEditor.js";
import type { Podstawienie } from "./MessageEditor.js";
import { dataGodzinaPL, czasWzgledny } from "./format.js";

/**
 * Odtworzenie listy podstawień z gotowej treści. Serwer zwraca tekst już
 * wypełniony, a interfejs musi wiedzieć, które fragmenty podstawił system —
 * przepuszczamy więc kontekst przez ten sam mechanizm co szablon.
 */
export function podstawieniaDlaSprawy(
    req: CrmRequest,
    extra: Record<string, string | null> = {},
): Podstawienie[] {
    const kompletnosc = ocenKompletnosc(req);
    const ctx: Record<string, string | null> = {
        "klient.osoba": req.contactName,
        "klient.firma": req.companyName,
        "sprawa.numer": req.number,
        "sprawa.budowa": req.projectName,
        "sprawa.termin": req.deadline,
        "sprawa.adres": req.siteAddress,
        produkty: req.products,
        ilosc: req.quantity,
        // Braki wypisujemy tak samo jak szablon po stronie serwera, inaczej
        // podświetlenie ominęłoby najważniejszy fragment prośby o uzupełnienie.
        "braki.lista": kompletnosc.missingFields
            .map((f) => `— ${CRM_DATA_FIELD_LABELS[f]}`)
            .join("\n"),
        "braki.zalaczniki": kompletnosc.missingAttachments
            .map((a) => `— ${ATTACHMENT_KIND_LABELS[a]}`)
            .join("\n"),
        ...extra,
    };
    const wzor = Object.keys(ctx)
        .map((k) => `{{${k}}}`)
        .join("\n");
    return wypelnijSzablon(wzor, ctx).podstawienia.filter((p) => !p.value.startsWith("["));
}

export function SendMessageModal({
                                     req,
                                     messageId,
                                     title,
                                     intro,
                                     introTone,
                                     poprzednia,
                                     onClose,
                                     onSent,
                                     extraActions,
                                     externalBusy = false,
                                     pracownicy = [],
                                     firma = null,
                                 }: {
    req: CrmRequest;
    messageId: string;
    title: string;
    intro?: string;
    introTone?: CrmIssue["severity"];
    /** Wcześniejsza wiadomość tego samego rodzaju — podstawa ostrzeżenia. */
    poprzednia?: CrmMessage | null;
    onClose: (r: CrmRequest | null) => void;
    onSent: (r: CrmRequest) => void;
    extraActions?: React.ReactNode;
    /** Operacja rodzica (np. cofanie przeniesienia) blokuje wspólne akcje okna. */
    externalBusy?: boolean;
    /** Pracownicy i dane firmy — potrzebne do podświetlenia podstawień. */
    pracownicy?: CrmEmployee[];
    firma?: { name: string; email: string; phone: string; address: string } | null;
}) {
    const msg = req.messages.find((m) => m.id === messageId);
    const [subject, setSubject] = useState(msg?.subject ?? "");
    const [body, setBody] = useState(msg?.body ?? "");
    const [to, setTo] = useState(msg?.to ?? req.email);
    const [cc, setCc] = useState<string[]>(msg?.cc ?? []);
    const [busy, setBusy] = useState(false);
    const [pokazPoprzednia, setPokazPoprzednia] = useState(false);

    // Dane kosztorysanta i firmy podajemy jawnie: treść przychodzi z serwera już
    // wypełniona, więc bez tych wartości podświetlenie ominęłoby nazwiska,
    // adresy i telefony — czyli dokładnie to, co trzeba sprawdzić przed wysyłką.
    const opiekun = pracownicy.find((e) => e.id === req.assigneeId);
    const zalogowany = pracownicy.find((e) => e.id === getUserId());
    const podstawienia = podstawieniaDlaSprawy(req, {
        "kosztorysant.imie": opiekun?.name ?? msg?.authorName ?? null,
        "kosztorysant.email": opiekun?.email ?? null,
        "kosztorysant.telefon": opiekun?.phone ?? null,
        "firma.nazwa": firma?.name ?? null,
        "firma.email": firma?.email ?? null,
        "firma.telefon": firma?.phone ?? null,
        "firma.adres": firma?.address ?? null,
    });

    async function wyslij(): Promise<void> {
        if (externalBusy) return;
        setBusy(true);
        try {
            const r = await crmApi.sendMessage(req.id, messageId, { to, cc, subject, body });
            notify("Wiadomość wysłana", `${to} · konto ${r.messages.at(-1)?.sentFrom ?? "skrzynka działu"}`);
            onSent(r);
        } catch (e) {
            notify("Nie udało się wysłać", e instanceof ApiError ? e.body.message : "Spróbuj ponownie.", "err");
            setBusy(false);
        }
    }

    async function odrzuc(): Promise<void> {
        if (externalBusy) return;
        setBusy(true);
        try {
            onClose(await crmApi.discardMessage(req.id, messageId));
        } catch {
            onClose(null);
        }
    }

    return (
        <Modal
            title={title}
            wide
            className="sm-modal"
            onClose={() => void odrzuc()}
            footer={
                <>
                    {extraActions}
                    <span className="spacer" />
                    <button onClick={() => void odrzuc()} disabled={busy || externalBusy}>
                        Nie wysyłaj
                    </button>
                    <button className="primary" onClick={() => void wyslij()} disabled={busy || externalBusy}>
                        {busy ? "Wysyłanie…" : "Wyślij"}
                    </button>
                </>
            }
        >
            <div className="sm-compose">
            {intro && (
                <p className={`sm-intro ${introTone ?? "neutral"}`}>
                    <span className="sm-intro-ico" aria-hidden="true">!</span>
                    <span>{intro}</span>
                </p>
            )}

            {poprzednia && (
                <div className="dr-alert warn sm-alert">
          <span className="dr-alert-ico" aria-hidden="true">
            △
          </span>
                    <p>
                        Taka wiadomość już wyszła — <strong>{poprzednia.authorName}</strong>,{" "}
                        {czasWzgledny(poprzednia.sentAt)} ({dataGodzinaPL(poprzednia.sentAt)}). Możesz ponowić,
                        ale sprawdź, czy klient nie odpowiedział.
                    </p>
                    <button
                        type="button"
                        className="dr-alert-act"
                        onClick={() => setPokazPoprzednia((v) => !v)}
                    >
                        {pokazPoprzednia ? "Ukryj" : "Pokaż"}
                    </button>
                </div>
            )}

            {poprzednia && pokazPoprzednia && (
                <div className="sm-prev">
                    <p className="sm-prev-h">
                        {poprzednia.subject} · do: {poprzednia.to}
                        {poprzednia.sentFrom ? ` · z konta ${poprzednia.sentFrom}` : ""}
                    </p>
                    <pre>{poprzednia.body}</pre>
                    {req.attachments.filter((a) => a.messageId === poprzednia.id).length > 0 && (
                        <ul className="sm-prev-files">
                            {req.attachments
                                .filter((a) => a.messageId === poprzednia.id)
                                .map((a) => (
                                    <li key={a.id}>
                                        <a href={crmApi.attachmentUrl(req.id, a.id)} target="_blank" rel="noreferrer">
                                            ▤ {a.name}
                                        </a>
                                        <span>{a.sizeKb} kB</span>
                                    </li>
                                ))}
                        </ul>
                    )}
                </div>
            )}

            <MessageEditor
                zTrybami
                pokazLegende={false}
                to={to}
                cc={cc}
                subject={subject}
                body={body}
                podstawienia={podstawienia}
                account={zalogowany?.email ?? msg?.sentFrom ?? undefined}
                onToChange={setTo}
                onCcChange={setCc}
                onSubjectChange={setSubject}
                onBodyChange={setBody}
            />
            </div>
        </Modal>
    );
}
