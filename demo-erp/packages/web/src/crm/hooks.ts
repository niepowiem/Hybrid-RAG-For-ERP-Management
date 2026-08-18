/**
 * crm/hooks.ts — wspólne pobieranie danych modułu.
 *
 * Lista pracowników jest krótka i praktycznie stała, a potrzebna w każdym
 * widoku — trzymamy ją w cache modułu, żeby przejście między zakładkami
 * nie generowało tego samego żądania po raz piąty.
 */

import { useCallback, useEffect, useState } from "react";
import type { CrmEmployee, CrmRequest } from "@demo-erp/shared";
import { crmApi } from "./client.js";

let cachePracownikow: CrmEmployee[] | null = null;
let wLocie: Promise<CrmEmployee[]> | null = null;

export function useEmployees(): CrmEmployee[] {
  const [lista, setLista] = useState<CrmEmployee[]>(cachePracownikow ?? []);
  useEffect(() => {
    if (cachePracownikow) return;
    wLocie ??= crmApi.employees().then((e) => {
      cachePracownikow = e;
      return e;
    });
    void wLocie.then(setLista).catch(() => setLista([]));
  }, []);
  return lista;
}

/** Mapa id → pracownik, bo w tabelach i na kartach szukamy po identyfikatorze. */
export function useEmployeeMap(): Map<string, CrmEmployee> {
  const lista = useEmployees();
  return new Map(lista.map((e) => [e.id, e]));
}

export interface RequestsState {
  requests: CrmRequest[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** Podmiana pojedynczego zapytania po akcji, bez pełnego przeładowania listy. */
  podmien: (r: CrmRequest) => void;
}

export function useCrmRequests(): RequestsState {
  const [requests, setRequests] = useState<CrmRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setRequests(await crmApi.requests());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nie udało się wczytać zapytań.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const podmien = useCallback((r: CrmRequest) => {
    setRequests((rs) => rs.map((x) => (x.id === r.id ? r : x)));
  }, []);

  return { requests, loading, error, reload, podmien };
}