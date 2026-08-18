/**
 * PurchaseInvoices.tsx — lista faktur od dostawców.
 *
 * Drugi dokument modułu Zakupy. Prosty cykl: Szkic → Zaksięgowana.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { formatPLN, PI_STATUS_LABELS } from "@demo-erp/shared";
import type { Counterparty, PurchaseInvoice } from "@demo-erp/shared";
import { api } from "../api.js";

/** Wartość brutto pozycji faktury (netto + VAT). */
function brutto(inv: PurchaseInvoice): number {
  return inv.lines.reduce(
    (sum, l) => sum + l.quantity * l.unitPrice * (1 + l.vatRate / 100),
    0,
  );
}

export function PurchaseInvoicesPage() {
  const [invoices, setInvoices] = useState<PurchaseInvoice[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    void api.purchaseInvoices().then(setInvoices);
    void api.counterparties().then(setCounterparties);
  }, []);

  const cname = useMemo(
    () => new Map(counterparties.map((c) => [c.id, c.name])),
    [counterparties],
  );

  return (
    <>
      <div className="toolbar">
        <div>
          <h1>Faktury zakupu</h1>
          <p className="page-sub">
            Faktury od dostawców, opcjonalnie powiązane z zamówieniem zakupu.
          </p>
        </div>
        <div className="actions">
          <button
            className="sm primary"
            data-assistant-id="btn.pi-new"
            onClick={() => navigate("/purchase-invoices/new")}
          >
            Nowa faktura
          </button>
        </div>
      </div>

      <table data-assistant-id="table.purchase-invoices">
        <thead>
          <tr>
            <th style={{ width: 140 }}>Numer</th>
            <th style={{ width: 160 }}>Nr dostawcy</th>
            <th>Dostawca</th>
            <th style={{ width: 140 }}>Termin płatności</th>
            <th className="num" style={{ width: 130 }}>Brutto</th>
            <th style={{ width: 130 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => (
            <tr key={inv.id}>
              <td className="mono">
                <Link to={`/purchase-invoices/${inv.id}`}>{inv.number}</Link>
              </td>
              <td className="mono muted">{inv.externalNumber}</td>
              <td>{cname.get(inv.supplierId) ?? inv.supplierId}</td>
              <td className="muted">{inv.dueDate}</td>
              <td className="num mono">{formatPLN(brutto(inv))}</td>
              <td>
                <span className={`badge ${inv.status === "booked" ? "confirmed" : "inactive"}`}>
                  {PI_STATUS_LABELS[inv.status]}
                </span>
              </td>
            </tr>
          ))}
          {invoices.length === 0 && (
            <tr><td colSpan={6} className="muted">Brak faktur. Zarejestruj pierwszą przyciskiem powyżej.</td></tr>
          )}
        </tbody>
      </table>
    </>
  );
}
