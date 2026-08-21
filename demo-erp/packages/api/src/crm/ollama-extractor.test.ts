import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

test("wywołuje Ollamę dopiero jedną partią i waliduje dane CRM", async (context) => {
  let requestCount = 0;
  const server = createServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/chat");
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      requestCount += 1;
      const body = JSON.parse(raw) as Record<string, unknown>;
      assert.equal(body.model, "crm-extractor-test:8b");
      assert.equal(body.stream, false);
      assert.equal((body.options as Record<string, unknown>).temperature, 0);
      assert.equal((body.format as Record<string, unknown>).type, "object");
      const messages = body.messages as Array<Record<string, string>>;
      assert.match(messages[1]?.content ?? "", /mail-001/);
      assert.match(messages[1]?.content ?? "", /mail-002/);

      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        model: "crm-extractor-test:8b",
        done: true,
        message: {
          role: "assistant",
          content: JSON.stringify({
            results: [
              {
                message_id: "mail-001",
                data: {
                  companyName: "Alubud Sp. z o.o.", contactName: "Marek Zieliński",
                  email: "m.zielinski@alubud.com.pl", phone: null, address: null,
                  description: "Wycena profili aluminiowych", products: "profile aluminiowe",
                  quantity: "20 szt.", deadline: "2026-09-30", attachments: ["zmyślony.pdf"],
                },
              },
              {
                message_id: "mail-002",
                data: {
                  companyName: null, contactName: "Anna Nowak", email: "anna@example.com",
                  phone: null, address: null, description: "Prośba o ofertę", products: null,
                  quantity: null, deadline: null, attachments: [],
                },
              },
            ],
          }),
        },
      }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert(address && typeof address === "object");

  process.env.CRM_OLLAMA_URL = `http://127.0.0.1:${address.port}`;
  process.env.CRM_OLLAMA_MODEL = "crm-extractor-test:8b";
  const { extractRoundWithOllama } = await import("./ollama-extractor.js");
  const results = await extractRoundWithOllama([
    {
      externalId: "mail-001", from: "Marek Zieliński", fromEmail: "m.zielinski@alubud.com.pl",
      subject: "Prośba o ofertę", body: "Proszę o wycenę 20 profili do 30.09.2026.",
      attachments: [{ name: "projekt.pdf" }],
    },
    {
      externalId: "mail-002", from: "Anna Nowak", fromEmail: "anna@example.com",
      subject: "Oferta", body: "Proszę o przygotowanie oferty.", attachments: [],
    },
  ]);

  assert.equal(requestCount, 1);
  assert.equal(results.get("mail-001")?.companyName, "Alubud Sp. z o.o.");
  assert.deepEqual(results.get("mail-001")?.attachments, ["projekt.pdf"]);
  assert.equal(results.get("mail-002")?.deadline, null);
});
