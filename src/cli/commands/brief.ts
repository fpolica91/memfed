import type { Command } from "commander";
import { quarantineSet, resolveAuthor } from "../../core/config.js";
import { findProjectMarker } from "../../core/project.js";
import { composeBrief } from "../../git/presence.js";
import { loadSpace, type Space } from "../../git/space.js";
import { type Ctx, openCtx, parseCsv } from "../util.js";

export function registerBriefCommand(program: Command): void {
  program
    .command("brief")
    .description("session-start brief: teammate activity in your areas + recent team records")
    .option("--project <slug>", "project slug (default: .memfed.yaml discovery)")
    .option("--paths <globs>", "your active areas, for overlap detection (comma-separated)")
    .action(async (opts) => {
      const ctx: Ctx = await openCtx();
      try {
        const marker = findProjectMarker(process.cwd());
        const project = opts.project ?? marker?.slug;
        const spaceNames =
          marker && marker.spaces.length > 0 ? marker.spaces : Object.keys(ctx.config.spaces);
        const spaces = spaceNames
          .map((name) => {
            try {
              return loadSpace(ctx.paths, ctx.config, name);
            } catch {
              return undefined;
            }
          })
          .filter((s): s is Space => Boolean(s));
        console.log(
          composeBrief({
            index: ctx.index,
            spaces,
            selfEmail: resolveAuthor(ctx.config),
            project,
            paths: parseCsv(opts.paths),
            quarantined: quarantineSet(ctx.paths),
            pendingProposals: ctx.index.listProposals("proposed").length,
          }),
        );
      } finally {
        ctx.close();
      }
    });
}
