import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { parseRecord } from "../../core/record.js";
import { scan } from "../../redact/scan.js";
import { CliError } from "../util.js";

/**
 * Space-side CI backstop (RFC §3): re-run the deterministic redaction stages
 * over every record in a space checkout. Runs WITHOUT a memfed home — it lints
 * the checkout it's pointed at, so a bare `npx memfed lint-space` works in CI.
 * The allowlist is the space's own .memfed/lint-allow (ruleId:fingerprint lines).
 */

const STYLE_TITLE_RE = /^(always|never|you must|do not|run |execute |curl |pipe )/i;

export function registerLintCommand(program: Command): void {
  program
    .command("lint-space")
    .description("CI backstop: scan every record in a space checkout for secret-shaped content")
    .option("--dir <path>", "space checkout to lint", ".")
    .action(async (opts) => {
      const dir = resolve(opts.dir);
      const recordsDir = join(dir, "records");
      if (!existsSync(recordsDir))
        throw new CliError(`${dir} is not a memfed space checkout (no records/ directory)`);

      const allowFile = join(dir, ".memfed", "lint-allow");
      const allow = existsSync(allowFile)
        ? readFileSync(allowFile, "utf8")
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith("#"))
            .map((l) => {
              const [ruleId, fingerprint] = l.split(":");
              return { ruleId: ruleId ?? "", fingerprint: fingerprint ?? "" };
            })
        : [];

      let blocks = 0;
      let warns = 0;
      let parseErrors = 0;
      let scanned = 0;
      for (const f of readdirSync(recordsDir)) {
        if (!f.endsWith(".md")) continue;
        const file = join(recordsDir, f);
        const text = readFileSync(file, "utf8");
        scanned++;
        let selfAuthor: string | undefined;
        let title = "";
        try {
          const record = parseRecord(text, file);
          selfAuthor = record.fm.provenance.author;
          title = record.fm.title;
        } catch (e) {
          parseErrors++;
          console.error(`${pc.red("parse")}  ${f}: ${(e as Error).message}`);
          continue;
        }
        const result = scan(text, { selfAuthor, allow });
        for (const finding of result.blocks) {
          blocks++;
          console.error(
            `${pc.red("BLOCK")}  ${f} line ${finding.line}: ${finding.ruleId} ${finding.excerpt} ${pc.dim(`(allow with '${finding.ruleId}:${finding.fingerprint}' in .memfed/lint-allow)`)}`,
          );
        }
        for (const finding of result.warns) {
          warns++;
          console.log(
            `${pc.yellow("warn")}   ${f} line ${finding.line}: ${finding.ruleId} ${finding.excerpt}`,
          );
        }
        // Style lint (T2/T8): titles must be fact-voice, no URLs/code/imperatives.
        if (STYLE_TITLE_RE.test(title) || /https?:\/\//.test(title) || title.includes("`")) {
          warns++;
          console.log(
            `${pc.yellow("style")}  ${f}: title reads as an instruction or carries links/code — records are facts, not directives`,
          );
        }
      }

      console.log(
        `\nlint-space: ${scanned} record(s), ${pc.red(`${blocks} block(s)`)}, ${pc.yellow(`${warns} warning(s)`)}, ${parseErrors} parse error(s)`,
      );
      if (blocks > 0 || parseErrors > 0) process.exitCode = 1;
    });
}
