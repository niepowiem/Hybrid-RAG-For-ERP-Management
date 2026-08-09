/**
 * StocktakeDetail.tsx — arkusz liczenia.
 *
 * Zapis liczenia dzieje się przy opuszczeniu pola (onBlur), nie przy każdym
 * znaku — jedna pozycja to jeden zapis, a użytkownik przechodzi Tabem
 * przez kolejne wiersze.
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { STOCKTAKE_STATUS_LABELS } from "@demo-erp/shared";
import type { ApiErrorBody, Product, Stocktake, Warehouse } from "@demo-erp/shared";
import { api, ApiError } from "../api.js";
import { ErrorBanner } from "../App.js";
import { notify } from "../ui.js";

export function StocktakeDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [st, setSt] = useState<Stocktake | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [apiError, setApiError] = useState<ApiErrorBody | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.stocktake(id).then(setSt).catch(() => setSt(null));
    void api.products().then(setProducts);
    void api.warehouses().then(setWarehouses);
  }, [id]);

  const pname = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const wname = useMemo(() => new Map(warehouses.map((w) => [w.id, w.code])), [warehouses]);

  if (!st) return <p className="muted">Ładowanie arkusza…</p>;

  const readOnly = st.status === "closed";
  const counted = st.lines.filter((l) => l.counted !== null).length;
  const roznice = st.lines.filter(
    (l) => l.counted !== null && l.counted !== l.expected,
  ).length;

  async function zapiszLiczenie(productId: string, raw: string): Promise<void> {
    if (raw.trim() === "") return;
    setApiError(null);
    try {
      const updated = await api.countStocktake(id, productId, Number(raw));
      setSt(updated);
    } catch (e) {
      if (e instanceof ApiError) {
        setApiError(e.body);
        notify("Nie zapisano liczenia", e.body.code, "err");
      }
    }
  }

  async function zamknij(): Promise<void> {
    setBusy(true);
    setApiError(null);
    try {
      const updated = await api.closeStocktake(id);
      setSt(updated);
      notify("Zamknięto inwentaryzację", updated.number);
    } catch (e) {
      if (e instanceof ApiError) {
        setApiError(e.body);
        notify("Nie zamknięto inwentaryzacji", e.body.code, "err");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="toolbar">
        <div>
          <h1>{st.number}</h1>
          <p className="page-sub">
            Magazyn {wname.get(st.warehouseId) ?? st.warehouseId} ·{" "}
            <span className={`badge ${readOnly ? "confirmed" : "draft"}`}>
              {STOCKTAKE_STATUS_LABELS[st.status]}
            </span>{" "}
            · <span className="progress-note">policzono {counted}/{st.lines.length}</span>
            {roznice > 0 && <> · <span className="delta-down">różnic: {roznice}</span></>}
          </p>
        </div>
        <div className="actions">
          <button className="sm ghost" onClick={() => navigate("/stocktakes")}>
            Wróć do listy
          </button>
        </div>
      </div>

      <ErrorBanner error={apiError} />

      <div className="card">
        <div className="section-title">Arkusz spisowy</div>

        <table className="lines-table" data-assistant-id="table.stocktake-lines">
          <thead>
            <tr>
              <th style={{ width: 34 }}>Lp.</th>
              <th style={{ width: 120 }}>Indeks</th>
              <th>Produkt</th>
              <th className="num" style={{ width: 120 }}>Stan księgowy</th>
              <th className="num" style={{ width: 110 }}>Policzono</th>
              <th className="num" style={{ width: 100 }}>Różnica</th>
            </tr>
          </thead>
          <tbody>
            {st.lines.map((l, i) => {
              const p = pname.get(l.productId);
              const diff = l.counted === null ? null : l.counted - l.expected;
              return (
                <tr key={l.productId}>
                  <td className="mono muted">{i + 1}</td>
                  <td className="mono">{p?.sku ?? l.productId}</td>
                  <td>{p?.name ?? "?"}</td>
                  <td className="num mono">{l.expected}</td>
                  <td className="num">
                    {readOnly ? (
                      <span className="mono">{l.counted ?? "—"}</span>
                    ) : (
                      <input
                        data-assistant-id="field.count-input"
                        aria-label={`Policzono: ${p?.name ?? l.productId}`}
                        type="number"
                        min={0}
                        defaultValue={l.counted ?? ""}
                        onBlur={(e) => void zapiszLiczenie(l.productId, e.target.value)}
                      />
                    )}
                  </td>
                  <td className="num mono">
                    {diff === null ? (
                      <span className="muted">—</span>
                    ) : diff === 0 ? (
                      <span className="muted">0</span>
                    ) : (
                      <span className={diff > 0 ? "delta-up" : "delta-down"}>
                        {diff > 0 ? `+${diff}` : diff}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {st.lines.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  Magazyn nie miał stanów w chwili otwarcia arkusza.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {!readOnly ? (
          <div className="form-footer">
            <button
              className="primary"
              data-assistant-id="btn.stocktake-close"
              disabled={busy}
              onClick={() => void zamknij()}
            >
              Zamknij inwentaryzację
            </button>
            <span className="spacer" />
            <span className="muted" style={{ fontSize: 12 }}>
              Zamknąć arkusz może kierownik, gdy wszystkie pozycje są policzone.
            </span>
          </div>
        ) : (
          <div className="form-footer">
            <span className="muted" style={{ fontSize: 12 }}>
              Arkusz zamknięty{" "}
              {st.closedAt ? new Date(st.closedAt).toLocaleString("pl-PL") : ""} przez{" "}
              {st.closedBy}. Różnice koryguje się dokumentami PZ lub WZ.
            </span>
          </div>
        )}
      </div>
    </>
  );
}
