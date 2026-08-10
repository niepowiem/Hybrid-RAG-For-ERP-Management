/**
 * Products.tsx — kartoteka indeksów magazynowych.
 *
 * Formularz zakładania jest kartą rozwijaną przyciskiem, nie osobną trasą —
 * ten sam wzorzec co w Locations.tsx. Wycofanie produktu blokuje się, gdy
 * indeks występuje w obrocie; API zwraca wtedy ERR-8002.
 */

import { useEffect, useMemo, useState } from "react";
import { formatPLN, UNITS } from "@demo-erp/shared";
import type { ApiErrorBody, Product, Unit } from "@demo-erp/shared";
import { api, ApiError } from "../api.js";
import { ErrorBanner } from "../App.js";
import { notify } from "../ui.js";

export function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [showInactive, setShowInactive] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [apiError, setApiError] = useState<ApiErrorBody | null>(null);
  const [busy, setBusy] = useState(false);

  const [nSku, setNSku] = useState("");
  const [nName, setNName] = useState("");
  const [nUnit, setNUnit] = useState("");
  const [nCategory, setNCategory] = useState("");
  const [nMinStock, setNMinStock] = useState("");
  const [nPrice, setNPrice] = useState("");

  useEffect(() => {
    void api.products().then(setProducts);
  }, []);

  const categories = useMemo(
      () => [...new Set(products.map((p) => p.category))].sort(),
      [products],
  );

  const rows = products.filter((p) => {
    if (cat && p.category !== cat) return false;
    if (!showInactive && !p.active) return false;
    if (q && !`${p.sku} ${p.name}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  async function zapisz(): Promise<void> {
    setBusy(true);
    setApiError(null);
    try {
      const product = await api.createProduct({
        sku: nSku,
        name: nName,
        unit: nUnit as Unit,
        category: nCategory,
        minStock: nMinStock === "" ? 0 : Number(nMinStock),
        price: nPrice === "" ? 0 : Number(nPrice),
      });
      setProducts((ps) => [...ps, product]);
      notify("Dodano produkt", product.sku);
      setNSku("");
      setNName("");
      setNMinStock("");
      setNPrice("");
      setShowForm(false);
    } catch (e) {
      if (e instanceof ApiError) {
        setApiError(e.body);
        notify("Nie dodano produktu", e.body.code, "err");
      }
    } finally {
      setBusy(false);
    }
  }

  async function przelacz(p: Product): Promise<void> {
    setApiError(null);
    try {
      const updated = await api.toggleProduct(p.id);
      setProducts((ps) => ps.map((x) => (x.id === updated.id ? updated : x)));
      notify(updated.active ? "Przywrócono produkt" : "Wycofano produkt", updated.sku);
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
            <h1>Produkty</h1>
            <p className="page-sub">Kartoteka indeksów magazynowych.</p>
          </div>
          <div className="actions">
            <button
                className="sm primary"
                data-assistant-id="btn.product-new"
                onClick={() => setShowForm((v) => !v)}
            >
              {showForm ? "Ukryj formularz" : "Nowy produkt"}
            </button>
            <button className="sm" disabled title="Poza zakresem prototypu">
              Import CSV
            </button>
          </div>
        </div>

        <ErrorBanner error={apiError} />

        {showForm && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="section-title">Nowy produkt</div>
              <div className="grid">
                <div className="f-row">
                  <label htmlFor="p-sku">Indeks</label>
                  <input
                      id="p-sku"
                      data-assistant-id="field.product-sku"
                      placeholder="np. SR-M10-120"
                      value={nSku}
                      onChange={(e) => setNSku(e.target.value)}
                  />
                  <div className="hint">Musi być unikalny w całej kartotece</div>
                </div>
                <div className="f-row">
                  <label htmlFor="p-name">Nazwa</label>
                  <input
                      id="p-name"
                      data-assistant-id="field.product-name"
                      placeholder="np. Śruba M10 x 120 DIN 933"
                      value={nName}
                      onChange={(e) => setNName(e.target.value)}
                  />
                </div>
                <div className="f-row">
                  <label htmlFor="p-unit">Jednostka miary</label>
                  <select
                      id="p-unit"
                      data-assistant-id="field.product-unit"
                      value={nUnit}
                      onChange={(e) => setNUnit(e.target.value)}
                  >
                    <option value="">— wybierz —</option>
                    {UNITS.map((u) => (
                        <option key={u} value={u}>{u}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid" style={{ marginTop: 12 }}>
                <div className="f-row">
                  <label htmlFor="p-cat-new">Kategoria</label>
                  <select
                      id="p-cat-new"
                      data-assistant-id="field.product-category"
                      value={nCategory}
                      onChange={(e) => setNCategory(e.target.value)}
                  >
                    <option value="">— wybierz —</option>
                    {categories.map((c) => (
                        <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <div className="f-row">
                  <label htmlFor="p-min">Stan minimalny</label>
                  <input
                      id="p-min"
                      data-assistant-id="field.product-min-stock"
                      type="number"
                      min={0}
                      value={nMinStock}
                      onChange={(e) => setNMinStock(e.target.value)}
                  />
                  <div className="hint">Poniżej tej ilości stan świeci się na czerwono</div>
                </div>
                <div className="f-row">
                  <label htmlFor="p-price">Cena ewidencyjna</label>
                  <input
                      id="p-price"
                      data-assistant-id="field.product-price"
                      type="number"
                      min={0}
                      step="0.01"
                      value={nPrice}
                      onChange={(e) => setNPrice(e.target.value)}
                  />
                  <div className="hint">Podpowiada się na pozycjach dokumentów</div>
                </div>
              </div>

              <div className="form-footer">
                <button
                    className="primary"
                    data-assistant-id="btn.product-save"
                    disabled={busy}
                    onClick={() => void zapisz()}
                >
                  Zapisz produkt
                </button>
                <span className="spacer" />
                <button className="ghost" onClick={() => setShowForm(false)}>Anuluj</button>
              </div>
            </div>
        )}

        <div className="filters">
          <div className="f">
            <label htmlFor="p-q">Indeks lub nazwa</label>
            <input
                id="p-q"
                data-assistant-id="field.product-search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="f">
            <label htmlFor="p-cat">Kategoria</label>
            <select
                id="p-cat"
                data-assistant-id="field.product-filter-category"
                value={cat}
                onChange={(e) => setCat(e.target.value)}
            >
              <option value="">Wszystkie</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="f">
            <label>&nbsp;</label>
            <label
                style={{
                  display: "flex", gap: 6, alignItems: "center", fontSize: 12,
                  textTransform: "none", letterSpacing: 0, color: "var(--ink)",
                }}
            >
              <input
                  type="checkbox"
                  data-assistant-id="field.product-show-inactive"
                  checked={showInactive}
                  onChange={(e) => setShowInactive(e.target.checked)}
                  style={{ minWidth: 0, width: "auto" }}
              />
              pokaż nieaktywne
            </label>
          </div>
          <div className="spacer" />
          <span className="result-count">{rows.length} / {products.length}</span>
        </div>

        <table data-assistant-id="table.products">
          <thead>
          <tr>
            <th>Indeks</th><th>Nazwa</th><th>Kategoria</th><th>J.m.</th>
            <th className="num">Stan min.</th><th className="num">Cena ewid.</th>
            <th>Status</th><th style={{ width: 110 }} />
          </tr>
          </thead>
          <tbody>
          {rows.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.sku}</td>
                <td>{p.name}</td>
                <td className="muted">{p.category}</td>
                <td>{p.unit}</td>
                <td className="num mono">{p.minStock}</td>
                <td className="num mono">{formatPLN(p.price)}</td>
                <td>
                <span className={`badge ${p.active ? "confirmed" : "inactive"}`}>
                  {p.active ? "Aktywny" : "Nieaktywny"}
                </span>
                </td>
                <td className="num">
                  <button
                      className="sm"
                      data-assistant-id="btn.product-toggle"
                      onClick={() => void przelacz(p)}
                  >
                    {p.active ? "Wycofaj" : "Przywróć"}
                  </button>
                </td>
              </tr>
          ))}
          {rows.length === 0 && (
              <tr><td colSpan={8} className="muted">Brak produktów spełniających kryteria.</td></tr>
          )}
          </tbody>
        </table>
      </>
  );
}