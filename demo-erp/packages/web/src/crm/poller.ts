/**
 * crm/poller.ts — automatyczne odpytywanie skrzynki.
 *
 * Serwis żyje poza Reactem: jeden interwał na całą aplikację, niezależnie
 * od tego, ile widoków akurat wisi na nasłuchu. Komponenty dostają wyłącznie
 * migawkę stanu przez useMailbox(). Dzięki temu przejście z listy zapytań
 * do skrzynki nie gubi cyklu pobierania i nie odpala drugiego.
 *
 * Interwał startuje przy pierwszym subskrybencie i gaśnie przy ostatnim —
 * poza modułem CRM nic w tle nie chodzi.
 */

import { useEffect, useState } from "react";
import type { DgxStatus, InboxMessage, MailboxState } from "@demo-erp/shared";
import { crmApi } from "./client.js";
import { notify } from "../ui.js";

export interface MailboxSnapshotState {
  messages: InboxMessage[];
  state: MailboxState | null;
  adapter: string;
  ai: DgxStatus | null;
  /** true w trakcie pobierania — pod stan ładowania w interfejsie. */
  loading: boolean;
  /** Komunikat ostatniego nieudanego pobrania; null gdy ostatnie się udało. */
  error: string | null;
  /** false do czasu pierwszej odpowiedzi serwera — pod szkielet ekranu. */
  ready: boolean;
}

const POLL_MS = 30_000;

let snapshot: MailboxSnapshotState = {
  messages: [],
  state: null,
  adapter: "-",
  ai: null,
  loading: false,
  error: null,
  ready: false,
};

const subskrybenci = new Set<(s: MailboxSnapshotState) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function ustaw(patch: Partial<MailboxSnapshotState>): void {
  snapshot = { ...snapshot, ...patch };
  for (const s of subskrybenci) s(snapshot);
}

/** Ręczne i automatyczne pobranie wchodzą tą samą drogą. */
export async function sprawdzSkrzynke(recznie = false): Promise<void> {
  if (snapshot.loading) return;
  ustaw({ loading: true });
  try {
    const snap = await crmApi.poll();
    ustaw({
      messages: snap.messages,
      state: snap.state,
      adapter: snap.adapter,
      ai: snap.ai,
      loading: false,
      error: null,
      ready: true,
    });
    if (snap.result.fetched > 0) {
      const czesci = [`nowe wiadomości: ${snap.result.fetched}`];
      if (snap.result.created > 0) czesci.push(`utworzone zapytania: ${snap.result.created}`);
      if (snap.result.needsReview > 0) czesci.push(`do weryfikacji: ${snap.result.needsReview}`);
      notify("Pobrano pocztę", czesci.join(" · "));
    } else if (recznie) {
      notify("Skrzynka sprawdzona", "Brak nowych wiadomości.");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Nie udało się pobrać wiadomości.";
    ustaw({ loading: false, error: msg, ready: true });
    if (recznie) notify("Błąd pobierania poczty", msg, "err");
  }
}

/** Pierwsze wejście do modułu: wczytaj to, co już jest, i odpal cykl. */
async function wczytajStan(): Promise<void> {
  try {
    const snap = await crmApi.mailbox();
    ustaw({ messages: snap.messages, state: snap.state, adapter: snap.adapter, ai: snap.ai, ready: true });
  } catch {
    ustaw({ ready: true });
  }
  void sprawdzSkrzynke();
}

function start(): void {
  if (timer != null) return;
  void wczytajStan();
  timer = setInterval(() => void sprawdzSkrzynke(), POLL_MS);
}

function stop(): void {
  if (timer == null) return;
  clearInterval(timer);
  timer = null;
}

/** Podpięcie komponentu pod stan skrzynki. */
export function useMailbox(): MailboxSnapshotState {
  const [s, setS] = useState<MailboxSnapshotState>(snapshot);
  useEffect(() => {
    subskrybenci.add(setS);
    start();
    setS(snapshot);
    return () => {
      subskrybenci.delete(setS);
      if (subskrybenci.size === 0) stop();
    };
  }, []);
  return s;
}

/** Podmiana pojedynczej wiadomości po akcji operatora, bez pełnego przeładowania. */
export function podmienWiadomosc(msg: InboxMessage): void {
  ustaw({ messages: snapshot.messages.map((m) => (m.id === msg.id ? msg : m)) });
}

export const POLL_INTERVAL_MS = POLL_MS;
