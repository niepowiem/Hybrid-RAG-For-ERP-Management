/**
 * DocumentForm.tsx — najważniejszy ekran demo.
 *
 * Nagłówek celowo gęsty (12 pól w trzech kolumnach): pole, które faktycznie
 * blokuje zatwierdzenie, jest zakopane wśród innych. Dokładnie tego dotyczy
 * wartość asystenta — wskazania właściwego pola zamiast szukania po omacku.
 *
 * Zakładki Powiązane / Historia / Załączniki są poza zakresem prototypu
 * i mówią to wprost zamiast udawać funkcjonalność.
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  COST_CENTERS, CreateDocumentSchema, DOC_STATUS_LABELS, DOC_TYPES,
  DOC_TYPE_LABELS, formatPLN, lineValue,
} from "@demo-erp/shared";
import type {
  ApiErrorBody, Counterparty, CreateDocumentInput, DocStatus, DocType,
  Product, Warehouse,
} from "@demo-erp/shared";
import { api, ApiError } from "../api.js";
import { ErrorBanner } from "../App.js";
import { notify } from "../ui.js";

interface LineDraft { key: number; productId: string; quantity: string; unitPrice: string; location: string; }
let lineKey = 0;

type Tab = "header" | "lines" | "related" | "history" | "files";

const today = () => new Date().toISOString().slice(0, 10);

export function DocumentFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isNew = id === undefined;

  const [tab, setTab] = useState<Tab>("header");
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);

  const [type, setType] = useState<DocType>("PZ");
  const [warehouseFromId, setWarehouseFromId] = useState("");
  const [warehouseToId, setWarehouseToId] = useState("");
  const [counterpartyId, setCounterpartyId] = useState("");
  const [documentDate, setDocumentDate] = useState(today());
  const [operationDate, setOperationDate] = useState(today());
  const [externalNumber, setExternalNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [status, setStatus] = useState<DocStatus>("draft");
  const [docNumber, setDocNumber] = useState("");
  const [createdBy, setCreatedBy] = useState("");
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [apiError, setApiError] = useState<ApiErrorBody | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void Promise.all([api.products(), api.warehouses(), api.counterparties()])
      .then(([p, w, c]) => { setProducts(p); setWarehouses(w); setCounterparties(c); });
    if (!isNew && id) {
      void api.document(id).then((d) => {
        setType(d.type);
        setWarehouseFromId(d.warehouseFromId ?? "");
        setWarehouseToId(d.warehouseToId ?? "");
        setCounterpartyId(d.counterpartyId ?? "");
        setDocumentDate(d.documentDate);
        setOperationDate(d.operationDate);
        setExternalNumber(d.externalNumber ?? "");
        setNotes(d.notes ?? "");
        setStatus(d.status);
        setDocNumber(d.number);
        setCreatedBy(d.createdBy);
        setConfirmedAt(d.confirmedAt);
        setLines(d.lines.map((l) => ({
          key: ++lineKey, productId: l.productId,
          quantity: String(l.quantity), unitPrice: String(l.unitPrice),
          location: l.location ?? "",
        })));
      });
    }
  }, [id, isNew]);

  const readOnly = status === "confirmed";
  const needsFrom = type === "WZ" || type === "MM";
  const needsTo = type === "PZ" || type === "MM";
  const needsCp = type === "PZ" || type === "WZ";
  const activeProducts = useMemo(() => products.filter((p) => p.active), [products]);
  const total = lines.reduce(
    (s, l) => s + lineValue({ quantity: Number(l.quantity) || 0, unitPrice: Number(l.unitPrice) || 0 }), 0,
  );

  function buildInput(): CreateDocumentInput | null {
    const parsed = CreateDocumentSchema.safeParse({
      type,
      warehouseFromId: needsFrom ? warehouseFromId || null : null,
      warehouseToId: needsTo ? warehouseToId || null : null,
      counterpartyId: needsCp ? counterpartyId || null : null,
      documentDate, operationDate,
      externalNumber: externalNumber || null,
      notes: notes || null,
      lines: lines.map((l) => ({
        productId: l.productId,
        quantity: Number(l.quantity),
        unitPrice: Number(l.unitPrice),
        location: l.location || null,
      })),
    });
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) errors[issue.path.join(".")] = issue.message;
      setFieldErrors(errors);
      // Przełącz na zakładkę, w której faktycznie jest błąd.
      if (Object.keys(errors).some((k) => k.startsWith("lines"))) setTab("lines");
      else setTab("header");
      return null;
    }
    setFieldErrors({});
    return parsed.data;
  }

  async function save(): Promise<string | null> {
    const input = buildInput();
    if (!input) return null;
    setBusy(true); setApiError(null);
    try {
      const doc = isNew ? await api.createDocument(input) : await api.updateDocument(id!, input);
      setDocNumber(doc.number); setCreatedBy(doc.createdBy);
      notify("Zapisano szkic", doc.number);
      if (isNew) navigate(`/documents/${doc.id}`, { replace: true });
      return doc.id;
    } catch (e) {
      if (e instanceof ApiError) { setApiError(e.body); notify("Nie zapisano dokumentu", e.body.code, "err"); }
      return null;
    } finally { setBusy(false); }
  }

  async function confirm(): Promise<void> {
    const savedId = await save();
    if (!savedId) return;
    setBusy(true);
    try {
      const doc = await api.confirmDocument(savedId);
      setStatus(doc.status); setConfirmedAt(doc.confirmedAt);
      notify("Dokument zatwierdzony", `${doc.number} — stany zaktualizowane`);
    } catch (e) {
      if (e instanceof ApiError) { setApiError(e.body); notify("Nie zatwierdzono dokumentu", e.body.code, "err"); }
    } finally { setBusy(false); }
  }

  // Skróty jak w klasycznych systemach ERP: F2 zapis, F3 zatwierdzenie,
  // Insert nowa pozycja. Drobiazg, ale to on sprawia, że aplikacja
  // "zachowuje się jak system", a nie jak strona internetowa.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (readOnly || busy) return;
      if (e.key === "F2") { e.preventDefault(); void save(); }
      if (e.key === "F3") { e.preventDefault(); void confirm(); }
      if (e.key === "Insert") {
        e.preventDefault();
        setTab("lines");
        setLines((ls) => [...ls, { key: ++lineKey, productId: "", quantity: "", unitPrice: "", location: "" }]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const err = (k: string) => fieldErrors[k];
  const headerErr = Object.keys(fieldErrors).some((k) => !k.startsWith("lines"));
  const linesErr = Object.keys(fieldErrors).some((k) => k.startsWith("lines"));

  return (
    <>
      <div className="toolbar">
        <div>
          <h1>{isNew ? "Nowy dokument magazynowy" : `${docNumber} — ${DOC_TYPE_LABELS[type]}`}</h1>
          <p className="page-sub">
            {isNew
              ? "Uzupełnij nagłówek, dodaj pozycje, następnie zapisz szkic lub zatwierdź."
              : <>Status: <span className={`badge ${status}`}>{DOC_STATUS_LABELS[status]}</span>
                  {createdBy && <> · wystawił <span className="mono">{createdBy}</span></>}
                  {confirmedAt && <> · zatwierdzono <span className="mono">{confirmedAt.slice(0, 16).replace("T", " ")}</span></>}</>}
          </p>
        </div>
        <div className="actions">
          <button className="sm" disabled title="Poza zakresem prototypu">Drukuj</button>
          <button className="sm" disabled title="Poza zakresem prototypu">Kopiuj</button>
        </div>
      </div>

      <ErrorBanner error={apiError} />

      <div className="tabs">
        <button className={`${tab === "header" ? "active" : ""} ${headerErr ? "has-error" : ""}`} data-assistant-id="tab.header" onClick={() => setTab("header")}>Nagłówek{headerErr && " ⚠"}</button>
        <button className={`${tab === "lines" ? "active" : ""} ${linesErr ? "has-error" : ""}`} data-assistant-id="tab.lines" onClick={() => setTab("lines")}>
          Pozycje<span className="n">{lines.length}</span>{linesErr && " ⚠"}
        </button>
        <button className={tab === "related" ? "active" : ""} onClick={() => setTab("related")}>Powiązane</button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>Historia</button>
        <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>Załączniki</button>
      </div>

      <div className="card tabbed">
        {tab === "header" && (
          <>
            <div className="section-title">Dane podstawowe</div>
            <div className="grid">
              <div className="f-row">
                <label htmlFor="f-type">Typ dokumentu<span className="req">*</span></label>
                <select id="f-type" data-assistant-id="field.document-type" value={type}
                  disabled={readOnly || !isNew} onChange={(e) => setType(e.target.value as DocType)}>
                  {DOC_TYPES.map((t) => <option key={t} value={t}>{t} — {DOC_TYPE_LABELS[t]}</option>)}
                </select>
              </div>
              <div className="f-row">
                <label htmlFor="f-num">Numer dokumentu</label>
                <input id="f-num" value={docNumber || "nadawany automatycznie"} disabled />
              </div>
              <div className="f-row">
                <label htmlFor="f-ext">Numer obcy</label>
                <input id="f-ext" data-assistant-id="field.external-number" value={externalNumber}
                  disabled={readOnly} onChange={(e) => setExternalNumber(e.target.value)}
                  placeholder="np. FV/2026/07/118" />
                <div className="hint">Numer dokumentu u kontrahenta</div>
              </div>

              <div className="f-row">
                <label htmlFor="f-ddate">Data dokumentu<span className="req">*</span></label>
                <input id="f-ddate" type="date" data-assistant-id="field.document-date"
                  className={err("documentDate") ? "invalid" : ""} value={documentDate}
                  disabled={readOnly} onChange={(e) => setDocumentDate(e.target.value)} />
                {err("documentDate") && <div className="field-error">{err("documentDate")}</div>}
              </div>
              <div className="f-row">
                <label htmlFor="f-odate">Data operacji<span className="req">*</span></label>
                <input id="f-odate" type="date" data-assistant-id="field.operation-date"
                  className={err("operationDate") ? "invalid" : ""} value={operationDate}
                  disabled={readOnly} onChange={(e) => setOperationDate(e.target.value)} />
                {err("operationDate") && <div className="field-error">{err("operationDate")}</div>}
              </div>
              <div className="f-row">
                <label htmlFor="f-cp">
                  {type === "PZ" ? "Dostawca" : type === "WZ" ? "Odbiorca" : "Kontrahent"}
                  {needsCp && <span className="req">*</span>}
                </label>
                <select id="f-cp" data-assistant-id="field.counterparty"
                  className={err("counterpartyId") ? "invalid" : ""} value={counterpartyId}
                  disabled={readOnly || !needsCp} onChange={(e) => setCounterpartyId(e.target.value)}>
                  <option value="">{needsCp ? "— wybierz —" : "— nie dotyczy dla MM —"}</option>
                  {counterparties.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
                </select>
                {err("counterpartyId") && <div className="field-error">{err("counterpartyId")}</div>}
              </div>
            </div>

            <div className="section-title" style={{ marginTop: 20 }}>Magazyny</div>
            <div className="grid">
              <div className="f-row">
                <label htmlFor="f-whf">Magazyn źródłowy{needsFrom && <span className="req">*</span>}</label>
                <select id="f-whf" data-assistant-id="field.warehouse-from"
                  className={err("warehouseFromId") ? "invalid" : ""} value={warehouseFromId}
                  disabled={readOnly || !needsFrom} onChange={(e) => setWarehouseFromId(e.target.value)}>
                  <option value="">{needsFrom ? "— wybierz —" : "— nie dotyczy dla PZ —"}</option>
                  {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
                </select>
                {err("warehouseFromId") && <div className="field-error">{err("warehouseFromId")}</div>}
              </div>
              <div className="f-row">
                <label htmlFor="f-wht">Magazyn docelowy{needsTo && <span className="req">*</span>}</label>
                <select id="f-wht" data-assistant-id="field.warehouse-to"
                  className={err("warehouseToId") ? "invalid" : ""} value={warehouseToId}
                  disabled={readOnly || !needsTo} onChange={(e) => setWarehouseToId(e.target.value)}>
                  <option value="">{needsTo ? "— wybierz —" : "— nie dotyczy dla WZ —"}</option>
                  {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
                </select>
                {err("warehouseToId") && <div className="field-error">{err("warehouseToId")}</div>}
              </div>
              <div className="f-row">
                <label htmlFor="f-mpk">Miejsce powstawania kosztów</label>
                <select id="f-mpk" disabled title="Moduł finansowy poza zakresem prototypu">
                  <option>— moduł finansowy niedostępny —</option>
                  {COST_CENTERS.map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
            </div>

            <div className="section-title" style={{ marginTop: 20 }}>Dodatkowe</div>
            <div className="grid two">
              <div className="f-row">
                <label htmlFor="f-notes">Uwagi</label>
                <textarea id="f-notes" data-assistant-id="field.notes" value={notes}
                  disabled={readOnly} onChange={(e) => setNotes(e.target.value)}
                  placeholder="Widoczne na wydruku dokumentu" />
              </div>
              <div className="f-row">
                <label htmlFor="f-attr">Cechy dodatkowe</label>
                <textarea id="f-attr" disabled placeholder="Słowniki cech — poza zakresem prototypu" />
              </div>
            </div>
          </>
        )}

        {tab === "lines" && (
          <>
            <table className="lines-table" data-assistant-id="table.document-lines">
              <thead>
                <tr>
                  <th style={{ width: 34 }}>Lp.</th>
                  <th style={{ width: "38%" }}>Produkt</th>
                  <th style={{ width: 110 }}>Lokalizacja</th>
                  <th className="num" style={{ width: 100 }}>Ilość</th>
                  <th style={{ width: 52 }}>J.m.</th>
                  <th className="num" style={{ width: 100 }}>Cena</th>
                  <th className="num" style={{ width: 110 }}>Wartość</th>
                  <th style={{ width: 60 }} />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => {
                  const p = products.find((x) => x.id === line.productId);
                  return (
                    <tr key={line.key}>
                      <td className="mono muted">{i + 1}</td>
                      <td>
                        <select data-assistant-id="field.line-product" aria-label={`Produkt w pozycji ${i + 1}`}
                          className={err(`lines.${i}.productId`) ? "invalid" : ""} value={line.productId} disabled={readOnly}
                          onChange={(e) => {
                            const prod = products.find((x) => x.id === e.target.value);
                            setLines(lines.map((l) => l.key === line.key
                              ? { ...l, productId: e.target.value, unitPrice: l.unitPrice || String(prod?.price ?? "") }
                              : l));
                          }}>
                          <option value="">— wybierz produkt —</option>
                          {activeProducts.map((x) => <option key={x.id} value={x.id}>{x.sku} — {x.name}</option>)}
                        </select>
                        {err(`lines.${i}.productId`) && <div className="field-error">{err(`lines.${i}.productId`)}</div>}
                      </td>
                      <td>
                        <input data-assistant-id="field.line-location" aria-label={`Lokalizacja w pozycji ${i + 1}`}
                          value={line.location} disabled={readOnly} placeholder="np. A-01"
                          onChange={(e) => setLines(lines.map((l) => l.key === line.key ? { ...l, location: e.target.value } : l))} />
                      </td>
                      <td>
                        <input type="number" data-assistant-id="field.line-quantity" aria-label={`Ilość w pozycji ${i + 1}`}
                          className={err(`lines.${i}.quantity`) ? "invalid" : ""} value={line.quantity} disabled={readOnly} min={0}
                          onChange={(e) => setLines(lines.map((l) => l.key === line.key ? { ...l, quantity: e.target.value } : l))} />
                        {err(`lines.${i}.quantity`) && <div className="field-error">{err(`lines.${i}.quantity`)}</div>}
                      </td>
                      <td className="muted">{p?.unit ?? "—"}</td>
                      <td>
                        <input type="number" step="0.01" data-assistant-id="field.line-price" aria-label={`Cena w pozycji ${i + 1}`}
                          className={err(`lines.${i}.unitPrice`) ? "invalid" : ""} value={line.unitPrice} disabled={readOnly} min={0}
                          onChange={(e) => setLines(lines.map((l) => l.key === line.key ? { ...l, unitPrice: e.target.value } : l))} />
                      </td>
                      <td className="num mono">
                        {formatPLN(lineValue({ quantity: Number(line.quantity) || 0, unitPrice: Number(line.unitPrice) || 0 }))}
                      </td>
                      <td>
                        {!readOnly && (
                          <button className="ghost" data-assistant-id="btn.line-remove"
                            onClick={() => setLines(lines.filter((l) => l.key !== line.key))}>Usuń</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {lines.length === 0 && (
                  <tr><td colSpan={8} className="empty">Dokument nie ma jeszcze żadnej pozycji.</td></tr>
                )}
              </tbody>
              {lines.length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={6}>Razem</td>
                    <td className="num mono">{formatPLN(total)} zł</td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
            {!readOnly && (
              <div style={{ marginTop: 10 }}>
                <button data-assistant-id="btn.line-add"
                  onClick={() => setLines([...lines, { key: ++lineKey, productId: "", quantity: "", unitPrice: "", location: "" }])}>
                  Dodaj pozycję<span className="shortcut">Ins</span>
                </button>
              </div>
            )}
          </>
        )}

        {tab === "related" && (
          <div className="empty">Powiązania między dokumentami są poza zakresem prototypu.</div>
        )}
        {tab === "history" && (
          <div className="empty">Dziennik zmian dokumentu jest poza zakresem prototypu.</div>
        )}
        {tab === "files" && (
          <div className="empty">Repozytorium załączników jest poza zakresem prototypu.</div>
        )}

        {!readOnly && (
          <div className="form-footer">
            <button className="primary" data-assistant-id="btn.document-confirm" disabled={busy} onClick={() => void confirm()}>
              Zatwierdź dokument<span className="shortcut">F3</span>
            </button>
            <button data-assistant-id="btn.document-save" disabled={busy} onClick={() => void save()}>
              Zapisz szkic<span className="shortcut">F2</span>
            </button>
            <span className="spacer" />
            <button className="ghost" onClick={() => navigate("/documents")}>Anuluj</button>
          </div>
        )}
      </div>
    </>
  );
}
