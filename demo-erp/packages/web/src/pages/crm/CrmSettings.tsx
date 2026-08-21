/** Czytelne ustawienia automatyzacji modułu CRM. */

import { useEffect, useState } from "react";
import {
  ISSUE_RULES,
  ISSUE_RULE_LABELS,
  TEMPLATE_LABELS,
  TOKENY,
  TOKEN_CATEGORY_LABELS,
  wypelnijSzablon,
} from "@demo-erp/shared";
import type {
  CrmSettings,
  IssueRule,
  MessageTemplate,
  TemplateKey,
} from "@demo-erp/shared";
import { notify } from "../../ui.js";
import { ApiError } from "../../api.js";
import { crmApi } from "../../crm/client.js";
import { PodgladTresci } from "../../crm/MessageEditor.js";

const PRZYKLAD: Record<string, string> = {
  "klient.osoba": "Anna Wiśniewska",
  "klient.firma": "Hydromel Sp. z o.o.",
  "kosztorysant.imie": "Jakub Kowalski",
  "kosztorysant.email": "j.kowalski@norderp.pl",
  "kosztorysant.telefon": "+48 95 741 20 34",
  "pm.imie": "Magdalena Nowak",
  "sprawa.numer": "ZAP-2026-0001",
  "sprawa.budowa": "Hala P4 – Gliwice",
  "sprawa.termin": "2026-10-02",
  "sprawa.adres": "ul. Bojkowska 92, 44-100 Gliwice",
  "sprawa.wartosc": "125 999,99 PLN",
  "sprawa.dni": "3",
  produkty: "ramy montażowe",
  ilosc: "60 kpl.",
  "element.nazwa": "Gięcie blach 3 mm",
  "element.opis": "Gięcie wg rysunku, materiał S235JR.",
  "braki.lista": "– telefon kontaktowy\n– termin realizacji",
  "braki.zalaczniki": "– rysunek techniczny",
  "firma.nazwa": "NordERP Sp. z o.o.",
  "firma.telefon": "+48 95 741 20 30",
  "firma.email": "oferty@norderp.pl",
  "firma.adres": "ul. Zakaszewskiego 7, 66-300 Międzyrzecz",
};

const OPISY_PROBLEMOW: Record<IssueRule, string> = {
  deadline: "Ostrzega, gdy termin dostawy jest blisko lub został przekroczony.",
  address: "Pokazuje brak adresu potrzebnego do dostawy, transportu lub montażu.",
  attachments: "Sygnalizuje brak wymaganej specyfikacji, rysunku albo innego pliku.",
  data: "Kontroluje podstawowe dane zapytania, m.in. zakres, ilość i telefon.",
  assignee: "Przypomina, że sprawa nie ma jeszcze przypisanego kosztorysanta.",
  value: "Wskazuje ofertę bez uzupełnionej wartości na właściwym etapie.",
  followup: "Wyróżnia zaplanowany kontakt, którego termin już minął.",
};

const IKONY_PROBLEMOW: Record<IssueRule, string> = {
  deadline: "◷",
  address: "⌖",
  attachments: "⌑",
  data: "≡",
  assignee: "●",
  value: "PLN",
  followup: "↻",
};

function PanelHeader({
  eyebrow,
  title,
  description,
  badge,
}: {
  eyebrow: string;
  title: string;
  description: string;
  badge?: string;
}) {
  return (
    <header className="as-panel-head">
      <div>
        <span>{eyebrow}</span>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {badge && <strong className="as-panel-badge">{badge}</strong>}
    </header>
  );
}

function ToggleCard({
  checked,
  title,
  description,
  onChange,
  assistantId,
}: {
  checked: boolean;
  title: string;
  description: string;
  onChange: (checked: boolean) => void;
  assistantId?: string;
}) {
  return (
    <label className={`as-toggle-card${checked ? " active" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        data-assistant-id={assistantId}
      />
      <span className="as-toggle-copy">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <span className="as-switch" aria-hidden="true"><i /></span>
    </label>
  );
}

export function CrmSettingsPage() {
  const [settings, setSettings] = useState<CrmSettings | null>(null);
  const [blad, setBlad] = useState<string | null>(null);
  const [zapisywanie, setZapisywanie] = useState(false);
  const [otwarty, setOtwarty] = useState<TemplateKey | null>(null);

  useEffect(() => {
    crmApi.settings().then(setSettings).catch((error: unknown) =>
      setBlad(error instanceof ApiError ? error.body.message : "Nie udało się wczytać ustawień."),
    );
  }, []);

  async function zapisz(patch: Partial<CrmSettings>): Promise<void> {
    setZapisywanie(true);
    try {
      const nowe = await crmApi.saveSettings(patch);
      setSettings(nowe);
      notify("Ustawienia zapisane", "Zmiany obowiązują od następnej operacji.");
    } catch (error) {
      notify(
        "Nie udało się zapisać",
        error instanceof ApiError ? error.body.message : "Spróbuj ponownie.",
        "err",
      );
    } finally {
      setZapisywanie(false);
    }
  }

  if (blad) return <p className="crm-note danger">{blad}</p>;
  if (!settings) return <div className="as-loading">Wczytywanie ustawień…</div>;
  const loadedSettings = settings;

  const aktywneAutomaty = [
    settings.automation.acknowledgeNewRequests,
    settings.automation.autoSendFollowUp,
    settings.automation.autoCloseOnRefusal,
  ].filter(Boolean).length;
  const aktywneReguly = ISSUE_RULES.filter((rule) => settings.issues[rule] ?? true).length;
  const aktywneSzablony = settings.templates.filter((template) => template.enabled).length;

  function ustawAutomatyzacje(patch: Partial<CrmSettings["automation"]>): void {
    const automation = { ...loadedSettings.automation, ...patch };
    setSettings({ ...loadedSettings, automation });
    void zapisz({ automation });
  }

  function zmienSzablon(key: TemplateKey, patch: Partial<MessageTemplate>): void {
    setSettings({
      ...loadedSettings,
      templates: loadedSettings.templates.map((template) =>
        template.key === key ? { ...template, ...patch } : template,
      ),
    });
  }

  function wlaczSzablon(key: TemplateKey, enabled: boolean): void {
    const templates = loadedSettings.templates.map((template) =>
      template.key === key ? { ...template, enabled } : template,
    );
    setSettings({ ...loadedSettings, templates });
    void zapisz({ templates });
  }

  function kopiujToken(token: string): void {
    void navigator.clipboard?.writeText(`{{${token}}}`);
    notify("Znacznik skopiowany", `{{${token}}}`);
  }

  return (
    <section className="page crm-settings as-page">
      <header className="as-page-head">
        <div>
          <span className="as-eyebrow">CRM · konfiguracja procesu</span>
          <h1>Ustawienia automatyzacji</h1>
          <p>Określ, które czynności system wykonuje sam, a które pozostawia pracownikowi.</p>
        </div>
        <div className={`as-save-state${zapisywanie ? " saving" : ""}`} role="status" aria-live="polite">
          <span aria-hidden="true" />
          <div>
            <strong>{zapisywanie ? "Zapisywanie zmian" : "Zapis automatyczny"}</strong>
            <small>{zapisywanie ? "Proszę czekać…" : "Zmiany zapisują się od razu"}</small>
          </div>
        </div>
      </header>

      <div className="as-summary" aria-label="Podsumowanie ustawień">
        <div><strong>{settings.automation.mailClassificationMode === "automatic" ? "AI" : "Ręczna"}</strong><span>klasyfikacja</span></div>
        <div><strong>{aktywneAutomaty}/3</strong><span>aktywne automaty</span></div>
        <div><strong>{aktywneReguly}/{ISSUE_RULES.length}</strong><span>kontrole problemów</span></div>
        <div><strong>{aktywneSzablony}/{settings.templates.length}</strong><span>aktywne szablony</span></div>
      </div>

      <nav className="as-section-nav" aria-label="Sekcje ustawień">
        <a href="#classification">Klasyfikacja</a>
        <a href="#automation">Automaty</a>
        <a href="#mailbox">Skrzynka</a>
        <a href="#issues">Kontrola spraw</a>
        <a href="#templates">Szablony</a>
      </nav>

      <div className="as-content">
        <section className="as-panel" id="classification">
          <PanelHeader
            eyebrow="Krok 1"
            title="Klasyfikacja wiadomości"
            description="Wybierz, czy nowe wiadomości ma najpierw oceniać klasyfikator AI na DGX."
            badge={settings.automation.mailClassificationMode === "automatic" ? "AI aktywne" : "Tryb ręczny"}
          />
          <div className="as-mode-grid">
            <button
              type="button"
              className={`as-mode-card${settings.automation.mailClassificationMode === "automatic" ? " selected" : ""}`}
              aria-pressed={settings.automation.mailClassificationMode === "automatic"}
              disabled={zapisywanie}
              onClick={() => ustawAutomatyzacje({ mailClassificationMode: "automatic" })}
              data-assistant-id="crm-set-classification-automatic"
            >
              <span className="as-mode-icon">★</span>
              <strong>Automatyczna z AI</strong>
              <small>DGX klasyfikuje wiadomości. Wyniki wymagające decyzji nadal trafiają do człowieka.</small>
              <em>{settings.automation.mailClassificationMode === "automatic" ? "Wybrano" : "Wybierz tryb"}</em>
            </button>
            <button
              type="button"
              className={`as-mode-card manual${settings.automation.mailClassificationMode === "manual" ? " selected" : ""}`}
              aria-pressed={settings.automation.mailClassificationMode === "manual"}
              disabled={zapisywanie}
              onClick={() => ustawAutomatyzacje({ mailClassificationMode: "manual" })}
              data-assistant-id="crm-set-classification-manual"
            >
              <span className="as-mode-icon">✓</span>
              <strong>Weryfikacja ręczna</strong>
              <small>Każdą nową wiadomość sprawdza pracownik. Klasyfikator nie podejmuje decyzji.</small>
              <em>{settings.automation.mailClassificationMode === "manual" ? "Wybrano" : "Wybierz tryb"}</em>
            </button>
          </div>
          <div className="as-info-line">
            <span aria-hidden="true">i</span>
            <p>Niezależnie od trybu wiadomość nie jest automatycznie dodawana do CRM — utworzenie sprawy wymaga zatwierdzenia.</p>
          </div>
        </section>

        <section className="as-panel" id="automation">
          <PanelHeader
            eyebrow="Krok 2"
            title="Automatyczne działania"
            description="Włącz tylko czynności, które system może wykonywać bez dodatkowego potwierdzenia."
            badge={`${aktywneAutomaty} z 3 włączone`}
          />
          <div className="as-timing-grid">
            <label className="as-number-field">
              <span>Follow-up po</span>
              <div><input
                type="number"
                min={1}
                max={60}
                value={settings.automation.followUpAfterDays}
                onChange={(event) => setSettings({
                  ...settings,
                  automation: { ...settings.automation, followUpAfterDays: Number(event.target.value) },
                })}
                onBlur={() => void zapisz({ automation: settings.automation })}
              /><strong>dniach</strong></div>
              <small>Od przeniesienia oferty do kolumny „Wysłane”.</small>
            </label>
            <label className="as-number-field">
              <span>Deklarowana odpowiedź w</span>
              <div><input
                type="number"
                min={1}
                max={30}
                value={settings.automation.responseDays}
                onChange={(event) => setSettings({
                  ...settings,
                  automation: { ...settings.automation, responseDays: Number(event.target.value) },
                })}
                onBlur={() => void zapisz({ automation: settings.automation })}
              /><strong>dniach roboczych</strong></div>
              <small>Ta wartość może być używana w wiadomościach do klienta.</small>
            </label>
          </div>
          <div className="as-toggle-list">
            <ToggleCard
              checked={settings.automation.acknowledgeNewRequests}
              title="Potwierdzaj przyjęcie zapytania"
              description="Po zatwierdzeniu nowego zapytania system wysyła klientowi wiadomość z numerem sprawy."
              onChange={(checked) => ustawAutomatyzacje({ acknowledgeNewRequests: checked })}
              assistantId="crm-set-acknowledgeNewRequests"
            />
            <ToggleCard
              checked={settings.automation.autoSendFollowUp}
              title="Wysyłaj follow-up automatycznie"
              description={`Po ${settings.automation.followUpAfterDays} dniach wiadomość zostanie wysłana. Po wyłączeniu powstanie tylko szkic.`}
              onChange={(checked) => ustawAutomatyzacje({ autoSendFollowUp: checked })}
              assistantId="crm-set-autoSendFollowUp"
            />
            <ToggleCard
              checked={settings.automation.autoCloseOnRefusal}
              title="Zamykaj sprawę po wyraźnej odmowie"
              description="Jednoznaczna rezygnacja klienta przenosi sprawę do przegranych i zapisuje zdarzenie w historii."
              onChange={(checked) => ustawAutomatyzacje({ autoCloseOnRefusal: checked })}
              assistantId="crm-set-autoCloseOnRefusal"
            />
          </div>
        </section>

        <section className="as-panel" id="mailbox">
          <PanelHeader
            eyebrow="Korespondencja"
            title="Wspólna skrzynka działu"
            description="Adres i nazwa widoczne dla klientów w wiadomościach wysyłanych przez CRM."
            badge="Outlook"
          />
          <div className="as-mailbox-grid">
            <label>
              <span>Adres konta</span>
              <input
                type="email"
                value={settings.mailbox.account}
                onChange={(event) => setSettings({
                  ...settings,
                  mailbox: { ...settings.mailbox, account: event.target.value },
                })}
                onBlur={() => void zapisz({ mailbox: settings.mailbox })}
              />
              <small>Odpowiedzi klientów wrócą na ten adres.</small>
            </label>
            <label>
              <span>Nazwa nadawcy</span>
              <input
                value={settings.mailbox.displayName}
                onChange={(event) => setSettings({
                  ...settings,
                  mailbox: { ...settings.mailbox, displayName: event.target.value },
                })}
                onBlur={() => void zapisz({ mailbox: settings.mailbox })}
              />
              <small>Wyświetla się w polu „Od” u odbiorcy.</small>
            </label>
          </div>
        </section>

        <section className="as-panel" id="issues">
          <PanelHeader
            eyebrow="Kontrola jakości"
            title="Wykrywane problemy"
            description="Wyłącz regułę tylko wtedy, gdy dane ostrzeżenie nie pasuje do procesu firmy."
            badge={`${aktywneReguly} z ${ISSUE_RULES.length} aktywne`}
          />
          <div className="as-issue-grid">
            {ISSUE_RULES.map((rule) => {
              const checked = settings.issues[rule] ?? true;
              return (
                <label key={rule} className={`as-issue-card${checked ? " active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      const issues = { ...settings.issues, [rule]: event.target.checked };
                      setSettings({ ...settings, issues });
                      void zapisz({ issues });
                    }}
                    data-assistant-id={`crm-set-issue-${rule}`}
                  />
                  <span className="as-issue-icon" aria-hidden="true">{IKONY_PROBLEMOW[rule]}</span>
                  <span className="as-issue-copy">
                    <strong>{ISSUE_RULE_LABELS[rule]}</strong>
                    <small>{OPISY_PROBLEMOW[rule]}</small>
                  </span>
                  <span className="as-switch" aria-hidden="true"><i /></span>
                </label>
              );
            })}
          </div>
        </section>

        <section className="as-panel" id="templates">
          <PanelHeader
            eyebrow="Treści wiadomości"
            title="Szablony"
            description="Edytuj wiadomości używane przez automaty i szybkie akcje."
            badge={`${aktywneSzablony} aktywne`}
          />

          <details className="as-token-help">
            <summary>Znaczniki danych — kliknij, aby skopiować</summary>
            <p>System zastąpi znaczniki rzeczywistymi danymi klienta, sprawy lub pracownika.</p>
            <div className="tpl-tokens">
              {TOKENY.map((token) => (
                <button
                  key={token.token}
                  type="button"
                  className={`me-tok tok-${token.category}`}
                  title={token.label}
                  onClick={() => kopiujToken(token.token)}
                >
                  {`{{${token.token}}}`}
                </button>
              ))}
            </div>
            <small>Kategorie: {Object.values(TOKEN_CATEGORY_LABELS).join(" · ")}</small>
          </details>

          <div className="as-template-list">
            {settings.templates.map((template) => {
              const bodyPreview = wypelnijSzablon(template.body, PRZYKLAD);
              const subjectPreview = wypelnijSzablon(template.subject, PRZYKLAD);
              const expanded = otwarty === template.key;
              return (
                <article className={`as-template${template.enabled ? "" : " disabled"}`} key={template.key}>
                  <header>
                    <button
                      type="button"
                      className="as-template-toggle"
                      onClick={() => setOtwarty(expanded ? null : template.key)}
                      aria-expanded={expanded}
                    >
                      <span className={`as-chevron${expanded ? " open" : ""}`} aria-hidden="true">›</span>
                      <span>
                        <strong>{TEMPLATE_LABELS[template.key]}</strong>
                        <small>{template.subject || "Brak tematu wiadomości"}</small>
                      </span>
                    </button>
                    <label className="as-template-status">
                      <input
                        type="checkbox"
                        checked={template.enabled}
                        onChange={(event) => wlaczSzablon(template.key, event.target.checked)}
                      />
                      <span className="as-switch" aria-hidden="true"><i /></span>
                      <strong>{template.enabled ? "Aktywny" : "Wyłączony"}</strong>
                    </label>
                  </header>

                  {expanded && (
                    <div className="as-template-body">
                      <div className="as-template-editor">
                        <label>
                          <span>Temat wiadomości</span>
                          <input
                            value={template.subject}
                            onChange={(event) => zmienSzablon(template.key, { subject: event.target.value })}
                            onBlur={() => void zapisz({ templates: settings.templates })}
                          />
                        </label>
                        <label>
                          <span>Treść wiadomości</span>
                          <textarea
                            rows={13}
                            value={template.body}
                            onChange={(event) => zmienSzablon(template.key, { body: event.target.value })}
                            onBlur={() => void zapisz({ templates: settings.templates })}
                          />
                        </label>
                      </div>
                      <div className="as-template-preview">
                        <span>Podgląd z przykładowymi danymi</span>
                        <div className="as-preview-subject">
                          <small>Temat</small>
                          <PodgladTresci text={subjectPreview.text} podstawienia={subjectPreview.podstawienia} />
                        </div>
                        <div className="as-preview-message">
                          <small>Treść</small>
                          <PodgladTresci text={bodyPreview.text} podstawienia={bodyPreview.podstawienia} />
                        </div>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      </div>
    </section>
  );
}
