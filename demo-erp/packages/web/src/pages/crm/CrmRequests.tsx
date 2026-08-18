/**
 * CrmRequests.tsx — rejestr zapytań ofertowych.
 *
 * Tabela z filtrowaniem, wyszukiwaniem i sortowaniem, zbudowana na tych samych
 * komponentach co listy magazynowe (useSort, SortTh, cmp) — dzięki temu
 * zachowanie nagłówków jest identyczne w całym systemie.
 *
 * Parametry filtrów żyją w adresie URL. Kafelek na pulpicie prowadzi wprost
 * do przefiltrowanej listy, a odnośnik można wysłać współpracownikowi.
 */

import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  CRM_SOURCE_LABELS,
  CRM_STAGES,
  CRM_STAGE_LABELS,
  SCORE_BANDS,
  najblizszyFollowUp,
  ocenKompletnosc,
} from "@demo-erp/shared";
import type { CrmRequest } from "@demo-erp/shared";
import { cmp, SortTh, useSort } from "../../ui.js";
import { useCrmRequests, useEmployeeMap, useEmployees } from "../../crm/hooks.js";
import {
  Assignee,
  CompletenessBadge,
  EmptyState,
  LoadingRows,
  ScoreBar,
  StageBadge,
} from "../../crm/components.js";
import { QuickEditModal } from "../../crm/modals.js";
import { dataPL, maPrzeterminowany, poziomTerminu, terminOpis } from "../../crm/format.js";

export function CrmRequestsPage() {
  const { requests, loading, podmien } = useCrmRequests();
  const employees = useEmployees();
  const emap = useEmployeeMap();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { sort, toggle } = useSort({ key: "number", dir: "desc" });
  const [edytowane, setEdytowane] = useState<CrmRequest | null>(null);

  const q = params.get("q") ?? "";
  const stage = params.get("stage") ?? "";
  const assignee = params.get("assignee") ?? "";
  const completeness = params.get("completeness") ?? "";
  const band = params.get("band") ?? "";
  const tylkoZalegle = params.get("late") === "1";

  const ustaw = (klucz: string, wartosc: string): void => {
    const next = new URLSearchParams(params);
    if (wartosc === "") next.delete(klucz);
    else next.set(klucz, wartosc);
    setParams(next, { replace: true });
  };

  const widoczne = useMemo(() => {
    const szukane = q.trim().toLowerCase();
    const filtrowane = requests.filter((r) => {
      if (stage !== "" && r.stage !== stage) return false;
      if (assignee === "none" && r.assigneeId != null) return false;
      if (assignee !== "" && assignee !== "none" && r.assigneeId !== assignee) return false;
      if (completeness === "incomplete" && ocenKompletnosc(r).status === "complete") return false;
      if (completeness === "complete" && ocenKompletnosc(r).status !== "complete") return false;
      if (band !== "") {
        const b = SCORE_BANDS[Number(band)];
        if (b && (r.score < b.min || r.score > b.max)) return false;
      }
      if (tylkoZalegle && !maPrzeterminowany(r)) return false;
      if (szukane !== "") {
        const hay = [r.number, r.companyName, r.contactName, r.email, r.description, r.products ?? ""]
            .join(" ")
            .toLowerCase();
        if (!hay.includes(szukane)) return false;
      }
      return true;
    });

    const klucz = (r: CrmRequest): unknown => {
      switch (sort.key) {
        case "company":
          return r.companyName;
        case "contact":
          return r.contactName;
        case "assignee":
          return r.assigneeId ? (emap.get(r.assigneeId)?.name ?? "") : "";
        case "stage":
          return CRM_STAGES.indexOf(r.stage);
        case "score":
          return r.score;
        case "created":
          return r.createdAt;
        case "followup":
          return najblizszyFollowUp(r.followUps)?.date ?? "9999-99-99";
        default:
          return r.number;
      }
    };
    return [...filtrowane].sort((a, b) => cmp(klucz(a), klucz(b), sort.dir));
  }, [requests, q, stage, assignee, completeness, band, tylkoZalegle, sort, emap]);

  return (
      <>
        <div className="toolbar">
          <div>
            <h1>Zapytania CRM</h1>
            <p className="page-sub">
              Rejestr zapytań ofertowych ze wszystkich źródeł — poczty przychodzącej i wprowadzonych ręcznie.
            </p>
          </div>
          <div className="actions">
            <button className="sm" onClick={() => navigate("/crm/board")}>
              Widok tablicy
            </button>
            <button
                className="sm primary"
                data-assistant-id="btn.crm-new"
                onClick={() => navigate("/crm/requests/new")}
            >
              Nowe zapytanie
            </button>
          </div>
        </div>

        <div className="filters">
          <div className="f">
            <label htmlFor="crm-q">Szukaj</label>
            <input
                id="crm-q"
                data-assistant-id="field.crm-search"
                value={q}
                onChange={(e) => ustaw("q", e.target.value)}
                placeholder="numer, firma, osoba, e-mail…"
                style={{ minWidth: 210 }}
            />
          </div>
          <div className="f">
            <label htmlFor="crm-stage">Etap</label>
            <select id="crm-stage" value={stage} onChange={(e) => ustaw("stage", e.target.value)}>
              <option value="">wszystkie</option>
              {CRM_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {CRM_STAGE_LABELS[s]}
                  </option>
              ))}
            </select>
          </div>
          <div className="f">
            <label htmlFor="crm-assignee">Pracownik</label>
            <select id="crm-assignee" value={assignee} onChange={(e) => ustaw("assignee", e.target.value)}>
              <option value="">wszyscy</option>
              <option value="none">nieprzypisane</option>
              {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
              ))}
            </select>
          </div>
          <div className="f">
            <label htmlFor="crm-compl">Kompletność</label>
            <select id="crm-compl" value={completeness} onChange={(e) => ustaw("completeness", e.target.value)}>
              <option value="">dowolna</option>
              <option value="complete">kompletne</option>
              <option value="incomplete">wymaga uzupełnienia</option>
            </select>
          </div>
          <div className="f">
            <label htmlFor="crm-band">Scoring</label>
            <select id="crm-band" value={band} onChange={(e) => ustaw("band", e.target.value)}>
              <option value="">dowolny</option>
              {SCORE_BANDS.map((b, i) => (
                  <option key={b.label} value={String(i)}>
                    {b.label}
                  </option>
              ))}
            </select>
          </div>
          <label className="check">
            <input type="checkbox" checked={tylkoZalegle} onChange={(e) => ustaw("late", e.target.checked ? "1" : "")} />
            tylko z zaległym kontaktem
          </label>
          <span className="spacer" />
          <span className="result-count">
          {widoczne.length} / {requests.length}
        </span>
        </div>

        <table data-assistant-id="table.crm-requests">
          <thead>
          <tr>
            <SortTh label="Numer" sortKey="number" sort={sort} toggle={toggle} />
            <SortTh label="Firma / klient" sortKey="company" sort={sort} toggle={toggle} />
            <SortTh label="Osoba kontaktowa" sortKey="contact" sort={sort} toggle={toggle} />
            <th>E-mail</th>
            <SortTh label="Pracownik" sortKey="assignee" sort={sort} toggle={toggle} />
            <SortTh label="Etap" sortKey="stage" sort={sort} toggle={toggle} />
            <SortTh label="Scoring" sortKey="score" sort={sort} toggle={toggle} />
            <th>Kompletność</th>
            <SortTh label="Utworzone" sortKey="created" sort={sort} toggle={toggle} />
            <SortTh label="Follow-up" sortKey="followup" sort={sort} toggle={toggle} />
            <th style={{ width: 46 }} aria-label="Akcje" />
          </tr>
          </thead>
          <tbody>
          {loading && requests.length === 0 && <LoadingRows cols={11} />}
          {widoczne.map((r) => {
            const fu = najblizszyFollowUp(r.followUps);
            return (
                <tr key={r.id} className={maPrzeterminowany(r) ? "st-alert" : ""}>
                  <td className="mono">
                    <Link to={`/crm/requests/${r.id}`}>{r.number}</Link>
                  </td>
                  <td>
                    {r.companyName}
                    <span className="crm-src" title={`Źródło: ${CRM_SOURCE_LABELS[r.source]}`}>
                    {r.source === "email" ? "✉" : "✎"}
                  </span>
                  </td>
                  <td>{r.contactName}</td>
                  <td className="muted">{r.email}</td>
                  <td>
                    <Assignee employee={r.assigneeId ? emap.get(r.assigneeId) : undefined} />
                  </td>
                  <td>
                    <StageBadge stage={r.stage} />
                  </td>
                  <td>
                    <ScoreBar value={r.score} />
                  </td>
                  <td>
                    <CompletenessBadge req={r} />
                  </td>
                  <td className="muted mono">{dataPL(r.createdAt)}</td>
                  <td>
                    {fu ? (
                        <span className={`crm-due lvl-${poziomTerminu(fu.date)}`}>
                      <b className="mono">{dataPL(fu.date)}</b>
                      <span>{terminOpis(fu.date)}</span>
                    </span>
                    ) : (
                        <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <button
                        className="icon-btn"
                        title="Szybka edycja: etap, pracownik, scoring"
                        aria-label={`Szybka edycja zapytania ${r.number}`}
                        onClick={() => setEdytowane(r)}
                    >
                      ⋮
                    </button>
                  </td>
                </tr>
            );
          })}
          {!loading && widoczne.length === 0 && (
              <tr>
                <td colSpan={11}>
                  <EmptyState
                      text="Brak zapytań spełniających kryteria."
                      hint="Wyczyść filtry albo dodaj nowe zapytanie przyciskiem powyżej."
                  />
                </td>
              </tr>
          )}
          </tbody>
        </table>

        {edytowane && (
            <QuickEditModal
                req={edytowane}
                onClose={() => setEdytowane(null)}
                onSaved={(r) => podmien(r)}
            />
        )}
      </>
  );
}