/**
 * PurchaseInvoiceForm.tsx — nowa faktura zakupu oraz podgląd istniejącej.
 *
 * Faktura może wskazywać zamówienie zakupu — wtedy dostawca i pozycje
 * wypełniają się automatycznie. To spina łańcuch: zamówienie ZZ,
 * przyjęcie towaru PZ, faktura FZ.
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { formatPLN, PI_STATUS_LABELS } from "@demo-erp/shared";
import type {
  ApiErrorBody,
  Counterparty,
  Product,
  PurchaseInvoice,
  PurchaseOrder,
} from "@demo-erp/shared";
import { api, ApiError } from "../api.js";
import { ErrorBanner } from "../App.js";
import { notify } from "../ui.js";

interface FormLine {
  key: number;
  productId: string;
  quantity: string;
  unitPrice: string;
  vatRate: string;
}

let lineKey = 0;
const VAT_STAWKI = ["23", "8", "5", "0"];

export function PurchaseInvoiceFormPage() {
  const { id } = useParams();
  const isNew = id === undefined;
  const navigate = useNavigate();

  const [inv, setInv] = useState<PurchaseInvoice | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [apiError, setApiError] = useState<ApiErrorBody | null>(null);
  const [busy, setBusy] = useState(false);

  const [supplierId, setSupplierId] = useState("");
  const [externalNumber, setExternalNumber] = useState("");
  const [issueDate, setIssueDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [purchaseOrderId, setPurchaseOrderId] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<FormLine[]>([]);

  useEffect(() => {
    void api.products().then(setProducts);
    void api.counterparties().then(setCounterparties);
    void api.purchaseOrders().then(setOrders);
    if (!isNew && id) {
      void api.purchaseInvoice(id).then((i) => {
        setInv(i);
        setSupplierId(i.supplierId);
        setExternalNumber(i.externalNumber);
        setIssueDate(i.issueDate);
        setDueDate(i.dueDate);
        setPurchaseOrderId(i.purchaseOrderId ?? "");
        setNotes(i.notes ?? "");
        setLines(
          i.lines.map((l) => ({
            key: ++lineKey,
            productId: l.productId,
            quantity: String(l.quantity),
            unitPrice: String(l.unitPrice),
            vatRate: String(l.vatRate),
          })),
        );
      });
    }
  }, [id, isNew]);

  const pname = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const editable = isNew;

  const sumy = lines.reduce(
    (acc, l) => {
      const netto = (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0);
      acc.netto += netto;
      acc.vat += netto * ((Number(l.vatRate) || 0) / 100);
      return acc;
    },
    { netto: 0, vat: 0 },
  );

  function dodajLinie(): void {
    setLines((ls) => [
      ...ls,
      { key: ++lineKey, productId: "", quantity: "", unitPrice: "", vatRate: "23" },
    ]);
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

  /** Wybór zamówienia wypełnia dostawcę i pozycje z tego zamówienia. */
  function wczytajZamowienie(poId: string): void {
    setPurchaseOrderId(poId);
    const po = orders.find((o) => o.id === poId);
    if (!po) return;
    setSupplierId(po.supplierId);
    setLines(
      po.lines.map((l) => ({
        key: ++lineKey,
        productId: l.productId,
        quantity: String(l.quantity),
        unitPrice: String(l.unitPrice),
        vatRate: "23",
      })),
    );
  }

  async function zapisz(): Promise<void> {
    setBusy(true);
    setApiError(null);
    try {
      const created = await api.createPurchaseInvoice({
        supplierId,
        externalNumber: externalNumber.trim(),
        issueDate,
        dueDate,
        purchaseOrderId: purchaseOrderId || null,
        notes: notes.trim() || null,
        lines: lines.map((l) => ({
          productId: l.productId,
          quantity: Number(l.quantity),
          unitPrice: Number(l.unitPrice),
          vatRate: Number(l.vatRate),
        })),
      });
      notify("Zapisano fakturę", created.number);
      navigate(`/purchase-invoices/${created.id}`);
    } catch (e) {
      if (e instanceof ApiError) {
        setApiError(e.body);
        notify("Nie zapisano faktury", e.body.code, "err");
      }
    } finally {
      setBusy(false);
    }
  }

  async function ksieguj(): Promise<void> {
    if (!inv) return;
    setBusy(true);
    setApiError(null);
    try {
      const updated = await api.bookPurchaseInvoice(inv.id);
      setInv(updated);
      notify("Zaksięgowano fakturę", updated.number);
    } catch (e) {
      if (e instanceof ApiError) {
        setApiError(e.body);
        notify("Nie zaksięgowano faktury", e.body.code, "err");
      }
    } finally {
      setBusy(false);
    }
  }

  if (!isNew && !inv) return <p className="muted">Ładowanie faktury…</p>;

  const zamowieniaDoWyboru = orders.filter((o) => o.status !== "draft");

  return (
    <>
      <div className="toolbar">
        <div>
          <h1>{isNew ? "Nowa faktura zakupu" : inv?.number}</h1>
          <p className="page-sub">
            {isNew ? (
              "Faktura od dostawcy. Po zapisaniu trafia do statusu Szkic."
            ) : (
              <>
                <span className={`badge ${inv?.status === "booked" ? "confirmed" : "inactive"}`}>
                  {inv ? PI_STATUS_LABELS[inv.status] : ""}
                </span>
                {inv?.externalNumber && (
                  <> · nr dostawcy <span className="mono">{inv.externalNumber}</span></>
                )}
              </>
            )}
          </p>
        </div>
        <div className="actions">
          <button className="sm ghost" onClick={() => navigate("/purchase-invoices")}>
            Wróć do listy
          </button>
        </div>
      </div>

      <ErrorBanner error={apiError} />

      <div className="card">
        <div className="section-title">Dane faktury</div>
        <div className="grid">
          <div className="f-row">
            <label htmlFor="pi-po">Zamówienie zakupu</label>
            <select
              id="pi-po"
              data-assistant-id="field.pi-purchase-order"
              value={purchaseOrderId}
              disabled={!editable}
              onChange={(e) => wczytajZamowienie(e.target.value)}
            >
              <option value="">— bez powiązania —</option>
              {zamowieniaDoWyboru.map((o) => (
                <option key={o.id} value={o.id}>{o.number}</option>
              ))}
            </select>
            <div className="hint">Wypełnia dostawcę i pozycje automatycznie</div>
          </div>
          <div className="f-row">
            <label htmlFor="pi-sup">Dostawca</label>
            <select
              id="pi-sup"
              data-assistant-id="field.pi-supplier"
              value={supplierId}
              disabled={!editable}
              onChange={(e) => setSupplierId(e.target.value)}
            >
              <option value="">— wybierz —</option>
              {counterparties
                .filter((c) => c.kind !== "customer")
                .map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
            </select>
          </div>
          <div className="f-row">
            <label htmlFor="pi-extno">Numer faktury dostawcy</label>
            <input
              id="pi-extno"
              data-assistant-id="field.pi-external-number"
              placeholder="np. FV 2026/08/114"
              value={externalNumber}
              disabled={!editable}
              onChange={(e) => setExternalNumber(e.target.value)}
            />
            <div className="hint">Unikalny w obrębie dostawcy</div>
          </div>
        </div>

        <div className="section-title" style={{ marginTop: 20 }}>Terminy</div>
        <div className="grid">
          <div className="f-row">
            <label htmlFor="pi-issue">Data wystawienia</label>
            <input
              id="pi-issue"
              data-assistant-id="field.pi-issue-date"
              type="date"
              value={issueDate}
              disabled={!editable}
              onChange={(e) => setIssueDate(e.target.value)}
            />
          </div>
          <div className="f-row">
            <label htmlFor="pi-due">Termin płatności</label>
            <input
              id="pi-due"
              data-assistant-id="field.pi-due-date"
              type="date"
              value={dueDate}
              disabled={!editable}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
          <div className="f-row">
            <label htmlFor="pi-notes">Uwagi</label>
            <input
              id="pi-notes"
              data-assistant-id="field.pi-notes"
              value={notes}
              disabled={!editable}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-title">Pozycje</div>
        <table className="lines-table" data-assistant-id="table.pi-lines">
          <thead>
            <tr>
              <th style={{ width: 34 }}>Lp.</th>
              <th>Produkt</th>
              <th className="num" style={{ width: 100 }}>Ilość</th>
              <th className="num" style={{ width: 110 }}>Cena netto</th>
              <th className="num" style={{ width: 80 }}>VAT</th>
              <th className="num" style={{ width: 120 }}>Wartość netto</th>
              {editable && <th style={{ width: 60 }} />}
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const prod = pname.get(l.productId);
              const netto = (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0);
              return (
                <tr key={l.key}>
                  <td className="mono muted">{i + 1}</td>
                  <td>
                    {editable ? (
                      <select
                        data-assistant-id="field.pi-line-product"
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
                  <td className="num">
                    {editable ? (
                      <input
                        data-assistant-id="field.pi-line-quantity"
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
                        data-assistant-id="field.pi-line-price"
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
                  <td className="num">
                    {editable ? (
                      <select
                        data-assistant-id="field.pi-line-vat"
                        aria-label={`Stawka VAT w pozycji ${i + 1}`}
                        value={l.vatRate}
                        onChange={(e) => zmienLinie(l.key, { vatRate: e.target.value })}
                      >
                        {VAT_STAWKI.map((v) => (
                          <option key={v} value={v}>{v}%</option>
                        ))}
                      </select>
                    ) : (
                      <span className="mono">{l.vatRate}%</span>
                    )}
                  </td>
                  <td className="num mono">{formatPLN(netto)}</td>
                  {editable && (
                    <td className="num">
                      <button
                        className="sm ghost"
                        data-assistant-id="btn.pi-line-remove"
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
                  Brak pozycji. Wybierz zamówienie zakupu albo dodaj pozycje ręcznie.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="form-footer">
          {editable && (
            <>
              <button
                className="primary"
                data-assistant-id="btn.pi-save"
                disabled={busy}
                onClick={() => void zapisz()}
              >
                Zapisz fakturę
              </button>
              <button data-assistant-id="btn.pi-line-add" onClick={dodajLinie}>
                Dodaj pozycję
              </button>
            </>
          )}
          {!isNew && inv?.status === "draft" && (
            <button
              className="primary"
              data-assistant-id="btn.pi-book"
              disabled={busy}
              onClick={() => void ksieguj()}
            >
              Zaksięguj
            </button>
          )}
          <span className="spacer" />
          <div className="totals">
            <div className="row"><span>Netto</span><span className="mono">{formatPLN(sumy.netto)}</span></div>
            <div className="row"><span>VAT</span><span className="mono">{formatPLN(sumy.vat)}</span></div>
            <div className="row sum"><span>Brutto</span><span className="mono">{formatPLN(sumy.netto + sumy.vat)}</span></div>
          </div>
        </div>
      </div>
    </>
  );
}
