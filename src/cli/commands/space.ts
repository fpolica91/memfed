import { basename } from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { addSpace, getPin, initSpace, loadSpace, reindexSpace } from "../../git/space.js";
import { type Ctx, openCtx } from "../util.js";

function deriveName(url: string): string {
  return basename(url)
    .replace(/\.git$/, "")
    .toLowerCase();
}

async function withCtx<T>(fn: (ctx: Ctx) => Promise<T> | T): Promise<T> {
  const ctx = await openCtx();
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

export function registerSpaceCommands(program: Command): void {
  const space = program.command("space").description("manage spaces (git repos of shared records)");

  space
    .command("init <url>")
    .description("create a brand-new space and push its layout to an empty remote")
    .option("--name <name>", "space name (default: derived from URL)")
    .option("--kind <kind>", "project|team|org", "team")
    .option("--policy <policy>", "publish policy: direct|pr (org default: pr)")
    .option("--description <text>")
    .action(async (url, opts) => {
      await withCtx((ctx) => {
        const s = initSpace(ctx.paths, ctx.config, {
          url,
          name: opts.name ?? deriveName(url),
          kind: opts.kind,
          policy: opts.policy,
          description: opts.description,
        });
        console.log(
          `${pc.green("created space")} ${pc.bold(s.name)} (${s.manifest.kind}, publish=${s.manifest.publish})`,
        );
        console.log(pc.dim(`clone: ${s.dir}\nteammates join with: memfed space add ${url}`));
      });
    });

  space
    .command("add <url>")
    .description("join an existing space by cloning it")
    .option("--name <name>", "local alias (default: the space's manifest name)")
    .action(async (url, opts) => {
      await withCtx((ctx) => {
        const s = addSpace(ctx.paths, ctx.config, url, opts.name);
        const { count, errors } = reindexSpace(ctx.index, s);
        console.log(
          `${pc.green("joined space")} ${pc.bold(s.name)} (${s.manifest.kind}) — indexed ${count} record(s)`,
        );
        for (const e of errors) console.error(pc.yellow(`  skip ${e.file}: ${e.error}`));
      });
    });

  space
    .command("list")
    .description("list joined spaces")
    .action(async () => {
      await withCtx((ctx) => {
        const names = Object.keys(ctx.config.spaces);
        if (names.length === 0) {
          console.log(pc.dim("no spaces — create one with 'memfed space init <git-url>'"));
          return;
        }
        for (const name of names) {
          try {
            const s = loadSpace(ctx.paths, ctx.config, name);
            const n = ctx.index.idsForSource(name).length;
            const pin = getPin(ctx.paths, name);
            console.log(
              `${pc.bold(name.padEnd(16))} ${s.manifest.kind.padEnd(8)} publish=${s.manifest.publish.padEnd(7)} ${n} record(s)  ${pc.dim(s.url)} ${pc.dim(pin ? `@${pin.slice(0, 8)}` : "")}`,
            );
          } catch (e) {
            console.log(`${pc.bold(name.padEnd(16))} ${pc.red((e as Error).message)}`);
          }
        }
      });
    });
}
