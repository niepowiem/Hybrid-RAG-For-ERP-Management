/**
 * crm/boardPrefs.ts — ustawienia tablicy zapamiętywane po stronie przeglądarki.
 *
 * Sortowanie kolumny, jej zwinięcie, limit widocznych kafelków i tryb
 * kolorowania to preferencje JEDNEJ osoby przy JEDNYM biurku — nie dane
 * firmy. Trzymanie ich w API oznaczałoby, że zwinięcie kolumny u jednego
 * handlowca zwija ją wszystkim, więc siedzą w localStorage.
 *
 * Zapis jest w try/catch, bo w trybie prywatnym localStorage potrafi rzucać
 * wyjątkiem, a utrata preferencji nie może wywrócić tablicy.
 */

export const SORT_MODES = [
    "newest",
    "oldest",
    "value_desc",
    "value_asc",
    "urgency_desc",
    "urgency_asc",
    "issues",
] as const;
export type SortMode = (typeof SORT_MODES)[number];

export const SORT_LABELS: Record<SortMode, string> = {
    newest: "Od najnowszych",
    oldest: "Od najstarszych",
    value_desc: "Od najdroższych",
    value_asc: "Od najtańszych",
    urgency_desc: "Od najpilniejszych",
    urgency_asc: "Od najmniej pilnych",
    issues: "Najpierw z problemami",
};

/** Czym kolorować tło kafelka. „none” to domyślny, świadomie nudny widok. */
export const COLOR_MODES = ["none", "urgency", "stage", "assignee", "value"] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export const COLOR_MODE_LABELS: Record<ColorMode, string> = {
    none: "Bez kolorowania",
    urgency: "Według pilności",
    stage: "Według etapu",
    assignee: "Według kosztorysanta",
    value: "Według wartości wyceny",
};

export interface ColumnPrefs {
    sort: SortMode;
    collapsed: boolean;
    limit: number;
    /**
     * Kiedy ta osoba ostatnio „sprawdziła” kolumnę. Karty, które weszły później,
     * liczą się do niebieskiego licznika „+N”. Data jest lokalna, bo to pytanie
     * o MOJĄ nieobecność, a nie o stan wspólny.
     */
    checkedAt: string | null;
}

export interface BoardPrefs {
    columns: Record<string, ColumnPrefs>;
    colorMode: ColorMode;
    /** Ile kafelków pokazuje kolumna, zanim pojawi się „Pokaż więcej”. */
    pageSize: number;
}

export const DEFAULT_COLUMN_PREFS: ColumnPrefs = {
    sort: "urgency_desc",
    collapsed: false,
    limit: 0,
    checkedAt: null,
};

const KLUCZ = "crm.board.prefs.v1";

const PUSTE: BoardPrefs = { columns: {}, colorMode: "none", pageSize: 5 };

/** Dopuszczalne liczby kafelków w kolumnie. */
export const ROZMIARY_STRONY = [3, 5, 10, 20] as const;

export function wczytajPrefs(): BoardPrefs {
    try {
        const raw = window.localStorage.getItem(KLUCZ);
        if (!raw) return PUSTE;
        const p = JSON.parse(raw) as Partial<BoardPrefs>;
        return {
            columns: p.columns ?? {},
            colorMode: (COLOR_MODES as readonly string[]).includes(p.colorMode ?? "")
                ? (p.colorMode as ColorMode)
                : "none",
            pageSize: typeof p.pageSize === "number" && p.pageSize > 0 ? p.pageSize : 5,
        };
    } catch {
        return PUSTE;
    }
}

export function zapiszPrefs(p: BoardPrefs): void {
    try {
        window.localStorage.setItem(KLUCZ, JSON.stringify(p));
    } catch {
        // Brak zapisu preferencji nie jest błędem, który warto pokazywać.
    }
}

export const prefsKolumny = (p: BoardPrefs, id: string): ColumnPrefs =>
    p.columns[id] ?? DEFAULT_COLUMN_PREFS;