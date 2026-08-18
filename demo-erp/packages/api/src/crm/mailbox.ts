/**
 * mailbox.ts — adapter skrzynki pocztowej.
 *
 * Cała reszta modułu CRM zna wyłącznie interfejs MailboxAdapter i typ RawMail.
 * Podmiana atrapy na prawdziwą pocztę sprowadza się do napisania drugiej
 * implementacji tego interfejsu i zmiany jednej linijki w `mailboxAdapter`.
 * Żaden endpoint ani komponent nie wie, skąd biorą się wiadomości.
 *
 * Kontrakt adaptera:
 *   - fetchNew() dostaje zbiór znanych identyfikatorów i zwraca WYŁĄCZNIE
 *     wiadomości spoza tego zbioru (deduplikacja po stronie źródła — realny
 *     IMAP zrobi to zapytaniem UID > lastSeenUid, atrapa filtrem tablicy),
 *   - błąd sieci/uwierzytelnienia sygnalizuje wyjątkiem MailboxError.
 */

import { RAW_MAILBOX } from "./mock-mailbox.js";
import type { RawMail } from "./mock-mailbox.js";

export type { RawMail };

export class MailboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailboxError";
  }
}

export interface MailboxAdapter {
  /** Nazwa pokazywana w interfejsie, np. „Atrapa skrzynki (demo)”. */
  readonly name: string;
  fetchNew(znaneIds: ReadonlySet<string>): Promise<RawMail[]>;
}

const spij = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Atrapa: czyta z tablicy w pamięci, symuluje opóźnienie sieci i sporadyczną
 * awarię. Awaria jest celowa — interfejs ma mieć okazję pokazać stan błędu,
 * a operator ma zobaczyć, że automat sam spróbuje ponownie.
 */
export class MockMailboxAdapter implements MailboxAdapter {
  readonly name = "Atrapa skrzynki (demo)";

  /** Moment startu procesu — od niego liczy się „przychodzenie” wiadomości. */
  private readonly start = Date.now();

  /** Prawdopodobieństwo symulowanej awarii pojedynczego pobrania. */
  private readonly awariaP = 0.08;

  /** Pierwsze pobranie ma się zawsze udać — inaczej demo zaczyna od błędu. */
  private pierwsze = true;

  async fetchNew(znaneIds: ReadonlySet<string>): Promise<RawMail[]> {
    await spij(500 + Math.random() * 900);

    if (!this.pierwsze && Math.random() < this.awariaP) {
      throw new MailboxError("Przekroczono czas oczekiwania na odpowiedź serwera poczty.");
    }
    this.pierwsze = false;

    const wiek = (Date.now() - this.start) / 1000;
    return RAW_MAILBOX.filter(
        (m) => m.deliverAfterSec <= wiek && !znaneIds.has(m.messageId),
    );
  }
}

/**
 * Punkt podmiany. Docelowo:
 *
 *   export const mailboxAdapter: MailboxAdapter =
 *     process.env.MAIL_MODE === "imap"
 *       ? new ImapMailboxAdapter({ host: ..., user: ..., pass: ... })
 *       : new MockMailboxAdapter();
 */
export const mailboxAdapter: MailboxAdapter = new MockMailboxAdapter();