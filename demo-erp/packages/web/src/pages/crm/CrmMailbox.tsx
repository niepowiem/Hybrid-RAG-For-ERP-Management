/** Skrzynka zapytań — kafelki wiadomości i spójny z kartą sprawy panel roboczy. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ATTACHMENT_KIND_LABELS,
  MAIL_CATEGORIES,
  MAIL_CATEGORY_LABELS,
  MAIL_STATUS_LABELS,
} from "@demo-erp/shared";
import type { CrmSettings, InboxMessage, MailCategory, MailStatus } from "@demo-erp/shared";
import { notify } from "../../ui.js";
import { ApiError } from "../../api.js";
import { crmApi } from "../../crm/client.js";
import { podmienWiadomosc, sprawdzSkrzynke, useMailbox, POLL_INTERVAL_MS } from "../../crm/poller.js";
import { EmptyState, MailStatusBadge } from "../../crm/components.js";
import { dataGodzinaPL } from "../../crm/format.js";
import { PodgladTresci, type Podstawienie } from "../../crm/MessageEditor.js";

type MailboxStatusFilter = MailStatus | "";
type MailboxQuickFilter = "" | "new_group" | "approval" | "needs_review";

export function CrmMailboxPage() {
  const mailbox = useMailbox();
  const [wybrana, setWybrana] = useState<string | null>(null);
  const [status, setStatus] = useState<MailboxStatusFilter>("");
  const [quickFilter, setQuickFilter] = useState<MailboxQuickFilter>("");
  const [kategoria, setKategoria] = useState<MailCategory | "">("");
  const [automationSettings, setAutomationSettings] = useState<CrmSettings["automation"] | null>(null);
  const [savingClassificationMode, setSavingClassificationMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const listaRef = useRef<HTMLDivElement>(null);
  const [weryfikacjaPozaWidokiem, setWeryfikacjaPozaWidokiem] = useState({ gora: false, dol: false });

  const widoczne = useMemo(
    () => mailbox.messages.filter(
      (message) =>
        (quickFilter === "" || (quickFilter === "new_group"
          ? message.status === "new" || message.status === "processing"
          : quickFilter === "approval"
              ? message.category === "inquiry" && message.crmRequestId == null && message.status !== "skipped"
              : quickFilter === "needs_review"
                  ? message.status === "needs_review" && !(message.category === "inquiry" && message.crmRequestId == null)
                  : true)) &&
        (status === "" || message.status === status) &&
        (kategoria === "" || message.category === kategoria),
    ),
    [mailbox.messages, quickFilter, status, kategoria],
  );

  function ustawSzybkiFiltr(next: MailboxQuickFilter): void {
    setStatus("");
    setKategoria("");
    setQuickFilter((current) => current === next ? "" : next);
  }

  useEffect(() => {
    if (widoczne.length === 0) {
      setWybrana(null);
      return;
    }
    if (!widoczne.some((message) => message.id === wybrana)) setWybrana(widoczne[0]!.id);
  }, [widoczne, wybrana]);

  useEffect(() => {
    let active = true;
    void crmApi.settings()
        .then((settings) => { if (active) setAutomationSettings(settings.automation); })
        .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const msg = mailbox.messages.find((message) => message.id === wybrana) ?? null;
  const oznaczeniaWiadomosci = useMemo(() => msg ? wykryjOznaczenia(msg) : [], [msg]);

  const aktualizujWskaznikiWeryfikacji = useCallback((): void => {
    const lista = listaRef.current;
    if (!lista) return;
    const obszar = lista.getBoundingClientRect();
    let gora = false;
    let dol = false;
    for (const element of Array.from(lista.querySelectorAll<HTMLElement>('[data-review="true"]'))) {
      const pozycja = element.getBoundingClientRect();
      if (pozycja.bottom <= obszar.top + 1) gora = true;
      if (pozycja.top >= obszar.bottom - 1) dol = true;
    }
    setWeryfikacjaPozaWidokiem((obecne) =>
        obecne.gora === gora && obecne.dol === dol ? obecne : { gora, dol },
    );
  }, []);

  useEffect(() => {
    const klatka = window.requestAnimationFrame(aktualizujWskaznikiWeryfikacji);
    window.addEventListener("resize", aktualizujWskaznikiWeryfikacji);
    return () => {
      window.cancelAnimationFrame(klatka);
      window.removeEventListener("resize", aktualizujWskaznikiWeryfikacji);
    };
  }, [aktualizujWskaznikiWeryfikacji, widoczne]);

  function przewinDoWeryfikacji(kierunek: "gora" | "dol"): void {
    const lista = listaRef.current;
    if (!lista) return;
    const obszar = lista.getBoundingClientRect();
    const pozaWidokiem = Array.from(lista.querySelectorAll<HTMLElement>('[data-review="true"]')).filter((element) => {
      const pozycja = element.getBoundingClientRect();
      return kierunek === "gora" ? pozycja.bottom <= obszar.top + 1 : pozycja.top >= obszar.bottom - 1;
    });
    const cel = kierunek === "gora" ? pozaWidokiem.at(-1) : pozaWidokiem[0];
    if (!cel) return;
    lista.scrollTo({
      top: cel.offsetTop - lista.clientHeight / 2 + cel.offsetHeight / 2,
      behavior: "smooth",
    });
  }

  async function akcja(fn: () => Promise<InboxMessage>, komunikat: string): Promise<void> {
    setBusy(true);
    try {
      const message = await fn();
      podmienWiadomosc(message);
      notify(komunikat, message.subject);
    } catch (error) {
      notify(
        "Operacja nie powiodła się",
        error instanceof ApiError ? error.body.message : "Spróbuj ponownie.",
        "err",
      );
    } finally {
      setBusy(false);
    }
  }

  async function akceptuj(message: InboxMessage): Promise<void> {
    const potwierdzone = window.confirm(
      `Czy na pewno chcesz dodać do CRM wiadomość „${message.subject}” jako zapytanie ofertowe?`,
    );
    if (!potwierdzone) return;
    setBusy(true);
    try {
      if (message.category !== "inquiry") {
        const sklasyfikowana = await crmApi.setCategory(message.id, "inquiry");
        podmienWiadomosc(sklasyfikowana);
      }
      const wynik = await crmApi.acceptMessage(message.id);
      podmienWiadomosc(wynik.message);
      notify("Utworzono zapytanie CRM", `${wynik.request.number} · ${wynik.request.companyName}`);
    } catch (error) {
      notify(
        "Nie udało się utworzyć zapytania",
        error instanceof ApiError ? error.body.message : "Spróbuj ponownie.",
        "err",
      );
    } finally {
      setBusy(false);
    }
  }

  async function changeClassificationMode(mode: CrmSettings["automation"]["mailClassificationMode"]): Promise<void> {
    if (!automationSettings || mode === automationSettings.mailClassificationMode) return;
    const previous = automationSettings;
    const next = { ...automationSettings, mailClassificationMode: mode };
    setAutomationSettings(next);
    setSavingClassificationMode(true);
    try {
      const saved = await crmApi.saveSettings({ automation: next });
      setAutomationSettings(saved.automation);
      notify(
        mode === "automatic" ? "Włączono klasyfikowanie automatyczne" : "Włączono weryfikację ręczną",
        mode === "automatic"
          ? "Nowe wiadomości będą klasyfikowane automatycznie."
          : "Nowe wiadomości trafią do ręcznej weryfikacji.",
      );
    } catch (error) {
      setAutomationSettings(previous);
      notify("Nie udało się zmienić trybu", error instanceof ApiError ? error.body.message : "Spróbuj ponownie.", "err");
    } finally {
      setSavingClassificationMode(false);
    }
  }

  const noweCount = mailbox.messages.filter(
    (message) => message.status === "new" || message.status === "processing",
  ).length;
  const doZatwierdzenia = mailbox.messages.filter(
    (message) => message.category === "inquiry" && message.crmRequestId == null && message.status !== "skipped",
  ).length;
  const doWeryfikacji = mailbox.messages.filter(
    (message) => message.status === "needs_review" &&
      !(message.category === "inquiry" && message.crmRequestId == null),
  ).length;
  const dgx = mailbox.ai;
  const dgxState = dgx?.state ?? "not_configured";
  const dgxLabel =
      dgxState === "connected"
          ? "DGX połączony"
          : dgxState === "degraded"
              ? "DGX działa częściowo"
              : dgxState === "incompatible"
                  ? "Niezgodny model DGX"
                  : dgxState === "offline" || dgxState === "not_configured"
                      ? "Klasyfikator AI niedostępny"
                      : "DGX działa częściowo";
  const dgxDetail =
      dgx?.classifier.state === "online"
          ? [
            dgx.classifier.modelName?.split("/").at(-1) ?? null,
            dgx.classifier.modelVersion ?? "klasyfikator aktywny",
            dgx.classifier.embeddingDimension ? `${dgx.classifier.embeddingDimension}D` : null,
            dgx.classifier.normalizeEmbeddings === true ? "normalizacja L2" : null,
            dgx.classifier.preprocessingVersion ? `preprocessing v${dgx.classifier.preprocessingVersion}` : null,
            `${Math.round(dgx.classifier.latencyMs ?? 0)} ms`,
          ].filter(Boolean).join(" · ")
          : dgxState === "not_configured" || dgxState === "offline"
              ? "Przełączono na manualną weryfikację skrzynki pocztowej."
              : dgx?.classifier.lastError ?? "Przełączono na manualną weryfikację skrzynki pocztowej.";
  const classificationMode = automationSettings?.mailClassificationMode ?? "automatic";
  const classifierLabel = classificationMode === "manual" ? "Weryfikacja ręczna" : dgxLabel;
  const classifierDetail = classificationMode === "manual" ? "Automatyczne klasyfikowanie wyłączone" : dgxDetail;

  return (
    <section className="page crm-mailbox-page">
      <header className="page-head mb-page-head">
        <div>
          <p className="mb-eyebrow">CRM · poczta przychodząca</p>
          <h1>Skrzynka zapytań</h1>
          <p className="page-sub">
            {classificationMode === "automatic"
              ? `Nowe wiadomości są klasyfikowane automatycznie co ${Math.round(POLL_INTERVAL_MS / 1000)} sekund.`
              : "Nowe wiadomości trafiają do ręcznej weryfikacji."}
          </p>
        </div>
        <span className="spacer" />
        <div
          className={`mb-dgx-state mb-head-ai ${classificationMode === "manual" ? "manual" : dgxState}`}
          title={`${classifierLabel}. ${classifierDetail}`}
        >
          <DgxIcon />
          <span>
            <strong>{classifierLabel}</strong>
            <small>{classifierDetail}</small>
          </span>
          <select
            value={classificationMode}
            disabled={automationSettings == null || savingClassificationMode}
            aria-label="Tryb klasyfikowania wiadomości"
            onChange={(event) => void changeClassificationMode(
              event.target.value as CrmSettings["automation"]["mailClassificationMode"],
            )}
          >
            <option value="automatic">Automatyczny</option>
            <option value="manual">Ręczny</option>
          </select>
        </div>
        <div className={`mb-sync-state mb-head-sync${mailbox.error ? " error" : ""}`} role="status" aria-live="polite">
          <span className={`led ${mailbox.loading ? "busy" : mailbox.error ? "error" : "ok"}`} aria-hidden="true" />
          <span>
            <strong>{mailbox.error ? "Błąd synchronizacji" : mailbox.loading ? "Pobieranie poczty" : "Skrzynka zsynchronizowana"}</strong>
            <small>{mailbox.adapter} · ostatnio {dataGodzinaPL(mailbox.state?.lastCheckedAt ?? null)}</small>
          </span>
        </div>
        <button
          type="button"
          className={`dr-refresh-btn${mailbox.loading ? " pracuje" : ""}`}
          data-assistant-id="btn.crm-poll"
          disabled={mailbox.loading}
          onClick={() => void sprawdzSkrzynke(true)}
        >
          <span className="dr-refresh-ico" aria-hidden="true">↻</span>
          {mailbox.loading ? "Sprawdzanie…" : "Sprawdź teraz"}
        </button>
      </header>

      {mailbox.error && (
        <div className="error-banner" role="alert">
          <span className="code">ERR-9005</span>
          <p className="msg">Nie udało się pobrać wiadomości: {mailbox.error}. Automat spróbuje ponownie.</p>
        </div>
      )}

      <div className="crm-inbox mb-workspace">
        <div className="mb-list-column">
          <div className="mb-list-summary" role="status" aria-live="polite">
            <button
              type="button"
              className={`mb-sync-stat${quickFilter === "" && status === "" && kategoria === "" ? " active" : ""}`}
              aria-pressed={quickFilter === "" && status === "" && kategoria === ""}
              onClick={() => { setQuickFilter(""); setStatus(""); setKategoria(""); }}
            ><strong>{mailbox.messages.length}</strong><span>wszystkich</span></button>
            <button
              type="button"
              className={`mb-sync-stat info${quickFilter === "new_group" ? " active" : ""}`}
              aria-pressed={quickFilter === "new_group"}
              onClick={() => ustawSzybkiFiltr("new_group")}
            ><strong>{noweCount}</strong><span>nowych</span></button>
            <button
              type="button"
              className={`mb-sync-stat approval${quickFilter === "approval" ? " active" : ""}`}
              aria-pressed={quickFilter === "approval"}
              onClick={() => ustawSzybkiFiltr("approval")}
            ><strong>{doZatwierdzenia}</strong><span>do zatwierdzenia</span></button>
            <button
              type="button"
              className={`mb-sync-stat warn${quickFilter === "needs_review" ? " active" : ""}`}
              aria-pressed={quickFilter === "needs_review"}
              onClick={() => ustawSzybkiFiltr("needs_review")}
            ><strong>{doWeryfikacji}</strong><span>do weryfikacji</span></button>
          </div>
          <aside className="mb-list-panel" aria-label="Lista wiadomości">
            <div className="mb-list-head">
              <div className="mb-list-title">
                <div><h2>Wiadomości</h2><p>Najświeższe zapytania są na górze.</p></div>
              </div>
            <div className="mb-list-controls">
              <label>
                <span>Status</span>
                <select value={status} onChange={(event) => { setQuickFilter(""); setStatus(event.target.value as MailboxStatusFilter); }}>
                  <option value="">Wszystkie statusy</option>
                  <option value="needs_review">{MAIL_STATUS_LABELS.needs_review}</option>
                  <option value="skipped">{MAIL_STATUS_LABELS.skipped}</option>
                </select>
              </label>
              <label>
                <span>Kategoria wiadomości</span>
                <select value={kategoria} onChange={(event) => setKategoria(event.target.value as MailCategory | "")}>
                  <option value="">Wszystkie kategorie</option>
                  {MAIL_CATEGORIES.map((item) => <option key={item} value={item}>{MAIL_CATEGORY_LABELS[item]}</option>)}
                </select>
              </label>
            </div>
          </div>
          <div className="mb-list-scroll-wrap">
            {weryfikacjaPozaWidokiem.gora && (
              <button
                type="button"
                className="mb-review-jump up"
                title="Wiadomość do weryfikacji znajduje się wyżej"
                aria-label="Przewiń do wiadomości wymagającej weryfikacji wyżej"
                onClick={() => przewinDoWeryfikacji("gora")}
              >
                <ReviewScrollIcon direction="up" />
              </button>
            )}
            <div className="crm-inbox-list" ref={listaRef} onScroll={aktualizujWskaznikiWeryfikacji}>
            {!mailbox.ready && <><div className="crm-card-skeleton" /><div className="crm-card-skeleton" /></>}
            {mailbox.ready && widoczne.length === 0 && (
              <EmptyState text="Brak wiadomości spełniających kryteria." hint="Zmień filtry lub odśwież skrzynkę." />
            )}
            {widoczne.map((message) => (
              <div
                role="button"
                tabIndex={0}
                key={message.id}
                data-review={message.status === "needs_review" && !(message.category === "inquiry" && message.crmRequestId == null)}
                className={`crm-inbox-item status-${message.status}${message.category === "inquiry" && message.crmRequestId == null && message.status !== "skipped" ? " approval" : ""} ${message.id === wybrana ? "sel" : ""}`}
                onClick={() => setWybrana(message.id)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setWybrana(message.id);
                  }
                }}
              >
                <div className="mb-card-tags">
                  <span className="crm-flag mb-date-tag">
                    <CalendarIcon />
                    <time>{dataGodzinaPL(message.receivedAt)}</time>
                  </span>
                  {message.category === "inquiry" && message.crmRequestId == null && message.status !== "skipped" ? (
                    <span className="crm-flag ok">{MAIL_CATEGORY_LABELS.inquiry}</span>
                  ) : message.status === "needs_review" ? (
                    <MailStatusBadge status="needs_review" />
                  ) : (
                    <>
                      <span className={`crm-flag ${message.category === "inquiry" ? "ok" : "muted"}`}>
                        {MAIL_CATEGORY_LABELS[message.category]}
                      </span>
                      {message.crmRequestId && <span className="mb-linked" title="Utworzono zapytanie CRM">✓ CRM</span>}
                    </>
                  )}
                </div>
                <div className="mb-card-client">{message.from}</div>
                <div className="mb-card-subject">{message.subject}</div>
                <p className="mb-card-preview">{message.body.replace(/\s+/g, " ").slice(0, 120)}</p>
                {message.attachments.length > 0 && (
                  <span className="tl-files mb-card-files">
                    {message.attachments.map((attachment, index) => (
                      <a
                        className="tl-file mb-card-file"
                        key={attachment.id}
                        href={crmApi.mailboxAttachmentUrl(message.id, attachment.id)}
                        target="_blank"
                        rel="noreferrer"
                        title={`Otwórz załącznik ${attachment.name}`}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <span className="mb-file-index">{index + 1}.</span>
                        <PaperclipIcon />
                        <span>{attachment.name} ({attachment.sizeKb} kB)</span>
                      </a>
                    ))}
                  </span>
                )}
              </div>
            ))}
            </div>
            {weryfikacjaPozaWidokiem.dol && (
              <button
                type="button"
                className="mb-review-jump down"
                title="Wiadomość do weryfikacji znajduje się niżej"
                aria-label="Przewiń do wiadomości wymagającej weryfikacji niżej"
                onClick={() => przewinDoWeryfikacji("dol")}
              >
                <ReviewScrollIcon direction="down" />
              </button>
            )}
          </div>
          </aside>
        </div>

        <article className={`crm-inbox-detail mb-detail${msg ? ` status-${msg.status}` : ""}`}>
          {!msg ? <EmptyState text="Wybierz wiadomość z listy." /> : (
            <>
              <header className="mb-detail-head">
                <div>
                  <div className="mb-detail-tags">
                    <span className="crm-flag mb-date-tag">
                      <CalendarIcon />
                      <time>Otrzymano {dataGodzinaPL(msg.receivedAt)}</time>
                    </span>
                    {msg.category === "inquiry" && msg.crmRequestId == null && msg.status !== "skipped" ? (
                      <span className="crm-flag ok">{MAIL_CATEGORY_LABELS.inquiry}</span>
                    ) : msg.status === "needs_review" ? (
                      <MailStatusBadge status="needs_review" />
                    ) : (
                      <>
                        <span className={`crm-flag ${msg.category === "inquiry" ? "ok" : "muted"}`}>
                          {MAIL_CATEGORY_LABELS[msg.category]}
                        </span>
                      </>
                    )}
                  </div>
                  <h2>{msg.subject}</h2>
                  <p>{msg.from} <span>&lt;{msg.fromEmail}&gt;</span></p>
                </div>
              </header>

              {msg.note && msg.status === "error" && (
                <div className="dr-alert error">
                  <span className="dr-alert-ico" aria-hidden="true">!</span>
                  <p>{msg.note}</p>
                </div>
              )}

              <div className="mb-actions">
                <label>
                  <span>Kategoria wiadomości</span>
                  <select
                    value={msg.category}
                    disabled={busy}
                    onChange={(event) => void akcja(
                      () => crmApi.setCategory(msg.id, event.target.value as MailCategory),
                      "Zmieniono kategorię",
                    )}
                  >
                    {MAIL_CATEGORIES.map((item) => <option key={item} value={item}>{MAIL_CATEGORY_LABELS[item]}</option>)}
                  </select>
                </label>
                {msg.crmRequestId ? (
                  <Link className="mb-action-btn mb-open-crm" to={`/crm/requests/${msg.crmRequestId}`}>Otwórz zapytanie CRM</Link>
                ) : (
                  <button className="primary sm mb-action-btn" disabled={busy} onClick={() => void akceptuj(msg)}>Dodaj do CRM</button>
                )}
                <button
                  className="sm mb-classify-pill other"
                  disabled={busy || msg.crmRequestId != null || msg.status === "skipped"}
                  aria-pressed={msg.category === "other" && msg.status === "skipped"}
                  onClick={() => void akcja(
                    () => crmApi.setCategory(msg.id, "other"),
                    "Sklasyfikowano jako pozostałą wiadomość",
                  )}
                >Sklasyfikuj jako pozostałą wiadomość</button>
                <button
                  className="sm mb-classify-pill inquiry"
                  disabled={busy || msg.crmRequestId != null || (msg.category === "inquiry" && msg.status === "needs_review")}
                  aria-pressed={msg.category === "inquiry" && msg.status === "needs_review" && msg.crmRequestId == null}
                  onClick={() => void akcja(
                    () => crmApi.setCategory(msg.id, "inquiry"),
                    "Sklasyfikowano jako zapytanie",
                  )}
                >Sklasyfikuj jako zapytanie</button>
              </div>

              <div className="mb-detail-body mb-detail-panels">
                <div className="mb-data-column">
                  <section className="dr-card mb-detail-panel mb-data-panel">
                    <div className="dr-card-head mb-panel-head">
                      <div><h4>Dane firmy</h4><p>Informacje rozpoznane w treści wiadomości.</p></div>
                    </div>
                    <div className="mb-data-list">
                      <Pole label="Nazwa firmy" value={msg.extracted?.companyName ?? null} />
                      <Pole label="Adres" value={msg.extracted?.address ?? null} />
                    </div>
                  </section>
                  <section className="dr-card mb-detail-panel mb-data-panel">
                    <div className="dr-card-head mb-panel-head">
                      <div><h4>Dane kontaktowe</h4><p>Nadawca i dane osoby kontaktowej.</p></div>
                    </div>
                    <div className="mb-data-list">
                      <Pole label="Osoba kontaktowa" value={msg.extracted?.contactName ?? null} />
                      <Pole label="E-mail" value={msg.extracted?.email ?? null} mono />
                      <Pole label="Telefon" value={msg.extracted?.phone ?? null} mono />
                    </div>
                  </section>
                  <section className="dr-card mb-detail-panel mb-data-panel">
                    <div className="dr-card-head mb-panel-head">
                      <div><h4>Termin</h4><p>Termin wskazany przez klienta.</p></div>
                    </div>
                    <div className="mb-data-list">
                      <Pole label="Termin realizacji" value={msg.extracted?.deadline ?? null} mono />
                    </div>
                  </section>
                  <section className={`dr-card mb-detail-panel mb-data-panel mb-classifier-panel${msg.classification?.source === "dgx" ? " spark" : ""}`}>
                    <div className="dr-card-head mb-panel-head">
                      <div>
                        <h4>
                          Klasyfikator
                          {msg.classification?.source === "dgx" && (
                            <span className="mb-ai-star" title="Wiadomość sklasyfikowana przez AI" aria-label="Sklasyfikowane przez AI">★</span>
                          )}
                        </h4>
                        <p>Wynik zapisany podczas sprawdzania wiadomości.</p>
                      </div>
                    </div>
                    <div className="mb-classifier-cells">
                      <div className="mb-classifier-cell">
                        <span>Model</span>
                        <strong>{msg.classification
                          ? msg.classification.modelName?.split("/").at(-1)
                              ?? (msg.classification.source === "dgx" ? "Model DGX" : "Reguły lokalne")
                          : "Nie użyto klasyfikatora"}</strong>
                      </div>
                      <div className="mb-classifier-cell">
                        <span>Pewność</span>
                        <strong className="mono">{msg.classification
                          ? `${Math.round(msg.classification.confidence * 100)}%`
                          : "Brak wyniku"}</strong>
                      </div>
                    </div>
                  </section>
                </div>

                <div className="mb-message-column">
                <section className="dr-card mb-message mb-detail-panel mb-message-panel">
                  <div className="dr-card-head mb-panel-head">
                    <div><h4>Treść wiadomości</h4><p>Oryginalna wiadomość przesłana przez klienta.</p></div>
                  </div>
                  <div className="mb-panel-body">
                    <div className="mb-message-line">
                      <span>Od</span>
                      <div className="mb-message-sender">
                        <strong>{msg.from}</strong>
                        <span className="mb-email-pill">{msg.fromEmail}</span>
                      </div>
                    </div>
                    <div className="mb-message-line">
                      <span>Temat</span>
                      <div className="mb-message-subject">
                        <PodgladTresci text={msg.subject} podstawienia={oznaczeniaWiadomosci} />
                      </div>
                    </div>
                    <div className="mb-message-content-head">
                      <span>Treść</span>
                    </div>
                    <div className="mb-message-content">
                      <PodgladTresci text={msg.body} podstawienia={oznaczeniaWiadomosci} />
                    </div>
                  </div>
                </section>

                <section className="dr-card mb-detail-panel mb-attachments-panel">
                  <div className="dr-card-head mb-panel-head">
                    <div><h4>Załączniki ({msg.attachments.length})</h4><p>Pliki dostarczone przez nadawcę.</p></div>
                  </div>
                  <div className="mb-panel-body">
                    {msg.attachments.length === 0 ? <EmptyState text="Wiadomość nie zawiera załączników." /> : (
                      <ul className="crm-files mb-files">
                        {msg.attachments.map((attachment, index) => (
                          <li key={attachment.id}>
                            <a
                              className="mb-file-link"
                              href={crmApi.mailboxAttachmentUrl(msg.id, attachment.id)}
                              target="_blank"
                              rel="noreferrer"
                              title={`Otwórz załącznik ${attachment.name}`}
                            >
                              <span className="mb-file-index">{index + 1}.</span>
                              <PaperclipIcon />
                              <span className="nm">{attachment.name}</span>
                              <span className="kind">{ATTACHMENT_KIND_LABELS[attachment.kind]}</span>
                              <span className="mono muted">{attachment.sizeKb} kB</span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </section>
                </div>
              </div>
            </>
          )}
        </article>
      </div>
    </section>
  );
}

function wykryjOznaczenia(message: InboxMessage): Podstawienie[] {
  const text = `${message.subject}\n${message.body}`;
  const wynik: Podstawienie[] = [];
  const widziane = new Set<string>();

  function dodajWartosc(value: string | null | undefined, category: Podstawienie["category"], token: string): void {
    const oczyszczona = value?.trim();
    if (!oczyszczona || oczyszczona.length < 3) return;
    const expression = new RegExp(escapeRegExp(oczyszczona), "giu");
    for (const match of text.matchAll(expression)) dodajDopasowanie(match[0], category, token);
  }

  function dodajDopasowania(
    expression: RegExp,
    category: Podstawienie["category"],
    token: string,
    zaakceptuj: (value: string) => boolean = () => true,
  ): void {
    for (const match of text.matchAll(expression)) {
      if (zaakceptuj(match[0])) dodajDopasowanie(match[0], category, token);
    }
  }

  function dodajDopasowanie(value: string, category: Podstawienie["category"], token: string): void {
    const key = value.toLocaleLowerCase("pl-PL");
    if (widziane.has(key)) return;
    widziane.add(key);
    wynik.push({ token, value, category });
  }

  dodajWartosc(message.from, "osoba", "auto.osoba");
  dodajWartosc(message.extracted?.contactName, "osoba", "auto.osoba");
  dodajWartosc(message.extracted?.companyName, "firma", "auto.firma");
  dodajWartosc(message.extracted?.email, "firma", "auto.email");
  dodajWartosc(message.extracted?.phone, "firma", "auto.telefon");
  dodajWartosc(message.extracted?.address, "sprawa", "auto.adres");
  dodajWartosc(message.extracted?.deadline, "sprawa", "auto.termin");
  dodajWartosc(message.extracted?.quantity, "produkt", "auto.ilosc");
  dodajWartosc(message.extracted?.products, "produkt", "auto.produkt");
  for (const product of message.extracted?.products?.split(/[,;\n]/) ?? []) {
    dodajWartosc(product, "produkt", "auto.produkt");
  }

  dodajDopasowania(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/giu, "firma", "auto.email");
  dodajDopasowania(/https?:\/\/[^\s<>()]+/giu, "firma", "auto.strona");
  dodajDopasowania(/\b(?:ZAP|CRM)-\d{4}-\d+\b/giu, "sprawa", "auto.numer");
  dodajDopasowania(/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/gu, "sprawa", "auto.data");
  dodajDopasowania(/\b\d{2}-\d{3}\b/gu, "sprawa", "auto.kod-pocztowy");
  dodajDopasowania(/(?:ul\.|al\.|aleja|os\.)\s+[\p{L} .-]+\s+\d+[a-z]?/giu, "sprawa", "auto.adres");
  dodajDopasowania(/(?:\+48\s*)?(?:\d[\s-]*){9}/gu, "firma", "auto.telefon");
  dodajDopasowania(/\b(?:NIP|REGON|KRS)\s*:?\s*[\d -]{7,14}\b/giu, "firma", "auto.identyfikator-firmy");
  dodajDopasowania(/\b\d[\d\s.,]*\s*(?:PLN|zł|EUR|USD)\b/giu, "sprawa", "auto.wartosc");
  dodajDopasowania(/\b\d+(?:[,.]\d+)?\s*(?:szt\.?|kpl\.?|kg|t|mb|m²|m2)\b/giu, "produkt", "auto.ilosc");
  dodajDopasowania(/\b[A-Z]{2,}[A-Z0-9-]*\d[A-Z0-9-]*\b/gu, "produkt", "auto.kod-produktu");
  dodajDopasowania(/[\p{Lu}][\p{L}\d&.-]*(?:\s+[\p{Lu}][\p{L}\d&.-]*){0,4}\s+(?:Sp\.\s*z\s*o\.o\.|S\.A\.|Sp\.\s*j\.|Sp\.\s*k\.)/giu, "firma", "auto.firma");
  const nieSaOsobami = new Set(["dzień dobry", "szanowni państwo", "termin realizacji", "zapytanie ofertowe"]);
  dodajDopasowania(
    /\b[\p{Lu}][\p{Ll}-]{2,}\s+[\p{Lu}][\p{Ll}-]{2,}\b/gu,
    "osoba",
    "auto.osoba",
    (value) => !nieSaOsobami.has(value.toLocaleLowerCase("pl-PL")),
  );

  return wynik;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function CalendarIcon() {
  return (
    <svg className="mb-calendar-icon" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="3.5" y="5" width="13" height="11" rx="2" />
      <path d="M6.5 3.5v3M13.5 3.5v3M3.5 8.5h13" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg className="mb-paperclip" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7.2 10.7 12.8 5a2.8 2.8 0 0 1 4 4l-7.2 7.3a4.3 4.3 0 0 1-6.1-6.1l7-7" />
    </svg>
  );
}

function DgxIcon() {
  return (
    <svg className="mb-dgx-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="16" height="6" rx="2" />
      <rect x="4" y="14" width="16" height="6" rx="2" />
      <path d="M8 7h.01M8 17h.01M12 7h5M12 17h5" />
    </svg>
  );
}

function ReviewScrollIcon({ direction }: { direction: "up" | "down" }) {
  return (
    <svg className="mb-review-jump-icon" viewBox="0 0 24 24" aria-hidden="true">
      {direction === "up" ? <path d="m5 11 5-5 5 5M10 6v12" /> : <path d="m5 13 5 5 5-5M10 18V6" />}
      <circle cx="18" cy="6" r="3" />
      <path d="M18 4.8v1.4M18 7.3h.01" />
    </svg>
  );
}

function Pole({ label, value, mono = false, wide = false }: { label: string; value: string | null; mono?: boolean; wide?: boolean }) {
  return (
    <div className={`mb-data-row${wide ? " wide" : ""}`}>
      <span>{label}</span>
      <strong className={mono ? "mono" : ""}>{value ?? <em>nie odczytano</em>}</strong>
    </div>
  );
}
