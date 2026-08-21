/**
 * crm.ts — model domenowy modułu CRM (obsługa zapytań ofertowych).
 *
 * Konwencja jak w domain.ts: słowniki jako `as const` + mapa etykiet,
 * schematy Zod jako jedno źródło prawdy dla walidacji po obu stronach,
 * komunikaty po polsku pisane raz, tutaj.
 *
 * Świadoma decyzja: status kompletności i sugerowany scoring NIE są polami
 * przechowywanymi w bazie, tylko funkcjami czystymi liczonymi z danych
 * zapytania (ocenKompletnosc / sugerowanyScoring). Dzięki temu wartość
 * pokazana na liście, w kanbanie i w szczegółach nigdy się nie rozjedzie,
 * a zmiana reguły nie wymaga migracji danych. Scoring RĘCZNY jest natomiast
 * polem — użytkownik może nadpisać podpowiedź systemu.
 */

import { z } from "zod";

// ------------------------------- słowniki --------------------------------

/** Etapy lejka sprzedażowego. Kolejność tablicy = kolejność kolumn kanbana. */
export const CRM_STAGES = [
  "new",
  "contact",
  "offer_prep",
  "offer_sent",
  "negotiation",
  "won",
  "lost",
] as const;
export type CrmStage = (typeof CRM_STAGES)[number];

export const CRM_STAGE_LABELS: Record<CrmStage, string> = {
  new: "Nowe",
  contact: "Kontakt",
  offer_prep: "Przygotowanie oferty",
  offer_sent: "Oferta wysłana",
  negotiation: "Negocjacje",
  won: "Wygrane",
  lost: "Przegrane",
};

/** Skrót na karty kanbana i wąskie kolumny tabeli. */
export const CRM_STAGE_SHORT: Record<CrmStage, string> = {
  new: "Nowe",
  contact: "Kontakt",
  offer_prep: "Oferta w przyg.",
  offer_sent: "Oferta wysłana",
  negotiation: "Negocjacje",
  won: "Wygrane",
  lost: "Przegrane",
};

/**
 * Etykiety jednowyrazowe — na szynę kafelka i na strzałki etapów w panelu,
 * gdzie „Przygotowanie oferty” nie ma prawa się zmieścić.
 */
export const CRM_STAGE_MICRO: Record<CrmStage, string> = {
  new: "Nowe",
  contact: "Kontakt",
  offer_prep: "Wycena",
  offer_sent: "Oferta",
  negotiation: "Negocjacje",
  won: "Wygrane",
  lost: "Przegrane",
};

export const CRM_SOURCES = ["manual", "email"] as const;
export type CrmSource = (typeof CRM_SOURCES)[number];

export const CRM_SOURCE_LABELS: Record<CrmSource, string> = {
  manual: "Ręczne",
  email: "E-mail",
};

/** Role pracowników w module CRM — niezależne od ról ERP (magazynier/kierownik). */
export const CRM_EMPLOYEE_ROLES = ["kierownik", "handlowiec", "ofertowanie", "administrator"] as const;
export type CrmEmployeeRole = (typeof CRM_EMPLOYEE_ROLES)[number];

export const CRM_EMPLOYEE_ROLE_LABELS: Record<CrmEmployeeRole, string> = {
  kierownik: "Kierownik sprzedaży",
  handlowiec: "Handlowiec",
  ofertowanie: "Przygotowanie oferty",
  administrator: "Administrator",
};

/** Rodzaje załączników wymaganych przy wycenie. */
export const ATTACHMENT_KINDS = ["specification", "drawing", "photos", "pdf", "form", "other"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const ATTACHMENT_KIND_LABELS: Record<AttachmentKind, string> = {
  specification: "Specyfikacja",
  drawing: "Rysunek techniczny",
  photos: "Zdjęcia",
  pdf: "Dokument PDF",
  form: "Formularz zapytania",
  other: "Inne",
};

/** Dane, których brak blokuje lub utrudnia wycenę. */
export const CRM_DATA_FIELDS = [
  "phone",
  "address",
  "description",
  "products",
  "quantity",
  "deadline",
] as const;
export type CrmDataField = (typeof CRM_DATA_FIELDS)[number];

export const CRM_DATA_FIELD_LABELS: Record<CrmDataField, string> = {
  phone: "Numer telefonu",
  address: "Adres",
  description: "Opis zapytania",
  products: "Specyfikacja produktu lub usługi",
  quantity: "Informacja o ilości",
  deadline: "Termin realizacji",
};

export const COMPLETENESS_STATUSES = [
  "complete",
  "partial",
  "missing_data",
  "missing_attachments",
] as const;
export type CompletenessStatus = (typeof COMPLETENESS_STATUSES)[number];

export const COMPLETENESS_LABELS: Record<CompletenessStatus, string> = {
  complete: "Kompletne",
  partial: "Częściowo kompletne",
  missing_data: "Brakuje danych",
  missing_attachments: "Brakuje załączników",
};

export const LOST_REASONS = [
  "price",
  "quality",
  "lead_time",
  "competitor",
  "no_response",
  "no_capacity",
  "incomplete_data",
  "other",
] as const;
export type LostReason = (typeof LOST_REASONS)[number];

export const LOST_REASON_LABELS: Record<LostReason, string> = {
  price: "Za wysoka cena",
  quality: "Jakość",
  lead_time: "Termin realizacji",
  competitor: "Wybrano konkurencję",
  no_response: "Brak odpowiedzi klienta",
  no_capacity: "Brak możliwości realizacji",
  incomplete_data: "Niekompletne dane",
  other: "Inna przyczyna",
};

export const FOLLOWUP_TYPES = ["email", "phone", "meeting", "reoffer", "other"] as const;
export type FollowUpType = (typeof FOLLOWUP_TYPES)[number];

export const FOLLOWUP_TYPE_LABELS: Record<FollowUpType, string> = {
  email: "E-mail",
  phone: "Telefon",
  meeting: "Spotkanie",
  reoffer: "Ponowna oferta",
  other: "Inne",
};

export const FOLLOWUP_STATUSES = ["planned", "done", "skipped", "overdue"] as const;
export type FollowUpStatus = (typeof FOLLOWUP_STATUSES)[number];

export const FOLLOWUP_STATUS_LABELS: Record<FollowUpStatus, string> = {
  planned: "Zaplanowany",
  done: "Wykonany",
  skipped: "Pominięty",
  overdue: "Przeterminowany",
};

/** Kategorie nadawane pobranym wiadomościom przez klasyfikator. */
export const MAIL_CATEGORIES = ["inquiry", "other"] as const;
export type MailCategory = (typeof MAIL_CATEGORIES)[number];

export const MAIL_CATEGORY_LABELS: Record<MailCategory, string> = {
  inquiry: "Zapytanie ofertowe",
  other: "Pozostała wiadomość",
};

export const MAIL_CLASSIFICATION_SOURCES = ["dgx", "heuristic"] as const;
export type MailClassificationSource = (typeof MAIL_CLASSIFICATION_SOURCES)[number];

/** Metadane decyzji klasyfikatora, bez treści wiadomości i danych osobowych. */
export const MailClassificationSchema = z.object({
  source: z.enum(MAIL_CLASSIFICATION_SOURCES),
  confidence: z.number().min(0).max(1),
  threshold: z.number().min(0).max(1).nullable(),
  /** Nazwa klasyfikatora zapisana razem z wynikiem. */
  modelName: z.string().nullable().optional(),
  modelVersion: z.string().nullable(),
  latencyMs: z.number().nonnegative(),
  usedFallback: z.boolean(),
  /** Powód przejścia do bezpiecznej, ręcznej weryfikacji. */
  fallbackReason: z.string().nullable().optional(),
});
export type MailClassification = z.infer<typeof MailClassificationSchema>;

export type DgxConnectionState = "connected" | "degraded" | "incompatible" | "offline" | "not_configured";
export type DgxServiceState = "online" | "incompatible" | "offline" | "not_configured";

export interface DgxServiceStatus {
  state: DgxServiceState;
  label: string;
  modelName: string | null;
  modelVersion: string | null;
  embeddingDimension: number | null;
  normalizeEmbeddings: boolean | null;
  preprocessingVersion: number | null;
  latencyMs: number | null;
  lastError: string | null;
}

/** Stan usług AI na DGX Spark, pokazywany stale w skrzynce CRM. */
export interface DgxStatus {
  state: DgxConnectionState;
  checkedAt: string;
  classifier: DgxServiceStatus;
  extractor: DgxServiceStatus;
}

export const MAIL_STATUSES = [
  "new",
  "processing",
  "processed",
  "needs_review",
  "skipped",
  "error",
] as const;
export type MailStatus = (typeof MAIL_STATUSES)[number];

export const MAIL_STATUS_LABELS: Record<MailStatus, string> = {
  new: "Nowa",
  processing: "Przetwarzanie",
  processed: "Przetworzona",
  needs_review: "Wymaga weryfikacji",
  skipped: "Pominięta",
  error: "Błąd przetwarzania",
};

/** Rodzaje wpisów w historii aktywności zapytania. */
export const ACTIVITY_KINDS = [
  "created",
  "stage_changed",
  "assignee_changed",
  "score_changed",
  "data_changed",
  "mail_fetched",
  "message_generated",
  "message_sent",
  "followup_created",
  "followup_done",
  "lost_reason_changed",
  "note_added",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  created: "Utworzenie zapytania",
  stage_changed: "Zmiana etapu",
  assignee_changed: "Zmiana pracownika",
  score_changed: "Zmiana scoringu",
  data_changed: "Zmiana danych klienta",
  mail_fetched: "Pobranie wiadomości",
  message_generated: "Wygenerowanie wiadomości",
  message_sent: "Wysłanie wiadomości",
  followup_created: "Utworzenie follow-upu",
  followup_done: "Wykonanie follow-upu",
  lost_reason_changed: "Zmiana przyczyny przegranej",
  note_added: "Notatka",
};

/** Rodzaje wiadomości generowanych przez system (mock wysyłki). */
/** Szablony wiadomości — klucz odpowiada sytuacji, w której wychodzą. */
export const TEMPLATE_KEYS = [
  "acknowledgement",
  "assignment",
  "missing_data",
  "address",
  "attachments",
  "phone",
  "followup",
  "outsourcing",
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const TEMPLATE_LABELS: Record<TemplateKey, string> = {
  acknowledgement: "Potwierdzenie przyjęcia zapytania",
  assignment: "Informacja o opiekunie sprawy",
  missing_data: "Prośba o uzupełnienie danych",
  address: "Prośba o adres budowy",
  attachments: "Prośba o pliki i rysunki",
  phone: "Prośba o kontakt telefoniczny",
  followup: "Follow-up do wysłanej oferty",
  outsourcing: "Zapytanie do firmy zewnętrznej",
};


export const CRM_MESSAGE_KINDS = ["missing_data", "assignment", "followup", "incoming", "custom"] as const;
export type CrmMessageKind = (typeof CRM_MESSAGE_KINDS)[number];

export const CRM_MESSAGE_KIND_LABELS: Record<CrmMessageKind, string> = {
  missing_data: "Prośba o uzupełnienie danych",
  assignment: "Informacja o opiekunie zapytania",
  followup: "Follow-up do wysłanej oferty",
  incoming: "Wiadomość od klienta",
  custom: "Wiadomość własna",
};

// --------------------------------- encje ---------------------------------

export const CrmEmployeeSchema = z.object({
  id: z.string(),
  /** Telefon bezpośredni — trafia do wiadomości „kto prowadzi sprawę”. */
  phone: z.string().nullable().default(null),
  name: z.string(),
  initials: z.string(),
  email: z.string(),
  role: z.enum(CRM_EMPLOYEE_ROLES),
  active: z.boolean(),
});
export type CrmEmployee = z.infer<typeof CrmEmployeeSchema>;

export const CrmAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(ATTACHMENT_KINDS),
  sizeKb: z.number().nonnegative(),
  /** „client” — plik od klienta, „own” — nasz, wysłany do klienta. */
  source: z.enum(["client", "own"]),
  at: z.string(),
  /** Kto przysłał albo kto załączył — imię i nazwisko, nie identyfikator. */
  fromName: z.string(),
  /**
   * Wiadomość, przy której plik wisi — dla plików od klienta i dla naszych.
   * Dzięki temu wątek w zakładce „Wiadomości” pokazuje załączniki pod
   * właściwym wpisem, a nie w oderwanej liście.
   */
  messageId: z.string().nullable(),
  messageSubject: z.string().nullable(),
});
export type CrmAttachment = z.infer<typeof CrmAttachmentSchema>;

export const CrmActivitySchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.enum(ACTIVITY_KINDS),
  /** Zdanie gotowe do wyświetlenia — historia ma się czytać, nie dekodować. */
  text: z.string(),
  user: z.string(),
});
export type CrmActivity = z.infer<typeof CrmActivitySchema>;

export const CrmFollowUpSchema = z.object({
  id: z.string(),
  date: z.string(),
  time: z.string(),
  type: z.enum(FOLLOWUP_TYPES),
  note: z.string(),
  status: z.enum(FOLLOWUP_STATUSES),
  doneAt: z.string().nullable(),
});
export type CrmFollowUp = z.infer<typeof CrmFollowUpSchema>;

export const CrmMessageSchema = z.object({
  id: z.string(),
  kind: z.enum(CRM_MESSAGE_KINDS),
  /** „out” — my do klienta, „in” — klient do nas. */
  direction: z.enum(["out", "in"]).default("out"),
  /** Kto napisał — po obu stronach bywa kilka osób naraz. */
  authorName: z.string().default("Dział Handlowy"),
  /** Osoba kontaktowa klienta, jeśli wiadomość da się z nią powiązać. */
  contactId: z.string().nullable().default(null),
  /** Pracownik, który napisał — decyduje o kolorze wpisu i widoczności szkicu. */
  authorId: z.string().nullable().default(null),
  /** Dodatkowi adresaci (DW) — np. przedstawiciel klienta na budowie. */
  cc: z.array(z.string()).default([]),
  /** Kto już przeczytał — wiadomość „nowa” to taka, której nie ma tu mojego id. */
  readBy: z.array(z.string()).default([]),
  to: z.string(),
  subject: z.string(),
  body: z.string(),
  createdAt: z.string(),
  /** null = wygenerowana, ale jeszcze nie „wysłana”. */
  sentAt: z.string().nullable(),
  /** Konto, z którego wiadomość wyszła — w demo skrzynka działu w Outlooku. */
  sentFrom: z.string().nullable().default(null),
  /** Szablon, z którego powstała — pozwala poznać „czy już o to prosiliśmy”. */
  templateKey: z.enum(TEMPLATE_KEYS).nullable().default(null),
});
export type CrmMessage = z.infer<typeof CrmMessageSchema>;

/**
 * Szyna etapów na kafelku — sześć segmentów. „Przegrane” celowo tu nie ma:
 * to nie jest kolejny krok procesu, tylko jego zakończenie, a szyna ma
 * pokazywać postęp, nie wynik.
 */
export const CRM_PIPELINE = [
  "new",
  "contact",
  "offer_prep",
  "offer_sent",
  "negotiation",
  "won",
] as const;
export type CrmPipelineStage = (typeof CRM_PIPELINE)[number];

/** Rodzaje kolumn tablicy. Kolumny kosztorysantów wiążą się z pracownikiem. */
export const CRM_COLUMN_KINDS = [
  "new",
  "estimator",
  "custom",
  "sent",
  "followup",
  "won",
  "lost",
] as const;
export type CrmColumnKind = (typeof CRM_COLUMN_KINDS)[number];

/** Barwy kolumn — nazwy, nie kody, żeby motyw dało się zmienić w jednym miejscu. */
export const COLUMN_COLORS = ["default", "blue", "orange", "gold", "purple", "green", "red"] as const;
export type ColumnColor = (typeof COLUMN_COLORS)[number];

export const CrmColumnSchema = z.object({
  id: z.string(),
  title: z.string(),
  color: z.enum(COLUMN_COLORS).default("default"),
  kind: z.enum(CRM_COLUMN_KINDS),
  /** Ustawione dla kolumn kosztorysantów — upuszczenie karty przypisuje sprawę. */
  employeeId: z.string().nullable(),
  order: z.number(),
  /** Kolumn systemowych („Nowe”, „Przegrane”) nie da się usunąć. */
  removable: z.boolean(),
});
export type CrmColumn = z.infer<typeof CrmColumnSchema>;

/**
 * Kartoteka klientów. Dane klienta są wspólne dla wszystkich jego zapytań,
 * więc z poziomu zapytania są tylko do odczytu — inaczej poprawka literówki
 * w jednym zapytaniu po cichu zmieniałaby dane w pozostałych.
 */
/**
 * Osoba kontaktowa. Po stronie klienta rzadko rozmawia się z jedną osobą —
 * zakupy przysyłają zapytanie, technolog dosyła rysunki, a o cenę pyta ktoś
 * trzeci. Bez listy kontaktów historia korespondencji zlewa się w jedno.
 */
export const CrmContactSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  role: z.string().nullable(),
});
export type CrmContact = z.infer<typeof CrmContactSchema>;

export const CrmClientSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Kontakt główny — pierwszy z listy; pola zostawione dla zgodności widoków. */
  contactName: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  nip: z.string().nullable(),
  contacts: z.array(CrmContactSchema).default([]),
});

export type CrmClient = z.infer<typeof CrmClientSchema>;

/** Notatka przypisana do etapu — jedna na etap, nadpisywana. */
export const StageNoteSchema = z.object({
  stage: z.enum(CRM_STAGES),
  text: z.string(),
  at: z.string(),
  user: z.string(),
});
export type StageNote = z.infer<typeof StageNoteSchema>;

export const STICKY_NOTE_COLORS = [
  "yellow",
  "pink",
  "blue",
  "green",
  "purple",
  "orange",
  "mint",
  "cyan",
  "coral",
] as const;
export const StickyNoteSchema = z.object({
  id: z.string(),
  text: z.string(),
  authorId: z.string().nullable(),
  authorName: z.string(),
  createdAt: z.string(),
  color: z.enum(STICKY_NOTE_COLORS),
});
export type StickyNote = z.infer<typeof StickyNoteSchema>;

// ------------------------------ outsourcing -------------------------------

/** Firma zewnętrzna, do której wysyłamy zapytania o wycenę elementów. */
export const CrmVendorSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  /** Czym się zajmuje — po to, żeby nie wysyłać zapytania o gięcie do lakierni. */
  specialties: z.array(z.string()),
  phone: z.string().nullable(),
});
export type CrmVendor = z.infer<typeof CrmVendorSchema>;

export const VENDOR_INQUIRY_STATUSES = ["sent", "quoted", "declined", "no_reply"] as const;
export type VendorInquiryStatus = (typeof VENDOR_INQUIRY_STATUSES)[number];

export const VENDOR_STATUS_LABELS: Record<VendorInquiryStatus, string> = {
  sent: "Wysłane, czeka na wycenę",
  quoted: "Wycena otrzymana",
  declined: "Odmowa",
  no_reply: "Brak odpowiedzi",
};

/**
 * Zapytanie do jednej firmy. KAŻDA firma dostaje własną wiadomość, z własnym
 * adresem w polu „do” — nigdy kopię zbiorczą. Informacja o tym, że pytamy
 * kilka firm naraz, jest naszą wiedzą negocjacyjną, nie ich.
 */
export const VendorInquirySchema = z.object({
  id: z.string(),
  vendorId: z.string(),
  vendorName: z.string(),
  /** Elementy, o które pytamy TĘ firmę — nie każda dostaje cały pakiet. */
  elementIds: z.array(z.string()),
  to: z.string(),
  subject: z.string(),
  body: z.string(),
  sentAt: z.string(),
  /** Pełna treść odpowiedzi kooperanta — do rozwinięcia w panelu. */
  replySubject: z.string().nullable(),
  replyBody: z.string().nullable(),
  status: z.enum(VENDOR_INQUIRY_STATUSES),
  quoteValue: z.number().nullable(),
  quoteAt: z.string().nullable(),
  leadTimeDays: z.number().nullable(),
  note: z.string().nullable(),
  attachments: z.array(CrmAttachmentSchema),
  /** Tylko demo: po ilu sekundach atrapa udzieli odpowiedzi. */
  respondAfterSec: z.number().nullable(),
});
export type VendorInquiry = z.infer<typeof VendorInquirySchema>;

/** Pojedyncza pozycja do wyceny wewnątrz zapytania. */
export const OutsourcingElementSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  quantity: z.string().nullable(),
});
export type OutsourcingElement = z.infer<typeof OutsourcingElementSchema>;

/**
 * Zapytanie outsourcingowe: jeden pakiet elementów wysłany do kilku firm.
 * Zakres bywa różny dla różnych firm — jedna wycenia całość, inna tylko to,
 * w czym jest dobra — dlatego wybór elementów siedzi przy zapytaniu do firmy,
 * a nie przy pakiecie.
 */
export const OutsourcingItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  deadline: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string(),
  elements: z.array(OutsourcingElementSchema),
  inquiries: z.array(VendorInquirySchema),
  /** Ręcznie wskazany zwycięzca — decyzja człowieka, nie sama najniższa cena. */
  selectedVendorId: z.string().nullable().default(null),
});
export type OutsourcingItem = z.infer<typeof OutsourcingItemSchema>;

/** Elementy, o które pytano daną firmę. */
export function elementyZapytania(item: OutsourcingItem, zap: VendorInquiry): OutsourcingElement[] {
  return item.elements.filter((e) => zap.elementIds.includes(e.id));
}

/** Najtańsza wycena w pakiecie — null, gdy nikt jeszcze nie odpowiedział. */
export function najlepszaWycena(item: OutsourcingItem): VendorInquiry | null {
  const wyceny = item.inquiries.filter((i) => i.status === "quoted" && i.quoteValue != null);
  if (wyceny.length === 0) return null;
  return [...wyceny].sort((a, b) => (a.quoteValue ?? 0) - (b.quoteValue ?? 0))[0]!;
}

export const CrmRequestSchema = z.object({
  id: z.string(),
  number: z.string(),
  /** Nazwa budowy — główny identyfikator sprawy na kafelku. */
  projectName: z.string(),
  /** Klient z kartoteki; null dla zapytań, których nie udało się dopasować. */
  clientId: z.string().nullable(),
  /** Adres dostawy/budowy — należy do zapytania, nie do klienta, więc edytowalny. */
  siteAddress: z.string().nullable(),
  /** Wartość wyceny w PLN. */
  quoteValue: z.number().nullable(),
  projectManagerId: z.string().nullable(),
  /** Kolumna tablicy. Kolumna kosztorysanta = zapytanie przypisane do niego. */
  columnId: z.string(),
  /** Kiedy karta weszła do bieżącej kolumny — potrzebne automatom i licznikowi „+N”. */
  columnEnteredAt: z.string(),
  /** Kiedy ktoś pierwszy raz otworzył zapytanie — do wygaszania pulsowania. */
  seenAt: z.string().nullable(),
  stageNotes: z.array(StageNoteSchema),
  stickyNotes: z.array(StickyNoteSchema).default([]),
  outsourcing: z.array(OutsourcingItemSchema).default([]),
  notes: z.string(),
  companyName: z.string(),
  contactName: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  description: z.string(),
  /** Wymagane produkty lub usługi — wolny tekst, w demo bez kartoteki. */
  products: z.string().nullable(),
  quantity: z.string().nullable(),
  /** Oczekiwany termin odpowiedzi / realizacji (YYYY-MM-DD). */
  deadline: z.string().nullable(),
  source: z.enum(CRM_SOURCES),
  createdAt: z.string(),
  /**
   * Kosztorysanci, którzy mieli styczność ze sprawą, w kolejności wejścia.
   * Źródłem prawdy jest ta lista; `assigneeId` to jej ostatni element,
   * trzymany osobno, żeby widoki filtrujące „po opiekunie” działały bez zmian.
   */
  assigneeIds: z.array(z.string()).default([]),
  assigneeId: z.string().nullable(),
  stage: z.enum(CRM_STAGES),
  /** 0–100. Wartość ręczna; podpowiedź liczy sugerowanyScoring(). */
  score: z.number().min(0).max(100),
  requiredAttachments: z.array(z.enum(ATTACHMENT_KINDS)),
  attachments: z.array(CrmAttachmentSchema),
  lastContactAt: z.string().nullable(),
  lostReason: z.enum(LOST_REASONS).nullable(),
  lostReasonNote: z.string().nullable(),
  /** Id wiadomości źródłowej, gdy zapytanie powstało z poczty. */
  sourceMessageId: z.string().nullable(),
  followUps: z.array(CrmFollowUpSchema),
  messages: z.array(CrmMessageSchema),
  activity: z.array(CrmActivitySchema),
});
export type CrmRequest = z.infer<typeof CrmRequestSchema>;

/** Dane wyciągnięte z treści wiadomości przez ekstraktor. */
export const ExtractedDataSchema = z.object({
  companyName: z.string().nullable(),
  contactName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  description: z.string().nullable(),
  products: z.string().nullable(),
  quantity: z.string().nullable(),
  deadline: z.string().nullable(),
  attachments: z.array(z.string()),
});
export type ExtractedData = z.infer<typeof ExtractedDataSchema>;

export const InboxMessageSchema = z.object({
  id: z.string(),
  /** Identyfikator ze skrzynki (Message-ID) — klucz deduplikacji pobierania. */
  externalId: z.string(),
  from: z.string(),
  fromEmail: z.string(),
  subject: z.string(),
  receivedAt: z.string(),
  body: z.string(),
  attachments: z.array(CrmAttachmentSchema),
  status: z.enum(MAIL_STATUSES),
  category: z.enum(MAIL_CATEGORIES),
  /** Wynik pierwszego etapu AI; brak dla starszych danych demonstracyjnych. */
  classification: MailClassificationSchema.nullable().optional(),
  /** true, gdy kategorię nadpisał człowiek — klasyfikator już jej nie zmienia. */
  categoryManual: z.boolean(),
  extracted: ExtractedDataSchema.nullable(),
  crmRequestId: z.string().nullable(),
  /** Zapytanie, z którym wiadomość może być duplikatem. */
  duplicateOfId: z.string().nullable(),
  /** Powód wymagania weryfikacji lub błędu — pokazywany w skrzynce. */
  note: z.string().nullable(),
  fetchedAt: z.string(),
});
export type InboxMessage = z.infer<typeof InboxMessageSchema>;

/** Stan mechanizmu pobierania poczty — pokazywany w nagłówku skrzynki. */
export interface MailboxState {
  lastCheckedAt: string | null;
  lastResult: "ok" | "error" | null;
  lastError: string | null;
  newCount: number;
  totalFetched: number;
  /** Częstotliwość automatycznego odpytywania (sekundy) — dla podpisu w UI. */
  pollIntervalSec: number;
}

// ------------------------- schematy formularzy ---------------------------

const pusteNaNull = (v: unknown): unknown =>
    typeof v === "string" && v.trim() === "" ? null : v;

export const CreateCrmRequestSchema = z.object({
  projectName: z.string().min(2, "Podaj nazwę budowy"),
  companyName: z.string().min(2, "Podaj nazwę firmy lub klienta"),
  contactName: z.string().min(3, "Podaj imię i nazwisko osoby kontaktowej"),
  email: z.string().email("Podaj poprawny adres e-mail"),
  phone: z.preprocess(pusteNaNull, z.string().nullable()),
  address: z.preprocess(pusteNaNull, z.string().nullable()),
  description: z.string().min(10, "Opis zapytania musi mieć co najmniej 10 znaków"),
  products: z.preprocess(pusteNaNull, z.string().nullable()),
  quantity: z.preprocess(pusteNaNull, z.string().nullable()),
  deadline: z.preprocess(pusteNaNull, z.string().nullable()),
  siteAddress: z.preprocess(pusteNaNull, z.string().nullable()),
  quoteValue: z.preprocess(
      (v) => (v === "" || v == null ? null : typeof v === "string" ? Number(v.replace(/\s/g, "").replace(",", ".")) : v),
      z.number().nonnegative("Wartość wyceny nie może być ujemna").nullable(),
  ),
  source: z.enum(CRM_SOURCES),
  requiredAttachments: z.array(z.enum(ATTACHMENT_KINDS)),
  assigneeId: z.preprocess(pusteNaNull, z.string().nullable()),
});
export type CreateCrmRequestInput = z.infer<typeof CreateCrmRequestSchema>;

/** Edycja danych klienta — te same reguły co przy zakładaniu. */
export const UpdateCrmRequestSchema = CreateCrmRequestSchema.omit({ source: true });
export type UpdateCrmRequestInput = z.infer<typeof UpdateCrmRequestSchema>;

export const CreateFollowUpSchema = z.object({
  date: z.string().min(1, "Podaj datę kontaktu"),
  time: z.string().min(1, "Podaj godzinę kontaktu"),
  type: z.enum(FOLLOWUP_TYPES, { errorMap: () => ({ message: "Wybierz typ kontaktu" }) }),
  note: z.string().min(3, "Dodaj krótką notatkę, np. czego dotyczy kontakt"),
});
export type CreateFollowUpInput = z.infer<typeof CreateFollowUpSchema>;

export const ChangeStageSchema = z
    .object({
      stage: z.enum(CRM_STAGES, { errorMap: () => ({ message: "Wybierz etap" }) }),
      lostReason: z.enum(LOST_REASONS).nullable().optional(),
      lostReasonNote: z.string().nullable().optional(),
    })
    .superRefine((v, ctx) => {
      if (v.stage === "lost" && !v.lostReason) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lostReason"],
          message: "Wskaż przyczynę przegranej oferty",
        });
      }
      if (v.stage === "lost" && v.lostReason === "other" && !v.lostReasonNote?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lostReasonNote"],
          message: "Opisz inną przyczynę przegranej",
        });
      }
    });
export type ChangeStageInput = z.infer<typeof ChangeStageSchema>;

// ---------------------- reguły domenowe (funkcje czyste) -------------------

export interface CompletenessResult {
  status: CompletenessStatus;
  missingFields: CrmDataField[];
  missingAttachments: AttachmentKind[];
}

const pusty = (v: string | null | undefined): boolean => v == null || v.trim() === "";

/**
 * Ocena kompletności zapytania.
 *
 * Hierarchia jest istotna: brak danych twardych (opis, specyfikacja) waży
 * więcej niż brak załącznika, bo bez nich handlowiec nie ruszy z wyceną,
 * a o załącznik można dopytać jednym mailem.
 */
export function ocenKompletnosc(req: {
  phone: string | null;
  address: string | null;
  description: string;
  products: string | null;
  quantity: string | null;
  deadline: string | null;
  requiredAttachments: AttachmentKind[];
  attachments: { kind: AttachmentKind }[];
}): CompletenessResult {
  const missingFields: CrmDataField[] = [];
  if (pusty(req.description)) missingFields.push("description");
  if (pusty(req.products)) missingFields.push("products");
  if (pusty(req.quantity)) missingFields.push("quantity");
  if (pusty(req.phone)) missingFields.push("phone");
  if (pusty(req.address)) missingFields.push("address");
  if (pusty(req.deadline)) missingFields.push("deadline");

  const posiadane = new Set(req.attachments.map((a) => a.kind));
  const missingAttachments = req.requiredAttachments.filter((k) => !posiadane.has(k));

  const twarde = missingFields.filter((f) => f === "description" || f === "products" || f === "quantity");

  const status: CompletenessStatus =
      twarde.length > 0
          ? "missing_data"
          : missingAttachments.length > 0
              ? "missing_attachments"
              : missingFields.length > 0
                  ? "partial"
                  : "complete";

  return { status, missingFields, missingAttachments };
}

/** Progi scoringowe — wspólne dla filtrów, kolorów i pasków postępu. */
export const SCORE_BANDS = [
  { min: 0, max: 19, label: "0–19%", level: "d" },
  { min: 20, max: 39, label: "20–39%", level: "d" },
  { min: 40, max: 59, label: "40–59%", level: "w" },
  { min: 60, max: 79, label: "60–79%", level: "o" },
  { min: 80, max: 100, label: "80–100%", level: "o" },
] as const;

export type ScoreLevel = "d" | "w" | "o";

export function scoreBand(score: number): (typeof SCORE_BANDS)[number] {
  return SCORE_BANDS.find((b) => score >= b.min && score <= b.max) ?? SCORE_BANDS[0];
}

/**
 * Demonstracyjna reguła scoringu — świadomie prosta i jawna, żeby dało się ją
 * wytłumaczyć klientowi na spotkaniu. Docelowo w tym miejscu stanie model
 * albo reguły biznesowe uzgodnione z działem handlowym.
 *
 *   40  baza
 *  +20  komplet danych (bez braków)
 *  +10  częściowo kompletne
 *  +10  są jakiekolwiek załączniki
 *  +10  podany termin realizacji
 *  +10  podana ilość
 *  +10  etap co najmniej „Oferta wysłana”
 *  -10  brak telefonu (kontakt tylko mailowy)
 */
export function sugerowanyScoring(req: {
  phone: string | null;
  address: string | null;
  description: string;
  products: string | null;
  quantity: string | null;
  deadline: string | null;
  stage: CrmStage;
  requiredAttachments: AttachmentKind[];
  attachments: { kind: AttachmentKind }[];
}): number {
  const k = ocenKompletnosc(req);
  let s = 40;
  if (k.status === "complete") s += 20;
  else if (k.status === "partial") s += 10;
  if (req.attachments.length > 0) s += 10;
  if (!pusty(req.deadline)) s += 10;
  if (!pusty(req.quantity)) s += 10;
  if (["offer_sent", "negotiation", "won"].includes(req.stage)) s += 10;
  if (pusty(req.phone)) s -= 10;
  return Math.max(0, Math.min(100, s));
}

/** Najbliższy zaplanowany kontakt — używane w liście, kanbanie i kalendarzu. */
export function najblizszyFollowUp(fus: CrmFollowUp[]): CrmFollowUp | null {
  const otwarte = fus
      .filter((f) => f.status === "planned" || f.status === "overdue")
      .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  return otwarte[0] ?? null;
}

/** Follow-up przeterminowany = zaplanowany na termin wcześniejszy niż dziś. */
export function czyPrzeterminowany(f: CrmFollowUp, dzisiaj: string): boolean {
  return (f.status === "planned" || f.status === "overdue") && f.date < dzisiaj;
}

export const dzisiajISO = (): string => new Date().toISOString().slice(0, 10);

/** Podobieństwo tekstów 0–1 (współczynnik Dice’a na bigramach). */
export function podobienstwo(a: string, b: string): number {
  const norm = (s: string): string =>
      s.toLowerCase().replace(/[^a-ząćęłńóśźż0-9 ]/gi, " ").replace(/\s+/g, " ").trim();
  const x = norm(a);
  const y = norm(b);
  if (x === "" || y === "") return 0;
  if (x === y) return 1;
  const bigrams = (s: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };
  const A = bigrams(x);
  const B = bigrams(y);
  if (A.length === 0 || B.length === 0) return 0;
  const pula = [...B];
  let wspolne = 0;
  for (const g of A) {
    const i = pula.indexOf(g);
    if (i >= 0) {
      wspolne++;
      pula.splice(i, 1);
    }
  }
  return (2 * wspolne) / (A.length + B.length);
}

// --------------------- tablica: terminy, problemy, puls --------------------

/**
 * Bliskość terminu dostawy. Progi dobrane pod rytm pracy kosztorysanta:
 * dwa tygodnie to jeszcze spokojna praca, tydzień to sygnał, pięć dni i mniej
 * to stan alarmowy. Poziom steruje kolorem szyny i pulsowaniem kafelka.
 */
export type DeadlineLevel = "none" | "soon" | "urgent" | "overdue";

export function poziomTerminu(deadline: string | null, dzisiaj = dzisiajISO()): DeadlineLevel {
  if (!deadline) return "none";
  const dni = Math.round((Date.parse(deadline) - Date.parse(dzisiaj)) / 86_400_000);
  if (dni < 0) return "overdue";
  if (dni <= 5) return "urgent";
  if (dni <= 14) return "soon";
  return "none";
}

export function dniDoTerminu(deadline: string, dzisiaj = dzisiajISO()): number {
  return Math.round((Date.parse(deadline) - Date.parse(dzisiaj)) / 86_400_000);
}

/** Pilność sprawy — kropka w lewym górnym rogu kafelka. */
export const URGENCY_LEVELS = ["low", "normal", "high", "critical"] as const;
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];

export const URGENCY_LABELS: Record<UrgencyLevel, string> = {
  low: "Niska pilność",
  normal: "Zwykła pilność",
  high: "Wysoka pilność",
  critical: "Krytyczna pilność",
};

/**
 * Pilność liczona, a nie wpisywana: bierze pod uwagę termin dostawy, wiek
 * sprawy bez przypisania i wagę wyceny. Ręczne pole szybko przestaje
 * odpowiadać rzeczywistości, bo nikt go nie aktualizuje.
 */
export function pilnosc(
    req: {
      deadline: string | null;
      createdAt: string;
      assigneeId: string | null;
      stage: CrmStage;
      quoteValue: number | null;
    },
    dzisiaj = dzisiajISO(),
): UrgencyLevel {
  if (req.stage === "won" || req.stage === "lost") return "low";
  const termin = poziomTerminu(req.deadline, dzisiaj);
  if (termin === "overdue" || termin === "urgent") return "critical";
  const wiekDni = Math.round((Date.parse(dzisiaj) - Date.parse(req.createdAt.slice(0, 10))) / 86_400_000);
  if (termin === "soon") return "high";
  if (!req.assigneeId && wiekDni >= 3) return "high";
  if ((req.quoteValue ?? 0) >= 200_000) return "high";
  if (!req.assigneeId) return "normal";
  return "normal";
}

/** Szybkie akcje przy problemach — kafelek ma nie tylko marudzić, ale i pomagać. */
export const ISSUE_ACTIONS = [
  "email_address",
  "email_attachments",
  "email_data",
  "assign",
  "set_value",
  "open_followups",
] as const;
export type IssueAction = (typeof ISSUE_ACTIONS)[number];

export interface CrmIssue {
  id: string;
  severity: "warn" | "error";
  /** Etap, na którym problem blokuje pracę — podświetlany na szynie. */
  stage: CrmStage | null;
  /** Krótki komunikat na kafelku. */
  title: string;
  /** Pełne zdanie do dymka. */
  message: string;
  action: IssueAction | null;
  actionLabel: string | null;
  /** Wysłaliśmy prośbę i brak nadal istnieje — teraz czekamy na klienta. */
  waitingSince?: string | null;
}

/**
 * Wykrywanie problemów sprawy. Funkcja czysta i wspólna dla API oraz
 * interfejsu — kafelek, dymek i szczegóły pokazują dokładnie to samo.
 *
 * Kolejność wyniku jest kolejnością ważności: pierwszy element steruje
 * kolorem szyny i pulsowaniem kafelka.
 */
export function wykryjProblemy(
    req: {
      stage: CrmStage;
      deadline: string | null;
      createdAt: string;
      assigneeId: string | null;
      quoteValue: number | null;
      siteAddress: string | null;
      phone: string | null;
      description: string;
      products: string | null;
      quantity: string | null;
      requiredAttachments: AttachmentKind[];
      attachments: { kind: AttachmentKind }[];
      messages: { templateKey: TemplateKey | null; sentAt: string | null }[];
      followUps: CrmFollowUp[];
    },
    dzisiaj = dzisiajISO(),
    /**
     * Reguły wyłączone w ustawieniach modułu. Nie każda firma chce, żeby brak
     * rysunku świecił na czerwono — jeśli reguła nie pasuje do sposobu pracy,
     * lepiej ją wyłączyć niż uczyć ludzi ignorowania ostrzeżeń.
     */
    wylaczone: readonly string[] = [],
): CrmIssue[] {
  const out: CrmIssue[] = [];
  if (req.stage === "won" || req.stage === "lost") return out;
  const wlaczona = (id: string): boolean => !wylaczone.includes(id);

  const termin = poziomTerminu(req.deadline, dzisiaj);
  if (wlaczona("deadline") && req.deadline && termin !== "none") {
    const dni = dniDoTerminu(req.deadline, dzisiaj);
    out.push({
      id: "deadline",
      severity: termin === "soon" ? "warn" : "error",
      stage: req.stage,
      title:
          termin === "overdue"
              ? `Termin minął ${Math.abs(dni)} dni temu`
              : dni === 0
                  ? "Termin dostawy dzisiaj"
                  : `Termin za ${dni} dni`,
      message:
          termin === "overdue"
              ? `Termin dostawy (${req.deadline}) minął ${Math.abs(dni)} dni temu, a sprawa jest wciąż otwarta.`
              : `Do terminu dostawy (${req.deadline}) zostało ${dni} dni — sprawa jest na etapie „${CRM_STAGE_LABELS[req.stage]}”.`,
      action: "open_followups",
      actionLabel: "Zaplanuj kontakt",
    });
  }

  if (wlaczona("address") && pusty(req.siteAddress)) {
    out.push({
      id: "address",
      severity: "error",
      stage: "contact",
      title: "Brak adresu budowy",
      message: "Nie znamy adresu budowy, więc nie da się policzyć transportu ani montażu.",
      action: "email_address",
      actionLabel: "Poproś o adres",
    });
  }

  const brakZal = req.requiredAttachments.filter(
      (k) => !req.attachments.some((a) => a.kind === k),
  );
  if (wlaczona("attachments") && brakZal.length > 0) {
    const ostatniaProsba = req.messages
        .filter((m) => m.templateKey === "attachments" && m.sentAt != null)
        .sort((a, b) => (a.sentAt ?? "").localeCompare(b.sentAt ?? ""))
        .at(-1);
    const czekamy = ostatniaProsba?.sentAt != null;
    out.push({
      id: "attachments",
      severity: "warn",
      stage: "offer_prep",
      title: czekamy
          ? "Czekamy na pliki od klienta"
          : brakZal.length === 1 ? "Brak pliku" : `Brak ${brakZal.length} plików`,
      message: czekamy
          ? `Brakuje załączników: ${brakZal.map((k) => ATTACHMENT_KIND_LABELS[k]).join(", ")}. Prośba została wysłana; czekamy na odpowiedź klienta.`
          : `Brakuje załączników: ${brakZal.map((k) => ATTACHMENT_KIND_LABELS[k]).join(", ")}.`,
      action: "email_attachments",
      actionLabel: czekamy ? "Poproś ponownie o pliki" : "Poproś o pliki",
      waitingSince: ostatniaProsba?.sentAt ?? null,
    });
  }

  const brakiDanych: string[] = [];
  if (pusty(req.products)) brakiDanych.push("specyfikacja");
  if (pusty(req.quantity)) brakiDanych.push("ilość");
  if (pusty(req.phone)) brakiDanych.push("telefon");
  if (wlaczona("data") && brakiDanych.length > 0) {
    out.push({
      id: "data",
      severity: brakiDanych.includes("telefon") && brakiDanych.length === 1 ? "warn" : "error",
      stage: "contact",
      title: "Brak danych",
      message: `Do wyceny brakuje: ${brakiDanych.join(", ")}.`,
      action: "email_data",
      actionLabel: "Poproś o dane",
    });
  }

  const wiekDni = Math.round(
      (Date.parse(dzisiaj) - Date.parse(req.createdAt.slice(0, 10))) / 86_400_000,
  );
  if (wlaczona("assignee") && !req.assigneeId && wiekDni >= 3) {
    out.push({
      id: "assignee",
      severity: "warn",
      stage: "new",
      title: `Bez kosztorysanta od ${wiekDni} dni`,
      message: `Zapytanie wpłynęło ${wiekDni} dni temu i nadal nie ma przypisanego kosztorysanta.`,
      action: "assign",
      actionLabel: "Przypisz",
    });
  }

  if (
      wlaczona("value") &&
      req.quoteValue == null &&
      ["offer_prep", "offer_sent", "negotiation"].includes(req.stage)
  ) {
    out.push({
      id: "value",
      severity: "warn",
      stage: "offer_prep",
      title: "Brak wartości wyceny",
      message: "Sprawa jest na etapie ofertowym, a wartość wyceny nie została wpisana.",
      action: "set_value",
      actionLabel: "Wpisz wartość",
    });
  }

  const zalegly = req.followUps.some((f) => czyPrzeterminowany(f, dzisiaj));
  if (wlaczona("followup") && zalegly) {
    out.push({
      id: "followup",
      severity: "warn",
      stage: req.stage,
      title: "Zaległy kontakt",
      message: "Zaplanowany kontakt z klientem jest przeterminowany.",
      action: "open_followups",
      actionLabel: "Otwórz kontakty",
    });
  }

  const waga = { error: 0, warn: 1 } as const;
  return out.sort((a, b) => waga[a.severity] - waga[b.severity]);
}

/**
 * Puls kafelka. Nowe, nietknięte zapytanie miga na niebiesko, dopóki ktoś go
 * nie otworzy albo nie przeciągnie do kosztorysanta. Termin bierze
 * pierwszeństwo — czerwień ma wygrywać z zaproszeniem do pracy.
 */
export type CardPulse = "none" | "new" | "warn" | "danger";

export function pulsKafelka(
    req: {
      stage: CrmStage;
      deadline: string | null;
      seenAt: string | null;
      assigneeId: string | null;
    },
    dzisiaj = dzisiajISO(),
): CardPulse {
  if (req.stage === "won" || req.stage === "lost") return "none";
  const termin = poziomTerminu(req.deadline, dzisiaj);
  if (termin === "urgent" || termin === "overdue") return "danger";
  if (!req.seenAt && !req.assigneeId) return "new";
  if (termin === "soon") return "warn";
  return "none";
}

// ---------------------- schematy formularzy tablicy ------------------------

export const CreateOutsourcingSchema = z.object({
  /** Pusta nazwa = zbudowana z pozycji po stronie serwera. */
  title: z.string().trim().default(""),
  deadline: z.preprocess(pusteNaNull, z.string().nullable()).optional(),
  subject: z.string().trim().min(3, "Temat wiadomości nie może być pusty"),
  body: z.string().trim().min(10, "Treść wiadomości jest za krótka"),
  elements: z
      .array(
          z.object({
            title: z.string().trim().min(2, "Nazwa elementu jest za krótka"),
            description: z.string().trim().min(3, "Opisz krótko, co ma być wycenione"),
            // Ilość bywa nieznana na etapie zapytania — wtedy pytamy o cenę
            // jednostkową, a nie blokujemy wysyłki.
            quantity: z.preprocess(pusteNaNull, z.string().nullable()).optional().default(null),
          }),
      )
      .min(1, "Dodaj co najmniej jeden element do wyceny"),
  /** Firmy wraz z zakresem: indeksy elementów z tablicy `elements`. */
  vendors: z
      .array(
          z.object({
            vendorId: z.string(),
            elementIndexes: z.array(z.number().int().nonnegative()).min(1, "Firma musi dostać choć jeden element"),
          }),
      )
      .min(1, "Wskaż co najmniej jedną firmę"),
  /** Metadane załączników — wersja demonstracyjna nie przesyła plików. */
  attachments: z
      .array(z.object({ name: z.string(), sizeKb: z.number().nonnegative() }))
      .default([]),
});

export const SelectVendorSchema = z.object({
  vendorId: z.string().nullable(),
});
export type CreateOutsourcingInput = z.infer<typeof CreateOutsourcingSchema>;

export const RecordQuoteSchema = z.object({
  quoteValue: z.preprocess(
      (v) => (typeof v === "string" ? Number(v.replace(/\s/g, "").replace(",", ".")) : v),
      z.number().nonnegative("Kwota nie może być ujemna").nullable(),
  ),
  leadTimeDays: z.preprocess(
      (v) => (v === "" || v == null ? null : typeof v === "string" ? Number(v) : v),
      z.number().int().nonnegative().nullable(),
  ),
  status: z.enum(VENDOR_INQUIRY_STATUSES),
  note: z.preprocess(pusteNaNull, z.string().nullable()),
});
export type RecordQuoteInput = z.infer<typeof RecordQuoteSchema>;

/**
 * Osoba kontaktowa. Wymagamy JEDNEJ formy kontaktu, nie obu naraz: część
 * kontaktów budowlanych to numer telefonu bez służbowej skrzynki, a część —
 * skrzynka działu bez konkretnego numeru. Wymaganie kompletu zmuszałoby do
 * wpisywania danych zmyślonych, a wtedy kartoteka kłamie.
 */
export const CreateContactSchema = z
    .object({
      name: z.string().trim().min(3, "Podaj imię i nazwisko (min. 3 znaki)"),
      email: z.preprocess(pusteNaNull, z.string().nullable()),
      phone: z.preprocess(pusteNaNull, z.string().nullable()),
      role: z.preprocess(pusteNaNull, z.string().nullable()),
    })
    .superRefine((v, ctx) => {
      if (!v.email && !v.phone) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["email"],
          message: "Podaj przynajmniej jedną formę kontaktu: e-mail albo telefon",
        });
        return;
      }
      if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["email"],
          message: "Adres e-mail wygląda niepoprawnie — oczekiwany format: nazwa@firma.pl",
        });
      }
      if (v.phone) {
        const cyfry = v.phone.replace(/[^\d]/g, "");
        if (cyfry.length < 9) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["phone"],
            message: "Numer telefonu jest za krótki — podaj co najmniej 9 cyfr",
          });
        }
      }
    });
export type CreateContactInput = z.infer<typeof CreateContactSchema>;

export const CreateColumnSchema = z
    .object({
      title: z.string(),
      employeeId: z.preprocess(pusteNaNull, z.string().nullable()),
    })
    .superRefine((v, ctx) => {
      // Kolumna kosztorysanta bierze nazwę z kartoteki pracowników, więc pole
      // tytułu jest wtedy puste — wymagamy go tylko dla kolumn własnych.
      if (!v.employeeId && v.title.trim().length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["title"],
          message: "Nazwa kolumny musi mieć co najmniej 2 znaki",
        });
      }
    });
export type CreateColumnInput = z.infer<typeof CreateColumnSchema>;

export const MoveRequestSchema = z.object({
  columnId: z.string().min(1, "Wskaż kolumnę"),
  lostReason: z.enum(LOST_REASONS).nullable().optional(),
  lostReasonNote: z.string().nullable().optional(),
});
export type MoveRequestInput = z.infer<typeof MoveRequestSchema>;

/** Edycja pól, które wolno zmieniać z panelu szczegółów. */
export const PatchRequestSchema = z.object({
  projectName: z.string().min(2, "Podaj nazwę budowy").optional(),
  siteAddress: z.preprocess(pusteNaNull, z.string().nullable()).optional(),
  quoteValue: z.preprocess(
      (v) => (v === "" || v == null ? null : typeof v === "string" ? Number(v.replace(/\s|,/g, (m) => (m === "," ? "." : ""))) : v),
      z.number().nonnegative("Wartość wyceny nie może być ujemna").nullable(),
  ).optional(),
  deadline: z.preprocess(pusteNaNull, z.string().nullable()).optional(),
  projectManagerId: z.preprocess(pusteNaNull, z.string().nullable()).optional(),
  assigneeId: z.preprocess(pusteNaNull, z.string().nullable()).optional(),
  clientId: z.preprocess(pusteNaNull, z.string().nullable()).optional(),
  score: z.number().min(0).max(100).optional(),
  notes: z.string().optional(),
});
export type PatchRequestInput = z.infer<typeof PatchRequestSchema>;

export const StageNoteInputSchema = z.object({
  stage: z.enum(CRM_STAGES),
  text: z.string(),
});
export type StageNoteInput = z.infer<typeof StageNoteInputSchema>;

// ----------------------- odległość do miejsca dostawy ----------------------

/**
 * Szacowanie trasy z zakładu na budowę.
 *
 * WAŻNE: to jest przybliżenie, nie nawigacja. Nie mamy tu ani geokodera, ani
 * usługi tras, więc liczymy odległość w linii prostej między zakładem a
 * miastem rozpoznanym z adresu i mnożymy przez współczynnik krętości dróg.
 * Wynik służy do wstępnej wyceny transportu — do oferty wiążącej trzeba
 * podpiąć prawdziwe API (patrz CRM.md, sekcja o podłączeniu usług).
 *
 * Bufor bezpieczeństwa 25 km doliczamy do trasy w dwie strony: dojazdy pod
 * adres, objazdy i szukanie wjazdu na plac budowy potrafią zjeść tyle bez
 * ostrzeżenia.
 */
export const DEPOT = {
  name: "Zakład",
  address: "ul. Zakaszewskiego 7, 66-300 Międzyrzecz",
  lat: 52.4453,
  lon: 15.5772,
};

/** Współczynnik krętości: droga jest dłuższa niż linia prosta. */
export const WSP_KRETOSCI = 1.32;

/** Bufor bezpieczeństwa doliczany do trasy w dwie strony [km]. */
export const BUFOR_KM = 25;

/**
 * Miasta, które umiemy rozpoznać po nazwie w adresie. Lista celowo krótka —
 * ma pokazać mechanizm, a nie udawać bazy TERYT.
 */
const MIASTA: Record<string, { lat: number; lon: number }> = {
  międzyrzecz: { lat: 52.4453, lon: 15.5772 },
  "zielona góra": { lat: 51.9356, lon: 15.5062 },
  gorzów: { lat: 52.7368, lon: 15.2288 },
  świebodzin: { lat: 52.2472, lon: 15.5344 },
  nowa: { lat: 51.8006, lon: 15.7181 },
  legnica: { lat: 51.2107, lon: 16.1619 },
  katowice: { lat: 50.2649, lon: 19.0238 },
  gliwice: { lat: 50.2945, lon: 18.6714 },
  chorzów: { lat: 50.2974, lon: 18.9546 },
  sosnowiec: { lat: 50.2863, lon: 19.104 },
  kraków: { lat: 50.0647, lon: 19.945 },
  warszawa: { lat: 52.2297, lon: 21.0122 },
  wrocław: { lat: 51.1079, lon: 17.0385 },
  poznań: { lat: 52.4064, lon: 16.9252 },
  łódź: { lat: 51.7592, lon: 19.4559 },
  gdańsk: { lat: 54.352, lon: 18.6466 },
  gdynia: { lat: 54.5189, lon: 18.5305 },
  szczecin: { lat: 53.4285, lon: 14.5528 },
  lublin: { lat: 51.2465, lon: 22.5684 },
  białystok: { lat: 53.1325, lon: 23.1688 },
  rzeszów: { lat: 50.0413, lon: 21.999 },
  radom: { lat: 51.4027, lon: 21.1471 },
  płock: { lat: 52.5463, lon: 19.7065 },
  opole: { lat: 50.6751, lon: 17.9213 },
  bydgoszcz: { lat: 53.1235, lon: 18.0084 },
  toruń: { lat: 53.0138, lon: 18.5984 },
  kielce: { lat: 50.8661, lon: 20.6286 },
  częstochowa: { lat: 50.7971, lon: 19.1204 },
  bielsko: { lat: 49.8224, lon: 19.0584 },
  rybnik: { lat: 50.0971, lon: 18.5416 },
  tychy: { lat: 50.1372, lon: 18.9662 },
  zabrze: { lat: 50.3249, lon: 18.7857 },
};

const RAD = Math.PI / 180;

function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

export interface Trasa {
  miasto: string;
  /** Trasa w jedną stronę [km], po uwzględnieniu krętości dróg. */
  wJednaStrone: number;
  wDwieStrony: number;
  /** Trasa w dwie strony powiększona o bufor bezpieczeństwa. */
  zBuforem: number;
  bufor: number;
  /** true, gdy miasta nie ma w tablicy — wtedy pozostałe pola są zerowe. */
  nieznane: boolean;
}

export function szacujTrase(address: string | null): Trasa | null {
  if (!address) return null;
  const a = address.toLowerCase();
  const wpis = Object.entries(MIASTA).find(([m]) => a.includes(m));
  if (!wpis) {
    return { miasto: "?", wJednaStrone: 0, wDwieStrony: 0, zBuforem: 0, bufor: BUFOR_KM, nieznane: true };
  }
  const [nazwa, poz] = wpis;
  const km = Math.round(haversine(DEPOT, poz) * WSP_KRETOSCI);
  return {
    miasto: nazwa.charAt(0).toUpperCase() + nazwa.slice(1),
    wJednaStrone: km,
    wDwieStrony: km * 2,
    zBuforem: km * 2 + BUFOR_KM,
    bufor: BUFOR_KM,
    nieznane: false,
  };
}

// ---------------------------- automaty tablicy -----------------------------

/** Po tylu dniach w kolumnie „Wysłane” oferta idzie do follow-upu. */
export const DNI_DO_FOLLOWUP = 7;

/** Zwroty, po których odpowiedź klienta czytamy jako odmowę. */
export const FRAZY_ODMOWY = [
  "nie jesteśmy zainteresowani",
  "nie jestem zainteresowany",
  "rezygnujemy",
  "rezygnuję",
  "wybraliśmy inną ofertę",
  "wybraliśmy innego",
  "zdecydowaliśmy się na inn",
  "nie skorzystamy",
  "oferta odrzucona",
  "za drogo",
];

export function czyOdmowa(text: string): boolean {
  const t = text.toLowerCase();
  return FRAZY_ODMOWY.some((f) => t.includes(f));
}

// ------------------------- szablony i automatyzacja ------------------------

/**
 * Znaczniki w szablonach wiadomości. Każdy należy do kategorii, a kategoria
 * ma swój kolor w edytorze — dzięki temu autor szablonu widzi jednym rzutem
 * oka, co jest tekstem stałym, a co system podstawi za niego.
 */
export const TOKEN_CATEGORIES = ["osoba", "sprawa", "produkt", "braki", "firma"] as const;
export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];

export const TOKEN_CATEGORY_LABELS: Record<TokenCategory, string> = {
  osoba: "Osoby",
  sprawa: "Dane sprawy",
  produkt: "Zakres i produkty",
  braki: "Braki i załączniki",
  firma: "Nasza firma",
};

export interface TokenMeta {
  token: string;
  label: string;
  category: TokenCategory;
}

export const TOKENY: TokenMeta[] = [
  { token: "klient.osoba", label: "Osoba kontaktowa klienta", category: "osoba" },
  { token: "klient.firma", label: "Nazwa firmy klienta", category: "osoba" },
  { token: "kosztorysant.imie", label: "Kosztorysant — imię i nazwisko", category: "osoba" },
  { token: "kosztorysant.email", label: "Kosztorysant — e-mail", category: "osoba" },
  { token: "kosztorysant.telefon", label: "Kosztorysant — telefon", category: "osoba" },
  { token: "pm.imie", label: "Project manager", category: "osoba" },
  { token: "sprawa.numer", label: "Numer zapytania", category: "sprawa" },
  { token: "sprawa.budowa", label: "Nazwa budowy", category: "sprawa" },
  { token: "sprawa.termin", label: "Termin dostawy", category: "sprawa" },
  { token: "sprawa.adres", label: "Adres budowy", category: "sprawa" },
  { token: "sprawa.wartosc", label: "Wartość wyceny", category: "sprawa" },
  { token: "sprawa.dni", label: "Dni od wysłania oferty", category: "sprawa" },
  { token: "produkty", label: "Zakres / produkty", category: "produkt" },
  { token: "ilosc", label: "Ilość", category: "produkt" },
  { token: "element.nazwa", label: "Element do wyceny", category: "produkt" },
  { token: "element.opis", label: "Opis elementu", category: "produkt" },
  { token: "braki.lista", label: "Lista brakujących danych", category: "braki" },
  { token: "braki.zalaczniki", label: "Lista brakujących załączników", category: "braki" },
  { token: "firma.nazwa", label: "Nasza firma", category: "firma" },
  { token: "firma.telefon", label: "Nasz telefon", category: "firma" },
  { token: "firma.email", label: "Nasz e-mail", category: "firma" },
  { token: "firma.adres", label: "Adres zakładu", category: "firma" },
];

export const KATEGORIA_TOKENA: Record<string, TokenCategory> = Object.fromEntries(
    TOKENY.map((t) => [t.token, t.category]),
);

/** Fragment wypełnionej treści: tekst stały albo wartość podstawiona za znacznik. */
export interface Segment {
  text: string;
  token: string | null;
  category: TokenCategory | null;
}

/**
 * Wypełnienie szablonu. Zwraca gotowy tekst ORAZ listę podstawionych wartości,
 * żeby edytor mógł je podświetlić także po ręcznej korekcie treści — pozycje
 * znaków przestają się zgadzać po pierwszej edycji, wartości nie.
 */
export function wypelnijSzablon(
    tpl: string,
    ctx: Record<string, string | null | undefined>,
): { text: string; podstawienia: { token: string; value: string; category: TokenCategory }[] } {
  const podstawienia: { token: string; value: string; category: TokenCategory }[] = [];
  const text = tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, token: string) => {
    const value = (ctx[token] ?? "").toString().trim();
    const wynik = value === "" ? `[${token}]` : value;
    podstawienia.push({ token, value: wynik, category: KATEGORIA_TOKENA[token] ?? "sprawa" });
    return wynik;
  });
  return { text, podstawienia };
}

export const MessageTemplateSchema = z.object({
  key: z.enum(TEMPLATE_KEYS),
  subject: z.string().min(3, "Temat nie może być pusty"),
  body: z.string().min(10, "Treść jest za krótka"),
  /** Wyłączony szablon nie jest używany przez automaty ani szybkie akcje. */
  enabled: z.boolean(),
});
export type MessageTemplate = z.infer<typeof MessageTemplateSchema>;

/** Reguły wykrywania problemów, które da się wyłączyć w ustawieniach. */
export const ISSUE_RULES = [
  "deadline",
  "address",
  "attachments",
  "data",
  "assignee",
  "value",
  "followup",
] as const;
export type IssueRule = (typeof ISSUE_RULES)[number];

export const ISSUE_RULE_LABELS: Record<IssueRule, string> = {
  deadline: "Zbliżający się termin dostawy",
  address: "Brak adresu budowy",
  attachments: "Brak wymaganych załączników",
  data: "Braki w danych (zakres, ilość, telefon)",
  assignee: "Sprawa bez kosztorysanta",
  value: "Brak wartości wyceny na etapie ofertowym",
  followup: "Zaległy zaplanowany kontakt",
};

export const CrmSettingsSchema = z.object({
  /** Konto pocztowe, z którego wychodzi korespondencja modułu. */
  mailbox: z.object({
    provider: z.literal("outlook"),
    account: z.string(),
    displayName: z.string(),
  }),
  company: z.object({
    name: z.string(),
    email: z.string(),
    phone: z.string(),
    address: z.string(),
  }),
  automation: z.object({
    /** Automatyczny klasyfikator lub bezpieczne kierowanie każdej wiadomości do operatora. */
    mailClassificationMode: z.enum(["automatic", "manual"]),
    /** Potwierdzenie przyjęcia wychodzi samo po rozpoznaniu zapytania. */
    acknowledgeNewRequests: z.boolean(),
    /** Po ilu dniach w „Wysłanych” karta idzie do follow-upu. */
    followUpAfterDays: z.number().int().min(1).max(60),
    /** Czy follow-up ma wyjść automatycznie, czy tylko przygotować szkic. */
    autoSendFollowUp: z.boolean(),
    /** Czy odpowiedź czytana jako odmowa zamyka sprawę bez pytania. */
    autoCloseOnRefusal: z.boolean(),
    /** Deklarowany czas odpowiedzi podawany klientowi. */
    responseDays: z.number().int().min(1).max(30),
  }),
  issues: z.record(z.enum(ISSUE_RULES), z.boolean()),
  templates: z.array(MessageTemplateSchema),
});
export type CrmSettings = z.infer<typeof CrmSettingsSchema>;

export const UpdateSettingsSchema = CrmSettingsSchema.partial();
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>;

export const ComposeMessageSchema = z.object({
  to: z.string().min(3, "Podaj adresata"),
  cc: z.array(z.string()).default([]),
  attachments: z
      .array(z.object({ name: z.string(), sizeKb: z.number().nonnegative() }))
      .default([]),
  subject: z.string().min(3, "Temat nie może być pusty"),
  body: z.string().trim().min(1, "Treść nie może być pusta"),
  kind: z.enum(CRM_MESSAGE_KINDS).default("custom"),
  /** Klucz szablonu, jeśli wiadomość powstała z szybkiej akcji. */
  templateKey: z.enum(TEMPLATE_KEYS).nullable().default(null),
  send: z.boolean().default(true),
});
export type ComposeMessageInput = z.infer<typeof ComposeMessageSchema>;

/** Gotowe zestawy do outsourcingu — żeby nie pisać opisu od zera. */
export const OUTSOURCING_PRESETS = [
  {
    id: "giecie",
    title: "Gięcie blach",
    description:
        "Gięcie wg załączonego rysunku. Materiał: {{material}}. Grubość: {{grubosc}}. Tolerancja wg rysunku.",
    keywords: ["gięcie", "cięcie laserem"],
  },
  {
    id: "malowanie",
    title: "Malowanie proszkowe",
    description:
        "Malowanie proszkowe elementów. Kolor: {{kolor}}. Przygotowanie powierzchni wg standardu Sa 2,5.",
    keywords: ["malowanie proszkowe", "ocynk"],
  },
  {
    id: "ocynk",
    title: "Ocynk ogniowy",
    description:
        "Cynkowanie ogniowe konstrukcji wg PN-EN ISO 1461. Największy element: {{gabaryt}}.",
    keywords: ["ocynk ogniowy", "ocynk"],
  },
  {
    id: "obrobka",
    title: "Obróbka skrawaniem",
    description:
        "Obróbka skrawaniem wg rysunku. Materiał: {{material}}. Chropowatość i tolerancje wg dokumentacji.",
    keywords: ["obróbka skrawaniem"],
  },
  {
    id: "spawanie",
    title: "Spawanie konstrukcji",
    description:
        "Spawanie konstrukcji wg rysunku. Metoda: {{metoda}}. Wymagana dokumentacja spawalnicza.",
    keywords: ["spawanie", "konstrukcje stalowe"],
  },
  {
    id: "okablowanie",
    title: "Okablowanie i automatyka",
    description:
        "Wykonanie okablowania wg schematu. Zakres: {{zakres}}. Odbiór z pomiarami.",
    keywords: ["okablowanie", "automatyka"],
  },
] as const;

/** Ile pełnych dni minęło od podanej chwili (ISO). */
export function dniOdISO(iso: string): number {
  return Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
}


// ------------------------- korespondencja: role autorów ---------------------

/**
 * Kto napisał wiadomość — z punktu widzenia osoby, która na nią patrzy.
 * Kolor wpisu w wątku bierze się właśnie stąd: własna korespondencja, pismo
 * kolegi i pismo kierownika mają w pracy inną wagę i inaczej się je czyta.
 */
export type AutorWiadomosci = "klient" | "ja" | "kierownik" | "wspolpracownik" | "system";

export function autorWiadomosci(
    msg: { direction: "in" | "out"; authorId: string | null },
    jaId: string | null,
    pracownicy: { id: string; role: CrmEmployeeRole }[],
): AutorWiadomosci {
  if (msg.direction === "in") return "klient";
  if (!msg.authorId) return "system";
  if (msg.authorId === jaId) return "ja";
  const p = pracownicy.find((x) => x.id === msg.authorId);
  if (p?.role === "kierownik" || p?.role === "administrator") return "kierownik";
  return "wspolpracownik";
}

/**
 * Czy wiadomość ma być widoczna dla tej osoby. Szkic jest prywatny: nikt nie
 * chce, żeby kolega zobaczył nieskończone zdanie, które akurat przemyśliwa.
 */
export function widocznaDla(
    msg: { sentAt: string | null; authorId: string | null },
    jaId: string | null,
): boolean {
  if (msg.sentAt) return true;
  return msg.authorId != null && msg.authorId === jaId;
}

/** Nieprzeczytane wiadomości w sprawie — bez szkiców i bez własnych pism. */
export function nieprzeczytane<T extends { sentAt: string | null; authorId: string | null; readBy: string[]; direction: "in" | "out" }>(
    messages: T[],
    jaId: string | null,
): T[] {
  if (!jaId) return [];
  return messages.filter(
      (m) => m.sentAt != null && m.authorId !== jaId && !m.readBy.includes(jaId),
  );
}
