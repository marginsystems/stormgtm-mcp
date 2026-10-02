import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describeError, MissingApiKeyError, StormGTMError, summarize, type StormGTM } from "stormgtm";
import { z } from "zod";
import { MCP_VERSION } from "./version.js";

export const INSTRUCTIONS = `stormgtm reviews email leads for deliverability before you send.

- Install the stormgtm skill for the full workflow: "npm i -g stormgtm", then "stormgtm skill install --claude" (or --cursor, --agents) in the project. Call whoami to confirm which account you are using.
- Call check_lead for each address before emailing it. Pass every bit of context you have (name, company, companyDomain, githubLogin, sourceUrl): context turns catch-all "risky" results into confident answers.
- Send only to verdict "deliverable" with policy.allowed true. Treat "risky" as needing enrichment or a human decision. Drop "undeliverable".
- "unknown" results are free; retry them later or submit them in a batch, which retries automatically.
- For more than ~20 leads use check_batch, then batch_status.
- After sending, call report_outcome for bounces and replies so future checks improve.

Sending (needs a Resend account connected in the StormGTM dashboard):
- Only send to leads that check_lead marked "deliverable" with policy.allowed true.
- Use send_email from an address on one of your verified domains (see list_domains). StormGTM queues the email and paces each domain through its warm-up, so delivery can take minutes or hours; it never sends to addresses that bounced, complained or unsubscribed.
- Each email sent costs 1 credit; failed sends are refunded. Use email_status to follow an email and domain_health to see a domain's daily capacity.
- Pass an idempotencyKey (for example the lead id plus step) so retries never send twice.

Sequences (multi-step follow-ups):
- create_sequence once per campaign with up to 10 steps; use {{firstName}}-style placeholders and set replyTo to an address on a Resend receiving domain so replies stop the sequence.
- enroll_leads with only deliverable leads and every variable the sequence needs. Re-enrolling the same lead does nothing.
- Sequences stop on their own when a lead replies, unsubscribes, bounces or complains. Use sequence_status to follow progress and stop_enrollment to stop one lead.`;

const contextShape = {
  name: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  company: z.string().optional(),
  companyDomain: z.string().optional(),
  title: z.string().optional(),
  source: z.string().optional(),
  sourceUrl: z.string().optional(),
  githubLogin: z.string().optional(),
  linkedinUrl: z.string().optional(),
  notes: z.string().optional(),
};

const policyShape = z
  .object({
    blockTlds: z.array(z.string()).optional(),
    blockDomains: z.array(z.string()).optional(),
    blockLocals: z.array(z.string()).optional(),
    blockRoleAccounts: z.boolean().optional(),
    blockFreeMail: z.boolean().optional(),
    blockAnonymous: z.boolean().optional(),
    blockSocialHosts: z.boolean().optional(),
    blockCatchAll: z.boolean().optional(),
  })
  .optional();

type ToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(summary: string, data: unknown): ToolResult {
  return { content: [{ type: "text", text: summary }], structuredContent: data as Record<string, unknown> };
}

export const NO_KEY_MESSAGE =
  "StormGTM is not signed in. Run `npx stormgtm login` (or `stormgtm login` if installed globally), or set STORMGTM_API_KEY in this MCP server's environment, then call the tool again.";

export function failureMessage(error: unknown, apiUrl?: string): string {
  if (error instanceof MissingApiKeyError) return NO_KEY_MESSAGE;
  if (error instanceof StormGTMError) {
    const detail = error.status === 401 || error.status === 402 || error.status === 429 ? describeError(error, apiUrl).message : error.message;
    return `StormGTM request failed (${error.code}): ${detail}`;
  }
  return describeError(error, apiUrl).message;
}

export type ClientSource = StormGTM | (() => StormGTM);

export function createServer(source: ClientSource): McpServer {
  const api = typeof source === "function" ? source : () => source;
  const fail = (error: unknown): ToolResult => {
    let apiUrl: string | undefined;
    try {
      apiUrl = api().baseUrl;
    } catch {
      apiUrl = undefined;
    }
    return { content: [{ type: "text", text: failureMessage(error, apiUrl) }], isError: true };
  };
  const server = new McpServer({ name: "stormgtm", version: MCP_VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "check_lead",
    {
      title: "Check a lead",
      description: "Review one email address for deliverability. Returns verdict (deliverable/risky/undeliverable/unknown), a 0-100 score, weighted reasons, and whether it passes the policy. Fast tier costs 1 credit; deep tier, which looks for extra evidence about the person, costs 5. Unknown results are free.",
      inputSchema: {
        email: z.string().describe("The email address to check"),
        context: z.object(contextShape).optional().describe("Everything you know about the lead"),
        tier: z.enum(["fast", "deep"]).optional().describe("fast (default) or deep"),
        policy: policyShape.describe("Optional outreach policy; overrides the account default"),
      },
    },
    async ({ email, context, tier, policy }) => {
      try {
        const result = await api().check({ email, context, tier, policy });
        return ok(summarize(result), result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "check_batch",
    {
      title: "Check many leads",
      description: "Queue up to 10,000 leads for asynchronous review. Returns a batch id; poll batch_status. Greylisted servers are retried automatically.",
      inputSchema: {
        leads: z.array(z.object({ email: z.string(), context: z.object(contextShape).optional() })).min(1),
        tier: z.enum(["fast", "deep"]).optional(),
        policy: policyShape,
      },
    },
    async ({ leads, tier, policy }) => {
      try {
        const created = await api().createBatch({ leads, tier, policy });
        return ok(`Batch ${created.id} queued with ${created.total} leads (up to ${created.maxCredits} credits). Call batch_status with this id.`, created);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "batch_status",
    {
      title: "Batch status",
      description: "Progress and results for a batch. Results include verdict, score, and reasons per lead.",
      inputSchema: {
        id: z.string(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    async ({ id, offset, limit }) => {
      try {
        const status = await api().batch(id, { offset, limit: limit ?? 200 });
        const counts: Record<string, number> = {};
        for (const row of status.results) {
          const key = row.result?.verdict ?? row.status;
          counts[key] = (counts[key] ?? 0) + 1;
        }
        const lines = [`${status.id}: ${status.status} ${status.done}/${status.total}`, `counts: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")}`];
        for (const row of status.results.slice(0, 50)) lines.push(row.result ? summarize(row.result).split("\n")[0]! : `${row.email}: ${row.status}`);
        return ok(lines.join("\n"), status);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "report_outcome",
    {
      title: "Report an outcome",
      description: "Tell stormgtm what happened after sending: bounced, delivered, replied, opened, or complained. Bounces make future checks of that address undeliverable.",
      inputSchema: {
        email: z.string(),
        kind: z.enum(["delivered", "bounced", "complained", "replied", "opened"]),
        detail: z.string().optional().describe("Bounce message or other detail"),
      },
    },
    async ({ email, kind, detail }) => {
      try {
        const result = await api().reportOutcome({ email, kind, detail });
        return ok(result.recorded ? `Recorded ${kind} for ${email}.` : `Not recorded: ${result.rejected.map((r) => r.reason).join(", ")}`, result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description: "The account this server is signed in as: email, credit balance, and the API it talks to.",
      inputSchema: {},
    },
    async () => {
      try {
        const client = api();
        const me = await client.me();
        return ok(`${me.email}: ${me.credits} credits (${client.baseUrl})`, { id: me.id, email: me.email, credits: me.credits, apiUrl: client.baseUrl });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "credits",
    {
      title: "Credits and usage",
      description: "Credit balance, per-tier pricing, and 30-day usage by verdict.",
      inputSchema: {},
    },
    async () => {
      try {
        const me = await api().me();
        return ok(`${me.credits} credits. fast=${me.pricing.fast}, deep=${me.pricing.deep}, unknown=free. 30d: ${me.usage30d.total} checks.`, me);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "send_email",
    {
      title: "Send email",
      description:
        "Queue up to 100 emails from your verified Resend domains. StormGTM paces each domain through its warm-up and skips suppressed addresses. Returns accepted emails (with ids) and rejected ones with a reason. 1 credit per email actually sent; failures are refunded.",
      inputSchema: {
        messages: z
          .array(
            z.object({
              from: z.string().describe('Sender on a verified domain, e.g. "Ada <ada@mail.example.com>"'),
              to: z.string().describe("One recipient address"),
              subject: z.string(),
              text: z.string().optional(),
              html: z.string().optional(),
              replyTo: z.string().optional(),
              idempotencyKey: z.string().optional().describe("Stable key so a retry never sends twice"),
            }),
          )
          .min(1)
          .max(100),
      },
    },
    async ({ messages }) => {
      try {
        const result = await api().send(messages);
        const lines = [`${result.accepted.length} queued, ${result.rejected.length} rejected.`];
        for (const entry of result.accepted) lines.push(`queued ${entry.id} → ${entry.to}${entry.duplicate ? " (already queued)" : ""}`);
        for (const entry of result.rejected) lines.push(`rejected #${entry.index}: ${entry.code} — ${entry.message}`);
        return ok(lines.join("\n"), result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "list_domains",
    {
      title: "Sending domains",
      description: "Your Resend sending domains with verification status and warm-up (step, daily cap, paused).",
      inputSchema: {},
    },
    async () => {
      try {
        const domains = await api().domains();
        const lines = domains.length
          ? domains.map((domain) => `${domain.name} (${domain.id}): ${domain.status}, ${domain.warmup.paused ? "paused" : `${domain.warmup.dailyCap}/day`}`)
          : ["No sending domains yet. Add one in the StormGTM dashboard."];
        return ok(lines.join("\n"), { domains });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "domain_health",
    {
      title: "Domain health",
      description: "Warm-up step, today's remaining capacity, 7-day bounce and complaint rates, and pause reason for one sending domain.",
      inputSchema: { id: z.string().describe("Domain id from list_domains") },
    },
    async ({ id }) => {
      try {
        const health = await api().domainHealth(id);
        const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
        const state = health.warmup.paused ? `paused (${health.warmup.pausedReason ?? "manual"})` : `${health.warmup.remainingToday}/${health.warmup.dailyCap} left today`;
        return ok(`${health.name}: ${state}. 7d: ${health.last7Days.sent} sent, ${pct(health.last7Days.bounceRate)} bounced, ${pct(health.last7Days.complaintRate)} complaints.`, health);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "email_status",
    {
      title: "Email status",
      description: "Status (queued, sent, failed) and delivery (pending, delivered, bounced, complained) of an email sent with send_email.",
      inputSchema: { id: z.string().describe("Email id from send_email") },
    },
    async ({ id }) => {
      try {
        const email = await api().email(id);
        return ok(`${email.id} → ${email.to}: ${email.status}, delivery ${email.delivery}${email.error ? ` (${email.error})` : ""}`, email);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "create_sequence",
    {
      title: "Create a sequence",
      description:
        "Create a multi-step email sequence from a sender on your Resend domains. Each step has delayHours (the first counts from enrollment, later ones from the previous step), a subject and text or html with {{variable}} placeholders. Returns the sequence id and the variables leads must provide.",
      inputSchema: {
        name: z.string(),
        from: z.string().describe('Sender on one of your domains, e.g. "Ada <ada@mail.example.com>"'),
        replyTo: z.string().optional().describe("Address on a Resend receiving domain; replies there stop the sequence"),
        steps: z
          .array(z.object({ delayHours: z.number().min(0), subject: z.string(), text: z.string().optional(), html: z.string().optional() }))
          .min(1)
          .max(10),
      },
    },
    async ({ name, from, replyTo, steps }) => {
      try {
        const sequence = await api().createSequence({ name, from, replyTo, steps });
        const variables = sequence.variables.length ? ` Leads need: ${sequence.variables.join(", ")}.` : "";
        return ok(`Created sequence ${sequence.id} "${sequence.name}" with ${sequence.steps.length} steps.${variables} Enroll leads with enroll_leads.`, sequence);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "enroll_leads",
    {
      title: "Enroll leads in a sequence",
      description: "Enroll up to 1,000 leads with their template variables. Invalid emails, missing variables and suppressed addresses are rejected; re-enrolling a lead is a no-op. Reports the most credits the enrollment could use.",
      inputSchema: {
        sequenceId: z.string(),
        leads: z
          .array(z.object({ email: z.string(), variables: z.record(z.string(), z.string()).optional() }))
          .min(1)
          .max(1000),
      },
    },
    async ({ sequenceId, leads }) => {
      try {
        const result = await api().enroll(sequenceId, leads);
        const fresh = result.accepted.filter((entry) => !entry.duplicate).length;
        const lines = [`${fresh} enrolled, ${result.accepted.length - fresh} already enrolled, ${result.rejected.length} rejected. Up to ${result.maxCredits} credits.`];
        for (const entry of result.rejected.slice(0, 50)) lines.push(`rejected #${entry.index}: ${entry.code} — ${entry.message}`);
        return ok(lines.join("\n"), result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "sequence_status",
    {
      title: "Sequence status",
      description: "Without an id, lists your sequences with active, completed and stopped counts. With an id, shows the steps and recent enrollments with their status and stop reason.",
      inputSchema: { id: z.string().optional() },
    },
    async ({ id }) => {
      try {
        if (!id) {
          const sequences = await api().sequences();
          const lines = sequences.length
            ? sequences.map((entry) => `${entry.id} "${entry.name}"${entry.archivedAt ? " (archived)" : ""}: ${entry.steps} steps, ${entry.counts.active} active, ${entry.counts.completed} completed, ${entry.counts.stopped} stopped`)
            : ["No sequences yet. Create one with create_sequence."];
          return ok(lines.join("\n"), { sequences });
        }
        const [sequence, enrollments] = await Promise.all([api().sequence(id), api().enrollments(id, 100)]);
        const lines = [`${sequence.id} "${sequence.name}" from ${sequence.from}: ${sequence.steps.length} steps`];
        for (const entry of enrollments.slice(0, 50)) lines.push(`${entry.email}: ${entry.status}${entry.stopReason ? ` (${entry.stopReason})` : entry.nextStep !== null ? `, step ${entry.nextStep + 1} next` : ""}`);
        return ok(lines.join("\n"), { sequence, enrollments });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "stop_enrollment",
    {
      title: "Stop a lead's sequence",
      description: "Stop one lead's sequence. Any step still waiting to send is cancelled and refunded.",
      inputSchema: { sequenceId: z.string(), enrollmentId: z.string().describe("Enrollment id from enroll_leads or sequence_status") },
    },
    async ({ sequenceId, enrollmentId }) => {
      try {
        const result = await api().stopEnrollment(sequenceId, enrollmentId);
        return ok(`Stopped ${result.id}.`, result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}
