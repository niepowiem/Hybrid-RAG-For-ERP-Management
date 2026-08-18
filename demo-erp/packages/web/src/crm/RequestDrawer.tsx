/**
 * RequestDrawer.tsx — panel szczegółów wysuwany z prawej krawędzi.
 *
 * Panel, a nie osobna strona: praca na tablicy jest ciągła — sprawdzam kartę,
 * poprawiam wartość, wracam do przeciągania.
 *
 * Kolejność sekcji odpowiada kolejności pytań: co to za sprawa (opis pod
 * nagłówkiem), co z nią zrobić (problemy z akcją), gdzie jest w procesie
 * (etapy), z kim i dokąd (klient, dostawa), za ile (sprawa), z czym
 * (załączniki), a na końcu notatki — bo do nich wraca się najrzadziej.
 *
 * Notatki etapowe nie mają własnego pola pod szyną: klika się w etap i pisze
 * w dymku. Etap z notatką dostaje ikonę karteczki, etap bez notatki nie ma
 * nic. Sześć pustych ramek „Brak notatki” zajmowało pół ekranu i nie niosło
 * żadnej informacji.
 *
 * Zasada edycji: wszystko, co należy do SPRAWY, jest edytowalne w miejscu.
 * Dane KLIENTA są tylko do odczytu — należą do kartoteki i zmieniane stąd
 * rozjechałyby się z pozostałymi zapytaniami tego samego klienta.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ACTIVITY_KIND_LABELS,
  CreateContactSchema,
  ATTACHMENT_KIND_LABELS,
  CRM_PIPELINE,
  CRM_STAGE_LABELS,
  CRM_STAGE_MICRO,
  DEPOT,
  TEMPLATE_KEYS,
  TEMPLATE_LABELS,
  LOST_REASON_LABELS,
  sugerowanyScoring,
  szacujTrase,
  wykryjProblemy,
} from "@demo-erp/shared";
import type {
  ActivityKind,
  CreateContactInput,
  CrmClient,
  CrmEmployee,
  CrmIssue,
  CrmRequest,
  CrmStage,
  CrmVendor,
  TemplateKey,
} from "@demo-erp/shared";
import { notify } from "../ui.js";
import { ApiError } from "../api.js";
import { crmApi } from "./client.js";
import { dataGodzinaPL, dataPL, czasWzgledny, terminOpis } from "./format.js";
import { kwotaPL } from "./BoardCard.js";
import { OutsourcingPanel } from "./OutsourcingPanel.js";
import { MessageEditor } from "./MessageEditor.js";
import { podstawieniaDlaSprawy } from "./SendMessageModal.js";

type Zakladka = "szczegoly" | "wiadomosci" | "zalaczniki" | "outsourcing" | "historia";

interface Props {
  req: CrmRequest;
  clients: CrmClient[];
  employees: CrmEmployee[];
  onChange: (r: CrmRequest) => void;
  onClose: () => void;
  onLost: (r: CrmRequest) => void;
  onIssueAction: (r: CrmRequest, i: CrmIssue) => void;
  onClientChange: (k: CrmClient) => void;
  vendors: CrmVendor[];
  wylaczoneReguly: string[];
  /** Konto pocztowe, z którego moduł wysyła korespondencję (Outlook). */
  konto: string;
}

/** Formularz dodania osoby kontaktowej — dokłada wpis do kartoteki klienta. */
/**
 * Formularz kontaktu. Wymagamy JEDNEJ formy kontaktu, nie obu naraz —
 * część kontaktów budowlanych to numer bez służbowej skrzynki, część to
 * skrzynka działu bez numeru. Błędy pokazujemy przy polach, bo „formularz
 * zawiera błędy” zmusza do zgadywania, które pole jest nie tak.
 */
function FormularzKontaktu({
                             wartosci,
                             onCancel,
                             onSave,
                           }: {
  wartosci?: { name: string; email: string; phone: string | null; role: string | null };
  onCancel: () => void;
  onSave: (dane: CreateContactInput) => Promise<void>;
}) {
  const [name, setName] = useState(wartosci?.name ?? "");
  const [email, setEmail] = useState(wartosci?.email ?? "");
  const [phone, setPhone] = useState(wartosci?.phone ?? "");
  const [role, setRole] = useState(wartosci?.role ?? "");
  const [busy, setBusy] = useState(false);
  const [bledy, setBledy] = useState<Record<string, string>>({});

  function sprawdz(): boolean {
    const wynik = CreateContactSchema.safeParse({ name, email, phone, role });
    if (wynik.success) {
      setBledy({});
      return true;
    }
    const b: Record<string, string> = {};
    for (const i of wynik.error.issues) {
      const pole = String(i.path[0] ?? "ogolny");
      b[pole] ??= i.message;
    }
    setBledy(b);
    return false;
  }

  return (
      <div className="dr-contact-form">
        <label>
          <input
              placeholder="Imię i nazwisko"
              value={name}
              className={bledy.name ? "invalid" : ""}
              onChange={(e) => setName(e.target.value)}
          />
          {bledy.name && <span className="field-error">{bledy.name}</span>}
        </label>
        <label>
          <input
              placeholder="Rola, np. Technolog"
              value={role}
              onChange={(e) => setRole(e.target.value)}
          />
        </label>
        <label>
          <input
              placeholder="E-mail"
              value={email}
              className={bledy.email ? "invalid" : ""}
              onChange={(e) => setEmail(e.target.value)}
          />
          {bledy.email && <span className="field-error">{bledy.email}</span>}
        </label>
        <label>
          <input
              placeholder="Telefon"
              value={phone}
              className={bledy.phone ? "invalid" : ""}
              onChange={(e) => setPhone(e.target.value)}
          />
          {bledy.phone && <span className="field-error">{bledy.phone}</span>}
        </label>
        <p className="dr-meta dr-contact-hint">
          Wystarczy jedna forma kontaktu — e-mail albo telefon.
        </p>
        <div className="dr-contact-act">
          <button type="button" className="btn ghost sm" onClick={onCancel}>
            Anuluj
          </button>
          <button
              type="button"
              className="btn primary sm"
              disabled={busy}
              onClick={() => {
                if (!sprawdz()) return;
                setBusy(true);
                void onSave({ name, email, phone, role } as unknown as CreateContactInput).finally(() =>
                    setBusy(false),
                );
              }}
          >
            {wartosci ? "Zapisz" : "Dodaj"}
          </button>
        </div>
      </div>
  );
}

/** Pole zapisywane po wyjściu z niego — bez przycisku „Zapisz” przy każdej linijce. */
function PoleTekst({
                     label,
                     value,
                     placeholder,
                     onSave,
                     type = "text",
                     id,
                   }: {
  label: string;
  value: string;
  placeholder?: string;
  onSave: (v: string) => void;
  type?: string;
  id: string;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
      <label className="dr-field">
        <span>{label}</span>
        <input
            type={type}
            value={v}
            placeholder={placeholder}
            onChange={(e) => setV(e.target.value)}
            onBlur={() => {
              if (v !== value) onSave(v);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setV(value);
            }}
            data-assistant-id={id}
        />
      </label>
  );
}

const IKONY: Record<string, string> = {
  message_sent: "✉",
  message_generated: "✎",
  mail_fetched: "↓",
  followup_created: "☎",
  followup_done: "✓",
  created: "＋",
  stage_changed: "→",
  assignee_changed: "◆",
  score_changed: "%",
  data_changed: "✎",
  lost_reason_changed: "✕",
  note_added: "✎",
};

export function RequestDrawer({
                                req,
                                clients,
                                employees,
                                onChange,
                                onClose,
                                onLost,
                                onIssueAction,
                                onClientChange,
                                vendors,
                                wylaczoneReguly,
                                konto,
                              }: Props) {
  const [tab, setTab] = useState<Zakladka>("szczegoly");
  const [notatkaEtapu, setNotatkaEtapu] = useState<CrmStage | null>(null);
  const [tekstNotatki, setTekstNotatki] = useState("");
  const [dodajKontakt, setDodajKontakt] = useState(false);
  const [edycjaKontaktu, setEdycjaKontaktu] = useState<string | null>(null);
  const [rozwiniete, setRozwiniete] = useState<string[]>([]);
  const [nowaDo, setNowaDo] = useState(req.email);
  const [nowyTemat, setNowyTemat] = useState(`Zapytanie ${req.number} — ${req.projectName}`);
  const [nowaTresc, setNowaTresc] = useState("");
  const [wysylanie, setWysylanie] = useState(false);
  const [nowyKosztorysant, setNowyKosztorysant] = useState("");
  const ustawieniaKonta = konto;
  const panel = useRef<HTMLDivElement>(null);

  const klient = clients.find((k) => k.id === req.clientId);
  const kosztorysant = employees.find((e) => e.id === req.assigneeId);
  const przypisani = req.assigneeIds
      .map((id) => employees.find((e) => e.id === id))
      .filter((e): e is CrmEmployee => e != null);
  const pm = employees.find((e) => e.id === req.projectManagerId);
  const issues = useMemo(() => wykryjProblemy(req, undefined, wylaczoneReguly), [req, wylaczoneReguly]);
  const podpowiedz = useMemo(() => sugerowanyScoring(req), [req]);

  const brakZal = req.requiredAttachments.filter((k) => !req.attachments.some((a) => a.kind === k));
  const poDacie = [...req.attachments].sort((a, b) => b.at.localeCompare(a.at));

  /**
   * Wątek sprawy: nasze wiadomości, wiadomości klienta i zaplanowane kontakty
   * w jednej osi czasu. Załączniki wiszą pod wpisem, przy którym przyszły.
   */
  const watek = [
    ...req.messages.map((m) => ({
      id: m.id,
      at: m.sentAt ?? m.createdAt,
      kanal: "mail" as const,
      naglowek: m.subject,
      tresc: m.body as string | null,
      stopka: m.direction === "in" ? `od: ${m.authorName}` : `do: ${m.to}`,
      status: m.sentAt
          ? `${m.direction === "in" ? "otrzymano" : "wysłano"} ${czasWzgledny(m.sentAt)}`
          : "do wysłania",
      wyslana: m.sentAt != null,
      kto: m.authorName,
      przychodzaca: m.direction === "in",
      pliki: req.attachments.filter((a) => a.messageId === m.id),
    })),
    ...req.followUps.map((f) => ({
      id: f.id,
      at: `${f.date}T${f.time}:00.000Z`,
      kanal: (f.type === "phone" ? "phone" : f.type === "meeting" ? "meet" : "mail") as
          | "phone"
          | "meet"
          | "mail",
      naglowek: f.note,
      tresc: null as string | null,
      stopka: `${dataPL(f.date)}, ${f.time}`,
      status:
          f.status === "done"
              ? `wykonano ${czasWzgledny(f.doneAt)}`
              : f.status === "overdue"
                  ? "termin minął"
                  : "zaplanowany",
      wyslana: f.status === "done",
      kto: "kontakt",
      przychodzaca: false,
      pliki: [] as typeof req.attachments,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const odKlienta = poDacie.filter((a) => a.source === "client");
  const nasze = poDacie.filter((a) => a.source === "own");

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // Escape zamyka najpierw dymek notatki, dopiero potem cały panel.
      if (notatkaEtapu) setNotatkaEtapu(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, notatkaEtapu]);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  async function zapisz(patch: Parameters<typeof crmApi.patch>[1]): Promise<void> {
    try {
      onChange(await crmApi.patch(req.id, patch));
    } catch (e) {
      notify("Nie udało się zapisać zmiany", e instanceof ApiError ? e.body.message : "Spróbuj ponownie.", "err");
    }
  }

  /**
   * Wstawienie szablonu do okna pisania. Serwer zwraca treść już wypełnioną
   * danymi sprawy, więc szkic od razu tworzymy po jego stronie i od razu
   * kasujemy — nie chcemy zostawiać w wątku wpisów, których nikt nie wysłał.
   */
  async function wstawSzablon(key: TemplateKey): Promise<void> {
    try {
      const { request, messageId } = await crmApi.draftFromTemplate(req.id, key);
      const szkic = request.messages.find((m) => m.id === messageId);
      if (szkic) {
        setNowyTemat(szkic.subject);
        setNowaTresc(szkic.body);
        setNowaDo(szkic.to);
      }
      onChange(await crmApi.discardMessage(req.id, messageId));
    } catch (e) {
      notify("Nie udało się wczytać szablonu", e instanceof ApiError ? e.body.message : "Spróbuj ponownie.", "err");
    }
  }

  async function wyslijNowa(send: boolean): Promise<void> {
    setWysylanie(true);
    try {
      const r = await crmApi.compose(req.id, {
        to: nowaDo,
        subject: nowyTemat,
        body: nowaTresc,
        kind: "custom",
        templateKey: null,
        send,
      });
      onChange(r);
      setNowaTresc("");
      notify(send ? "Wiadomość wysłana" : "Szkic zapisany", send ? `${nowaDo} · ${ustawieniaKonta}` : nowyTemat);
    } catch (e) {
      notify("Nie udało się wysłać", e instanceof ApiError ? e.body.message : "Spróbuj ponownie.", "err");
    } finally {
      setWysylanie(false);
    }
  }

  async function usunKontakt(kid: string, name: string): Promise<void> {
    if (!klient) return;
    if (!window.confirm(`Usunąć osobę kontaktową „${name}” z kartoteki klienta?`)) return;
    try {
      onClientChange(await crmApi.removeContact(klient.id, kid));
      notify("Kontakt usunięty", name);
    } catch (e) {
      notify("Nie udało się usunąć", e instanceof ApiError ? e.body.message : "Spróbuj ponownie.", "err");
    }
  }

  async function usunKosztorysanta(eid: string, name: string): Promise<void> {
    try {
      onChange(await crmApi.removeAssignee(req.id, eid));
      notify("Usunięto z listy kosztorysantów", name);
    } catch (e) {
      notify("Nie udało się usunąć", e instanceof ApiError ? e.body.message : "Spróbuj ponownie.", "err");
    }
  }

  async function zmienEtap(stage: CrmStage): Promise<void> {
    if (stage === "lost") {
      onLost(req);
      return;
    }
    try {
      onChange(await crmApi.setStage(req.id, stage));
      notify("Zmieniono etap", `${req.number} · ${CRM_STAGE_LABELS[stage]}`);
    } catch (e) {
      notify("Nie udało się zmienić etapu", e instanceof ApiError ? e.body.message : "Spróbuj ponownie.", "err");
    }
  }

  function otworzNotatke(stage: CrmStage): void {
    setTekstNotatki(req.stageNotes.find((n) => n.stage === stage)?.text ?? "");
    setNotatkaEtapu(stage);
  }

  async function zapiszNotatke(): Promise<void> {
    if (!notatkaEtapu) return;
    const biezaca = req.stageNotes.find((x) => x.stage === notatkaEtapu)?.text ?? "";
    const stage = notatkaEtapu;
    setNotatkaEtapu(null);
    if (tekstNotatki === biezaca) return;
    try {
      onChange(await crmApi.setStageNote(req.id, stage, tekstNotatki));
      notify(
          tekstNotatki.trim() === "" ? "Notatka usunięta" : "Notatka zapisana",
          `Etap „${CRM_STAGE_MICRO[stage]}”`,
      );
    } catch (e) {
      notify("Nie udało się zapisać notatki", e instanceof ApiError ? e.body.message : "Spróbuj ponownie.", "err");
    }
  }

  const idxEtapu = CRM_PIPELINE.indexOf(req.stage as (typeof CRM_PIPELINE)[number]);
  const adres = req.siteAddress?.trim() ?? "";
  // Link prowadzi do wyznaczonej TRASY z zakładu, nie do samego punktu —
  // kosztorysanta interesuje dojazd, nie pinezka.
  const mapaUrl = adres
      ? `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(DEPOT.address)}&destination=${encodeURIComponent(adres)}&travelmode=driving`
      : null;
  // Podgląd mapy bez klucza API — publiczny endpoint `output=embed`. Do wdrożenia
  // produkcyjnego należy przejść na Maps Embed API z kluczem i regulaminową
  // atrybucją; tutaj chodzi o to, żeby kosztorysant zobaczył okolicę budowy.
  const trasa = szacujTrase(adres);
  const mapaEmbed = adres
      ? `https://maps.google.com/maps?saddr=${encodeURIComponent(DEPOT.address)}&daddr=${encodeURIComponent(adres)}&output=embed`
      : null;

  return (
      <>
        <div className="dr-scrim" onClick={onClose} />
        <aside
            className="dr"
            ref={panel}
            tabIndex={-1}
            role="dialog"
            aria-label={`Szczegóły zapytania ${req.number}`}
        >
          <header className="dr-head">
            <div className="dr-head-t">
              <p className="dr-num">
                <span className="mono">{req.number}</span> ·{" "}
                {req.stage === "lost"
                    ? "zapytanie przegrane"
                    : req.stage === "won"
                        ? "zapytanie wygrane"
                        : "aktywne zapytanie"}
              </p>
              <h2>{req.projectName}</h2>
              <p className="dr-sub">
                {req.companyName} · {dataPL(req.createdAt)}
              </p>
            </div>
            <div className="dr-head-act">
              <Link to={`/crm/requests/${req.id}`} className="btn ghost">
                Pełny widok
              </Link>
              <button
                  type="button"
                  className="dr-close"
                  onClick={onClose}
                  aria-label="Zamknij panel"
                  data-assistant-id="crm-drawer-close"
              >
                ✕
              </button>
            </div>
          </header>

          <div className="dr-lead">
            <p className="dr-lead-h">Opis zapytania</p>
            <p className="dr-lead-t">{req.description}</p>
            {(req.products || req.quantity) && (
                <p className="dr-lead-m">
                  Zakres: {req.products ?? "—"}
                  {req.quantity ? ` · ${req.quantity}` : ""}
                </p>
            )}
          </div>

          {issues.length > 0 && (
              <div className="dr-alerts">
                {issues.map((i) => (
                    <div key={i.id} className={`dr-alert ${i.severity}`}>
                <span className="dr-alert-ico" aria-hidden="true">
                  {i.severity === "error" ? "!" : "△"}
                </span>
                      <p>
                        <strong>{i.title}:</strong> {i.message}
                      </p>
                      {i.action && (
                          <button
                              type="button"
                              className="dr-alert-act"
                              onClick={() => onIssueAction(req, i)}
                              data-assistant-id={`crm-drawer-action-${i.id}`}
                          >
                            {i.actionLabel}
                          </button>
                      )}
                    </div>
                ))}
              </div>
          )}

          <nav className="dr-tabs" role="tablist">
            {(
                [
                  ["szczegoly", "Szczegóły"],
                  ["wiadomosci", `Wiadomości (${req.messages.length})`],
                  ["zalaczniki", `Załączniki (${req.attachments.length})`],
                  ["outsourcing", `Outsourcing (${req.outsourcing.length})`],
                  ["historia", `Historia (${req.activity.length})`],
                ] as const
            ).map(([k, label]) => (
                <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={tab === k}
                    className={tab === k ? "on" : ""}
                    onClick={() => setTab(k)}
                    data-assistant-id={`crm-drawer-tab-${k}`}
                >
                  {label}
                </button>
            ))}
          </nav>

          <div className="dr-scroll">
            {tab === "szczegoly" && (
                <>
                  <section className="dr-block">
                    <h4>Etap procesu</h4>
                    <div className="dr-flow">
                      {CRM_PIPELINE.map((s, i) => {
                        const aktywny = s === req.stage;
                        const zrobiony = idxEtapu > i;
                        const problem = issues.find((x) => x.stage === s);
                        const notatka = req.stageNotes.find((n) => n.stage === s);
                        const klasa = [
                          "dr-chev",
                          zrobiony ? "done" : "",
                          aktywny ? "on" : "",
                          problem ? `p-${problem.severity}` : "",
                        ]
                            .filter(Boolean)
                            .join(" ");
                        return (
                            <div className="dr-chev-wrap" key={s}>
                              <button
                                  type="button"
                                  className={klasa}
                                  onClick={() => otworzNotatke(s)}
                                  onDoubleClick={() => void zmienEtap(s)}
                                  title={
                                    notatka
                                        ? `${CRM_STAGE_LABELS[s]} — notatka: ${notatka.text}`
                                        : `${CRM_STAGE_LABELS[s]}${problem ? ` — ${problem.message}` : ""}\nKliknij, aby dodać notatkę`
                                  }
                                  data-assistant-id={`crm-drawer-stage-${s}`}
                              >
                          <span className="dr-chev-l">
                            {i + 1} · {CRM_STAGE_MICRO[s]}
                          </span>
                                {notatka && (
                                    <span className="dr-chev-note" aria-label="Etap ma notatkę">
                              🗒
                            </span>
                                )}
                                {problem && !notatka && <span className="dr-chev-b">!</span>}
                              </button>

                              {notatkaEtapu === s && (
                                  <div className="dr-note-pop">
                                    <p className="dr-note-pop-h">
                                      Notatka · {CRM_STAGE_LABELS[s]}
                                      <button
                                          type="button"
                                          className="dr-note-x"
                                          onClick={() => setNotatkaEtapu(null)}
                                          aria-label="Zamknij bez zapisywania"
                                      >
                                        ✕
                                      </button>
                                    </p>
                                    <textarea
                                        rows={3}
                                        autoFocus
                                        value={tekstNotatki}
                                        placeholder="Co się wydarzyło na tym etapie, na co czekamy, co ustalono."
                                        onChange={(e) => setTekstNotatki(e.target.value)}
                                        data-assistant-id="crm-drawer-stage-note"
                                    />
                                    <div className="dr-note-act">
                                      {req.stage !== s && (
                                          <button
                                              type="button"
                                              className="btn ghost sm"
                                              onClick={() => {
                                                setNotatkaEtapu(null);
                                                void zmienEtap(s);
                                              }}
                                          >
                                            Ustaw ten etap
                                          </button>
                                      )}
                                      <span className="spacer" />
                                      <button type="button" className="btn primary sm" onClick={() => void zapiszNotatke()}>
                                        Zapisz
                                      </button>
                                    </div>
                                    {notatka && (
                                        <p className="dr-meta">
                                          Ostatnia zmiana: {dataGodzinaPL(notatka.at)} · {notatka.user}
                                        </p>
                                    )}
                                  </div>
                              )}
                            </div>
                        );
                      })}
                    </div>

                    <p className="dr-meta">
                      Kliknij etap, aby dodać notatkę. Podwójne kliknięcie ustawia etap sprawy.
                    </p>

                    {req.stage === "lost" && req.lostReason ? (
                        <p className="dr-lost">
                          Przegrane: {LOST_REASON_LABELS[req.lostReason]}
                          {req.lostReasonNote ? ` — ${req.lostReasonNote}` : ""}
                        </p>
                    ) : (
                        req.stage !== "won" && (
                            <button
                                type="button"
                                className="dr-lost-btn"
                                onClick={() => onLost(req)}
                                data-assistant-id="crm-drawer-lost"
                            >
                              <span aria-hidden="true">✕</span> Oznacz zapytanie jako przegrane
                            </button>
                        )
                    )}
                  </section>

                  <section className="dr-block">
                    <h4>Klient</h4>
                    <div className="dr-card">
                      <label className="dr-field">
                        <span>Przypisany klient</span>
                        <select
                            value={req.clientId ?? ""}
                            onChange={(e) => void zapisz({ clientId: e.target.value || null })}
                            data-assistant-id="crm-drawer-client"
                        >
                          <option value="">— brak w kartotece —</option>
                          {clients.map((k) => (
                              <option key={k.id} value={k.id}>
                                {k.name}
                              </option>
                          ))}
                        </select>
                      </label>

                      <dl className="dr-grid2">
                        <div>
                          <dt>Firma</dt>
                          <dd className="strong">{klient?.name ?? req.companyName}</dd>
                        </div>
                        <div>
                          <dt>NIP</dt>
                          <dd className="mono">{klient?.nip ?? "—"}</dd>
                        </div>
                        <div>
                          <dt>Adres siedziby</dt>
                          <dd>{klient?.address ?? req.address ?? "—"}</dd>
                        </div>
                      </dl>
                      <p className="dr-ps">
                        Dane powyżej pochodzą z kartoteki klienta i są tu tylko do odczytu. Zmiana
                        w tym miejscu rozjechałaby się z pozostałymi zapytaniami tego klienta.
                      </p>
                    </div>
                  </section>

                  <section className="dr-block">
                    <h4>Osoby kontaktowe ({klient?.contacts.length ?? 1})</h4>
                    <div className="dr-card">
                      <ul className="dr-contacts">
                        {(klient?.contacts ?? []).map((k) =>
                            edycjaKontaktu === k.id ? (
                                <li key={k.id} className="edytowany">
                                  <FormularzKontaktu
                                      wartosci={k}
                                      onCancel={() => setEdycjaKontaktu(null)}
                                      onSave={async (dane) => {
                                        if (!klient) return;
                                        try {
                                          onClientChange(await crmApi.updateContact(klient.id, k.id, dane));
                                          setEdycjaKontaktu(null);
                                          notify("Zapisano kontakt", dane.name);
                                        } catch (e) {
                                          notify(
                                              "Nie udało się zapisać",
                                              e instanceof ApiError ? e.body.message : "Spróbuj ponownie.",
                                              "err",
                                          );
                                        }
                                      }}
                                  />
                                </li>
                            ) : (
                                <li key={k.id}>
                                  <span className="dr-c-n">{k.name}</span>
                                  {k.role && <span className="dr-c-r">{k.role}</span>}
                                  <a className="dr-c-e" href={`mailto:${k.email}`}>
                                    {k.email}
                                  </a>
                                  <span className="dr-c-t">{k.phone ?? "—"}</span>
                                  <span className="dr-c-act">
                            <button
                                type="button"
                                title="Edytuj kontakt"
                                onClick={() => setEdycjaKontaktu(k.id)}
                                data-assistant-id={`crm-contact-edit-${k.id}`}
                            >
                              ✎
                            </button>
                            <button
                                type="button"
                                title="Usuń kontakt"
                                className="usun"
                                onClick={() => void usunKontakt(k.id, k.name)}
                                data-assistant-id={`crm-contact-remove-${k.id}`}
                            >
                              ✕
                            </button>
                          </span>
                                </li>
                            ),
                        )}
                        {!klient && (
                            <li>
                              <span className="dr-c-n">{req.contactName}</span>
                              <a className="dr-c-e" href={`mailto:${req.email}`}>
                                {req.email}
                              </a>
                              <span className="dr-c-t">{req.phone ?? "—"}</span>
                            </li>
                        )}
                      </ul>

                      {klient &&
                          (dodajKontakt ? (
                              <FormularzKontaktu
                                  onCancel={() => setDodajKontakt(false)}
                                  onSave={async (dane) => {
                                    try {
                                      onClientChange(await crmApi.addContact(klient.id, dane));
                                      setDodajKontakt(false);
                                      notify("Dodano osobę kontaktową", dane.name);
                                    } catch (e) {
                                      notify(
                                          "Nie udało się dodać kontaktu",
                                          e instanceof ApiError ? e.body.message : "Spróbuj ponownie.",
                                          "err",
                                      );
                                    }
                                  }}
                              />
                          ) : (
                              <button
                                  type="button"
                                  className="dr-add-c"
                                  onClick={() => setDodajKontakt(true)}
                                  data-assistant-id="crm-drawer-add-contact"
                              >
                                + Dodaj osobę kontaktową
                              </button>
                          ))}

                      <p className="dr-ps">
                        Kontakty należą do kartoteki klienta i są wspólne dla wszystkich jego zapytań —
                        zmiana kontaktu głównego zaktualizuje adres, na który idzie korespondencja.
                      </p>
                    </div>
                  </section>

                  <section className="dr-block">
                    <h4>Dostawa</h4>
                    <div className="dr-card">
                      {mapaEmbed && (
                          <div className="dr-mapbox">
                            <iframe
                                title={`Mapa: ${adres}`}
                                src={mapaEmbed}
                                loading="lazy"
                                referrerPolicy="no-referrer-when-downgrade"
                            />
                          </div>
                      )}
                      <div className="dr-addr">
                        <PoleTekst
                            id="crm-drawer-site"
                            label="Adres dostawy (budowa)"
                            value={req.siteAddress ?? ""}
                            placeholder="ul. Przykładowa 1, 00-000 Miasto"
                            onSave={(v) => void zapisz({ siteAddress: v })}
                        />
                        <a
                            className={`dr-map-btn${mapaUrl ? "" : " off"}`}
                            href={mapaUrl ?? undefined}
                            target="_blank"
                            rel="noreferrer"
                            aria-disabled={mapaUrl ? undefined : true}
                        >
                          Otwórz w Google Maps
                        </a>
                      </div>
                      {!adres && (
                          <p className="dr-meta">
                            Bez adresu dostawy nie da się policzyć transportu ani montażu.
                          </p>
                      )}
                      {trasa && !trasa.nieznane && (
                          <div className="dr-km">
                            <div>
                              <span className="dr-km-h">W jedną stronę</span>
                              <strong>{trasa.wJednaStrone} km</strong>
                            </div>
                            <div>
                              <span className="dr-km-h">W obie strony</span>
                              <strong>{trasa.wDwieStrony} km</strong>
                            </div>
                            <div className="wyroz">
                              <span className="dr-km-h">Z buforem +{trasa.bufor} km</span>
                              <strong>{trasa.zBuforem} km</strong>
                            </div>
                          </div>
                      )}
                      {trasa && (
                          <p className="dr-meta">
                            {trasa.nieznane
                                ? `Nie rozpoznano miasta w adresie — kilometrów nie oszacowano. Punkt startowy: ${DEPOT.address}.`
                                : `Liczone z: ${DEPOT.address} → ${trasa.miasto}.`}
                          </p>
                      )}
                    </div>
                  </section>

                  <section className="dr-block">
                    <h4>Sprawa</h4>
                    <div className="dr-card">
                      <div className="dr-metrics">
                        <div>
                          <span className="dr-metric-h">Wartość</span>
                          <strong className="dr-metric-v">{kwotaPL(req.quoteValue)}</strong>
                        </div>
                        <div>
                          <span className="dr-metric-h">Prawd. wygrania</span>
                          <strong className="dr-metric-v">
                            {req.score}
                            <small>/100</small>
                          </strong>
                        </div>
                        <div>
                          <span className="dr-metric-h">Podpowiedź systemu</span>
                          <strong className="dr-metric-v soft">
                            {podpowiedz}
                            <small>/100</small>
                          </strong>
                        </div>
                      </div>

                      <div className="dr-two">
                        <PoleTekst
                            id="crm-drawer-value"
                            label="Wartość wyceny (PLN)"
                            value={req.quoteValue == null ? "" : String(req.quoteValue)}
                            placeholder="np. 125 999,99"
                            onSave={(v) => {
                              const t = v.replace(/\s/g, "").replace(",", ".").trim();
                              if (t === "") {
                                void zapisz({ quoteValue: null });
                                return;
                              }
                              const liczba = Number(t);
                              if (Number.isNaN(liczba) || liczba < 0) {
                                notify("Niepoprawna wartość wyceny", "Podaj liczbę nieujemną, np. 125 999,99.", "err");
                                return;
                              }
                              void zapisz({ quoteValue: liczba });
                            }}
                        />
                        <label className="dr-field">
                          <span>Prawd. wygrania: {req.score}%</span>
                          <input
                              type="range"
                              min={0}
                              max={100}
                              step={1}
                              defaultValue={req.score}
                              onMouseUp={(e) => void zapisz({ score: Number((e.target as HTMLInputElement).value) })}
                              onTouchEnd={(e) => void zapisz({ score: Number((e.target as HTMLInputElement).value) })}
                              data-assistant-id="crm-drawer-score"
                          />
                        </label>
                      </div>

                      <div className="dr-two">
                        <div className="dr-field">
                          <span>Data wpłynięcia</span>
                          <p className="dr-static">{dataPL(req.createdAt)}</p>
                        </div>
                        <PoleTekst
                            id="crm-drawer-deadline"
                            label="Termin dostawy"
                            type="date"
                            value={req.deadline ?? ""}
                            onSave={(v) => void zapisz({ deadline: v })}
                        />
                      </div>
                      {req.deadline && <p className="dr-meta">Termin dostawy: {terminOpis(req.deadline)}.</p>}
                    </div>
                  </section>

                  <section className="dr-block">
                    <h4>Zespół sprawy</h4>
                    <div className="dr-card">
                      <div className="dr-rows">
                        <label className="dr-row">
                          <span>Project manager</span>
                          <select
                              value={req.projectManagerId ?? ""}
                              onChange={(e) => void zapisz({ projectManagerId: e.target.value || null })}
                              data-assistant-id="crm-drawer-pm"
                          >
                            <option value="">— nie wskazano —</option>
                            {employees
                                .filter((e) => e.role !== "administrator")
                                .map((e) => (
                                    <option key={e.id} value={e.id}>
                                      {e.name}
                                    </option>
                                ))}
                          </select>
                        </label>
                      </div>

                      <div className="dr-assignees">
                        <p className="dr-assignees-h">
                          Kosztorysanci ({przypisani.length})
                          <span>— w kolejności, w jakiej sprawa do nich trafiała</span>
                        </p>
                        {przypisani.length === 0 ? (
                            <p className="muted">Nikt jeszcze nie prowadził tej sprawy.</p>
                        ) : (
                            <ul>
                              {przypisani.map((e, i) => (
                                  <li key={e.id}>
                                    <span className="dr-a-i">{i + 1}</span>
                                    <span className="dr-a-n">{e.name}</span>
                                    {i === przypisani.length - 1 && <span className="dr-a-tag">bieżący</span>}
                                    <button
                                        type="button"
                                        className="dr-a-x"
                                        title="Usuń z listy kosztorysantów"
                                        onClick={() => void usunKosztorysanta(e.id, e.name)}
                                        data-assistant-id={`crm-drawer-assignee-remove-${e.id}`}
                                    >
                                      ✕
                                    </button>
                                  </li>
                              ))}
                            </ul>
                        )}
                        <div className="dr-add-a">
                          <p className="dr-add-a-h">Dodaj kosztorysanta do sprawy</p>
                          <div className="dr-add-a-row">
                            <select
                                value={nowyKosztorysant}
                                onChange={(e) => setNowyKosztorysant(e.target.value)}
                                data-assistant-id="crm-drawer-assignee"
                            >
                              <option value="">— wybierz osobę —</option>
                              {employees
                                  .filter((e) => e.role !== "administrator" && !req.assigneeIds.includes(e.id))
                                  .map((e) => (
                                      <option key={e.id} value={e.id}>
                                        {e.name}
                                        {e.role === "kierownik" ? " (kierownik)" : ""}
                                      </option>
                                  ))}
                            </select>
                            <button
                                type="button"
                                className="btn primary sm"
                                disabled={nowyKosztorysant === ""}
                                onClick={() => {
                                  void zapisz({ assigneeId: nowyKosztorysant });
                                  setNowyKosztorysant("");
                                }}
                                data-assistant-id="crm-drawer-assignee-add"
                            >
                              Dodaj
                            </button>
                          </div>
                        </div>
                      </div>
                      <p className="dr-meta">
                        Dodanie kosztorysanta przenosi kartę do jego kolumny; poprzedni zostają na
                        liście jako zapis, kto miał styczność ze sprawą.
                      </p>
                    </div>
                  </section>

                  <section className="dr-block">
                    <h4>Notatki ogólne</h4>
                    <div className="dr-card">
                  <textarea
                      rows={4}
                      defaultValue={req.notes}
                      placeholder="Ustalenia, kontekst, rzeczy do zapamiętania przy tej sprawie."
                      onBlur={(e) => {
                        if (e.target.value !== req.notes) void zapisz({ notes: e.target.value });
                      }}
                      data-assistant-id="crm-drawer-notes"
                  />
                    </div>
                  </section>
                </>
            )}

            {tab === "wiadomosci" && (
                <section className="dr-block">
                  <p className="dr-meta">
                    Cała korespondencja sprawy w jednym miejscu — niezależnie od tego, kto pisał:
                    kosztorysant, kierownik czy klient. Kliknij wpis, aby rozwinąć treść.
                  </p>
                  {watek.length === 0 ? (
                      <p className="muted">Brak korespondencji i kontaktów w tej sprawie.</p>
                  ) : (
                      <ol className="tl">
                        {watek.map((w) => {
                          const otwarty = rozwiniete.includes(w.id);
                          return (
                              <li
                                  key={w.id}
                                  className={`tl-i ${w.wyslana ? "ok" : "pending"}${w.przychodzaca ? " in" : ""}`}
                              >
                        <span
                            className={`tl-ico ${w.kanal}${w.przychodzaca ? " in" : ""}`}
                            aria-hidden="true"
                        >
                          {w.kanal === "phone" ? "☎" : w.kanal === "meet" ? "◫" : w.przychodzaca ? "↓" : "✉"}
                        </span>
                                <div className="tl-body">
                                  <button
                                      type="button"
                                      className="tl-toggle"
                                      aria-expanded={otwarty}
                                      onClick={() =>
                                          setRozwiniete((prev) =>
                                              prev.includes(w.id) ? prev.filter((x) => x !== w.id) : [...prev, w.id],
                                          )
                                      }
                                      data-assistant-id={`crm-thread-${w.id}`}
                                  >
                            <span className="tl-caret" aria-hidden="true">
                              {otwarty ? "▾" : "▸"}
                            </span>
                                    <span className="tl-h">
                              <strong>{w.naglowek}</strong>
                              <span className={`tl-who${w.przychodzaca ? " in" : ""}`}>
                                {w.przychodzaca ? "↙ " : "↗ "}
                                {w.kto}
                              </span>
                            </span>
                                  </button>

                                  {!otwarty && w.tresc && (
                                      <p className="tl-peek">{w.tresc.replace(/\s+/g, " ").slice(0, 96)}…</p>
                                  )}
                                  {otwarty && w.tresc && <pre className="tl-full">{w.tresc}</pre>}

                                  {w.pliki.length > 0 && (
                                      <ul className="tl-files">
                                        {w.pliki.map((a2) => (
                                            <li key={a2.id}>
                                              <a
                                                  href={crmApi.attachmentUrl(req.id, a2.id)}
                                                  target="_blank"
                                                  rel="noreferrer"
                                              >
                                                ▤ {a2.name}
                                              </a>
                                              <span>
                                    {dataGodzinaPL(a2.at)} · {a2.sizeKb} kB
                                  </span>
                                            </li>
                                        ))}
                                      </ul>
                                  )}

                                  <div className="tl-f">
                                    <span>{w.stopka}</span>
                                    <span className={`tl-status ${w.wyslana ? "ok" : "pending"}`}>{w.status}</span>
                                  </div>
                                </div>
                              </li>
                          );
                        })}
                      </ol>
                  )}
                  <div className="dr-compose">
                    <div className="dr-compose-h">
                      <h5>Nowa wiadomość</h5>
                      <label className="dr-inline-add">
                        <span>Szablon</span>
                        <select
                            value=""
                            onChange={(e) => {
                              if (!e.target.value) return;
                              void wstawSzablon(e.target.value as TemplateKey);
                            }}
                            data-assistant-id="crm-compose-template"
                        >
                          <option value="">— pusta wiadomość —</option>
                          {TEMPLATE_KEYS.map((k) => (
                              <option key={k} value={k}>
                                {TEMPLATE_LABELS[k]}
                              </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <MessageEditor
                        to={nowaDo}
                        subject={nowyTemat}
                        body={nowaTresc}
                        podstawienia={podstawieniaDlaSprawy(req)}
                        account={ustawieniaKonta}
                        onToChange={setNowaDo}
                        onSubjectChange={setNowyTemat}
                        onBodyChange={setNowaTresc}
                    />
                    <div className="dr-compose-act">
                      <button
                          type="button"
                          className="btn ghost"
                          onClick={() => void wyslijNowa(false)}
                          disabled={wysylanie}
                      >
                        Zapisz szkic
                      </button>
                      <button
                          type="button"
                          className="btn primary"
                          onClick={() => void wyslijNowa(true)}
                          disabled={wysylanie || nowaTresc.trim() === ""}
                          data-assistant-id="crm-compose-send"
                      >
                        {wysylanie ? "Wysyłanie…" : "Wyślij"}
                      </button>
                    </div>
                  </div>
                </section>
            )}

            {tab === "zalaczniki" && (
                <>
                  <section className="dr-block">
                    <h4>Załączniki od klienta ({odKlienta.length})</h4>
                    <div className="dr-card">
                      {odKlienta.length === 0 ? (
                          <p className="muted">Klient nie przysłał jeszcze żadnych plików.</p>
                      ) : (
                          <ul className="dr-att">
                            {odKlienta.map((a) => (
                                <li key={a.id}>
                          <span className="dr-att-i" aria-hidden="true">
                            ▤
                          </span>
                                  <div className="dr-att-b">
                                    <p className="dr-att-n">
                                      <a
                                          href={crmApi.attachmentUrl(req.id, a.id)}
                                          target="_blank"
                                          rel="noreferrer"
                                          title="Otwórz załącznik"
                                      >
                                        {a.name}
                                      </a>
                                    </p>
                                    <p className="dr-att-m">
                                      {dataGodzinaPL(a.at)} · od: {a.fromName} · {ATTACHMENT_KIND_LABELS[a.kind]}
                                    </p>
                                    {a.messageSubject && (
                                        <p className="dr-att-src">z wiadomości: {a.messageSubject}</p>
                                    )}
                                  </div>
                                  <span className="dr-att-s mono">{a.sizeKb} kB</span>
                                </li>
                            ))}
                          </ul>
                      )}
                      {brakZal.length > 0 && (
                          <p className="dr-meta">
                            Wciąż brakuje: {brakZal.map((k) => ATTACHMENT_KIND_LABELS[k]).join(", ")}.
                          </p>
                      )}
                    </div>
                  </section>

                  <section className="dr-block">
                    <h4>Moje załączniki ({nasze.length})</h4>
                    <div className="dr-card">
                      {nasze.length === 0 ? (
                          <p className="muted">Nie wysłaliśmy jeszcze klientowi żadnych plików.</p>
                      ) : (
                          <ul className="dr-att">
                            {nasze.map((a) => (
                                <li key={a.id}>
                          <span className="dr-att-i own" aria-hidden="true">
                            ▤
                          </span>
                                  <div className="dr-att-b">
                                    <p className="dr-att-n">
                                      <a
                                          href={crmApi.attachmentUrl(req.id, a.id)}
                                          target="_blank"
                                          rel="noreferrer"
                                          title="Otwórz załącznik"
                                      >
                                        {a.name}
                                      </a>
                                    </p>
                                    <p className="dr-att-m">
                                      {dataGodzinaPL(a.at)} · przesłał(a): {a.fromName} ·{" "}
                                      {ATTACHMENT_KIND_LABELS[a.kind]}
                                    </p>
                                    {a.messageSubject && (
                                        <p className="dr-att-src">w wiadomości: {a.messageSubject}</p>
                                    )}
                                  </div>
                                  <span className="dr-att-s mono">{a.sizeKb} kB</span>
                                </li>
                            ))}
                          </ul>
                      )}
                      <p className="dr-meta">
                        Wersja demonstracyjna nie przyjmuje plików z dysku — pozycje pochodzą
                        z korespondencji i z danych przykładowych.
                      </p>
                    </div>
                  </section>
                </>
            )}

            {tab === "outsourcing" && (
                <OutsourcingPanel req={req} vendors={vendors} onChange={onChange} />
            )}

            {tab === "historia" && (
                <section className="dr-block">
                  <ol className="tl compact">
                    {[...req.activity].reverse().map((a) => (
                        <li key={a.id} className="tl-i">
                    <span className="tl-ico sys" aria-hidden="true">
                      {IKONY[a.kind as ActivityKind] ?? "•"}
                    </span>
                          <div className="tl-body">
                            <div className="tl-h">
                              <strong>{a.text}</strong>
                              <span className="tl-who">{a.user}</span>
                            </div>
                            <div className="tl-f">
                              <span>{ACTIVITY_KIND_LABELS[a.kind]}</span>
                              <span>{dataGodzinaPL(a.at)}</span>
                            </div>
                          </div>
                        </li>
                    ))}
                  </ol>
                </section>
            )}
          </div>

          <footer className="dr-foot">
            <span className="dr-foot-v">{kwotaPL(req.quoteValue)}</span>
            <span className="muted">
            {kosztorysant ? kosztorysant.name : "bez kosztorysanta"}
              {pm ? ` · PM: ${pm.name}` : ""}
          </span>
          </footer>
        </aside>
      </>
  );
}