/**
 * CrmBoard.tsx — tablica zapytań.
 *
 * Kolumny to nie etapy, tylko LUDZIE: „Nowe”, kolumna każdego kosztorysanta,
 * kolumny własne i „Przegrane”. Etap sprawy żyje na szynie kafelka, dzięki
 * czemu jedna tablica odpowiada naraz na dwa pytania — kto się tym zajmuje
 * i jak daleko jest sprawa.
 *
 * Kolumny ZAWIJAJĄ SIĘ do kolejnego rzędu zamiast uciekać w poziome
 * przewijanie. Kolumna, do której trzeba przewinąć w bok, jest kolumną,
 * o której się zapomina — a tu każda z nich to czyjaś praca.
 *
 * Każda kolumna ma własne sortowanie, własny limit widocznych kafelków
 * („Pokaż więcej”) i można ją zwinąć. Ustawienia są per-osoba i siedzą
 * w localStorage (patrz boardPrefs.ts).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { pilnosc, pulsKafelka, wykryjProblemy } from "@demo-erp/shared";
import type {
  CrmClient,
  CrmColumn,
  CrmEmployee,
  CrmIssue,
  CrmMessage,
  CrmRequest,
  CrmSettings,
  CrmVendor,
  TemplateKey,
} from "@demo-erp/shared";
import { notify } from "../../ui.js";
import { ApiError } from "../../api.js";
import { crmApi } from "../../crm/client.js";
import { useMailbox } from "../../crm/poller.js";
import { BoardCard, kwotaPL } from "../../crm/BoardCard.js";
import { RequestDrawer } from "../../crm/RequestDrawer.js";
import { LostReasonModal } from "../../crm/modals.js";
import { SendMessageModal } from "../../crm/SendMessageModal.js";
import { Modal } from "../../crm/components.js";
import {
  COLOR_MODES,
  COLOR_MODE_LABELS,
  ROZMIARY_STRONY,
  SORT_LABELS,
  SORT_MODES,
  prefsKolumny,
  wczytajPrefs,
  zapiszPrefs,
} from "../../crm/boardPrefs.js";
import type { BoardPrefs, ColorMode, SortMode } from "../../crm/boardPrefs.js";

const WAGA_PILNOSCI = { critical: 3, high: 2, normal: 1, low: 0 } as const;

function porownaj(a: CrmRequest, b: CrmRequest, tryb: SortMode): number {
  switch (tryb) {
    case "newest":
      return b.createdAt.localeCompare(a.createdAt);
    case "oldest":
      return a.createdAt.localeCompare(b.createdAt);
    case "value_desc":
      return (b.quoteValue ?? -1) - (a.quoteValue ?? -1);
    case "value_asc":
      return (a.quoteValue ?? Number.MAX_SAFE_INTEGER) - (b.quoteValue ?? Number.MAX_SAFE_INTEGER);
    case "urgency_asc":
      return WAGA_PILNOSCI[pilnosc(a)] - WAGA_PILNOSCI[pilnosc(b)];
    case "issues": {
      const w = (r: CrmRequest): number => {
        const p = wykryjProblemy(r);
        if (p.some((x) => x.severity === "error")) return 2;
        return p.length > 0 ? 1 : 0;
      };
      const d = w(b) - w(a);
      return d !== 0 ? d : b.createdAt.localeCompare(a.createdAt);
    }
    case "urgency_desc":
    default: {
      const d = WAGA_PILNOSCI[pilnosc(b)] - WAGA_PILNOSCI[pilnosc(a)];
      return d !== 0 ? d : b.createdAt.localeCompare(a.createdAt);
    }
  }
}

export function CrmBoardPage() {
  const [columns, setColumns] = useState<CrmColumn[]>([]);
  const [requests, setRequests] = useState<CrmRequest[]>([]);
  const [clients, setClients] = useState<CrmClient[]>([]);
  const [employees, setEmployees] = useState<CrmEmployee[]>([]);
  const [vendors, setVendors] = useState<CrmVendor[]>([]);
  /** Reguły problemów wyłączone w ustawieniach modułu — wspólne dla firmy. */
  const [wylaczoneReguly, setWylaczoneReguly] = useState<string[]>([]);
  const [ustawieniaModulu, setUstawieniaModulu] = useState<CrmSettings | null>(null);
  /** Szkic informacji o opiekunie czekający na decyzję po przeciągnięciu karty. */
  const [doWyslania, setDoWyslania] = useState<{
    req: CrmRequest;
    messageId: string;
    title: string;
    intro: string;
    severity: CrmIssue["severity"];
    poprzednia: CrmMessage | null;
  } | null>(null);
  const [powiadomienie, setPowiadomienie] = useState<{
    req: CrmRequest;
    messageId: string;
    poprzedniaKolumna: string;
    poprzedniAssignee: string | null;
  } | null>(null);
  const [cofaniePowiadomienia, setCofaniePowiadomienia] = useState(false);
  const [loading, setLoading] = useState(true);
  const [blad, setBlad] = useState<string | null>(null);

  const [prefs, setPrefs] = useState<BoardPrefs>(() => wczytajPrefs());
  const [ciagniete, setCiagniete] = useState<string | null>(null);
  const [nadKolumna, setNadKolumna] = useState<string | null>(null);
  const [menuKolumny, setMenuKolumny] = useState<string | null>(null);
  const [doPrzegranych, setDoPrzegranych] = useState<{ req: CrmRequest; columnId: string } | null>(null);
  const [nowaKolumna, setNowaKolumna] = useState(false);
  const [ustawienia, setUstawienia] = useState(false);
  const [szukaj, setSzukaj] = useState("");
  const [tylkoProblemy, setTylkoProblemy] = useState(false);

  const [params, setParams] = useSearchParams();
  const otwarteId = params.get("id");
  const mailbox = useMailbox();

  useEffect(() => zapiszPrefs(prefs), [prefs]);

  // Pierwsze zetknięcie z kolumną nie jest „nowością” — bez tego licznik „+N”
  // pokazywałby przy starcie całą zawartość tablicy.
  useEffect(() => {
    if (columns.length === 0) return;
    setPrefs((p) => {
      const brakujace = columns.filter((c) => prefsKolumny(p, c.id).checkedAt == null);
      if (brakujace.length === 0) return p;
      const teraz = new Date().toISOString();
      const kolumnyPrefs = { ...p.columns };
      for (const c of brakujace) {
        kolumnyPrefs[c.id] = { ...prefsKolumny(p, c.id), checkedAt: teraz };
      }
      return { ...p, columns: kolumnyPrefs };
    });
  }, [columns]);

  const wczytaj = useCallback(async (): Promise<void> => {
    try {
      const b = await crmApi.board();
      setColumns(b.columns);
      setRequests(b.requests);
      setClients(b.clients);
      setEmployees(b.employees);
      setWylaczoneReguly(b.disabledIssues ?? []);
      setUstawieniaModulu(b.settings ?? null);
      setBlad(null);
    } catch (e) {
      setBlad(e instanceof ApiError ? e.body.message : "Nie udało się wczytać tablicy.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void wczytaj();
    void crmApi
        .vendors()
        .then(setVendors)
        .catch(() => undefined);
  }, [wczytaj]);

  // Po każdym pobraniu poczty odświeżamy tablicę — nowe karty mają wpadać
  // do „Nowych” same, bez klikania „odśwież”.
  const ostatnie = mailbox.state?.lastCheckedAt ?? null;
  useEffect(() => {
    if (ostatnie) void wczytaj();
  }, [ostatnie, wczytaj]);

  const podmien = useCallback((r: CrmRequest): void => {
    setRequests((prev) => prev.map((x) => (x.id === r.id ? r : x)));
  }, []);

  const otwarte = requests.find((r) => r.id === otwarteId) ?? null;

  const otworz = useCallback(
      (id: string): void => {
        setParams((p) => {
          const n = new URLSearchParams(p);
          n.set("id", id);
          return n;
        });
        const r = requests.find((x) => x.id === id);
        if (r && !r.seenAt) void crmApi.markSeen(id).then(podmien).catch(() => undefined);
      },
      [podmien, requests, setParams],
  );

  const zamknij = useCallback((): void => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.delete("id");
      return n;
    });
  }, [setParams]);

  async function przenies(id: string, columnId: string): Promise<void> {
    const req = requests.find((r) => r.id === id);
    if (!req || req.columnId === columnId) return;
    const kol = columns.find((c) => c.id === columnId);
    if (kol?.kind === "lost") {
      setDoPrzegranych({ req, columnId });
      return;
    }
    const poprzedniaKolumna = req.columnId;
    const poprzedniAssignee = req.assigneeId;
    try {
      const r = await crmApi.move(id, columnId);
      podmien(r);
      notify("Karta przeniesiona", `${r.number} → ${kol?.title ?? "kolumna"}`);

      // Przypisanie kosztorysanta to moment, w którym klient powinien poznać
      // swojego rozmówcę — ale treść wychodzi dopiero po akceptacji człowieka.
      if (kol?.kind === "estimator" && r.assigneeId && r.assigneeId !== poprzedniAssignee) {
        const zSzkicem = await crmApi.draftAssignment(r.id);
        podmien(zSzkicem);
        const szkic = zSzkicem.messages.filter((m) => !m.sentAt).at(-1);
        if (szkic) {
          setPowiadomienie({
            req: zSzkicem,
            messageId: szkic.id,
            poprzedniaKolumna,
            poprzedniAssignee,
          });
        }
      }
    } catch (e) {
      notify("Nie udało się przenieść karty", e instanceof ApiError ? e.body.message : "Spróbuj ponownie.", "err");
    }
  }

  async function cofnijPrzeniesienieZPowiadomienia(): Promise<void> {
    const dane = powiadomienie;
    if (!dane || cofaniePowiadomienia) return;
    setCofaniePowiadomienia(true);
    try {
      await crmApi.discardMessage(dane.req.id, dane.messageId);
      const przeniesione = await crmApi.move(dane.req.id, dane.poprzedniaKolumna);
      const finalne =
          dane.poprzedniAssignee && przeniesione.assigneeId !== dane.poprzedniAssignee
              ? await crmApi.patch(dane.req.id, { assigneeId: dane.poprzedniAssignee })
              : przeniesione;
      podmien(finalne);
      setPowiadomienie(null);
      notify("Cofnięto przeniesienie", `${dane.req.number} wróciło na poprzednie miejsce.`);
    } catch (e) {
      notify(
          "Nie udało się cofnąć",
          e instanceof ApiError ? e.body.message : "Spróbuj ponownie.",
          "err",
      );
    } finally {
      setCofaniePowiadomienia(false);
    }
  }

  /** Szybkie akcje z paska problemu — na kafelku i w panelu szczegółów. */
  const akcjaProblemu = useCallback(
      async (req: CrmRequest, issue: CrmIssue): Promise<void> => {
        const klucz: Record<string, TemplateKey> = {
          email_address: "address",
          email_attachments: "attachments",
          email_data: "missing_data",
        };
        const key = issue.action ? klucz[issue.action] : undefined;
        if (!key) {
          otworz(req.id);
          return;
        }
        try {
          // Szybka akcja PRZYGOTOWUJE treść, nie wysyła. Nic nie idzie do
          // klienta, czego człowiek nie zobaczył — zwłaszcza gdy wystarczy
          // jedno kliknięcie na kafelku.
          const { request, messageId } = await crmApi.draftFromTemplate(req.id, key);
          podmien(request);
          setDoWyslania({
            req: request,
            messageId,
            title: issue.actionLabel ?? "Wyślij wiadomość",
            intro: `${request.number} · ${request.companyName} — ${issue.message}`,
            severity: issue.severity,
            poprzednia:
                request.messages.find(
                    (m) => m.templateKey === key && m.sentAt && m.id !== messageId,
                ) ?? null,
          });
        } catch (e) {
          notify(
              "Nie udało się przygotować wiadomości",
              e instanceof ApiError ? e.body.message : "Spróbuj ponownie.",
              "err",
          );
        }
      },
      [otworz, podmien],
  );

  const widoczne = useMemo(() => {
    const q = szukaj.trim().toLowerCase();
    return requests.filter((r) => {
      if (tylkoProblemy && wykryjProblemy(r, undefined, wylaczoneReguly).length === 0) return false;
      if (q === "") return true;
      return (
          r.projectName.toLowerCase().includes(q) ||
          r.companyName.toLowerCase().includes(q) ||
          r.number.toLowerCase().includes(q)
      );
    });
  }, [requests, szukaj, tylkoProblemy, wylaczoneReguly]);

  const emap = new Map(employees.map((e) => [e.id, e]));
  const nowych = requests.filter((r) => r.columnId === "col-new" && !r.seenAt).length;

  const ustawKolumne = (id: string, patch: Partial<ReturnType<typeof prefsKolumny>>): void =>
      setPrefs((p) => ({
        ...p,
        columns: { ...p.columns, [id]: { ...prefsKolumny(p, id), ...patch } },
      }));

  async function usunKolumne(c: CrmColumn): Promise<void> {
    const karty = requests.filter((r) => r.columnId === c.id).length;
    const pytanie =
        karty > 0
            ? `Kolumna „${c.title}” zawiera ${karty} ${karty === 1 ? "kartę" : "kart"}. Po usunięciu wrócą do „Nowych”. Kontynuować?`
            : `Usunąć kolumnę „${c.title}”?`;
    if (!window.confirm(pytanie)) return;
    try {
      await crmApi.removeColumn(c.id);
      notify("Kolumna usunięta", `„${c.title}” — karty wróciły do „Nowych”.`);
      void wczytaj();
    } catch (e) {
      notify("Nie udało się usunąć kolumny", e instanceof ApiError ? e.body.message : "Spróbuj ponownie.", "err");
    }
  }

  return (
      <section className="page crm-board-page">
        <div className="page-head">
          <h1>Tablica zapytań</h1>
          <span className="spacer" />
          <input
              type="search"
              className="crm-search"
              placeholder="Szukaj: budowa, klient, numer…"
              value={szukaj}
              onChange={(e) => setSzukaj(e.target.value)}
              data-assistant-id="crm-board-search"
          />
          <label className="check">
            <input
                type="checkbox"
                checked={tylkoProblemy}
                onChange={(e) => setTylkoProblemy(e.target.checked)}
                data-assistant-id="crm-board-only-issues"
            />
            Tylko z problemami
          </label>
          <button type="button" onClick={() => setUstawienia(true)} data-assistant-id="crm-board-settings">
            Ustawienia listy
          </button>
          <button type="button" onClick={() => setNowaKolumna(true)} data-assistant-id="crm-board-add-column">
            + Kolumna
          </button>
        </div>

        <p className="crm-board-info">
          {nowych > 0 ? (
              <>
                <span className="crm-pulse-dot" /> {nowych}{" "}
                {nowych === 1 ? "nowe zapytanie czeka" : "nowych zapytań czeka"} na przydzielenie —
                przeciągnij kartę do kolumny kosztorysanta.
              </>
          ) : (
              "Przeciągnij kartę do kolumny kosztorysanta, aby przydzielić sprawę. Kliknięcie karty otwiera szczegóły."
          )}
        </p>

        {blad && <p className="crm-note danger">{blad}</p>}

        <div className="crm-board">
          {columns.map((c) => {
            const pk = prefsKolumny(prefs, c.id);
            const wszystkie = widoczne.filter((r) => r.columnId === c.id).sort((a, b) => porownaj(a, b, pk.sort));
            const limit = pk.limit > 0 ? pk.limit : prefs.pageSize;
            const pokazane = wszystkie.slice(0, limit);
            const suma = wszystkie.reduce((s, r) => s + (r.quoteValue ?? 0), 0);
            // „+N” liczy karty, które weszły do kolumny po ostatnim sprawdzeniu
            // przez TĘ osobę — stąd data z preferencji lokalnych, nie z API.
            const nowePoSprawdzeniu = pk.checkedAt
                ? wszystkie.filter((r) => r.columnEnteredAt > pk.checkedAt!).length
                : 0;
            const problemy = wszystkie.map((r) => wykryjProblemy(r, undefined, wylaczoneReguly));
            const problemow = problemy.filter((p) => p.length > 0).length;
            const bledow = problemy.filter((p) => p.some((x) => x.severity === "error")).length;

            return (
                <section
                    key={c.id}
                    className={`crm-col k-${c.kind} c-${c.color}${nadKolumna === c.id ? " nad" : ""}${
                        pk.collapsed ? " zwinieta" : ""
                    }`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (nadKolumna !== c.id) setNadKolumna(c.id);
                    }}
                    onDragLeave={() => setNadKolumna((v) => (v === c.id ? null : v))}
                    onDrop={(e) => {
                      e.preventDefault();
                      setNadKolumna(null);
                      const id = e.dataTransfer.getData("text/plain");
                      setCiagniete(null);
                      // Upuszczenie na zwiniętą kolumnę ją rozwija — inaczej karta
                      // znikałaby użytkownikowi z oczu.
                      if (pk.collapsed) ustawKolumne(c.id, { collapsed: false });
                      if (id) void przenies(id, c.id);
                    }}
                >
                  <header className="crm-col-h">
                    {/* Cały nagłówek jest przełącznikiem zwijania — trafienie
                    w kilkupikselową strzałkę było niepotrzebną próbą celności. */}
                    <button
                        type="button"
                        className="crm-col-fold"
                        onClick={() =>
                            ustawKolumne(c.id, {
                              collapsed: !pk.collapsed,
                              // Zajrzenie do kolumny jest jej sprawdzeniem — licznik
                              // „+N” zeruje się dopiero wtedy, nie przy samym wejściu
                              // na tablicę.
                              checkedAt: new Date().toISOString(),
                            })
                        }
                        aria-expanded={!pk.collapsed}
                        title={pk.collapsed ? "Rozwiń kolumnę" : "Zwiń kolumnę"}
                        data-assistant-id={`crm-col-fold-${c.id}`}
                    >
                  <span className="crm-col-caret" aria-hidden="true">
                    {pk.collapsed ? "▸" : "▾"}
                  </span>
                      <span className="crm-col-title" title={c.title}>
                    {c.title}
                  </span>
                    </button>
                    {nowePoSprawdzeniu > 0 && (
                        <span
                            className="crm-col-new-n"
                            title={`${nowePoSprawdzeniu} nowych kart od Twojego ostatniego sprawdzenia tej kolumny`}
                        >
                    +{nowePoSprawdzeniu}
                  </span>
                    )}
                    {problemow > 0 && (
                        <span
                            className={`crm-col-err${bledow > 0 ? " err" : " warn"}`}
                            title={`${problemow} ${problemow === 1 ? "karta wymaga" : "kart wymaga"} uwagi${
                                bledow > 0 ? `, w tym ${bledow} z błędem` : ""
                            }`}
                        >
                    ! {problemow}
                  </span>
                    )}
                    <span className="crm-col-n" title={`${wszystkie.length} kart w kolumnie`}>
                  {wszystkie.length}
                </span>
                    <ColumnMenu
                        open={menuKolumny === c.id}
                        onToggle={() => setMenuKolumny((v) => (v === c.id ? null : c.id))}
                        sort={pk.sort}
                        onSort={(s) => {
                          ustawKolumne(c.id, { sort: s });
                          setMenuKolumny(null);
                        }}
                        limit={limit}
                        onLimit={(n) => ustawKolumne(c.id, { limit: n })}
                        removable={c.removable}
                        onRemove={() => {
                          setMenuKolumny(null);
                          void usunKolumne(c);
                        }}
                        columnId={c.id}
                    />
                  </header>

                  {!pk.collapsed && (
                      <>
                        <p className="crm-col-sum">{suma > 0 ? kwotaPL(suma) : "bez wyceny"}</p>

                        <div className="crm-col-body">
                          {pokazane.map((r) => (
                              <BoardCard
                                  key={r.id}
                                  req={r}
                                  przypisani={r.assigneeIds
                                      .map((eid) => emap.get(eid))
                                      .filter((e): e is CrmEmployee => e != null)}
                                  employees={employees}
                                  colorMode={prefs.colorMode}
                                  wylaczoneReguly={wylaczoneReguly}
                                  onOpen={otworz}
                                  onAction={(rq, issue) => void akcjaProblemu(rq, issue)}
                                  onDragStart={setCiagniete}
                                  onDragEnd={() => setCiagniete(null)}
                                  dragging={ciagniete === r.id}
                              />
                          ))}
                          {wszystkie.length === 0 && (
                              <p className="crm-col-empty">{loading ? "Wczytywanie…" : "Przeciągnij tutaj kartę"}</p>
                          )}
                          {wszystkie.length > pokazane.length && (
                              <button
                                  type="button"
                                  className="crm-col-more"
                                  onClick={() => ustawKolumne(c.id, { limit: limit + prefs.pageSize })}
                                  data-assistant-id={`crm-col-more-${c.id}`}
                              >
                                Pokaż więcej ({wszystkie.length - pokazane.length})
                              </button>
                          )}
                          {limit > prefs.pageSize && wszystkie.length > prefs.pageSize && (
                              <button
                                  type="button"
                                  className="crm-col-less"
                                  onClick={() => ustawKolumne(c.id, { limit: prefs.pageSize })}
                              >
                                Zwiń listę
                              </button>
                          )}
                        </div>
                      </>
                  )}

                  {pk.collapsed && (
                      <p className="crm-col-folded">
                        {wszystkie.length} {wszystkie.length === 1 ? "karta" : "kart"}
                        {suma > 0 ? ` · ${kwotaPL(suma)}` : ""}
                        {problemow > 0 && (
                            <span className={bledow > 0 ? "crm-col-folded-err" : "crm-col-folded-warn"}>
                      {" "}
                              · {problemow} z problemem{bledow > 0 ? ` (${bledow} błąd${bledow === 1 ? "" : "y"})` : ""}
                    </span>
                        )}
                      </p>
                  )}
                </section>
            );
          })}
        </div>

        {otwarte && (
            <RequestDrawer
                req={otwarte}
                clients={clients}
                employees={employees}
                onChange={podmien}
                onClose={zamknij}
                onLost={(r) => setDoPrzegranych({ req: r, columnId: "col-lost" })}
                onIssueAction={(r, i) => void akcjaProblemu(r, i)}
                wylaczoneReguly={wylaczoneReguly}
                onClientChange={(k) => setClients((prev) => prev.map((x) => (x.id === k.id ? k : x)))}
                vendors={vendors}
                konto={ustawieniaModulu?.mailbox.account ?? "skrzynka działu"}
            />
        )}

        {doPrzegranych && (
            <LostReasonModal
                req={doPrzegranych.req}
                onClose={() => setDoPrzegranych(null)}
                onSaved={(r) => {
                  podmien(r);
                  setDoPrzegranych(null);
                }}
                zapiszJako={(reason, note) => crmApi.move(doPrzegranych.req.id, doPrzegranych.columnId, reason, note)}
            />
        )}

        {nowaKolumna && (
            <NowaKolumnaModal
                employees={employees}
                zajete={columns.map((c) => c.employeeId).filter((x): x is string => x != null)}
                onClose={() => setNowaKolumna(false)}
                onAdded={() => {
                  setNowaKolumna(false);
                  void wczytaj();
                }}
            />
        )}

        {doWyslania && (
            <SendMessageModal
                req={doWyslania.req}
                messageId={doWyslania.messageId}
                title={doWyslania.title}
                intro={doWyslania.intro}
                introTone={doWyslania.severity}
                poprzednia={doWyslania.poprzednia}
                onClose={(r) => {
                  if (r) podmien(r);
                  setDoWyslania(null);
                }}
                onSent={(r) => {
                  podmien(r);
                  setDoWyslania(null);
                }}
                pracownicy={employees}
                firma={ustawieniaModulu?.company ?? null}
            />
        )}

        {powiadomienie && (
            <SendMessageModal
                req={powiadomienie.req}
                messageId={powiadomienie.messageId}
                title="Poinformować klienta o opiekunie?"
                intro={`${powiadomienie.req.number} · ${powiadomienie.req.companyName} — sprawę prowadzi teraz ${
                    employees.find((e) => e.id === powiadomienie.req.assigneeId)?.name ?? "wskazany kosztorysant"
                }.`}
                poprzednia={
                  [...powiadomienie.req.messages].reverse().find(
                      (m) => m.templateKey === "assignment" && m.sentAt && m.id !== powiadomienie.messageId,
                  ) ?? null
                }
                pracownicy={employees}
                firma={ustawieniaModulu?.company ?? null}
                externalBusy={cofaniePowiadomienia}
                extraActions={
                  <button
                      type="button"
                      onClick={() => void cofnijPrzeniesienieZPowiadomienia()}
                      disabled={cofaniePowiadomienia}
                  >
                    {cofaniePowiadomienia ? "Cofanie…" : "Cofnij przeniesienie"}
                  </button>
                }
                onClose={(r) => {
                  if (r) podmien(r);
                  setPowiadomienie(null);
                }}
                onSent={(r) => {
                  podmien(r);
                  setPowiadomienie(null);
                }}
            />
        )}

        {ustawienia && (
            <UstawieniaModal
                prefs={prefs}
                onChange={setPrefs}
                onClose={() => setUstawienia(false)}
            />
        )}
      </section>
  );
}

// ---------------------------- menu kolumny ---------------------------------

function ColumnMenu({
                      open,
                      onToggle,
                      sort,
                      onSort,
                      limit,
                      onLimit,
                      removable,
                      onRemove,
                      columnId,
                    }: {
  open: boolean;
  onToggle: () => void;
  sort: SortMode;
  onSort: (s: SortMode) => void;
  limit: number;
  onLimit: (n: number) => void;
  removable: boolean;
  onRemove: () => void;
  columnId: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);

  // Klik poza menu zamyka je — inaczej zostaje otwarte i zasłania karty.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) onToggle();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onToggle]);

  return (
      <div className="crm-col-menu-wrap" ref={wrap}>
        <button
            type="button"
            className="crm-col-menu-btn"
            onClick={onToggle}
            aria-haspopup="menu"
            aria-expanded={open}
            title="Sortowanie i widok kolumny"
            data-assistant-id={`crm-col-menu-${columnId}`}
        >
          ⋮
        </button>
        {open && (
            <div className="crm-col-menu" role="menu">
              <p className="crm-menu-h">Sortowanie</p>
              {SORT_MODES.map((s) => (
                  <button
                      key={s}
                      type="button"
                      role="menuitemradio"
                      aria-checked={sort === s}
                      className={sort === s ? "on" : ""}
                      onClick={() => onSort(s)}
                  >
                    {SORT_LABELS[s]}
                  </button>
              ))}
              <p className="crm-menu-h">Widocznych kafelków</p>
              <div className="crm-menu-row">
                {ROZMIARY_STRONY.map((n) => (
                    <button key={n} type="button" className={limit === n ? "on" : ""} onClick={() => onLimit(n)}>
                      {n}
                    </button>
                ))}
              </div>
              {removable && (
                  <>
                    <p className="crm-menu-h">Kolumna</p>
                    <button type="button" className="danger" onClick={onRemove}>
                      Usuń kolumnę
                    </button>
                  </>
              )}
            </div>
        )}
      </div>
  );
}

// ------------------------------ ustawienia ---------------------------------

function UstawieniaModal({
                           prefs,
                           onChange,
                           onClose,
                         }: {
  prefs: BoardPrefs;
  onChange: (p: BoardPrefs) => void;
  onClose: () => void;
}) {
  return (
      <Modal
          title="Ustawienia listy"
          onClose={onClose}
          footer={
            <>
              <span className="spacer" />
              <button className="primary" onClick={onClose}>
                Gotowe
              </button>
            </>
          }
      >
        <p className="crm-note">
          Ustawienia są zapamiętywane w tej przeglądarce i dotyczą tylko Ciebie — zwinięcie
          kolumny u jednej osoby nie zwija jej całemu zespołowi.
        </p>

        <p className="section-title">Kolorowanie kafelków</p>
        <div className="crm-radios">
          {COLOR_MODES.map((m) => (
              <label key={m} className={prefs.colorMode === m ? "sel" : ""}>
                <input
                    type="radio"
                    name="color-mode"
                    checked={prefs.colorMode === m}
                    onChange={() => onChange({ ...prefs, colorMode: m as ColorMode })}
                />
                {COLOR_MODE_LABELS[m]}
              </label>
          ))}
        </div>
        <p className="crm-note">
          Kolor tła jest dodatkiem, nie zamiennikiem sygnałów: paski problemów i szyna etapu
          zachowują swoje kolory niezależnie od tego ustawienia.
        </p>

        <p className="section-title">Domyślna liczba kafelków w kolumnie</p>
        <div className="crm-radios">
          {ROZMIARY_STRONY.map((n) => (
              <label key={n} className={prefs.pageSize === n ? "sel" : ""}>
                <input
                    type="radio"
                    name="page-size"
                    checked={prefs.pageSize === n}
                    onChange={() => onChange({ ...prefs, pageSize: n })}
                />
                {n}
              </label>
          ))}
        </div>

        <button
            type="button"
            onClick={() => onChange({ columns: {}, colorMode: "none", pageSize: 5 })}
            data-assistant-id="crm-prefs-reset"
        >
          Przywróć ustawienia domyślne
        </button>
      </Modal>
  );
}

// --------------------------- dodawanie kolumny -----------------------------

function NowaKolumnaModal({
                            employees,
                            zajete,
                            onClose,
                            onAdded,
                          }: {
  employees: CrmEmployee[];
  zajete: string[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [rodzaj, setRodzaj] = useState<"estimator" | "custom">("estimator");
  const [employeeId, setEmployeeId] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [blad, setBlad] = useState<string | null>(null);

  const wolni = employees.filter((e) => e.role !== "administrator" && !zajete.includes(e.id));

  async function zapisz(): Promise<void> {
    if (rodzaj === "estimator" && employeeId === "") {
      setBlad("Wybierz kosztorysanta.");
      return;
    }
    if (rodzaj === "custom" && title.trim().length < 2) {
      setBlad("Podaj nazwę kolumny (co najmniej 2 znaki).");
      return;
    }
    setBusy(true);
    try {
      await crmApi.addColumn({
        title: rodzaj === "custom" ? title.trim() : "",
        employeeId: rodzaj === "estimator" ? employeeId : null,
      });
      onAdded();
    } catch (e) {
      setBlad(e instanceof ApiError ? e.body.message : "Nie udało się dodać kolumny.");
    } finally {
      setBusy(false);
    }
  }

  return (
      <Modal
          title="Nowa kolumna tablicy"
          onClose={onClose}
          footer={
            <>
              <span className="spacer" />
              <button onClick={onClose}>Anuluj</button>
              <button className="primary" onClick={() => void zapisz()} disabled={busy}>
                {busy ? "Dodawanie…" : "Dodaj kolumnę"}
              </button>
            </>
          }
      >
        <div className="crm-radios">
          <label className={rodzaj === "estimator" ? "sel" : ""}>
            <input
                type="radio"
                name="col-kind"
                checked={rodzaj === "estimator"}
                onChange={() => setRodzaj("estimator")}
            />
            Kolumna kosztorysanta
          </label>
          <label className={rodzaj === "custom" ? "sel" : ""}>
            <input
                type="radio"
                name="col-kind"
                checked={rodzaj === "custom"}
                onChange={() => setRodzaj("custom")}
            />
            Kolumna własna
          </label>
        </div>

        {rodzaj === "estimator" ? (
            <div className="f-row" style={{ marginTop: 10 }}>
              <label htmlFor="col-emp">Kosztorysant</label>
              <select
                  id="col-emp"
                  value={employeeId}
                  onChange={(e) => {
                    setEmployeeId(e.target.value);
                    setBlad(null);
                  }}
              >
                <option value="">— wybierz —</option>
                {wolni.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                ))}
              </select>
              {wolni.length === 0 && <p className="crm-note">Wszyscy pracownicy mają już własne kolumny.</p>}
              <p className="crm-note">
                Upuszczenie karty na taką kolumnę przypisuje sprawę temu kosztorysantowi.
              </p>
            </div>
        ) : (
            <div className="f-row" style={{ marginTop: 10 }}>
              <label htmlFor="col-title">Nazwa kolumny</label>
              <input
                  id="col-title"
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setBlad(null);
                  }}
                  placeholder="np. Do weryfikacji, Wstrzymane, Duże projekty"
              />
              <p className="crm-note">Kolumna własna nie przypisuje spraw — służy do porządkowania pracy.</p>
            </div>
        )}

        {blad && <p className="crm-note danger">{blad}</p>}
      </Modal>
  );
}
