/**
 * api.ts — cienki klient HTTP + obsługa błędów kontraktowych.
 *
 * ApiError niesie kod z rejestru — komponenty pokazują błąd jednym wspólnym
 * mechanizmem, a przyszły asystent dostanie ten sam kod w kontekście.
 */

import { zglosBlad } from "./assistant/context.js";
import type {
  ApiErrorBody,
  Counterparty,
  CreateDocumentInput,
  CreateLocationInput,
  CreatePurchaseInvoiceInput,
  CreatePurchaseOrderInput,
  CreateSalesOrderInput,
  Document,
  Product,
  PurchaseInvoice,
  PurchaseOrder,
  Role,
  SalesOrder,
  StockLevel,
  Stocktake,
  StorageLocation,
  Warehouse,
  CreateCounterpartyInput,
  CreateProductInput,
} from "@demo-erp/shared";

export class ApiError extends Error {
  constructor(readonly body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiError";
  }
}

/** Rola trzymana per zakładka; zmiana w nagłówku UI. */
let currentRole: Role = "magazynier";
export const getRole = (): Role => currentRole;
export const setRole = (r: Role): void => {
  currentRole = r;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Nagłówek content-type tylko wtedy, gdy faktycznie coś wysyłamy.
  // Zapowiedź JSON-a przy pustym ciele to dla Fastify błąd protokołu.
  const headers: Record<string, string> = {
    "x-user-role": currentRole,
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.body != null) headers["content-type"] = "application/json";

  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({
      code: "INTERNAL",
      message: "Błąd serwera.",
    }))) as ApiErrorBody;
    // Kod błędu trafia do sondy kontekstu — asystent go zobaczy.
    zglosBlad(body.code, body.message);
    throw new ApiError(body);
  }
  return res.json() as Promise<T>;
}

export const api = {
  products: () => request<Product[]>("/api/products"),
  createProduct: (input: CreateProductInput) =>
      request<Product>("/api/products", { method: "POST", body: JSON.stringify(input) }),
  toggleProduct: (id: string) =>
      request<Product>(`/api/products/${id}/toggle`, { method: "POST" }),
  warehouses: () => request<Warehouse[]>("/api/warehouses"),
  counterparties: () => request<Counterparty[]>("/api/counterparties"),
  createCounterparty: (input: CreateCounterpartyInput) =>
      request<Counterparty>("/api/counterparties", { method: "POST", body: JSON.stringify(input) }),
  toggleCounterparty: (id: string) =>
      request<Counterparty>(`/api/counterparties/${id}/toggle`, { method: "POST" }),
  stock: () => request<StockLevel[]>("/api/stock"),
  documents: () => request<Document[]>("/api/documents"),
  document: (id: string) => request<Document>(`/api/documents/${id}`),
  createDocument: (input: CreateDocumentInput) =>
    request<Document>("/api/documents", { method: "POST", body: JSON.stringify(input) }),
  updateDocument: (id: string, input: CreateDocumentInput) =>
    request<Document>(`/api/documents/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  confirmDocument: (id: string) =>
    request<Document>(`/api/documents/${id}/confirm`, { method: "POST" }),

  // Lokalizacje
  locations: () => request<StorageLocation[]>("/api/locations"),
  createLocation: (input: CreateLocationInput) =>
    request<StorageLocation>("/api/locations", { method: "POST", body: JSON.stringify(input) }),
  toggleLocation: (id: string) =>
    request<StorageLocation>(`/api/locations/${id}/toggle`, { method: "POST" }),

  // Inwentaryzacja
  stocktakes: () => request<Stocktake[]>("/api/stocktakes"),
  stocktake: (id: string) => request<Stocktake>(`/api/stocktakes/${id}`),
  createStocktake: (warehouseId: string) =>
    request<Stocktake>("/api/stocktakes", { method: "POST", body: JSON.stringify({ warehouseId }) }),
  countStocktake: (id: string, productId: string, counted: number) =>
    request<Stocktake>(`/api/stocktakes/${id}/count`, {
      method: "POST",
      body: JSON.stringify({ productId, counted }),
    }),
  closeStocktake: (id: string) =>
    request<Stocktake>(`/api/stocktakes/${id}/close`, { method: "POST" }),

  // Zamówienia zakupu
  purchaseOrders: () => request<PurchaseOrder[]>("/api/purchase-orders"),
  purchaseOrder: (id: string) => request<PurchaseOrder>(`/api/purchase-orders/${id}`),
  createPurchaseOrder: (input: CreatePurchaseOrderInput) =>
    request<PurchaseOrder>("/api/purchase-orders", { method: "POST", body: JSON.stringify(input) }),
  sendPurchaseOrder: (id: string) =>
    request<PurchaseOrder>(`/api/purchase-orders/${id}/send`, { method: "POST" }),
  receivePurchaseOrder: (id: string) =>
    request<PurchaseOrder>(`/api/purchase-orders/${id}/receive`, { method: "POST" }),

  // Zamówienia sprzedaży
  salesOrders: () => request<SalesOrder[]>("/api/sales-orders"),
  salesOrder: (id: string) => request<SalesOrder>(`/api/sales-orders/${id}`),
  createSalesOrder: (input: CreateSalesOrderInput) =>
    request<SalesOrder>("/api/sales-orders", { method: "POST", body: JSON.stringify(input) }),
  confirmSalesOrder: (id: string) =>
    request<SalesOrder>(`/api/sales-orders/${id}/confirm`, { method: "POST" }),
  fulfilSalesOrder: (id: string) =>
    request<SalesOrder>(`/api/sales-orders/${id}/fulfil`, { method: "POST" }),

  // Faktury zakupu
  purchaseInvoices: () => request<PurchaseInvoice[]>("/api/purchase-invoices"),
  purchaseInvoice: (id: string) => request<PurchaseInvoice>(`/api/purchase-invoices/${id}`),
  createPurchaseInvoice: (input: CreatePurchaseInvoiceInput) =>
    request<PurchaseInvoice>("/api/purchase-invoices", { method: "POST", body: JSON.stringify(input) }),
  bookPurchaseInvoice: (id: string) =>
    request<PurchaseInvoice>(`/api/purchase-invoices/${id}/book`, { method: "POST" }),
};
