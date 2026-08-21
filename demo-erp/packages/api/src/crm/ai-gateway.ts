/**
 * Połączenie modułu CRM z usługami AI uruchomionymi na DGX Spark.
 *
 * ERP ufa wynikowi klasyfikatora dopiero po sprawdzeniu całego kontraktu
 * modelu. Sam działający port nie oznacza, że po drugiej stronie pracuje
 * właściwy encoder.
 */

import type { DgxServiceStatus, DgxStatus } from "@demo-erp/shared";

function positiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const CLASSIFY_TIMEOUT_MS = positiveNumber("CRM_AI_CLASSIFY_TIMEOUT_MS", positiveNumber("CRM_AI_TIMEOUT_MS", 5_000));
const HEALTH_TIMEOUT_MS = positiveNumber("CRM_AI_HEALTH_TIMEOUT_MS", 3_000);
const HEALTH_CACHE_MS = positiveNumber("CRM_AI_HEALTH_CACHE_MS", 10_000);

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

function urlEnv(name: string): string | null {
  return env(name)?.replace(/\/$/, "") ?? null;
}

const dgxBaseUrl = urlEnv("CRM_DGX_BASE_URL");
const classifierUrl = urlEnv("CRM_CLASSIFIER_URL") ?? (dgxBaseUrl ? `${dgxBaseUrl}/classify-email` : null);
const extractorUrl = urlEnv("CRM_EXTRACTOR_URL");
const apiKey = env("CRM_AI_API_KEY");

const EXPECTED_CLASSIFIER = {
  service: env("CRM_EXPECTED_CLASSIFIER_SERVICE") ?? "crm-email-classifier",
  modelName:
      env("CRM_EXPECTED_ENCODER_NAME") ??
      "stacking:minilm+e5-base+bge-m3",
  modelVersion: env("CRM_EXPECTED_MODEL_VERSION") ?? "stacking-crm-v1-dgx",
  embeddingDimension: positiveNumber("CRM_EXPECTED_EMBEDDING_DIMENSION", 3),
  normalizeEmbeddings:
      (env("CRM_EXPECTED_NORMALIZE_EMBEDDINGS") ?? "true").toLowerCase() === "true",
  preprocessingVersion: positiveNumber("CRM_EXPECTED_PREPROCESSING_VERSION", 2),
} as const;

function healthUrl(serviceUrl: string | null, overrideName: string): string | null {
  const override = urlEnv(overrideName);
  if (override) return override;
  if (!serviceUrl) return null;
  try {
    return new URL("/health", serviceUrl).toString();
  } catch {
    return null;
  }
}

const classifierHealthUrl = healthUrl(classifierUrl, "CRM_CLASSIFIER_HEALTH_URL");
const extractorHealthUrl = healthUrl(extractorUrl, "CRM_EXTRACTOR_HEALTH_URL");

export type DgxClassifierFailure =
    | "not_configured"
    | "timeout"
    | "unavailable"
    | "incompatible"
    | "invalid_response";

export class DgxClassifierError extends Error {
  readonly reason: DgxClassifierFailure;

  constructor(reason: DgxClassifierFailure, message: string) {
    super(message);
    this.name = "DgxClassifierError";
    this.reason = reason;
  }
}

function safeError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === "AbortError") return `Przekroczono limit ${timeoutMs} ms.`;
  if (error instanceof Error) return error.message.slice(0, 240);
  return "Nieznany błąd połączenia.";
}

async function fetchJson(
    url: string,
    init: RequestInit = {},
    timeoutMs = CLASSIFY_TIMEOUT_MS,
): Promise<{ body: unknown; latencyMs: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} (${response.statusText || "błąd usługi"})`);
    return { body: await response.json(), latencyMs: performance.now() - started };
  } finally {
    clearTimeout(timeout);
  }
}

interface ClassifierContract {
  service: string | null;
  modelName: string | null;
  modelVersion: string | null;
  embeddingDimension: number | null;
  normalizeEmbeddings: boolean | null;
  preprocessingVersion: number | null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Czyta zarówno nowy zagnieżdżony kontrakt, jak i jego pola na najwyższym poziomie. */
function readClassifierContract(body: unknown): ClassifierContract {
  const root = object(body);
  const listedModels = Array.isArray(root.models) ? root.models.map(object) : [];
  const selectedModel = listedModels.find((entry) => {
    const entryContract = object(entry.model_contract);
    return entryContract.model_version === EXPECTED_CLASSIFIER.modelVersion;
  });
  const model = selectedModel
      ? object(selectedModel.model_contract)
      : object(root.model_contract);
  const source = Object.keys(model).length > 0 ? model : root;
  const dimension = Number(source.embedding_dimension);
  const preprocessingVersion = Number(source.preprocessing_version);
  return {
    service: typeof root.service === "string" ? root.service : null,
    modelName:
        typeof source.model_name === "string"
            ? source.model_name
            : typeof source.encoder_name === "string" ? source.encoder_name : null,
    modelVersion: typeof source.model_version === "string" ? source.model_version : null,
    embeddingDimension: Number.isInteger(dimension) && dimension > 0 ? dimension : null,
    normalizeEmbeddings:
        typeof source.normalize_embeddings === "boolean" ? source.normalize_embeddings : null,
    preprocessingVersion:
        Number.isInteger(preprocessingVersion) && preprocessingVersion > 0 ? preprocessingVersion : null,
  };
}

function contractMismatches(contract: ClassifierContract): string[] {
  const mismatches: string[] = [];
  if (contract.service !== EXPECTED_CLASSIFIER.service) {
    mismatches.push(`usługa: ${contract.service ?? "brak"} (oczekiwano ${EXPECTED_CLASSIFIER.service})`);
  }
  if (contract.modelName !== EXPECTED_CLASSIFIER.modelName) {
    mismatches.push(`model: ${contract.modelName ?? "brak"} (oczekiwano ${EXPECTED_CLASSIFIER.modelName})`);
  }
  if (contract.modelVersion !== EXPECTED_CLASSIFIER.modelVersion) {
    mismatches.push(`wersja: ${contract.modelVersion ?? "brak"} (oczekiwano ${EXPECTED_CLASSIFIER.modelVersion})`);
  }
  if (contract.embeddingDimension !== EXPECTED_CLASSIFIER.embeddingDimension) {
    mismatches.push(`wymiar: ${contract.embeddingDimension ?? "brak"} (oczekiwano ${EXPECTED_CLASSIFIER.embeddingDimension})`);
  }
  if (contract.normalizeEmbeddings !== EXPECTED_CLASSIFIER.normalizeEmbeddings) {
    mismatches.push(
      `normalizacja: ${contract.normalizeEmbeddings == null ? "brak" : String(contract.normalizeEmbeddings)}` +
      ` (oczekiwano ${EXPECTED_CLASSIFIER.normalizeEmbeddings})`,
    );
  }
  if (contract.preprocessingVersion !== EXPECTED_CLASSIFIER.preprocessingVersion) {
    mismatches.push(
      `preprocessing: ${contract.preprocessingVersion ?? "brak"}` +
      ` (oczekiwano ${EXPECTED_CLASSIFIER.preprocessingVersion})`,
    );
  }
  return mismatches;
}

function incompatibleMessage(mismatches: string[]): string {
  return `Niezgodny kontrakt modelu: ${mismatches.join("; ")}. Automatyczna klasyfikacja została zablokowana.`;
}

export interface ExternalClassification {
  category: "inquiry" | "other";
  confidence: number;
  threshold: number;
  modelName: string;
  modelVersion: string;
  latencyMs: number;
}

/** Klasyfikacja przez DGX. Każda odpowiedź ponownie potwierdza kontrakt modelu. */
export async function classifyWithDgx(input: {
  messageId: string;
  subject: string;
  body: string;
  attachments: string[];
}): Promise<ExternalClassification> {
  if (!classifierUrl || !apiKey) {
    throw new DgxClassifierError("not_configured", "Klasyfikator DGX nie jest skonfigurowany.");
  }

  let body: unknown;
  let latencyMs: number;
  try {
    ({ body, latencyMs } = await fetchJson(classifierUrl, {
      method: "POST",
      body: JSON.stringify({
        message_id: input.messageId,
        model_version: EXPECTED_CLASSIFIER.modelVersion,
        subject: input.subject,
        body: input.body,
        attachments: input.attachments,
      }),
    }));
  } catch (error) {
    const timeout = error instanceof Error && error.name === "AbortError";
    throw new DgxClassifierError(
      timeout ? "timeout" : "unavailable",
      timeout
          ? `DGX nie odpowiedział w ciągu ${CLASSIFY_TIMEOUT_MS} ms.`
          : `Nie udało się połączyć z DGX: ${safeError(error, CLASSIFY_TIMEOUT_MS)}`,
    );
  }

  if (!body || typeof body !== "object") {
    throw new DgxClassifierError("invalid_response", "Klasyfikator zwrócił niepoprawny JSON.");
  }
  const result = body as Record<string, unknown>;
  const contract = readClassifierContract(result);
  const mismatches = contractMismatches(contract);
  if (mismatches.length > 0) {
    cached = null;
    throw new DgxClassifierError("incompatible", incompatibleMessage(mismatches));
  }

  const probability = Number(result.probability);
  const threshold = Number(result.threshold);
  const classification = result.classification;
  const responseMessageId = result.message_id;
  const responseModelVersion = result.model_version;
  const label = Number(result.label);
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new DgxClassifierError("invalid_response", "Klasyfikator zwrócił niepoprawne prawdopodobieństwo.");
  }
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
    throw new DgxClassifierError("invalid_response", "Klasyfikator zwrócił niepoprawny próg.");
  }
  if (classification !== "inquiry" && classification !== "not_inquiry") {
    throw new DgxClassifierError("invalid_response", "Klasyfikator zwrócił nieznaną klasę.");
  }
  if (responseMessageId !== input.messageId) {
    throw new DgxClassifierError("invalid_response", "Klasyfikator zwrócił wynik dla innej wiadomości.");
  }
  if (responseModelVersion !== contract.modelVersion) {
    throw new DgxClassifierError("invalid_response", "Wersja wyniku nie zgadza się z kontraktem modelu.");
  }
  const expectedClassification = probability >= threshold ? "inquiry" : "not_inquiry";
  const expectedLabel = expectedClassification === "inquiry" ? 1 : 0;
  if (classification !== expectedClassification || label !== expectedLabel) {
    throw new DgxClassifierError("invalid_response", "Wynik klasyfikatora jest niespójny z prawdopodobieństwem i progiem.");
  }
  return {
    category: classification === "inquiry" ? "inquiry" : "other",
    confidence: classification === "inquiry" ? probability : 1 - probability,
    threshold,
    modelName: contract.modelName!,
    modelVersion: contract.modelVersion!,
    latencyMs,
  };
}

function emptyService(state: "not_configured" | "offline", label: string, lastError: string | null): DgxServiceStatus {
  return {
    state,
    label,
    modelName: null,
    modelVersion: null,
    embeddingDimension: null,
    normalizeEmbeddings: null,
    preprocessingVersion: null,
    latencyMs: null,
    lastError,
  };
}

async function probeClassifier(): Promise<DgxServiceStatus> {
  const label = "Klasyfikator wiadomości";
  if (!classifierHealthUrl || !apiKey) {
    return emptyService("not_configured", label, !apiKey ? "Brak konfiguracji klucza usługi AI." : null);
  }
  try {
    const { body, latencyMs } = await fetchJson(classifierHealthUrl, {}, HEALTH_TIMEOUT_MS);
    const root = object(body);
    const contract = readClassifierContract(root);
    const mismatches = root.status === "ok" ? contractMismatches(contract) : ["usługa nie zgłosiła statusu ok"];
    if (mismatches.length > 0) {
      return {
        state: "incompatible",
        label,
        ...contract,
        latencyMs,
        lastError: incompatibleMessage(mismatches),
      };
    }
    return { state: "online", label, ...contract, latencyMs, lastError: null };
  } catch (error) {
    return emptyService("offline", label, safeError(error, HEALTH_TIMEOUT_MS));
  }
}

async function probeGeneric(label: string, url: string | null): Promise<DgxServiceStatus> {
  if (!url) return emptyService("not_configured", label, null);
  try {
    const { body, latencyMs } = await fetchJson(url, {}, HEALTH_TIMEOUT_MS);
    const result = object(body);
    return {
      state: "online",
      label,
      modelName: typeof result.model === "string" ? result.model : null,
      modelVersion: typeof result.model_version === "string" ? result.model_version : null,
      embeddingDimension: null,
      normalizeEmbeddings: null,
      preprocessingVersion: null,
      latencyMs,
      lastError: null,
    };
  } catch (error) {
    return emptyService("offline", label, safeError(error, HEALTH_TIMEOUT_MS));
  }
}

let cached: { at: number; value: DgxStatus } | null = null;

/** Health-check jest zielony wyłącznie dla zgodnego kontraktu klasyfikatora. */
export async function getDgxStatus(force = false): Promise<DgxStatus> {
  const now = Date.now();
  if (!force && cached && now - cached.at < HEALTH_CACHE_MS) return cached.value;

  const [classifier, extractor] = await Promise.all([
    probeClassifier(),
    probeGeneric("Ekstrakcja danych LLM", extractorHealthUrl),
  ]);

  let state: DgxStatus["state"];
  if (classifier.state === "not_configured") state = "not_configured";
  else if (classifier.state === "incompatible") state = "incompatible";
  else if (classifier.state === "offline") state = "offline";
  else if (extractor.state === "offline" || extractor.state === "incompatible") state = "degraded";
  else state = "connected";

  const value: DgxStatus = {
    state,
    checkedAt: new Date().toISOString(),
    classifier,
    extractor,
  };
  cached = { at: now, value };
  return value;
}

export function isDgxClassifierConfigured(): boolean {
  return classifierUrl != null && apiKey != null;
}
