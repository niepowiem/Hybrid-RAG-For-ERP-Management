/**
 * crm/client.ts — klient HTTP modułu CRM.
 *
 * Korzysta z tego samego `request` co reszta aplikacji, więc rola, nagłówki
 * i obsługa błędów kontraktowych działają identycznie. Komponenty nie znają
 * ścieżek endpointów — tylko ten plik.
 */

import { request } from "../api.js";
import type {
    CreateColumnInput,
    CreateContactInput,
    CreateCrmRequestInput,
    CreateFollowUpInput,
    CrmClient,
    CrmColumn,
    CrmEmployee,
    CrmVendor,
    ComposeMessageInput,
    CreateOutsourcingInput,
    CrmSettings,
    TemplateKey,
    UpdateSettingsInput,
    PatchRequestInput,
    RecordQuoteInput,
    CrmRequest,
    InboxMessage,
    MailboxState,
    MailCategory,
    UpdateCrmRequestInput,
    CrmStage,
    LostReason,
} from "@demo-erp/shared";

export interface MailboxSnapshot {
    state: MailboxState;
    adapter: string;
    messages: InboxMessage[];
}

export interface PollSnapshot extends MailboxSnapshot {
    result: {
        fetched: number;
        created: number;
        needsReview: number;
        skipped: number;
        added: InboxMessage[];
    };
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, {
        method: "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

export interface BoardSnapshot {
    columns: CrmColumn[];
    requests: CrmRequest[];
    clients: CrmClient[];
    employees: CrmEmployee[];
    /** Reguły problemów wyłączone w ustawieniach modułu. */
    disabledIssues: string[];
    settings: CrmSettings;
}

export const crmApi = {
    employees: () => request<CrmEmployee[]>("/api/crm/employees"),
    clients: () => request<CrmClient[]>("/api/crm/clients"),
    vendors: () => request<CrmVendor[]>("/api/crm/vendors"),
    settings: () => request<CrmSettings>("/api/crm/settings"),
    saveSettings: (input: UpdateSettingsInput) =>
        request<CrmSettings>("/api/crm/settings", { method: "PUT", body: JSON.stringify(input) }),

    updateContact: (clientId: string, contactId: string, input: CreateContactInput) =>
        request<CrmClient>(`/api/crm/clients/${clientId}/contacts/${contactId}`, {
            method: "PUT",
            body: JSON.stringify(input),
        }),
    removeContact: (clientId: string, contactId: string) =>
        request<CrmClient>(`/api/crm/clients/${clientId}/contacts/${contactId}`, { method: "DELETE" }),

    draftFromTemplate: (id: string, key: TemplateKey) =>
        post<{ request: CrmRequest; messageId: string }>(`/api/crm/requests/${id}/messages/draft`, { key }),
    compose: (id: string, input: ComposeMessageInput) =>
        post<CrmRequest>(`/api/crm/requests/${id}/messages/compose`, input),

    addOutsourcing: (id: string, input: CreateOutsourcingInput) =>
        post<CrmRequest>(`/api/crm/requests/${id}/outsourcing`, input),
    selectVendor: (id: string, oid: string, vendorId: string | null) =>
        post<CrmRequest>(`/api/crm/requests/${id}/outsourcing/${oid}/select`, { vendorId }),
    removeOutsourcing: (id: string, oid: string) =>
        request<CrmRequest>(`/api/crm/requests/${id}/outsourcing/${oid}`, { method: "DELETE" }),
    recordQuote: (id: string, oid: string, iid: string, input: RecordQuoteInput) =>
        post<CrmRequest>(`/api/crm/requests/${id}/outsourcing/${oid}/quotes/${iid}`, input),

    draftAssignment: (id: string) => post<CrmRequest>(`/api/crm/requests/${id}/messages/assignment`),
    discardMessage: (id: string, mid: string) =>
        request<CrmRequest>(`/api/crm/requests/${id}/messages/${mid}`, { method: "DELETE" }),
    attachmentUrl: (id: string, aid: string) => `/api/crm/requests/${id}/attachments/${aid}`,
    addContact: (clientId: string, input: CreateContactInput) =>
        post<CrmClient>(`/api/crm/clients/${clientId}/contacts`, input),
    removeAssignee: (id: string, employeeId: string) =>
        request<CrmRequest>(`/api/crm/requests/${id}/assignees/${employeeId}`, { method: "DELETE" }),

    board: () => request<BoardSnapshot>("/api/crm/board"),
    addColumn: (input: CreateColumnInput) => post<CrmColumn>("/api/crm/board/columns", input),
    removeColumn: (cid: string) =>
        request<{ removed: string; columns: CrmColumn[] }>(`/api/crm/board/columns/${cid}`, {
            method: "DELETE",
        }),
    move: (id: string, columnId: string, lostReason?: LostReason | null, lostReasonNote?: string | null) =>
        post<CrmRequest>(`/api/crm/requests/${id}/column`, {
            columnId,
            lostReason: lostReason ?? null,
            lostReasonNote: lostReasonNote ?? null,
        }),
    markSeen: (id: string) => post<CrmRequest>(`/api/crm/requests/${id}/seen`),
    patch: (id: string, input: PatchRequestInput) =>
        request<CrmRequest>(`/api/crm/requests/${id}`, {
            method: "PATCH",
            body: JSON.stringify(input),
        }),
    setStageNote: (id: string, stage: CrmStage, text: string) =>
        post<CrmRequest>(`/api/crm/requests/${id}/stage-note`, { stage, text }),

    requests: () => request<CrmRequest[]>("/api/crm/requests"),
    request: (id: string) => request<CrmRequest>(`/api/crm/requests/${id}`),

    create: (input: CreateCrmRequestInput) => post<CrmRequest>("/api/crm/requests", input),
    update: (id: string, input: UpdateCrmRequestInput) =>
        request<CrmRequest>(`/api/crm/requests/${id}`, {
            method: "PUT",
            body: JSON.stringify(input),
        }),

    setStage: (id: string, stage: CrmStage, lostReason?: LostReason | null, lostReasonNote?: string | null) =>
        post<CrmRequest>(`/api/crm/requests/${id}/stage`, {
            stage,
            lostReason: lostReason ?? null,
            lostReasonNote: lostReasonNote ?? null,
        }),

    assign: (id: string, employeeId: string) =>
        post<CrmRequest>(`/api/crm/requests/${id}/assign`, { employeeId }),

    setScore: (id: string, score: number) =>
        post<CrmRequest>(`/api/crm/requests/${id}/score`, { score }),

    addFollowUp: (id: string, input: CreateFollowUpInput) =>
        post<CrmRequest>(`/api/crm/requests/${id}/followups`, input),
    doneFollowUp: (id: string, fid: string) =>
        post<CrmRequest>(`/api/crm/requests/${id}/followups/${fid}/done`),
    skipFollowUp: (id: string, fid: string) =>
        post<CrmRequest>(`/api/crm/requests/${id}/followups/${fid}/skip`),

    generateMissingDataMessage: (id: string) =>
        post<CrmRequest>(`/api/crm/requests/${id}/messages/missing-data`),
    sendMessage: (id: string, mid: string, patch: { subject: string; body: string }) =>
        post<CrmRequest>(`/api/crm/requests/${id}/messages/${mid}/send`, patch),

    mailbox: () => request<MailboxSnapshot>("/api/crm/mailbox"),
    poll: () => post<PollSnapshot>("/api/crm/mailbox/poll"),
    setCategory: (mid: string, category: MailCategory) =>
        post<InboxMessage>(`/api/crm/mailbox/messages/${mid}/category`, { category }),
    acceptMessage: (mid: string) =>
        post<{ message: InboxMessage; request: CrmRequest }>(
            `/api/crm/mailbox/messages/${mid}/accept`,
        ),
    rejectMessage: (mid: string) => post<InboxMessage>(`/api/crm/mailbox/messages/${mid}/reject`),
    reviewMessage: (mid: string) => post<InboxMessage>(`/api/crm/mailbox/messages/${mid}/review`),
};