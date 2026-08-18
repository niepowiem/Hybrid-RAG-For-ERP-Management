/**
 * stock.ts — stany magazynowe i reguły zatwierdzania.
 *
 * Kluczowa decyzja: stan NIE jest przechowywany, tylko wyliczany z
 * zatwierdzonych dokumentów (PZ dodaje, WZ odejmuje, MM przesuwa).
 * Stan nigdy nie rozjedzie się z dokumentami, a zatwierdzenie jest czystą
 * funkcją, którą łatwo testować. Przy skali demo koszt wyliczania jest zerowy;
 * prawdziwy system robi to samo plus cache.
 */

import { AppError } from "@demo-erp/shared";
import type { Document, Role, StockLevel } from "@demo-erp/shared";
import { documents, products } from "./store.js";

/** Pełna mapa stanów: `${warehouseId}:${productId}` -> ilość. */
export function computeStock(): Map<string, number> {
  const stock = new Map<string, number>();
  const add = (wh: string | null, product: string, qty: number): void => {
    if (!wh) return;
    const key = `${wh}:${product}`;
    stock.set(key, (stock.get(key) ?? 0) + qty);
  };

  for (const doc of documents) {
    if (doc.status !== "confirmed") continue;
    for (const line of doc.lines) {
      add(doc.warehouseToId, line.productId, line.quantity);
      add(doc.warehouseFromId, line.productId, -line.quantity);
    }
  }
  return stock;
}

export function stockLevels(): StockLevel[] {
  const out: StockLevel[] = [];
  for (const [key, quantity] of computeStock()) {
    const [warehouseId, productId] = key.split(":") as [string, string];
    out.push({ warehouseId, productId, quantity });
  }
  return out;
}

/**
 * Waliduje zatwierdzenie dokumentu. Rzuca AppError; nic nie zapisuje —
 * zapis robi warstwa tras dopiero po przejściu wszystkich reguł.
 */
export function assertCanConfirm(doc: Document, role: Role): void {
  if (doc.status !== "draft") throw new AppError("ERR-1002", { documentNumber: doc.number });
  if (doc.lines.length === 0) throw new AppError("ERR-1003", { documentNumber: doc.number });

  if (doc.type === "MM" && role !== "kierownik") {
    throw new AppError("ERR-3001", { documentNumber: doc.number, role });
  }

  for (const line of doc.lines) {
    const product = products.find((p) => p.id === line.productId);
    if (!product || !product.active) {
      throw new AppError("ERR-1006", {
        documentNumber: doc.number,
        productId: line.productId,
        productName: product?.name ?? null,
      });
    }
  }

  // Dokumenty rozchodowe: sprawdź pokrycie w stanie źródłowym.
  if (doc.warehouseFromId) {
    const stock = computeStock();
    const shortages: Array<{ productId: string; productName: string; requested: number; available: number }> = [];

    for (const line of doc.lines) {
      const available = stock.get(`${doc.warehouseFromId}:${line.productId}`) ?? 0;
      if (line.quantity > available) {
        const product = products.find((p) => p.id === line.productId);
        shortages.push({
          productId: line.productId,
          productName: product?.name ?? line.productId,
          requested: line.quantity,
          available,
        });
      }
    }

    if (shortages.length > 0) {
      // details.shortages to konkret, który asystent zamieni na zdanie
      // "prosisz o 500 szt, a na MAG-GL jest 380".
      throw new AppError("ERR-1004", {
        documentNumber: doc.number,
        warehouseId: doc.warehouseFromId,
        shortages,
      });
    }
  }
}
