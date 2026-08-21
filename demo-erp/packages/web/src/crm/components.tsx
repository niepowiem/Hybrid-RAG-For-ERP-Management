/**
 * crm/components.tsx — drobne elementy wspólne modułu CRM.
 *
 * Zasada kolorów z styles.css obowiązuje bez wyjątku: limonka wyłącznie
 * w chromie interfejsu, w danych tylko kolory semantyczne. Etapy lejka mają
 * własną, bladą skalę szarości z jednym akcentem na etapach końcowych —
 * inaczej tablica zamieniłaby się w tęczę i przestał cokolwiek komunikować.
 */

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import {
  ATTACHMENT_KIND_LABELS,
  COMPLETENESS_LABELS,
  CRM_DATA_FIELD_LABELS,
  CRM_STAGE_SHORT,
  FOLLOWUP_STATUS_LABELS,
  MAIL_STATUS_LABELS,
  ocenKompletnosc,
  scoreBand,
} from "@demo-erp/shared";
import type {
  CompletenessResult,
  CrmEmployee,
  CrmRequest,
  CrmStage,
  FollowUpStatus,
  MailStatus,
} from "@demo-erp/shared";

// ------------------------------- etapy ------------------------------------

export function StageBadge({ stage }: { stage: CrmStage }) {
  return <span className={`crm-stage s-${stage}`}>{CRM_STAGE_SHORT[stage]}</span>;
}

// ------------------------------- scoring ----------------------------------

export function ScoreBar({ value, width = 96 }: { value: number; width?: number }) {
  const band = scoreBand(value);
  return (
      <span className="crm-score" style={{ width }} title={`Scoring ${value}% (${band.label})`}>
      <span className={`crm-score-fill lvl-${band.level}`} style={{ width: `${value}%` }} />
      <span className="crm-score-val mono">{value}%</span>
    </span>
  );
}

// ---------------------------- kompletność ---------------------------------

const KOMPLETNOSC_KLASA: Record<CompletenessResult["status"], string> = {
  complete: "ok",
  partial: "warn",
  missing_data: "danger",
  missing_attachments: "warn",
};

export function CompletenessBadge({ req }: { req: CrmRequest }) {
  const k = ocenKompletnosc(req);
  const braki = [
    ...k.missingFields.map((f) => CRM_DATA_FIELD_LABELS[f]),
    ...k.missingAttachments.map((a) => `${ATTACHMENT_KIND_LABELS[a]} (załącznik)`),
  ];
  return (
      <span
          className={`crm-flag ${KOMPLETNOSC_KLASA[k.status]}`}
          title={braki.length > 0 ? `Brakuje: ${braki.join(", ")}` : "Komplet danych i załączników"}
      >
      {COMPLETENESS_LABELS[k.status]}
        {braki.length > 0 && <b className="mono">{braki.length}</b>}
    </span>
  );
}

/** Rozpisane braki — w szczegółach zapytania i w podglądzie wiadomości. */
export function MissingList({ req }: { req: CrmRequest }) {
  const k = ocenKompletnosc(req);
  if (k.missingFields.length === 0 && k.missingAttachments.length === 0) {
    return <p className="crm-note ok">Komplet danych — zapytanie gotowe do wyceny.</p>;
  }
  return (
      <ul className="crm-missing">
        {k.missingFields.map((f) => (
            <li key={f}>{CRM_DATA_FIELD_LABELS[f]}</li>
        ))}
        {k.missingAttachments.map((a) => (
            <li key={a} className="att">
              {ATTACHMENT_KIND_LABELS[a]} <span className="muted">(załącznik)</span>
            </li>
        ))}
      </ul>
  );
}

// ------------------------------ pracownik ---------------------------------

export function Assignee({ employee }: { employee: CrmEmployee | undefined }) {
  if (!employee) {
    return <span className="crm-assignee none">Nieprzypisane</span>;
  }
  return (
      <span className="crm-assignee" title={employee.email}>
      <span className="ini mono">{employee.initials}</span>
        {employee.name}
    </span>
  );
}

// ------------------------------- statusy ----------------------------------

const FU_KLASA: Record<FollowUpStatus, string> = {
  planned: "info",
  done: "ok",
  skipped: "muted",
  overdue: "danger",
};

export function FollowUpBadge({ status }: { status: FollowUpStatus }) {
  return <span className={`crm-flag ${FU_KLASA[status]}`}>{FOLLOWUP_STATUS_LABELS[status]}</span>;
}

const MAIL_KLASA: Record<MailStatus, string> = {
  new: "info",
  processing: "info",
  processed: "ok",
  needs_review: "warn",
  skipped: "muted",
  error: "danger",
};

export function MailStatusBadge({ status }: { status: MailStatus }) {
  return (
      <span className={`crm-flag ${MAIL_KLASA[status]}`}>
      {status === "processing" && <span className="spin" aria-hidden="true" />}
        {MAIL_STATUS_LABELS[status]}
    </span>
  );
}

// -------------------------------- modal -----------------------------------

/**
 * Okno modalne. Escape zamyka, focus wchodzi do środka przy otwarciu,
 * a tło łapie kliknięcie — trzy rzeczy, których brak najczęściej wychodzi
 * przy nawigacji klawiaturą.
 */
export function Modal({
                        title,
                        onClose,
                        children,
                        footer,
                        wide,
                        className = "",
                      }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  // Funkcja zamknięcia jest często tworzona inline przez rodzica. Nie może być
  // zależnością efektu ustawiającego fokus, bo każda wpisana litera powodowałaby
  // ponowne skupienie pierwszego przycisku w oknie (zwykle krzyżyka).
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    box.current?.querySelector<HTMLElement>(
        ".crm-modal-body input, .crm-modal-body select, .crm-modal-body textarea, .crm-modal-body button",
    )?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
      <div className="crm-modal-bg" onMouseDown={onClose}>
        <div
            className={`crm-modal${wide ? " wide" : ""}${className ? ` ${className}` : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            ref={box}
            onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="crm-modal-head">
            <b>{title}</b>
            <button className="icon-btn" onClick={onClose} aria-label="Zamknij okno">
              ✕
            </button>
          </div>
          <div className="crm-modal-body">{children}</div>
          {footer && <div className="crm-modal-foot">{footer}</div>}
        </div>
      </div>
  );
}

// ------------------------- stany puste i ładowania -------------------------

export function EmptyState({ text, hint }: { text: string; hint?: string }) {
  return (
      <div className="empty">
        <div>{text}</div>
        {hint && <div className="muted" style={{ marginTop: 4 }}>{hint}</div>}
      </div>
  );
}

export function LoadingRows({ cols, rows = 5 }: { cols: number; rows?: number }) {
  return (
      <>
        {Array.from({ length: rows }, (_, i) => (
            <tr key={i} className="crm-skeleton">
              {Array.from({ length: cols }, (_, j) => (
                  <td key={j}>
                    <span className="sk" />
                  </td>
              ))}
            </tr>
        ))}
      </>
  );
}
