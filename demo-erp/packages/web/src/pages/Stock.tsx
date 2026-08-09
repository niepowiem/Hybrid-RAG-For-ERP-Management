import { useEffect, useMemo, useState } from "react";
import { formatPLN } from "@demo-erp/shared";
import type { Document, Product, StockLevel, Warehouse } from "@demo-erp/shared";
import { api } from "../api.js";
import { QuantityBar, SortTh, cmp, useSort } from "../ui.js";

export function StockPage() {
  const [stock, setStock] = useState<StockLevel[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [wh, setWh] = useState("");
  const [cat, setCat] = useState("");
  const [q, setQ] = useState("");
  const [onlyLow, setOnlyLow] = useState(false);
  const { sort, toggle } = useSort({ key: "sku", dir: "asc" });

  useEffect(() => {
    void Promise.all([api.stock(), api.products(), api.warehouses(), api.documents()])
      .then(([s, p, w, d]) => { setStock(s); setProducts(p); setWarehouses(w); setDocuments(d); });
  }, []);

  const product = (id: string) => products.find((p) => p.id === id);
  const warehouse = (id: string) => warehouses.find((w) => w.id === id);
  const categories = useMemo(() => [...new Set(products.map((p) => p.category))].sort(), [products]);

  const rows = stock
    .filter((s) => {
      const p = product(s.productId);
      if (!p) return false;
      if (wh && s.warehouseId !== wh) return false;
      if (cat && p.category !== cat) return false;
      if (onlyLow && s.quantity >= p.minStock) return false;
      if (q && !`${p.sku} ${p.name}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    })
    .sort((a, b) => {
      const pa = product(a.productId)!, pb = product(b.productId)!;
      const pick = (s: StockLevel, p: Product): unknown => ({
        wh: warehouse(s.warehouseId)?.code, sku: p.sku, name: p.name,
        cat: p.category, qty: s.quantity, min: p.minStock,
        val: s.quantity * p.price,
      })[sort.key];
      return cmp(pick(a, pa), pick(b, pb), sort.dir);
    });

  const totalValue = stock.reduce((s, x) => s + x.quantity * (product(x.productId)?.price ?? 0), 0);
  const lowRows = stock.filter((s) => {
    const p = product(s.productId);
    return p != null && s.quantity < p.minStock;
  });
  const drafts = documents.filter((d) => d.status === "draft").length;
  const confirmedThisMonth = documents.filter(
    (d) => d.status === "confirmed" && d.operationDate.startsWith("2026-07"),
  ).length;

  return (
    <>
      <div className="toolbar">
        <div>
          <h1>Stany magazynowe</h1>
          <p className="page-sub">Stan wyliczony z zatwierdzonych dokumentów PZ, WZ i MM.</p>
        </div>
        <div className="actions">
          <button className="sm" data-assistant-id="btn.stock-export" disabled title="Poza zakresem prototypu">Eksport XLSX</button>
          <button className="sm" data-assistant-id="btn.stock-print" disabled title="Poza zakresem prototypu">Drukuj</button>
        </div>
      </div>

      <div className="kpis">
        <div className="kpi">
          <div className="label">Wartość zapasu</div>
          <div className="value">{formatPLN(totalValue)}<span className="unit">zł</span></div>
          <div className="sub">wg ceny ewidencyjnej</div>
        </div>
        <div className={`kpi ${lowRows.length > 0 ? "alert" : ""}`}>
          <div className="label">Poniżej minimum</div>
          <div className="value">{lowRows.length}<span className="unit">/ {stock.length}</span></div>
          <div className="sub">{lowRows.length > 0 ? "wymaga uzupełnienia" : "wszystko w normie"}</div>
        </div>
        <div className={`kpi ${drafts > 0 ? "warn" : ""}`}>
          <div className="label">Dokumenty w buforze</div>
          <div className="value">{drafts}</div>
          <div className="sub">szkice niezatwierdzone</div>
        </div>
        <div className="kpi">
          <div className="label">Obroty w okresie</div>
          <div className="value">{confirmedThisMonth}</div>
          <div className="sub">dokumentów zatwierdzonych</div>
        </div>
      </div>

      <div className="filters">
        <div className="f">
          <label htmlFor="s-wh">Magazyn</label>
          <select id="s-wh" data-assistant-id="field.filter-warehouse" value={wh} onChange={(e) => setWh(e.target.value)}>
            <option value="">Wszystkie</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
          </select>
        </div>
        <div className="f">
          <label htmlFor="s-cat">Kategoria</label>
          <select id="s-cat" data-assistant-id="field.filter-category" value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="">Wszystkie</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="f">
          <label htmlFor="s-q">Indeks lub nazwa</label>
          <input id="s-q" data-assistant-id="field.filter-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="np. SR-M8" />
        </div>
        <label className="check">
          <input type="checkbox" data-assistant-id="field.filter-low" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} />
          tylko poniżej minimum
        </label>
        <div className="spacer" />
        <span className="result-count">{rows.length} pozycji</span>
      </div>

      <table data-assistant-id="table.stock">
        <thead>
          <tr>
            <SortTh label="Magazyn" sortKey="wh" sort={sort} toggle={toggle} />
            <SortTh label="Indeks" sortKey="sku" sort={sort} toggle={toggle} />
            <SortTh label="Nazwa" sortKey="name" sort={sort} toggle={toggle} />
            <SortTh label="Kategoria" sortKey="cat" sort={sort} toggle={toggle} />
            <SortTh label="Stan" sortKey="qty" sort={sort} toggle={toggle} num />
            <th>J.m.</th>
            <SortTh label="Minimum" sortKey="min" sort={sort} toggle={toggle} num />
            <th className="num">Cena ewid.</th>
            <SortTh label="Wartość" sortKey="val" sort={sort} toggle={toggle} num />
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const p = product(s.productId)!;
            const below = s.quantity < p.minStock;
            return (
              <tr key={`${s.warehouseId}:${s.productId}`} className={below ? "st-alert" : ""}>
                <td className="mono">{warehouse(s.warehouseId)?.code}</td>
                <td className="mono">{p.sku}</td>
                <td>{p.name}</td>
                <td className="muted">{p.category}</td>
                <QuantityBar value={s.quantity} min={p.minStock} unit={p.unit} />
                <td>{p.unit}</td>
                <td className="num mono muted">{p.minStock}</td>
                <td className="num mono muted">{formatPLN(p.price)}</td>
                <td className="num mono">{formatPLN(s.quantity * p.price)}</td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td colSpan={9} className="empty">Brak pozycji spełniających kryteria.</td></tr>
          )}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr>
              <td colSpan={8}>Wartość wyfiltrowanych pozycji</td>
              <td className="num mono">
                {formatPLN(rows.reduce((s, x) => s + x.quantity * (product(x.productId)?.price ?? 0), 0))} zł
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </>
  );
}
