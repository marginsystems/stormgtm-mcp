import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { clientFromEnv } from "stormgtm";
import { createServer } from "./server.js";

const server = createServer(clientFromEnv());
await server.connect(new StdioServerTransport());
