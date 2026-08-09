/**
 * App.tsx — powłoka aplikacji: górny pasek, nawigacja modułowa, pasek statusu.
 *
 * Nawigacja celowo odwzorowuje strukturę pełnego ERP. Moduły spoza prototypu
 * są wygaszone i oznaczone kłódką — mają wyglądać na świadomie wyłączone,
 * nie na zepsute. Kliknięcie prowadzi do czystej informacji o zakresie,
 * dzięki czemu nic w demie nie "wybucha".
 *
 * Wszystkie elementy interaktywne mają data-assistant-id (nav.*, btn.*,
 * field.*) — to zaczepy pod podświetlanie kroków przez asystenta.
 */

import { useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { ROLE_LABELS, ROLES } from "@demo-erp/shared";
import type { ApiErrorBody, Role } from "@demo-erp/shared";
import { getRole, setRole } from "./api.js";
import { StockPage } from "./pages/Stock.js";
import { ProductsPage } from "./pages/Products.js";
import { CounterpartiesPage } from "./pages/Counterparties.js";
import { DocumentsPage } from "./pages/Documents.js";
import { DocumentFormPage } from "./pages/DocumentForm.js";
import { LockedPage } from "./pages/Locked.js";
import { LocationsPage } from "./pages/Locations.js";
import { StocktakesPage } from "./pages/Stocktakes.js";
import { StocktakeDetailPage } from "./pages/StocktakeDetail.js";
import { PurchaseOrdersPage } from "./pages/PurchaseOrders.js";
import { PurchaseOrderFormPage } from "./pages/PurchaseOrderForm.js";
import { SalesOrdersPage } from "./pages/SalesOrders.js";
import { SalesOrderFormPage } from "./pages/SalesOrderForm.js";
import { PurchaseInvoicesPage } from "./pages/PurchaseInvoices.js";
import { PurchaseInvoiceFormPage } from "./pages/PurchaseInvoiceForm.js";
import { Toasts } from "./ui.js";
import { AssistantBubble } from "./assistant/AssistantBubble.js";

export function ErrorBanner({ error }: { error: ApiErrorBody | null }) {
  if (!error) return null;
  return (
    <div className="error-banner" role="alert" data-assistant-id="banner.error">
      <span className="code">{error.code}</span>
      <p className="msg">{error.message}</p>
      {error.details && Object.keys(error.details).length > 0 && (
        <details>
          <summary>Szczegóły techniczne</summary>
          <pre>{JSON.stringify(error.details, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

interface NavItem {
  label: string;
  to?: string;
  end?: boolean;
  id?: string;
  count?: string;
}
interface NavGroup {
  title: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    title: "Magazyn",
    items: [
      { label: "Stany magazynowe", to: "/", end: true, id: "nav.stock" },
      { label: "Dokumenty", to: "/documents", id: "nav.documents", count: "2" },
      { label: "Produkty", to: "/products", id: "nav.products" },
      { label: "Lokalizacje", to: "/locations", id: "nav.locations" },
      { label: "Inwentaryzacja", to: "/stocktakes", id: "nav.stocktakes" },
      { label: "Partie i numery seryjne" },
    ],
  },
  {
    title: "Zakupy",
    items: [
      { label: "Zamówienia zakupu", to: "/purchase-orders", id: "nav.purchase-orders" },
      { label: "Faktury zakupu", to: "/purchase-invoices", id: "nav.purchase-invoices" },
      { label: "Zapytania ofertowe" },
      { label: "Przyjęcia oczekiwane" },
    ],
  },
  {
    title: "Sprzedaż",
    items: [
      { label: "Kontrahenci", to: "/counterparties", id: "nav.counterparties" },
      { label: "Zamówienia sprzedaży", to: "/sales-orders", id: "nav.sales-orders" },
      { label: "Cenniki" },
    ],
  },
  {
    title: "Raporty",
    items: [
      { label: "Obroty i stany" },
      { label: "Rotacja zapasów" },
      { label: "Analiza ABC" },
      { label: "Zestawienie braków" },
    ],
  },
  {
    title: "Administracja",
    items: [
      { label: "Użytkownicy i role" },
      { label: "Słowniki" },
      { label: "Parametry systemu" },
      { label: "Dziennik zdarzeń" },
    ],
  },
];

const CRUMBS: Record<string, [string, string]> = {
  "/": ["Magazyn", "Stany magazynowe"],
  "/documents": ["Magazyn", "Dokumenty"],
  "/documents/new": ["Magazyn", "Dokumenty / Nowy"],
  "/products": ["Magazyn", "Produkty"],
  "/counterparties": ["Sprzedaż", "Kontrahenci"],
  "/locations": ["Magazyn", "Lokalizacje"],
  "/stocktakes": ["Magazyn", "Inwentaryzacja"],
  "/purchase-orders": ["Zakupy", "Zamówienia zakupu"],
  "/purchase-orders/new": ["Zakupy", "Zamówienia / Nowe"],
  "/purchase-invoices": ["Zakupy", "Faktury zakupu"],
  "/purchase-invoices/new": ["Zakupy", "Faktury / Nowa"],
  "/sales-orders": ["Sprzedaż", "Zamówienia sprzedaży"],
  "/sales-orders/new": ["Sprzedaż", "Zamówienia / Nowe"],
};

export default function App() {
  const [role, setRoleState] = useState<Role>(getRole());
  const { pathname } = useLocation();

  const crumb =
    CRUMBS[pathname] ??
    (pathname.startsWith("/documents/")
      ? ["Magazyn", "Dokumenty / Podgląd"]
      : pathname.startsWith("/stocktakes/")
        ? ["Magazyn", "Inwentaryzacja / Arkusz"]
        : pathname.startsWith("/purchase-orders/")
          ? ["Zakupy", "Zamówienia / Podgląd"]
          : pathname.startsWith("/purchase-invoices/")
            ? ["Zakupy", "Faktury / Podgląd"]
            : pathname.startsWith("/sales-orders/")
              ? ["Sprzedaż", "Zamówienia / Podgląd"]
              : ["System", "—"]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo">
          NORD<span>ERP</span>
        </div>
        <div className="crumbs">
          {crumb[0]}
          <span className="sep">›</span>
          <b>{crumb[1]}</b>
        </div>
        <input
          className="search"
          data-assistant-id="field.global-search"
          placeholder="Szukaj w systemie…  (Ctrl+K)"
          aria-label="Wyszukiwanie globalne"
        />
        <div className="chip" title="Okres obrachunkowy">
          Okres <b>2026</b>
        </div>
        <div className="chip" title="Jednostka organizacyjna">
          Oddział <b>Zakład Główny</b>
        </div>
        <div className="chip bell" title="Powiadomienia">
          🔔<span className="dot">3</span>
        </div>
        <div className="chip user" title="Zalogowany użytkownik">
          <b>{role === "kierownik" ? "M. Nowak" : "J. Kowalski"}</b>
        </div>
      </header>

      <div className="body">
        <nav className="sidebar">
          {NAV.map((group) => (
            <div key={group.title}>
              <div className="nav-group">{group.title}</div>
              {group.items.map((item) =>
                item.to ? (
                  <NavLink
                    key={item.label}
                    to={item.to}
                    end={item.end}
                    data-assistant-id={item.id}
                  >
                    <span>{item.label}</span>
                    {item.count && <span className="count">{item.count}</span>}
                  </NavLink>
                ) : (
                  <div
                    key={item.label}
                    className="locked"
                    title="Moduł poza zakresem prototypu"
                  >
                    <span>{item.label}</span>
                    <span className="lock">🔒</span>
                  </div>
                ),
              )}
            </div>
          ))}

          <div className="role-box">
            <label htmlFor="role">Kontekst uprawnień</label>
            <select
              id="role"
              data-assistant-id="field.role"
              value={role}
              onChange={(e) => {
                const r = e.target.value as Role;
                setRole(r);
                setRoleState(r);
              }}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
        </nav>

        <main className="content">
          <Routes>
            <Route path="/" element={<StockPage />} />
            <Route path="/documents" element={<DocumentsPage />} />
            <Route path="/documents/new" element={<DocumentFormPage />} />
            <Route path="/documents/:id" element={<DocumentFormPage />} />
            <Route path="/products" element={<ProductsPage />} />
            <Route path="/counterparties" element={<CounterpartiesPage />} />
            <Route path="/locations" element={<LocationsPage />} />
            <Route path="/stocktakes" element={<StocktakesPage />} />
            <Route path="/stocktakes/:id" element={<StocktakeDetailPage />} />
            <Route path="/purchase-orders" element={<PurchaseOrdersPage />} />
            <Route path="/purchase-orders/new" element={<PurchaseOrderFormPage />} />
            <Route path="/purchase-orders/:id" element={<PurchaseOrderFormPage />} />
            <Route path="/purchase-invoices" element={<PurchaseInvoicesPage />} />
            <Route path="/purchase-invoices/new" element={<PurchaseInvoiceFormPage />} />
            <Route path="/purchase-invoices/:id" element={<PurchaseInvoiceFormPage />} />
            <Route path="/sales-orders" element={<SalesOrdersPage />} />
            <Route path="/sales-orders/new" element={<SalesOrderFormPage />} />
            <Route path="/sales-orders/:id" element={<SalesOrderFormPage />} />
            <Route path="*" element={<LockedPage />} />
          </Routes>
        </main>
      </div>

      <Toasts />
      <AssistantBubble />

      <footer className="statusbar">
        <span className="env">ŚRODOWISKO: DEMO</span>
        <span>wersja 0.4.0</span>
        <span>baza: pamięć procesu</span>
        <span className="spacer" />
        <span>rola: {ROLE_LABELS[role]}</span>
        <span>magazyn domyślny: MAG-GL</span>
        <span>sesja: 00:14</span>
      </footer>
    </div>
  );
}
