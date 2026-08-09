/**
 * domain.ts — model domenowy magazynu.
 *
 * Schematy Zod są jednym źródłem prawdy dla walidacji na froncie i w API,
 * typów TypeScript oraz — docelowo — wiedzy asystenta o polach formularzy.
 * Komunikaty walidacji po polsku pisane raz, tutaj.
 */

import { z } from "zod";

// ------------------------------- słowniki --------------------------------

export const DOC_TYPES = ["PZ", "WZ", "MM"] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  PZ: "Przyjęcie zewnętrzne",
  WZ: "Wydanie zewnętrzne",
  MM: "Przesunięcie międzymagazynowe",
};

export const DOC_STATUSES = ["draft", "confirmed"] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

export const DOC_STATUS_LABELS: Record<DocStatus, string> = {
  draft: "Szkic",
  confirmed: "Zatwierdzony",
};

export const ROLES = ["magazynier", "kierownik"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  magazynier: "Magazynier",
  kierownik: "Kierownik",
};

/** Miejsca powstawania kosztów — słownik dekoracyjny, pole zablokowane. */
export const COST_CENTERS = ["MPK-100 Produkcja", "MPK-200 Utrzymanie ruchu", "MPK-300 Administracja"] as const;

// --------------------------------- encje ---------------------------------

export const ProductSchema = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
  unit: z.string(),
  minStock: z.number().nonnegative(),
  /** Cena ewidencyjna — podpowiadana na pozycji dokumentu. */
  price: z.number().nonnegative(),
  category: z.string(),
  active: z.boolean(),
});
export type Product = z.infer<typeof ProductSchema>;

export const WarehouseSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
});
export type Warehouse = z.infer<typeof WarehouseSchema>;

export const CounterpartySchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  taxId: z.string(),
  city: z.string(),
  kind: z.enum(["supplier", "customer", "both"]),
  active: z.boolean(),
});
export type Counterparty = z.infer<typeof CounterpartySchema>;

export const DocumentLineSchema = z.object({
  id: z.string(),
  productId: z.string(),
  quantity: z.number(),
  unitPrice: z.number(),
  /** Lokalizacja w magazynie, np. regał A-12. Opcjonalna. */
  location: z.string().nullable(),
});
export type DocumentLine = z.infer<typeof DocumentLineSchema>;

export const DocumentSchema = z.object({
  id: z.string(),
  number: z.string(),
  type: z.enum(DOC_TYPES),
  status: z.enum(DOC_STATUSES),
  warehouseFromId: z.string().nullable(),
  warehouseToId: z.string().nullable(),
  /** Wymagany dla PZ i WZ, niedostępny dla MM. */
  counterpartyId: z.string().nullable(),
  documentDate: z.string(),
  operationDate: z.string(),
  /** Numer dokumentu u kontrahenta (numer obcy). */
  externalNumber: z.string().nullable(),
  notes: z.string().nullable(),
  lines: z.array(DocumentLineSchema),
  createdAt: z.string(),
  createdBy: z.string(),
  confirmedAt: z.string().nullable(),
  confirmedBy: z.string().nullable(),
});
export type Document = z.infer<typeof DocumentSchema>;

export interface StockLevel {
  productId: string;
  warehouseId: string;
  quantity: number;
}

// ------------------------- schematy formularzy ---------------------------

export const CreateLineSchema = z.object({
  productId: z.string().min(1, "Wybierz produkt"),
  quantity: z
    .number({ invalid_type_error: "Ilość musi być liczbą" })
    .positive("Ilość musi być większa od zera"),
  unitPrice: z
    .number({ invalid_type_error: "Cena musi być liczbą" })
    .nonnegative("Cena nie może być ujemna"),
  location: z.string().nullable(),
});
export type CreateLineInput = z.infer<typeof CreateLineSchema>;

export const CreateDocumentSchema = z
  .object({
    type: z.enum(DOC_TYPES, {
      errorMap: () => ({ message: "Wybierz typ dokumentu" }),
    }),
    warehouseFromId: z.string().nullable(),
    warehouseToId: z.string().nullable(),
    counterpartyId: z.string().nullable(),
    documentDate: z.string().min(1, "Podaj datę dokumentu"),
    operationDate: z.string().min(1, "Podaj datę operacji"),
    externalNumber: z.string().nullable(),
    notes: z.string().nullable(),
    lines: z.array(CreateLineSchema),
  })
  .superRefine((doc, ctx) => {
    if ((doc.type === "WZ" || doc.type === "MM") && !doc.warehouseFromId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["warehouseFromId"],
        message: "Wybierz magazyn źródłowy",
      });
    }
    if ((doc.type === "PZ" || doc.type === "MM") && !doc.warehouseToId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["warehouseToId"],
        message: "Wybierz magazyn docelowy",
      });
    }
    if ((doc.type === "PZ" || doc.type === "WZ") && !doc.counterpartyId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["counterpartyId"],
        message: doc.type === "PZ" ? "Wybierz dostawcę" : "Wybierz odbiorcę",
      });
    }
    if (doc.operationDate && doc.documentDate && doc.operationDate < doc.documentDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operationDate"],
        message: "Data operacji nie może być wcześniejsza niż data dokumentu",
      });
    }
  });
export type CreateDocumentInput = z.infer<typeof CreateDocumentSchema>;

/** Wartość pozycji — używane w UI i w podsumowaniu dokumentu. */
export const lineValue = (l: { quantity: number; unitPrice: number }): number =>
  Math.round(l.quantity * l.unitPrice * 100) / 100;

export const formatPLN = (v: number): string =>
  v.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ============================ LOKALIZACJE ==================================

/**
 * Nazwa StorageLocation, nie Location — "Location" to wbudowany typ DOM
 * (window.location) i kolizja nazw prowadzi do mylących błędów kompilacji.
 */
export const StorageLocationSchema = z.object({
  id: z.string(),
  warehouseId: z.string(),
  /** Adres w magazynie, np. A-01. Unikalny w obrębie magazynu. */
  code: z.string(),
  description: z.string().nullable(),
  /** Orientacyjna pojemność w sztukach. 0 = nieokreślona. */
  capacity: z.number().nonnegative(),
  active: z.boolean(),
});
export type StorageLocation = z.infer<typeof StorageLocationSchema>;

export const CreateLocationSchema = z.object({
  warehouseId: z.string().min(1, "Wybierz magazyn"),
  code: z
    .string()
    .min(2, "Podaj kod lokalizacji, np. A-01")
    .max(10, "Kod może mieć najwyżej 10 znaków"),
  description: z.string().nullable(),
  capacity: z
    .number({ invalid_type_error: "Pojemność musi być liczbą" })
    .nonnegative("Pojemność nie może być ujemna"),
});
export type CreateLocationInput = z.infer<typeof CreateLocationSchema>;

// =========================== INWENTARYZACJA ================================

export const STOCKTAKE_STATUSES = ["open", "closed"] as const;
export type StocktakeStatus = (typeof STOCKTAKE_STATUSES)[number];

export const STOCKTAKE_STATUS_LABELS: Record<StocktakeStatus, string> = {
  open: "Otwarta",
  closed: "Zamknięta",
};

export const StocktakeLineSchema = z.object({
  productId: z.string(),
  /** Stan księgowy w chwili otwarcia arkusza — zamrożony snapshot. */
  expected: z.number(),
  /** Ilość policzona fizycznie. null = jeszcze nie liczono. */
  counted: z.number().nullable(),
});
export type StocktakeLine = z.infer<typeof StocktakeLineSchema>;

export const StocktakeSchema = z.object({
  id: z.string(),
  number: z.string(),
  warehouseId: z.string(),
  status: z.enum(STOCKTAKE_STATUSES),
  lines: z.array(StocktakeLineSchema),
  createdAt: z.string(),
  createdBy: z.string(),
  closedAt: z.string().nullable(),
  closedBy: z.string().nullable(),
});
export type Stocktake = z.infer<typeof StocktakeSchema>;

// ========================== ZAMÓWIENIA ZAKUPU ==============================

export const PO_STATUSES = ["draft", "ordered", "received"] as const;
export type PurchaseOrderStatus = (typeof PO_STATUSES)[number];

export const PO_STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  draft: "Szkic",
  ordered: "Zamówione",
  received: "Zrealizowane",
};

export const PurchaseOrderLineSchema = z.object({
  id: z.string(),
  productId: z.string(),
  quantity: z.number(),
  unitPrice: z.number(),
});
export type PurchaseOrderLine = z.infer<typeof PurchaseOrderLineSchema>;

export const PurchaseOrderSchema = z.object({
  id: z.string(),
  number: z.string(),
  supplierId: z.string(),
  /** Magazyn, na który trafi dostawa — z niego powstanie PZ. */
  warehouseId: z.string(),
  status: z.enum(PO_STATUSES),
  expectedDate: z.string(),
  notes: z.string().nullable(),
  lines: z.array(PurchaseOrderLineSchema),
  createdAt: z.string(),
  createdBy: z.string(),
  /** Id dokumentu PZ utworzonego przy przyjęciu dostawy. */
  receivedDocumentId: z.string().nullable(),
});
export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>;

export const CreatePurchaseOrderSchema = z.object({
  supplierId: z.string().min(1, "Wybierz dostawcę"),
  warehouseId: z.string().min(1, "Wybierz magazyn dostawy"),
  expectedDate: z.string().min(1, "Podaj oczekiwaną datę dostawy"),
  notes: z.string().nullable(),
  lines: z.array(
    z.object({
      productId: z.string().min(1, "Wybierz produkt"),
      quantity: z
        .number({ invalid_type_error: "Ilość musi być liczbą" })
        .positive("Ilość musi być większa od zera"),
      unitPrice: z
        .number({ invalid_type_error: "Cena musi być liczbą" })
        .nonnegative("Cena nie może być ujemna"),
    }),
  ),
});
export type CreatePurchaseOrderInput = z.infer<typeof CreatePurchaseOrderSchema>;

// ========================== ZAMÓWIENIA SPRZEDAŻY ===========================
// Lustro zamówień zakupu po stronie klienta. Realizacja tworzy szkic WZ
// zamiast PZ, a zamiast dostawcy figuruje odbiorca.

export const SO_STATUSES = ["draft", "confirmed", "fulfilled"] as const;
export type SalesOrderStatus = (typeof SO_STATUSES)[number];

export const SO_STATUS_LABELS: Record<SalesOrderStatus, string> = {
  draft: "Szkic",
  confirmed: "Potwierdzone",
  fulfilled: "Zrealizowane",
};

export const SalesOrderLineSchema = z.object({
  id: z.string(),
  productId: z.string(),
  quantity: z.number(),
  unitPrice: z.number(),
});
export type SalesOrderLine = z.infer<typeof SalesOrderLineSchema>;

export const SalesOrderSchema = z.object({
  id: z.string(),
  number: z.string(),
  customerId: z.string(),
  /** Magazyn, z którego towar zejdzie WZ-etką. */
  warehouseId: z.string(),
  status: z.enum(SO_STATUSES),
  expectedDate: z.string(),
  notes: z.string().nullable(),
  lines: z.array(SalesOrderLineSchema),
  createdAt: z.string(),
  createdBy: z.string(),
  /** Id dokumentu WZ utworzonego przy realizacji zamówienia. */
  issuedDocumentId: z.string().nullable(),
});
export type SalesOrder = z.infer<typeof SalesOrderSchema>;

export const CreateSalesOrderSchema = z.object({
  customerId: z.string().min(1, "Wybierz odbiorcę"),
  warehouseId: z.string().min(1, "Wybierz magazyn wydania"),
  expectedDate: z.string().min(1, "Podaj oczekiwaną datę realizacji"),
  notes: z.string().nullable(),
  lines: z.array(
    z.object({
      productId: z.string().min(1, "Wybierz produkt"),
      quantity: z
        .number({ invalid_type_error: "Ilość musi być liczbą" })
        .positive("Ilość musi być większa od zera"),
      unitPrice: z
        .number({ invalid_type_error: "Cena musi być liczbą" })
        .nonnegative("Cena nie może być ujemna"),
    }),
  ),
});
export type CreateSalesOrderInput = z.infer<typeof CreateSalesOrderSchema>;

// ============================ FAKTURA ZAKUPU ===============================
// Drugi dokument w module Zakupy. Rejestruje fakturę od dostawcy i pozwala
// powiązać ją z zamówieniem zakupu oraz przyjęciem PZ.

export const PI_STATUSES = ["draft", "booked"] as const;
export type PurchaseInvoiceStatus = (typeof PI_STATUSES)[number];

export const PI_STATUS_LABELS: Record<PurchaseInvoiceStatus, string> = {
  draft: "Szkic",
  booked: "Zaksięgowana",
};

export const PurchaseInvoiceLineSchema = z.object({
  id: z.string(),
  productId: z.string(),
  quantity: z.number(),
  unitPrice: z.number(),
  /** Stawka VAT w procentach: 23, 8, 5, 0. */
  vatRate: z.number(),
});
export type PurchaseInvoiceLine = z.infer<typeof PurchaseInvoiceLineSchema>;

export const PurchaseInvoiceSchema = z.object({
  id: z.string(),
  number: z.string(),
  supplierId: z.string(),
  /** Numer faktury nadany przez dostawcę. */
  externalNumber: z.string(),
  status: z.enum(PI_STATUSES),
  issueDate: z.string(),
  dueDate: z.string(),
  /** Opcjonalne powiązanie z zamówieniem zakupu. */
  purchaseOrderId: z.string().nullable(),
  notes: z.string().nullable(),
  lines: z.array(PurchaseInvoiceLineSchema),
  createdAt: z.string(),
  createdBy: z.string(),
});
export type PurchaseInvoice = z.infer<typeof PurchaseInvoiceSchema>;

export const CreatePurchaseInvoiceSchema = z.object({
  supplierId: z.string().min(1, "Wybierz dostawcę"),
  externalNumber: z.string().min(1, "Podaj numer faktury dostawcy"),
  issueDate: z.string().min(1, "Podaj datę wystawienia"),
  dueDate: z.string().min(1, "Podaj termin płatności"),
  purchaseOrderId: z.string().nullable(),
  notes: z.string().nullable(),
  lines: z.array(
    z.object({
      productId: z.string().min(1, "Wybierz produkt"),
      quantity: z
        .number({ invalid_type_error: "Ilość musi być liczbą" })
        .positive("Ilość musi być większa od zera"),
      unitPrice: z
        .number({ invalid_type_error: "Cena musi być liczbą" })
        .nonnegative("Cena nie może być ujemna"),
      vatRate: z.number(),
    }),
  ),
});
export type CreatePurchaseInvoiceInput = z.infer<typeof CreatePurchaseInvoiceSchema>;
