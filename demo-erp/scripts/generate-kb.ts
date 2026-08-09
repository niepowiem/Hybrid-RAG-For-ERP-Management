/**
 * generate-kb.ts — generuje korpus wiedzy asystenta z kodu aplikacji.
 *
 * TO JEST GWÓŹDŹ DEMO. Rejestr błędów w shared/src/errors.ts jest jedynym
 * źródłem prawdy: aplikacja pokazuje z niego komunikaty, a ten skrypt
 * produkuje z niego wiedzę asystenta. Zmieniasz opis błędu w kodzie,
 * uruchamiasz build — asystent wie. Zero ręcznej synchronizacji,
 * zero możliwości rozjazdu.
 *
 * Uruchomienie:  npm run kb:generate
 * Wyjście:       $KB_OUT/errors/errors.generated.yaml
 *                (domyślnie ../assistant-py/knowledge)
 *
 * Docelowo ten skrypt wchodzi do CI po każdym merge — wtedy czas od zmiany
 * w kodzie do zaktualizowanej wiedzy asystenta liczy się w sekundach.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { ERRORS } from "../packages/shared/src/errors.js";

const KB_OUT = resolve(process.env.KB_OUT ?? "../assistant-py/knowledge");

interface KbError {
  id: string;
  module: string;
  message_user: string;
  message_dev?: string;
  causes: string[];
  resolution: string[];
  resolution_refs: string[];
  is_known_bug: boolean;
}

const docs: KbError[] = Object.values(ERRORS).map((e) => ({
  id: e.code,
  module: "magazyn",
  message_user: e.messageUser,
  message_dev: e.messageDev,
  causes: e.causes,
  resolution: e.resolution,
  resolution_refs: e.resolutionRefs ?? [],
  is_known_bug: e.isKnownBug,
}));

const header = [
  "# PLIK GENEROWANY — nie edytuj ręcznie.",
  "# Źródło: demo-erp/packages/shared/src/errors.ts",
  "# Regeneracja: npm run kb:generate",
  "",
].join("\n");

const outDir = join(KB_OUT, "errors");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, "errors.generated.yaml");
writeFileSync(outFile, header + stringify(docs), "utf8");

console.log(`Wygenerowano ${docs.length} kart błędów -> ${outFile}`);
