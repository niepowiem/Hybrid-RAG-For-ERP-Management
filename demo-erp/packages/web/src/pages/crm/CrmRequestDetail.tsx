/**
 * CrmRequestDetail.tsx — karta zapytania.
 *
 * Układ dwukolumnowy: po lewej treść sprawy (dane, załączniki, korespondencja,
 * historia), po prawej panel decyzji — etap, opiekun, scoring, kompletność.
 * To rozdzielenie jest celowe: lewa strona odpowiada „o co chodzi”,
 * prawa „co z tym robimy”, i tylko prawa zmienia stan zapytania.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ATTACHMENT_KIND_LABELS,
  ACTIVITY_KIND_LABELS,
  CRM_EMPLOYEE_ROLE_LABELS,
  CRM_MESSAGE_KIND_LABELS,
  CRM_SOURCE_LABELS,
  CRM_STAGES,
  CRM_STAGE_LABELS,
  FOLLOWUP_TYPES,
  FOLLOWUP_TYPE_LABELS,
  LOST_REASON_LABELS,
  ocenKompletnosc,
  sugerowanyScoring,
} from "@demo-erp/shared";
import type {
  ApiErrorBody,
  CrmMessage,
  CrmRequest,
  CrmStage,
  FollowUpType,
  InboxMessage,
} from "@demo-erp/shared";
import { ApiError } from "../../api.js";
import { ErrorBanner } from "../../App.js";
import { notify } from "../../ui.js";
import { crmApi } from "../../crm/client.js";
import { useEmployees } from "../../crm/hooks.js";
import { useMailbox } from "../../crm/poller.js";
import {
  Assignee,
  CompletenessBadge,
  EmptyState,
  FollowUpBadge,
  MissingList,
  Modal,
  ScoreBar,
  StageBadge,
} from "../../crm/components.js";
import { LostReasonModal } from "../../crm/modals.js";
import { dataGodzinaPL, dataPL, terminOpis } from "../../crm/format.js";

export function CrmRequestDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const employees = useEmployees();
  const mailbox = useMailbox();

  const [req, setReq] = useState<CrmRequest | null>(null);
  const [apiError, setApiError] = useState<ApiErrorBody | null>(null);
  const [busy, setBusy] = useState(false);
  const [score, setScore] = useState(0);
  const [lostOpen, setLostOpen] = useState(false);
  const [fuOpen, setFuOpen] = useState(false);
  const [podglad, setPodglad] = useState<CrmMessage | null>(null);

  useEffect(() => {
    if (!id) return;
    void crmApi
        .request(id)
        .then((r) => {
          setReq(r);
          setScore(r.score);
        })
        .catch((e: unknown) => {
          if (e instanceof ApiError) setApiError(e.body);
        });
  }, [id]);

  const zrodlowa: InboxMessage | undefined = useMemo(
      () => mailbox.messages.find((m) => m.id === req?.sourceMessageId),
      [mailbox.messages, req?.sourceMessageId],
  );

  if (apiError && !req) {
    return (
        <>
          <h1>Zapytanie CRM</h1>
          <ErrorBanner error={apiError} />
          <button onClick={() => navigate("/crm/requests")}>Wróć do listy zapytań</button>
        </>
    );
  }

  if (!req) {
    return (
        <>
          <h1>Zapytanie CRM</h1>
          <p className="page-sub">Wczytywanie danych…</p>
          <div className="card">
            <div className="crm-skeleton-block" />
          </div>
        </>
    );
  }

  const r = req;
  const opiekun = r.assigneeId ? employees.find((e) => e.id === r.assigneeId) : undefined;
  const kompletnosc = ocenKompletnosc(r);
  const podpowiedz = sugerowanyScoring(r);

  async function akcja<T extends CrmRequest>(fn: () => Promise<T>, komunikat?: string): Promise<void> {
    setBusy(true);
    setApiError(null);
    try {
      const wynik = await fn();
      setReq(wynik);
      setScore(wynik.score);
      if (komunikat) notify(komunikat, r.number);
    } catch (e) {
      if (e instanceof ApiError) setApiError(e.body);
      else notify("Operacja nie powiodła się", "Spróbuj ponownie.", "err");
    } finally {
      setBusy(false);
    }
  }

  function zmienEtap(nowy: CrmStage): void {
    if (nowy === "lost") {
      setLostOpen(true);
      return;
    }
    void akcja(() => crmApi.setStage(r.id, nowy), "Zmieniono etap");
  }

  return (
      <>
        <div className="toolbar">
          <div>
            <h1>
              <span className="mono">{r.number}</span> — {r.companyName}
            </h1>
            <p className="page-sub">
              {CRM_SOURCE_LABELS[r.source]} · utworzone {dataGodzinaPL(r.createdAt)} · ostatni kontakt{" "}
              {r.lastContactAt ? dataGodzinaPL(r.lastContactAt) : "—"}
            </p>
          </div>
          <div className="actions">
            <button className="sm" onClick={() => navigate(`/crm/requests/${r.id}/edit`)}>
              Edytuj dane
            </button>
            <button className="sm" onClick={() => setFuOpen(true)}>
              Zaplanuj kontakt
            </button>
            <button
                className="sm primary"
                disabled={busy}
                onClick={() =>
                    void akcja(() => crmApi.generateMissingDataMessage(r.id), "Wygenerowano wiadomość")
                }
            >
              Poproś o uzupełnienie
            </button>
          </div>
        </div>

        <ErrorBanner error={apiError} />

        <div className="crm-detail">
          {/* ------------------------------ lewa kolumna ------------------------------ */}
          <div className="crm-main">
            <div className="card">
              <div className="section-title">Dane klienta</div>
              <dl className="crm-dl two">
                <dt>Firma / klient</dt>
                <dd>{r.companyName}</dd>
                <dt>Osoba kontaktowa</dt>
                <dd>{r.contactName}</dd>
                <dt>E-mail</dt>
                <dd className="mono">{r.email}</dd>
                <dt>Telefon</dt>
                <dd className="mono">{r.phone ?? <span className="brak">brak</span>}</dd>
                <dt>Adres</dt>
                <dd>{r.address ?? <span className="brak">brak</span>}</dd>
                <dt>Termin</dt>
                <dd className="mono">{r.deadline ? dataPL(r.deadline) : <span className="brak">brak</span>}</dd>
              </dl>

              <div className="section-title" style={{ marginTop: 16 }}>
                Zakres zapytania
              </div>
              <p className="crm-desc">{r.description}</p>
              <dl className="crm-dl two">
                <dt>Produkty / usługi</dt>
                <dd>{r.products ?? <span className="brak">nie określono</span>}</dd>
                <dt>Ilość</dt>
                <dd>{r.quantity ?? <span className="brak">nie określono</span>}</dd>
              </dl>
            </div>

            <div className="card">
              <div className="section-title">Załączniki i braki</div>
              {r.attachments.length === 0 ? (
                  <p className="crm-note warn">Brak załączników przy zapytaniu.</p>
              ) : (
                  <ul className="crm-files">
                    {r.attachments.map((a) => (
                        <li key={a.id}>
                    <span className="ico" aria-hidden="true">
                      📎
                    </span>
                          <span className="nm">{a.name}</span>
                          <span className="kind">{ATTACHMENT_KIND_LABELS[a.kind]}</span>
                          <span className="mono muted">{a.sizeKb} kB</span>
                        </li>
                    ))}
                  </ul>
              )}
              <div className="section-title" style={{ marginTop: 14 }}>
                Brakujące informacje
              </div>
              <MissingList req={r} />
            </div>

            {zrodlowa && (
                <div className="card">
                  <div className="section-title">Wiadomość źródłowa</div>
                  <div className="crm-mail-head">
                    <div>
                      <b>{zrodlowa.subject}</b>
                      <div className="muted">
                        {zrodlowa.from} &lt;{zrodlowa.fromEmail}&gt; · {dataGodzinaPL(zrodlowa.receivedAt)}
                      </div>
                    </div>
                    <Link className="crm-btn-link" to="/crm/mailbox">
                      Otwórz w skrzynce
                    </Link>
                  </div>
                  <pre className="crm-mail-body">{zrodlowa.body}</pre>
                </div>
            )}

            <div className="card">
              <div className="section-title">Follow-upy</div>
              {r.followUps.length === 0 ? (
                  <EmptyState text="Nie zaplanowano jeszcze żadnego kontaktu." hint="Użyj przycisku „Zaplanuj kontakt”." />
              ) : (
                  <table className="crm-mini">
                    <tbody>
                    {[...r.followUps]
                        .sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`))
                        .map((f) => (
                            <tr key={f.id}>
                              <td className="mono">
                                {dataPL(f.date)} {f.time}
                              </td>
                              <td>{FOLLOWUP_TYPE_LABELS[f.type]}</td>
                              <td>{f.note}</td>
                              <td>
                                <FollowUpBadge status={f.status} />
                              </td>
                              <td className={f.status === "overdue" ? "late-txt" : "muted"}>
                                {f.status === "done" ? dataPL(f.doneAt) : terminOpis(f.date)}
                              </td>
                              <td style={{ width: 150, textAlign: "right" }}>
                                {(f.status === "planned" || f.status === "overdue") && (
                                    <>
                                      <button
                                          className="sm"
                                          disabled={busy}
                                          onClick={() =>
                                              void akcja(() => crmApi.doneFollowUp(r.id, f.id), "Follow-up wykonany")
                                          }
                                      >
                                        Wykonany
                                      </button>{" "}
                                      <button
                                          className="ghost"
                                          disabled={busy}
                                          onClick={() => void akcja(() => crmApi.skipFollowUp(r.id, f.id))}
                                      >
                                        pomiń
                                      </button>
                                    </>
                                )}
                              </td>
                            </tr>
                        ))}
                    </tbody>
                  </table>
              )}
            </div>

            <div className="card">
              <div className="section-title">Wiadomości do klienta</div>
              {r.messages.length === 0 ? (
                  <EmptyState
                      text="Nie wygenerowano jeszcze żadnej wiadomości."
                      hint="Prośbę o uzupełnienie danych utworzysz przyciskiem w nagłówku."
                  />
              ) : (
                  <ul className="crm-msgs">
                    {[...r.messages].reverse().map((m) => (
                        <li key={m.id}>
                          <div className="hd">
                      <span className={`crm-flag ${m.sentAt ? "ok" : "info"}`}>
                        {m.sentAt ? "Wysłana" : "Do wysłania"}
                      </span>
                            <b>{m.subject}</b>
                            <span className="muted">{CRM_MESSAGE_KIND_LABELS[m.kind]}</span>
                            <span className="spacer" />
                            <span className="muted mono">
                        {m.sentAt ? dataGodzinaPL(m.sentAt) : dataGodzinaPL(m.createdAt)}
                      </span>
                            <button className="sm" onClick={() => setPodglad(m)}>
                              {m.sentAt ? "Podgląd" : "Podgląd i wysyłka"}
                            </button>
                          </div>
                          <p className="pre">{m.body.split("\n").slice(0, 2).join(" ")}…</p>
                        </li>
                    ))}
                  </ul>
              )}
            </div>

            <div className="card">
              <div className="section-title">Historia aktywności</div>
              <ol className="crm-timeline">
                {[...r.activity].reverse().map((a) => (
                    <li key={a.id}>
                      <span className="dot" aria-hidden="true" />
                      <span className="mono when">{dataGodzinaPL(a.at)}</span>
                      <span className="kind">{ACTIVITY_KIND_LABELS[a.kind]}</span>
                      <span className="txt">{a.text}</span>
                      <span className="who mono">{a.user}</span>
                    </li>
                ))}
              </ol>
            </div>
          </div>

          {/* ------------------------------ prawa kolumna ----------------------------- */}
          <aside className="crm-side">
            <div className="card">
              <div className="section-title">Etap sprzedażowy</div>
              <div className="crm-stage-now">
                <StageBadge stage={r.stage} />
              </div>
              <select
                  aria-label="Zmień etap"
                  data-assistant-id="field.crm-stage"
                  value={r.stage}
                  disabled={busy}
                  onChange={(e) => zmienEtap(e.target.value as CrmStage)}
              >
                {CRM_STAGES.map((s) => (
                    <option key={s} value={s}>
                      {CRM_STAGE_LABELS[s]}
                    </option>
                ))}
              </select>
              {r.stage === "lost" && (
                  <div className="crm-lost">
                    <div className="section-title" style={{ marginTop: 12 }}>
                      Przyczyna przegranej
                    </div>
                    <p className="crm-note danger">
                      {r.lostReason ? LOST_REASON_LABELS[r.lostReason] : "nie wskazano"}
                      {r.lostReasonNote ? ` — ${r.lostReasonNote}` : ""}
                    </p>
                    <button className="sm" onClick={() => setLostOpen(true)}>
                      Zmień przyczynę
                    </button>
                  </div>
              )}
            </div>

            <div className="card">
              <div className="section-title">Opiekun zapytania</div>
              <div style={{ marginBottom: 8 }}>
                <Assignee employee={opiekun} />
                {opiekun && <div className="muted">{CRM_EMPLOYEE_ROLE_LABELS[opiekun.role]}</div>}
              </div>
              <select
                  aria-label="Przydziel pracownika"
                  data-assistant-id="field.crm-assignee"
                  value={r.assigneeId ?? ""}
                  disabled={busy}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "") return;
                    void akcja(() => crmApi.assign(r.id, v), "Przydzielono pracownika");
                  }}
              >
                <option value="">— wybierz pracownika —</option>
                {employees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name} · {CRM_EMPLOYEE_ROLE_LABELS[e.role]}
                    </option>
                ))}
              </select>
              <p className="hint">
                Przydzielenie generuje wiadomość informującą klienta o opiekunie sprawy.
                Operacja dostępna dla roli „Kierownik”.
              </p>
            </div>

            <div className="card">
              <div className="section-title">Scoring</div>
              <ScoreBar value={r.score} width={220} />
              <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={score}
                  aria-label="Wartość scoringu"
                  onChange={(e) => setScore(Number(e.target.value))}
                  style={{ width: "100%", marginTop: 10 }}
              />
              <div className="crm-score-row">
                <span className="mono">{score}%</span>
                <button
                    className="sm"
                    disabled={busy || score === r.score}
                    onClick={() => void akcja(() => crmApi.setScore(r.id, score), "Zapisano scoring")}
                >
                  Zapisz
                </button>
                <span className="spacer" />
                <button
                    className="ghost"
                    title="Wartość z reguły demonstracyjnej"
                    onClick={() => setScore(podpowiedz)}
                >
                  podpowiedź: {podpowiedz}%
                </button>
              </div>
            </div>

            <div className="card">
              <div className="section-title">Kompletność danych</div>
              <CompletenessBadge req={r} />
              <div style={{ marginTop: 10 }}>
                <MissingList req={r} />
              </div>
              {kompletnosc.status !== "complete" && (
                  <button
                      className="sm"
                      style={{ marginTop: 10 }}
                      disabled={busy}
                      onClick={() =>
                          void akcja(() => crmApi.generateMissingDataMessage(r.id), "Wygenerowano wiadomość")
                      }
                  >
                    Wygeneruj prośbę o dane
                  </button>
              )}
            </div>
          </aside>
        </div>

        {lostOpen && (
            <LostReasonModal
                req={r}
                onClose={() => setLostOpen(false)}
                onSaved={(x) => {
                  setReq(x);
                  setScore(x.score);
                }}
            />
        )}

        {fuOpen && (
            <FollowUpModal
                req={r}
                onClose={() => setFuOpen(false)}
                onSaved={(x) => {
                  setReq(x);
                  notify("Zaplanowano kontakt", x.number);
                }}
            />
        )}

        {podglad && (
            <MessagePreviewModal
                req={r}
                msg={podglad}
                onClose={() => setPodglad(null)}
                onSent={(x) => {
                  setReq(x);
                  setPodglad(null);
                }}
            />
        )}
      </>
  );
}

// ---------------------------- okno: nowy follow-up -------------------------

function FollowUpModal({
                         req,
                         onClose,
                         onSaved,
                       }: {
  req: CrmRequest;
  onClose: () => void;
  onSaved: (r: CrmRequest) => void;
}) {
  const jutro = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const [date, setDate] = useState(jutro);
  const [time, setTime] = useState("09:00");
  const [type, setType] = useState<FollowUpType>("phone");
  const [note, setNote] = useState("");
  const [blad, setBlad] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function zapisz(): Promise<void> {
    if (note.trim().length < 3) {
      setBlad("Dodaj krótką notatkę — czego ma dotyczyć kontakt.");
      return;
    }
    setBusy(true);
    try {
      const r = await crmApi.addFollowUp(req.id, { date, time, type, note: note.trim() });
      onSaved(r);
      onClose();
    } catch (e) {
      setBlad(e instanceof ApiError ? e.body.message : "Nie udało się zapisać kontaktu.");
    } finally {
      setBusy(false);
    }
  }

  return (
      <Modal
          title={`Zaplanuj kontakt — ${req.number}`}
          onClose={onClose}
          footer={
            <>
              <span className="spacer" />
              <button onClick={onClose}>Anuluj</button>
              <button className="primary" onClick={() => void zapisz()} disabled={busy}>
                {busy ? "Zapisywanie…" : "Zaplanuj"}
              </button>
            </>
          }
      >
        <div className="grid">
          <div className="f-row">
            <label htmlFor="fu-date">Data</label>
            <input id="fu-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="f-row">
            <label htmlFor="fu-time">Godzina</label>
            <input id="fu-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
          <div className="f-row">
            <label htmlFor="fu-type">Typ kontaktu</label>
            <select id="fu-type" value={type} onChange={(e) => setType(e.target.value as FollowUpType)}>
              {FOLLOWUP_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {FOLLOWUP_TYPE_LABELS[t]}
                  </option>
              ))}
            </select>
          </div>
        </div>
        <div className="f-row" style={{ marginTop: 12 }}>
          <label htmlFor="fu-note">Notatka</label>
          <textarea
              id="fu-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="np. dopytać o decyzję po wysłanej ofercie"
          />
        </div>
        {blad && <p className="crm-note danger">{blad}</p>}
      </Modal>
  );
}

// ------------------------ okno: podgląd i wysyłka mocka --------------------

function MessagePreviewModal({
                               req,
                               msg,
                               onClose,
                               onSent,
                             }: {
  req: CrmRequest;
  msg: CrmMessage;
  onClose: () => void;
  onSent: (r: CrmRequest) => void;
}) {
  const [subject, setSubject] = useState(msg.subject);
  const [body, setBody] = useState(msg.body);
  const [busy, setBusy] = useState(false);
  const wyslana = msg.sentAt != null;

  async function wyslij(): Promise<void> {
    setBusy(true);
    try {
      const r = await crmApi.sendMessage(req.id, msg.id, { subject, body });
      notify("Wiadomość wysłana", `${msg.to} · wysyłka symulowana`);
      onSent(r);
    } catch {
      notify("Nie udało się wysłać", "Spróbuj ponownie.", "err");
    } finally {
      setBusy(false);
    }
  }

  return (
      <Modal
          title={CRM_MESSAGE_KIND_LABELS[msg.kind]}
          wide
          onClose={onClose}
          footer={
            <>
              <span className="crm-mock-tag">wysyłka symulowana — brak połączenia z serwerem poczty</span>
              <span className="spacer" />
              <button onClick={onClose}>Zamknij</button>
              {!wyslana && (
                  <button className="primary" onClick={() => void wyslij()} disabled={busy}>
                    {busy ? "Wysyłanie…" : "Wyślij"}
                  </button>
              )}
            </>
          }
      >
        <div className="grid two">
          <div className="f-row">
            <label htmlFor="msg-to">Do</label>
            <input id="msg-to" value={msg.to} disabled />
          </div>
          <div className="f-row">
            <label htmlFor="msg-subject">Temat</label>
            <input
                id="msg-subject"
                value={subject}
                disabled={wyslana}
                onChange={(e) => setSubject(e.target.value)}
            />
          </div>
        </div>
        <div className="f-row" style={{ marginTop: 12 }}>
          <label htmlFor="msg-body">Treść</label>
          <textarea
              id="msg-body"
              className="crm-msg-body"
              value={body}
              disabled={wyslana}
              onChange={(e) => setBody(e.target.value)}
          />
        </div>
        {wyslana && (
            <p className="crm-note ok">Wiadomość wysłana {dataGodzinaPL(msg.sentAt)} — treść zablokowana do edycji.</p>
        )}
      </Modal>
  );
}