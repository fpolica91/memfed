import type { Command } from "commander";
import { runMcpServer } from "../../mcp/server.js";
import { openCtx } from "../util.js";

export function registerMcpCommand(program: Command): void {
  program
    .command("mcp")
    .description("run the stdio MCP server (register via 'memfed connect <tool>')")
    .action(async () => {
      // stdout carries the MCP protocol from here on — nothing else may print to it.
      const ctx = await openCtx();
      await runMcpServer(ctx);
      // The transport owns the process lifetime; it exits when the client disconnects.
    });
}
