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
import { wypelnijSzablon } from "@demo-erp/shared";
import type { CrmMessage, CrmRequest } from "@demo-erp/shared";
import { notify } from "../ui.js";
import { ApiError } from "../api.js";
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
export function podstawieniaDlaSprawy(req: CrmRequest, extra: Record<string, string | null> = {}): Podstawienie[] {
    const ctx: Record<string, string | null> = {
        "klient.osoba": req.contactName,
        "klient.firma": req.companyName,
        "sprawa.numer": req.number,
        "sprawa.budowa": req.projectName,
        "sprawa.termin": req.deadline,
        "sprawa.adres": req.siteAddress,
        produkty: req.products,
        ilosc: req.quantity,
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
                                     poprzednia,
                                     onClose,
                                     onSent,
                                     extraActions,
                                 }: {
    req: CrmRequest;
    messageId: string;
    title: string;
    intro?: string;
    /** Wcześniejsza wiadomość tego samego rodzaju — podstawa ostrzeżenia. */
    poprzednia?: CrmMessage | null;
    onClose: (r: CrmRequest | null) => void;
    onSent: (r: CrmRequest) => void;
    extraActions?: React.ReactNode;
}) {
    const msg = req.messages.find((m) => m.id === messageId);
    const [subject, setSubject] = useState(msg?.subject ?? "");
    const [body, setBody] = useState(msg?.body ?? "");
    const [to, setTo] = useState(msg?.to ?? req.email);
    const [busy, setBusy] = useState(false);
    const [pokazPoprzednia, setPokazPoprzednia] = useState(false);

    const opiekun = req.assigneeId;
    const podstawienia = podstawieniaDlaSprawy(req, {
        "kosztorysant.imie": opiekun ? (msg?.authorName ?? null) : null,
    });

    async function wyslij(): Promise<void> {
        setBusy(true);
        try {
            const r = await crmApi.sendMessage(req.id, messageId, { subject, body });
            notify("Wiadomość wysłana", `${to} · konto ${r.messages.at(-1)?.sentFrom ?? "skrzynka działu"}`);
            onSent(r);
        } catch (e) {
            notify("Nie udało się wysłać", e instanceof ApiError ? e.body.message : "Spróbuj ponownie.", "err");
            setBusy(false);
        }
    }

    async function odrzuc(): Promise<void> {
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
            onClose={() => void odrzuc()}
            footer={
                <>
                    {extraActions}
                    <span className="spacer" />
                    <button onClick={() => void odrzuc()} disabled={busy}>
                        Nie wysyłaj
                    </button>
                    <button className="primary" onClick={() => void wyslij()} disabled={busy}>
                        {busy ? "Wysyłanie…" : "Wyślij"}
                    </button>
                </>
            }
        >
            {intro && <p className="crm-note">{intro}</p>}

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
                to={to}
                subject={subject}
                body={body}
                podstawienia={podstawienia}
                account={msg?.sentFrom ?? undefined}
                onToChange={setTo}
                onSubjectChange={setSubject}
                onBodyChange={setBody}
            />
        </Modal>
    );
}