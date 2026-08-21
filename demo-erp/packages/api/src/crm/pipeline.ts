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

import { sugerowanyScoring } from "@demo-erp/shared";
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
import { extractRoundWithOllama } from "./ollama-extractor.js";
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
    authorId: null,
    contactId: null,
    cc: [],
    readBy: [],
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
    stickyNotes: [],
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

/**
 * Wysyła jedno automatyczne potwierdzenie, gdy wiadomość trafia na tablicę.
 * Wspólna funkcja obsługuje zarówno klasyfikację automatyczną, jak i
 * ręczną akceptację ze skrzynki, bez ryzyka podwójnej wysyłki.
 */
export function wyslijPotwierdzeniePrzyjecia(req: CrmRequest): void {
  if (!crmSettings.automation.acknowledgeNewRequests) return;
  if (req.messages.some((m) => m.templateKey === "acknowledgement" && m.sentAt)) return;

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

/** Pojedyncza wiadomość: od surowego rekordu do wpisu w skrzynce. */
async function przetworz(msg: InboxMessage): Promise<void> {
  try {
    const klasyfikacjaAutomatyczna = crmSettings.automation.mailClassificationMode === "automatic";
    let przeslankiKlasyfikacji: string[] = [];

    if (!klasyfikacjaAutomatyczna) {
      msg.classification = null;
    }

    if (!klasyfikacjaAutomatyczna && !msg.categoryManual) {
      msg.extracted = extractFromMail({
        from: msg.from,
        fromEmail: msg.fromEmail,
        subject: msg.subject,
        body: msg.body,
        attachments: msg.attachments,
      });
      msg.status = "needs_review";
      msg.note = null;
      return;
    }

    if (klasyfikacjaAutomatyczna) {
      // Klasyfikacja jest pierwszą bramką bezpieczeństwa. Dzięki temu
      // awaria DGX blokuje również automatyczne zamknięcie sprawy jako odmowy.
      const kl = await classifyMail(msg.subject, msg.body, {
        messageId: msg.externalId,
        attachments: msg.attachments.map((attachment) => attachment.name),
      });
      przeslankiKlasyfikacji = kl.reasons;
      msg.classification = {
        source: kl.source,
        confidence: kl.confidence,
        threshold: kl.threshold,
        modelName: kl.modelName,
        modelVersion: kl.modelVersion,
        latencyMs: kl.latencyMs,
        usedFallback: kl.usedFallback,
        fallbackReason: kl.fallbackReason,
      };
      if (!msg.categoryManual) msg.category = kl.category;

      // Jeżeli skonfigurowany model zniknął, nie wysyłamy automatycznej
      // odpowiedzi na podstawie samych reguł. Wiadomość zostaje w skrzynce
      // do weryfikacji, więc awaria DGX nie może po cichu zgubić leada.
      if (kl.usedFallback && !msg.categoryManual) {
        msg.status = "needs_review";
        msg.note = null;
        return;
      }
    }

    // 0. Odpowiedź na follow-up: dopiero po udanej klasyfikacji może zamknąć
    // sprawę. Przy fallbacku powyżej zawsze decyduje człowiek.
    const odmowa = klasyfikacjaAutomatyczna ? obsluzOdmowe(msg.fromEmail, msg.subject, msg.body) : null;
    if (odmowa) {
      msg.status = "processed";
      msg.category = "other";
      msg.crmRequestId = odmowa.id;
      msg.note = `Odpowiedź odczytana jako rezygnacja - zapytanie ${odmowa.number} przeniesione do przegranych.`;
      odmowa.messages.push({
        id: nextCrmId(),
        kind: "incoming",
        direction: "in",
        authorName: msg.from,
        authorId: null,
        contactId: null,
        cc: [],
        readBy: [],
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

    if (msg.category === "other") {
      msg.status = "skipped";
      msg.note = `Zaklasyfikowano jako pozostałą korespondencję${
          przeslankiKlasyfikacji.length > 0 ? ` (${przeslankiKlasyfikacji[0]})` : ""
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
    msg.duplicateOfId = dup?.requestId ?? null;
    // Klasyfikacja kończy się w kolejce „Do zatwierdzenia”. Dopiero jawna
    // akcja operatora może utworzyć klienta, sprawę CRM i potwierdzenie.
    msg.status = "needs_review";
    msg.crmRequestId = null;
    msg.note = null;
    return;
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
    classification: null,
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
  for (const msg of dodane) await przetworz(msg);

  // Drugi etap zaczyna się dopiero wtedy, gdy DGX zakończy klasyfikację całej
  // tury. Do Ollamy trafiają wyłącznie potwierdzone wyniki klasyfikatora AI,
  // nigdy wiadomości z fallbacku regułowego ani pozostała korespondencja.
  const zapytaniaDoEkstrakcji = dodane.filter((msg) =>
    msg.category === "inquiry" &&
    msg.classification?.source === "dgx" &&
    !msg.classification.usedFallback &&
    msg.crmRequestId == null,
  );
  try {
    const wynikiOllamy = await extractRoundWithOllama(zapytaniaDoEkstrakcji);
    for (const msg of zapytaniaDoEkstrakcji) {
      const extracted = wynikiOllamy.get(msg.externalId);
      if (!extracted) continue;
      msg.extracted = extracted;
      const duplicate = znajdzDuplikat(crmRequests, {
        fromEmail: msg.fromEmail,
        subject: msg.subject,
        extracted,
      });
      msg.duplicateOfId = duplicate?.requestId ?? null;
    }
  } catch {
    // Bezpieczny fallback: zachowujemy konserwatywny wynik lokalnego parsera.
    // Wiadomość nadal czeka na zatwierdzenie i nie tworzy automatycznie CRM.
  }

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
export async function przetworzPonownie(msg: InboxMessage): Promise<void> {
  msg.status = "processing";
  msg.duplicateOfId = null;
  msg.note = null;
  await przetworz(msg);
}
