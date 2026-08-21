/** Kalendarz wszystkich zaplanowanych kontaktów CRM. */

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { dzisiajISO, FOLLOWUP_TYPE_LABELS } from "@demo-erp/shared";
import type { CrmFollowUp, CrmRequest } from "@demo-erp/shared";
import { notify } from "../../ui.js";
import { ApiError } from "../../api.js";
import { crmApi } from "../../crm/client.js";
import { useCrmRequests, useEmployeeMap, useEmployees } from "../../crm/hooks.js";
import { Assignee, EmptyState, FollowUpBadge, StageBadge } from "../../crm/components.js";

interface Pozycja {
  r: CrmRequest;
  f: CrmFollowUp;
}

interface DzienKalendarza {
  iso: string;
  numer: number;
  wMiesiacu: boolean;
}

const DNI_TYGODNIA = ["Pon", "Wt", "Śr", "Czw", "Pt", "Sob", "Niedz"];
const DZISIAJ = dzisiajISO();

function dataUTC(iso: string): Date {
  const [rok, miesiac, dzien] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(rok ?? 2000, (miesiac ?? 1) - 1, dzien ?? 1));
}

function dataISO(data: Date): string {
  return data.toISOString().slice(0, 10);
}

function pierwszyDzienMiesiaca(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

function przesunMiesiac(iso: string, delta: number): string {
  const data = dataUTC(pierwszyDzienMiesiaca(iso));
  data.setUTCMonth(data.getUTCMonth() + delta);
  return dataISO(data);
}

function nazwaMiesiaca(iso: string): string {
  const label = dataUTC(iso).toLocaleDateString("pl-PL", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return label.charAt(0).toLocaleUpperCase("pl-PL") + label.slice(1);
}

function pelnaData(iso: string): string {
  return dataUTC(iso).toLocaleDateString("pl-PL", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function dniMiesiaca(miesiacISO: string): DzienKalendarza[] {
  const pierwszy = dataUTC(pierwszyDzienMiesiaca(miesiacISO));
  const przesuniecieOdPoniedzialku = (pierwszy.getUTCDay() + 6) % 7;
  const start = new Date(pierwszy);
  start.setUTCDate(start.getUTCDate() - przesuniecieOdPoniedzialku);
  const prefiksMiesiaca = miesiacISO.slice(0, 7);

  return Array.from({ length: 42 }, (_, index) => {
    const data = new Date(start);
    data.setUTCDate(start.getUTCDate() + index);
    const iso = dataISO(data);
    return {
      iso,
      numer: data.getUTCDate(),
      wMiesiacu: iso.startsWith(prefiksMiesiaca),
    };
  });
}

function jestZamkniety(followUp: CrmFollowUp): boolean {
  return followUp.status === "done" || followUp.status === "skipped";
}

function klasaWydarzenia(followUp: CrmFollowUp): string {
  if (followUp.status === "done") return "done";
  if (followUp.status === "skipped") return "skipped";
  if (followUp.status === "overdue" || followUp.date < DZISIAJ) return "late";
  if (followUp.date === DZISIAJ) return "today";
  return "planned";
}

function ikonaKontaktu(followUp: CrmFollowUp): string {
  if (followUp.type === "phone") return "☎";
  if (followUp.type === "meeting") return "●";
  if (followUp.type === "reoffer") return "↻";
  if (followUp.type === "email") return "✉";
  return "•";
}

export function CrmFollowUpsPage() {
  const { requests, loading, podmien } = useCrmRequests();
  const employees = useEmployees();
  const emap = useEmployeeMap();
  const [assignee, setAssignee] = useState("");
  const [pokazZamkniete, setPokazZamkniete] = useState(false);
  const [miesiac, setMiesiac] = useState(pierwszyDzienMiesiaca(DZISIAJ));
  const [wybranyDzien, setWybranyDzien] = useState(DZISIAJ);
  const [busy, setBusy] = useState<string | null>(null);

  const pozycje = useMemo(() => {
    const wynik: Pozycja[] = [];
    for (const request of requests) {
      if (assignee === "none" && request.assigneeId != null) continue;
      if (assignee !== "" && assignee !== "none" && request.assigneeId !== assignee) continue;
      for (const followUp of request.followUps) {
        if (!pokazZamkniete && jestZamkniety(followUp)) continue;
        wynik.push({ r: request, f: followUp });
      }
    }
    return wynik.sort((a, b) => `${a.f.date}${a.f.time}`.localeCompare(`${b.f.date}${b.f.time}`));
  }, [requests, assignee, pokazZamkniete]);

  const wedlugDaty = useMemo(() => {
    const mapa = new Map<string, Pozycja[]>();
    for (const pozycja of pozycje) {
      const lista = mapa.get(pozycja.f.date) ?? [];
      lista.push(pozycja);
      mapa.set(pozycja.f.date, lista);
    }
    return mapa;
  }, [pozycje]);

  const dni = useMemo(() => dniMiesiaca(miesiac), [miesiac]);
  const dzienAgenda = wedlugDaty.get(wybranyDzien) ?? [];
  const otwarte = pozycje.filter((item) => !jestZamkniety(item.f));
  const zalegle = otwarte.filter((item) => item.f.date < DZISIAJ).length;
  const dzisiaj = otwarte.filter((item) => item.f.date === DZISIAJ).length;
  const wMiesiacu = pozycje.filter((item) => item.f.date.startsWith(miesiac.slice(0, 7))).length;

  function zmienMiesiac(delta: number): void {
    const nastepny = przesunMiesiac(miesiac, delta);
    setMiesiac(nastepny);
    setWybranyDzien(nastepny);
  }

  function przejdzDoDzisiaj(): void {
    setMiesiac(pierwszyDzienMiesiaca(DZISIAJ));
    setWybranyDzien(DZISIAJ);
  }

  function wybierzDzien(iso: string): void {
    setWybranyDzien(iso);
    if (!iso.startsWith(miesiac.slice(0, 7))) setMiesiac(pierwszyDzienMiesiaca(iso));
  }

  async function wykonaj(pozycja: Pozycja): Promise<void> {
    setBusy(pozycja.f.id);
    try {
      const request = await crmApi.doneFollowUp(pozycja.r.id, pozycja.f.id);
      podmien(request);
      notify("Kontakt odnotowany", `${pozycja.r.number} · ${FOLLOWUP_TYPE_LABELS[pozycja.f.type]}`);
    } catch (error) {
      notify(
        "Nie udało się zapisać",
        error instanceof ApiError ? error.body.message : "Spróbuj ponownie.",
        "err",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="fu-page">
      <header className="fu-page-head">
        <div>
          <div className="fu-eyebrow">CRM · plan kontaktów</div>
          <h1>Kalendarz kontaktów</h1>
          <p>Terminy rozmów, spotkań i wiadomości ze wszystkich zapytań.</p>
        </div>
        <div className="fu-head-stats" aria-label="Podsumowanie kontaktów">
          <div className={zalegle > 0 ? "danger" : ""}><strong>{zalegle}</strong><span>zaległych</span></div>
          <div className={dzisiaj > 0 ? "today" : ""}><strong>{dzisiaj}</strong><span>na dziś</span></div>
          <div><strong>{wMiesiacu}</strong><span>w miesiącu</span></div>
        </div>
      </header>

      <div className="fu-toolbar">
        <div className="fu-filter">
          <label htmlFor="fu-assignee">Pracownik</label>
          <select id="fu-assignee" value={assignee} onChange={(event) => setAssignee(event.target.value)}>
            <option value="">Wszyscy pracownicy</option>
            <option value="none">Nieprzypisane</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>{employee.name}</option>
            ))}
          </select>
        </div>
        <label className="fu-closed-toggle">
          <input
            type="checkbox"
            checked={pokazZamkniete}
            onChange={(event) => setPokazZamkniete(event.target.checked)}
          />
          <span>Pokaż zakończone</span>
        </label>
        <span className="fu-toolbar-spacer" />
        <div className="fu-legend" aria-label="Legenda kalendarza">
          <span><i className="late" /> Zaległe</span>
          <span><i className="today" /> Dzisiaj</span>
          <span><i className="planned" /> Zaplanowane</span>
        </div>
      </div>

      {loading && requests.length === 0 ? (
        <div className="fu-calendar-skeleton" aria-label="Wczytywanie kalendarza" />
      ) : (
        <div className="fu-calendar-layout">
          <article className="fu-calendar-card">
            <div className="fu-calendar-nav">
              <div className="fu-month-switcher">
                <button type="button" className="fu-nav-arrow" onClick={() => zmienMiesiac(-1)} aria-label="Poprzedni miesiąc">‹</button>
                <h2>{nazwaMiesiaca(miesiac)}</h2>
                <button type="button" className="fu-nav-arrow" onClick={() => zmienMiesiac(1)} aria-label="Następny miesiąc">›</button>
              </div>
              <button type="button" className="fu-today-btn" onClick={przejdzDoDzisiaj}>Dzisiaj</button>
            </div>

            <div className="fu-weekdays" aria-hidden="true">
              {DNI_TYGODNIA.map((dzien) => <span key={dzien}>{dzien}</span>)}
            </div>
            <div className="fu-calendar-grid">
              {dni.map((dzien) => {
                const wydarzenia = wedlugDaty.get(dzien.iso) ?? [];
                const pozostale = Math.max(0, wydarzenia.length - 3);
                return (
                  <div
                    key={dzien.iso}
                    className={[
                      "fu-day",
                      dzien.wMiesiacu ? "" : "outside",
                      dzien.iso === DZISIAJ ? "is-today" : "",
                      dzien.iso === wybranyDzien ? "selected" : "",
                    ].filter(Boolean).join(" ")}
                  >
                    <button
                      type="button"
                      className="fu-day-number"
                      onClick={() => wybierzDzien(dzien.iso)}
                      aria-label={`Pokaż kontakty: ${pelnaData(dzien.iso)}`}
                    >
                      <time dateTime={dzien.iso}>{dzien.numer}</time>
                      {wydarzenia.length > 0 && <span>{wydarzenia.length}</span>}
                    </button>
                    <div className="fu-day-events">
                      {wydarzenia.slice(0, 3).map((pozycja) => (
                        <Link
                          key={pozycja.f.id}
                          className={`fu-cal-event ${klasaWydarzenia(pozycja.f)}`}
                          to={`/crm/requests/${pozycja.r.id}`}
                          title={`${pozycja.f.time} · ${pozycja.r.companyName} · ${pozycja.f.note}`}
                        >
                          <span className="fu-event-icon" aria-hidden="true">{ikonaKontaktu(pozycja.f)}</span>
                          <span className="fu-event-time">{pozycja.f.time}</span>
                          <strong>{pozycja.r.companyName}</strong>
                        </Link>
                      ))}
                      {pozostale > 0 && (
                        <button type="button" className="fu-more-events" onClick={() => wybierzDzien(dzien.iso)}>
                          +{pozostale} więcej
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </article>

          <aside className="fu-agenda">
            <div className="fu-agenda-head">
              <span>Wybrany dzień</span>
              <h2>{pelnaData(wybranyDzien)}</h2>
              <p>{dzienAgenda.length === 0 ? "Brak zaplanowanych kontaktów" : `${dzienAgenda.length} ${dzienAgenda.length === 1 ? "kontakt" : "kontakty"}`}</p>
            </div>

            <div className="fu-agenda-list">
              {dzienAgenda.length === 0 ? (
                <EmptyState text="Ten dzień jest wolny." hint="Kontakt zaplanujesz w szczegółach zapytania." />
              ) : dzienAgenda.map((pozycja) => (
                <section key={pozycja.f.id} className={`fu-agenda-item ${klasaWydarzenia(pozycja.f)}`}>
                  <div className="fu-agenda-time">
                    <span aria-hidden="true">{ikonaKontaktu(pozycja.f)}</span>
                    <strong>{pozycja.f.time}</strong>
                    <small>{FOLLOWUP_TYPE_LABELS[pozycja.f.type]}</small>
                  </div>
                  <div className="fu-agenda-main">
                    <div className="fu-agenda-tags">
                      <FollowUpBadge status={pozycja.f.status} />
                      <StageBadge stage={pozycja.r.stage} />
                    </div>
                    <Link to={`/crm/requests/${pozycja.r.id}`}>{pozycja.r.number} · {pozycja.r.companyName}</Link>
                    <p>{pozycja.f.note}</p>
                    <Assignee employee={pozycja.r.assigneeId ? emap.get(pozycja.r.assigneeId) : undefined} />
                  </div>
                  {!jestZamkniety(pozycja.f) && (
                    <button
                      type="button"
                      className="fu-done-btn"
                      disabled={busy === pozycja.f.id}
                      onClick={() => void wykonaj(pozycja)}
                    >
                      {busy === pozycja.f.id ? "Zapisywanie…" : "Oznacz jako wykonany"}
                    </button>
                  )}
                </section>
              ))}
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
