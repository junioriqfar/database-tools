import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOutputDir } from "./utils.ts";

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  schemas?: string[]; // optional — if omitted, auto-discovered from DB
  includeTables?: string[]; // whitelist: only these tables (--table), e.g. ["public.users","public.orders"]
  excludeTables?: string[]; // blacklist: skip entirely (--exclude-table), e.g. ["public.audit_log"]
  excludeTableData?: string[]; // skip data only (--exclude-table-data), e.g. ["public.history_api"]
}

export interface RestoreTarget extends DatabaseConfig {
  createIfNotExists?: boolean;
}

export interface AppConfig {
  pgBin: string;
  outputDir: string;
  jobs: number | "auto";
  retentionDays?: number;
  databases: Record<string, DatabaseConfig>;
  restoreTargets: Record<string, RestoreTarget>;
}

const CONFIG_FILE = "config.json";

export function loadConfig(): AppConfig {
  const baseDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const configPath = resolve(baseDir, CONFIG_FILE);

  if (!existsSync(configPath)) {
    const examplePath = resolve(baseDir, "config.example.json");
    const hint = existsSync(examplePath) ? ` Copy from ${examplePath} -> ${configPath} and fill credentials.` : "";
    throw new Error(`Config file not found: ${configPath}.${hint}`);
  }

  const raw = readFileSync(configPath, "utf-8");
  const cfg = JSON.parse(raw) as AppConfig;

  // Validate
  if (!cfg.databases || Object.keys(cfg.databases).length === 0) {
    throw new Error("No databases defined in config.json");
  }

  // Security: warn if config.json is not ignored by .gitignore (risk of committing credentials)
  try {
    if (existsSync(resolve(baseDir, ".git"))) {
      const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
      const res = spawnSync("git", ["check-ignore", "-q", configPath], { stdio: "ignore" });
      if (res.status === 1) {
        console.warn(`[warn] config.json is NOT ignored by .gitignore — add "config.json" to .gitignore to avoid committing credentials!`);
      }
      // Also warn about weak default passwords
      for (const [k, db] of Object.entries(cfg.databases)) {
        if (db.password === "CHANGE_ME" || db.password === "password" || db.password.length < 4) {
          console.warn(`[warn] database "${k}" has weak/default password`);
        }
      }
    }
  } catch {}

  // Resolve outputDir relative to project root
  cfg.outputDir = resolveOutputDir(cfg.outputDir || "./backups", baseDir);

  // Cross-platform: pgBin may be Windows (C:\laragon\...) or Unix (/usr/bin, /opt/homebrew/...)
  // Keep as-is, let db.ts resolve with correct separator and .exe handling per platform.
  // If pgBin is empty or invalid, db.ts will fallback to "pg_dump" in PATH (works on all OS).
  cfg.pgBin = cfg.pgBin?.trim() || "";

  // Defaults
  if (!cfg.jobs) cfg.jobs = 4;

  // Normalize per-database table filters: trim, filter empty, ensure arrays
  for (const [k, db] of Object.entries(cfg.databases)) {
    if (db.includeTables && !Array.isArray(db.includeTables)) db.includeTables = [String(db.includeTables)] as any;
    if (db.excludeTables && !Array.isArray(db.excludeTables)) db.excludeTables = [String(db.excludeTables)] as any;
    if (db.excludeTableData && !Array.isArray(db.excludeTableData)) db.excludeTableData = [String(db.excludeTableData)] as any;
    db.includeTables = (db.includeTables || []).map((s: string) => String(s).trim()).filter(Boolean);
    db.excludeTables = (db.excludeTables || []).map((s: string) => String(s).trim()).filter(Boolean);
    db.excludeTableData = (db.excludeTableData || []).map((s: string) => String(s).trim()).filter(Boolean);
    // Validate mutual exclusivity: includeTables whitelist vs exclude
    if (db.includeTables!.length > 0 && (db.excludeTables!.length > 0 || db.excludeTableData!.length > 0)) {
      console.warn(`[warn] database "${k}" has both includeTables and exclude* set — includeTables (--table) will take precedence and exclude* will be ignored`);
    }
  }

  return cfg;
}

export function getDatabaseNames(cfg: AppConfig): string[] {
  return Object.keys(cfg.databases);
}

export function getRestoreTargetNames(cfg: AppConfig): string[] {
  return Object.keys(cfg.restoreTargets || {});
}
