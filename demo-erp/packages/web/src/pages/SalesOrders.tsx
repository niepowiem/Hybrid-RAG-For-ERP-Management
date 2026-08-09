/**
 * SalesOrders.tsx — lista zamówień od klientów.
 *
 * Lustro PurchaseOrders: ten sam układ, ale odbiorca zamiast dostawcy
 * i realizacja tworzy WZ zamiast PZ.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { formatPLN, SO_STATUS_LABELS } from "@demo-erp/shared";
import type { Counterparty, SalesOrder, Warehouse } from "@demo-erp/shared";
import { api } from "../api.js";

/** Szkic neutralny, potwierdzone w toku, zrealizowane zamknięte. */
const BADGE: Record<SalesOrder["status"], string> = {
  draft: "inactive",
  confirmed: "draft",
  fulfilled: "confirmed",
};

export function SalesOrdersPage() {
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    void api.salesOrders().then(setOrders);
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

  const wartosc = (so: SalesOrder): number =>
    so.lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);

  return (
    <>
      <div className="toolbar">
        <div>
          <h1>Zamówienia sprzedaży</h1>
          <p className="page-sub">
            Zamówienia od klientów. Realizacja tworzy szkic dokumentu WZ.
          </p>
        </div>
        <div className="actions">
          <button
            className="sm primary"
            data-assistant-id="btn.so-new"
            onClick={() => navigate("/sales-orders/new")}
          >
            Nowe zamówienie
          </button>
        </div>
      </div>

      <table data-assistant-id="table.sales-orders">
        <thead>
          <tr>
            <th style={{ width: 140 }}>Numer</th>
            <th>Odbiorca</th>
            <th style={{ width: 100 }}>Magazyn</th>
            <th style={{ width: 120 }}>Realizacja do</th>
            <th className="num" style={{ width: 130 }}>Wartość netto</th>
            <th style={{ width: 130 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((so) => (
            <tr key={so.id}>
              <td className="mono">
                <Link to={`/sales-orders/${so.id}`}>{so.number}</Link>
              </td>
              <td>{cname.get(so.customerId) ?? so.customerId}</td>
              <td className="muted">{wname.get(so.warehouseId) ?? so.warehouseId}</td>
              <td className="muted">{so.expectedDate}</td>
              <td className="num mono">{formatPLN(wartosc(so))}</td>
              <td>
                <span className={`badge ${BADGE[so.status]}`}>
                  {SO_STATUS_LABELS[so.status]}
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
