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

  // Resolve outputDir relative to project root
  cfg.outputDir = resolveOutputDir(cfg.outputDir || "./backups", baseDir);

  // Cross-platform: pgBin may be Windows (C:\laragon\...) or Unix (/usr/bin, /opt/homebrew/...)
  // Keep as-is, let db.ts resolve with correct separator and .exe handling per platform.
  // If pgBin is empty or invalid, db.ts will fallback to "pg_dump" in PATH (works on all OS).
  cfg.pgBin = cfg.pgBin?.trim() || "";

  // Defaults
  if (!cfg.jobs) cfg.jobs = 4;

  return cfg;
}

export function getDatabaseNames(cfg: AppConfig): string[] {
  return Object.keys(cfg.databases);
}

export function getRestoreTargetNames(cfg: AppConfig): string[] {
  return Object.keys(cfg.restoreTargets || {});
}
