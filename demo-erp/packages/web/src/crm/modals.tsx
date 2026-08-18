/**
 * crm/modals.tsx — okna używane w więcej niż jednym widoku.
 *
 * LostReasonModal jest wspólny dla listy, tablicy i szczegółów, bo reguła
 * jest jedna: etap „Przegrane” nie zapisze się bez przyczyny. Gdyby każdy
 * widok miał własną wersję tego okna, po pierwszej zmianie słownika
 * rozjechałyby się między sobą.
 */

import { useState } from "react";
import {
  CRM_STAGES,
  CRM_STAGE_LABELS,
  LOST_REASONS,
  LOST_REASON_LABELS,
} from "@demo-erp/shared";
import type { CrmRequest, CrmStage, LostReason } from "@demo-erp/shared";
import { crmApi } from "./client.js";
import { useEmployees } from "./hooks.js";
import { Modal } from "./components.js";
import { notify } from "../ui.js";
import { ApiError } from "../api.js";

// --------------------------- przyczyna przegranej --------------------------

export function LostReasonModal({
                                  req,
                                  onClose,
                                  onSaved,
                                  zapiszJako,
                                }: {
  req: CrmRequest;
  onClose: () => void;
  onSaved: (r: CrmRequest) => void;
  /**
   * Alternatywny zapis — tablica przenosi kartę do kolumny „Przegrane”
   * jednym wywołaniem (przeniesienie + przyczyna), zamiast zmieniać etap
   * osobno i ryzykować, że drugie żądanie się nie powiedzie.
   */
  zapiszJako?: (reason: LostReason, note: string | null) => Promise<CrmRequest>;
}) {
  const [reason, setReason] = useState<LostReason>(req.lostReason ?? "price");
  const [note, setNote] = useState(req.lostReasonNote ?? "");
  const [blad, setBlad] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function zapisz(): Promise<void> {
    if (reason === "other" && note.trim() === "") {
      setBlad("Opisz inną przyczynę przegranej.");
      return;
    }
    setBusy(true);
    try {
      const uwaga = reason === "other" ? note.trim() : null;
      const r = zapiszJako
          ? await zapiszJako(reason, uwaga)
          : await crmApi.setStage(req.id, "lost", reason, uwaga);
      notify("Zapytanie przeniesione do przegranych", `${req.number} · ${LOST_REASON_LABELS[reason]}`);
      onSaved(r);
      onClose();
    } catch (e) {
      setBlad(e instanceof ApiError ? e.body.message : "Nie udało się zapisać przyczyny.");
    } finally {
      setBusy(false);
    }
  }

  return (
      <Modal
          title={`Przyczyna przegranej — ${req.number}`}
          onClose={onClose}
          footer={
            <>
              <span className="spacer" />
              <button onClick={onClose}>Anuluj</button>
              <button className="primary" onClick={() => void zapisz()} disabled={busy}>
                {busy ? "Zapisywanie…" : "Zapisz przyczynę"}
              </button>
            </>
          }
      >
        <p className="crm-note">
          Etap „Przegrane” wymaga wskazania przyczyny — bez niej statystyki utraconych szans
          nic nie powiedzą.
        </p>
        <div className="crm-radios">
          {LOST_REASONS.map((r) => (
              <label key={r} className={reason === r ? "sel" : ""}>
                <input
                    type="radio"
                    name="lost-reason"
                    value={r}
                    checked={reason === r}
                    onChange={() => {
                      setReason(r);
                      setBlad(null);
                    }}
                />
                {LOST_REASON_LABELS[r]}
              </label>
          ))}
        </div>
        {reason === "other" && (
            <div className="f-row" style={{ marginTop: 10 }}>
              <label htmlFor="lost-note">Opis przyczyny<span className="req">*</span></label>
              <textarea
                  id="lost-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Np. klient wstrzymał inwestycję do przyszłego kwartału."
              />
            </div>
        )}
        {blad && <p className="crm-note danger">{blad}</p>}
      </Modal>
  );
}

// ------------------------------ szybka edycja ------------------------------

/** Etap, opiekun i scoring w jednym oknie — najczęstsze trzy zmiany na liście. */
export function QuickEditModal({
                                 req,
                                 onClose,
                                 onSaved,
                               }: {
  req: CrmRequest;
  onClose: () => void;
  onSaved: (r: CrmRequest) => void;
}) {
  const employees = useEmployees();
  const [stage, setStage] = useState<CrmStage>(req.stage);
  const [assigneeId, setAssigneeId] = useState(req.assigneeId ?? "");
  const [score, setScore] = useState(req.score);
  const [busy, setBusy] = useState(false);
  const [blad, setBlad] = useState<string | null>(null);
  const [lostOpen, setLostOpen] = useState(false);

  async function zapisz(): Promise<void> {
    if (stage === "lost" && req.stage !== "lost") {
      setLostOpen(true);
      return;
    }
    setBusy(true);
    setBlad(null);
    try {
      let aktualne = req;
      if (assigneeId !== (req.assigneeId ?? "") && assigneeId !== "") {
        aktualne = await crmApi.assign(req.id, assigneeId);
      }
      if (stage !== req.stage) {
        aktualne = await crmApi.setStage(req.id, stage);
      }
      if (score !== req.score) {
        aktualne = await crmApi.setScore(req.id, score);
      }
      notify("Zapisano zmiany", req.number);
      onSaved(aktualne);
      onClose();
    } catch (e) {
      setBlad(e instanceof ApiError ? e.body.message : "Nie udało się zapisać zmian.");
    } finally {
      setBusy(false);
    }
  }

  if (lostOpen) {
    return (
        <LostReasonModal
            req={req}
            onClose={() => setLostOpen(false)}
            onSaved={(r) => {
              onSaved(r);
              onClose();
            }}
        />
    );
  }

  return (
      <Modal
          title={`Szybka edycja — ${req.number}`}
          onClose={onClose}
          footer={
            <>
              <span className="spacer" />
              <button onClick={onClose}>Anuluj</button>
              <button className="primary" onClick={() => void zapisz()} disabled={busy}>
                {busy ? "Zapisywanie…" : "Zapisz"}
              </button>
            </>
          }
      >
        <div className="grid two">
          <div className="f-row">
            <label htmlFor="qe-stage">Etap sprzedażowy</label>
            <select id="qe-stage" value={stage} onChange={(e) => setStage(e.target.value as CrmStage)}>
              {CRM_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {CRM_STAGE_LABELS[s]}
                  </option>
              ))}
            </select>
          </div>
          <div className="f-row">
            <label htmlFor="qe-assignee">Przypisany pracownik</label>
            <select id="qe-assignee" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">— nieprzypisane —</option>
              {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
              ))}
            </select>
            <div className="hint">Przydzielanie jest zastrzeżone dla roli „Kierownik”.</div>
          </div>
        </div>

        <div className="f-row" style={{ marginTop: 12 }}>
          <label htmlFor="qe-score">
            Scoring: <b className="mono">{score}%</b>
          </label>
          <input
              id="qe-score"
              type="range"
              min={0}
              max={100}
              step={5}
              value={score}
              onChange={(e) => setScore(Number(e.target.value))}
          />
        </div>

        {blad && <p className="crm-note danger">{blad}</p>}
      </Modal>
  );
}