/**
 * store.ts — dane w pamięci procesu.
 *
 * Świadoma decyzja dla demo: baza danych nic by tu nie pokazała, a dodałaby
 * zależność. Restart procesu przywraca dane startowe — przy demo to zaleta:
 * każda próba generalna zaczyna od tego samego stanu.
 */

import type {
  Counterparty,
  Document,
  Product,
  PurchaseInvoice,
  PurchaseOrder,
  SalesOrder,
  Stocktake,
  StorageLocation,
  Warehouse,
} from "@demo-erp/shared";

let seq = 0;
export const nextId = (): string => `id-${++seq}`;

const docCounters: Record<string, number> = {};
export function nextDocNumber(type: string): string {
  docCounters[type] = (docCounters[type] ?? 0) + 1;
  return `${type}-2026-${String(docCounters[type]).padStart(4, "0")}`;
}

export const products: Product[] = [
  { id: "p-1", sku: "SR-M8-100", name: "Śruba M8 x 100 DIN 933", unit: "szt", minStock: 500, price: 0.42, category: "Złączne", active: true },
  { id: "p-2", sku: "NK-M8", name: "Nakrętka M8 DIN 934", unit: "szt", minStock: 500, price: 0.18, category: "Złączne", active: true },
  { id: "p-3", sku: "PL-ST-2MM", name: "Blacha stalowa S235 2 mm", unit: "kg", minStock: 100, price: 6.9, category: "Materiały", active: true },
  { id: "p-4", sku: "KB-3X1.5", name: "Kabel YDY 3x1,5 mm²", unit: "m", minStock: 200, price: 4.15, category: "Elektryka", active: true },
  { id: "p-5", sku: "FR-D40", name: "Filtr powietrza D40", unit: "szt", minStock: 20, price: 87.0, category: "Części zamienne", active: true },
  { id: "p-6", sku: "OL-HYD-46", name: "Olej hydrauliczny HL-46", unit: "l", minStock: 60, price: 12.4, category: "Eksploatacyjne", active: false },
  { id: "p-7", sku: "LZ-6204", name: "Łożysko kulkowe 6204-2RS", unit: "szt", minStock: 40, price: 23.5, category: "Części zamienne", active: true },
  { id: "p-8", sku: "US-30X3", name: "Uszczelka gumowa 30x3", unit: "szt", minStock: 150, price: 1.85, category: "Części zamienne", active: true },
  { id: "p-9", sku: "PR-RAL9005", name: "Farba proszkowa RAL 9005", unit: "kg", minStock: 25, price: 34.9, category: "Materiały", active: true },
  { id: "p-10", sku: "RK-16A", name: "Rękawice robocze rozm. 10", unit: "par", minStock: 80, price: 5.6, category: "BHP", active: true },
];

export const warehouses: Warehouse[] = [
  { id: "w-1", code: "MAG-GL", name: "Magazyn główny" },
  { id: "w-2", code: "MAG-PR", name: "Magazyn produkcji" },
];

export const counterparties: Counterparty[] = [
  { id: "c-1", code: "DOS-001", name: "Stalmex Sp. z o.o.", taxId: "7010234567", city: "Katowice", kind: "supplier", active: true },
  { id: "c-2", code: "DOS-002", name: "Elektro-Hurt S.A.", taxId: "5252345678", city: "Warszawa", kind: "supplier", active: true },
  { id: "c-3", code: "ODB-001", name: "Zakład Mechaniczny Nowak", taxId: "6431234567", city: "Gliwice", kind: "customer", active: true },
  { id: "c-4", code: "ODB-002", name: "PPHU Technoserwis", taxId: "9542345678", city: "Kraków", kind: "customer", active: true },
  { id: "c-5", code: "KON-001", name: "Metalpol Handel", taxId: "8121234567", city: "Radom", kind: "both", active: true },
];

const line = (productId: string, quantity: number, unitPrice: number, location: string | null = null) => ({
  id: nextId(),
  productId,
  quantity,
  unitPrice,
  location,
});

export const documents: Document[] = [
  {
    id: "d-1", number: nextDocNumber("PZ"), type: "PZ", status: "confirmed",
    warehouseFromId: null, warehouseToId: "w-1", counterpartyId: "c-1",
    documentDate: "2026-07-01", operationDate: "2026-07-01",
    externalNumber: "FV/2026/07/118", notes: null,
    lines: [line("p-1", 1200, 0.4, "A-01"), line("p-2", 1500, 0.17, "A-02"), line("p-3", 350, 6.75, "B-04")],
    createdAt: "2026-07-01T08:00:00Z", createdBy: "jkowalski",
    confirmedAt: "2026-07-01T08:15:00Z", confirmedBy: "jkowalski",
  },
  {
    id: "d-2", number: nextDocNumber("PZ"), type: "PZ", status: "confirmed",
    warehouseFromId: null, warehouseToId: "w-2", counterpartyId: "c-2",
    documentDate: "2026-07-03", operationDate: "2026-07-03",
    externalNumber: "FS 4412/26", notes: "Dostawa częściowa, reszta w kolejnym tygodniu.",
    lines: [line("p-4", 400, 4.05, "C-11"), line("p-5", 25, 85.0, "C-12"), line("p-7", 60, 22.9, "C-13")],
    createdAt: "2026-07-03T10:00:00Z", createdBy: "jkowalski",
    confirmedAt: "2026-07-03T10:05:00Z", confirmedBy: "mnowak",
  },
  {
    id: "d-3", number: nextDocNumber("PZ"), type: "PZ", status: "confirmed",
    warehouseFromId: null, warehouseToId: "w-1", counterpartyId: "c-5",
    documentDate: "2026-07-08", operationDate: "2026-07-08",
    externalNumber: "MP/1204", notes: null,
    lines: [line("p-8", 300, 1.72, "A-07"), line("p-9", 40, 33.5, "D-01"), line("p-10", 120, 5.2, "E-02")],
    createdAt: "2026-07-08T07:40:00Z", createdBy: "jkowalski",
    confirmedAt: "2026-07-08T07:55:00Z", confirmedBy: "jkowalski",
  },
  {
    id: "d-4", number: nextDocNumber("WZ"), type: "WZ", status: "confirmed",
    warehouseFromId: "w-1", warehouseToId: null, counterpartyId: "c-3",
    documentDate: "2026-07-10", operationDate: "2026-07-10",
    externalNumber: null, notes: null,
    lines: [line("p-1", 300, 0.42, "A-01"), line("p-8", 80, 1.85, "A-07")],
    createdAt: "2026-07-10T12:00:00Z", createdBy: "jkowalski",
    confirmedAt: "2026-07-10T12:30:00Z", confirmedBy: "jkowalski",
  },
  {
    id: "d-5", number: nextDocNumber("WZ"), type: "WZ", status: "confirmed",
    warehouseFromId: "w-2", warehouseToId: null, counterpartyId: "c-4",
    documentDate: "2026-07-18", operationDate: "2026-07-19",
    externalNumber: "ZAM/882", notes: null,
    lines: [line("p-4", 150, 4.15, "C-11"), line("p-7", 12, 23.5, "C-13")],
    createdAt: "2026-07-18T14:20:00Z", createdBy: "mnowak",
    confirmedAt: "2026-07-19T08:10:00Z", confirmedBy: "mnowak",
  },
  {
    id: "d-6", number: nextDocNumber("MM"), type: "MM", status: "confirmed",
    warehouseFromId: "w-1", warehouseToId: "w-2", counterpartyId: null,
    documentDate: "2026-07-22", operationDate: "2026-07-22",
    externalNumber: null, notes: "Uzupełnienie stanu na linii montażowej.",
    lines: [line("p-3", 120, 6.9, "B-04")],
    createdAt: "2026-07-22T09:15:00Z", createdBy: "jkowalski",
    confirmedAt: "2026-07-22T11:00:00Z", confirmedBy: "mnowak",
  },
  {
    id: "d-7", number: nextDocNumber("MM"), type: "MM", status: "draft",
    warehouseFromId: "w-1", warehouseToId: "w-2", counterpartyId: null,
    documentDate: "2026-07-28", operationDate: "2026-07-28",
    externalNumber: null, notes: null,
    lines: [line("p-2", 200, 0.18, "A-02")],
    createdAt: "2026-07-28T09:00:00Z", createdBy: "jkowalski",
    confirmedAt: null, confirmedBy: null,
  },
  {
    id: "d-8", number: nextDocNumber("WZ"), type: "WZ", status: "draft",
    warehouseFromId: "w-1", warehouseToId: null, counterpartyId: "c-3",
    documentDate: "2026-07-30", operationDate: "2026-07-30",
    externalNumber: null, notes: null,
    lines: [line("p-10", 40, 5.6, "E-02")],
    createdAt: "2026-07-30T13:05:00Z", createdBy: "mnowak",
    confirmedAt: null, confirmedBy: null,
  },
];

// ------------------------------ lokalizacje --------------------------------
// Kody pokrywają się z lokalizacjami użytymi na pozycjach dokumentów wyżej —
// dzięki temu dezaktywacja A-01 faktycznie trafi w blokadę ERR-6002.

export const storageLocations: StorageLocation[] = [
  { id: "loc-1", warehouseId: "w-1", code: "A-01", description: "Regał A, poziom 1 — złączne", capacity: 5000, active: true },
  { id: "loc-2", warehouseId: "w-1", code: "A-02", description: "Regał A, poziom 2 — złączne", capacity: 5000, active: true },
  { id: "loc-3", warehouseId: "w-1", code: "A-07", description: "Regał A, poziom 7 — uszczelki", capacity: 2000, active: true },
  { id: "loc-4", warehouseId: "w-1", code: "B-04", description: "Regał B — materiały hutnicze", capacity: 1500, active: true },
  { id: "loc-5", warehouseId: "w-1", code: "D-01", description: "Strefa farb i chemii", capacity: 400, active: true },
  { id: "loc-6", warehouseId: "w-1", code: "E-02", description: "Strefa BHP", capacity: 800, active: true },
  { id: "loc-7", warehouseId: "w-1", code: "E-09", description: "Wycofana — remont posadzki", capacity: 0, active: false },
  { id: "loc-8", warehouseId: "w-2", code: "C-11", description: "Linia montażowa — elektryka", capacity: 900, active: true },
  { id: "loc-9", warehouseId: "w-2", code: "C-12", description: "Linia montażowa — filtry", capacity: 200, active: true },
  { id: "loc-10", warehouseId: "w-2", code: "C-13", description: "Linia montażowa — łożyska", capacity: 300, active: true },
];

// ----------------------------- inwentaryzacje ------------------------------
// Jedna zamknięta z historii: pokazuje na liście, jak wygląda ukończony
// arkusz, i daje asystentowi realny przykład różnicy inwentaryzacyjnej.

export const stocktakes: Stocktake[] = [
  {
    id: "st-1",
    number: nextDocNumber("INW"),
    warehouseId: "w-2",
    status: "closed",
    lines: [
      { productId: "p-3", expected: 120, counted: 120 },
      { productId: "p-4", expected: 250, counted: 250 },
      { productId: "p-5", expected: 25, counted: 25 },
      { productId: "p-7", expected: 48, counted: 47 },
    ],
    createdAt: "2026-07-25T06:30:00Z",
    createdBy: "jkowalski",
    closedAt: "2026-07-25T13:45:00Z",
    closedBy: "mnowak",
  },
];

// --------------------------- zamówienia zakupu -----------------------------

export const purchaseOrders: PurchaseOrder[] = [
  {
    id: "po-1",
    number: nextDocNumber("ZZ"),
    supplierId: "c-1",
    warehouseId: "w-1",
    status: "ordered",
    expectedDate: "2026-08-08",
    notes: "Uzupełnienie złącznych przed przeglądem linii.",
    lines: [
      { id: nextId(), productId: "p-1", quantity: 2000, unitPrice: 0.4 },
      { id: nextId(), productId: "p-2", quantity: 2000, unitPrice: 0.17 },
    ],
    createdAt: "2026-07-29T09:10:00Z",
    createdBy: "mnowak",
    receivedDocumentId: null,
  },
  {
    id: "po-2",
    number: nextDocNumber("ZZ"),
    supplierId: "c-2",
    warehouseId: "w-2",
    status: "draft",
    expectedDate: "2026-08-15",
    notes: null,
    lines: [{ id: nextId(), productId: "p-4", quantity: 300, unitPrice: 4.05 }],
    createdAt: "2026-08-01T11:00:00Z",
    createdBy: "jkowalski",
    receivedDocumentId: null,
  },
];

// -------------------------- zamówienia sprzedaży ---------------------------

export const salesOrders: SalesOrder[] = [
  {
    id: "so-1",
    number: nextDocNumber("ZS"),
    customerId: "c-3",
    warehouseId: "w-1",
    status: "confirmed",
    expectedDate: "2026-08-12",
    notes: "Odbiór własny klienta, rampa 2.",
    lines: [
      { id: nextId(), productId: "p-1", quantity: 400, unitPrice: 0.75 },
      { id: nextId(), productId: "p-3", quantity: 30, unitPrice: 8.2 },
    ],
    createdAt: "2026-07-30T08:15:00Z",
    createdBy: "jkowalski",
    issuedDocumentId: null,
  },
  {
    id: "so-2",
    number: nextDocNumber("ZS"),
    customerId: "c-4",
    warehouseId: "w-1",
    status: "draft",
    expectedDate: "2026-08-18",
    notes: null,
    lines: [{ id: nextId(), productId: "p-6", quantity: 12, unitPrice: 41.0 }],
    createdAt: "2026-08-02T10:40:00Z",
    createdBy: "jkowalski",
    issuedDocumentId: null,
  },
];

// ---------------------------- faktury zakupu -------------------------------

export const purchaseInvoices: PurchaseInvoice[] = [
  {
    id: "pi-1",
    number: nextDocNumber("FZ"),
    supplierId: "c-1",
    externalNumber: "FV 2026/07/218",
    status: "booked",
    issueDate: "2026-07-28",
    dueDate: "2026-08-11",
    purchaseOrderId: "po-1",
    notes: "Faktura do zamówienia ZZ-2026-0001.",
    lines: [
      { id: nextId(), productId: "p-1", quantity: 2000, unitPrice: 0.4, vatRate: 23 },
      { id: nextId(), productId: "p-2", quantity: 2000, unitPrice: 0.17, vatRate: 23 },
    ],
    createdAt: "2026-07-28T14:00:00Z",
    createdBy: "mnowak",
  },
];
