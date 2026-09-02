import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { spawn } from "node:child_process";
import type { DatabaseConfig, RestoreTarget } from "./config.ts";
import { getFileSize, prettyBytes, uniqueDir, getOptimalJobs, getCpuInfo } from "./utils.ts";

export type BackupFormat = "tar" | "custom" | "plain" | "directory";

interface BackupOptions {
  pgBin: string;
  db: DatabaseConfig;
  schemas: string[];
  formats: BackupFormat[];
  outputDir: string;
  jobs: number | "auto";
  timestamp: string;
  onProgress?: (msg: string) => void;
  includeTables?: string[]; // e.g. ["public.users", "public.orders"] -> --table (whitelist)
  excludeTables?: string[]; // e.g. ["public.history_api"] -> --exclude-table
  excludeTableData?: string[]; // e.g. ["public.temp_transaksi"] -> --exclude-table-data
}

interface RestoreOptions {
  pgBin: string;
  target: RestoreTarget;
  dumpFile: string;
  jobs?: number | "auto";
  onProgress?: (msg: string) => void;
}

function getExeName(base: string): string {
  return process.platform === "win32" ? `${base}.exe` : base;
}

function getPgDumpPath(pgBin: string): string {
  if (pgBin) {
    const direct = join(pgBin, getExeName("pg_dump"));
    if (existsSync(direct)) return direct;
  }
  return "pg_dump";
}

function getPgRestorePath(pgBin: string): string {
  if (pgBin) {
    const direct = join(pgBin, getExeName("pg_restore"));
    if (existsSync(direct)) return direct;
  }
  return "pg_restore";
}

function getPsqlPath(pgBin: string): string {
  if (pgBin) {
    const direct = join(pgBin, getExeName("psql"));
    if (existsSync(direct)) return direct;
  }
  return "psql";
}

function buildSchemaArgs(schemas: string[]): string[] {
  if (!schemas || schemas.length === 0) return [];
  return schemas.flatMap((s) => ["--schema", s]);
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function escapeSqlIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

// Track active child for SIGINT cleanup (avoid orphan pg_dump/pg_restore on close)
let activeChild: ReturnType<typeof spawn> | null = null;

// Robust run using node:child_process, not Bun.spawn (avoids segfault on large DB)
async function runWithLog(
  cmd: string[],
  env: Record<string, string>,
  logFile: string,
  onProgress?: (msg: string) => void,
): Promise<number> {
  const { appendFileSync } = await import("node:fs");
  try {
    if (!existsSync(logFile)) {
      // create empty
      const { writeFileSync } = await import("node:fs");
      writeFileSync(logFile, "");
    }
  } catch {}

  return new Promise<number>((resolve) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    activeChild = child;
    const cleanup = () => {
      activeChild = null;
      process.removeListener("SIGINT", sigKill);
      process.removeListener("SIGTERM", sigKill);
    };
    const sigKill = () => {
      try { child.kill("SIGTERM"); } catch {}
      // also kill pg_* siblings for -j parallel (pg_restore forks 10 workers)
      try {
        const { spawnSync } = require("node:child_process");
        spawnSync("pkill", ["-TERM", "-f", "pg_restore"], { stdio: "ignore" });
        spawnSync("pkill", ["-TERM", "-f", "pg_dump"], { stdio: "ignore" });
      } catch {}
    };
    process.once("SIGINT", sigKill);
    process.once("SIGTERM", sigKill);

    const handle = (data: Buffer) => {
      const text = data.toString();
      const lines = text.split("\n");
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        onProgress?.(line);
        try {
          appendFileSync(logFile, line + "\n");
        } catch {}
      }
    };

    child.stdout?.on("data", handle);
    child.stderr?.on("data", handle);

    child.on("error", (err) => {
      cleanup();
      try {
        appendFileSync(logFile, `[spawn error] ${err.message}\n`);
      } catch {}
      onProgress?.(`[spawn error] ${err.message}`);
      resolve(1);
    });

    child.on("close", (code) => {
      cleanup();
      resolve(code ?? 0);
    });
  });
}

export async function testConnection(pgBin: string, db: DatabaseConfig): Promise<boolean> {
  const psql = getPsqlPath(pgBin);
  const env = { PGPASSWORD: db.password };
  const cmd = [psql, "-h", db.host, "-p", String(db.port), "-U", db.username, "-d", db.database, "-c", "SELECT 1;"];
  return new Promise<boolean>((resolve) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

export async function getDatabaseSize(pgBin: string, db: DatabaseConfig): Promise<string> {
  const psql = getPsqlPath(pgBin);
  const env = { PGPASSWORD: db.password };
  const safeDb = escapeSqlLiteral(db.database);
  const cmd = [psql, "-h", db.host, "-p", String(db.port), "-U", db.username, "-d", db.database, "-t", "-c", `SELECT pg_size_pretty(pg_database_size('${safeDb}'));`];
  return new Promise<string>((resolve) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("close", () => resolve(out.trim() || "unknown"));
    child.on("error", () => resolve("unknown"));
  });
}

export async function getTableCount(pgBin: string, db: DatabaseConfig, schema: string = "public"): Promise<number> {
  const psql = getPsqlPath(pgBin);
  const env = { PGPASSWORD: db.password };
  const safeSchema = escapeSqlLiteral(schema);
  const cmd = [psql, "-h", db.host, "-p", String(db.port), "-U", db.username, "-d", db.database, "-t", "-c", `SELECT count(*) FROM information_schema.tables WHERE table_schema='${safeSchema}';`];
  return new Promise<number>((resolve) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("close", () => resolve(parseInt(out.trim() || "0", 10)));
    child.on("error", () => resolve(0));
  });
}

export async function getSchemas(pgBin: string, db: DatabaseConfig): Promise<string[]> {
  const psql = getPsqlPath(pgBin);
  const env = { PGPASSWORD: db.password };
  const cmd = [psql, "-h", db.host, "-p", String(db.port), "-U", db.username, "-d", db.database, "-t", "-A", "-c", `SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg_%' AND schema_name NOT IN ('information_schema') ORDER BY schema_name;`];
  return new Promise<string[]>((resolve) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", () => {}); // ignore
    child.on("close", (code) => {
      if (code !== 0) resolve([]);
      else {
        const schemas = out
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        resolve(schemas);
      }
    });
    child.on("error", () => resolve([]));
  });
}

export async function getTableDataSize(pgBin: string, db: DatabaseConfig, table: string): Promise<number> {
  const psql = getPsqlPath(pgBin);
  const env = { PGPASSWORD: db.password };
  const safeTable = escapeSqlLiteral(table);
  // pg_relation_size = only table data (without indexes), for --exclude-table-data
  const cmd = [psql, "-h", db.host, "-p", String(db.port), "-U", db.username, "-d", db.database, "-t", "-A", "-c", `SELECT pg_relation_size('${safeTable}'::regclass);`];
  return new Promise<number>((resolve) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("close", () => {
      const n = parseInt(out.trim() || "0", 10);
      resolve(isNaN(n) ? 0 : n);
    });
    child.on("error", () => resolve(0));
  });
}

export async function getTableSize(pgBin: string, db: DatabaseConfig, table: string): Promise<number> {
  const psql = getPsqlPath(pgBin);
  const env = { PGPASSWORD: db.password };
  const safeTable = escapeSqlLiteral(table);
  // Use ::regclass to handle schema-qualified names like 'public.users'
  const cmd = [psql, "-h", db.host, "-p", String(db.port), "-U", db.username, "-d", db.database, "-t", "-A", "-c", `SELECT pg_total_relation_size('${safeTable}'::regclass);`];
  return new Promise<number>((resolve) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("close", () => {
      const n = parseInt(out.trim() || "0", 10);
      resolve(isNaN(n) ? 0 : n);
    });
    child.on("error", () => resolve(0));
  });
}

export async function getTablesWithSizes(pgBin: string, db: DatabaseConfig, schemas: string[]): Promise<Map<string, number>> {
  const psql = getPsqlPath(pgBin);
  const env = { PGPASSWORD: db.password };
  const result = new Map<string, number>();
  if (schemas.length === 0) return result;
  const schemaList = schemas.map((s) => `'${escapeSqlLiteral(s)}'`).join(",");
  const cmd = [
    psql,
    "-h",
    db.host,
    "-p",
    String(db.port),
    "-U",
    db.username,
    "-d",
    db.database,
    "-t",
    "-A",
    "-F",
    "|",
    "-c",
    `SELECT schemaname, tablename, pg_total_relation_size(schemaname||'.'||quote_ident(tablename)::regclass) FROM pg_tables WHERE schemaname IN (${schemaList}) ORDER BY schemaname, tablename;`,
  ];
  return new Promise<Map<string, number>>((resolve) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) resolve(result);
      else {
        for (const line of out.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const [sch, tbl, sz] = trimmed.split("|");
          if (sch && tbl) {
            const key = `${sch}.${tbl}`;
            const n = parseInt(sz || "0", 10);
            result.set(key, isNaN(n) ? 0 : n);
          }
        }
        resolve(result);
      }
    });
    child.on("error", () => resolve(result));
  });
}

export async function getRestoreObjectCount(pgBin: string, dumpFile: string): Promise<number> {
  const pgRestore = getPgRestorePath(pgBin);
  if (dumpFile.endsWith(".sql")) return 0;
  return new Promise<number>((resolve) => {
    const child = spawn(pgRestore, ["-l", dumpFile], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) resolve(0);
      else {
        const cnt = out.split("\n").filter((l) => l.trim() && !l.trim().startsWith(";")).length;
        resolve(cnt);
      }
    });
    child.on("error", () => resolve(0));
  });
}

export async function getTables(pgBin: string, db: DatabaseConfig, schema: string): Promise<string[]> {
  const psql = getPsqlPath(pgBin);
  const env = { PGPASSWORD: db.password };
  const safeSchema = escapeSqlLiteral(schema);
  const cmd = [psql, "-h", db.host, "-p", String(db.port), "-U", db.username, "-d", db.database, "-t", "-A", "-c", `SELECT tablename FROM pg_tables WHERE schemaname='${safeSchema}' ORDER BY tablename;`];
  return new Promise<string[]>((resolve) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) resolve([]);
      else {
        const tables = out
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((t) => `${schema}.${t}`);
        resolve(tables);
      }
    });
    child.on("error", () => resolve([]));
  });
}

export function getEffectiveJobs(jobs: number | "auto" | undefined): number {
  if (jobs === "auto" || jobs === undefined || jobs === 0) {
    return getOptimalJobs();
  }
  if (typeof jobs === "number") return Math.max(1, jobs);
  const n = parseInt(String(jobs), 10);
  return isNaN(n) ? getOptimalJobs() : Math.max(1, n);
}

export async function backupDatabase(opts: BackupOptions): Promise<{ files: string[]; log: string; folder: string }> {
  const { pgBin, db, schemas, formats, outputDir, jobs: rawJobs, timestamp, onProgress, includeTables, excludeTables, excludeTableData } = opts;
  const pgDump = getPgDumpPath(pgBin);
  const env = { PGPASSWORD: db.password };
  const jobs = getEffectiveJobs(rawJobs);
  const cpu = getCpuInfo();

  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  // Selalu buat folder dulu: {nama_database}_{timestamp}
  const backupFolder = join(outputDir, `${db.database}_${timestamp}`);
  const finalFolder = uniqueDir(backupFolder);
  mkdirSync(finalFolder, { recursive: true });

  const logFile = join(finalFolder, `backup_${db.database}_${timestamp}.log`);
  const files: string[] = [];

  const { appendFileSync } = await import("node:fs");
  appendFileSync(logFile, `Backup ${db.database} @ ${db.host}:${db.port} - ${timestamp}\n`);
  appendFileSync(logFile, `Folder: ${finalFolder}\n`);
  appendFileSync(logFile, `Schemas: ${schemas.length ? schemas.join(", ") : "all"}\n`);
  appendFileSync(logFile, `Formats: ${formats.join(", ")}\n`);
  appendFileSync(logFile, `Jobs: ${jobs} (logical:${cpu.logical}, physical:${cpu.physical}, HT:${cpu.hyperThreading ? "yes" : "no"})\n`);
  if (includeTables?.length) appendFileSync(logFile, `Include Tables (--table): ${includeTables.join(", ")}\n`);
  if (excludeTables?.length) appendFileSync(logFile, `Exclude Tables: ${excludeTables.join(", ")}\n`);
  if (excludeTableData?.length) appendFileSync(logFile, `Exclude Data: ${excludeTableData.join(", ")}\n`);
  appendFileSync(logFile, `PG_BIN: ${pgDump}\n\n`);

  // includeTables (whitelist) is mutually exclusive with schema filter and exclude
  // pg_dump: -n public + -t public.a dumps ALL in public, so when whitelist is set we skip --schema
  const hasInclude = !!(includeTables && includeTables.length > 0);
  const schemaArgs = hasInclude ? [] : buildSchemaArgs(schemas);
  const includeArgs: string[] = [];
  if (hasInclude) {
    for (const t of includeTables!) includeArgs.push("--table", t);
  }
  const excludeArgs: string[] = [];
  if (!hasInclude) {
    if (excludeTables?.length) {
      for (const t of excludeTables) excludeArgs.push("--exclude-table", t);
    }
    if (excludeTableData?.length) {
      for (const t of excludeTableData) excludeArgs.push("--exclude-table-data", t);
    }
  } else if (excludeTables?.length || excludeTableData?.length) {
    appendFileSync(logFile, `[WARN] includeTables set — ignoring excludeTables/excludeTableData\n`);
  }
  const baseArgs = ["-h", db.host, "-p", String(db.port), "-U", db.username, "-d", db.database, "-v", ...excludeArgs, ...includeArgs];

  for (const fmt of formats) {
    let outPath: string;
    let args: string[] = [...baseArgs, ...schemaArgs];
    switch (fmt) {
      case "tar":
        outPath = join(finalFolder, `${db.database}_${timestamp}.tar`);
        args.push("-F", "t", "-b", "-f", outPath);
        onProgress?.(`[TAR] Dumping to ${basename(outPath)}...`);
        break;
      case "custom":
        outPath = join(finalFolder, `${db.database}_${timestamp}.dump`);
        args.push("-F", "c", "-Z", "6", "-f", outPath);
        onProgress?.(`[CUSTOM] Dumping to ${basename(outPath)} (compressed, fastest)...`);
        break;
      case "plain":
        outPath = join(finalFolder, `${db.database}_${timestamp}.sql`);
        args.push("-F", "p", "--no-owner", "--no-privileges", "-f", outPath);
        onProgress?.(`[PLAIN] Dumping to ${basename(outPath)}...`);
        break;
      case "directory":
        outPath = join(finalFolder, `${db.database}_${timestamp}_dir`);
        if (existsSync(outPath)) {
          outPath = uniqueDir(outPath);
        }
        args.push("-F", "d", "-j", String(jobs), "--no-owner", "--no-privileges", "-f", outPath);
        onProgress?.(`[DIR] Dumping to ${basename(outPath)}/ with ${jobs} jobs (fastest for large DB)...`);
        break;
      default:
        continue;
    }

    const cmd = [pgDump, ...args];
    onProgress?.(`> ${cmd.join(" ")}`);

    const exitCode = await runWithLog(cmd, env, logFile, onProgress);

    // Check for permission denied in log and suggest fix
    let logContent = "";
    try {
      logContent = (await import("node:fs")).readFileSync(logFile, "utf-8");
    } catch {}

    if (logContent.includes("permission denied for relation")) {
      const match = logContent.match(/permission denied for relation ([^\n]+)/);
      const relation = match ? match[1] : "unknown";
      onProgress?.(`[WARN] Permission denied for ${relation} — user ${db.username} lacks SELECT on sequence owned by sari_admin/programmer`);
      onProgress?.(`[HINT] Try: 1) Use superuser postgres, or 2) GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${db.username}, or 3) Exclude with --exclude-table`);
      appendFileSync(logFile, `\n[HINT] Permission denied fix: GRANT SELECT ON SEQUENCE ${relation} TO ${db.username};\n`);
      appendFileSync(logFile, `Or run pg_dump as superuser or add --exclude-table for that relation.\n`);
    }

    if (exitCode !== 0) {
      onProgress?.(`[ERROR] ${fmt} failed with exit ${exitCode} - see ${logFile}`);
      appendFileSync(logFile, `[ERROR] ${fmt} exit ${exitCode}\n`);
      // Don't throw, continue to next format
      continue;
    }

    // Check file exists and size
    let exists = false;
    if (fmt === "directory") {
      exists = existsSync(outPath) && readdirSync(outPath).length > 0;
      if (exists) {
        const getSize = (dir: string): number => {
          try {
            const entries = readdirSync(dir, { withFileTypes: true });
            let sum = 0;
            for (const e of entries) {
              const p = join(dir, e.name);
              if (e.isDirectory()) sum += getSize(p);
              else
                try {
                  sum += statSync(p).size;
                } catch {}
            }
            return sum;
          } catch {
            return 0;
          }
        };
        const size = getSize(outPath);
        if (size === 0) {
          onProgress?.(`[WARN] ${fmt} directory empty (likely permission error): ${outPath}`);
          exists = false;
        } else {
          onProgress?.(`[OK] ${fmt} done: ${basename(outPath)}/ (${prettyBytes(size)})`);
          files.push(outPath);
        }
      }
    } else {
      exists = existsSync(outPath);
      if (exists) {
        const size = getFileSize(outPath);
        if (size === 0) {
          onProgress?.(`[WARN] ${fmt} file is 0 bytes (likely permission error): ${outPath} — check log`);
          // Keep file but warn; don't push 0-byte as success? Push but warn
          // Actually don't push 0-byte as success
          exists = false;
        } else {
          onProgress?.(`[OK] ${fmt} done: ${basename(outPath)} (${prettyBytes(size)})`);
          files.push(outPath);
        }
      }
    }
    if (!exists) {
      onProgress?.(`[WARN] ${fmt} no file created or 0 bytes: ${outPath}`);
      // Clean up 0-byte file
      try {
        if (existsSync(outPath)) {
          const st = statSync(outPath);
          if (!st.isDirectory() && st.size === 0) {
            const { unlinkSync } = await import("node:fs");
            unlinkSync(outPath);
            onProgress?.(`[INFO] Removed 0-byte file: ${basename(outPath)}`);
          }
        }
      } catch {}
    }
  }

  // Jika tidak ada file yang berhasil, tetap kembalikan folder dan log
  return { files, log: logFile, folder: finalFolder };
}

export async function restoreDatabase(opts: RestoreOptions): Promise<void> {
  const { pgBin, target, dumpFile, jobs: rawJobs, onProgress } = opts;
  const env = { PGPASSWORD: target.password };
  const jobs = rawJobs !== undefined ? getEffectiveJobs(rawJobs as any) : getEffectiveJobs(4);
  const cpu = getCpuInfo();
  if (rawJobs !== undefined) {
    onProgress?.(`Restore jobs: ${jobs} (logical:${cpu.logical}, HT:${cpu.hyperThreading ? "yes" : "no"})`);
  }

  const isDirectory = (() => {
    try {
      return statSync(dumpFile).isDirectory();
    } catch {
      return false;
    }
  })();

  const isSql = dumpFile.endsWith(".sql");
  const isTar = dumpFile.endsWith(".tar");
  const isCustom = dumpFile.endsWith(".dump") || dumpFile.endsWith(".custom");

  if (target.createIfNotExists) {
    onProgress?.(`Checking if database ${target.database} exists...`);
    const psql = getPsqlPath(pgBin);
    const safeIdent = escapeSqlIdentifier(target.database);
    const createCmd = [psql, "-h", target.host, "-p", String(target.port), "-U", target.username, "-d", "postgres", "-c", `CREATE DATABASE ${safeIdent};`];
    const exit = await new Promise<number>((resolve) => {
      const child = spawn(createCmd[0]!, createCmd.slice(1), { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stderr = "";
      child.stderr?.on("data", (d) => (stderr += d.toString()));
      child.on("close", (code) => {
        if (stderr.includes("already exists")) {
          onProgress?.(`Database ${target.database} already exists, continuing...`);
          resolve(0);
        } else if (code === 0) {
          onProgress?.(`Created database ${target.database}`);
          resolve(0);
        } else {
          onProgress?.(`Create DB check: ${stderr.trim().slice(0, 200)}`);
          resolve(code ?? 0);
        }
      });
      child.on("error", () => resolve(1));
    });
    // ignore exit, continue
    void exit;
  }

  if (isSql) {
    const psql = getPsqlPath(pgBin);
    const cmd = [psql, "-h", target.host, "-p", String(target.port), "-U", target.username, "-d", target.database, "-f", dumpFile, "-v", "ON_ERROR_STOP=1"];
    onProgress?.(`Restoring SQL via psql: ${basename(dumpFile)} -> ${target.database}`);
    const exit = await runWithLog(cmd, env, `${dumpFile}.restore.log`, onProgress);
    if (exit !== 0) throw new Error(`psql restore failed with ${exit}`);
  } else if (isDirectory || isTar || isCustom) {
    const pgRestore = getPgRestorePath(pgBin);
    const base = [pgRestore, "-h", target.host, "-p", String(target.port), "-U", target.username, "-d", target.database, "-v", "--clean", "--if-exists", "--no-owner", "--no-acl"];
    let cmd: string[];
    if (isDirectory) {
      // Directory + Custom support parallel jobs with hyper-threading
      cmd = [...base, "-j", String(jobs), dumpFile];
      onProgress?.(`Restoring via pg_restore (parallel ${jobs} jobs, HT ${cpu.hyperThreading ? "ON" : "OFF"}): ${basename(dumpFile)} -> ${target.database}`);
    } else if (isCustom) {
      // Custom also supports -j in pg_restore 9.3+
      cmd = [...base, "-j", String(jobs), dumpFile];
      onProgress?.(`Restoring via pg_restore (parallel ${jobs} jobs): ${basename(dumpFile)} -> ${target.database}`);
    } else {
      cmd = [...base, dumpFile];
      onProgress?.(`Restoring via pg_restore: ${basename(dumpFile)} -> ${target.database}`);
    }
    const exit = await runWithLog(cmd, env, `${dumpFile}.restore.log`, onProgress);
    if (exit !== 0) throw new Error(`pg_restore failed with ${exit}`);
  } else {
    throw new Error(`Unknown dump format for file: ${dumpFile}`);
  }
}
