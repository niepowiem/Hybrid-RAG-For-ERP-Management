import { useEffect, useState } from "react";
import type { Counterparty } from "@demo-erp/shared";
import { api } from "../api.js";

const KIND: Record<Counterparty["kind"], string> = {
  supplier: "Dostawca",
  customer: "Odbiorca",
  both: "Dostawca i odbiorca",
};

export function CounterpartiesPage() {
  const [rows, setRows] = useState<Counterparty[]>([]);
  const [q, setQ] = useState("");

  useEffect(() => {
    void api.counterparties().then(setRows);
  }, []);

  const filtered = rows.filter(
    (c) =>
      q === "" ||
      c.name.toLowerCase().includes(q.toLowerCase()) ||
      c.code.toLowerCase().includes(q.toLowerCase()) ||
      c.taxId.includes(q),
  );

  return (
    <>
      <h1>Kontrahenci</h1>
      <p className="page-sub">Dostawcy i odbiorcy używani na dokumentach PZ i WZ.</p>

      <div className="filters">
        <div className="f">
          <label htmlFor="cp-q">Szukaj</label>
          <input
            id="cp-q"
            data-assistant-id="field.counterparty-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="nazwa, kod lub NIP"
          />
        </div>
        <div className="spacer" />
        <span className="result-count">{filtered.length} / {rows.length}</span>
      </div>

      <table data-assistant-id="table.counterparties">
        <thead>
          <tr>
            <th>Kod</th><th>Nazwa</th><th>NIP</th><th>Miasto</th><th>Rodzaj</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((c) => (
            <tr key={c.id}>
              <td className="mono">{c.code}</td>
              <td>{c.name}</td>
              <td className="mono">{c.taxId}</td>
              <td>{c.city}</td>
              <td>{KIND[c.kind]}</td>
              <td>
                <span className={`badge ${c.active ? "confirmed" : "inactive"}`}>
                  {c.active ? "Aktywny" : "Nieaktywny"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
