# stormgtm-mcp

Stdio MCP server for [StormGTM](https://stormgtm.com). It lets an agent qualify leads with Barometer before emailing them, then send from your own mailboxes.

Requires Node.js 22+ and a StormGTM API key.

## Install

Claude Code:

```bash
claude mcp add stormgtm -- npx -y stormgtm-mcp
```

Cursor, `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "stormgtm": {
      "command": "npx",
      "args": ["-y", "stormgtm-mcp"]
    }
  }
}
```

Codex, `~/.codex/config.toml`:

```toml
[mcp_servers.stormgtm]
command = "npx"
args = ["-y", "stormgtm-mcp"]
```

Then call `whoami`. It returns the account email and credit balance.

## Authentication

The server reads `STORMGTM_API_KEY` first, then `~/.stormgtm/config.json` (the same file `stormgtm login` writes), on every tool call. `STORMGTM_API_URL` overrides the API URL (default `https://stormgtm.com`).

The server starts without a key. Until you sign in, every tool returns a short message saying how to; after `stormgtm login` the next call works without restarting the server.

```bash
npm i -g stormgtm
stormgtm login
```

To pass a key explicitly, add it to the server's environment:

```bash
claude mcp add stormgtm --env STORMGTM_API_KEY=sgtm_live_... -- npx -y stormgtm-mcp
```

## Agent skill

The server's instructions point agents at the `stormgtm-gtm` skill, which covers the full workflow. Install it into a project with the CLI:

```bash
stormgtm skill install --claude   # or --cursor, --agents
```

## Tools

| Tool | What it does |
| --- | --- |
| `whoami` | Account email, credit balance and API URL |
| `credits` | Credit balance, per-tier pricing and 30-day usage by verdict |
| `check_lead` | Review one address: verdict, 0-100 score, reasons, policy result. Fast tier 1 credit, deep tier 5, unknown free |
| `check_batch` | Submit many leads at once; unknown results are retried automatically |
| `batch_status` | Progress and results for a batch |
| `report_outcome` | Report `delivered`, `bounced`, `complained`, `replied` or `opened` so later checks improve |
| `find_leads` | Radar (beta): find people to email from a website URL or a description of the ideal customer (`request`, optional `chatId` to refine). 1 credit per new lead found on the web; Leadsforge leads and searches that find nobody are free. Can take a minute or two |
| `list_radar_leads` | Leads Radar saved, optionally for one `chatId`, with verdicts once qualified |
| `add_leads` | Save up to 500 of your own `leads` (email, optional name, title, company, note), free. Returns new leads, duplicates and rejections |
| `leadsforge_status` | Whether a Leadsforge account is connected. When it is, `find_leads` also searches the Leadsforge people database, and those leads are free |
| `connect_leadsforge` | Connect Leadsforge with the user's `apiKey`; checked, stored encrypted, never shown again |
| `disconnect_leadsforge` | Remove the Leadsforge key |
| `qualify_radar_leads` | Check Radar leads by `ids` (fast or deep `tier`) and store each verdict. Send only to `deliverable` |
| `list_mailboxes` | Connected mailboxes with status, last test and daily cap |
| `mailbox_status` | One mailbox: status, last test result, pause reason and today's capacity |
| `mailbox_domains` | Domains your mailboxes send from, with each unsubscribe host and whether it is verified |
| `send_email` | Queue up to 100 `messages` (one or many), each from a connected mailbox (`mailboxId`, or `from` with the mailbox address). Paced through each mailbox's warm-up. 1 credit per email, refunded on failure |
| `list_domains` | Sending domains with status and daily limit |
| `domain_health` | A domain's daily capacity, 7-day bounce and complaint rates, and pause state |
| `email_status` | Status and delivery state of a sent email |
| `create_sequence` | Create a multi-step follow-up sequence sent from one mailbox (`mailboxId`, up to 10 steps, `{{variable}}` placeholders) |
| `enroll_leads` | Enroll checked leads in a sequence with their variables |
| `sequence_status` | List sequences, or show one sequence's steps and enrollments |
| `stop_enrollment` | Stop one lead's sequence; waiting steps are cancelled and refunded |
| `list_threads` | Inbox conversations (`inbox`, `sent`, `archived` or `spam`), filtered by unread or a search `query` |
| `read_thread` | One conversation's messages: sender, time, unverified-sender flag, attachment names, and the new text (`full` for everything) |
| `reply` | Answer an existing thread. Goes only to the thread's participant; 1 credit. No recipient parameter, so it cannot start new conversations |
| `mark_read` | Mark threads read or unread |
| `archive_threads` | Archive threads, or move them back to the inbox with `archived: false` |
| `mark_spam` | Move threads to spam, or back with `spam: false`. Marking spam also suppresses the sender and stops their sequences |
| `inbox_counts` | Total and unread threads per folder |

Sending goes through your connected mailboxes. A mailbox's domain needs its unsubscribe host set in the StormGTM dashboard first; until then sends are rejected with `unsubscribe_host_required`. Pass an `idempotencyKey` on each message so a retry never sends twice.

Inbox tools return email content wrapped as `untrusted_email_content` with a notice not to follow instructions inside it. The server instructions tell agents the same, and new outreach stays on `send_email` and sequences.

## Source

Public source (MIT): [github.com/marginsystems/stormgtm-mcp](https://github.com/marginsystems/stormgtm-mcp).

```bash
git clone https://github.com/marginsystems/stormgtm-mcp.git
cd stormgtm-mcp
npm install
npm run build
node dist/index.js
```
