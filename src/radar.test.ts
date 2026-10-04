import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StormGTM, type RadarEvent, type RadarLead } from "stormgtm";
import { createServer, INSTRUCTIONS } from "./server.js";

const lead: RadarLead = {
  id: "rld_1",
  chatId: "rch_new",
  email: "jane@acme.io",
  name: "Jane Doe",
  title: "CTO",
  company: "Acme",
  companyHost: "acme.io",
  sourceUrl: "https://acme.io/team",
  note: null,
  origin: "web",
  verdict: null,
  checkId: null,
  createdAt: "2026-10-02T00:00:00.000Z",
};

function stream(events: RadarEvent[]): Response {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + 11));
      offset += 11;
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function finished(leads: RadarLead[], answer: string): RadarEvent[] {
  return [
    { type: "status", stage: "thinking" },
    { type: "tool", phase: "start", name: "read_site", summary: "Reading acme.io", callId: "c1" },
    ...(leads.length ? [{ type: "leads", leads } as RadarEvent] : []),
    { type: "assistant_message", message: { id: "msg_1", role: "assistant", content: answer, metadata: null, createdAt: "x" } },
    { type: "done" },
  ];
}

async function connect(handler: (method: string, url: string, body: unknown) => Response) {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = { method: init?.method ?? "GET", url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(request);
    if (request.method === "POST" && request.url.endsWith("/v1/radar/chats")) {
      return new Response(JSON.stringify({ chat: { id: "rch_new", name: "New search", createdAt: "x", updatedAt: "x" } }), { status: 201 });
    }
    return handler(request.method, request.url, request.body);
  }) as typeof fetch;
  const server = createServer(new StormGTM({ apiKey: "sgtm_live_test", baseUrl: "https://api.test", fetch: fetchImpl }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, requests };
}

const text = (result: Record<string, unknown>) => (result.content as Array<{ text: string }>)[0]!.text;

test("find_leads runs a search and returns a summary plus structured leads", async () => {
  const { client, requests } = await connect(() => stream(finished([lead], "Jane runs engineering at Acme.")));
  const result = await client.callTool({ name: "find_leads", arguments: { request: "https://acme.io" } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.url}`),
    ["POST https://api.test/v1/radar/chats", "POST https://api.test/v1/radar/chats/rch_new/message"],
  );
  assert.deepEqual(requests[1]!.body, { content: "https://acme.io" });
  assert.match(text(result), /^Found 1 new lead \(chat rch_new\)\.\njane@acme\.io {2}Jane Doe · CTO · Acme\n/);
  assert.match(text(result), /Jane runs engineering at Acme\./);
  assert.match(text(result), /qualify_radar_leads/);
  assert.deepEqual(result.structuredContent, { chatId: "rch_new", answer: "Jane runs engineering at Acme.", leads: [lead] });
});

test("find_leads continues a chat and reports when nobody was found", async () => {
  const { client, requests } = await connect(() => stream(finished([], "No public emails on that site.")));
  const result = await client.callTool({ name: "find_leads", arguments: { request: "founders of dev tools startups", chatId: "rch_7" } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "https://api.test/v1/radar/chats/rch_7/message");
  assert.match(text(result), /^Found 0 new leads \(chat rch_7\)\./);
  assert.deepEqual((result.structuredContent as { leads: unknown[] }).leads, []);
});

test("find_leads turns a stream error and a 402 into tool errors", async () => {
  const failing = await connect(() => stream([{ type: "error", message: "Something went wrong while searching. Try again.", kind: "run_failed" }]));
  const failed = await failing.client.callTool({ name: "find_leads", arguments: { request: "acme.io", chatId: "rch_1" } });
  assert.equal(failed.isError, true);
  assert.match(text(failed), /run_failed/);

  const broke = await connect(() => new Response(JSON.stringify({ error: { code: "insufficient_credits", message: "Finding leads needs credits; balance is 0" } }), { status: 402 }));
  const credits = await broke.client.callTool({ name: "find_leads", arguments: { request: "acme.io", chatId: "rch_1" } });
  assert.equal(credits.isError, true);
  assert.match(text(credits), /insufficient_credits/);
  assert.match(text(credits), /Top up/);
});

test("list_radar_leads and qualify_radar_leads call the Radar routes", async () => {
  const { client, requests } = await connect((_method, url) => {
    if (url.includes("/qualify")) return new Response(JSON.stringify({ leads: [{ ...lead, verdict: "deliverable", checkId: "chk_1" }], remaining: 2 }));
    return new Response(JSON.stringify({ leads: [{ ...lead, verdict: "risky" }] }));
  });
  const listed = await client.callTool({ name: "list_radar_leads", arguments: { chatId: "rch_new" } });
  assert.equal(requests[0]!.url, "https://api.test/v1/radar/leads?chatId=rch_new");
  assert.equal(text(listed), "rld_1 jane@acme.io  Jane Doe · CTO · Acme [risky]");

  const qualified = await client.callTool({ name: "qualify_radar_leads", arguments: { ids: ["rld_1", "rld_2", "rld_3"], tier: "deep" } });
  assert.deepEqual(requests[1], { method: "POST", url: "https://api.test/v1/radar/leads/qualify", body: { ids: ["rld_1", "rld_2", "rld_3"], tier: "deep" } });
  assert.match(text(qualified), /^rld_1 jane@acme\.io: deliverable\n2 not checked yet/);
  assert.equal((qualified.structuredContent as { remaining: number }).remaining, 2);
});

test("instructions send agents from Radar through qualification before sending", () => {
  assert.match(INSTRUCTIONS, /find_leads/);
  assert.match(INSTRUCTIONS, /qualify_radar_leads/);
  assert.match(INSTRUCTIONS, /list_radar_leads/);
  assert.match(INSTRUCTIONS, /send only to the ones that come back "deliverable"/);
  assert.match(INSTRUCTIONS, /cursor is account-wide; if you filter with chatId, use the same chatId on every page and next run/);
});

test("add_leads saves the user's own leads and reports duplicates and rejections", async () => {
  const { client, requests } = await connect(() =>
    new Response(JSON.stringify({ leads: [{ ...lead, origin: "manual" }], duplicates: ["bo@acme.io"], rejected: [{ index: 2, code: "invalid_email", message: "Not a valid email address" }] }), { status: 201 }),
  );
  const result = await client.callTool({ name: "add_leads", arguments: { leads: [{ email: "jane@acme.io", name: "Jane Doe" }, { email: "bo@acme.io" }, { email: "nope" }] } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), ["POST https://api.test/v1/radar/leads"]);
  assert.deepEqual(requests[0]!.body, { leads: [{ email: "jane@acme.io", name: "Jane Doe" }, { email: "bo@acme.io" }, { email: "nope" }] });
  assert.match(text(result), /^Added 1 lead, free\.\nrld_1 jane@acme\.io {2}Jane Doe · CTO · Acme\nAlready saved: bo@acme\.io\nRejected nope: Not a valid email address/);
});

test("no Leadsforge tool is offered, and the tool descriptions and instructions never mention it", async () => {
  const { client } = await connect(() => new Response("{}"));
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name).filter((name) => /leadsforge/i.test(name)), []);
  assert.doesNotMatch(JSON.stringify(tools), /leadsforge/i);
  assert.doesNotMatch(client.getInstructions() ?? "", /leadsforge/i);
  assert.equal((await client.callTool({ name: "connect_leadsforge", arguments: { apiKey: "lf_live_key_1234" } })).isError, true);
});

test("list_radar_leads with after takes only new leads and returns the next cursor", async () => {
  const { client, requests } = await connect((_method, url) => new Response(JSON.stringify(url.includes("after=0") ? { leads: [lead], nextAfter: "1.rld_1" } : { leads: [], nextAfter: "1.rld_1" })));
  const first = await client.callTool({ name: "list_radar_leads", arguments: { after: "0", limit: 50 } });
  assert.equal(requests[0]!.url, "https://api.test/v1/radar/leads?after=0&limit=50");
  assert.equal(text(first), "rld_1 jane@acme.io  Jane Doe · CTO · Acme\nnextAfter: 1.rld_1");
  assert.equal((first.structuredContent as { nextAfter: string }).nextAfter, "1.rld_1");
  const idle = await client.callTool({ name: "list_radar_leads", arguments: { after: "1.rld_1" } });
  assert.equal(text(idle), "No new leads.\nnextAfter: 1.rld_1");
  const tools = await client.listTools();
  const listTool = tools.tools.find((tool) => tool.name === "list_radar_leads");
  assert.match(listTool?.description ?? "", /cursor is account-wide.*same chatId for every page and next run/);
});

test("list_radar_leads marks leads the user added, and leads saved from Leadsforge before it was removed still list", async () => {
  const { client } = await connect(() => new Response(JSON.stringify({ leads: [lead, { ...lead, id: "rld_2", email: "cto@initech.io", origin: "leadsforge" }, { ...lead, id: "rld_3", email: "me@acme.io", origin: "manual" }] })));
  const result = await client.callTool({ name: "list_radar_leads", arguments: {} });
  assert.deepEqual(text(result).split("\n"), ["rld_1 jane@acme.io  Jane Doe · CTO · Acme", "rld_2 cto@initech.io  Jane Doe · CTO · Acme", "rld_3 me@acme.io  Jane Doe · CTO · Acme (manual)"]);
  assert.deepEqual((result.structuredContent as { leads: Array<{ origin: string }> }).leads.map((entry) => entry.origin), ["web", "leadsforge", "manual"]);
});
