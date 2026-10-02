import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MissingApiKeyError, StormGTM, StormGTMError } from "stormgtm";
import { createServer, failureMessage, NO_KEY_MESSAGE } from "./server.js";

async function connect(handler: (url: string, body: unknown) => { status: number; body: unknown }) {
  const requests: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: String(url), body });
    const reply = handler(String(url), body);
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  const server = createServer(new StormGTM({ apiKey: "sgtm_live_test", baseUrl: "https://api.test", fetch: fetchImpl }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, requests };
}

const deliverable = {
  id: "chk_1",
  email: "jane@acme.io",
  normalized: "jane@acme.io",
  verdict: "deliverable",
  score: 96,
  tier: "fast",
  reasons: [{ code: "smtp_accepted", impact: "positive", weight: 45, detail: "RCPT accepted" }],
  facts: {},
  policy: { allowed: true, violations: [] },
  billable: true,
  credits: 1,
  checkedAt: "2026-10-01T00:00:00Z",
};

test("lists the agent tools with instructions", async () => {
  const { client } = await connect(() => ({ status: 200, body: {} }));
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["batch_status", "check_batch", "check_lead", "create_sequence", "credits", "domain_health", "email_status", "enroll_leads", "list_domains", "report_outcome", "send_email", "sequence_status", "stop_enrollment", "whoami"]);
  assert.match(client.getInstructions() ?? "", /check_lead/);
  assert.match(client.getInstructions() ?? "", /stormgtm skill install --claude/);
});

test("check_lead forwards context and returns a summary plus structured result", async () => {
  const { client, requests } = await connect(() => ({ status: 200, body: deliverable }));
  const result = await client.callTool({ name: "check_lead", arguments: { email: "jane@acme.io", context: { name: "Jane Doe" }, tier: "deep" } });
  assert.deepEqual(requests[0], { url: "https://api.test/v1/check", body: { email: "jane@acme.io", context: { name: "Jane Doe" }, tier: "deep" } });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  assert.match(text, /jane@acme.io: deliverable \(96\/100\)/);
  assert.equal((result.structuredContent as { verdict: string }).verdict, "deliverable");
});

test("api errors become tool errors", async () => {
  const { client } = await connect(() => ({ status: 402, body: { error: { code: "insufficient_credits", message: "balance is 0" } } }));
  const result = await client.callTool({ name: "credits", arguments: {} });
  assert.equal(result.isError, true);
  assert.match((result.content as Array<{ text: string }>)[0]!.text, /insufficient_credits/);
});

test("batch_status summarizes counts", async () => {
  const { client } = await connect(() => ({
    status: 200,
    body: { id: "bat_1", status: "running", tier: "fast", total: 2, done: 1, results: [{ index: 0, email: "jane@acme.io", status: "done", result: deliverable }, { index: 1, email: "x@y.io", status: "pending", result: null }] },
  }));
  const result = await client.callTool({ name: "batch_status", arguments: { id: "bat_1" } });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  assert.match(text, /bat_1: running 1\/2/);
  assert.match(text, /deliverable=1, pending=1/);
});

test("send_email queues messages and reports rejections", async () => {
  const { client, requests } = await connect(() => ({
    status: 202,
    body: { accepted: [{ index: 0, id: "em_1", to: "jane@acme.io", status: "queued", duplicate: false }], rejected: [{ index: 1, code: "suppressed", message: "This address bounced" }] },
  }));
  const messages = [
    { from: "Ada <ada@mail.acme.io>", to: "jane@acme.io", subject: "Hi", text: "Hello" },
    { from: "Ada <ada@mail.acme.io>", to: "gone@acme.io", subject: "Hi", text: "Hello" },
  ];
  const result = await client.callTool({ name: "send_email", arguments: { messages } });
  assert.deepEqual(requests[0], { url: "https://api.test/v1/send/emails", body: { messages } });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  assert.match(text, /1 queued, 1 rejected/);
  assert.match(text, /suppressed/);
});

test("domain tools summarize capacity and health", async () => {
  const { client } = await connect((url) => ({
    status: 200,
    body: url.endsWith("/health")
      ? { id: "d_1", name: "mail.acme.io", status: "verified", warmup: { step: 1, dailyCap: 40, maxStep: 4, paused: false, ladder: [20, 40, 80, 150, 300], pausedAt: null, pausedReason: null, sentToday: 10, remainingToday: 30 }, last7Days: { sent: 100, bounced: 1, complained: 0, bounceRate: 0.01, complaintRate: 0 }, thresholds: {} }
      : { domains: [{ id: "d_1", name: "mail.acme.io", status: "verified", region: null, createdAt: null, warmup: { step: 1, dailyCap: 40, maxStep: 4, paused: false } }] },
  }));
  const list = await client.callTool({ name: "list_domains", arguments: {} });
  assert.match((list.content as Array<{ text: string }>)[0]!.text, /mail\.acme\.io \(d_1\): verified, 40\/day/);
  const health = await client.callTool({ name: "domain_health", arguments: { id: "d_1" } });
  assert.match((health.content as Array<{ text: string }>)[0]!.text, /30\/40 left today.*1\.0% bounced/);
});

test("tool descriptions do not expose internals", async () => {
  const { client } = await connect(() => ({ status: 200, body: {} }));
  const { tools } = await client.listTools();
  const text = JSON.stringify(tools);
  assert.doesNotMatch(text, /SMTP|GitHub, web|reviewer model|DeepSeek/i);
  assert.ok(tools.some((tool) => tool.name === "send_email"));
});

test("sequence tools create, enroll and summarize", async () => {
  const { client, requests } = await connect((url) => ({
    status: url.endsWith("/enrollments") ? 202 : 201,
    body: url.endsWith("/enrollments")
      ? { accepted: [{ index: 0, id: "enr_1", email: "jane@acme.io", status: "active", duplicate: false }], rejected: [{ index: 1, code: "missing_variables", message: "Missing firstName" }], maxCredits: 2 }
      : { id: "seq_1", name: "Intro", from: "ada@mail.acme.io", replyTo: null, archivedAt: null, createdAt: "", variables: ["firstName"], steps: [{}, {}] },
  }));
  const created = await client.callTool({ name: "create_sequence", arguments: { name: "Intro", from: "ada@mail.acme.io", steps: [{ delayHours: 0, subject: "Hi {{firstName}}", text: "x" }] } });
  assert.match((created.content as Array<{ text: string }>)[0]!.text, /seq_1.*Leads need: firstName/);
  const enrolled = await client.callTool({ name: "enroll_leads", arguments: { sequenceId: "seq_1", leads: [{ email: "jane@acme.io", variables: { firstName: "Jane" } }, { email: "bob@acme.io" }] } });
  assert.match((enrolled.content as Array<{ text: string }>)[0]!.text, /1 enrolled, 0 already enrolled, 1 rejected\. Up to 2 credits/);
  assert.equal(requests[1]!.url, "https://api.test/v1/send/sequences/seq_1/enrollments");
});

test("whoami reports the account and API", async () => {
  const { client, requests } = await connect(() => ({ status: 200, body: { id: "acc_1", email: "ada@acme.io", credits: 42, pricing: { fast: 1, deep: 5, unknown: 0 }, usage30d: { total: 0, credits: 0, byVerdict: {} } } }));
  const result = await client.callTool({ name: "whoami", arguments: {} });
  assert.equal(requests[0]!.url, "https://api.test/v1/me");
  assert.match((result.content as Array<{ text: string }>)[0]!.text, /ada@acme\.io: 42 credits \(https:\/\/api\.test\)/);
  assert.deepEqual(result.structuredContent, { id: "acc_1", email: "ada@acme.io", credits: 42, apiUrl: "https://api.test" });
});

test("tools explain how to sign in when no key is configured, and pick up a key added later", async () => {
  const auth: { key?: string } = {};
  const fetchImpl = (async () => new Response(JSON.stringify({ id: "acc_1", email: "a@b.co", credits: 5 }), { status: 200 })) as typeof fetch;
  const server = createServer(() => {
    if (!auth.key) throw new MissingApiKeyError();
    return new StormGTM({ apiKey: auth.key, baseUrl: "https://api.test", fetch: fetchImpl });
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  const before = (await client.callTool({ name: "whoami", arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(before.isError, true);
  assert.equal(before.content[0]?.text, NO_KEY_MESSAGE);
  auth.key = "sgtm_live_later";
  const after = (await client.callTool({ name: "whoami", arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(after.isError, undefined);
  assert.match(after.content[0]?.text ?? "", /a@b\.co: 5 credits/);
});

test("API failures carry the error code and a next step", () => {
  assert.equal(failureMessage(new StormGTMError(404, "not_found", "Batch not found")), "StormGTM request failed (not_found): Batch not found");
  assert.match(failureMessage(new StormGTMError(402, "insufficient_credits", "Not enough credits"), "https://api.test"), /insufficient_credits.*https:\/\/api\.test\/app\/billing/);
  assert.match(failureMessage(new StormGTMError(401, "invalid_api_key", "API key is invalid or revoked")), /stormgtm login/);
});
