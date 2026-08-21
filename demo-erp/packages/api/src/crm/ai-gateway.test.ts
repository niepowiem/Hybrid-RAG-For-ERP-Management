import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

test("obsługuje kontrakt stackingu DGX Spark", async (context) => {
  const expectedAuthorization = "Bearer contract-test-secret";
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, expectedAuthorization);
    response.setHeader("content-type", "application/json");

    if (request.url === "/health") {
      response.end(JSON.stringify({
        status: "ok",
        service: "crm-email-classifier",
        default_model_version: "stacking-crm-v1-dgx",
        model_contract: {
          model_name: "stacking:minilm+e5-base+bge-m3",
          model_version: "stacking-crm-v1-dgx",
          embedding_dimension: 3,
          normalize_embeddings: true,
          preprocessing_version: 2,
        },
        models: [],
        device: "cuda",
      }));
      return;
    }

    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const input = JSON.parse(raw) as Record<string, unknown>;
      assert.equal(input.model_version, "stacking-crm-v1-dgx");
      response.end(JSON.stringify({
        message_id: input.message_id,
        label: 1,
        classification: "inquiry",
        probability: 0.97,
        threshold: 0.85,
        model_version: "stacking-crm-v1-dgx",
        service: "crm-email-classifier",
        model_contract: {
          model_name: "stacking:minilm+e5-base+bge-m3",
          model_version: "stacking-crm-v1-dgx",
          embedding_dimension: 3,
          normalize_embeddings: true,
          preprocessing_version: 2,
        },
      }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert(address && typeof address === "object");

  process.env.CRM_CLASSIFIER_URL = `http://127.0.0.1:${address.port}/classify-email`;
  process.env.CRM_CLASSIFIER_HEALTH_URL = `http://127.0.0.1:${address.port}/health`;
  process.env.CRM_AI_API_KEY = "contract-test-secret";

  const gateway = await import("./ai-gateway.js");
  const status = await gateway.getDgxStatus(true);
  assert.equal(status.state, "connected");
  assert.equal(status.classifier.modelVersion, "stacking-crm-v1-dgx");
  assert.equal(status.classifier.preprocessingVersion, 2);

  const result = await gateway.classifyWithDgx({
    messageId: "mail-test-001",
    subject: "Prośba o przygotowanie oferty",
    body: "Proszę o wycenę i podanie terminu realizacji.",
    attachments: ["specyfikacja.pdf"],
  });
  assert.equal(result.category, "inquiry");
  assert.equal(result.confidence, 0.97);
  assert.equal(result.threshold, 0.85);
});
