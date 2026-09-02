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
  const logical = (() => {
    try {
      const { cpus } = require("node:os");
      return Math.max(1, cpus().length);
    } catch {
      return 1;
    }
  })();

  const physical = (() => {
    try {
      const { execSync } = require("node:child_process") as typeof import("node:child_process");
      if (process.platform === "linux") {
        // Try nproc --all for logical already, need physical: lscpu or /proc/cpuinfo
        try {
          const out = execSync("lscpu -p 2>/dev/null | grep -v '^#' | cut -d, -f2 | sort -u | wc -l", { encoding: "utf-8" }).trim();
          const n = parseInt(out, 10);
          if (!isNaN(n) && n > 0 && n <= logical) return n;
        } catch {}
        try {
          const { readFileSync } = require("node:fs") as typeof import("node:fs");
          const cpuinfo = readFileSync("/proc/cpuinfo", "utf-8");
          const cores = cpuinfo.match(/^cpu cores\s*:\s*(\d+)/m);
          if (cores) {
            const perSocket = parseInt(cores[1]!, 10);
            const sockets = (cpuinfo.match(/^physical id\s*:/gm) || []).length || 1;
            const ids = new Set((cpuinfo.match(/^physical id\s*:\s*(\d+)/gm) || []).map((s) => s.trim()));
            const socketCount = ids.size || sockets;
            const total = perSocket * socketCount;
            if (!isNaN(total) && total > 0 && total <= logical) return total;
          }
        } catch {}
      }
      if (process.platform === "darwin") {
        try {
          const out = execSync("sysctl -n hw.physicalcpu 2>/dev/null", { encoding: "utf-8" }).trim();
          const n = parseInt(out, 10);
          if (!isNaN(n) && n > 0 && n <= logical) return n;
        } catch {}
      }
      if (process.platform === "win32") {
        try {
          const out = execSync("wmic cpu get NumberOfCores /value 2>nul", { encoding: "utf-8" });
          const m = out.match(/NumberOfCores=(\d+)/);
          if (m) {
            const n = parseInt(m[1]!, 10);
            if (!isNaN(n) && n > 0 && n <= logical) return n;
          }
        } catch {}
        // PowerShell fallback
        try {
          const out = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_Processor).NumberOfCores"', { encoding: "utf-8" }).trim();
          const n = parseInt(out.split(/\s+/)[0]!, 10);
          if (!isNaN(n) && n > 0 && n <= logical) return n;
        } catch {}
      }
    } catch {}
    // Heuristic fallback: assume HT enabled if logical > 1 => physical = ceil(logical/2)
    // For non-HT CPUs logical == physical, heuristic overestimates HT but still safe for -j
    return Math.max(1, Math.ceil(logical / 2));
  })();

  return { physical, logical, hyperThreading: logical > physical };
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

export function renderBar(current: number, total: number, width = 20): string {
  if (total <= 0) return "";
  const ratio = Math.min(1, Math.max(0, current / total));
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const pct = Math.round(ratio * 100);
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return `${bar} ${pct}%`;
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function parseSizeToBytes(sizeStr: string): number {
  // e.g. "132 GB", "60.48 KB", "unknown"
  const m = sizeStr.trim().match(/^([\d.]+)\s*([KMGT]?B)?/i);
  if (!m) return 0;
  const num = parseFloat(m[1]!);
  const unit = (m[2] || "B").toUpperCase();
  const mult: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Math.round(num * (mult[unit] || 1));
}
