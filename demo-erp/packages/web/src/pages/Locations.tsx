/**
 * Locations.tsx — lokalizacje magazynowe (adresy składowania).
 *
 * Formularz dodawania jest kartą rozwijaną przyciskiem, nie osobną trasą —
 * dodanie lokalizacji to operacja na jednym ekranie.
 */

import { useEffect, useMemo, useState } from "react";
import type { ApiErrorBody, StorageLocation, Warehouse } from "@demo-erp/shared";
import { api, ApiError } from "../api.js";
import { ErrorBanner } from "../App.js";
import { notify } from "../ui.js";

export function LocationsPage() {
  const [locations, setLocations] = useState<StorageLocation[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [fWarehouse, setFWarehouse] = useState("");
  const [q, setQ] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [apiError, setApiError] = useState<ApiErrorBody | null>(null);
  const [busy, setBusy] = useState(false);

  const [nWarehouse, setNWarehouse] = useState("");
  const [nCode, setNCode] = useState("");
  const [nDescription, setNDescription] = useState("");
  const [nCapacity, setNCapacity] = useState("");

  useEffect(() => {
    void api.locations().then(setLocations);
    void api.warehouses().then(setWarehouses);
  }, []);

  const wname = useMemo(
    () => new Map(warehouses.map((w) => [w.id, w.code])),
    [warehouses],
  );

  const rows = locations.filter((l) => {
    if (fWarehouse && l.warehouseId !== fWarehouse) return false;
    if (q && !`${l.code} ${l.description ?? ""}`.toLowerCase().includes(q.toLowerCase()))
      return false;
    return true;
  });

  async function zapisz(): Promise<void> {
    setBusy(true);
    setApiError(null);
    try {
      const loc = await api.createLocation({
        warehouseId: nWarehouse,
        code: nCode.trim().toUpperCase(),
        description: nDescription.trim() || null,
        capacity: nCapacity === "" ? 0 : Number(nCapacity),
      });
      setLocations((ls) => [...ls, loc]);
      notify("Dodano lokalizację", loc.code);
      setNCode("");
      setNDescription("");
      setNCapacity("");
      setShowForm(false);
    } catch (e) {
      if (e instanceof ApiError) {
        setApiError(e.body);
        notify("Nie dodano lokalizacji", e.body.code, "err");
      }
    } finally {
      setBusy(false);
    }
  }

  async function przelacz(loc: StorageLocation): Promise<void> {
    setApiError(null);
    try {
      const updated = await api.toggleLocation(loc.id);
      setLocations((ls) => ls.map((l) => (l.id === updated.id ? updated : l)));
      notify(
        updated.active ? "Aktywowano lokalizację" : "Dezaktywowano lokalizację",
        updated.code,
      );
    } catch (e) {
      if (e instanceof ApiError) {
        setApiError(e.body);
        notify("Nie zmieniono statusu", e.body.code, "err");
      }
    }
  }

  return (
    <>
      <div className="toolbar">
        <div>
          <h1>Lokalizacje magazynowe</h1>
          <p className="page-sub">Adresy składowania w układzie regał–poziom.</p>
        </div>
        <div className="actions">
          <button
            className="sm primary"
            data-assistant-id="btn.location-new"
            onClick={() => setShowForm((v) => !v)}
          >
            {showForm ? "Ukryj formularz" : "Nowa lokalizacja"}
          </button>
        </div>
      </div>

      <ErrorBanner error={apiError} />

      {showForm && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="section-title">Nowa lokalizacja</div>
          <div className="grid">
            <div className="f-row">
              <label htmlFor="loc-w">Magazyn</label>
              <select
                id="loc-w"
                data-assistant-id="field.location-warehouse"
                value={nWarehouse}
                onChange={(e) => setNWarehouse(e.target.value)}
              >
                <option value="">— wybierz —</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
                ))}
              </select>
            </div>
            <div className="f-row">
              <label htmlFor="loc-code">Kod lokalizacji</label>
              <input
                id="loc-code"
                data-assistant-id="field.location-code"
                placeholder="np. F-01"
                value={nCode}
                onChange={(e) => setNCode(e.target.value)}
              />
              <div className="hint">Musi być unikalny w obrębie magazynu</div>
            </div>
            <div className="f-row">
              <label htmlFor="loc-cap">Pojemność (szt.)</label>
              <input
                id="loc-cap"
                data-assistant-id="field.location-capacity"
                type="number"
                min={0}
                value={nCapacity}
                onChange={(e) => setNCapacity(e.target.value)}
              />
              <div className="hint">Zero oznacza pojemność nieokreśloną</div>
            </div>
          </div>
          <div className="grid" style={{ marginTop: 12 }}>
            <div className="f-row" style={{ gridColumn: "1 / -1" }}>
              <label htmlFor="loc-desc">Opis</label>
              <input
                id="loc-desc"
                data-assistant-id="field.location-description"
                placeholder="np. Regał F — narzędzia"
                value={nDescription}
                onChange={(e) => setNDescription(e.target.value)}
              />
            </div>
          </div>
          <div className="form-footer">
            <button
              className="primary"
              data-assistant-id="btn.location-save"
              disabled={busy}
              onClick={() => void zapisz()}
            >
              Zapisz lokalizację
            </button>
            <span className="spacer" />
            <button className="ghost" onClick={() => setShowForm(false)}>Anuluj</button>
          </div>
        </div>
      )}

      <div className="filters">
        <div className="f">
          <label htmlFor="loc-fw">Magazyn</label>
          <select
            id="loc-fw"
            data-assistant-id="field.location-filter-warehouse"
            value={fWarehouse}
            onChange={(e) => setFWarehouse(e.target.value)}
          >
            <option value="">Wszystkie</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.code}</option>
            ))}
          </select>
        </div>
        <div className="f">
          <label htmlFor="loc-q">Kod lub opis</label>
          <input
            id="loc-q"
            data-assistant-id="field.location-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="spacer" />
        <span className="result-count">{rows.length} / {locations.length}</span>
      </div>

      <table data-assistant-id="table.locations">
        <thead>
          <tr>
            <th style={{ width: 90 }}>Kod</th>
            <th style={{ width: 100 }}>Magazyn</th>
            <th>Opis</th>
            <th className="num" style={{ width: 110 }}>Pojemność</th>
            <th style={{ width: 110 }}>Status</th>
            <th style={{ width: 110 }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => (
            <tr key={l.id}>
              <td className="mono">{l.code}</td>
              <td className="muted">{wname.get(l.warehouseId) ?? l.warehouseId}</td>
              <td>{l.description ?? <span className="muted">—</span>}</td>
              <td className="num mono">{l.capacity > 0 ? l.capacity : "—"}</td>
              <td>
                <span className={`badge ${l.active ? "confirmed" : "inactive"}`}>
                  {l.active ? "Aktywna" : "Nieaktywna"}
                </span>
              </td>
              <td className="num">
                <button
                  className="sm"
                  data-assistant-id="btn.location-toggle"
                  onClick={() => void przelacz(l)}
                >
                  {l.active ? "Dezaktywuj" : "Aktywuj"}
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                Brak lokalizacji dla wybranych filtrów.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
