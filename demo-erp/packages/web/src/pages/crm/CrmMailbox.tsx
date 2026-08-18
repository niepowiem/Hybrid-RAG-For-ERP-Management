/**
 * CrmMailbox.tsx — skrzynka zapytań przychodzących.
 *
 * Widok master-detail: po lewej lista pobranych wiadomości, po prawej treść
 * z wynikiem automatycznego przetwarzania — kategoria, dane wyodrębnione
 * z tekstu, załączniki, ewentualne ostrzeżenie o duplikacie.
 *
 * Pobieranie obsługuje serwis crm/poller.ts (co 30 s). Ten komponent tylko
 * pokazuje jego stan i wywołuje „Sprawdź teraz”. Rozdział jest celowy:
 * po podmianie atrapy na prawdziwą pocztę ten plik nie wymaga zmian.
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ATTACHMENT_KIND_LABELS,
  MAIL_CATEGORIES,
  MAIL_CATEGORY_LABELS,
  MAIL_STATUSES,
  MAIL_STATUS_LABELS,
} from "@demo-erp/shared";
import type { InboxMessage, MailCategory, MailStatus } from "@demo-erp/shared";
import { notify } from "../../ui.js";
import { ApiError } from "../../api.js";
import { crmApi } from "../../crm/client.js";
import { podmienWiadomosc, sprawdzSkrzynke, useMailbox, POLL_INTERVAL_MS } from "../../crm/poller.js";
import { EmptyState, MailStatusBadge } from "../../crm/components.js";
import { dataGodzinaPL } from "../../crm/format.js";

export function CrmMailboxPage() {
  const mailbox = useMailbox();
  const [wybrana, setWybrana] = useState<string | null>(null);
  const [status, setStatus] = useState<MailStatus | "">("");
  const [kategoria, setKategoria] = useState<MailCategory | "">("");
  const [busy, setBusy] = useState(false);

  const widoczne = useMemo(
      () =>
          mailbox.messages.filter(
              (m) => (status === "" || m.status === status) && (kategoria === "" || m.category === kategoria),
          ),
      [mailbox.messages, status, kategoria],
  );

  // Pierwsza wiadomość zaznacza się sama — pusty panel po prawej wygląda
  // na awarię, a nie na stan wyjściowy.
  useEffect(() => {
    if (wybrana == null && widoczne.length > 0) setWybrana(widoczne[0]!.id);
  }, [widoczne, wybrana]);

  const msg = mailbox.messages.find((m) => m.id === wybrana) ?? null;

  async function akcja(fn: () => Promise<InboxMessage>, komunikat: string): Promise<void> {
    setBusy(true);
    try {
      const m = await fn();
      podmienWiadomosc(m);
      notify(komunikat, m.subject);
    } catch (e) {
      notify("Operacja nie powiodła się", e instanceof ApiError ? e.body.message : "Spróbuj ponownie.", "err");
    } finally {
      setBusy(false);
    }
  }

  async function akceptuj(m: InboxMessage): Promise<void> {
    setBusy(true);
    try {
      const wynik = await crmApi.acceptMessage(m.id);
      podmienWiadomosc(wynik.message);
      notify("Utworzono zapytanie CRM", `${wynik.request.number} · ${wynik.request.companyName}`);
    } catch (e) {
      notify("Nie udało się utworzyć zapytania", e instanceof ApiError ? e.body.message : "Spróbuj ponownie.", "err");
    } finally {
      setBusy(false);
    }
  }

  const noweCount = mailbox.messages.filter((m) => m.status === "new" || m.status === "processing").length;
  const doWeryfikacji = mailbox.messages.filter((m) => m.status === "needs_review").length;

  return (
      <>
        <div className="toolbar">
          <div>
            <h1>Skrzynka zapytań</h1>
            <p className="page-sub">
              Wiadomości pobierane automatycznie co {Math.round(POLL_INTERVAL_MS / 1000)} sekund,
              klasyfikowane i przetwarzane bez udziału operatora.
            </p>
          </div>
          <div className="actions">
            <button
                className="sm primary"
                data-assistant-id="btn.crm-poll"
                disabled={mailbox.loading}
                onClick={() => void sprawdzSkrzynke(true)}
            >
              {mailbox.loading ? "Sprawdzanie…" : "Sprawdź teraz"}
            </button>
          </div>
        </div>

        <div className={`crm-poll-bar ${mailbox.error ? "err" : ""}`} role="status" aria-live="polite">
          <span className={`led ${mailbox.loading ? "busy" : mailbox.error ? "err" : "ok"}`} aria-hidden="true" />
          <span>
          <b>Źródło:</b> {mailbox.adapter}
        </span>
          <span>
          <b>Ostatnie sprawdzenie:</b>{" "}
            <span className="mono">
            {mailbox.loading ? "trwa pobieranie…" : dataGodzinaPL(mailbox.state?.lastCheckedAt ?? null)}
          </span>
        </span>
          <span>
          <b>Nowe w ostatnim cyklu:</b> <span className="mono">{mailbox.state?.newCount ?? 0}</span>
        </span>
          <span>
          <b>W skrzynce:</b> <span className="mono">{mailbox.messages.length}</span>
        </span>
          <span className="spacer" />
          {doWeryfikacji > 0 && <span className="crm-flag warn">do weryfikacji: {doWeryfikacji}</span>}
          {noweCount > 0 && <span className="crm-flag info">w przetwarzaniu: {noweCount}</span>}
          <span className="crm-mock-tag">integracja pocztowa: atrapa</span>
        </div>

        {mailbox.error && (
            <div className="error-banner" role="alert">
              <span className="code">ERR-9005</span>
              <p className="msg">
                Nie udało się pobrać wiadomości: {mailbox.error} Automat spróbuje ponownie w kolejnym cyklu.
              </p>
            </div>
        )}

        <div className="filters">
          <div className="f">
            <label htmlFor="mb-status">Status przetwarzania</label>
            <select id="mb-status" value={status} onChange={(e) => setStatus(e.target.value as MailStatus | "")}>
              <option value="">wszystkie</option>
              {MAIL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {MAIL_STATUS_LABELS[s]}
                  </option>
              ))}
            </select>
          </div>
          <div className="f">
            <label htmlFor="mb-cat">Kategoria</label>
            <select id="mb-cat" value={kategoria} onChange={(e) => setKategoria(e.target.value as MailCategory | "")}>
              <option value="">wszystkie</option>
              {MAIL_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {MAIL_CATEGORY_LABELS[c]}
                  </option>
              ))}
            </select>
          </div>
          <span className="spacer" />
          <span className="result-count">
          {widoczne.length} / {mailbox.messages.length}
        </span>
        </div>

        <div className="crm-inbox">
          <div className="crm-inbox-list">
            {!mailbox.ready && (
                <>
                  <div className="crm-card-skeleton" />
                  <div className="crm-card-skeleton" />
                  <div className="crm-card-skeleton" />
                </>
            )}
            {mailbox.ready && widoczne.length === 0 && (
                <EmptyState text="Brak wiadomości spełniających kryteria." hint="Zmień filtry lub sprawdź skrzynkę." />
            )}
            {widoczne.map((m) => (
                <button
                    key={m.id}
                    className={`crm-inbox-item ${m.id === wybrana ? "sel" : ""} ${m.status === "needs_review" ? "warn" : ""}`}
                    onClick={() => setWybrana(m.id)}
                >
                  <div className="l1">
                    <b>{m.from}</b>
                    <span className="spacer" />
                    <span className="mono muted">{dataGodzinaPL(m.receivedAt)}</span>
                  </div>
                  <div className="l2">{m.subject}</div>
                  <div className="l3">
                    <MailStatusBadge status={m.status} />
                    <span className={`crm-flag ${m.category === "inquiry" ? "ok" : "muted"}`}>
                  {MAIL_CATEGORY_LABELS[m.category]}
                </span>
                    {m.attachments.length > 0 && (
                        <span className="muted mono" title="Załączniki">
                    📎 {m.attachments.length}
                  </span>
                    )}
                    {m.crmRequestId && <span className="crm-flag info">zapytanie utworzone</span>}
                  </div>
                </button>
            ))}
          </div>

          <div className="crm-inbox-detail card">
            {!msg ? (
                <EmptyState text="Wybierz wiadomość z listy." />
            ) : (
                <>
                  <div className="crm-mail-head">
                    <div>
                      <b>{msg.subject}</b>
                      <div className="muted">
                        {msg.from} &lt;{msg.fromEmail}&gt; · {dataGodzinaPL(msg.receivedAt)}
                      </div>
                    </div>
                    <MailStatusBadge status={msg.status} />
                  </div>

                  {msg.note && (
                      <p className={`crm-note ${msg.status === "error" ? "danger" : msg.status === "needs_review" ? "warn" : ""}`}>
                        {msg.note}
                        {msg.duplicateOfId && (
                            <>
                              {" "}
                              <Link to={`/crm/requests/${msg.duplicateOfId}`}>Otwórz powiązane zapytanie</Link>
                            </>
                        )}
                      </p>
                  )}

                  <div className="crm-inbox-actions">
                    <div className="f-row" style={{ maxWidth: 220 }}>
                      <label htmlFor="mb-set-cat">Kategoria wiadomości</label>
                      <select
                          id="mb-set-cat"
                          value={msg.category}
                          disabled={busy}
                          onChange={(e) =>
                              void akcja(
                                  () => crmApi.setCategory(msg.id, e.target.value as MailCategory),
                                  "Zmieniono kategorię",
                              )
                          }
                      >
                        {MAIL_CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {MAIL_CATEGORY_LABELS[c]}
                            </option>
                        ))}
                      </select>
                    </div>
                    <span className="spacer" />
                    {msg.crmRequestId ? (
                        <Link className="crm-btn-link" to={`/crm/requests/${msg.crmRequestId}`}>
                          Otwórz zapytanie CRM
                        </Link>
                    ) : (
                        <button className="primary sm" disabled={busy} onClick={() => void akceptuj(msg)}>
                          Utwórz zapytanie CRM
                        </button>
                    )}
                    <button
                        className="sm"
                        disabled={busy || msg.status === "needs_review"}
                        onClick={() => void akcja(() => crmApi.reviewMessage(msg.id), "Oznaczono do weryfikacji")}
                    >
                      Do weryfikacji
                    </button>
                    <button
                        className="sm"
                        disabled={busy || msg.status === "skipped"}
                        onClick={() => void akcja(() => crmApi.rejectMessage(msg.id), "Wiadomość odrzucona")}
                    >
                      Odrzuć
                    </button>
                  </div>

                  <div className="section-title">Treść wiadomości</div>
                  <pre className="crm-mail-body">{msg.body}</pre>

                  <div className="section-title">Załączniki</div>
                  {msg.attachments.length === 0 ? (
                      <p className="crm-note">Wiadomość bez załączników.</p>
                  ) : (
                      <ul className="crm-files">
                        {msg.attachments.map((a) => (
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

                  <div className="section-title">Dane wyodrębnione automatycznie</div>
                  {msg.extracted == null ? (
                      <p className="crm-note">
                        Wiadomość nie została zaklasyfikowana jako zapytanie ofertowe — danych nie wyodrębniano.
                      </p>
                  ) : (
                      <dl className="crm-dl two">
                        <Pole label="Nazwa firmy" v={msg.extracted.companyName} />
                        <Pole label="Osoba kontaktowa" v={msg.extracted.contactName} />
                        <Pole label="E-mail" v={msg.extracted.email} mono />
                        <Pole label="Telefon" v={msg.extracted.phone} mono />
                        <Pole label="Adres" v={msg.extracted.address} />
                        <Pole label="Produkty / usługi" v={msg.extracted.products} />
                        <Pole label="Ilość" v={msg.extracted.quantity} />
                        <Pole label="Termin" v={msg.extracted.deadline} mono />
                        <Pole label="Opis" v={msg.extracted.description} />
                      </dl>
                  )}
                </>
            )}
          </div>
        </div>
      </>
  );
}

function Pole({ label, v, mono }: { label: string; v: string | null; mono?: boolean }) {
  return (
      <>
        <dt>{label}</dt>
        <dd className={mono ? "mono" : ""}>{v ?? <span className="brak">nie odczytano</span>}</dd>
      </>
  );
}