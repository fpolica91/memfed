import { existsSync } from "node:fs";
import type { Command } from "commander";
import pc from "picocolors";
import { git } from "../../git/exec.js";
import { loadSpace, spaceDir, type Space } from "../../git/space.js";
import { syncSpace } from "../../git/sync.js";
import { CliError, type Ctx, openCtx } from "../util.js";

/** Load a space, re-cloning if the local checkout is missing (recoverable state). */
export function ensureSpaceClone(ctx: Ctx, name: string): Space {
  const entry = ctx.config.spaces[name];
  if (!entry) throw new CliError(`unknown space '${name}'`);
  const dir = spaceDir(ctx.paths, name);
  if (!existsSync(dir)) {
    console.log(pc.dim(`cloning missing space '${name}' from ${entry.url}…`));
    git(["clone", "-q", entry.url, dir]);
  }
  return loadSpace(ctx.paths, ctx.config, name);
}

export function registerSyncCommand(program: Command): void {
  program
    .command("sync [space]")
    .description("fetch/rebase/push all spaces (or one) and refresh the index")
    .option("--accept-rewrite", "accept a rewritten remote history (TOFU pin update)")
    .action(async (spaceArg, opts) => {
      const ctx = await openCtx();
      try {
        const names = spaceArg ? [spaceArg] : Object.keys(ctx.config.spaces);
        if (names.length === 0) {
          console.log(pc.dim("no spaces to sync"));
          return;
        }
        let failed = false;
        for (const name of names) {
          try {
            const space = ensureSpaceClone(ctx, name);
            const r = syncSpace(ctx, space, { acceptRewrite: opts.acceptRewrite });
            const bits = [
              r.pulled ? `${r.pulled} pulled` : null,
              r.removed ? `${r.removed} removed` : null,
              r.pushed ? "pushed local commits" : null,
            ].filter(Boolean);
            console.log(
              `${pc.green("synced")} ${pc.bold(name)}${bits.length ? ` — ${bits.join(", ")}` : pc.dim(" — up to date")}`,
            );
            for (const e of r.errors) console.error(pc.yellow(`  skip ${e.file}: ${e.error}`));
          } catch (e) {
            failed = true;
            console.error(pc.red(`sync ${name} failed: ${(e as Error).message}`));
          }
        }
        if (failed) process.exitCode = 1;
      } finally {
        ctx.close();
      }
    });
}
