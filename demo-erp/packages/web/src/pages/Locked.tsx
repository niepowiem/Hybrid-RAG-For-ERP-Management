/**
 * Ekran dla modułów spoza prototypu. Uczciwy komunikat zamiast atrapy —
 * kliknięcie w wygaszoną pozycję menu nie może wyglądać jak awaria.
 */
export function LockedPage() {
  return (
    <>
      <h1>Moduł niedostępny</h1>
      <p className="page-sub">Ta część systemu nie wchodzi w zakres prototypu.</p>
      <div className="locked-page">
        <div className="icon">🔒</div>
        <h2>Poza zakresem wersji demonstracyjnej</h2>
        <p>
          Prototyp obejmuje moduł magazynowy: stany, dokumenty PZ / WZ / MM,
          kartotekę produktów i kontrahentów. Pozostałe moduły są widoczne
          w nawigacji, aby odwzorować strukturę docelowego systemu.
        </p>
      </div>
    </>
  );
}
