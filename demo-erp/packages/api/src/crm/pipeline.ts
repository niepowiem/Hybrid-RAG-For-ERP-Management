/**
 * pipeline.ts — automatyczne przetwarzanie pobranej poczty.
 *
 * Kolejność kroków jest stała i celowo płytka, żeby dało się ją opowiedzieć
 * jednym zdaniem: sklasyfikuj → wyodrębnij dane → rozpoznaj załączniki →
 * oceń kompletność → sprawdź duplikaty → załóż zapytanie albo odłóż
 * do weryfikacji.
 *
 * Każdy krok to osobna funkcja z osobnego pliku. Podmiana klasyfikatora
 * na model językowy albo ekstraktora na parser AI nie dotyka tego pliku
 * poza jedną linią importu.
 */

import { ocenKompletnosc, sugerowanyScoring } from "@demo-erp/shared";
import type {
  AttachmentKind,
  CrmMessage,
  CrmRequest,
  InboxMessage,
} from "@demo-erp/shared";
import { classifyMail } from "./classify.js";
import { znajdzLubUtworzKlienta } from "./clients.js";
import { obsluzOdmowe } from "./automation.js";
import { generujPotwierdzenieZapytania } from "./messages.js";
import { crmSettings } from "./settings.js";
import { znajdzDuplikat } from "./duplicates.js";
import { extractFromMail, rodzajZalacznika } from "./extract.js";
import { mailboxAdapter, MailboxError } from "./mailbox.js";
import type { RawMail } from "./mailbox.js";
import {
  crmRequests,
  inboxMessages,
  mailboxState,
  nextCrmId,
  nextCrmNumber,
  znanePobrania,
} from "./store.js";

export interface PollResult {
  fetched: number;
  created: number;
  needsReview: number;
  skipped: number;
  /** Wiadomości dodane w tym cyklu — front dopisuje je do listy. */
  added: InboxMessage[];
}

const spij = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));

/** Wymagane załączniki wywnioskowane z treści zapytania. */
function wymaganeZalaczniki(body: string, subject: string): AttachmentKind[] {
  const t = `${subject}\n${body}`.toLowerCase();
  const out: AttachmentKind[] = ["specification"];
  if (/(rysun|wg rysunku|dwg|dxf|wykonawcz)/.test(t)) out.push("drawing");
  return out;
}

/**
 * Nazwa budowy z tematu wiadomości. Odcinamy nagłówek grzecznościowy
 * („Zapytanie ofertowe — …”), bo na kafelku liczy się to, CO budujemy,
 * a nie to, że ktoś przysłał zapytanie — to widać z samej tablicy.
 */
function nazwaBudowy(subject: string, products: string | null): string {
  const bez = subject
      .replace(/^\s*(re|fwd|odp)\s*:\s*/i, "")
      .replace(
          /^\s*(zapytanie ofertowe|zapytanie o cen[ęe]|zapytanie|pro[śs]ba o wycen[ęe]|wycena|rfq)\s*[—–\-:]*\s*/i,
          "",
      )
      .trim();
  const kandydat = bez !== "" ? bez : (products ?? subject);
  return kandydat.length > 48
      ? `${kandydat.slice(0, 47).trimEnd()}…`
      : kandydat;
}

export function utworzZapytanieZWiadomosci(msg: InboxMessage): CrmRequest {
  const e = msg.extracted;
  const idPierwotnej = nextCrmId();
  // Załączniki wiążemy z wiadomością wątku, a nie z identyfikatorem z serwera
  // pocztowego — dzięki temu widok korespondencji potrafi je pokazać pod
  // właściwym wpisem.
  const attachments = msg.attachments.map((a) => ({
    ...a,
    id: nextCrmId(),
    messageId: idPierwotnej,
  }));
  const requiredAttachments = wymaganeZalaczniki(msg.body, msg.subject);

  const baza = {
    phone: e?.phone ?? null,
    address: e?.address ?? null,
    description: e?.description ?? msg.subject,
    products: e?.products ?? null,
    quantity: e?.quantity ?? null,
    deadline: e?.deadline ?? null,
    stage: "new" as const,
    requiredAttachments,
    attachments,
  };

  const nazwaFirmy = e?.companyName ?? msg.from;
  const klient = znajdzLubUtworzKlienta({
    name: nazwaFirmy,
    contactName: e?.contactName ?? msg.from,
    email: e?.email ?? msg.fromEmail,
    phone: e?.phone ?? null,
    address: e?.address ?? null,
  });

  // Wątek sprawy zaczyna się od wiadomości klienta — bez niej korespondencja
  // wyglądałaby, jakby zapytanie wzięło się znikąd, a załączniki nie miałyby
  // przy czym wisieć.
  const wiadomoscPierwotna: CrmMessage = {
    id: idPierwotnej,
    kind: "incoming",
    direction: "in",
    authorName: msg.from,
    contactId: null,
    to: "Dział Handlowy",
    subject: msg.subject,
    body: msg.body,
    createdAt: msg.receivedAt,
    sentAt: msg.receivedAt,
    sentFrom: null,
    templateKey: null,
  };

  const req: CrmRequest = {
    id: nextCrmId(),
    number: nextCrmNumber(),
    projectName: nazwaBudowy(msg.subject, e?.products ?? null),
    clientId: klient.id,
    siteAddress: e?.address ?? null,
    quoteValue: null,
    projectManagerId: null,
    // Każde zapytanie z poczty ląduje w „Nowych” i pulsuje, dopóki ktoś go nie tknie.
    columnId: "col-new",
    columnEnteredAt: new Date().toISOString(),
    seenAt: null,
    stageNotes: [],
    outsourcing: [],
    notes: "",
    companyName: nazwaFirmy,
    contactName: e?.contactName ?? msg.from,
    email: e?.email ?? msg.fromEmail,
    ...baza,
    source: "email",
    createdAt: new Date().toISOString(),
    assigneeIds: [],
    assigneeId: null,
    score: sugerowanyScoring(baza),
    lastContactAt: null,
    lostReason: null,
    lostReasonNote: null,
    sourceMessageId: msg.id,
    followUps: [],
    messages: [wiadomoscPierwotna],
    activity: [
      {
        id: nextCrmId(),
        at: new Date().toISOString(),
        kind: "created",
        text: "Zapytanie utworzone automatycznie z wiadomości e-mail.",
        user: "system",
      },
      {
        id: nextCrmId(),
        at: new Date().toISOString(),
        kind: "mail_fetched",
        text: `Pobrano wiadomość „${msg.subject}” od ${msg.fromEmail}.`,
        user: "system",
      },
    ],
  };
  return req;
}

/** Pojedyncza wiadomość: od surowego rekordu do wpisu w skrzynce. */
function przetworz(msg: InboxMessage): void {
  try {
    // 0. odpowiedź na follow-up: rezygnacja klienta zamyka sprawę.
    //    Sprawdzamy PRZED klasyfikacją, bo „nie jesteśmy zainteresowani” nie
    //    jest zapytaniem ofertowym i klasyfikator odłożyłby to na bok.
    const odmowa = obsluzOdmowe(msg.fromEmail, msg.subject, msg.body);
    if (odmowa) {
      msg.status = "processed";
      msg.category = "other";
      msg.crmRequestId = odmowa.id;
      msg.note = `Odpowiedź odczytana jako rezygnacja — zapytanie ${odmowa.number} przeniesione do przegranych.`;
      // Treść odpowiedzi ląduje w korespondencji sprawy, żeby było widać,
      // na jakiej podstawie automat ją zamknął.
      odmowa.messages.push({
        id: nextCrmId(),
        kind: "incoming",
        direction: "in",
        authorName: msg.from,
        contactId: null,
        to: "Dział Handlowy",
        subject: msg.subject,
        body: msg.body,
        createdAt: msg.receivedAt,
        sentAt: msg.receivedAt,
        sentFrom: null,
        templateKey: null,
      });
      return;
    }

    // 1. klasyfikacja
    const kl = classifyMail(msg.subject, msg.body);
    if (!msg.categoryManual) msg.category = kl.category;

    if (msg.category === "other") {
      msg.status = "skipped";
      msg.note = `Zaklasyfikowano jako pozostałą korespondencję${
          kl.reasons.length > 0 ? ` (${kl.reasons[0]})` : ""
      }.`;
      return;
    }

    // 2. ekstrakcja danych + 3. rozpoznanie załączników (już przy pobraniu)
    msg.extracted = extractFromMail({
      from: msg.from,
      fromEmail: msg.fromEmail,
      subject: msg.subject,
      body: msg.body,
      attachments: msg.attachments,
    });

    // 5. duplikaty — sprawdzane przed założeniem zapytania
    const dup = znajdzDuplikat(crmRequests, {
      fromEmail: msg.fromEmail,
      subject: msg.subject,
      extracted: msg.extracted,
    });
    if (dup) {
      msg.status = "needs_review";
      msg.duplicateOfId = dup.requestId;
      msg.note = `Możliwy duplikat zapytania ${dup.number}: ${dup.reasons.join(", ")}. Zapytanie nie zostało utworzone automatycznie.`;
      return;
    }

    // 6. utworzenie zapytania CRM
    const req = utworzZapytanieZWiadomosci(msg);
    crmRequests.unshift(req);
    msg.crmRequestId = req.id;

    // 7. potwierdzenie przyjęcia — wychodzi od razu, bo klient ma się
    //    dowiedzieć, że wiadomość doszła, zanim zdąży zadzwonić z pytaniem.
    if (crmSettings.automation.acknowledgeNewRequests) {
      const potwierdzenie = generujPotwierdzenieZapytania(req);
      potwierdzenie.sentAt = new Date().toISOString();
      potwierdzenie.sentFrom = crmSettings.mailbox.account;
      req.messages.push(potwierdzenie);
      req.lastContactAt = potwierdzenie.sentAt;
      req.activity.push({
        id: nextCrmId(),
        at: potwierdzenie.sentAt,
        kind: "message_sent",
        text: `Automat: wysłano potwierdzenie przyjęcia zapytania do ${req.email}.`,
        user: "system",
      });
    }

    // 4. ocena kompletności decyduje, czy sprawa wymaga ludzkiego oka
    const k = ocenKompletnosc(req);
    if (k.status === "missing_data" || msg.extracted.companyName == null) {
      msg.status = "needs_review";
      msg.note =
          "Zapytanie utworzone, ale nie udało się odczytać kompletu danych — sprawdź i uzupełnij ręcznie.";
    } else {
      msg.status = "processed";
      msg.note = null;
    }
  } catch (e) {
    msg.status = "error";
    msg.note = `Błąd przetwarzania: ${(e as Error).message}`;
  }
}

function doWiadomosci(raw: RawMail): InboxMessage {
  return {
    id: nextCrmId(),
    externalId: raw.messageId,
    from: raw.from,
    fromEmail: raw.fromEmail,
    subject: raw.subject,
    receivedAt: raw.receivedAt,
    body: raw.body,
    attachments: raw.attachments.map((a) => ({
      id: nextCrmId(),
      name: a.name,
      kind: rodzajZalacznika(a.name),
      sizeKb: a.sizeKb,
      // Wszystko, co przyszło pocztą, jest z definicji plikiem od klienta;
      // zapamiętujemy też, z której wiadomości, żeby dało się wrócić do źródła.
      source: "client" as const,
      at: raw.receivedAt,
      fromName: raw.from,
      messageId: raw.messageId,
      messageSubject: raw.subject,
    })),
    status: "processing",
    category: "other",
    categoryManual: false,
    extracted: null,
    crmRequestId: null,
    duplicateOfId: null,
    note: null,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Pełny cykl: pobranie + przetworzenie. Wywoływane przez endpoint
 * „Sprawdź teraz” oraz przez automatyczne odpytywanie z przeglądarki.
 */
export async function pobierzIPrzetworz(): Promise<PollResult> {
  let surowe: RawMail[];
  try {
    surowe = await mailboxAdapter.fetchNew(znanePobrania);
  } catch (e) {
    mailboxState.lastCheckedAt = new Date().toISOString();
    mailboxState.lastResult = "error";
    mailboxState.lastError =
        e instanceof MailboxError
            ? e.message
            : "Nieznany błąd połączenia ze skrzynką.";
    throw e;
  }

  const dodane: InboxMessage[] = [];
  for (const raw of surowe) {
    // Znacznik zakładamy od razu: gdyby dwa cykle nałożyły się na siebie,
    // druga tura nie może pobrać tej samej wiadomości drugi raz.
    znanePobrania.add(raw.messageId);
    const msg = doWiadomosci(raw);
    inboxMessages.unshift(msg);
    dodane.push(msg);
  }

  // Krótka pauza między pobraniem a przetworzeniem: status „przetwarzanie”
  // ma być realnym stanem, a nie etykietą, której nikt nigdy nie zobaczy.
  if (dodane.length > 0) await spij(400);
  for (const msg of dodane) przetworz(msg);

  mailboxState.lastCheckedAt = new Date().toISOString();
  mailboxState.lastResult = "ok";
  mailboxState.lastError = null;
  mailboxState.newCount = dodane.length;
  mailboxState.totalFetched = inboxMessages.length;

  return {
    fetched: dodane.length,
    created: dodane.filter((m) => m.crmRequestId != null).length,
    needsReview: dodane.filter((m) => m.status === "needs_review").length,
    skipped: dodane.filter((m) => m.status === "skipped").length,
    added: dodane,
  };
}

/** Ponowne przetworzenie wiadomości — np. po ręcznej zmianie kategorii. */
export function przetworzPonownie(msg: InboxMessage): void {
  msg.status = "processing";
  msg.duplicateOfId = null;
  msg.note = null;
  przetworz(msg);
}