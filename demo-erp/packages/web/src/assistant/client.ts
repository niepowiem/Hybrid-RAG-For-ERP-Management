/**
 * client.ts — jedyne miejsce, przez które interfejs rozmawia z asystentem.
 *
 * Szew: komponent czatu nie wie, czy odpowiedź pochodzi z atrapy, czy
 * z backendu Pythona. Przełącznik poniżej to jedyna zmiana potrzebna,
 * żeby przejść z jednego na drugie.
 */

import type { AssistantReply, AssistantRequest } from "@demo-erp/shared";
import { askMock } from "./mock.js";

/** true = atrapa (działa bez backendu), false = prawdziwy asystent. */
const USE_MOCK = false;

const ASSISTANT_URL = "/assistant/ask";

export async function askAssistant(req: AssistantRequest): Promise<AssistantReply> {
  if (USE_MOCK) return askMock(req.question);

  const res = await fetch(ASSISTANT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`Asystent odpowiedział ${res.status}`);
  return (await res.json()) as AssistantReply;
}
