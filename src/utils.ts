import { mkdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";

export function getTimestamp(): string {
  // Explicit Asia/Jakarta (WIB, UTC+7) — not system GMT
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  // en-CA gives YYYY-MM-DD, HH:MM:SS
  const parts = fmt.formatToParts(now).reduce((acc: any, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${parts.year}${parts.month}${parts.day}_${parts.hour}${parts.minute}${parts.second}`;
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function resolveOutputDir(outputDir: string, baseDir: string): string {
  if (isAbsolute(outputDir)) return outputDir;
  // handle ./backups
  if (outputDir.startsWith("./") || outputDir.startsWith(".\\")) {
    return resolve(baseDir, outputDir);
  }
  return resolve(baseDir, outputDir);
}

export function prettyBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);
  return `${val.toFixed(i === 0 ? 0 : 2)} ${sizes[i]}`;
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export function getFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function uniqueDir(basePath: string): string {
  if (!existsSync(basePath)) return basePath;
  let i = 1;
  while (existsSync(`${basePath}_${i}`)) i++;
  return `${basePath}_${i}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function getCpuInfo(): { physical: number; logical: number; hyperThreading: boolean } {
  try {
    const { cpus } = require("node:os");
    const all = cpus();
    const logical = all.length;
    // Count unique physical cores by model + core mapping (best effort)
    const cores = new Set(all.map((c: any) => `${c.model}-${c.speed}`));
    // More accurate: count distinct physical id via /proc/cpuinfo not available, fallback to logical/2 if hyper-threading
    const physical = Math.max(1, Math.ceil(logical / 2));
    // Hyper-threading if logical > physical
    return { physical, logical, hyperThreading: logical > physical };
  } catch {
    return { physical: 1, logical: 1, hyperThreading: false };
  }
}

export function getOptimalJobs(): number {
  try {
    const { availableParallelism } = require("node:os");
    if (typeof availableParallelism === "function") {
      return Math.max(1, availableParallelism());
    }
  } catch {}
  try {
    const { cpus } = require("node:os");
    return Math.max(1, cpus().length);
  } catch {
    return 4;
  }
}
