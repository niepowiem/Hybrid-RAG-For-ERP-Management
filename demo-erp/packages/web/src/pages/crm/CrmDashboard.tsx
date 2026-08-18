/**
 * CrmDashboard.tsx — pulpit modułu CRM.
 *
 * Układ odpowiada pytaniom, które kierownik zadaje rano w tej kolejności:
 * co przyszło, co stoi, gdzie są pieniądze i o czym zapomnieliśmy.
 * Stąd kolejność: kafelki stanu, lejek, a na dole dwie listy zadaniowe —
 * przeterminowane kontakty i sprawy bez opiekuna.
 */

import { useMemo } from "react";
import { Link } from "react-router-dom";
import { CRM_STAGES, CRM_STAGE_LABELS, najblizszyFollowUp, ocenKompletnosc } from "@demo-erp/shared";
import type { CrmRequest, CrmStage } from "@demo-erp/shared";
import { useCrmRequests, useEmployeeMap } from "../../crm/hooks.js";
import { useMailbox } from "../../crm/poller.js";
import { Assignee, EmptyState, ScoreBar, StageBadge } from "../../crm/components.js";
import { dataGodzinaPL, maPrzeterminowany, otwarteFollowUpy, terminOpis } from "../../crm/format.js";

export function CrmDashboardPage() {
  const { requests, loading } = useCrmRequests();
  const employees = useEmployeeMap();
  const mailbox = useMailbox();

  const stat = useMemo(() => {
    const wEtapie = (s: CrmStage): CrmRequest[] => requests.filter((r) => r.stage === s);
    const niekompletne = requests.filter(
        (r) => r.stage !== "won" && r.stage !== "lost" && ocenKompletnosc(r).status !== "complete",
    );
    const przeterminowane = requests.filter(maPrzeterminowany);
    const bezOpiekuna = requests.filter((r) => r.assigneeId == null && r.stage !== "lost");
    return {
      nowe: wEtapie("new"),
      niekompletne,
      przygotowanie: wEtapie("offer_prep"),
      negocjacje: wEtapie("negotiation"),
      wygrane: wEtapie("won"),
      przegrane: wEtapie("lost"),
      przeterminowane,
      bezOpiekuna,
    };
  }, [requests]);

  const lejek = useMemo(() => {
    const max = Math.max(1, ...CRM_STAGES.map((s) => requests.filter((r) => r.stage === s).length));
    return CRM_STAGES.map((s) => {
      const n = requests.filter((r) => r.stage === s).length;
      return { stage: s, n, pct: Math.round((n / max) * 100) };
    });
  }, [requests]);

  const doKontaktu = useMemo(
      () =>
          requests
              .filter((r) => otwarteFollowUpy(r).length > 0)
              .map((r) => ({ r, f: najblizszyFollowUp(r.followUps)! }))
              .sort((a, b) => `${a.f.date}${a.f.time}`.localeCompare(`${b.f.date}${b.f.time}`))
              .slice(0, 6),
      [requests],
  );

  return (
      <>
        <div className="toolbar">
          <div>
            <h1>CRM — pulpit</h1>
            <p className="page-sub">
              Obsługa zapytań ofertowych: poczta przychodząca, lejek sprzedaży i terminy kontaktów.
            </p>
          </div>
          <div className="actions">
            <Link className="crm-btn-link" to="/crm/settings" data-assistant-id="btn.crm-settings">
              Ustawienia automatyzacji
            </Link>
            <Link className="crm-btn-link" to="/crm/requests/new" data-assistant-id="btn.crm-new">
              Nowe zapytanie
            </Link>
          </div>
        </div>

        <div className="kpis crm-kpis">
          <Kafelek label="Nowe zapytania" value={stat.nowe.length} sub="etap „Nowe”" to="/crm/requests?stage=new" />
          <Kafelek
              label="Do uzupełnienia"
              value={stat.niekompletne.length}
              sub="brak danych lub załączników"
              ton="warn"
              to="/crm/requests?completeness=incomplete"
          />
          <Kafelek label="Oferty w przygotowaniu" value={stat.przygotowanie.length} sub="etap „Przygotowanie oferty”" to="/crm/requests?stage=offer_prep" />
          <Kafelek label="W negocjacjach" value={stat.negocjacje.length} sub="etap „Negocjacje”" to="/crm/requests?stage=negotiation" />
          <Kafelek label="Wygrane" value={stat.wygrane.length} sub="zamknięte sukcesem" to="/crm/requests?stage=won" />
          <Kafelek label="Przegrane" value={stat.przegrane.length} sub="z podaną przyczyną" to="/crm/requests?stage=lost" />
          <Kafelek
              label="Przeterminowany follow-up"
              value={stat.przeterminowane.length}
              sub="kontakt po terminie"
              ton="alert"
              to="/crm/followups"
          />
          <Kafelek
              label="Bez opiekuna"
              value={stat.bezOpiekuna.length}
              sub="czeka na przydzielenie"
              ton={stat.bezOpiekuna.length > 0 ? "warn" : undefined}
              to="/crm/requests?assignee=none"
          />
        </div>

        <div className="crm-cols">
          <div className="card">
            <div className="section-title">Lejek sprzedażowy</div>
            {loading && requests.length === 0 ? (
                <p className="muted">Wczytywanie danych…</p>
            ) : (
                <div className="crm-funnel">
                  {lejek.map((l) => (
                      <Link key={l.stage} to={`/crm/board`} className="row" title={CRM_STAGE_LABELS[l.stage]}>
                        <span className="lbl">{CRM_STAGE_LABELS[l.stage]}</span>
                        <span className="track">
                    <span className={`bar s-${l.stage}`} style={{ width: `${l.pct}%` }} />
                  </span>
                        <span className="n mono">{l.n}</span>
                      </Link>
                  ))}
                </div>
            )}
          </div>

          <div className="card">
            <div className="section-title">Skrzynka zapytań</div>
            <dl className="crm-dl">
              <dt>Źródło</dt>
              <dd>{mailbox.adapter}</dd>
              <dt>Ostatnie sprawdzenie</dt>
              <dd className="mono">
                {mailbox.loading ? "trwa pobieranie…" : dataGodzinaPL(mailbox.state?.lastCheckedAt ?? null)}
              </dd>
              <dt>Nowe w ostatnim cyklu</dt>
              <dd className="mono">{mailbox.state?.newCount ?? 0}</dd>
              <dt>Wiadomości w skrzynce</dt>
              <dd className="mono">{mailbox.messages.length}</dd>
              <dt>Do weryfikacji</dt>
              <dd className="mono">
                {mailbox.messages.filter((m) => m.status === "needs_review").length}
              </dd>
            </dl>
            {mailbox.error && (
                <p className="crm-note danger">Ostatnie pobranie nie powiodło się: {mailbox.error}</p>
            )}
            <Link className="crm-btn-link" to="/crm/mailbox">
              Otwórz skrzynkę
            </Link>
          </div>
        </div>

        <div className="crm-cols">
          <div className="card">
            <div className="section-title">Najbliższe kontakty</div>
            {doKontaktu.length === 0 ? (
                <EmptyState text="Brak zaplanowanych kontaktów." hint="Follow-upy dodasz w szczegółach zapytania." />
            ) : (
                <table className="crm-mini">
                  <tbody>
                  {doKontaktu.map(({ r, f }) => (
                      <tr key={f.id} className={f.status === "overdue" ? "late" : ""}>
                        <td className="mono">
                          <Link to={`/crm/requests/${r.id}`}>{r.number}</Link>
                        </td>
                        <td>{r.companyName}</td>
                        <td className="mono">{f.date.split("-").reverse().join(".")}</td>
                        <td className={f.status === "overdue" ? "late-txt" : "muted"}>{terminOpis(f.date)}</td>
                      </tr>
                  ))}
                  </tbody>
                </table>
            )}
          </div>

          <div className="card">
            <div className="section-title">Oczekuje na przydzielenie</div>
            {stat.bezOpiekuna.length === 0 ? (
                <EmptyState text="Wszystkie zapytania mają opiekuna." />
            ) : (
                <table className="crm-mini">
                  <tbody>
                  {stat.bezOpiekuna.slice(0, 6).map((r) => (
                      <tr key={r.id}>
                        <td className="mono">
                          <Link to={`/crm/requests/${r.id}`}>{r.number}</Link>
                        </td>
                        <td>{r.companyName}</td>
                        <td>
                          <StageBadge stage={r.stage} />
                        </td>
                        <td>
                          <ScoreBar value={r.score} width={70} />
                        </td>
                        <td>
                          <Assignee employee={r.assigneeId ? employees.get(r.assigneeId) : undefined} />
                        </td>
                      </tr>
                  ))}
                  </tbody>
                </table>
            )}
          </div>
        </div>
      </>
  );
}

function Kafelek({
                   label,
                   value,
                   sub,
                   ton,
                   to,
                 }: {
  label: string;
  value: number;
  sub: string;
  ton?: "warn" | "alert";
  to: string;
}) {
  return (
      <Link className={`kpi crm-kpi ${ton ?? ""}`} to={to}>
        <div className="label">{label}</div>
        <div className="value">{value}</div>
        <div className="sub">{sub}</div>
      </Link>
  );
}