import { useEffect, useMemo, useState } from "react";
import { formatPLN } from "@demo-erp/shared";
import type { Product } from "@demo-erp/shared";
import { api } from "../api.js";

export function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [showInactive, setShowInactive] = useState(true);

  useEffect(() => { void api.products().then(setProducts); }, []);

  const categories = useMemo(
    () => [...new Set(products.map((p) => p.category))].sort(), [products],
  );

  const rows = products.filter((p) => {
    if (cat && p.category !== cat) return false;
    if (!showInactive && !p.active) return false;
    if (q && !`${p.sku} ${p.name}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  return (
    <>
      <div className="toolbar">
        <div>
          <h1>Produkty</h1>
          <p className="page-sub">Kartoteka indeksów magazynowych.</p>
        </div>
        <div className="actions">
          <button className="sm" disabled title="Poza zakresem prototypu">Nowy produkt</button>
          <button className="sm" disabled title="Poza zakresem prototypu">Import CSV</button>
        </div>
      </div>

      <div className="filters">
        <div className="f">
          <label htmlFor="p-q">Indeks lub nazwa</label>
          <input id="p-q" data-assistant-id="field.product-search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="f">
          <label htmlFor="p-cat">Kategoria</label>
          <select id="p-cat" value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="">Wszystkie</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="f">
          <label>&nbsp;</label>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, textTransform: "none", letterSpacing: 0, color: "var(--ink)" }}>
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} style={{ minWidth: 0, width: "auto" }} />
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
            <th className="num">Stan min.</th><th className="num">Cena ewid.</th><th>Status</th>
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
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
