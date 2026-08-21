/**
 * Pełna karta zapytania korzysta z tego samego obszaru roboczego co panel
 * boczny tablicy. Dzięki temu obie wersje mają te same zakładki, akcje i
 * zachowania, a zmiana w jednym widoku nie tworzy drugiego standardu UI.
 */

import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type {
  ApiErrorBody,
  CrmClient,
  CrmEmployee,
  CrmIssue,
  CrmMessage,
  CrmRequest,
  CrmSettings,
  CrmVendor,
  TemplateKey,
} from "@demo-erp/shared";
import { ApiError } from "../../api.js";
import { ErrorBanner } from "../../App.js";
import { notify } from "../../ui.js";
import { crmApi } from "../../crm/client.js";
import { RequestDrawer } from "../../crm/RequestDrawer.js";
import { SendMessageModal } from "../../crm/SendMessageModal.js";
import { LostReasonModal } from "../../crm/modals.js";

interface QuickMessage {
  req: CrmRequest;
  messageId: string;
  title: string;
  intro: string;
  severity: CrmIssue["severity"];
  poprzednia: CrmMessage | null;
}

export function CrmRequestDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [req, setReq] = useState<CrmRequest | null>(null);
  const [clients, setClients] = useState<CrmClient[]>([]);
  const [employees, setEmployees] = useState<CrmEmployee[]>([]);
  const [vendors, setVendors] = useState<CrmVendor[]>([]);
  const [settings, setSettings] = useState<CrmSettings | null>(null);
  const [disabledIssues, setDisabledIssues] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState<ApiErrorBody | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [lost, setLost] = useState<CrmRequest | null>(null);
  const [quickMessage, setQuickMessage] = useState<QuickMessage | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!id) return;
    setLoading(true);
    setApiError(null);
    setNotFound(false);
    try {
      const [board, vendorList] = await Promise.all([crmApi.board(), crmApi.vendors()]);
      const request = board.requests.find((item) => item.id === id) ?? null;
      setReq(request);
      setClients(board.clients);
      setEmployees(board.employees);
      setVendors(vendorList);
      setSettings(board.settings);
      setDisabledIssues(board.disabledIssues ?? []);
      setNotFound(request == null);
    } catch (error) {
      if (error instanceof ApiError) setApiError(error.body);
      else notify("Nie udało się wczytać zapytania", "Spróbuj ponownie.", "err");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const issueAction = useCallback(async (request: CrmRequest, issue: CrmIssue): Promise<void> => {
    const templateByAction: Partial<Record<NonNullable<CrmIssue["action"]>, TemplateKey>> = {
      email_address: "address",
      email_attachments: "attachments",
      email_data: "missing_data",
    };
    const key = issue.action ? templateByAction[issue.action] : undefined;
    if (!key) {
      notify("Szczegóły problemu", "Pole do uzupełnienia znajduje się w zakładce Szczegóły.");
      return;
    }

    try {
      const { request: withDraft, messageId } = await crmApi.draftFromTemplate(request.id, key);
      setReq(withDraft);
      setQuickMessage({
        req: withDraft,
        messageId,
        title: issue.actionLabel ?? "Wyślij wiadomość",
        intro: `${withDraft.number} · ${withDraft.companyName} — ${issue.message}`,
        severity: issue.severity,
        poprzednia:
          withDraft.messages.find(
            (message) => message.templateKey === key && message.sentAt && message.id !== messageId,
          ) ?? null,
      });
    } catch (error) {
      notify(
        "Nie udało się przygotować wiadomości",
        error instanceof ApiError ? error.body.message : "Spróbuj ponownie.",
        "err",
      );
    }
  }, []);

  if (loading && !req) {
    return (
      <section className="crm-request-full">
        <div className="card">
          <p className="page-sub">Wczytywanie pełnej karty zapytania…</p>
          <div className="crm-skeleton-block" />
        </div>
      </section>
    );
  }

  if (apiError && !req) {
    return (
      <section className="crm-request-full">
        <ErrorBanner error={apiError} />
        <button type="button" onClick={() => navigate("/crm/board")}>Wróć do tablicy</button>
      </section>
    );
  }

  if (notFound || !req) {
    return (
      <section className="crm-request-full">
        <div className="card">
          <h1>Nie znaleziono zapytania</h1>
          <p className="page-sub">Zapytanie mogło zostać usunięte albo przeniesione.</p>
          <button type="button" onClick={() => navigate("/crm/board")}>Wróć do tablicy</button>
        </div>
      </section>
    );
  }

  return (
    <section className="crm-request-full">
      <RequestDrawer
        fullPage
        req={req}
        clients={clients}
        employees={employees}
        vendors={vendors}
        wylaczoneReguly={disabledIssues}
        konto={settings?.mailbox.account ?? "skrzynka działu"}
        onChange={setReq}
        onClose={() => navigate("/crm/board")}
        onLost={setLost}
        onIssueAction={(request, issue) => void issueAction(request, issue)}
        onClientChange={(client) =>
          setClients((current) => current.map((item) => (item.id === client.id ? client : item)))
        }
      />

      {lost && (
        <LostReasonModal
          req={lost}
          onClose={() => setLost(null)}
          onSaved={(updated) => {
            setReq(updated);
            setLost(null);
          }}
        />
      )}

      {quickMessage && (
        <SendMessageModal
          req={quickMessage.req}
          messageId={quickMessage.messageId}
          title={quickMessage.title}
          intro={quickMessage.intro}
          introTone={quickMessage.severity}
          poprzednia={quickMessage.poprzednia}
          pracownicy={employees}
          firma={settings?.company ?? null}
          onClose={(updated) => {
            if (updated) setReq(updated);
            setQuickMessage(null);
          }}
          onSent={(updated) => {
            setReq(updated);
            setQuickMessage(null);
          }}
        />
      )}
    </section>
  );
}
