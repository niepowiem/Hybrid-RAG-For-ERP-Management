/**
 * crm/vendors.ts — firmy zewnętrzne (outsourcing) i atrapa ich odpowiedzi.
 *
 * Kooperanci są osobnym rejestrem, nie klientami: pytamy ich o cenę zakresu,
 * którego nie robimy u siebie. Kluczowa reguła całego modułu: KAŻDA firma
 * dostaje własną wiadomość, ze swoim adresem w polu „do”. Wysyłka zbiorcza
 * pokazałaby konkurentom, że pytamy równolegle, i oddała za darmo jedyną
 * przewagę, jaką w tej rozmowie mamy.
 */

import type { CrmVendor } from "@demo-erp/shared";

export const crmVendors: CrmVendor[] = [
    { id: "v-1", name: "Gięcie CNC Kowalczyk", email: "oferty@giecie-kowalczyk.pl", specialties: ["gięcie", "cięcie laserem"], phone: "+48 95 720 11 40" },
    { id: "v-2", name: "Lakiernia Proszkowa KOLOR", email: "biuro@kolor-lakiernia.pl", specialties: ["malowanie proszkowe", "ocynk"], phone: "+48 61 300 55 12" },
    { id: "v-3", name: "MetalTech Obróbka", email: "wyceny@metaltech-obrobka.pl", specialties: ["obróbka skrawaniem", "spawanie"], phone: "+48 68 411 90 22" },
    { id: "v-4", name: "Ocynkownia Zachód", email: "zapytania@ocynkownia-zachod.pl", specialties: ["ocynk ogniowy"], phone: "+48 95 733 18 05" },
    { id: "v-5", name: "PRO-SPAW Konstrukcje", email: "biuro@pro-spaw.com.pl", specialties: ["spawanie", "konstrukcje stalowe"], phone: null },
    { id: "v-6", name: "Elektro-Montaż Serwis", email: "oferty@elektro-montaz.pl", specialties: ["okablowanie", "automatyka"], phone: "+48 61 842 77 30" },
];

/**
 * Atrapa odpowiedzi kooperanta. Prawdziwy kooperant odpisuje mailem, którego
 * treść trzeba odczytać — tutaj losujemy cenę wokół wartości bazowej, żeby
 * demonstracja pokazała różnicę ofert i sortowanie od najtańszej.
 *
 * Część firm celowo nie odpowiada w ogóle: brak odpowiedzi jest w tej pracy
 * równie częsty jak odpowiedź i widok musi sobie z nim radzić.
 */
export interface SymulowanaOdpowiedz {
    quoteValue: number | null;
    leadTimeDays: number | null;
    status: "quoted" | "declined" | "sent";
    note: string | null;
    zalacznik: { name: string; sizeKb: number } | null;
    /** Pełna treść odpowiedzi — do rozwinięcia w panelu outsourcingu. */
    replySubject: string | null;
    replyBody: string | null;
}

export function symulujOdpowiedz(
    vendorId: string,
    bazowaCena: number,
    kontekst: { vendorName: string; temat: string; pozycje: string[] } = {
        vendorName: "Kooperant",
        temat: "zapytanie",
        pozycje: [],
    },
): SymulowanaOdpowiedz {
    const los = Math.random();
    const lista = kontekst.pozycje.map((p, i) => `${i + 1}. ${p}`).join("\n");

    if (los < 0.12) {
        return {
            quoteValue: null,
            leadTimeDays: null,
            status: "declined",
            note: "Brak wolnych mocy w podanym terminie.",
            zalacznik: null,
            replySubject: `Re: ${kontekst.temat}`,
            replyBody: [
                "Dzień dobry,",
                "",
                "dziękujemy za zapytanie. Niestety w podanym terminie nie mamy wolnych mocy",
                "przerobowych i musimy odmówić wyceny.",
                "",
                "Prosimy o pamięć przy kolejnych zapytaniach.",
                "",
                "Pozdrawiam,",
                kontekst.vendorName,
            ].join("\n"),
        };
    }
    if (los < 0.28) {
        // Firma milczy — zostaje w statusie „wysłane”.
        return {
            quoteValue: null,
            leadTimeDays: null,
            status: "sent",
            note: null,
            zalacznik: null,
            replySubject: null,
            replyBody: null,
        };
    }

    const wsp = 0.82 + Math.random() * 0.46;
    const cena = Math.round(bazowaCena * wsp);
    const dni = 7 + Math.floor(Math.random() * 21);
    return {
        quoteValue: cena,
        leadTimeDays: dni,
        status: "quoted",
        note: null,
        zalacznik: {
            name: `wycena-${vendorId}.pdf`,
            sizeKb: 120 + Math.floor(Math.random() * 380),
        },
        replySubject: `Re: ${kontekst.temat}`,
        replyBody: [
            "Dzień dobry,",
            "",
            "w odpowiedzi na zapytanie przesyłamy wycenę:",
            "",
            lista !== "" ? lista : "— zakres wg zapytania",
            "",
            `Cena netto łącznie: ${cena.toLocaleString("pl-PL")} PLN`,
            `Termin realizacji: ${dni} dni roboczych od potwierdzenia zamówienia`,
            "Warunki płatności: przelew 21 dni",
            "Ważność oferty: 30 dni",
            "",
            "Szczegółowa kalkulacja w załączeniu. W razie pytań pozostajemy do dyspozycji.",
            "",
            "Pozdrawiam,",
            kontekst.vendorName,
        ].join("\n"),
    };
}