/**
 * Stocktakes.tsx — lista arkuszy inwentaryzacji.
 *
 * "Nowa inwentaryzacja" tworzy arkusz od razu (snapshot stanów po stronie
 * API) i przenosi do detalu — nie ma osobnego formularza, bo jedyną decyzją
 * użytkownika jest wybór magazynu.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { STOCKTAKE_STATUS_LABELS } from "@demo-erp/shared";
import type { ApiErrorBody, Stocktake, Warehouse } from "@demo-erp/shared";
import { api, ApiError } from "../api.js";
import { ErrorBanner } from "../App.js";
import { notify } from "../ui.js";

const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString("pl-PL") : "—";

export function StocktakesPage() {
  const [stocktakes, setStocktakes] = useState<Stocktake[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState("");
  const [apiError, setApiError] = useState<ApiErrorBody | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    void api.stocktakes().then(setStocktakes);
    void api.warehouses().then(setWarehouses);
  }, []);

  const wname = useMemo(
    () => new Map(warehouses.map((w) => [w.id, w.code])),
    [warehouses],
  );

  async function rozpocznij(): Promise<void> {
    setBusy(true);
    setApiError(null);
    try {
      const st = await api.createStocktake(warehouseId);
      notify("Rozpoczęto inwentaryzację", st.number);
      navigate(`/stocktakes/${st.id}`);
    } catch (e) {
      if (e instanceof ApiError) {
        setApiError(e.body);
        notify("Nie rozpoczęto inwentaryzacji", e.body.code, "err");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="toolbar">
        <div>
          <h1>Inwentaryzacja</h1>
          <p className="page-sub">
            Arkusze spisu z natury. Stan księgowy jest zamrażany w chwili otwarcia arkusza.
          </p>
        </div>
        <div className="actions">
          <select
            data-assistant-id="field.stocktake-warehouse"
            aria-label="Magazyn do inwentaryzacji"
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
          >
            <option value="">— wybierz magazyn —</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
            ))}
          </select>
          <button
            className="sm primary"
            data-assistant-id="btn.stocktake-new"
            disabled={busy || !warehouseId}
            onClick={() => void rozpocznij()}
          >
            Nowa inwentaryzacja
          </button>
        </div>
      </div>

      <ErrorBanner error={apiError} />

      <table data-assistant-id="table.stocktakes">
        <thead>
          <tr>
            <th style={{ width: 150 }}>Numer</th>
            <th>Magazyn</th>
            <th style={{ width: 120 }}>Status</th>
            <th className="num" style={{ width: 120 }}>Policzono</th>
            <th style={{ width: 120 }}>Rozpoczęto</th>
            <th style={{ width: 120 }}>Zamknięto</th>
          </tr>
        </thead>
        <tbody>
          {stocktakes.map((st) => {
            const counted = st.lines.filter((l) => l.counted !== null).length;
            return (
              <tr key={st.id}>
                <td className="mono">
                  <Link to={`/stocktakes/${st.id}`}>{st.number}</Link>
                </td>
                <td className="muted">{wname.get(st.warehouseId) ?? st.warehouseId}</td>
                <td>
                  <span className={`badge ${st.status === "closed" ? "confirmed" : "draft"}`}>
                    {STOCKTAKE_STATUS_LABELS[st.status]}
                  </span>
                </td>
                <td className="num mono">{counted} / {st.lines.length}</td>
                <td className="muted">{fmtDate(st.createdAt)}</td>
                <td className="muted">{fmtDate(st.closedAt)}</td>
              </tr>
            );
          })}
          {stocktakes.length === 0 && (
            <tr><td colSpan={6} className="muted">Brak arkuszy. Wybierz magazyn i rozpocznij inwentaryzację.</td></tr>
          )}
        </tbody>
      </table>
    </>
  );
}
