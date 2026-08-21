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
  autorWiadomosci,
  szacujTrase,
  widocznaDla,
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
import { ApiError, getUserId } from "../api.js";
import { crmApi } from "./client.js";
import { dataGodzinaPL, dataPL, czasWzgledny, terminOpis } from "./format.js";
import { kwotaPL } from "./BoardCard.js";
import { OutsourcingPanel } from "./OutsourcingPanel.js";
import { StrefaPlikow } from "./FileZone.js";

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
  fullPage?: boolean;
}

function NaglowekPanelu({
                          title,
                          description,
                          action,
                        }: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
      <div className="dr-card-head">
        <div>
          <h4>{title}</h4>
          {description && <p>{description}</p>}
        </div>
        {action && <div className="dr-card-head-act">{action}</div>}
      </div>
  );
}

function IkonaTrasy({ wariant }: { wariant: "jedna" | "obie" | "bufor" }) {
  if (wariant === "jedna") {
    return (
        <svg className="dr-km-svg" viewBox="0 0 20 16" aria-hidden="true">
          <path d="M2 8h14M12 4l4 4-4 4" />
        </svg>
    );
  }
  if (wariant === "obie") {
    return (
        <svg className="dr-km-svg" viewBox="0 0 20 16" aria-hidden="true">
          <path d="M2 5h14M12 2l4 3-4 3M18 11H4M8 8l-4 3 4 3" />
        </svg>
    );
  }
  return (
      <svg className="dr-km-svg" viewBox="0 0 20 16" aria-hidden="true">
        <path d="M2 8h10M8 4l4 4-4 4M16 4v8M12 8h8" />
      </svg>
  );
}

function IkonaPotwierdzenia() {
  return (
      <svg className="tl-ticks" viewBox="0 0 20 12" aria-hidden="true">
        <path d="m1.5 6.5 3 3 5-6" />
        <path d="m8.5 6.5 3 3 7-8" />
      </svg>
  );
}

/** Jedna wektorowa ikona dodawania we wszystkich nagłówkach panelu. */
function IkonaDodawania({ className = "" }: { className?: string }) {
  return (
      <svg
          className={`dr-add-svg${className ? ` ${className}` : ""}`}
          viewBox="0 0 24 24"
          aria-hidden="true"
      >
        <circle cx="12" cy="12" r="11" />
        <path d="M12 7v10M7 12h10" />
      </svg>
  );
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
                                fullPage = false,
                              }: Props) {
  const [tab, setTab] = useState<Zakladka>("szczegoly");
  const [notatkaEtapu, setNotatkaEtapu] = useState<CrmStage | null>(null);
  const [tekstNotatki, setTekstNotatki] = useState("");
  const [dodajKontakt, setDodajKontakt] = useState(false);
  const [edycjaKontaktu, setEdycjaKontaktu] = useState<string | null>(null);
  const [rozwiniete, setRozwiniete] = useState<string[]>([]);
  const [piszemy, setPiszemy] = useState(false);
  const [nowaDo, setNowaDo] = useState(req.email);
  const [nowaDw, setNowaDw] = useState<string[]>([]);
  const [nowyDw, setNowyDw] = useState("");
  const [noweZalaczniki, setNoweZalaczniki] = useState<{ name: string; sizeKb: number }[]>([]);
  const [nowyTemat, setNowyTemat] = useState(`Zapytanie ${req.number} — ${req.projectName}`);
  const [nowaTresc, setNowaTresc] = useState("");
  const [wysylanie, setWysylanie] = useState(false);
  const [odswiezanie, setOdswiezanie] = useState(false);
  const [nowyKosztorysant, setNowyKosztorysant] = useState("");
  const [dodawanieKosztorysanta, setDodawanieKosztorysanta] = useState(false);
  const [nowaKarteczka, setNowaKarteczka] = useState("");
  const [zapisywanieKarteczki, setZapisywanieKarteczki] = useState(false);
  const [karteczkaAktywna, setKarteczkaAktywna] = useState(false);
  const [karteczkiZwiniete, setKarteczkiZwiniete] = useState(true);
  const [bladWiadomosci, setBladWiadomosci] = useState<string | null>(null);
  const [wiadomoscDocelowa, setWiadomoscDocelowa] = useState<string | null>(null);
  const [wartoscWyceny, setWartoscWyceny] = useState(
      req.quoteValue == null ? "" : req.quoteValue.toLocaleString("pl-PL", { maximumFractionDigits: 2 }),
  );
  const [scoreRoboczy, setScoreRoboczy] = useState(req.score);
  // Wysyłamy z konta zalogowanej osoby — odpowiedź klienta ma wrócić do tego,
  // kto pisał, a nie do zbiorczej skrzynki działu.
  /** Dziś → sama godzina, wcześniej → data. Tak samo jak w programach pocztowych. */
  const krotkiCzas = (iso: string): string => {
    const d = new Date(iso);
    const dzis = new Date().toDateString() === d.toDateString();
    return dzis
        ? `Dzisiaj, ${d.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}`
        : d.toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric" });
  };

  const jaId = getUserId();
  const ja = employees.find((e) => e.id === jaId);
  const mojeKonto = ja?.email ?? konto;
  const panel = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const przyciskPisania = useRef<HTMLButtonElement>(null);
  const poleWiadomosci = useRef<HTMLTextAreaElement>(null);
  const koniecWatku = useRef<HTMLDivElement>(null);

  const klient = clients.find((k) => k.id === req.clientId);
  const kosztorysant = employees.find((e) => e.id === req.assigneeId);
  const przypisani = req.assigneeIds
      .map((id) => employees.find((e) => e.id === id))
      .filter((e): e is CrmEmployee => e != null);
  const pm = employees.find((e) => e.id === req.projectManagerId);
  const issues = useMemo(() => wykryjProblemy(req, undefined, wylaczoneReguly), [req, wylaczoneReguly]);

  useEffect(() => {
    setWartoscWyceny(
        req.quoteValue == null ? "" : req.quoteValue.toLocaleString("pl-PL", { maximumFractionDigits: 2 }),
    );
  }, [req.quoteValue]);

  useEffect(() => setScoreRoboczy(req.score), [req.score]);

  const brakZal = req.requiredAttachments.filter((k) => !req.attachments.some((a) => a.kind === k));
  const poDacie = [...req.attachments].sort((a, b) => b.at.localeCompare(a.at));

  /**
   * Wątek sprawy: nasze wiadomości, wiadomości klienta i zaplanowane kontakty
   * w jednej osi czasu. Załączniki wiszą pod wpisem, przy którym przyszły.
   */
  const watek = [
    ...req.messages.filter((m) => widocznaDla(m, jaId)).map((m) => ({
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
      adres: m.to,
      czas: krotkiCzas(m.sentAt ?? m.createdAt),
      autor: autorWiadomosci(m, jaId, employees),
      szkic: m.sentAt == null,
      nowa: m.sentAt != null && m.authorId !== jaId && !m.readBy.includes(jaId ?? ""),
      dw: m.cc,
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
      adres: "kalendarz kontaktów",
      czas: krotkiCzas(`${f.date}T${f.time}:00.000Z`),
      autor: "system" as const,
      szkic: false,
      nowa: false,
      dw: [] as string[],
    })),
    // Jak w komunikatorze: rozmowa biegnie z góry na dół, a najnowszy wpis
    // znajduje się tuż nad polem odpowiedzi.
  ].sort((a, b) => a.at.localeCompare(b.at));
  const odKlienta = poDacie.filter((a) => a.source === "client");
  const nasze = poDacie.filter((a) => a.source === "own");

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // Escape zamyka najpierw dymek notatki, dopiero potem cały panel.
      if (notatkaEtapu) setNotatkaEtapu(null);
      else if (!fullPage) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, notatkaEtapu, fullPage]);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  useEffect(() => {
    if (tab !== "wiadomosci") return;
    window.requestAnimationFrame(() => koniecWatku.current?.scrollIntoView({ block: "end" }));
  }, [tab, req.messages.length, req.followUps.length]);

  useEffect(() => {
    if (tab !== "wiadomosci" || !wiadomoscDocelowa) return;
    const klatka = window.requestAnimationFrame(() => {
      const wpis = panel.current?.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(wiadomoscDocelowa)}"]`,
      );
      wpis?.scrollIntoView({ behavior: "smooth", block: "center" });
      wpis?.focus({ preventScroll: true });
    });
    const wyczysc = window.setTimeout(() => setWiadomoscDocelowa(null), 1800);
    return () => {
      window.cancelAnimationFrame(klatka);
      window.clearTimeout(wyczysc);
    };
  }, [tab, wiadomoscDocelowa]);

  useEffect(() => {
    const pole = poleWiadomosci.current;
    if (!pole) return;
    pole.style.height = "0px";
    pole.style.height = `${Math.max(62, pole.scrollHeight)}px`;
  }, [nowaTresc, piszemy]);

  useEffect(() => {
    if (!piszemy) return;
    const zwinPoKliknieciuObok = (event: PointerEvent): void => {
      const cel = event.target as Node;
      if (composer.current?.contains(cel) || przyciskPisania.current?.contains(cel)) return;
      setPiszemy(false);
    };
    document.addEventListener("pointerdown", zwinPoKliknieciuObok);
    return () => document.removeEventListener("pointerdown", zwinPoKliknieciuObok);
  }, [piszemy]);

  // Wejście w zakładkę korespondencji jest jej przeczytaniem — inaczej licznik
  // nowych wiadomości nigdy by nie gasł.
  useEffect(() => {
    if (tab !== "wiadomosci" || !jaId) return;
    const nowe = req.messages.filter(
        (m) => m.sentAt != null && m.authorId !== jaId && !m.readBy.includes(jaId),
    );
    if (nowe.length === 0) return;
    void crmApi
        .markMessagesRead(req.id, nowe.map((m) => m.id))
        .then(onChange)
        .catch(() => undefined);
  }, [tab, req.id, req.messages, jaId, onChange]);

  async function zapisz(patch: Parameters<typeof crmApi.patch>[1]): Promise<void> {
    try {
      onChange(await crmApi.patch(req.id, patch));
    } catch (e) {
      notify("Nie udało się zapisać zmiany", e instanceof ApiError ? e.body.message : "Spróbuj ponownie.", "err");
    }
  }

  function zatwierdzWartoscWyceny(): void {
    const tekst = wartoscWyceny.replace(/\s/g, "").replace(",", ".").trim();
    if (tekst === "") {
      if (req.quoteValue != null) void zapisz({ quoteValue: null });
      return;
    }
    const liczba = Number(tekst);
    if (Number.isNaN(liczba) || liczba < 0) {
      notify("Niepoprawna wartość wyceny", "Podaj liczbę nieujemną, np. 125 999,99.", "err");
      setWartoscWyceny(
          req.quoteValue == null ? "" : req.quoteValue.toLocaleString("pl-PL", { maximumFractionDigits: 2 }),
      );
      return;
    }
    if (liczba !== req.quoteValue) void zapisz({ quoteValue: liczba });
  }

  function zatwierdzScore(): void {
    if (scoreRoboczy !== req.score) void zapisz({ score: scoreRoboczy });
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

  /** Ręczne odświeżenie wątku — poczta bywa szybsza niż cykl odpytywania. */
  async function odswiez(): Promise<void> {
    setOdswiezanie(true);
    try {
      onChange(await crmApi.request(req.id));
    } catch (e) {
      notify("Nie udało się odświeżyć", e instanceof ApiError ? e.body.message : "Spróbuj ponownie.", "err");
    } finally {
      setOdswiezanie(false);
    }
  }

  /**
   * Wysyłka nowej wiadomości. Panel nie zapisuje już szkiców: półprodukt
   * w wątku mylił się z korespondencją, a i tak nikt do niego nie wracał.
   * Szkice powstają wyłącznie z szybkich akcji i czekają na zatwierdzenie.
   */
  async function wyslijNowa(): Promise<void> {
    const doKogo = nowaDo.trim();
    const temat = nowyTemat.trim();
    const tresc = nowaTresc.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(doKogo)) {
      setBladWiadomosci("Podaj poprawny adres e-mail odbiorcy.");
      setPiszemy(true);
      return;
    }
    if (temat.length < 3) {
      setBladWiadomosci("Temat wiadomości musi mieć co najmniej 3 znaki.");
      setPiszemy(true);
      return;
    }
    if (!tresc) {
      setBladWiadomosci("Wpisz treść wiadomości.");
      return;
    }
    setBladWiadomosci(null);
    setWysylanie(true);
    try {
      const r = await crmApi.compose(req.id, {
        to: doKogo,
        cc: nowaDw,
        subject: temat,
        body: tresc,
        kind: "custom",
        templateKey: null,
        attachments: noweZalaczniki,
        send: true,
      });
      onChange(r);
      setNowaTresc("");
      setNoweZalaczniki([]);
      setNowaDw([]);
      setNowyDw("");
      setBladWiadomosci(null);
      setPiszemy(false);
      notify("Wiadomość wysłana", `${nowaDo} · ${mojeKonto}`);
    } catch (e) {
      const komunikat = e instanceof ApiError ? e.body.message : "Nie udało się wysłać wiadomości. Spróbuj ponownie.";
      setBladWiadomosci(komunikat);
      notify("Nie udało się wysłać", komunikat, "err");
    } finally {
      setWysylanie(false);
    }
  }

  function dodajDw(): void {
    const adresy = nowyDw
        .split(/[;,\s]+/)
        .map((x) => x.trim().toLowerCase())
        .filter((x) => x.includes("@") && x !== nowaDo && !nowaDw.includes(x));
    if (adresy.length > 0) setNowaDw((prev) => [...prev, ...adresy]);
    setNowyDw("");
  }

  function przejdzDoPisania(): void {
    setPiszemy(true);
    window.requestAnimationFrame(() => {
      composer.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      composer.current?.querySelector("textarea")?.focus();
    });
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

  async function dodajKosztorysanta(): Promise<void> {
    if (!nowyKosztorysant || dodawanieKosztorysanta) return;
    const pracownik = employees.find((e) => e.id === nowyKosztorysant);
    setDodawanieKosztorysanta(true);
    try {
      onChange(await crmApi.addAssignee(req.id, nowyKosztorysant));
      setNowyKosztorysant("");
      notify("Dodano kosztorysanta", pracownik?.name ?? "Lista zespołu została zaktualizowana.");
    } catch (e) {
      notify(
          "Nie udało się dodać kosztorysanta",
          e instanceof ApiError ? e.body.message : "Spróbuj ponownie.",
          "err",
      );
    } finally {
      setDodawanieKosztorysanta(false);
    }
  }

  async function dodajKarteczke(): Promise<void> {
    const text = nowaKarteczka.trim();
    if (!text || zapisywanieKarteczki) return;
    setZapisywanieKarteczki(true);
    try {
      onChange(await crmApi.addStickyNote(req.id, text));
      setNowaKarteczka("");
      setKarteczkaAktywna(false);
      notify("Dodano notatkę", "Karteczka jest widoczna dla całego zespołu.");
    } catch (e) {
      notify("Nie udało się dodać notatki", e instanceof ApiError ? e.body.message : "Spróbuj ponownie.", "err");
    } finally {
      setZapisywanieKarteczki(false);
    }
  }

  async function usunKarteczke(id: string): Promise<void> {
    if (!window.confirm("Usunąć tę notatkę zespołu?")) return;
    try {
      onChange(await crmApi.removeStickyNote(req.id, id));
    } catch (e) {
      notify("Nie udało się usunąć notatki", e instanceof ApiError ? e.body.message : "Spróbuj ponownie.", "err");
    }
  }

  function otworzWiadomoscZalacznika(messageId: string | null, messageSubject: string | null): void {
    const wiadomosc = req.messages.find(
        (m) => (messageId != null && m.id === messageId) ||
            (messageSubject != null && m.subject === messageSubject),
    );
    if (!wiadomosc) {
      notify("Nie znaleziono wiadomości", "Źródłowa wiadomość nie jest już dostępna w konwersacji.", "err");
      return;
    }
    setRozwiniete((prev) => prev.includes(wiadomosc.id) ? prev : [...prev, wiadomosc.id]);
    setWiadomoscDocelowa(wiadomosc.id);
    setTab("wiadomosci");
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
        {!fullPage && <div className="dr-scrim" onClick={onClose} />}
        <aside
            className={`dr${fullPage ? " dr-page" : ""}`}
            ref={panel}
            tabIndex={-1}
            role={fullPage ? "region" : "dialog"}
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
              {fullPage && (
                  <>
                    <Link to={`/crm/requests/${req.id}/edit`} className="btn ghost">
                      Edytuj dane
                    </Link>
                    <Link to="/crm/board" className="btn ghost">
                      Wróć do tablicy
                    </Link>
                  </>
              )}
              {!fullPage && (
                  <>
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
                  </>
              )}
            </div>
          </header>

          <div className="dr-lead">
            <aside
                className={`dr-sticky-rail${karteczkiZwiniete ? " collapsed" : ""}`}
                aria-label="Notatki zespołu"
            >
              <button
                  type="button"
                  className="dr-sticky-collapse"
                  onClick={() => setKarteczkiZwiniete((v) => !v)}
                  aria-expanded={!karteczkiZwiniete}
                  aria-label={karteczkiZwiniete ? "Pokaż notatki zespołu" : "Zwiń notatki zespołu"}
                  title={karteczkiZwiniete ? `Pokaż notatki (${req.stickyNotes.length})` : "Zwiń notatki"}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 4h11l3 3v13H5zM16 4v4h3" />
                  <path d={karteczkiZwiniete ? "m9 9 4 3-4 3" : "m14 9-4 3 4 3"} />
                </svg>
                {karteczkiZwiniete && req.stickyNotes.length > 0 && <span>{req.stickyNotes.length}</span>}
              </button>
              <div className="dr-sticky-stack">
                {req.stickyNotes.map((note, index) => (
                    <article className={`dr-sticky ${note.color} tilt-${index % 7}`} key={note.id}>
                      <button
                          type="button"
                          className="dr-sticky-x"
                          onClick={() => void usunKarteczke(note.id)}
                          aria-label={`Usuń notatkę autora ${note.authorName}`}
                      >×</button>
                      <p>{note.text}</p>
                      <footer>
                        <strong>{note.authorName}</strong>
                        <span>{dataGodzinaPL(note.createdAt)}</span>
                      </footer>
                    </article>
                ))}
                <div className={`dr-sticky-form tilt-${req.stickyNotes.length % 7}`}>
                  <textarea
                      rows={5}
                      value={nowaKarteczka}
                      maxLength={600}
                      placeholder="Napisz notatkę…"
                      disabled={zapisywanieKarteczki}
                      onChange={(e) => setNowaKarteczka(e.target.value)}
                      onFocus={() => setKarteczkaAktywna(true)}
                      onBlur={() => {
                        if (nowaKarteczka.trim()) void dodajKarteczke();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void dodajKarteczke();
                        }
                      }}
                      data-assistant-id="crm-sticky-text"
                      aria-label="Nowa notatka zespołu"
                  />
                  <span>{zapisywanieKarteczki ? "Przypinanie…" : "Enter przypina · Shift+Enter dodaje wiersz"}</span>
                </div>
                {karteczkaAktywna && (
                    <div
                        className={`dr-sticky-form dr-sticky-reserve tilt-${(req.stickyNotes.length + 1) % 7}`}
                        aria-hidden="true"
                    >
                      <span>Kolejna karteczka jest gotowa</span>
                    </div>
                )}
              </div>
            </aside>
            <p className="dr-lead-h">Opis zapytania</p>
            <p className="dr-lead-t">{req.description}</p>
            {(req.products || req.quantity) && (
                <p className="dr-lead-m">
                  Zakres: {req.products ?? "-"}
                  {req.quantity ? ` · ${req.quantity}` : ""}
                </p>
            )}
          </div>

          {issues.length > 0 && (
              <div className="dr-alerts">
                {issues.map((i) => (
                    <div key={i.id} className={`dr-alert ${i.severity}${i.waitingSince ? " waiting" : ""}`}>
                <span className="dr-alert-ico" aria-hidden="true">
                  {i.severity === "error" ? "!" : "△"}
                </span>
                      <p>
                        <strong>{i.title}:</strong> {i.message}
                        {i.waitingSince && (
                            <span className="dr-alert-wait">
                              Prośbę wysłano {dataGodzinaPL(i.waitingSince)} ({czasWzgledny(i.waitingSince)}).
                            </span>
                        )}
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

          <div className="dr-content-shell">
            <div className={`dr-scroll dr-scroll-${tab}`}>
            {tab === "szczegoly" && (
                <>
                  <section className="dr-block">
                    <div className="dr-card dr-stage-card">
                      <NaglowekPanelu
                          title="Etap procesu"
                          description="Kliknij etap, aby dodać notatkę. Podwójne kliknięcie ustawia etap sprawy."
                      />
                      <div className="dr-flow">
                      {CRM_PIPELINE.map((s, i) => {
                        const aktywny = s === req.stage;
                        const zrobiony = idxEtapu > i;
                        const problemyEtapu = issues.filter((x) => x.stage === s);
                        const problem = problemyEtapu.find((x) => x.severity === "error") ?? problemyEtapu[0];
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
                              {problemyEtapu.length > 0 && (
                                  <div className={`dr-stage-issues ${problem?.severity ?? "warn"}${problem?.waitingSince ? " waiting" : ""}`} role="tooltip">
                                    <strong>
                                      {problemyEtapu.length === 1
                                          ? "Problem powiązany z etapem"
                                          : `Problemy powiązane z etapem (${problemyEtapu.length})`}
                                    </strong>
                                    <ul>
                                      {problemyEtapu.map((p) => (
                                          <li key={p.id}>
                                            {p.message}
                                            {p.waitingSince && <small>Wysłano {dataGodzinaPL(p.waitingSince)}.</small>}
                                          </li>
                                      ))}
                                    </ul>
                                  </div>
                              )}
                            </div>
                        );
                      })}
                    </div>

                    {req.stage === "lost" && req.lostReason ? (
                        <p className="dr-lost">
                          Przegrane: {LOST_REASON_LABELS[req.lostReason]}
                          {req.lostReasonNote ? ` — ${req.lostReasonNote}` : ""}
                        </p>
                    ) : null}
                    </div>
                  </section>

                  <section className="dr-block">
                    <div className="dr-card">
                      <NaglowekPanelu
                          title="Klient"
                          description="Dane pochodzą z kartoteki klienta i są tutaj tylko do odczytu. Zmiana w tym miejscu rozjechałaby się z pozostałymi zapytaniami tego klienta."
                      />
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

                      <dl className="dr-data-list">
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
                          <dd>{klient?.address ?? req.address ?? "-"}</dd>
                        </div>
                      </dl>
                    </div>
                  </section>

                  <section className="dr-block">
                    <div className="dr-card">
                      <NaglowekPanelu
                          title={`Osoby kontaktowe (${klient?.contacts.length ?? 1})`}
                          description="Kontakty należą do kartoteki klienta i są wspólne dla wszystkich jego zapytań. Zmiana kontaktu głównego aktualizuje adres korespondencji."
                          action={
                            klient && !dodajKontakt ? (
                                <button
                                    type="button"
                                    className="dr-add-c"
                                    onClick={() => setDodajKontakt(true)}
                                    data-assistant-id="crm-drawer-add-contact"
                                >
                                  <IkonaDodawania />
                                  <span>Dodaj osobę</span>
                                </button>
                            ) : undefined
                          }
                      />
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
                                  <span className="dr-c-person">
                                    <span className="dr-c-n">{k.name}</span>
                                    {k.role && <span className="dr-c-r">{k.role}</span>}
                                  </span>
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
                          dodajKontakt && (
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
                          )}
                    </div>
                  </section>

                  <section className="dr-block">
                    <div className="dr-card">
                      <NaglowekPanelu
                          title="Dostawa"
                          description="Adres budowy i orientacyjna odległość transportu liczona od siedziby firmy."
                      />
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
                      <p className={`dr-route-origin${trasa && !trasa.nieznane ? " has-distance" : ""}`}>
                        Liczone z: {DEPOT.address}
                        {trasa && !trasa.nieznane ? ` → ${trasa.miasto}` : ""}.
                      </p>
                      {!adres && (
                          <p className="dr-meta">
                            Bez adresu dostawy nie da się policzyć transportu ani montażu.
                          </p>
                      )}
                      {trasa && !trasa.nieznane && (
                          <div className="dr-km">
                            <div>
                              <span className="dr-km-h"><IkonaTrasy wariant="jedna" /><span>W jedną stronę</span></span>
                              <strong>{trasa.wJednaStrone} km</strong>
                            </div>
                            <div>
                              <span className="dr-km-h"><IkonaTrasy wariant="obie" /><span>W obie strony</span></span>
                              <strong>{trasa.wDwieStrony} km</strong>
                            </div>
                            <div className="wyroz">
                              <span className="dr-km-h"><IkonaTrasy wariant="bufor" /><span>Z buforem +{trasa.bufor} km</span></span>
                              <strong>{trasa.zBuforem} km</strong>
                            </div>
                          </div>
                      )}
                      {trasa?.nieznane && (
                          <p className="dr-meta">
                            Nie rozpoznano miasta w adresie — kilometrów nie oszacowano.
                          </p>
                      )}
                    </div>
                  </section>

                  <section className="dr-block">
                    <div className="dr-card">
                      <NaglowekPanelu
                          title="Sprawa"
                          description="Najważniejsze parametry handlowe, szansa wygrania i terminy zapytania."
                      />
                      <div className="dr-metrics dr-metrics-two">
                        <label className="dr-metric-editable">
                          <span className="dr-metric-h">Wartość</span>
                          <input
                              className="dr-metric-input"
                              value={wartoscWyceny}
                              inputMode="decimal"
                              placeholder="—"
                              aria-label="Wartość wyceny w PLN"
                              onChange={(e) => setWartoscWyceny(e.target.value)}
                              onBlur={zatwierdzWartoscWyceny}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                if (e.key === "Escape") {
                                  setWartoscWyceny(
                                      req.quoteValue == null
                                          ? ""
                                          : req.quoteValue.toLocaleString("pl-PL", { maximumFractionDigits: 2 }),
                                  );
                                  (e.target as HTMLInputElement).blur();
                                }
                              }}
                              data-assistant-id="crm-drawer-value"
                          />
                          <span className="dr-metric-unit">PLN</span>
                        </label>
                        <div className="dr-score-metric">
                          <span className="dr-metric-h">Prawd. wygrania</span>
                          <strong className="dr-metric-v">
                            {scoreRoboczy}
                            <small>/100</small>
                          </strong>
                          <input
                              className="dr-score-slider"
                              type="range"
                              min={0}
                              max={100}
                              step={1}
                              value={scoreRoboczy}
                              aria-label={`Prawdopodobieństwo wygrania: ${scoreRoboczy}%`}
                              onChange={(e) => setScoreRoboczy(Number(e.target.value))}
                              onPointerUp={zatwierdzScore}
                              onKeyUp={(e) => {
                                if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") zatwierdzScore();
                              }}
                              onBlur={zatwierdzScore}
                              data-assistant-id="crm-drawer-score"
                          />
                        </div>
                      </div>

                      <p className="dr-subsection-h">Terminy</p>
                      <div className="dr-deadlines">
                        <div>
                          <span>Data wpłynięcia</span>
                          <strong>{dataPL(req.createdAt)}</strong>
                        </div>
                        <label>
                          <span>Termin dostawy</span>
                          <span className="dr-deadline-edit">
                            <input
                                type="date"
                                value={req.deadline ?? ""}
                                onChange={(e) => void zapisz({ deadline: e.target.value })}
                                data-assistant-id="crm-drawer-deadline"
                            />
                            {req.deadline && <small>{terminOpis(req.deadline)}</small>}
                          </span>
                        </label>
                      </div>
                    </div>
                  </section>

                  <section className="dr-block">
                    <div className="dr-card">
                      <NaglowekPanelu
                          title="Zespół sprawy"
                          description="Osoby odpowiedzialne za prowadzenie zapytania i przygotowanie kosztorysu."
                      />
                      <div className="dr-rows">
                        <label className="dr-row dr-pm-row">
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
                          Historia przypisanych kosztorysantów ({przypisani.length})
                        </p>
                        <p className="dr-assignees-desc">W kolejności, w jakiej sprawa do nich trafiała.</p>
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
                          <div className="dr-add-a-copy">
                            <IkonaDodawania />
                            <p>
                              <strong>Przypisz kolejnego kosztorysanta</strong>
                              <span>Po dodaniu stanie się bieżącym opiekunem sprawy.</span>
                            </p>
                          </div>
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
                                disabled={nowyKosztorysant === "" || dodawanieKosztorysanta}
                                onClick={() => void dodajKosztorysanta()}
                                data-assistant-id="crm-drawer-assignee-add"
                            >
                              {dodawanieKosztorysanta ? "Dodawanie…" : "Dodaj"}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </section>

                </>
            )}

            {tab === "wiadomosci" && (
                <section className="dr-block dr-message-panel">
                  <div className="dr-msg-bar">
                    <button
                        ref={przyciskPisania}
                        type="button"
                        className="dr-write-btn"
                        onClick={przejdzDoPisania}
                        data-assistant-id="crm-compose-open"
                    >
                      ✎ Napisz wiadomość do klienta
                    </button>
                    {/* Etykieta i szerokość przycisku nie zmieniają się w trakcie
                    pobierania — podmiana tekstu na „…” wyglądała jak mrugnięcie
                    całego paska. Stan sygnalizuje sama ikona. */}
                    <button
                        type="button"
                        className={`dr-refresh-btn${odswiezanie ? " pracuje" : ""}`}
                        onClick={() => void odswiez()}
                        aria-busy={odswiezanie}
                        title="Pobierz najnowszą korespondencję"
                        data-assistant-id="crm-compose-refresh"
                    >
                  <span className="dr-refresh-ico" aria-hidden="true">
                    ⟳
                  </span>
                      Odśwież
                    </button>
                  </div>

                  <p className="dr-meta">
                    Cała korespondencja sprawy w jednym miejscu — niezależnie od tego, kto pisał:
                    kosztorysant, kierownik czy klient. Najnowsze wiadomości są na dole; kliknij wpis,
                    aby rozwinąć pełną treść.
                  </p>
                  {watek.length === 0 ? (
                      <p className="muted">Brak korespondencji i kontaktów w tej sprawie.</p>
                  ) : (
                      <ol className="tl tl-chat">
                        {watek.map((w) => {
                          const otwarty = rozwiniete.includes(w.id);
                          const przelaczWiadomosc = (): void =>
                              setRozwiniete((prev) =>
                                  prev.includes(w.id) ? prev.filter((x) => x !== w.id) : [...prev, w.id],
                              );
                          return (
                              <li
                                  key={w.id}
                                  className={`tl-i a-${w.autor}${w.szkic ? " szkic" : ""}${
                                      w.nowa ? " nowa" : ""
                                  }${otwarty ? " open" : ""}${wiadomoscDocelowa === w.id ? " source-target" : ""}`}
                                  data-message-id={w.kanal === "mail" ? w.id : undefined}
                                  tabIndex={-1}
                              >
                        <span className={`tl-ico ${w.kanal}${w.przychodzaca ? " in" : ""}`} aria-hidden="true">
                          {w.kanal === "phone" ? "☎" : w.kanal === "meet" ? "◫" : "✉"}
                        </span>

                                <div
                                    className="tl-body"
                                    role="button"
                                    tabIndex={0}
                                    aria-expanded={otwarty}
                                    onClick={przelaczWiadomosc}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        przelaczWiadomosc();
                                      }
                                    }}
                                    data-assistant-id={`crm-thread-${w.id}`}
                                >
                          <span className="tl-top">
                            <span className="tl-adres">
                              {w.przychodzaca ? (
                                  <strong>{w.kto}</strong>
                              ) : (
                                  <>
                                    <span className="tl-lab">od: </span>
                                    <strong>{w.kto}</strong>
                                    <span className="tl-lab">, do: </span>
                                    <strong>{w.adres}</strong>
                                  </>
                              )}
                            </span>
                            <span className="tl-czas">
                              {w.nowa && <span className="tl-new" title="Nieprzeczytana">●</span>}
                              {w.pliki.length > 0 && <span className="tl-clip" aria-hidden="true">📎</span>}
                              {w.czas}
                            </span>
                          </span>

                                  <span className="tl-temat">
                            {w.naglowek}
                                    {w.szkic && <span className="tl-draft">szkic — tylko dla Ciebie</span>}
                          </span>

                                  {w.tresc &&
                                      (otwarty ? (
                                          <span className="tl-full">{w.tresc}</span>
                                      ) : (
                                          <span className="tl-peek">{w.tresc.replace(/\s+/g, " ")}</span>
                                      ))}

                                  {w.pliki.length > 0 && (
                                      <span className="tl-files">
                              {w.pliki.map((a2, n) => (
                                  <a
                                      key={a2.id}
                                      className={`tl-file${n === 0 && a2.source === "own" ? " glowny" : ""}`}
                                      href={crmApi.attachmentUrl(req.id, a2.id)}
                                      target="_blank"
                                      rel="noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                  >
                                  <span className="tl-file-i" aria-hidden="true">
                                    ▤
                                  </span>
                                    {a2.name} ({a2.sizeKb} kB)
                                  </a>
                              ))}
                            </span>
                                  )}

                                  {w.dw.length > 0 && <span className="tl-peek">DW: {w.dw.join(", ")}</span>}

                                  <span className="tl-card-foot">
                                    {w.tresc && (
                                        <span className="tl-expand-hint">
                                          {otwarty ? "Zwiń wiadomość" : "Pokaż cały e-mail"}
                                        </span>
                                    )}
                                    <span className={`tl-stan ${w.wyslana ? "ok" : "pending"}`}>
                                      {w.status}
                                      {w.wyslana && <IkonaPotwierdzenia />}
                                    </span>
                                  </span>
                                </div>
                              </li>
                          );
                        })}
                      </ol>
                  )}
                  <div ref={koniecWatku} aria-hidden="true" />

                  <div className={`dr-chat-composer${piszemy ? " expanded" : ""}`} ref={composer}>
                    <div className="dr-chat-head">
                          <button
                              type="button"
                              className="dr-chat-mail-toggle"
                              onClick={() => setPiszemy((v) => !v)}
                              aria-expanded={piszemy}
                              title={piszemy ? "Zwiń dodatkowe pola wiadomości" : "Pokaż pola adresowe wiadomości"}
                          >
                            <span>
                              <strong>Do:</strong> {nowaDo || "wybierz odbiorcę"}
                            </span>
                            <span>
                              <strong>Temat:</strong> {nowyTemat || "bez tematu"}
                            </span>
                            {nowaDw.length > 0 && <span><strong>DW:</strong> {nowaDw.join(", ")}</span>}
                            <span className="dr-chat-caret" aria-hidden="true">{piszemy ? "▴" : "▾"}</span>
                          </button>
                          {piszemy && (
                              <label className="dr-chat-template">
                                <span>Szablon</span>
                                <select
                                    value=""
                                    onChange={(e) => {
                                      if (!e.target.value) return;
                                      void wstawSzablon(e.target.value as TemplateKey);
                                    }}
                                    data-assistant-id="crm-compose-template"
                                >
                                  <option value="">Pusta wiadomość</option>
                                  {TEMPLATE_KEYS.map((k) => (
                                      <option key={k} value={k}>{TEMPLATE_LABELS[k]}</option>
                                  ))}
                                </select>
                              </label>
                          )}
                    </div>

                    {piszemy && (
                        <div className="dr-chat-meta-fields">
                          <p className="dr-chat-from"><strong>Od:</strong> {mojeKonto}</p>
                          <label>
                            <span>Do</span>
                            <input
                                type="email"
                                value={nowaDo}
                                list={`crm-contact-list-${req.id}`}
                                onChange={(e) => {
                                  setNowaDo(e.target.value);
                                  setBladWiadomosci(null);
                                }}
                                placeholder="adres@firma.pl"
                            />
                            <datalist id={`crm-contact-list-${req.id}`}>
                              {(klient?.contacts ?? []).map((kontakt) => (
                                  <option key={kontakt.id} value={kontakt.email}>{kontakt.name}</option>
                              ))}
                            </datalist>
                          </label>
                          <label>
                            <span>Temat</span>
                            <input
                                value={nowyTemat}
                                onChange={(e) => {
                                  setNowyTemat(e.target.value);
                                  setBladWiadomosci(null);
                                }}
                            />
                          </label>
                          <div className="dr-chat-cc-row">
                            <span>DW</span>
                            <div className="dr-chat-cc-box">
                              {nowaDw.map((adres) => (
                                  <span className="dr-chat-chip" key={adres}>
                                    {adres}
                                    <button
                                        type="button"
                                        aria-label={`Usuń ${adres}`}
                                        onClick={() => setNowaDw((prev) => prev.filter((x) => x !== adres))}
                                    >×</button>
                                  </span>
                              ))}
                              <input
                                  value={nowyDw}
                                  onChange={(e) => setNowyDw(e.target.value)}
                                  onBlur={dodajDw}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === "," || e.key === ";") {
                                      e.preventDefault();
                                      dodajDw();
                                    }
                                  }}
                                  placeholder="Dodaj odbiorcę DW"
                              />
                            </div>
                          </div>
                        </div>
                    )}

                    <div className="dr-chat-write-row">
                      <textarea
                          ref={poleWiadomosci}
                          rows={3}
                          value={nowaTresc}
                          onChange={(e) => {
                            setNowaTresc(e.target.value);
                            setBladWiadomosci(null);
                          }}
                          onKeyDown={(e) => {
                            if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && nowaTresc.trim()) {
                              e.preventDefault();
                              void wyslijNowa();
                            }
                          }}
                          placeholder="Napisz wiadomość do klienta…"
                          data-assistant-id="crm-compose-body"
                      />
                    </div>

                    <div className="dr-chat-tools">
                      <StrefaPlikow
                          compact
                          pliki={noweZalaczniki}
                          onChange={setNoweZalaczniki}
                          naglowek={noweZalaczniki.length > 0 ? "Dodaj kolejne pliki" : "Załącz pliki"}
                          hint=""
                      />
                      <button
                          type="button"
                          className="dr-send-btn"
                          onClick={() => void wyslijNowa()}
                          disabled={wysylanie}
                          data-assistant-id="crm-compose-send"
                      >
                        {wysylanie ? "Wysyłanie…" : "Wyślij"}
                      </button>
                    </div>
                    <p className="dr-chat-file-hint" title="Wersja demonstracyjna zapisuje nazwę i rozmiar pliku, nie jego treść.">
                      Wersja demonstracyjna zapisuje nazwę i rozmiar pliku, nie jego treść.
                    </p>
                    {bladWiadomosci && <p className="dr-chat-error" role="alert">{bladWiadomosci}</p>}
                    <p className="dr-chat-hint">Ctrl + Enter wysyła wiadomość</p>
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
                                        <button
                                            type="button"
                                            className="dr-att-src"
                                            onClick={() => otworzWiadomoscZalacznika(a.messageId, a.messageSubject)}
                                            title="Przejdź do źródłowej wiadomości"
                                        >
                                          z wiadomości: <span>{a.messageSubject}</span>
                                        </button>
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
                                        <button
                                            type="button"
                                            className="dr-att-src"
                                            onClick={() => otworzWiadomoscZalacznika(a.messageId, a.messageSubject)}
                                            title="Przejdź do źródłowej wiadomości"
                                        >
                                          w wiadomości: <span>{a.messageSubject}</span>
                                        </button>
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
