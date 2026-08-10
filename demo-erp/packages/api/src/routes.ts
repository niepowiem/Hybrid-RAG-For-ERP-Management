/**
 * routes.ts — endpointy REST.
 *
 * Kontrakt błędu jest stały: { code, message, details } z rejestru w shared.
 * Rola przychodzi w nagłówku x-user-role — w demo zamiast logowania; docelowo
 * to samo miejsce zajmuje token. Front i przyszły asystent widzą identyczny
 * kształt odpowiedzi.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AppError,
  CreateDocumentSchema,
  CreateLocationSchema,
  CreatePurchaseInvoiceSchema,
  CreatePurchaseOrderSchema,
  CreateSalesOrderSchema,
  DOC_TYPE_LABELS,
  ROLES,
  CreateCounterpartySchema,
  CreateProductSchema,
} from "@demo-erp/shared";
import type { ApiErrorBody, Document, Role } from "@demo-erp/shared";
import {
  counterparties,
  documents,
  nextDocNumber,
  nextId,
  products,
  purchaseInvoices,
  purchaseOrders,
  salesOrders,
  stocktakes,
  storageLocations,
  warehouses,
} from "./store.js";
import { assertCanConfirm, stockLevels } from "./stock.js";

function roleFrom(header: unknown): Role {
  const value = typeof header === "string" ? header : "";
  return (ROLES as readonly string[]).includes(value) ? (value as Role) : "magazynier";
}

export function registerRoutes(app: FastifyInstance): void {
  // Puste ciało przy content-type: application/json ma być poprawne.
  // Endpointy akcji (np. /confirm) nie przyjmują danych, a przeglądarki
  // i klienci HTTP chętnie dokładają ten nagłówek zawsze. Domyślnie Fastify
  // traktuje to jako błąd protokołu — tu świadomie łagodzimy.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      const raw = body as string;
      if (raw === "" || raw == null) return done(null, undefined);
      try {
        done(null, JSON.parse(raw));
      } catch (e) {
        done(e as Error, undefined);
      }
    },
  );

  // Jeden handler błędów dla wszystkiego. AppError -> kontrakt z rejestru,
  // ZodError -> 400 z listą pól, reszta -> 500 bez szczegółów na zewnątrz.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      const body: ApiErrorBody = {
        code: err.def.code,
        message: err.def.messageUser,
        details: err.details,
      };
      return reply.status(err.def.httpStatus).send(body);
    }
    if (err instanceof z.ZodError) {
      return reply.status(400).send({
        code: "VALIDATION",
        message: "Formularz zawiera błędy.",
        details: { issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      });
    }
    // Błędy z samego Fastify (zły content-type, puste ciało, 404 trasy) niosą
    // własny statusCode i kod. Wcześniej wpadały do worka "500 Błąd serwera",
    // co ukrywało prawdziwą przyczynę — nigdy nie zwracaj 500 dla czegoś,
    // co framework już poprawnie zaklasyfikował.
    const fastifyErr = err as { statusCode?: number; code?: string; message?: string };
    const status = typeof fastifyErr.statusCode === "number" ? fastifyErr.statusCode : 500;
    if (status < 500) {
      return reply.status(status).send({
        code: fastifyErr.code ?? "BAD_REQUEST",
        message: fastifyErr.message ?? "Nieprawidłowe żądanie.",
      });
    }

    app.log.error(err);
    return reply.status(500).send({
      code: "INTERNAL",
      message: "Błąd serwera.",
      details: { reason: fastifyErr.message },
    });
  });

  app.get("/api/products", async () => products);
  app.get("/api/warehouses", async () => warehouses);
  app.get("/api/counterparties", async () => counterparties);

  // ============================== KARTOTEKI ================================
  // Wzorzec jak przy lokalizacjach: tworzenie z kontrolą duplikatu, wyłączanie
  // przełącznikiem z blokadą, gdy rekord jest już użyty w obrocie.

  app.post("/api/products", async (req) => {
    const input = CreateProductSchema.parse(req.body);

    const duplikat = products.find(
        (p) => p.sku.toLowerCase() === input.sku.trim().toLowerCase(),
    );
    if (duplikat) {
      throw new AppError("ERR-8001", { sku: input.sku, existingProductId: duplikat.id });
    }

    const product = {
      id: nextId(),
      ...input,
      sku: input.sku.trim().toUpperCase(),
      name: input.name.trim(),
      active: true,
    };
    products.push(product);
    return product;
  });

  app.post("/api/products/:id/toggle", async (req) => {
    const { id } = req.params as { id: string };
    const product = products.find((p) => p.id === id);
    if (!product) throw new AppError("ERR-1001", { productId: id });

    if (product.active) {
      // Wycofanie tylko wtedy, gdy indeks nie występuje nigdzie w obrocie.
      const uzyty =
          documents.some((d) => d.lines.some((l) => l.productId === product.id)) ||
          purchaseOrders.some((o) => o.lines.some((l) => l.productId === product.id)) ||
          salesOrders.some((o) => o.lines.some((l) => l.productId === product.id)) ||
          purchaseInvoices.some((i) => i.lines.some((l) => l.productId === product.id)) ||
          stocktakes.some((s) => s.lines.some((l) => l.productId === product.id));

      if (uzyty) throw new AppError("ERR-8002", { sku: product.sku });
    }

    product.active = !product.active;
    return product;
  });

  app.post("/api/counterparties", async (req) => {
    const input = CreateCounterpartySchema.parse(req.body);

    const duplikat = counterparties.find(
        (c) => c.code.toLowerCase() === input.code.trim().toLowerCase(),
    );
    if (duplikat) {
      throw new AppError("ERR-8101", { code: input.code, existingCounterpartyId: duplikat.id });
    }

    const counterparty = {
      id: nextId(),
      ...input,
      code: input.code.trim().toUpperCase(),
      name: input.name.trim(),
      active: true,
    };
    counterparties.push(counterparty);
    return counterparty;
  });

  app.post("/api/counterparties/:id/toggle", async (req) => {
    const { id } = req.params as { id: string };
    const counterparty = counterparties.find((c) => c.id === id);
    if (!counterparty) throw new AppError("ERR-1001", { counterpartyId: id });

    if (counterparty.active) {
      const uzyty =
          documents.some((d) => d.counterpartyId === counterparty.id) ||
          purchaseOrders.some((o) => o.supplierId === counterparty.id) ||
          salesOrders.some((o) => o.customerId === counterparty.id) ||
          purchaseInvoices.some((i) => i.supplierId === counterparty.id);

      if (uzyty) throw new AppError("ERR-8102", { code: counterparty.code });
    }

    counterparty.active = !counterparty.active;
    return counterparty;
  });
  app.get("/api/stock", async () => stockLevels());

  app.get("/api/documents", async () =>
    [...documents].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );

  app.get("/api/documents/:id", async (req) => {
    const { id } = req.params as { id: string };
    const doc = documents.find((d) => d.id === id);
    if (!doc) throw new AppError("ERR-1001", { documentId: id });
    return doc;
  });

  app.post("/api/documents", async (req, reply) => {
    const input = CreateDocumentSchema.parse(req.body);

    if (input.type === "MM" && input.warehouseFromId === input.warehouseToId) {
      throw new AppError("ERR-1005");
    }
    for (const line of input.lines) {
      const product = products.find((p) => p.id === line.productId);
      if (!product || !product.active) {
        throw new AppError("ERR-1006", { productId: line.productId, productName: product?.name ?? null });
      }
    }

    const doc: Document = {
      id: nextId(),
      number: nextDocNumber(input.type),
      type: input.type,
      status: "draft",
      warehouseFromId: input.type === "PZ" ? null : input.warehouseFromId,
      warehouseToId: input.type === "WZ" ? null : input.warehouseToId,
      counterpartyId: input.type === "MM" ? null : input.counterpartyId,
      documentDate: input.documentDate,
      operationDate: input.operationDate,
      externalNumber: input.externalNumber,
      notes: input.notes,
      lines: input.lines.map((l) => ({ id: nextId(), ...l })),
      createdAt: new Date().toISOString(),
      createdBy: roleFrom(req.headers["x-user-role"]) === "kierownik" ? "mnowak" : "jkowalski",
      confirmedAt: null,
      confirmedBy: null,
    };
    documents.push(doc);
    return reply.status(201).send(doc);
  });

  app.put("/api/documents/:id", async (req) => {
    const { id } = req.params as { id: string };
    const doc = documents.find((d) => d.id === id);
    if (!doc) throw new AppError("ERR-1001", { documentId: id });
    if (doc.status !== "draft") throw new AppError("ERR-1002", { documentNumber: doc.number });

    const input = CreateDocumentSchema.parse(req.body);
    if (input.type === "MM" && input.warehouseFromId === input.warehouseToId) {
      throw new AppError("ERR-1005");
    }
    for (const line of input.lines) {
      const product = products.find((p) => p.id === line.productId);
      if (!product || !product.active) {
        throw new AppError("ERR-1006", { productId: line.productId, productName: product?.name ?? null });
      }
    }

    doc.type = input.type;
    doc.warehouseFromId = input.type === "PZ" ? null : input.warehouseFromId;
    doc.warehouseToId = input.type === "WZ" ? null : input.warehouseToId;
    doc.counterpartyId = input.type === "MM" ? null : input.counterpartyId;
    doc.documentDate = input.documentDate;
    doc.operationDate = input.operationDate;
    doc.externalNumber = input.externalNumber;
    doc.notes = input.notes;
    doc.lines = input.lines.map((l) => ({ id: nextId(), ...l }));
    return doc;
  });

  app.post("/api/documents/:id/confirm", async (req) => {
    const { id } = req.params as { id: string };
    const doc = documents.find((d) => d.id === id);
    if (!doc) throw new AppError("ERR-1001", { documentId: id });

    const role = roleFrom(req.headers["x-user-role"]);
    assertCanConfirm(doc, role);

    doc.status = "confirmed";
    doc.confirmedAt = new Date().toISOString();
    doc.confirmedBy = role === "kierownik" ? "mnowak" : "jkowalski";
    return doc;
  });


  // ============================ LOKALIZACJE ================================

  app.get("/api/locations", async () => storageLocations);

  app.post("/api/locations", async (req) => {
    const input = CreateLocationSchema.parse(req.body);
    const duplikat = storageLocations.find(
      (l) =>
        l.warehouseId === input.warehouseId &&
        l.code.toLowerCase() === input.code.toLowerCase(),
    );
    if (duplikat) {
      throw new AppError("ERR-6001", {
        code: input.code,
        warehouseId: input.warehouseId,
        existingLocationId: duplikat.id,
      });
    }
    const loc = { id: nextId(), ...input, active: true };
    storageLocations.push(loc);
    return loc;
  });

  app.post("/api/locations/:id/toggle", async (req) => {
    const { id } = req.params as { id: string };
    const loc = storageLocations.find((l) => l.id === id);
    if (!loc) throw new AppError("ERR-1001", { locationId: id });

    if (loc.active) {
      // Dezaktywacja tylko, gdy żadna pozycja dokumentu nie wskazuje kodu.
      const uzyta = documents.some(
        (d) =>
          (d.warehouseFromId === loc.warehouseId || d.warehouseToId === loc.warehouseId) &&
          d.lines.some((ln) => ln.location === loc.code),
      );
      if (uzyta) throw new AppError("ERR-6002", { code: loc.code });
    }
    loc.active = !loc.active;
    return loc;
  });

  // =========================== INWENTARYZACJA ==============================

  app.get("/api/stocktakes", async () =>
    [...stocktakes].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );

  app.get("/api/stocktakes/:id", async (req) => {
    const { id } = req.params as { id: string };
    const st = stocktakes.find((s) => s.id === id);
    if (!st) throw new AppError("ERR-1001", { stocktakeId: id });
    return st;
  });

  app.post("/api/stocktakes", async (req) => {
    const { warehouseId } = z
      .object({ warehouseId: z.string().min(1, "Wybierz magazyn") })
      .parse(req.body);

    const otwarta = stocktakes.find(
      (s) => s.warehouseId === warehouseId && s.status === "open",
    );
    if (otwarta) {
      throw new AppError("ERR-4001", { stocktakeNumber: otwarta.number });
    }

    // Snapshot stanu księgowego w chwili otwarcia — zamrożony, żeby dokumenty
    // zatwierdzane w trakcie liczenia nie przesuwały punktu odniesienia.
    const lines = stockLevels()
      .filter((s) => s.warehouseId === warehouseId && s.quantity !== 0)
      .map((s) => ({ productId: s.productId, expected: s.quantity, counted: null }));

    const st = {
      id: nextId(),
      number: nextDocNumber("INW"),
      warehouseId,
      status: "open" as const,
      lines,
      createdAt: new Date().toISOString(),
      createdBy: roleFrom(req.headers["x-user-role"]) === "kierownik" ? "mnowak" : "jkowalski",
      closedAt: null,
      closedBy: null,
    };
    stocktakes.push(st);
    return st;
  });

  app.post("/api/stocktakes/:id/count", async (req) => {
    const { id } = req.params as { id: string };
    const st = stocktakes.find((s) => s.id === id);
    if (!st) throw new AppError("ERR-1001", { stocktakeId: id });
    if (st.status === "closed") throw new AppError("ERR-4004", { stocktakeNumber: st.number });

    const input = z
      .object({
        productId: z.string().min(1),
        counted: z
          .number({ invalid_type_error: "Ilość musi być liczbą" })
          .nonnegative("Ilość nie może być ujemna"),
      })
      .parse(req.body);

    const line = st.lines.find((l) => l.productId === input.productId);
    if (!line) throw new AppError("ERR-2001", { productId: input.productId });
    line.counted = input.counted;
    return st;
  });

  app.post("/api/stocktakes/:id/close", async (req) => {
    const { id } = req.params as { id: string };
    const st = stocktakes.find((s) => s.id === id);
    if (!st) throw new AppError("ERR-1001", { stocktakeId: id });
    if (st.status === "closed") throw new AppError("ERR-4004", { stocktakeNumber: st.number });

    const role = roleFrom(req.headers["x-user-role"]);
    if (role !== "kierownik") {
      throw new AppError("ERR-4003", { stocktakeNumber: st.number, role });
    }

    const niepoliczone = st.lines.filter((l) => l.counted === null).length;
    if (niepoliczone > 0) {
      throw new AppError("ERR-4002", {
        stocktakeNumber: st.number,
        uncountedLines: niepoliczone,
      });
    }

    st.status = "closed";
    st.closedAt = new Date().toISOString();
    st.closedBy = "mnowak";
    return st;
  });

  // ========================== ZAMÓWIENIA ZAKUPU ============================

  app.get("/api/purchase-orders", async () =>
    [...purchaseOrders].sort((a, b) => b.number.localeCompare(a.number)),
  );

  app.get("/api/purchase-orders/:id", async (req) => {
    const { id } = req.params as { id: string };
    const po = purchaseOrders.find((o) => o.id === id);
    if (!po) throw new AppError("ERR-1001", { purchaseOrderId: id });
    return po;
  });

  app.post("/api/purchase-orders", async (req) => {
    const input = CreatePurchaseOrderSchema.parse(req.body);
    const po = {
      id: nextId(),
      number: nextDocNumber("ZZ"),
      supplierId: input.supplierId,
      warehouseId: input.warehouseId,
      status: "draft" as const,
      expectedDate: input.expectedDate,
      notes: input.notes,
      lines: input.lines.map((l) => ({ id: nextId(), ...l })),
      createdAt: new Date().toISOString(),
      createdBy: roleFrom(req.headers["x-user-role"]) === "kierownik" ? "mnowak" : "jkowalski",
      receivedDocumentId: null,
    };
    purchaseOrders.push(po);
    return po;
  });

  app.post("/api/purchase-orders/:id/send", async (req) => {
    const { id } = req.params as { id: string };
    const po = purchaseOrders.find((o) => o.id === id);
    if (!po) throw new AppError("ERR-1001", { purchaseOrderId: id });
    if (po.status !== "draft") {
      throw new AppError("ERR-5003", { number: po.number, status: po.status });
    }
    if (po.lines.length === 0) {
      throw new AppError("ERR-5001", { number: po.number });
    }
    const dostawca = counterparties.find((c) => c.id === po.supplierId);
    if (!dostawca || !dostawca.active) {
      throw new AppError("ERR-5002", { supplierId: po.supplierId });
    }
    po.status = "ordered";
    return po;
  });

  app.post("/api/purchase-orders/:id/receive", async (req) => {
    const { id } = req.params as { id: string };
    const po = purchaseOrders.find((o) => o.id === id);
    if (!po) throw new AppError("ERR-1001", { purchaseOrderId: id });
    if (po.status !== "ordered") {
      throw new AppError("ERR-5003", { number: po.number, status: po.status });
    }

    // Przyjęcie dostawy tworzy SZKIC dokumentu PZ — celowo szkic, nie
    // zatwierdzony: magazynier ma zweryfikować ilości z dostawą fizyczną,
    // zanim ruch trafi na stany. Numer zamówienia ląduje w polu Numer obcy.
    const doc: Document = {
      id: nextId(),
      number: nextDocNumber("PZ"),
      type: "PZ",
      status: "draft",
      warehouseFromId: null,
      warehouseToId: po.warehouseId,
      counterpartyId: po.supplierId,
      documentDate: new Date().toISOString().slice(0, 10),
      operationDate: new Date().toISOString().slice(0, 10),
      externalNumber: po.number,
      notes: `Dostawa z zamówienia ${po.number}.`,
      lines: po.lines.map((l) => ({
        id: nextId(),
        productId: l.productId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        location: null,
      })),
      createdAt: new Date().toISOString(),
      createdBy: roleFrom(req.headers["x-user-role"]) === "kierownik" ? "mnowak" : "jkowalski",
      confirmedAt: null,
      confirmedBy: null,
    };
    documents.unshift(doc);

    po.status = "received";
    po.receivedDocumentId = doc.id;
    return po;
  });


  // ========================= ZAMÓWIENIA SPRZEDAŻY ==========================

  app.get("/api/sales-orders", async () =>
    [...salesOrders].sort((a, b) => b.number.localeCompare(a.number)),
  );

  app.get("/api/sales-orders/:id", async (req) => {
    const { id } = req.params as { id: string };
    const so = salesOrders.find((o) => o.id === id);
    if (!so) throw new AppError("ERR-1001", { salesOrderId: id });
    return so;
  });

  app.post("/api/sales-orders", async (req) => {
    const input = CreateSalesOrderSchema.parse(req.body);
    const so = {
      id: nextId(),
      number: nextDocNumber("ZS"),
      customerId: input.customerId,
      warehouseId: input.warehouseId,
      status: "draft" as const,
      expectedDate: input.expectedDate,
      notes: input.notes,
      lines: input.lines.map((l) => ({ id: nextId(), ...l })),
      createdAt: new Date().toISOString(),
      createdBy: roleFrom(req.headers["x-user-role"]) === "kierownik" ? "mnowak" : "jkowalski",
      issuedDocumentId: null,
    };
    salesOrders.push(so);
    return so;
  });

  app.post("/api/sales-orders/:id/confirm", async (req) => {
    const { id } = req.params as { id: string };
    const so = salesOrders.find((o) => o.id === id);
    if (!so) throw new AppError("ERR-1001", { salesOrderId: id });
    if (so.status !== "draft") {
      throw new AppError("ERR-7003", { number: so.number, status: so.status });
    }
    if (so.lines.length === 0) {
      throw new AppError("ERR-7001", { number: so.number });
    }
    const odbiorca = counterparties.find((c) => c.id === so.customerId);
    if (!odbiorca || !odbiorca.active) {
      throw new AppError("ERR-7002", { customerId: so.customerId });
    }
    so.status = "confirmed";
    return so;
  });

  app.post("/api/sales-orders/:id/fulfil", async (req) => {
    const { id } = req.params as { id: string };
    const so = salesOrders.find((o) => o.id === id);
    if (!so) throw new AppError("ERR-1001", { salesOrderId: id });
    if (so.status !== "confirmed") {
      throw new AppError("ERR-7003", { number: so.number, status: so.status });
    }

    // Kontrola stanu przed realizacją — na magazynie wydania musi starczyć
    // towaru na każdą pozycję. Liczymy z bieżących stanów, bo mogły się
    // zmienić od potwierdzenia zamówienia.
    const stany = stockLevels();
    for (const l of so.lines) {
      const stan = stany.find(
        (s) => s.productId === l.productId && s.warehouseId === so.warehouseId,
      );
      if (!stan || stan.quantity < l.quantity) {
        throw new AppError("ERR-7004", {
          number: so.number,
          productId: l.productId,
          available: stan?.quantity ?? 0,
          required: l.quantity,
        });
      }
    }

    // Realizacja tworzy szkic WZ — lustro przyjęcia dostawy z modułu zakupów.
    const doc: Document = {
      id: nextId(),
      number: nextDocNumber("WZ"),
      type: "WZ",
      status: "draft",
      warehouseFromId: so.warehouseId,
      warehouseToId: null,
      counterpartyId: so.customerId,
      documentDate: new Date().toISOString().slice(0, 10),
      operationDate: new Date().toISOString().slice(0, 10),
      externalNumber: so.number,
      notes: `Wydanie z zamówienia sprzedaży ${so.number}.`,
      lines: so.lines.map((l) => ({
        id: nextId(),
        productId: l.productId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        location: null,
      })),
      createdAt: new Date().toISOString(),
      createdBy: roleFrom(req.headers["x-user-role"]) === "kierownik" ? "mnowak" : "jkowalski",
      confirmedAt: null,
      confirmedBy: null,
    };
    documents.unshift(doc);

    so.status = "fulfilled";
    so.issuedDocumentId = doc.id;
    return so;
  });

  // =========================== FAKTURY ZAKUPU ==============================

  app.get("/api/purchase-invoices", async () =>
    [...purchaseInvoices].sort((a, b) => b.number.localeCompare(a.number)),
  );

  app.get("/api/purchase-invoices/:id", async (req) => {
    const { id } = req.params as { id: string };
    const inv = purchaseInvoices.find((i) => i.id === id);
    if (!inv) throw new AppError("ERR-1001", { purchaseInvoiceId: id });
    return inv;
  });

  app.post("/api/purchase-invoices", async (req) => {
    const input = CreatePurchaseInvoiceSchema.parse(req.body);

    // Numer faktury musi być unikalny w obrębie dostawcy.
    const duplikat = purchaseInvoices.find(
      (i) =>
        i.supplierId === input.supplierId &&
        i.externalNumber.toLowerCase() === input.externalNumber.toLowerCase(),
    );
    if (duplikat) {
      throw new AppError("ERR-5201", {
        externalNumber: input.externalNumber,
        existingInvoiceId: duplikat.id,
      });
    }

    const inv = {
      id: nextId(),
      number: nextDocNumber("FZ"),
      supplierId: input.supplierId,
      externalNumber: input.externalNumber,
      status: "draft" as const,
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      purchaseOrderId: input.purchaseOrderId,
      notes: input.notes,
      lines: input.lines.map((l) => ({ id: nextId(), ...l })),
      createdAt: new Date().toISOString(),
      createdBy: roleFrom(req.headers["x-user-role"]) === "kierownik" ? "mnowak" : "jkowalski",
    };
    purchaseInvoices.push(inv);
    return inv;
  });

  app.post("/api/purchase-invoices/:id/book", async (req) => {
    const { id } = req.params as { id: string };
    const inv = purchaseInvoices.find((i) => i.id === id);
    if (!inv) throw new AppError("ERR-1001", { purchaseInvoiceId: id });
    if (inv.status === "booked") {
      throw new AppError("ERR-5202", { number: inv.number });
    }
    inv.status = "booked";
    return inv;
  });

  // Meta-endpoint pod przyszłego asystenta: słownik typów dokumentów.
  app.get("/api/meta/doc-types", async () => DOC_TYPE_LABELS);
}
