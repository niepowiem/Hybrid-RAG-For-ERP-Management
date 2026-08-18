/**
 * messages.ts — budowa treści wiadomości z szablonów.
 *
 * Treść nie jest już wpisana w kod: każdy rodzaj wiadomości ma szablon
 * w ustawieniach modułu (`settings.ts`), a tutaj tylko podstawiamy dane
 * sprawy pod znaczniki `{{token}}`. Dzięki temu handlowiec zmienia brzmienie
 * pisma bez dotykania kodu, a interfejs może pokazać, które fragmenty system
 * podstawił za autora.
 *
 * Wyłącznie budowa treści: żadnego SMTP. Wysyłka to `wyslijMock` niżej —
 * jeden punkt podmiany na prawdziwe konto Outlook.
 */

import {
  ATTACHMENT_KIND_LABELS,
  CRM_DATA_FIELD_LABELS,
  dniOdISO,
  ocenKompletnosc,
  wypelnijSzablon,
} from "@demo-erp/shared";
import type {
  CrmEmployee,
  CrmMessage,
  CrmMessageKind,
  CrmRequest,
  TemplateKey,
} from "@demo-erp/shared";
import { nextCrmId } from "./store.js";
import { crmSettings, szablon } from "./settings.js";

/** Kontekst podstawień dla jednej sprawy. */
export function kontekstSprawy(
    req: CrmRequest,
    extra: Record<string, string | null> = {},
): Record<string, string | null> {
  const k = ocenKompletnosc(req);
  const braki = k.missingFields.map((f) => `— ${CRM_DATA_FIELD_LABELS[f]}`);
  const brakiZal = k.missingAttachments.map((a) => `— ${ATTACHMENT_KIND_LABELS[a]}`);

  return {
    "klient.osoba": req.contactName,
    "klient.firma": req.companyName,
    "sprawa.numer": req.number,
    "sprawa.budowa": req.projectName,
    "sprawa.termin": req.deadline,
    "sprawa.adres": req.siteAddress,
    "sprawa.wartosc": req.quoteValue == null ? null : `${req.quoteValue} PLN`,
    "sprawa.dni": String(crmSettings.automation.responseDays),
    produkty: req.products,
    ilosc: req.quantity,
    "braki.lista": braki.length > 0 ? braki.join("\n") : "— potwierdzenie kompletności dokumentacji",
    "braki.zalaczniki": brakiZal.length > 0 ? brakiZal.join("\n") : "— (brak braków w załącznikach)",
    "firma.nazwa": crmSettings.company.name,
    "firma.email": crmSettings.company.email,
    "firma.telefon": crmSettings.company.phone,
    "firma.adres": crmSettings.company.address,
    ...extra,
  };
}

export function kontekstPracownika(p: CrmEmployee | undefined): Record<string, string | null> {
  return {
    "kosztorysant.imie": p?.name ?? null,
    "kosztorysant.email": p?.email ?? null,
    "kosztorysant.telefon": p?.phone ?? crmSettings.company.phone,
  };
}

/**
 * Zbudowanie wiadomości z szablonu. Zwraca szkic (`sentAt: null`) — decyzję
 * o wysyłce podejmuje człowiek albo automat, nigdy sama funkcja generująca.
 */
export function zSzablonu(
    key: TemplateKey,
    req: CrmRequest,
    opcje: {
      kind?: CrmMessageKind;
      authorName?: string;
      to?: string;
      ctx?: Record<string, string | null>;
    } = {},
): CrmMessage {
  const tpl = szablon(key);
  const ctx = { ...kontekstSprawy(req), ...(opcje.ctx ?? {}) };
  return {
    id: nextCrmId(),
    kind: opcje.kind ?? "custom",
    direction: "out",
    authorName: opcje.authorName ?? crmSettings.mailbox.displayName,
    contactId: null,
    to: opcje.to ?? req.email,
    subject: wypelnijSzablon(tpl.subject, ctx).text,
    body: wypelnijSzablon(tpl.body, ctx).text,
    createdAt: new Date().toISOString(),
    sentAt: null,
    sentFrom: null,
    templateKey: key,
  };
}

export const generujProsbeOUzupelnienie = (req: CrmRequest): CrmMessage =>
    zSzablonu("missing_data", req, { kind: "missing_data" });

export const generujProsbeOAdres = (req: CrmRequest): CrmMessage =>
    zSzablonu("address", req, { kind: "missing_data" });

export const generujProsbeOZalaczniki = (req: CrmRequest): CrmMessage =>
    zSzablonu("attachments", req, { kind: "missing_data" });

export const generujProsbeOTelefon = (req: CrmRequest, p?: CrmEmployee): CrmMessage =>
    zSzablonu("phone", req, { kind: "missing_data", ctx: kontekstPracownika(p) });

export const generujPotwierdzenieZapytania = (req: CrmRequest): CrmMessage =>
    zSzablonu("acknowledgement", req, { kind: "custom" });

export const generujInformacjeOOpiekunie = (req: CrmRequest, pracownik: CrmEmployee): CrmMessage =>
    zSzablonu("assignment", req, {
      kind: "assignment",
      authorName: pracownik.name,
      ctx: kontekstPracownika(pracownik),
    });

export const generujFollowUp = (req: CrmRequest, dni: number): CrmMessage =>
    zSzablonu("followup", req, { kind: "followup", ctx: { "sprawa.dni": String(dni) } });

/** Zapytanie do firmy zewnętrznej — ta sama treść, ale wysyłana osobno do każdej. */
export function generujZapytanieDoPodwykonawcy(
    req: CrmRequest,
    vendor: { name: string; email: string },
    element: { title: string; description: string; quantity: string | null; deadline: string | null },
): { to: string; subject: string; body: string } {
  const tpl = szablon("outsourcing");
  const ctx = kontekstSprawy(req, {
    "element.nazwa": element.title,
    "element.opis": element.description,
    ilosc: element.quantity,
    "sprawa.termin": element.deadline ?? req.deadline,
  });
  return {
    to: vendor.email,
    subject: wypelnijSzablon(tpl.subject, ctx).text,
    body: wypelnijSzablon(tpl.body, ctx).text,
  };
}

/** Ile dni temu wysłano wiadomość danego rodzaju — na potrzeby ostrzeżeń w UI. */
export const dniOdWyslania = (msg: CrmMessage): number | null =>
    msg.sentAt ? dniOdISO(msg.sentAt) : null;

/**
 * Punkt podmiany na prawdziwą wysyłkę przez konto Outlook:
 *
 *   export interface MailSender { send(msg: CrmMessage, from: string): Promise<void>; }
 *   export const mailSender: MailSender = new GraphMailSender({ tenantId, clientId, secret });
 *
 * Microsoft Graph (`POST /users/{account}/sendMail`) jest tu właściwszy niż
 * SMTP: konto firmowe zwykle ma wyłączone uwierzytelnianie podstawowe, a Graph
 * pozwala wysyłać „jako” skrzynka działu i zostawia kopię w Elementach
 * wysłanych — czyli tam, gdzie handlowcy i tak jej szukają.
 *
 * Endpoint wysyłki wywoła wtedy `await mailSender.send(msg, crmSettings.mailbox.account)`
 * przed ustawieniem `sentAt`; reszta modułu pozostaje bez zmian.
 */
export const wyslijMock = async (msg: CrmMessage): Promise<CrmMessage> => {
  await new Promise((r) => setTimeout(r, 250));
  return {
    ...msg,
    sentAt: new Date().toISOString(),
    sentFrom: crmSettings.mailbox.account,
  };
};