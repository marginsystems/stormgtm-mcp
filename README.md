# stormgtm-mcp

Stdio MCP server for [StormGTM](https://stormgtm.com). It lets an agent qualify leads with Barometer before emailing them, then send through your own domains.

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

The server reads `STORMGTM_API_KEY` first, then `~/.stormgtm/config.json` (the same file `stormgtm login` writes). `STORMGTM_API_URL` overrides the API URL (default `https://stormgtm.com`).

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
| `send_email` | Queue up to 100 `messages` (one or many) from a verified domain. Paced through each domain's warm-up. 1 credit per email, refunded on failure |
| `list_domains` | Sending domains with status and daily limit |
| `domain_health` | A domain's daily capacity, 7-day bounce and complaint rates, and pause state |
| `email_status` | Status and delivery state of a sent email |
| `create_sequence` | Create a multi-step follow-up sequence (up to 10 steps, `{{variable}}` placeholders) |
| `enroll_leads` | Enroll checked leads in a sequence with their variables |
| `sequence_status` | List sequences, or show one sequence's steps and enrollments |
| `stop_enrollment` | Stop one lead's sequence; waiting steps are cancelled and refunded |

Send needs a Resend account connected in the StormGTM dashboard. Pass an `idempotencyKey` on each message so a retry never sends twice.

## Source

Public source (MIT): [github.com/marginsystems/stormgtm-mcp](https://github.com/marginsystems/stormgtm-mcp).

```bash
git clone https://github.com/marginsystems/stormgtm-mcp.git
cd stormgtm-mcp
npm install
npm run build
node dist/index.js
```
