/**
 * CrmRequestForm.tsx — ręczne zakładanie i edycja zapytania.
 *
 * Walidacja idzie ze schematu Zod z pakietu shared — tego samego, którego
 * używa API. Komunikat przy polu jest więc dosłownie tym, co odrzuciłby
 * serwer, a nie jego frontendową parafrazą.
 */

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ATTACHMENT_KINDS,
  ATTACHMENT_KIND_LABELS,
  CreateCrmRequestSchema,
  CRM_SOURCES,
  CRM_SOURCE_LABELS,
} from "@demo-erp/shared";
import type { AttachmentKind, ApiErrorBody, CrmSource } from "@demo-erp/shared";
import { ApiError } from "../../api.js";
import { ErrorBanner } from "../../App.js";
import { notify } from "../../ui.js";
import { crmApi } from "../../crm/client.js";
import { useEmployees } from "../../crm/hooks.js";

interface Formularz {
  projectName: string;
  siteAddress: string;
  quoteValue: string;
  companyName: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  description: string;
  products: string;
  quantity: string;
  deadline: string;
  source: CrmSource;
  assigneeId: string;
  requiredAttachments: AttachmentKind[];
}

const PUSTY: Formularz = {
  projectName: "",
  siteAddress: "",
  quoteValue: "",
  companyName: "",
  contactName: "",
  email: "",
  phone: "",
  address: "",
  description: "",
  products: "",
  quantity: "",
  deadline: "",
  source: "manual",
  assigneeId: "",
  requiredAttachments: ["specification"],
};

export function CrmRequestFormPage() {
  const { id } = useParams();
  const isNew = id === undefined;
  const navigate = useNavigate();
  const employees = useEmployees();

  const [f, setF] = useState<Formularz>(PUSTY);
  const [bledy, setBledy] = useState<Record<string, string>>({});
  const [apiError, setApiError] = useState<ApiErrorBody | null>(null);
  const [busy, setBusy] = useState(false);
  const [wczytywanie, setWczytywanie] = useState(!isNew);

  useEffect(() => {
    if (isNew || !id) return;
    void crmApi
        .request(id)
        .then((r) => {
          setF({
            projectName: r.projectName,
            siteAddress: r.siteAddress ?? "",
            quoteValue: r.quoteValue == null ? "" : String(r.quoteValue),
            companyName: r.companyName,
            contactName: r.contactName,
            email: r.email,
            phone: r.phone ?? "",
            address: r.address ?? "",
            description: r.description,
            products: r.products ?? "",
            quantity: r.quantity ?? "",
            deadline: r.deadline ?? "",
            source: r.source,
            assigneeId: r.assigneeId ?? "",
            requiredAttachments: r.requiredAttachments,
          });
        })
        .catch((e: unknown) => {
          if (e instanceof ApiError) setApiError(e.body);
        })
        .finally(() => setWczytywanie(false));
  }, [id, isNew]);

  const zmien = (patch: Partial<Formularz>): void => setF((s) => ({ ...s, ...patch }));

  function przelaczZalacznik(k: AttachmentKind): void {
    setF((s) => ({
      ...s,
      requiredAttachments: s.requiredAttachments.includes(k)
          ? s.requiredAttachments.filter((x) => x !== k)
          : [...s.requiredAttachments, k],
    }));
  }

  async function zapisz(): Promise<void> {
    setApiError(null);
    const wejscie = {
      projectName: f.projectName.trim(),
      siteAddress: f.siteAddress.trim(),
      quoteValue: f.quoteValue.trim(),
      companyName: f.companyName.trim(),
      contactName: f.contactName.trim(),
      email: f.email.trim(),
      phone: f.phone.trim(),
      address: f.address.trim(),
      description: f.description.trim(),
      products: f.products.trim(),
      quantity: f.quantity.trim(),
      deadline: f.deadline,
      source: f.source,
      assigneeId: f.assigneeId,
      requiredAttachments: f.requiredAttachments,
    };

    const wynik = CreateCrmRequestSchema.safeParse(wejscie);
    if (!wynik.success) {
      const mapa: Record<string, string> = {};
      for (const i of wynik.error.issues) {
        const klucz = i.path.join(".");
        mapa[klucz] ??= i.message;
      }
      setBledy(mapa);
      notify("Formularz zawiera błędy", "Popraw zaznaczone pola.", "err");
      return;
    }
    setBledy({});
    setBusy(true);
    try {
      if (isNew) {
        const r = await crmApi.create(wynik.data);
        notify("Zapytanie utworzone", `${r.number} · etap „Nowe”`);
        navigate(`/crm/requests/${r.id}`);
      } else if (id) {
        const { source: _pomijamy, ...reszta } = wynik.data;
        const r = await crmApi.update(id, reszta);
        notify("Zapisano zmiany", r.number);
        navigate(`/crm/requests/${r.id}`);
      }
    } catch (e) {
      if (e instanceof ApiError) setApiError(e.body);
      else notify("Nie udało się zapisać", "Spróbuj ponownie.", "err");
    } finally {
      setBusy(false);
    }
  }

  const pole = (klucz: keyof Formularz): string | undefined => bledy[klucz];

  if (wczytywanie) {
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

  return (
      <>
        <div className="toolbar">
          <div>
            <h1>{isNew ? "Nowe zapytanie" : "Edycja zapytania"}</h1>
            <p className="page-sub">
              Pola oznaczone gwiazdką są wymagane. Pozostałe wpływają na status kompletności
              i na scoring zapytania.
            </p>
          </div>
        </div>

        <ErrorBanner error={apiError} />

        <div className="card">
          <div className="section-title">Budowa</div>
          <div className="grid">
            <div className="f-row">
              <label htmlFor="c-project">
                Nazwa budowy<span className="req">*</span>
              </label>
              <input
                  id="c-project"
                  data-assistant-id="field.crm-project"
                  className={pole("projectName") ? "invalid" : ""}
                  value={f.projectName}
                  onChange={(e) => zmien({ projectName: e.target.value })}
                  placeholder="np. Hala P4 — Gliwice"
              />
              {pole("projectName") && <div className="field-error">{pole("projectName")}</div>}
            </div>
            <div className="f-row">
              <label htmlFor="c-site">Adres budowy (miejsce dostawy)</label>
              <input
                  id="c-site"
                  data-assistant-id="field.crm-site"
                  value={f.siteAddress}
                  onChange={(e) => zmien({ siteAddress: e.target.value })}
                  placeholder="np. ul. Bojkowska 92, 44-100 Gliwice"
              />
            </div>
            <div className="f-row">
              <label htmlFor="c-value">Wartość wyceny (PLN)</label>
              <input
                  id="c-value"
                  data-assistant-id="field.crm-value"
                  className={pole("quoteValue") ? "invalid" : ""}
                  value={f.quoteValue}
                  onChange={(e) => zmien({ quoteValue: e.target.value })}
                  placeholder="np. 125999.99"
              />
              {pole("quoteValue") && <div className="field-error">{pole("quoteValue")}</div>}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="section-title">Dane klienta</div>
          <div className="grid">
            <div className="f-row">
              <label htmlFor="c-company">
                Nazwa firmy lub klienta<span className="req">*</span>
              </label>
              <input
                  id="c-company"
                  data-assistant-id="field.crm-company"
                  className={pole("companyName") ? "invalid" : ""}
                  value={f.companyName}
                  onChange={(e) => zmien({ companyName: e.target.value })}
                  placeholder="np. Stalmex Sp. z o.o."
              />
              {pole("companyName") && <div className="field-error">{pole("companyName")}</div>}
            </div>
            <div className="f-row">
              <label htmlFor="c-contact">
                Imię i nazwisko<span className="req">*</span>
              </label>
              <input
                  id="c-contact"
                  data-assistant-id="field.crm-contact"
                  className={pole("contactName") ? "invalid" : ""}
                  value={f.contactName}
                  onChange={(e) => zmien({ contactName: e.target.value })}
                  placeholder="np. Anna Wiśniewska"
              />
              {pole("contactName") && <div className="field-error">{pole("contactName")}</div>}
            </div>
            <div className="f-row">
              <label htmlFor="c-email">
                Adres e-mail<span className="req">*</span>
              </label>
              <input
                  id="c-email"
                  data-assistant-id="field.crm-email"
                  className={pole("email") ? "invalid" : ""}
                  value={f.email}
                  onChange={(e) => zmien({ email: e.target.value })}
                  placeholder="np. a.wisniewska@firma.pl"
              />
              {pole("email") && <div className="field-error">{pole("email")}</div>}
            </div>
            <div className="f-row">
              <label htmlFor="c-phone">Numer telefonu</label>
              <input
                  id="c-phone"
                  value={f.phone}
                  onChange={(e) => zmien({ phone: e.target.value })}
                  placeholder="np. +48 601 224 118"
              />
              <div className="hint">Brak telefonu obniża scoring zapytania.</div>
            </div>
            <div className="f-row" style={{ gridColumn: "span 2" }}>
              <label htmlFor="c-address">Adres</label>
              <input
                  id="c-address"
                  value={f.address}
                  onChange={(e) => zmien({ address: e.target.value })}
                  placeholder="ulica, kod pocztowy, miejscowość"
              />
            </div>
          </div>

          <div className="section-title" style={{ marginTop: 18 }}>
            Zakres zapytania
          </div>
          <div className="grid">
            <div className="f-row" style={{ gridColumn: "span 3" }}>
              <label htmlFor="c-desc">
                Opis zapytania<span className="req">*</span>
              </label>
              <textarea
                  id="c-desc"
                  data-assistant-id="field.crm-description"
                  className={pole("description") ? "invalid" : ""}
                  value={f.description}
                  onChange={(e) => zmien({ description: e.target.value })}
                  placeholder="Czego dotyczy zapytanie, w jakim zakresie, jakie warunki brzegowe."
              />
              {pole("description") && <div className="field-error">{pole("description")}</div>}
            </div>
            <div className="f-row">
              <label htmlFor="c-products">Wymagane produkty lub usługi</label>
              <input
                  id="c-products"
                  value={f.products}
                  onChange={(e) => zmien({ products: e.target.value })}
                  placeholder="np. konstrukcje wsporcze, ocynk ogniowy"
              />
            </div>
            <div className="f-row">
              <label htmlFor="c-qty">Ilość</label>
              <input
                  id="c-qty"
                  value={f.quantity}
                  onChange={(e) => zmien({ quantity: e.target.value })}
                  placeholder="np. 40 kpl."
              />
            </div>
            <div className="f-row">
              <label htmlFor="c-deadline">Termin odpowiedzi lub realizacji</label>
              <input
                  id="c-deadline"
                  type="date"
                  value={f.deadline}
                  onChange={(e) => zmien({ deadline: e.target.value })}
              />
            </div>
          </div>

          <div className="section-title" style={{ marginTop: 18 }}>
            Wymagane załączniki
          </div>
          <p className="crm-note">
            Zaznacz dokumenty niezbędne do wyceny. Brakujące pozycje trafią na listę braków
            i do treści prośby o uzupełnienie.
          </p>
          <div className="crm-checks">
            {ATTACHMENT_KINDS.map((k) => (
                <label key={k} className={f.requiredAttachments.includes(k) ? "sel" : ""}>
                  <input
                      type="checkbox"
                      checked={f.requiredAttachments.includes(k)}
                      onChange={() => przelaczZalacznik(k)}
                  />
                  {ATTACHMENT_KIND_LABELS[k]}
                </label>
            ))}
          </div>

          <div className="section-title" style={{ marginTop: 18 }}>
            Obsługa
          </div>
          <div className="grid">
            <div className="f-row">
              <label htmlFor="c-source">Źródło zapytania</label>
              <select
                  id="c-source"
                  value={f.source}
                  disabled={!isNew}
                  onChange={(e) => zmien({ source: e.target.value as CrmSource })}
              >
                {CRM_SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {CRM_SOURCE_LABELS[s]}
                    </option>
                ))}
              </select>
              {!isNew && <div className="hint">Źródła zapytania nie zmienia się po utworzeniu.</div>}
            </div>
            <div className="f-row">
              <label htmlFor="c-assignee">Przypisany pracownik</label>
              <select
                  id="c-assignee"
                  value={f.assigneeId}
                  onChange={(e) => zmien({ assigneeId: e.target.value })}
              >
                <option value="">— przydzieli kierownik —</option>
                {employees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                ))}
              </select>
            </div>
          </div>

          <div className="form-footer">
            <button
                className="primary"
                data-assistant-id="btn.crm-save"
                onClick={() => void zapisz()}
                disabled={busy}
            >
              {busy ? "Zapisywanie…" : isNew ? "Utwórz zapytanie" : "Zapisz zmiany"}
            </button>
            <button onClick={() => navigate(isNew ? "/crm/requests" : `/crm/requests/${id}`)}>
              Anuluj
            </button>
            <span className="spacer" />
            <span className="muted">
            {isNew
                ? "Nowe zapytanie trafia na etap „Nowe” z domyślnym scoringiem."
                : "Zmiana danych zostanie odnotowana w historii aktywności."}
          </span>
          </div>
        </div>
      </>
  );
}