/**
 * crm/routes.ts — endpointy modułu CRM.
 *
 * Kontrakt identyczny jak w routes.ts magazynu: błędy z rejestru,
 * walidacja schematami z pakietu shared, rola w nagłówku x-user-role.
 * Rejestrowane z registerRoutes() jednym wywołaniem, żeby główny plik tras
 * nie puchł o kolejne kilkaset linii.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AppError,
  ChangeStageSchema,
  CreateColumnSchema,
  CreateContactSchema,
  CreateCrmRequestSchema,
  CreateOutsourcingSchema,
  ComposeMessageSchema,
  SelectVendorSchema,
  RecordQuoteSchema,
  TEMPLATE_KEYS,
  UpdateSettingsSchema,
  CreateFollowUpSchema,
  MoveRequestSchema,
  PatchRequestSchema,
  StageNoteInputSchema,
  CRM_MESSAGE_KIND_LABELS,
  CRM_STAGE_LABELS,
  LOST_REASON_LABELS,
  MAIL_CATEGORIES,
  ROLES,
  UpdateCrmRequestSchema,
  CRM_STAGE_SHORT,
  dzisiajISO,
  sugerowanyScoring,
} from "@demo-erp/shared";
import type {
  ActivityKind,
  CrmActivity,
  CrmColumn,
  CrmMessage,
  CrmRequest,
  OutsourcingItem,
  MailCategory,
  Role,
} from "@demo-erp/shared";
import {
  crmClients,
  crmColumns,
  crmEmployees,
  crmRequests,
  inboxMessages,
  mailboxState,
  nextColumnId,
  nextCrmId,
  nextCrmNumber,
} from "./store.js";
import { znajdzLubUtworzKlienta } from "./clients.js";
import { przetworzAutomaty, symulujOdpowiedziPodwykonawcow } from "./automation.js";
import { crmVendors } from "./vendors.js";
import { rodzajZalacznika } from "./extract.js";
import { mailboxAdapter } from "./mailbox.js";
import { pobierzIPrzetworz, przetworzPonownie, utworzZapytanieZWiadomosci } from "./pipeline.js";
import {
  generujInformacjeOOpiekunie,
  generujProsbeOUzupelnienie,
  generujZapytanieDoPodwykonawcy,
  kontekstPracownika,
  wyslijMock,
  zSzablonu,
} from "./messages.js";
import { crmSettings, wylaczoneReguly } from "./settings.js";

function roleFrom(header: unknown): Role {
  const value = typeof header === "string" ? header : "";
  return (ROLES as readonly string[]).includes(value) ? (value as Role) : "magazynier";
}

const userFrom = (role: Role): string => (role === "kierownik" ? "mnowak" : "jkowalski");

function wpis(req: CrmRequest, kind: ActivityKind, text: string, user: string): void {
  const a: CrmActivity = { id: nextCrmId(), at: new Date().toISOString(), kind, text, user };
  req.activity.push(a);
}

function znajdzZapytanie(id: string): CrmRequest {
  const r = crmRequests.find((x) => x.id === id);
  if (!r) throw new AppError("ERR-9001", { crmRequestId: id });
  return r;
}

/**
 * Follow-upy przeterminowane wykrywamy przy odczycie, a nie zadaniem
 * cyklicznym — w demo bez schedulera to jedyny uczciwy sposób, żeby status
 * zawsze zgadzał się z kalendarzem.
 */
function odswiezFollowUpy(): void {
  const dzis = dzisiajISO();
  for (const r of crmRequests) {
    for (const f of r.followUps) {
      if (f.status === "planned" && f.date < dzis) f.status = "overdue";
    }
  }
}

/** Porządkowanie kolejności kolumn po dodaniu lub usunięciu. */
function przenumerujKolumny(): void {
  // Kolumny wynikowe („Wygrane”, „Przegrane”) zawsze na końcu tablicy —
  // archiwum nie ma prawa rozdzielać kolumn, w których trwa praca.
  const wynik = crmColumns
      .filter((c) => c.kind === "won" || c.kind === "lost")
      .sort((a, b) => (a.kind === "won" ? -1 : 1) - (b.kind === "won" ? -1 : 1));
  const reszta = crmColumns
      .filter((c) => c.kind !== "won" && c.kind !== "lost")
      .sort((a, b) => a.order - b.order);
  [...reszta, ...wynik].forEach((c, i) => {
    c.order = i;
  });
}

export function registerCrmRoutes(app: FastifyInstance): void {
  // ------------------------------ słowniki --------------------------------

  app.get("/api/crm/employees", async () => crmEmployees);

  // ------------------------------ zapytania -------------------------------

  app.get("/api/crm/requests", async () => {
    odswiezFollowUpy();
    return [...crmRequests].sort((a, b) => b.number.localeCompare(a.number));
  });

  app.get("/api/crm/requests/:id", async (req) => {
    odswiezFollowUpy();
    const { id } = req.params as { id: string };
    return znajdzZapytanie(id);
  });

  app.post("/api/crm/requests", async (req) => {
    const input = CreateCrmRequestSchema.parse(req.body);
    const user = userFrom(roleFrom(req.headers["x-user-role"]));

    const baza = {
      phone: input.phone,
      address: input.address,
      description: input.description,
      products: input.products,
      quantity: input.quantity,
      deadline: input.deadline,
      stage: "new" as const,
      requiredAttachments: input.requiredAttachments,
      attachments: [],
    };

    const klient = znajdzLubUtworzKlienta({
      name: input.companyName,
      contactName: input.contactName,
      email: input.email,
      phone: input.phone,
      address: input.address,
    });
    // Zapytanie zakładane ręcznie trafia od razu do kolumny kosztorysanta,
    // jeśli go wskazano — inaczej do „Nowych”.
    const kolumna = input.assigneeId
        ? (crmColumns.find((c) => c.employeeId === input.assigneeId)?.id ?? "col-new")
        : "col-new";

    const nowe: CrmRequest = {
      id: nextCrmId(),
      number: nextCrmNumber(),
      projectName: input.projectName,
      clientId: klient.id,
      siteAddress: input.siteAddress ?? input.address,
      quoteValue: input.quoteValue,
      projectManagerId: null,
      columnId: kolumna,
      columnEnteredAt: new Date().toISOString(),
      // Ręcznie założone zapytanie jest z definicji „widziane” — nie pulsuje.
      seenAt: new Date().toISOString(),
      stageNotes: [],
      outsourcing: [],
      notes: "",
      companyName: input.companyName,
      contactName: input.contactName,
      email: input.email,
      ...baza,
      source: input.source,
      createdAt: new Date().toISOString(),
      assigneeIds: input.assigneeId ? [input.assigneeId] : [],
      assigneeId: input.assigneeId,
      // Domyślny scoring z reguły demonstracyjnej — użytkownik może nadpisać.
      score: sugerowanyScoring(baza),
      lastContactAt: null,
      lostReason: null,
      lostReasonNote: null,
      sourceMessageId: null,
      followUps: [],
      messages: [],
      activity: [],
    };
    wpis(nowe, "created", "Zapytanie utworzone ręcznie.", user);
    if (input.assigneeId) {
      const p = crmEmployees.find((e) => e.id === input.assigneeId);
      if (p) wpis(nowe, "assignee_changed", `Przypisano do: ${p.name}.`, user);
    }
    crmRequests.unshift(nowe);
    return nowe;
  });

  app.put("/api/crm/requests/:id", async (req) => {
    const { id } = req.params as { id: string };
    const r = znajdzZapytanie(id);
    const input = UpdateCrmRequestSchema.parse(req.body);
    const user = userFrom(roleFrom(req.headers["x-user-role"]));

    const zmiany: string[] = [];
    const porownaj = (etykieta: string, stare: unknown, nowe: unknown): void => {
      if ((stare ?? "") !== (nowe ?? "")) zmiany.push(etykieta);
    };
    porownaj("nazwa firmy", r.companyName, input.companyName);
    porownaj("osoba kontaktowa", r.contactName, input.contactName);
    porownaj("e-mail", r.email, input.email);
    porownaj("telefon", r.phone, input.phone);
    porownaj("adres", r.address, input.address);
    porownaj("opis", r.description, input.description);
    porownaj("produkty", r.products, input.products);
    porownaj("ilość", r.quantity, input.quantity);
    porownaj("termin", r.deadline, input.deadline);
    porownaj("nazwa budowy", r.projectName, input.projectName);
    porownaj("adres budowy", r.siteAddress, input.siteAddress);
    porownaj("wartość wyceny", r.quoteValue, input.quoteValue);

    Object.assign(r, {
      projectName: input.projectName,
      siteAddress: input.siteAddress,
      quoteValue: input.quoteValue,
      companyName: input.companyName,
      contactName: input.contactName,
      email: input.email,
      phone: input.phone,
      address: input.address,
      description: input.description,
      products: input.products,
      quantity: input.quantity,
      deadline: input.deadline,
      requiredAttachments: input.requiredAttachments,
    });

    if (input.assigneeId !== r.assigneeId) {
      const p = crmEmployees.find((e) => e.id === input.assigneeId);
      r.assigneeId = input.assigneeId;
      // Kolumna tablicy idzie za przypisaniem — inaczej karta zostałaby
      // w kolumnie poprzedniego kosztorysanta.
      r.columnId = input.assigneeId
          ? (crmColumns.find((c) => c.employeeId === input.assigneeId)?.id ?? r.columnId)
          : "col-new";
      wpis(r, "assignee_changed", p ? `Przypisano do: ${p.name}.` : "Zdjęto przypisanie.", user);
    }

    if (zmiany.length > 0) {
      wpis(r, "data_changed", `Zmieniono dane: ${zmiany.join(", ")}.`, user);
    }
    return r;
  });

  app.post("/api/crm/requests/:id/stage", async (req) => {
    const { id } = req.params as { id: string };
    const r = znajdzZapytanie(id);
    const input = ChangeStageSchema.parse(req.body);
    const user = userFrom(roleFrom(req.headers["x-user-role"]));

    if (input.stage === "lost" && !input.lostReason) {
      throw new AppError("ERR-9002", { number: r.number });
    }

    if (r.stage !== input.stage) {
      wpis(
          r,
          "stage_changed",
          `Etap zmieniony: ${CRM_STAGE_LABELS[r.stage]} → ${CRM_STAGE_LABELS[input.stage]}.`,
          user,
      );
      r.stage = input.stage;
    }

    if (input.stage === "lost" && input.lostReason) {
      const opis =
          input.lostReason === "other"
              ? `${LOST_REASON_LABELS.other}: ${input.lostReasonNote ?? ""}`.trim()
              : LOST_REASON_LABELS[input.lostReason];
      if (r.lostReason !== input.lostReason || r.lostReasonNote !== (input.lostReasonNote ?? null)) {
        wpis(r, "lost_reason_changed", `Przyczyna przegranej: ${opis}`, user);
      }
      r.lostReason = input.lostReason;
      r.lostReasonNote = input.lostReasonNote ?? null;
    }
    if (input.stage !== "lost") {
      r.lostReason = null;
      r.lostReasonNote = null;
    }
    return r;
  });

  // -------------------------------- tablica --------------------------------

  app.get("/api/crm/clients", async () => crmClients);

  app.get("/api/crm/board", async () => {
    odswiezFollowUpy();
    // Automaty w demo chodzą przy odczycie tablicy — nie ma tu schedulera,
    // a odpytywanie skrzynki i tak pracuje w tle co 30 sekund.
    przetworzAutomaty();
    symulujOdpowiedziPodwykonawcow();
    return {
      columns: [...crmColumns].sort((a, b) => a.order - b.order),
      requests: crmRequests,
      clients: crmClients,
      employees: crmEmployees,
      /** Reguły wyłączone w ustawieniach — interfejs liczy problemy tak samo. */
      disabledIssues: wylaczoneReguly(),
      settings: crmSettings,
    };
  });

  app.post("/api/crm/board/columns", async (req) => {
    const input = CreateColumnSchema.parse(req.body);
    const employee = input.employeeId
        ? crmEmployees.find((e) => e.id === input.employeeId)
        : undefined;
    if (input.employeeId && !employee) throw new AppError("ERR-9007", { employeeId: input.employeeId });
    if (employee && crmColumns.some((c) => c.employeeId === employee.id)) {
      throw new AppError("ERR-9008", { employeeId: employee.id, name: employee.name });
    }

    const kolumna: CrmColumn = {
      id: nextColumnId(),
      color: "default",
      // Kolumna kosztorysanta zawsze nosi jego imię — inaczej po tygodniu nikt
      // nie wie, czyja to kolumna.
      title: employee ? employee.name : input.title,
      kind: employee ? "estimator" : "custom",
      employeeId: employee?.id ?? null,
      // Przed „Przegranymi”, żeby archiwum zostało na końcu tablicy.
      order: Math.max(...crmColumns.map((c) => c.order)) - 1.5,
      removable: true,
    };
    crmColumns.push(kolumna);
    przenumerujKolumny();
    return kolumna;
  });

  app.delete("/api/crm/board/columns/:cid", async (req) => {
    const { cid } = req.params as { cid: string };
    const kol = crmColumns.find((c) => c.id === cid);
    if (!kol) throw new AppError("ERR-9009", { columnId: cid });
    if (!kol.removable) throw new AppError("ERR-9010", { title: kol.title });

    // Karty z usuwanej kolumny wracają do „Nowych” razem ze zdjęciem
    // przypisania — nie znikają razem z kolumną.
    const user = userFrom(roleFrom(req.headers["x-user-role"]));
    for (const r of crmRequests.filter((x) => x.columnId === cid)) {
      r.columnId = "col-new";
      if (kol.employeeId) r.assigneeId = null;
      wpis(r, "stage_changed", `Kolumna „${kol.title}” została usunięta — zapytanie wróciło do „Nowych”.`, user);
    }
    crmColumns.splice(crmColumns.indexOf(kol), 1);
    przenumerujKolumny();
    return { removed: cid, columns: [...crmColumns].sort((a, b) => a.order - b.order) };
  });

  /**
   * Przeniesienie karty. Kolumna jest jedynym miejscem, w którym ustala się
   * przypisanie do kosztorysanta — stąd synchronizacja `assigneeId` tutaj,
   * a nie w osobnej akcji, o której łatwo zapomnieć.
   */
  app.post("/api/crm/requests/:id/column", async (req) => {
    const { id } = req.params as { id: string };
    const r = znajdzZapytanie(id);
    const input = MoveRequestSchema.parse(req.body);
    const kol = crmColumns.find((c) => c.id === input.columnId);
    if (!kol) throw new AppError("ERR-9009", { columnId: input.columnId });
    const user = userFrom(roleFrom(req.headers["x-user-role"]));

    if (kol.kind === "lost" && !input.lostReason) {
      throw new AppError("ERR-9002", { number: r.number });
    }

    if (r.columnId !== kol.id) {
      const skad = crmColumns.find((c) => c.id === r.columnId)?.title ?? "?";
      r.columnId = kol.id;
      r.columnEnteredAt = new Date().toISOString();
      wpis(r, "stage_changed", `Karta przeniesiona: ${skad} → ${kol.title}.`, user);
    }

    // Przeciągnięcie do kosztorysanta jest równoznaczne z przypisaniem sprawy.
    // Poprzedni kosztorysanci ZOSTAJĄ na liście — to zapis, kto miał ze sprawą
    // styczność, a nie pole „aktualny właściciel”. Kto ma wypaść, usuwa się
    // ręcznie z panelu szczegółów.
    if (kol.kind === "estimator" && kol.employeeId && r.assigneeId !== kol.employeeId) {
      const p = crmEmployees.find((e) => e.id === kol.employeeId);
      r.assigneeId = kol.employeeId;
      if (!r.assigneeIds.includes(kol.employeeId)) r.assigneeIds.push(kol.employeeId);
      wpis(r, "assignee_changed", `Przypisano do: ${p?.name ?? kol.title}.`, user);
      if (r.stage === "new") {
        wpis(r, "stage_changed", `Etap zmieniony: ${CRM_STAGE_LABELS.new} → ${CRM_STAGE_LABELS.contact}.`, user);
        r.stage = "contact";
      }
    }
    if (kol.kind === "new" && r.assigneeId) {
      r.assigneeId = null;
      r.assigneeIds = [];
      wpis(r, "assignee_changed", "Zdjęto przypisanie — zapytanie wróciło do „Nowych”.", user);
    }
    if (kol.kind === "won" && r.stage !== "won") {
      wpis(r, "stage_changed", `Etap zmieniony: ${CRM_STAGE_LABELS[r.stage]} → ${CRM_STAGE_LABELS.won}.`, user);
      r.stage = "won";
      r.lostReason = null;
      r.lostReasonNote = null;
    }
    if (kol.kind === "lost" && input.lostReason) {
      const opis =
          input.lostReason === "other"
              ? `${LOST_REASON_LABELS.other}: ${input.lostReasonNote ?? ""}`.trim()
              : LOST_REASON_LABELS[input.lostReason];
      r.stage = "lost";
      r.lostReason = input.lostReason;
      r.lostReasonNote = input.lostReasonNote ?? null;
      wpis(r, "lost_reason_changed", `Przyczyna przegranej: ${opis}`, user);
    }

    // Karta dotknięta = karta zobaczona; przestaje pulsować.
    r.seenAt ??= new Date().toISOString();
    return r;
  });

  /**
   * Usunięcie kosztorysanta z listy osób, które miały styczność ze sprawą.
   * Gdy usuwamy bieżącego opiekuna, rolę przejmuje poprzedni z listy —
   * sprawa bez opiekuna po cichu to sprawa, którą nikt się nie zajmuje.
   */
  app.delete("/api/crm/requests/:id/assignees/:eid", async (req) => {
    const { id, eid } = req.params as { id: string; eid: string };
    const r = znajdzZapytanie(id);
    const user = userFrom(roleFrom(req.headers["x-user-role"]));
    const p = crmEmployees.find((e) => e.id === eid);
    if (!r.assigneeIds.includes(eid)) throw new AppError("ERR-9012", { employeeId: eid });

    r.assigneeIds = r.assigneeIds.filter((x) => x !== eid);
    r.assigneeId = r.assigneeIds.at(-1) ?? null;
    wpis(r, "assignee_changed", `Usunięto z listy kosztorysantów: ${p?.name ?? eid}.`, user);

    // Karta bez kosztorysanta nie ma czego szukać w kolumnie kosztorysanta.
    const kol = crmColumns.find((c) => c.id === r.columnId);
    if (kol?.kind === "estimator" && kol.employeeId === eid) {
      r.columnId = r.assigneeId
          ? (crmColumns.find((c) => c.employeeId === r.assigneeId)?.id ?? "col-new")
          : "col-new";
      r.columnEnteredAt = new Date().toISOString();
    }
    return r;
  });

  /** Dodanie osoby kontaktowej do kartoteki klienta. */
  app.post("/api/crm/clients/:cid/contacts", async (req) => {
    const { cid } = req.params as { cid: string };
    const klient = crmClients.find((k) => k.id === cid);
    if (!klient) throw new AppError("ERR-9011", { clientId: cid });
    const input = CreateContactSchema.parse(req.body);
    const kontakt = {
      id: `${cid}-c${klient.contacts.length + 1}`,
      name: input.name,
      email: input.email?.toLowerCase() ?? "",
      phone: input.phone,
      role: input.role,
    };
    // Dodanie kontaktu jest operacją dokładającą, nie nadpisującą — dlatego
    // wolno ją wykonać z poziomu zapytania, w odróżnieniu od edycji danych
    // klienta, która zmieniłaby historię wszystkich jego spraw.
    klient.contacts.push(kontakt);
    return klient;
  });

  // ------------------------------ ustawienia -------------------------------

  app.get("/api/crm/settings", async () => crmSettings);

  app.put("/api/crm/settings", async (req) => {
    const input = UpdateSettingsSchema.parse(req.body);
    // Scalanie płytkie po sekcjach: interfejs zapisuje pojedynczą sekcję
    // (np. same szablony), a reszta ustawień ma zostać nietknięta.
    if (input.mailbox) Object.assign(crmSettings.mailbox, input.mailbox);
    if (input.company) Object.assign(crmSettings.company, input.company);
    if (input.automation) Object.assign(crmSettings.automation, input.automation);
    if (input.issues) Object.assign(crmSettings.issues, input.issues);
    if (input.templates) crmSettings.templates = input.templates;
    return crmSettings;
  });

  // ------------------------- kartoteka: kontakty ----------------------------

  app.put("/api/crm/clients/:cid/contacts/:kid", async (req) => {
    const { cid, kid } = req.params as { cid: string; kid: string };
    const klient = crmClients.find((k) => k.id === cid);
    if (!klient) throw new AppError("ERR-9011", { clientId: cid });
    const kontakt = klient.contacts.find((k) => k.id === kid);
    if (!kontakt) throw new AppError("ERR-9016", { contactId: kid });
    const input = CreateContactSchema.parse(req.body);
    Object.assign(kontakt, {
      name: input.name,
      email: input.email?.toLowerCase() ?? "",
      phone: input.phone,
      role: input.role,
    });
    // Kontakt główny jest źródłem danych na zapytaniach — po jego edycji
    // odświeżamy je, żeby wiadomości nie szły na nieaktualny adres.
    if (klient.contacts[0]?.id === kontakt.id) {
      klient.contactName = kontakt.name;
      klient.phone = kontakt.phone;
      // Adres podmieniamy tylko, gdy kontakt główny go ma — inaczej klient
      // straciłby adres, na który idzie cała korespondencja.
      if (kontakt.email !== "") klient.email = kontakt.email;
      for (const r of crmRequests.filter((x) => x.clientId === klient.id)) {
        r.contactName = kontakt.name;
        r.phone = kontakt.phone;
        if (kontakt.email !== "") r.email = kontakt.email;
      }
    }
    return klient;
  });

  app.delete("/api/crm/clients/:cid/contacts/:kid", async (req) => {
    const { cid, kid } = req.params as { cid: string; kid: string };
    const klient = crmClients.find((k) => k.id === cid);
    if (!klient) throw new AppError("ERR-9011", { clientId: cid });
    const kontakt = klient.contacts.find((k) => k.id === kid);
    if (!kontakt) throw new AppError("ERR-9016", { contactId: kid });
    if (klient.contacts.length === 1) throw new AppError("ERR-9017", { clientId: cid });
    klient.contacts = klient.contacts.filter((k) => k.id !== kid);
    // Usunięcie kontaktu głównego przesuwa na jego miejsce następny — klient
    // bez adresu e-mail wypadłby z całej korespondencji.
    const glowny = klient.contacts[0]!;
    klient.contactName = glowny.name;
    klient.phone = glowny.phone;
    if (glowny.email !== "") klient.email = glowny.email;
    return klient;
  });

  // ------------------------------ outsourcing ------------------------------

  app.get("/api/crm/vendors", async () => crmVendors);

  /**
   * Wysłanie zapytania o wycenę elementu do wybranych firm.
   * Każda firma dostaje OSOBNĄ wiadomość ze swoim adresem w polu „do” —
   * to, że pytamy kilka firm naraz, jest naszą wiedzą negocjacyjną.
   */
  app.post("/api/crm/requests/:id/outsourcing", async (req) => {
    const { id } = req.params as { id: string };
    const r = znajdzZapytanie(id);
    const input = CreateOutsourcingSchema.parse(req.body);
    const user = userFrom(roleFrom(req.headers["x-user-role"]));
    const teraz = new Date().toISOString();

    const elements = input.elements.map((e) => ({
      id: nextCrmId(),
      title: e.title,
      description: e.description,
      quantity: e.quantity,
    }));

    const item: OutsourcingItem = {
      id: nextCrmId(),
      title: input.title,
      deadline: input.deadline,
      createdAt: teraz,
      createdBy: user,
      elements,
      selectedVendorId: null,
      inquiries: input.vendors.map((v, i) => {
        const vendor = crmVendors.find((x) => x.id === v.vendorId);
        if (!vendor) throw new AppError("ERR-9013", { vendorId: v.vendorId });
        const moje = v.elementIndexes
            .map((idx) => elements[idx])
            .filter((e): e is (typeof elements)[number] => e != null);
        if (moje.length === 0) throw new AppError("ERR-9018", { vendorId: v.vendorId });

        // Lista pozycji jest budowana OSOBNO dla każdej firmy — dzięki temu
        // jedna może dostać cały pakiet, a inna tylko to, w czym jest dobra,
        // i żadna nie widzi zakresu wysłanego pozostałym.
        const lista = moje
            .map(
                (e, n) =>
                    `${n + 1}. ${e.title}${e.quantity ? ` — ${e.quantity}` : ""}\n   ${e.description}`,
            )
            .join("\n");

        return {
          id: nextCrmId(),
          vendorId: vendor.id,
          vendorName: vendor.name,
          elementIds: moje.map((e) => e.id),
          to: vendor.email,
          subject: input.subject,
          body: input.body.includes("{{elementy}}")
              ? input.body.replace("{{elementy}}", lista)
              : `${input.body}\n\n${lista}`,
          sentAt: teraz,
          replySubject: null,
          replyBody: null,
          status: "sent" as const,
          quoteValue: null,
          quoteAt: null,
          leadTimeDays: null,
          note: null,
          attachments: input.attachments.map((a) => ({
            id: nextCrmId(),
            name: a.name,
            kind: rodzajZalacznika(a.name),
            sizeKb: a.sizeKb,
            source: "own" as const,
            at: teraz,
            fromName: user,
            messageId: null,
            messageSubject: input.subject,
          })),
          respondAfterSec: 20 + i * 15,
        };
      }),
    };

    r.outsourcing.push(item);
    wpis(
        r,
        "message_sent",
        `Zapytanie „${item.title}” (${elements.length} ${
            elements.length === 1 ? "pozycja" : "pozycji"
        }) wysłane do ${item.inquiries.length} firm: ${item.inquiries.map((q) => q.vendorName).join(", ")}.`,
        user,
    );
    return r;
  });

  /** Ręczny wybór kooperanta — decyzja człowieka, nie sama najniższa cena. */
  app.post("/api/crm/requests/:id/outsourcing/:oid/select", async (req) => {
    const { id, oid } = req.params as { id: string; oid: string };
    const r = znajdzZapytanie(id);
    const item = r.outsourcing.find((o) => o.id === oid);
    if (!item) throw new AppError("ERR-9014", { itemId: oid });
    const input = SelectVendorSchema.parse(req.body);
    const user = userFrom(roleFrom(req.headers["x-user-role"]));

    item.selectedVendorId = input.vendorId;
    const nazwa = item.inquiries.find((q) => q.vendorId === input.vendorId)?.vendorName;
    wpis(
        r,
        "data_changed",
        input.vendorId
            ? `Wybrano wykonawcę dla „${item.title}”: ${nazwa ?? input.vendorId}.`
            : `Cofnięto wybór wykonawcy dla „${item.title}”.`,
        user,
    );
    return r;
  });

  /** Ręczne wpisanie wyceny otrzymanej od kooperanta. */
  app.post("/api/crm/requests/:id/outsourcing/:oid/quotes/:iid", async (req) => {
    const { id, oid, iid } = req.params as { id: string; oid: string; iid: string };
    const r = znajdzZapytanie(id);
    const item = r.outsourcing.find((o) => o.id === oid);
    if (!item) throw new AppError("ERR-9014", { itemId: oid });
    const zap = item.inquiries.find((q) => q.id === iid);
    if (!zap) throw new AppError("ERR-9014", { inquiryId: iid });
    const input = RecordQuoteSchema.parse(req.body);
    const user = userFrom(roleFrom(req.headers["x-user-role"]));

    zap.status = input.status;
    zap.quoteValue = input.quoteValue;
    zap.leadTimeDays = input.leadTimeDays;
    zap.note = input.note;
    zap.quoteAt = new Date().toISOString();
    zap.respondAfterSec = null;
    wpis(r, "data_changed", `Wycena od ${zap.vendorName} („${item.title}”) zapisana ręcznie.`, user);
    return r;
  });

  app.delete("/api/crm/requests/:id/outsourcing/:oid", async (req) => {
    const { id, oid } = req.params as { id: string; oid: string };
    const r = znajdzZapytanie(id);
    const item = r.outsourcing.find((o) => o.id === oid);
    if (!item) throw new AppError("ERR-9014", { itemId: oid });
    const user = userFrom(roleFrom(req.headers["x-user-role"]));
    r.outsourcing = r.outsourcing.filter((o) => o.id !== oid);
    wpis(r, "data_changed", `Usunięto element outsourcingu: „${item.title}”.`, user);
    return r;
  });

  // ------------------------- wiadomości i załączniki ------------------------

  /**
   * Szkic wiadomości z szablonu — dla szybkich akcji z kafelka i panelu.
   * Zawsze zwraca SZKIC: wysyłkę zatwierdza człowiek, widząc treść.
   */
  app.post("/api/crm/requests/:id/messages/draft", async (req) => {
    const { id } = req.params as { id: string };
    const r = znajdzZapytanie(id);
    const { key } = z.object({ key: z.enum(TEMPLATE_KEYS) }).parse(req.body);
    const p = crmEmployees.find((e) => e.id === r.assigneeId);
    const msg =
        key === "assignment" && p
            ? generujInformacjeOOpiekunie(r, p)
            : zSzablonu(key, r, {
              kind: key === "followup" ? "followup" : key === "assignment" ? "assignment" : "missing_data",
              ctx: kontekstPracownika(p),
            });
    r.messages.push(msg);
    wpis(r, "message_generated", `Przygotowano wiadomość: ${msg.subject}`, userFrom(roleFrom(req.headers["x-user-role"])));
    return { request: r, messageId: msg.id };
  });

  /** Napisanie i wysłanie wiadomości wprost z zakładki korespondencji. */
  app.post("/api/crm/requests/:id/messages/compose", async (req) => {
    const { id } = req.params as { id: string };
    const r = znajdzZapytanie(id);
    const input = ComposeMessageSchema.parse(req.body);
    const user = userFrom(roleFrom(req.headers["x-user-role"]));
    const pracownik = crmEmployees.find((e) => e.email.startsWith(user.slice(0, 4)));

    const msg: CrmMessage = {
      id: nextCrmId(),
      kind: input.kind,
      direction: "out",
      authorName: pracownik?.name ?? crmSettings.mailbox.displayName,
      contactId: null,
      to: input.to,
      subject: input.subject,
      body: input.body,
      createdAt: new Date().toISOString(),
      sentAt: null,
      sentFrom: null,
      templateKey: input.templateKey,
    };

    if (input.send) {
      const wyslana = await wyslijMock(msg);
      r.messages.push(wyslana);
      r.lastContactAt = wyslana.sentAt;
      wpis(r, "message_sent", `Wysłano wiadomość: ${msg.subject} (konto ${crmSettings.mailbox.account}).`, user);
    } else {
      r.messages.push(msg);
      wpis(r, "message_generated", `Zapisano szkic: ${msg.subject}`, user);
    }
    return r;
  });

  /** Szkic informacji o opiekunie — do zatwierdzenia przez człowieka. */
  app.post("/api/crm/requests/:id/messages/assignment", async (req) => {
    const { id } = req.params as { id: string };
    const r = znajdzZapytanie(id);
    const p = crmEmployees.find((e) => e.id === r.assigneeId);
    if (!p) throw new AppError("ERR-9007", { requestId: id });
    const msg = generujInformacjeOOpiekunie(r, p);
    r.messages.push(msg);
    wpis(r, "message_generated", `Przygotowano wiadomość: ${msg.subject}`, userFrom(roleFrom(req.headers["x-user-role"])));
    return r;
  });

  /** Odrzucenie szkicu — „nie wysyłaj” nie może zostawiać śmieci w wątku. */
  app.delete("/api/crm/requests/:id/messages/:mid", async (req) => {
    const { id, mid } = req.params as { id: string; mid: string };
    const r = znajdzZapytanie(id);
    const msg = r.messages.find((m) => m.id === mid);
    if (!msg) throw new AppError("ERR-9003", { messageId: mid });
    if (msg.sentAt) throw new AppError("ERR-9004", { messageId: mid });
    r.messages = r.messages.filter((m) => m.id !== mid);
    return r;
  });

  /**
   * Pobranie załącznika. W demo nie ma prawdziwych plików, więc zwracamy
   * czytelny opis pozycji — lepiej to niż uszkodzony PDF udający dokument.
   */
  app.get("/api/crm/requests/:id/attachments/:aid", async (req, reply) => {
    const { id, aid } = req.params as { id: string; aid: string };
    const r = znajdzZapytanie(id);
    const zZapytania = r.attachments.find((a) => a.id === aid);
    const zOutsourcingu = r.outsourcing
        .flatMap((o) => o.inquiries.flatMap((q) => q.attachments))
        .find((a) => a.id === aid);
    const a = zZapytania ?? zOutsourcingu;
    if (!a) throw new AppError("ERR-9015", { attachmentId: aid });

    const tresc = [
      "PLIK DEMONSTRACYJNY — moduł CRM demo-erp",
      "",
      `Nazwa pliku:   ${a.name}`,
      `Rodzaj:        ${a.kind}`,
      `Rozmiar (meta): ${a.sizeKb} kB`,
      `Dodano:        ${a.at}`,
      `Od:            ${a.fromName}`,
      `Pochodzenie:   ${a.source === "client" ? "otrzymany od klienta / kooperanta" : "wysłany przez nas"}`,
      a.messageSubject ? `Wiadomość:     ${a.messageSubject}` : null,
      `Zapytanie:     ${r.number} — ${r.projectName}`,
      "",
      "Wersja demonstracyjna przechowuje wyłącznie metadane załączników.",
      "Po podpięciu magazynu plików w tym miejscu pobierze się oryginał.",
    ]
        .filter((l) => l !== null)
        .join("\n");

    return reply
        .header("content-type", "text/plain; charset=utf-8")
        .header("content-disposition", `inline; filename="${a.name}.txt"`)
        .send(tresc);
  });

  /** Oznaczenie karty jako obejrzanej — wygasza pulsowanie „nowego”. */
  app.post("/api/crm/requests/:id/seen", async (req) => {
    const { id } = req.params as { id: string };
    const r = znajdzZapytanie(id);
    r.seenAt ??= new Date().toISOString();
    return r;
  });

  /** Edycja pól sprawy z panelu szczegółów. Dane klienta są tu tylko do odczytu. */
  app.patch("/api/crm/requests/:id", async (req) => {
    const { id } = req.params as { id: string };
    const r = znajdzZapytanie(id);
    const input = PatchRequestSchema.parse(req.body);
    const user = userFrom(roleFrom(req.headers["x-user-role"]));
    const zmiany: string[] = [];

    if (input.projectName !== undefined && input.projectName !== r.projectName) {
      zmiany.push(`nazwa budowy: ${r.projectName} → ${input.projectName}`);
      r.projectName = input.projectName;
    }
    if (input.siteAddress !== undefined && input.siteAddress !== r.siteAddress) {
      zmiany.push(`adres budowy: ${input.siteAddress ?? "usunięty"}`);
      r.siteAddress = input.siteAddress;
    }
    if (input.quoteValue !== undefined && input.quoteValue !== r.quoteValue) {
      zmiany.push(`wartość wyceny: ${r.quoteValue ?? "brak"} → ${input.quoteValue ?? "brak"}`);
      r.quoteValue = input.quoteValue;
    }
    if (input.deadline !== undefined && input.deadline !== r.deadline) {
      zmiany.push(`termin dostawy: ${input.deadline ?? "usunięty"}`);
      r.deadline = input.deadline;
    }
    if (input.projectManagerId !== undefined && input.projectManagerId !== r.projectManagerId) {
      const p = crmEmployees.find((e) => e.id === input.projectManagerId);
      zmiany.push(`project manager: ${p?.name ?? "brak"}`);
      r.projectManagerId = input.projectManagerId;
    }
    if (input.clientId !== undefined && input.clientId !== r.clientId) {
      const k = crmClients.find((c) => c.id === input.clientId);
      if (input.clientId && !k) throw new AppError("ERR-9011", { clientId: input.clientId });
      zmiany.push(`klient: ${k?.name ?? "brak"}`);
      r.clientId = input.clientId;
      if (k) {
        // Nazwa i kontakt na zapytaniu idą za kartoteką — jedno źródło prawdy.
        r.companyName = k.name;
        r.contactName = k.contactName;
        r.email = k.email;
        r.phone = k.phone;
      }
    }
    if (input.notes !== undefined && input.notes !== r.notes) {
      zmiany.push("notatki ogólne");
      r.notes = input.notes;
    }
    if (input.score !== undefined && input.score !== r.score) {
      wpis(r, "score_changed", `Scoring zmieniony: ${r.score}% → ${input.score}%.`, user);
      r.score = input.score;
    }
    if (input.assigneeId !== undefined && input.assigneeId !== r.assigneeId) {
      const p = crmEmployees.find((e) => e.id === input.assigneeId);
      r.assigneeId = input.assigneeId;
      if (input.assigneeId && !r.assigneeIds.includes(input.assigneeId)) {
        r.assigneeIds.push(input.assigneeId);
      }
      // Kolumna idzie za przypisaniem, żeby tablica nie kłamała.
      r.columnId = input.assigneeId
          ? (crmColumns.find((c) => c.employeeId === input.assigneeId)?.id ?? r.columnId)
          : "col-new";
      wpis(r, "assignee_changed", p ? `Przypisano do: ${p.name}.` : "Zdjęto przypisanie.", user);
    }

    if (zmiany.length > 0) wpis(r, "data_changed", `Zmieniono: ${zmiany.join(", ")}.`, user);
    return r;
  });

  /** Notatka przy etapie — jedna na etap, nadpisywana. */
  app.post("/api/crm/requests/:id/stage-note", async (req) => {
    const { id } = req.params as { id: string };
    const r = znajdzZapytanie(id);
    const input = StageNoteInputSchema.parse(req.body);
    const user = userFrom(roleFrom(req.headers["x-user-role"]));

    const istniejaca = r.stageNotes.find((n) => n.stage === input.stage);
    if (input.text.trim() === "") {
      if (istniejaca) r.stageNotes.splice(r.stageNotes.indexOf(istniejaca), 1);
    } else if (istniejaca) {
      istniejaca.text = input.text;
      istniejaca.at = new Date().toISOString();
      istniejaca.user = user;
    } else {
      r.stageNotes.push({ stage: input.stage, text: input.text, at: new Date().toISOString(), user });
    }
    wpis(r, "note_added", `Notatka do etapu „${CRM_STAGE_SHORT[input.stage]}”.`, user);
    return r;
  });

  /** Przydzielenie opiekuna. Zastrzeżone dla kierownika — jak zatwierdzanie MM. */
  app.post("/api/crm/requests/:id/assign", async (req) => {
    const { id } = req.params as { id: string };
    const role = roleFrom(req.headers["x-user-role"]);
    if (role !== "kierownik") throw new AppError("ERR-9006", { crmRequestId: id, role });

    const r = znajdzZapytanie(id);
    const { employeeId } = z
        .object({ employeeId: z.string().min(1, "Wybierz pracownika") })
        .parse(req.body);
    const p = crmEmployees.find((e) => e.id === employeeId);
    if (!p) throw new AppError("ERR-9001", { employeeId });

    r.assigneeId = p.id;
    wpis(r, "assignee_changed", `Przypisano do: ${p.name}.`, userFrom(role));

    // Wiadomość do klienta powstaje od razu, ale zostaje w stanie „do wysłania”
    // — decyzję o wysyłce podejmuje człowiek.
    const msg = generujInformacjeOOpiekunie(r, p);
    r.messages.push(msg);
    wpis(r, "message_generated", `Wygenerowano wiadomość: ${CRM_MESSAGE_KIND_LABELS.assignment}.`, userFrom(role));
    return r;
  });

  app.post("/api/crm/requests/:id/score", async (req) => {
    const { id } = req.params as { id: string };
    const r = znajdzZapytanie(id);
    const { score } = z
        .object({
          score: z
              .number({ invalid_type_error: "Scoring musi być liczbą" })
              .min(0, "Scoring nie może być ujemny")
              .max(100, "Scoring nie może przekraczać 100%"),
        })
        .parse(req.body);
    const user = userFrom(roleFrom(req.headers["x-user-role"]));
    if (r.score !== score) {
      wpis(r, "score_changed", `Scoring zmieniony: ${r.score}% → ${score}%.`, user);
      r.score = score;
    }
    return r;
  });

  // ------------------------------ follow-upy ------------------------------

  app.post("/api/crm/requests/:id/followups", async (req) => {
    const { id } = req.params as { id: string };
    const r = znajdzZapytanie(id);
    const input = CreateFollowUpSchema.parse(req.body);
    const user = userFrom(roleFrom(req.headers["x-user-role"]));

    r.followUps.push({
      id: nextCrmId(),
      date: input.date,
      time: input.time,
      type: input.type,
      note: input.note,
      status: input.date < dzisiajISO() ? "overdue" : "planned",
      doneAt: null,
    });
    wpis(r, "followup_created", `Zaplanowano kontakt na ${input.date} ${input.time}.`, user);
    return r;
  });

  app.post("/api/crm/requests/:id/followups/:fid/done", async (req) => {
    const { id, fid } = req.params as { id: string; fid: string };
    const r = znajdzZapytanie(id);
    const f = r.followUps.find((x) => x.id === fid);
    if (!f) throw new AppError("ERR-9001", { followUpId: fid });
    const user = userFrom(roleFrom(req.headers["x-user-role"]));

    f.status = "done";
    f.doneAt = new Date().toISOString();
    r.lastContactAt = f.doneAt;
    wpis(r, "followup_done", `Wykonano kontakt: ${etykietaTypuKontaktu(f.type)} — ${f.note}`, user);
    return r;
  });

  app.post("/api/crm/requests/:id/followups/:fid/skip", async (req) => {
    const { id, fid } = req.params as { id: string; fid: string };
    const r = znajdzZapytanie(id);
    const f = r.followUps.find((x) => x.id === fid);
    if (!f) throw new AppError("ERR-9001", { followUpId: fid });
    f.status = "skipped";
    wpis(r, "followup_done", `Pominięto zaplanowany kontakt z ${f.date}.`, userFrom(roleFrom(req.headers["x-user-role"])));
    return r;
  });

  // ------------------------------ wiadomości ------------------------------

  app.post("/api/crm/requests/:id/messages/missing-data", async (req) => {
    const { id } = req.params as { id: string };
    const r = znajdzZapytanie(id);
    const user = userFrom(roleFrom(req.headers["x-user-role"]));
    const msg = generujProsbeOUzupelnienie(r);
    r.messages.push(msg);
    wpis(r, "message_generated", `Wygenerowano wiadomość: ${CRM_MESSAGE_KIND_LABELS.missing_data}.`, user);
    return r;
  });

  app.post("/api/crm/requests/:id/messages/:mid/send", async (req) => {
    const { id, mid } = req.params as { id: string; mid: string };
    const r = znajdzZapytanie(id);
    const idx = r.messages.findIndex((m) => m.id === mid);
    const msg = r.messages[idx];
    if (idx < 0 || !msg) throw new AppError("ERR-9001", { messageId: mid });
    const user = userFrom(roleFrom(req.headers["x-user-role"]));

    // Treść mogła zostać zmieniona w podglądzie przed wysłaniem.
    const patch = z
        .object({ subject: z.string().optional(), body: z.string().optional() })
        .parse(req.body ?? {});
    if (patch.subject) msg.subject = patch.subject;
    if (patch.body) msg.body = patch.body;

    const wyslany = await wyslijMock(msg);
    r.messages[idx] = wyslany;
    r.lastContactAt = wyslany.sentAt;
    wpis(r, "message_sent", `Wysłano wiadomość „${wyslany.subject}” na adres ${wyslany.to}.`, user);
    return r;
  });

  // ------------------------------- skrzynka -------------------------------

  app.get("/api/crm/mailbox", async () => ({
    state: mailboxState,
    adapter: mailboxAdapter.name,
    messages: [...inboxMessages].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)),
  }));

  app.post("/api/crm/mailbox/poll", async () => {
    try {
      const wynik = await pobierzIPrzetworz();
      return {
        state: mailboxState,
        adapter: mailboxAdapter.name,
        result: wynik,
        messages: [...inboxMessages].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)),
      };
    } catch {
      throw new AppError("ERR-9005", { adapter: mailboxAdapter.name });
    }
  });

  app.post("/api/crm/mailbox/messages/:id/category", async (req) => {
    const { id } = req.params as { id: string };
    const msg = inboxMessages.find((m) => m.id === id);
    if (!msg) throw new AppError("ERR-9003", { messageId: id });
    const { category } = z
        .object({ category: z.enum(MAIL_CATEGORIES) })
        .parse(req.body) as { category: MailCategory };

    msg.category = category;
    msg.categoryManual = true;
    // Zmiana kategorii to nowa przesłanka — przetwarzamy wiadomość od nowa.
    if (msg.crmRequestId == null) przetworzPonownie(msg);
    return msg;
  });

  /** Ręczna akceptacja: tworzy zapytanie mimo ostrzeżenia o duplikacie. */
  app.post("/api/crm/mailbox/messages/:id/accept", async (req) => {
    const { id } = req.params as { id: string };
    const msg = inboxMessages.find((m) => m.id === id);
    if (!msg) throw new AppError("ERR-9003", { messageId: id });
    if (msg.crmRequestId) throw new AppError("ERR-9004", { messageId: id });

    const nowe = utworzZapytanieZWiadomosci(msg);
    if (msg.duplicateOfId) {
      const powiazane = crmRequests.find((r) => r.id === msg.duplicateOfId);
      wpis(
          nowe,
          "created",
          `Utworzono mimo ostrzeżenia o możliwym duplikacie${powiazane ? ` zapytania ${powiazane.number}` : ""}.`,
          userFrom(roleFrom(req.headers["x-user-role"])),
      );
    }
    crmRequests.unshift(nowe);
    msg.crmRequestId = nowe.id;
    msg.status = "processed";
    msg.note = null;
    return { message: msg, request: nowe };
  });

  app.post("/api/crm/mailbox/messages/:id/reject", async (req) => {
    const { id } = req.params as { id: string };
    const msg = inboxMessages.find((m) => m.id === id);
    if (!msg) throw new AppError("ERR-9003", { messageId: id });
    msg.status = "skipped";
    msg.note = "Wiadomość odrzucona przez operatora.";
    return msg;
  });

  app.post("/api/crm/mailbox/messages/:id/review", async (req) => {
    const { id } = req.params as { id: string };
    const msg = inboxMessages.find((m) => m.id === id);
    if (!msg) throw new AppError("ERR-9003", { messageId: id });
    msg.status = "needs_review";
    msg.note = "Oznaczone do weryfikacji przez operatora.";
    return msg;
  });
}

/** Etykieta typu kontaktu w treści wpisu historii. */
function etykietaTypuKontaktu(t: string): string {
  const mapa: Record<string, string> = {
    email: "e-mail",
    phone: "telefon",
    meeting: "spotkanie",
    reoffer: "ponowna oferta",
    other: "inne",
  };
  return mapa[t] ?? t;
}