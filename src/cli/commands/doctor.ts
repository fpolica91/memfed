import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { Command } from "commander";
import pc from "picocolors";
import { getPaths, isInitialized, loadConfig } from "../../core/config.js";
import { openDb } from "../../core/db.js";
import { IndexDb } from "../../core/index-db.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  hard: boolean;
}

function has(cmd: string): string | undefined {
  try {
    return execFileSync("which", [cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("diagnose the memfed installation and tool integrations")
    .action(async () => {
      const checks: Check[] = [];
      const paths = getPaths();

      // Runtime
      const isBun = Boolean(process.versions.bun);
      const nodeVersion = process.versions.node;
      const [major, minor] = nodeVersion.split(".").map(Number);
      const nodeOk = isBun || (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 13);
      checks.push({
        name: "runtime",
        ok: nodeOk,
        detail: isBun ? `bun ${process.versions.bun}` : `node ${nodeVersion} (need >=22.13)`,
        hard: true,
      });

      // SQLite driver + FTS5
      try {
        const db = await openDb(":memory:");
        db.exec("CREATE VIRTUAL TABLE t USING fts5(x)");
        db.exec("INSERT INTO t (x) VALUES ('probe')");
        const row = db.prepare("SELECT count(*) AS n FROM t WHERE t MATCH 'probe'").get();
        db.close();
        checks.push({
          name: "sqlite+fts5",
          ok: Number(row?.n) === 1,
          detail: isBun ? "bun:sqlite" : "node:sqlite",
          hard: true,
        });
      } catch (e) {
        checks.push({ name: "sqlite+fts5", ok: false, detail: (e as Error).message, hard: true });
      }

      // git
      const gitPath = has("git");
      let gitDetail = "not found on PATH";
      let gitOk = false;
      if (gitPath) {
        try {
          const name = execFileSync("git", ["config", "user.name"], { encoding: "utf8" }).trim();
          const email = execFileSync("git", ["config", "user.email"], { encoding: "utf8" }).trim();
          gitOk = Boolean(name && email);
          gitDetail = gitOk ? `${name} <${email}>` : "user.name/user.email not set";
        } catch {
          gitDetail = "user.name/user.email not set";
        }
      }
      checks.push({ name: "git identity", ok: gitOk, detail: gitDetail, hard: true });

      // Home / init state
      if (isInitialized(paths)) {
        let detail = paths.home;
        let ok = true;
        try {
          const mode = statSync(paths.home).mode & 0o777;
          if (mode !== 0o700) {
            detail = `${paths.home} (mode ${mode.toString(8)}, want 700)`;
            ok = false;
          }
          loadConfig(paths);
          const index = await IndexDb.open(paths.indexPath);
          const n = index.idsForSource().length;
          index.close();
          detail += ` — ${n} indexed record(s)`;
        } catch (e) {
          ok = false;
          detail = (e as Error).message;
        }
        checks.push({ name: "store", ok, detail, hard: false });
      } else {
        checks.push({
          name: "store",
          ok: false,
          detail: `not initialized (run 'memfed init')`,
          hard: false,
        });
      }

      // Assistants on PATH
      for (const tool of ["claude", "codex", "crush", "gh"] as const) {
        const p = has(tool);
        checks.push({
          name: tool,
          ok: Boolean(p),
          detail: p ?? "not on PATH (integration unavailable)",
          hard: false,
        });
      }

      let hardFailure = false;
      for (const c of checks) {
        const mark = c.ok ? pc.green("ok") : c.hard ? pc.red("FAIL") : pc.yellow("--");
        console.log(`${mark.padEnd(6)} ${c.name.padEnd(14)} ${pc.dim(c.detail)}`);
        if (!c.ok && c.hard) hardFailure = true;
      }
      if (hardFailure) process.exitCode = 1;
    });
}
