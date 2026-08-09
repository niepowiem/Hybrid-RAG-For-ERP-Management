import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DOC_STATUS_LABELS, DOC_TYPES, DOC_TYPE_LABELS, formatPLN, lineValue } from "@demo-erp/shared";
import type { Counterparty, Document, Warehouse } from "@demo-erp/shared";
import { api } from "../api.js";
import { SortTh, cmp, useSort } from "../ui.js";

export function DocumentsPage() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [wh, setWh] = useState("");
  const [q, setQ] = useState("");
  const { sort, toggle } = useSort({ key: "number", dir: "desc" });
  const navigate = useNavigate();

  useEffect(() => {
    void Promise.all([api.documents(), api.warehouses(), api.counterparties()])
      .then(([d, w, c]) => { setDocuments(d); setWarehouses(w); setCounterparties(c); });
  }, []);

  const code = (id: string | null) =>
    id ? (warehouses.find((w) => w.id === id)?.code ?? "?") : "—";
  const cpName = (id: string | null) =>
    id ? (counterparties.find((c) => c.id === id)?.name ?? "?") : "—";

  const value = (d: Document) => d.lines.reduce((s, l) => s + lineValue(l), 0);

  const rows = documents.filter((d) => {
    if (type && d.type !== type) return false;
    if (status && d.status !== status) return false;
    if (wh && d.warehouseFromId !== wh && d.warehouseToId !== wh) return false;
    if (q && !`${d.number} ${d.externalNumber ?? ""} ${cpName(d.counterpartyId)}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  rows.sort((a, b) => {
    const pick = (d: Document): unknown => ({
      number: d.number, type: d.type, documentDate: d.documentDate,
      operationDate: d.operationDate, cp: cpName(d.counterpartyId),
      lines: d.lines.length, value: value(d), status: d.status, createdBy: d.createdBy,
    })[sort.key];
    return cmp(pick(a), pick(b), sort.dir);
  });

  return (
    <>
      <div className="toolbar">
        <div>
          <h1>Dokumenty magazynowe</h1>
          <p className="page-sub">PZ — przyjęcia zewnętrzne, WZ — wydania zewnętrzne, MM — przesunięcia międzymagazynowe.</p>
        </div>
        <div className="actions">
          <button className="sm" disabled title="Poza zakresem prototypu">Eksport</button>
          <button className="primary" data-assistant-id="btn.document-new" onClick={() => navigate("/documents/new")}>
            Nowy dokument<span className="shortcut">Ins</span>
          </button>
        </div>
      </div>

      <div className="filters">
        <div className="f">
          <label htmlFor="d-type">Typ</label>
          <select id="d-type" data-assistant-id="field.filter-type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Wszystkie</option>
            {DOC_TYPES.map((t) => <option key={t} value={t}>{t} — {DOC_TYPE_LABELS[t]}</option>)}
          </select>
        </div>
        <div className="f">
          <label htmlFor="d-status">Status</label>
          <select id="d-status" data-assistant-id="field.filter-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Wszystkie</option>
            <option value="draft">Szkic</option>
            <option value="confirmed">Zatwierdzony</option>
          </select>
        </div>
        <div className="f">
          <label htmlFor="d-wh">Magazyn</label>
          <select id="d-wh" value={wh} onChange={(e) => setWh(e.target.value)}>
            <option value="">Wszystkie</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
          </select>
        </div>
        <div className="f">
          <label htmlFor="d-q">Numer lub kontrahent</label>
          <input id="d-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="np. WZ-2026 lub Stalmex" />
        </div>
        <div className="spacer" />
        <span className="result-count">{rows.length} / {documents.length}</span>
      </div>

      <table data-assistant-id="table.documents">
        <thead>
          <tr>
            <SortTh label="Numer" sortKey="number" sort={sort} toggle={toggle} />
            <SortTh label="Typ" sortKey="type" sort={sort} toggle={toggle} />
            <SortTh label="Data dok." sortKey="documentDate" sort={sort} toggle={toggle} />
            <SortTh label="Data oper." sortKey="operationDate" sort={sort} toggle={toggle} />
            <SortTh label="Kontrahent" sortKey="cp" sort={sort} toggle={toggle} />
            <th>Z mag.</th><th>Na mag.</th>
            <SortTh label="Poz." sortKey="lines" sort={sort} toggle={toggle} num />
            <SortTh label="Wartość" sortKey="value" sort={sort} toggle={toggle} num />
            <SortTh label="Status" sortKey="status" sort={sort} toggle={toggle} />
            <SortTh label="Wystawił" sortKey="createdBy" sort={sort} toggle={toggle} />
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id} className={`st-${d.status}`}>
              <td className="mono"><Link to={`/documents/${d.id}`}>{d.number}</Link></td>
              <td><span className="badge type" title={DOC_TYPE_LABELS[d.type]}>{d.type}</span></td>
              <td className="mono muted">{d.documentDate}</td>
              <td className="mono muted">{d.operationDate}</td>
              <td>{cpName(d.counterpartyId)}</td>
              <td className="mono">{code(d.warehouseFromId)}</td>
              <td className="mono">{code(d.warehouseToId)}</td>
              <td className="num mono">{d.lines.length}</td>
              <td className="num mono">{formatPLN(value(d))}</td>
              <td><span className={`badge ${d.status}`}>{DOC_STATUS_LABELS[d.status]}</span></td>
              <td className="mono muted">{d.createdBy}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={11} className="empty">Brak dokumentów spełniających kryteria.</td></tr>
          )}
        </tbody>
      </table>
    </>
  );
}
