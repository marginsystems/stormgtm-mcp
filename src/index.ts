import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { clientFromEnv, resolveApiKey } from "stormgtm";
import { createServer, NO_KEY_MESSAGE } from "./server.js";

if (!resolveApiKey()) process.stderr.write(`stormgtm-mcp: ${NO_KEY_MESSAGE}\n`);
const server = createServer(() => clientFromEnv());
await server.connect(new StdioServerTransport());
