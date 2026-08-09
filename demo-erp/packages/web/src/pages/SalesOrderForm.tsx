/**
 * SalesOrderForm.tsx — nowe zamówienie sprzedaży oraz podgląd istniejącego.
 *
 * Lustro PurchaseOrderForm: odbiorca zamiast dostawcy, WZ zamiast PZ.
 * Cykl: Szkic → Potwierdzone → Zrealizowane. Realizacja sprawdza stany
 * i prowadzi wprost do utworzonego szkicu WZ.
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { formatPLN, SO_STATUS_LABELS } from "@demo-erp/shared";
import type {
  ApiErrorBody,
  Counterparty,
  Product,
  SalesOrder,
  Warehouse,
} from "@demo-erp/shared";
import { api, ApiError } from "../api.js";
import { ErrorBanner } from "../App.js";
import { notify } from "../ui.js";

interface FormLine {
  key: number;
  productId: string;
  quantity: string;
  unitPrice: string;
}

let lineKey = 0;

/** Odznaka statusu: szkic neutralny, zamówione w toku, zrealizowane zamknięte. */
const BADGE: Record<SalesOrder["status"], string> = {
  draft: "inactive",
  confirmed: "draft",
  fulfilled: "confirmed",
};

export function SalesOrderFormPage() {
  const { id } = useParams();
  const isNew = id === undefined;
  const navigate = useNavigate();

  const [so, setSo] = useState<SalesOrder | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [apiError, setApiError] = useState<ApiErrorBody | null>(null);
  const [busy, setBusy] = useState(false);

  const [customerId, setCustomerId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<FormLine[]>([]);

  useEffect(() => {
    void api.products().then(setProducts);
    void api.counterparties().then(setCounterparties);
    void api.warehouses().then(setWarehouses);
    if (!isNew && id) {
      void api.salesOrder(id).then((o) => {
        setSo(o);
        setCustomerId(o.customerId);
        setWarehouseId(o.warehouseId);
        setExpectedDate(o.expectedDate);
        setNotes(o.notes ?? "");
        setLines(
          o.lines.map((l) => ({
            key: ++lineKey,
            productId: l.productId,
            quantity: String(l.quantity),
            unitPrice: String(l.unitPrice),
          })),
        );
      });
    }
  }, [id, isNew]);

  const pname = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const editable = isNew;

  const suma = lines.reduce(
    (s, l) => s + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0),
    0,
  );

  function dodajLinie(): void {
    setLines((ls) => [...ls, { key: ++lineKey, productId: "", quantity: "", unitPrice: "" }]);
  }
  function usunLinie(key: number): void {
    setLines((ls) => ls.filter((l) => l.key !== key));
  }
  function zmienLinie(key: number, patch: Partial<FormLine>): void {
    setLines((ls) =>
      ls.map((l) => {
        if (l.key !== key) return l;
        const next = { ...l, ...patch };
        if (patch.productId !== undefined) {
          const prod = pname.get(patch.productId);
          if (prod && next.unitPrice === "") next.unitPrice = String(prod.price);
        }
        return next;
      }),
    );
  }

  async function zapisz(): Promise<void> {
    setBusy(true);
    setApiError(null);
    try {
      const created = await api.createSalesOrder({
        customerId,
        warehouseId,
        expectedDate,
        notes: notes.trim() || null,
        lines: lines.map((l) => ({
          productId: l.productId,
          quantity: Number(l.quantity),
          unitPrice: Number(l.unitPrice),
        })),
      });
      notify("Zapisano zamówienie", created.number);
      navigate(`/sales-orders/${created.id}`);
    } catch (e) {
      if (e instanceof ApiError) {
        setApiError(e.body);
        notify("Nie zapisano zamówienia", e.body.code, "err");
      }
    } finally {
      setBusy(false);
    }
  }

  async function potwierdz(): Promise<void> {
    if (!so) return;
    setBusy(true);
    setApiError(null);
    try {
      const updated = await api.confirmSalesOrder(so.id);
      setSo(updated);
      notify("Potwierdzono zamówienie", updated.number);
    } catch (e) {
      if (e instanceof ApiError) {
        setApiError(e.body);
        notify("Nie potwierdzono zamówienia", e.body.code, "err");
      }
    } finally {
      setBusy(false);
    }
  }

  async function zrealizuj(): Promise<void> {
    if (!so) return;
    setBusy(true);
    setApiError(null);
    try {
      const updated = await api.fulfilSalesOrder(so.id);
      setSo(updated);
      notify("Zrealizowano zamówienie", "Utworzono szkic dokumentu WZ");
      if (updated.issuedDocumentId) navigate(`/documents/${updated.issuedDocumentId}`);
    } catch (e) {
      if (e instanceof ApiError) {
        setApiError(e.body);
        notify("Nie zrealizowano zamówienia", e.body.code, "err");
      }
    } finally {
      setBusy(false);
    }
  }

  if (!isNew && !so) return <p className="muted">Ładowanie zamówienia…</p>;

  return (
    <>
      <div className="toolbar">
        <div>
          <h1>{isNew ? "Nowe zamówienie sprzedaży" : so?.number}</h1>
          <p className="page-sub">
            {isNew ? (
              "Zamówienie od klienta. Po zapisaniu trafia do statusu Szkic."
            ) : (
              <>
                <span className={`badge ${so ? BADGE[so.status] : ""}`}>
                  {so ? SO_STATUS_LABELS[so.status] : ""}
                </span>
                {so?.issuedDocumentId && <> · wydanie utworzone dokumentem WZ</>}
              </>
            )}
          </p>
        </div>
        <div className="actions">
          <button className="sm ghost" onClick={() => navigate("/sales-orders")}>
            Wróć do listy
          </button>
        </div>
      </div>

      <ErrorBanner error={apiError} />

      <div className="card">
        <div className="section-title">Dane zamówienia</div>
        <div className="grid">
          <div className="f-row">
            <label htmlFor="so-cust">Odbiorca</label>
            <select
              id="so-cust"
              data-assistant-id="field.so-customer"
              value={customerId}
              disabled={!editable}
              onChange={(e) => setCustomerId(e.target.value)}
            >
              <option value="">— wybierz —</option>
              {counterparties
                .filter((c) => c.kind !== "supplier")
                .map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
            </select>
          </div>
          <div className="f-row">
            <label htmlFor="so-wh">Magazyn wydania</label>
            <select
              id="so-wh"
              data-assistant-id="field.so-warehouse"
              value={warehouseId}
              disabled={!editable}
              onChange={(e) => setWarehouseId(e.target.value)}
            >
              <option value="">— wybierz —</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
              ))}
            </select>
          </div>
          <div className="f-row">
            <label htmlFor="so-date">Realizacja do</label>
            <input
              id="so-date"
              data-assistant-id="field.so-expected-date"
              type="date"
              value={expectedDate}
              disabled={!editable}
              onChange={(e) => setExpectedDate(e.target.value)}
            />
          </div>
        </div>

        <div className="section-title" style={{ marginTop: 20 }}>Dodatkowe</div>
        <div className="grid two">
          <div className="f-row">
            <label htmlFor="so-notes">Uwagi</label>
            <textarea
              id="so-notes"
              data-assistant-id="field.so-notes"
              value={notes}
              disabled={!editable}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Widoczne na potwierdzeniu dla klienta"
            />
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-title">Pozycje</div>
        <table className="lines-table" data-assistant-id="table.so-lines">
          <thead>
            <tr>
              <th style={{ width: 34 }}>Lp.</th>
              <th>Produkt</th>
              <th style={{ width: 52 }}>J.m.</th>
              <th className="num" style={{ width: 110 }}>Ilość</th>
              <th className="num" style={{ width: 110 }}>Cena netto</th>
              <th className="num" style={{ width: 120 }}>Wartość</th>
              {editable && <th style={{ width: 60 }} />}
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const prod = pname.get(l.productId);
              const wart = (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0);
              return (
                <tr key={l.key}>
                  <td className="mono muted">{i + 1}</td>
                  <td>
                    {editable ? (
                      <select
                        data-assistant-id="field.so-line-product"
                        aria-label={`Produkt w pozycji ${i + 1}`}
                        value={l.productId}
                        onChange={(e) => zmienLinie(l.key, { productId: e.target.value })}
                      >
                        <option value="">— wybierz —</option>
                        {products.filter((p) => p.active).map((p) => (
                          <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>
                        ))}
                      </select>
                    ) : (
                      <>
                        <span className="mono">{prod?.sku}</span> {prod?.name}
                      </>
                    )}
                  </td>
                  <td className="muted">{prod?.unit ?? "—"}</td>
                  <td className="num">
                    {editable ? (
                      <input
                        data-assistant-id="field.so-line-quantity"
                        aria-label={`Ilość w pozycji ${i + 1}`}
                        type="number"
                        min={0}
                        value={l.quantity}
                        onChange={(e) => zmienLinie(l.key, { quantity: e.target.value })}
                      />
                    ) : (
                      <span className="mono">{l.quantity}</span>
                    )}
                  </td>
                  <td className="num">
                    {editable ? (
                      <input
                        data-assistant-id="field.so-line-price"
                        aria-label={`Cena w pozycji ${i + 1}`}
                        type="number"
                        min={0}
                        step="0.01"
                        value={l.unitPrice}
                        onChange={(e) => zmienLinie(l.key, { unitPrice: e.target.value })}
                      />
                    ) : (
                      <span className="mono">{formatPLN(Number(l.unitPrice))}</span>
                    )}
                  </td>
                  <td className="num mono">{formatPLN(wart)}</td>
                  {editable && (
                    <td className="num">
                      <button
                        className="sm ghost"
                        data-assistant-id="btn.so-line-remove"
                        onClick={() => usunLinie(l.key)}
                      >
                        Usuń
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
            {lines.length === 0 && (
              <tr>
                <td colSpan={editable ? 7 : 6} className="muted">
                  Brak pozycji. Dodaj produkt, żeby zamówienie dało się potwierdzić.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={editable ? 5 : 4}>Razem netto</td>
              <td className="num mono">{formatPLN(suma)}</td>
              {editable && <td />}
            </tr>
          </tfoot>
        </table>

        <div className="form-footer">
          {editable && (
            <>
              <button
                className="primary"
                data-assistant-id="btn.so-save"
                disabled={busy}
                onClick={() => void zapisz()}
              >
                Zapisz zamówienie
              </button>
              <button data-assistant-id="btn.so-line-add" onClick={dodajLinie}>
                Dodaj pozycję
              </button>
            </>
          )}
          {!isNew && so?.status === "draft" && (
            <button
              className="primary"
              data-assistant-id="btn.so-confirm"
              disabled={busy}
              onClick={() => void potwierdz()}
            >
              Potwierdź zamówienie
            </button>
          )}
          {!isNew && so?.status === "confirmed" && (
            <button
              className="primary"
              data-assistant-id="btn.so-fulfil"
              disabled={busy}
              onClick={() => void zrealizuj()}
            >
              Zrealizuj (utwórz WZ)
            </button>
          )}
          <span className="spacer" />
          {!isNew && so?.status === "fulfilled" && so.issuedDocumentId && (
            <button
              className="sm"
              onClick={() => navigate(`/documents/${so.issuedDocumentId}`)}
            >
              Pokaż dokument WZ
            </button>
          )}
        </div>
      </div>
    </>
  );
}
