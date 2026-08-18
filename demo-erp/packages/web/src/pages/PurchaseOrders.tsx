/**
 * PurchaseOrders.tsx — lista zamówień do dostawców.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { formatPLN, PO_STATUS_LABELS } from "@demo-erp/shared";
import type { Counterparty, PurchaseOrder, Warehouse } from "@demo-erp/shared";
import { api } from "../api.js";

/** Szkic neutralny, zamówione w toku, zrealizowane zamknięte — trzy
 *  rozróżnialne wyglądy, nie dwa. */
const BADGE: Record<PurchaseOrder["status"], string> = {
  draft: "inactive",
  ordered: "draft",
  received: "confirmed",
};

export function PurchaseOrdersPage() {
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    void api.purchaseOrders().then(setOrders);
    void api.counterparties().then(setCounterparties);
    void api.warehouses().then(setWarehouses);
  }, []);

  const cname = useMemo(
    () => new Map(counterparties.map((c) => [c.id, c.name])),
    [counterparties],
  );
  const wname = useMemo(
    () => new Map(warehouses.map((w) => [w.id, w.code])),
    [warehouses],
  );

  const wartosc = (po: PurchaseOrder): number =>
    po.lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);

  return (
    <>
      <div className="toolbar">
        <div>
          <h1>Zamówienia zakupu</h1>
          <p className="page-sub">
            Zamówienia do dostawców. Przyjęcie dostawy tworzy szkic dokumentu PZ.
          </p>
        </div>
        <div className="actions">
          <button
            className="sm primary"
            data-assistant-id="btn.po-new"
            onClick={() => navigate("/purchase-orders/new")}
          >
            Nowe zamówienie
          </button>
        </div>
      </div>

      <table data-assistant-id="table.purchase-orders">
        <thead>
          <tr>
            <th style={{ width: 140 }}>Numer</th>
            <th>Dostawca</th>
            <th style={{ width: 100 }}>Magazyn</th>
            <th style={{ width: 120 }}>Dostawa do</th>
            <th className="num" style={{ width: 130 }}>Wartość netto</th>
            <th style={{ width: 130 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((po) => (
            <tr key={po.id}>
              <td className="mono">
                <Link to={`/purchase-orders/${po.id}`}>{po.number}</Link>
              </td>
              <td>{cname.get(po.supplierId) ?? po.supplierId}</td>
              <td className="muted">{wname.get(po.warehouseId) ?? po.warehouseId}</td>
              <td className="muted">{po.expectedDate}</td>
              <td className="num mono">{formatPLN(wartosc(po))}</td>
              <td>
                <span className={`badge ${BADGE[po.status]}`}>
                  {PO_STATUS_LABELS[po.status]}
                </span>
              </td>
            </tr>
          ))}
          {orders.length === 0 && (
            <tr><td colSpan={6} className="muted">Brak zamówień. Utwórz pierwsze przyciskiem powyżej.</td></tr>
          )}
        </tbody>
      </table>
    </>
  );
}
