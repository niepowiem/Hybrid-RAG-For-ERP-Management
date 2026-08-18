/**
 * crm/automation.ts — automaty tablicy.
 *
 * Dwie reguły, obie wynikające z tego samego problemu: oferta wysłana
 * i zapomniana jest ofertą przegraną, tylko nikt tego nie odnotował.
 *
 *  1. Karta, która przesiedziała w kolumnie „Wysłane” dłużej niż
 *     `DNI_DO_FOLLOWUP`, przechodzi do kolumny „Follow-up”, a do klienta idzie
 *     wygenerowany follow-up.
 *  2. Odpowiedź klienta, którą czytamy jako odmowę, zamyka sprawę jako
 *     przegraną z przyczyną „brak odpowiedzi/rezygnacja”.
 *
 * Reguła 1 uruchamia się przy każdym odczycie tablicy — w demo nie ma
 * schedulera, a odpytywanie skrzynki i tak chodzi co 30 sekund. W wersji
 * produkcyjnej to samo powinno wołać zadanie cykliczne po stronie serwera,
 * niezależnie od tego, czy ktoś patrzy na tablicę.
 *
 * Automat NIGDY nie zamyka sprawy sam z siebie na podstawie czasu — milczenie
 * klienta nie jest odmową. Zamknięcie następuje tylko po wyraźnej odpowiedzi
 * albo decyzją człowieka.
 */

import { CRM_STAGE_LABELS, LOST_REASON_LABELS, czyOdmowa } from "@demo-erp/shared";
import type { CrmActivity, CrmRequest } from "@demo-erp/shared";
import { crmColumns, crmRequests, nextCrmId } from "./store.js";
import { symulujOdpowiedz } from "./vendors.js";
import { crmSettings } from "./settings.js";
import { generujFollowUp } from "./messages.js";

function wpis(req: CrmRequest, kind: CrmActivity["kind"], text: string): void {
    req.activity.push({
        id: nextCrmId(),
        at: new Date().toISOString(),
        kind,
        text,
        user: "automat",
    });
}

const dni = (od: string): number => (Date.now() - Date.parse(od)) / 86_400_000;

/**
 * Reguła 3 (tylko demo): odpowiedzi kooperantów. Zapytanie wysłane do firmy
 * zewnętrznej dostaje po kilkudziesięciu sekundach wycenę, odmowę albo ciszę —
 * dokładnie tak, jak w rzeczywistości. W wersji produkcyjnej to miejsce
 * zastąpi odczyt skrzynki i sparsowanie odpowiedzi kooperanta.
 */
export function symulujOdpowiedziPodwykonawcow(): number {
    let zmian = 0;
    for (const r of crmRequests) {
        for (const item of r.outsourcing) {
            for (const zap of item.inquiries) {
                if (zap.status !== "sent" || zap.respondAfterSec == null) continue;
                const sekundy = (Date.now() - Date.parse(zap.sentAt)) / 1000;
                if (sekundy < zap.respondAfterSec) continue;

                const pozycje = item.elements
                    .filter((e) => zap.elementIds.includes(e.id))
                    .map((e) => `${e.title}${e.quantity ? ` — ${e.quantity}` : ""}`);
                const bazowa = ((r.quoteValue ?? 100_000) * 0.35 * Math.max(1, pozycje.length)) / 2;
                const odp = symulujOdpowiedz(zap.vendorId, bazowa, {
                    vendorName: zap.vendorName,
                    temat: zap.subject,
                    pozycje,
                });
                zap.respondAfterSec = null;
                if (odp.status === "sent") continue;

                zap.status = odp.status;
                zap.quoteValue = odp.quoteValue;
                zap.leadTimeDays = odp.leadTimeDays;
                zap.quoteAt = new Date().toISOString();
                zap.note = odp.note;
                zap.replySubject = odp.replySubject;
                zap.replyBody = odp.replyBody;
                if (odp.zalacznik) {
                    zap.attachments.push({
                        id: nextCrmId(),
                        name: odp.zalacznik.name,
                        kind: "pdf",
                        sizeKb: odp.zalacznik.sizeKb,
                        source: "client",
                        at: zap.quoteAt,
                        fromName: zap.vendorName,
                        messageId: zap.id,
                        messageSubject: `Odpowiedź na: ${zap.subject}`,
                    });
                }
                wpis(
                    r,
                    "message_sent",
                    odp.status === "quoted"
                        ? `Kooperant ${zap.vendorName} wycenił „${item.title}” na ${odp.quoteValue} PLN.`
                        : `Kooperant ${zap.vendorName} odmówił wyceny „${item.title}”.`,
                );
                zmian += 1;
            }
        }
    }
    return zmian;
}

export interface WynikAutomatu {
    przeniesione: string[];
    wyslaneFollowUpy: number;
}

/** Reguła 1: „Wysłane” → „Follow-up” po tygodniu bezruchu. */
export function przetworzAutomaty(): WynikAutomatu {
    const kolSent = crmColumns.find((c) => c.kind === "sent");
    const kolFollow = crmColumns.find((c) => c.kind === "followup");
    const wynik: WynikAutomatu = { przeniesione: [], wyslaneFollowUpy: 0 };
    if (!kolSent || !kolFollow) return wynik;

    for (const r of crmRequests) {
        if (r.columnId !== kolSent.id) continue;
        if (r.stage === "won" || r.stage === "lost") continue;
        const wiek = dni(r.columnEnteredAt);
        if (wiek < crmSettings.automation.followUpAfterDays) continue;

        r.columnId = kolFollow.id;
        r.columnEnteredAt = new Date().toISOString();
        wpis(
            r,
            "stage_changed",
            `Automat: oferta bez reakcji od ${Math.floor(wiek)} dni — karta przeniesiona do „${kolFollow.title}”.`,
        );

        const msg = generujFollowUp(r, Math.floor(wiek));
        // Ustawienie „wysyłaj automatycznie” decyduje, czy follow-up idzie sam,
        // czy tylko czeka w wątku jako szkic do zatwierdzenia.
        if (crmSettings.automation.autoSendFollowUp) {
            msg.sentAt = new Date().toISOString();
            msg.sentFrom = crmSettings.mailbox.account;
        }
        r.messages.push(msg);
        if (msg.sentAt) {
            r.lastContactAt = msg.sentAt;
            wpis(r, "message_sent", `Automat: wysłano follow-up do ${r.email}.`);
        } else {
            wpis(r, "message_generated", `Automat: przygotowano follow-up do ${r.email} — czeka na wysyłkę.`);
        }

        // Kontakt zapisujemy też jako wykonany follow-up, żeby kalendarz kontaktów
        // pokazywał prawdę — automat też jest kontaktem z klientem.
        r.followUps.push({
            id: nextCrmId(),
            date: new Date().toISOString().slice(0, 10),
            time: new Date().toISOString().slice(11, 16),
            type: "email",
            note: "Automatyczny follow-up do wysłanej oferty.",
            status: "done",
            doneAt: new Date().toISOString(),
        });

        wynik.przeniesione.push(r.number);
        wynik.wyslaneFollowUpy += 1;
    }
    return wynik;
}

/**
 * Reguła 2: odpowiedź klienta czytana jako odmowa zamyka sprawę.
 * Dopasowanie po adresie nadawcy wśród spraw otwartych — po numerze sprawy
 * byłoby pewniejsze, ale klienci rzadko go cytują.
 */
export function obsluzOdmowe(fromEmail: string, subject: string, body: string): CrmRequest | null {
    if (!crmSettings.automation.autoCloseOnRefusal) return null;
    if (!czyOdmowa(`${subject}\n${body}`)) return null;
    const email = fromEmail.trim().toLowerCase();

    const kandydaci = crmRequests.filter(
        (r) => r.stage !== "won" && r.stage !== "lost" && r.email.toLowerCase() === email,
    );
    if (kandydaci.length === 0) return null;

    // Gdy klient ma kilka otwartych spraw, bierzemy tę, przy której ostatnio
    // coś się działo — i tak zaznaczamy w historii, że decyzję podjął automat.
    const r = kandydaci.sort((a, b) =>
        (b.lastContactAt ?? b.createdAt).localeCompare(a.lastContactAt ?? a.createdAt),
    )[0]!;

    const kolLost = crmColumns.find((c) => c.kind === "lost");
    r.stage = "lost";
    r.lostReason = "no_response";
    r.lostReasonNote = `Odpowiedź klienta: „${subject}”.`;
    if (kolLost) {
        r.columnId = kolLost.id;
        r.columnEnteredAt = new Date().toISOString();
    }
    wpis(
        r,
        "lost_reason_changed",
        `Automat: odpowiedź klienta odczytana jako rezygnacja. Przyczyna: ${LOST_REASON_LABELS.no_response}. Etap: ${CRM_STAGE_LABELS.lost}.`,
    );
    return r;
}