/**
 * Counterparties.tsx — kartoteka dostawców i odbiorców.
 *
 * Formularz zakładania jest kartą rozwijaną przyciskiem, tak jak w Locations
 * i Products. Dezaktywacja blokuje się, gdy kontrahent występuje na dokumencie
 * albo zamówieniu; API zwraca wtedy ERR-8102.
 */

import { useEffect, useState } from "react";
import { COUNTERPARTY_KINDS, COUNTERPARTY_KIND_LABELS } from "@demo-erp/shared";
import type { ApiErrorBody, Counterparty } from "@demo-erp/shared";
import { api, ApiError } from "../api.js";
import { ErrorBanner } from "../App.js";
import { notify } from "../ui.js";

export function CounterpartiesPage() {
  const [rows, setRows] = useState<Counterparty[]>([]);
  const [q, setQ] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [apiError, setApiError] = useState<ApiErrorBody | null>(null);
  const [busy, setBusy] = useState(false);

  const [nCode, setNCode] = useState("");
  const [nName, setNName] = useState("");
  const [nTaxId, setNTaxId] = useState("");
  const [nCity, setNCity] = useState("");
  const [nKind, setNKind] = useState("");

  useEffect(() => {
    void api.counterparties().then(setRows);
  }, []);

  const filtered = rows.filter(
      (c) =>
          q === "" ||
          c.name.toLowerCase().includes(q.toLowerCase()) ||
          c.code.toLowerCase().includes(q.toLowerCase()) ||
          c.taxId.includes(q),
  );

  async function zapisz(): Promise<void> {
    setBusy(true);
    setApiError(null);
    try {
      const created = await api.createCounterparty({
        code: nCode,
        name: nName,
        taxId: nTaxId,
        city: nCity,
        kind: nKind as Counterparty["kind"],
      });
      setRows((cs) => [...cs, created]);
      notify("Dodano kontrahenta", created.name);
      setNCode("");
      setNName("");
      setNTaxId("");
      setNCity("");
      setShowForm(false);
    } catch (e) {
      if (e instanceof ApiError) {
        setApiError(e.body);
        notify("Nie dodano kontrahenta", e.body.code, "err");
      }
    } finally {
      setBusy(false);
    }
  }

  async function przelacz(c: Counterparty): Promise<void> {
    setApiError(null);
    try {
      const updated = await api.toggleCounterparty(c.id);
      setRows((cs) => cs.map((x) => (x.id === updated.id ? updated : x)));
      notify(
          updated.active ? "Aktywowano kontrahenta" : "Dezaktywowano kontrahenta",
          updated.name,
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
            <h1>Kontrahenci</h1>
            <p className="page-sub">Dostawcy i odbiorcy używani na dokumentach PZ i WZ.</p>
          </div>
          <div className="actions">
            <button
                className="sm primary"
                data-assistant-id="btn.counterparty-new"
                onClick={() => setShowForm((v) => !v)}
            >
              {showForm ? "Ukryj formularz" : "Nowy kontrahent"}
            </button>
          </div>
        </div>

        <ErrorBanner error={apiError} />

        {showForm && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="section-title">Nowy kontrahent</div>
              <div className="grid">
                <div className="f-row">
                  <label htmlFor="cp-code">Kod</label>
                  <input
                      id="cp-code"
                      data-assistant-id="field.counterparty-code"
                      placeholder="np. DOS-003"
                      value={nCode}
                      onChange={(e) => setNCode(e.target.value)}
                  />
                  <div className="hint">Musi być unikalny w kartotece</div>
                </div>
                <div className="f-row">
                  <label htmlFor="cp-name">Nazwa</label>
                  <input
                      id="cp-name"
                      data-assistant-id="field.counterparty-name"
                      placeholder="np. Hurtownia Stalowa Sp. z o.o."
                      value={nName}
                      onChange={(e) => setNName(e.target.value)}
                  />
                </div>
                <div className="f-row">
                  <label htmlFor="cp-kind">Rodzaj</label>
                  <select
                      id="cp-kind"
                      data-assistant-id="field.counterparty-kind"
                      value={nKind}
                      onChange={(e) => setNKind(e.target.value)}
                  >
                    <option value="">— wybierz —</option>
                    {COUNTERPARTY_KINDS.map((k) => (
                        <option key={k} value={k}>{COUNTERPARTY_KIND_LABELS[k]}</option>
                    ))}
                  </select>
                  <div className="hint">Rodzaj decyduje, gdzie kontrahent się pojawi</div>
                </div>
              </div>

              <div className="grid" style={{ marginTop: 12 }}>
                <div className="f-row">
                  <label htmlFor="cp-tax">NIP</label>
                  <input
                      id="cp-tax"
                      data-assistant-id="field.counterparty-taxid"
                      placeholder="10 cyfr, bez myślników"
                      value={nTaxId}
                      onChange={(e) => setNTaxId(e.target.value)}
                  />
                </div>
                <div className="f-row">
                  <label htmlFor="cp-city">Miejscowość</label>
                  <input
                      id="cp-city"
                      data-assistant-id="field.counterparty-city"
                      placeholder="np. Katowice"
                      value={nCity}
                      onChange={(e) => setNCity(e.target.value)}
                  />
                </div>
              </div>

              <div className="form-footer">
                <button
                    className="primary"
                    data-assistant-id="btn.counterparty-save"
                    disabled={busy}
                    onClick={() => void zapisz()}
                >
                  Zapisz kontrahenta
                </button>
                <span className="spacer" />
                <button className="ghost" onClick={() => setShowForm(false)}>Anuluj</button>
              </div>
            </div>
        )}

        <div className="filters">
          <div className="f">
            <label htmlFor="cp-q">Szukaj</label>
            <input
                id="cp-q"
                data-assistant-id="field.counterparty-search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="nazwa, kod lub NIP"
            />
          </div>
          <div className="spacer" />
          <span className="result-count">{filtered.length} / {rows.length}</span>
        </div>

        <table data-assistant-id="table.counterparties">
          <thead>
          <tr>
            <th>Kod</th><th>Nazwa</th><th>NIP</th><th>Miasto</th><th>Rodzaj</th>
            <th>Status</th><th style={{ width: 110 }} />
          </tr>
          </thead>
          <tbody>
          {filtered.map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.code}</td>
                <td>{c.name}</td>
                <td className="mono">{c.taxId}</td>
                <td>{c.city}</td>
                <td>{COUNTERPARTY_KIND_LABELS[c.kind]}</td>
                <td>
                <span className={`badge ${c.active ? "confirmed" : "inactive"}`}>
                  {c.active ? "Aktywny" : "Nieaktywny"}
                </span>
                </td>
                <td className="num">
                  <button
                      className="sm"
                      data-assistant-id="btn.counterparty-toggle"
                      onClick={() => void przelacz(c)}
                  >
                    {c.active ? "Dezaktywuj" : "Aktywuj"}
                  </button>
                </td>
              </tr>
          ))}
          {filtered.length === 0 && (
              <tr><td colSpan={7} className="muted">Brak kontrahentów spełniających kryteria.</td></tr>
          )}
          </tbody>
        </table>
      </>
  );
}