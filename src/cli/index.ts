import { Command } from "commander";
import pc from "picocolors";
import { suppressSqliteExperimentalWarning } from "../core/db.js";
import { registerBriefCommand } from "./commands/brief.js";
import { registerConnectCommands } from "./commands/connect.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerImportCommands } from "./commands/import.js";
import { registerLifecycleCommands } from "./commands/lifecycle.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerReviewCommands } from "./commands/review.js";
import { registerShareCommands } from "./commands/share.js";
import { registerSpaceCommands } from "./commands/space.js";
import { registerStoreCommands } from "./commands/store.js";
import { registerSyncCommand } from "./commands/sync.js";
import { CliError } from "./util.js";
import { VERSION } from "./version.js";

suppressSqliteExperimentalWarning();

const program = new Command("memfed")
  .description(
    "Federated, privacy-first shared memory for AI coding assistants.\nPrivate by default; published only by explicit, reviewed consent into git-backed spaces.",
  )
  .version(VERSION)
  .configureHelp({ sortSubcommands: false });

registerStoreCommands(program);
registerSpaceCommands(program);
registerShareCommands(program);
registerReviewCommands(program);
registerLifecycleCommands(program);
registerSyncCommand(program);
registerConnectCommands(program);
registerBriefCommand(program);
registerImportCommands(program);
registerMcpCommand(program);
registerDoctorCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(pc.red(`error: ${message}`));
  process.exit(err instanceof CliError ? err.exitCode : 1);
});
