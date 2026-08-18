/**
 * crm/clients.ts — kartoteka klientów.
 *
 * Dopasowanie po adresie e-mail, nie po nazwie firmy: nazwę ludzie zapisują
 * na pięć sposobów („Stalmex”, „STALMEX sp. z o.o.”, „Stalmex Katowice”),
 * adres skrzynki jest jeden. Gdy adresu nie ma w kartotece, zakładamy nowy
 * wpis — zapytanie bez klienta nie miałoby gdzie trzymać danych kontaktowych.
 */

import type { CrmClient } from "@demo-erp/shared";
import { crmClients, nextClientId } from "./store.js";

export function znajdzKlientaPoEmailu(email: string): CrmClient | undefined {
  const e = email.trim().toLowerCase();
  return crmClients.find((k) => k.email.toLowerCase() === e);
}

export function znajdzLubUtworzKlienta(dane: {
  name: string;
  contactName: string;
  email: string;
  phone: string | null;
  address: string | null;
}): CrmClient {
  const istniejacy = znajdzKlientaPoEmailu(dane.email);
  if (istniejacy) return istniejacy;
  const klient: CrmClient = {
    id: nextClientId(),
    name: dane.name,
    contactName: dane.contactName,
    email: dane.email.trim().toLowerCase(),
    phone: dane.phone,
    address: dane.address,
    nip: null,
    contacts: [
      {
        id: `${nextClientId()}-c1`,
        name: dane.contactName,
        email: dane.email.trim().toLowerCase(),
        phone: dane.phone,
        role: null,
      },
    ],
  };
  crmClients.push(klient);
  return klient;
}