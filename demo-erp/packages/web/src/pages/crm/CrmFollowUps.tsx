/**
 * CrmFollowUps.tsx — kalendarz kontaktów.
 *
 * Zamiast siatki miesiąca — lista zgrupowana wg pilności. Handlowiec nie
 * pyta „co jest 14 sierpnia”, tylko „co mam zrobić dziś i czego nie zdążyłem”.
 * Grupy odpowiadają dokładnie temu pytaniu.
 */

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { FOLLOWUP_TYPE_LABELS } from "@demo-erp/shared";
import type { CrmFollowUp, CrmRequest } from "@demo-erp/shared";
import { notify } from "../../ui.js";
import { ApiError } from "../../api.js";
import { crmApi } from "../../crm/client.js";
import { useCrmRequests, useEmployeeMap, useEmployees } from "../../crm/hooks.js";
import { Assignee, EmptyState, FollowUpBadge, StageBadge } from "../../crm/components.js";
import { dataPL, dniOdDzis, terminOpis } from "../../crm/format.js";

interface Pozycja {
  r: CrmRequest;
  f: CrmFollowUp;
}

const GRUPY = [
  { id: "late", label: "Przeterminowane", opis: "termin minął — kontakt zaległy" },
  { id: "today", label: "Dziś", opis: "do wykonania w dniu dzisiejszym" },
  { id: "tomorrow", label: "Jutro", opis: "" },
  { id: "week", label: "W tym tygodniu", opis: "najbliższe 7 dni" },
  { id: "later", label: "Później", opis: "" },
  { id: "closed", label: "Zamknięte", opis: "wykonane i pominięte" },
] as const;

type GrupaId = (typeof GRUPY)[number]["id"];

function grupaDla(f: CrmFollowUp): GrupaId {
  if (f.status === "done" || f.status === "skipped") return "closed";
  const d = dniOdDzis(f.date);
  if (d < 0) return "late";
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d <= 7) return "week";
  return "later";
}

export function CrmFollowUpsPage() {
  const { requests, loading, podmien } = useCrmRequests();
  const employees = useEmployees();
  const emap = useEmployeeMap();
  const [assignee, setAssignee] = useState("");
  const [pokazZamkniete, setPokazZamkniete] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const pozycje = useMemo(() => {
    const out: Pozycja[] = [];
    for (const r of requests) {
      if (assignee === "none" && r.assigneeId != null) continue;
      if (assignee !== "" && assignee !== "none" && r.assigneeId !== assignee) continue;
      for (const f of r.followUps) out.push({ r, f });
    }
    return out.sort((a, b) => `${a.f.date}${a.f.time}`.localeCompare(`${b.f.date}${b.f.time}`));
  }, [requests, assignee]);

  async function wykonaj(p: Pozycja): Promise<void> {
    setBusy(p.f.id);
    try {
      const r = await crmApi.doneFollowUp(p.r.id, p.f.id);
      podmien(r);
      notify("Kontakt odnotowany", `${p.r.number} · ${FOLLOWUP_TYPE_LABELS[p.f.type]}`);
    } catch (e) {
      notify("Nie udało się zapisać", e instanceof ApiError ? e.body.message : "Spróbuj ponownie.", "err");
    } finally {
      setBusy(null);
    }
  }

  const grupy = GRUPY.filter((g) => g.id !== "closed" || pokazZamkniete);
  const zaległe = pozycje.filter((p) => grupaDla(p.f) === "late").length;
  const dzisiaj = pozycje.filter((p) => grupaDla(p.f) === "today").length;
  const zaplanowane = pozycje.filter(
      (p) => p.f.status === "planned" || p.f.status === "overdue",
  ).length;

  return (
      <>
        <div className="toolbar">
          <div>
            <h1>Kalendarz kontaktów</h1>
            <p className="page-sub">
              Zaplanowane follow-upy ze wszystkich zapytań, pogrupowane według pilności.
            </p>
          </div>
        </div>

        <div className="kpis" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
          <div className={`kpi ${zaległe > 0 ? "alert" : ""}`}>
            <div className="label">Przeterminowane</div>
            <div className="value">{zaległe}</div>
            <div className="sub">kontakt po terminie</div>
          </div>
          <div className={`kpi ${dzisiaj > 0 ? "warn" : ""}`}>
            <div className="label">Na dziś</div>
            <div className="value">{dzisiaj}</div>
            <div className="sub">do wykonania dzisiaj</div>
          </div>
          <div className="kpi">
            <div className="label">Zaplanowane łącznie</div>
            <div className="value">{zaplanowane}</div>
            <div className="sub">otwarte follow-upy</div>
          </div>
        </div>

        <div className="filters">
          <div className="f">
            <label htmlFor="fu-assignee">Pracownik</label>
            <select id="fu-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">wszyscy</option>
              <option value="none">nieprzypisane</option>
              {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
              ))}
            </select>
          </div>
          <label className="check">
            <input
                type="checkbox"
                checked={pokazZamkniete}
                onChange={(e) => setPokazZamkniete(e.target.checked)}
            />
            pokaż zamknięte
          </label>
          <span className="spacer" />
          <span className="result-count">{pozycje.length} pozycji</span>
        </div>

        {loading && requests.length === 0 && <div className="card">Wczytywanie kalendarza…</div>}

        {!loading &&
            grupy.map((g) => {
              const lista = pozycje.filter((p) => grupaDla(p.f) === g.id);
              if (lista.length === 0 && g.id !== "today") return null;
              return (
                  <section key={g.id} className={`crm-fu-group ${g.id}`}>
                    <div className="hd">
                      <h2>{g.label}</h2>
                      <span className="cnt mono">{lista.length}</span>
                      {g.opis && <span className="muted">{g.opis}</span>}
                    </div>
                    {lista.length === 0 ? (
                        <EmptyState text="Brak kontaktów w tej grupie." />
                    ) : (
                        <table>
                          <tbody>
                          {lista.map((p) => (
                              <tr key={p.f.id} className={g.id === "late" ? "st-alert" : ""}>
                                <td className="mono" style={{ width: 110 }}>
                                  {dataPL(p.f.date)}
                                </td>
                                <td className="mono muted" style={{ width: 60 }}>
                                  {p.f.time}
                                </td>
                                <td style={{ width: 120 }}>{FOLLOWUP_TYPE_LABELS[p.f.type]}</td>
                                <td className="mono" style={{ width: 130 }}>
                                  <Link to={`/crm/requests/${p.r.id}`}>{p.r.number}</Link>
                                </td>
                                <td>{p.r.companyName}</td>
                                <td>{p.f.note}</td>
                                <td style={{ width: 150 }}>
                                  <Assignee employee={p.r.assigneeId ? emap.get(p.r.assigneeId) : undefined} />
                                </td>
                                <td style={{ width: 130 }}>
                                  <StageBadge stage={p.r.stage} />
                                </td>
                                <td style={{ width: 120 }}>
                                  <FollowUpBadge status={p.f.status} />
                                </td>
                                <td className="muted" style={{ width: 120 }}>
                                  {terminOpis(p.f.date)}
                                </td>
                                <td style={{ width: 110, textAlign: "right" }}>
                                  {(p.f.status === "planned" || p.f.status === "overdue") && (
                                      <button
                                          className="sm"
                                          disabled={busy === p.f.id}
                                          onClick={() => void wykonaj(p)}
                                      >
                                        {busy === p.f.id ? "…" : "Wykonany"}
                                      </button>
                                  )}
                                </td>
                              </tr>
                          ))}
                          </tbody>
                        </table>
                    )}
                  </section>
              );
            })}
      </>
  );
}