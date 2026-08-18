/**
 * extract.ts — wyodrębnianie danych klienta z treści wiadomości.
 *
 * Reguły są celowo konserwatywne: lepiej zwrócić null i pokazać brak
 * w statusie kompletności, niż wstawić do CRM zgadywankę, którą handlowiec
 * weźmie za pewnik. Każde pole ma osobną funkcję, więc podmiana pojedynczej
 * heurystyki na model nie rusza reszty.
 */

import type { AttachmentKind, ExtractedData } from "@demo-erp/shared";

// ----------------------------- pola proste --------------------------------

const RE_EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/** Polskie numery w typowych zapisach: +48 601 224 118, 12 345 67 89, 668900121. */
const RE_TEL = /(?:\+?48[\s-]?)?(?:\d{2,3}[\s-]?){2,3}\d{2,3}/;

const RE_KOD = /\b\d{2}-\d{3}\b/;

/**
 * Formy prawne. Przed formą bierzemy najwyżej trzy słowa zaczynające się
 * wielką literą — bez tego ograniczenia wyrażenie zjada resztę zdania
 * i do CRM trafia „Prosimy o wycenę do końca tygodnia. Hydromel Sp. z o.o.”.
 */
const RE_FIRMA_FORMA =
    /((?:[A-ZŁŚŻŹĆÓĄĘŃ][\p{L}\d.&-]*\s+){1,3}(?:Sp\.\s?z\s?o\.\s?o\.|S\.\s?A\.|Sp\.\s?j\.|S\.\s?C\.))/u;

/** Przedrostki typowe dla mniejszych firm, gdzie forma prawna bywa pomijana. */
const RE_FIRMA_PREFIX =
    /((?:PPHU|PHU|FHU|Zakłady|Zakład|Przedsiębiorstwo|Firma)\s+[\p{L}\d.&-]+(?:\s+[\p{L}\d.&-]+)?)/u;

const czysc = (s: string | undefined | null): string | null => {
  const v = (s ?? "").trim().replace(/\s+/g, " ");
  return v === "" ? null : v;
};

function znajdzTelefon(text: string): string | null {
  // Szukamy w linii z etykietą — inaczej łatwo złapać numer rysunku lub NIP.
  const linia = text
      .split("\n")
      .find((l) => /(tel|kom|telefon|phone|mob)/i.test(l) && RE_TEL.test(l));
  const zrodlo = linia ?? "";
  const m = RE_TEL.exec(zrodlo.replace(/^.*?(?=(?:\+|\d))/, ""));
  if (!m) return null;
  const cyfry = m[0].replace(/[^\d+]/g, "");
  return cyfry.replace(/^\+?48/, "").length >= 9 ? m[0].trim() : null;
}

function znajdzAdres(text: string): string | null {
  const linie = text.split("\n").map((l) => l.trim());
  const zKodem = linie.find((l) => RE_KOD.test(l) && /(ul\.|al\.|os\.|\d)/i.test(l));
  if (!zKodem) return null;
  // Odetnij prefiks typu „Adres:” i ewentualną nazwę firmy przed przecinkiem.
  return czysc(zKodem.replace(/^adres\s*:\s*/i, ""));
}

function znajdzFirme(text: string, fromEmail: string): string | null {
  // Linia po linii: nazwa firmy nigdy nie przechodzi przez łamanie wiersza.
  for (const linia of text.split("\n")) {
    const m = RE_FIRMA_FORMA.exec(linia) ?? RE_FIRMA_PREFIX.exec(linia);
    if (m?.[1]) return czysc(m[1]);
  }

  // Fallback: domena adresu nadawcy. Domeny pocztowe odpadają — z nich
  // nie da się wyprowadzić nazwy firmy i lepiej zgłosić brak.
  const domena = fromEmail.split("@")[1] ?? "";
  const publiczne = ["gmail.com", "wp.pl", "o2.pl", "interia.pl", "onet.pl", "outlook.com", "yahoo.com"];
  if (publiczne.includes(domena.toLowerCase())) return null;
  const rdzen = domena.split(".")[0] ?? "";
  return rdzen === "" ? null : rdzen.charAt(0).toUpperCase() + rdzen.slice(1);
}

/** Termin: „do 2026-09-30”, „Termin realizacji: 15.10.2026”, „do 30.09.2026”. */
function znajdzTermin(text: string): string | null {
  const iso = /(20\d{2})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return iso[0];
  const pl = /(\d{1,2})[.\-/](\d{1,2})[.\-/](20\d{2})/.exec(text);
  if (pl && pl[1] && pl[2] && pl[3]) {
    return `${pl[3]}-${pl[2].padStart(2, "0")}-${pl[1].padStart(2, "0")}`;
  }
  return null;
}

/** Ilość: „40 kpl.”, „200 szt.”, „2400 m”, „1,5 tony”. */
function znajdzIlosc(text: string): string | null {
  const m = /(\d[\d\s.,]*)\s?(kpl\.?|szt\.?|sztuk|m\b|mb\b|kg\b|ton[ya]?\b|l\b)/i.exec(text);
  return m ? czysc(m[0]) : null;
}

/**
 * Opis: treść bez powitania, stopki i danych kontaktowych. Bierzemy pierwsze
 * zdania merytoryczne — to one trafiają na kartę zapytania.
 */
function znajdzOpis(text: string): string | null {
  const pomijaj =
      /^(dzień dobry|witam|szanowni|dzien dobry|pozdrawiam|z poważaniem|z powazaniem|tel|kom|adres|firma|e-?mail|dział|dzial|kierownik)/i;
  const linie = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !pomijaj.test(l) && !RE_EMAIL.test(l) && !RE_KOD.test(l));
  const opis = linie.slice(0, 4).join(" ");
  return czysc(opis);
}

/** Produkty/usługi: fragment zdania po czasowniku zamówieniowym. */
function znajdzProdukty(text: string): string | null {
  const m =
      /(?:wycenę|wycene|ofertę|oferte|zapytaniem ofertowym) (?:na|o) ([^.\n]{6,120})/i.exec(text) ??
      /(?:interesuje mnie|zamawiamy|potrzebujemy) ([^.\n]{6,120})/i.exec(text) ??
      /(?:proszę o wycenę|prosimy o ofertę) ([^.\n]{6,120})/i.exec(text);
  return m?.[1] ? czysc(m[1]) : null;
}

// --------------------------- rodzaje załączników ---------------------------

/**
 * Rozpoznanie rodzaju załącznika po nazwie pliku. Kolejność warunków ma
 * znaczenie: „rysunek…pdf” to rysunek techniczny, nie „dokument PDF”.
 */
export function rodzajZalacznika(nazwa: string): AttachmentKind {
  const n = nazwa.toLowerCase();
  if (/(rys|rysunek|draw|dwg|dxf|wykonawcz)/.test(n)) return "drawing";
  if (/(specyf|spec|zestawienie|bom|materialow|materiałow)/.test(n)) return "specification";
  if (/(foto|zdj|photo|\.jpg|\.jpeg|\.png|referencj)/.test(n)) return "photos";
  if (/(formularz|form|ankieta)/.test(n)) return "form";
  if (/\.pdf$/.test(n)) return "pdf";
  return "other";
}

// -------------------------------- wejście ----------------------------------

export function extractFromMail(mail: {
  from: string;
  fromEmail: string;
  subject: string;
  body: string;
  attachments: { name: string }[];
}): ExtractedData {
  const pelny = `${mail.subject}\n${mail.body}`;
  return {
    companyName: znajdzFirme(mail.body, mail.fromEmail),
    // Nazwisko bierzemy z nagłówka From — jest tam w ustandaryzowanej formie.
    contactName: /^[\p{L}. -]+$/u.test(mail.from.trim()) ? czysc(mail.from) : null,
    email: RE_EMAIL.exec(mail.body)?.[0] ?? mail.fromEmail,
    phone: znajdzTelefon(mail.body),
    address: znajdzAdres(mail.body),
    description: znajdzOpis(mail.body),
    products: znajdzProdukty(pelny),
    quantity: znajdzIlosc(pelny),
    deadline: znajdzTermin(pelny),
    attachments: mail.attachments.map((a) => a.name),
  };
}