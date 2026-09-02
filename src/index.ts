#!/usr/bin/env bun
import { select, confirm, checkbox } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { loadConfig } from "./config.ts";
import { backupDatabase, restoreDatabase, testConnection, getDatabaseSize, getTableCount, getSchemas, getTables, getEffectiveJobs, getTableSize, getTableDataSize, getTablesWithSizes } from "./db.ts";
import type { BackupFormat } from "./db.ts";
import { prettyBytes, getCpuInfo, getOptimalJobs, renderBar, formatDuration, parseSizeToBytes } from "./utils.ts";
import { ensurePgBinaries, isPgDumpAvailable } from "./pgsql.ts";

function intro(text: string) {
  console.log(chalk.bgCyan.black(` ${text} `));
}
function outro(text: string) {
  console.log(chalk.green(`\n✔ ${text}\n`));
}
function logInfo(msg: string) {
  console.log(chalk.cyan("ℹ"), msg);
}
function logSuccess(msg: string) {
  console.log(chalk.green("✔"), msg);
}
function logWarn(msg: string) {
  console.log(chalk.yellow("⚠"), msg);
}
function logError(msg: string) {
  console.log(chalk.red("✖"), msg);
}

// Handle Ctrl+C / EPIPE gracefully — also kill orphan pg_dump/pg_restore (parity backup/restore)
process.on("SIGINT", () => {
  console.log(chalk.yellow("\nCancelled — stopping pg_dump/pg_restore..."));
  try {
    const { spawnSync } = require("node:child_process");
    spawnSync("pkill", ["-TERM", "-f", "pg_restore"], { stdio: "ignore" });
    spawnSync("pkill", ["-TERM", "-f", "pg_dump"], { stdio: "ignore" });
    spawnSync("pkill", ["-TERM", "-f", "psql"], { stdio: "ignore" });
  } catch {}
  setTimeout(() => process.exit(130), 300);
});
process.on("SIGTERM", () => {
  try {
    const { spawnSync } = require("node:child_process");
    spawnSync("pkill", ["-TERM", "-f", "pg_restore"], { stdio: "ignore" });
    spawnSync("pkill", ["-TERM", "-f", "pg_dump"], { stdio: "ignore" });
  } catch {}
  setTimeout(() => process.exit(143), 300);
});

async function main() {
  console.clear();
  intro("Database Tools");

  let config;
  try {
    config = loadConfig();
  } catch (e: any) {
    logError(`Failed to load config.json: ${e.message}`);
    process.exit(1);
  }

  // Auto-check PostgreSQL binaries on this device (Windows/Linux/macOS)
  // If not found in pgBin nor in PATH, offer to download automatically
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const hasPgDump = isPgDumpAvailable(config.pgBin) || isPgDumpAvailable("");
  if (!hasPgDump) {
    logWarn(`PostgreSQL client (pg_dump) not found on this device (${process.platform} ${process.arch}).`);
    logInfo(`Configured pgBin: ${config.pgBin || "(empty, will use PATH)"}`);
    logInfo(`Local bin: ${projectRoot}/bin/pgsql/bin`);
    let doDownload = false;
    try {
      doDownload = await confirm({
        message: "pg_dump not found. Download PostgreSQL binaries automatically (~80-200MB)?",
        default: true,
      });
    } catch {
      doDownload = false;
    }
    if (doDownload) {
      const dlSpinner = ora("Downloading PostgreSQL binaries...").start();
      try {
        const newPgBin = await ensurePgBinaries(config.pgBin, projectRoot, (msg) => {
          dlSpinner.text = msg;
        });
        dlSpinner.succeed(`PostgreSQL ready at ${newPgBin || "PATH"}`);
        config.pgBin = newPgBin;
        // Optionally save back to config.json for next run
        try {
          const { readFileSync, writeFileSync } = await import("node:fs");
          const cfgPath = resolve(projectRoot, "config.json");
          const cfgRaw = JSON.parse(readFileSync(cfgPath, "utf-8"));
          if (newPgBin && newPgBin !== cfgRaw.pgBin) {
            cfgRaw.pgBin = newPgBin;
            writeFileSync(cfgPath, JSON.stringify(cfgRaw, null, 2) + "\n", "utf-8");
            logInfo(`Updated config.json pgBin to ${newPgBin}`);
          }
        } catch {}
      } catch (e: any) {
        dlSpinner.fail("Download failed");
        logError(e.message);
        logWarn("Please install PostgreSQL client manually:");
        logInfo("  Windows: Laragon (C:\\laragon\\bin\\postgresql) or https://www.postgresql.org/download/windows/");
        logInfo("  macOS: brew install postgresql@16");
        logInfo("  Linux: sudo apt install postgresql-client-16");
        process.exit(1);
      }
    } else {
      logError("pg_dump is required. Install PostgreSQL client and set pgBin in config.json.");
      process.exit(1);
    }
  } else {
    logInfo(`PostgreSQL client found (${process.platform})`);
  }

  let action: string;
  try {
    action = await select({
      message: "What do you want to do?",
      choices: [
        { value: "backup", name: "Backup", description: "Dump database to file" },
        { value: "restore", name: "Restore", description: "Restore from dump file" },
      ],
    });
  } catch (e: any) {
    if (e.name === "ExitPromptError") {
      console.log(chalk.yellow("Cancelled."));
      process.exit(0);
    }
    throw e;
  }

  if (action === "backup") {
    await handleBackup(config);
  } else {
    await handleRestore(config);
  }

  outro("Done!");
}

async function handleBackup(config: ReturnType<typeof loadConfig>) {
  const dbNames = Object.keys(config.databases);
  if (dbNames.length === 0) {
    logError("No databases defined in config.json");
    return;
  }

  let dbKey: string;
  try {
    dbKey = await select({
      message: "Select database to backup:",
      choices: dbNames.map((k) => {
        const db = config.databases[k]!;
        return { value: k, name: `${k} — ${db.database} @ ${db.host}:${db.port} (${db.username})` };
      }),
    });
  } catch {
    console.log(chalk.yellow("Cancelled."));
    return;
  }

  const db = config.databases[dbKey]!;
  const spinner = ora("Testing connection & fetching info...").start();
  const ok = await testConnection(config.pgBin, db);
  if (!ok) {
    spinner.fail("Connection failed — check VPN/host/credentials");
    let cont = false;
    try {
      cont = await confirm({ message: "Continue anyway?", default: false });
    } catch {
      return;
    }
    if (!cont) return;
  } else {
    const size = await getDatabaseSize(config.pgBin, db);
    const count = await getTableCount(config.pgBin, db, "public");
    spinner.succeed(`Connected: ${count} tables, size ${size}`);
  }

  // Hyper-threading info
  const cpu = getCpuInfo();
  const optimalJobs = getOptimalJobs();
  logInfo(`CPU: ${cpu.logical} logical / ${cpu.physical} physical — Hyper-Threading: ${cpu.hyperThreading ? "YES" : "NO"} → optimal jobs: ${optimalJobs}`);
  let jobs: number | "auto" = config.jobs || "auto";
  try {
    const useAuto = await confirm({ message: `Use auto jobs (${optimalJobs}) with hyper-threading?`, default: true });
    if (!useAuto) {
      const customJobs = await select({
        message: "Select jobs (parallel) for directory format:",
        choices: [
          { value: "1", name: "1 — single thread" },
          { value: "2", name: "2 — dual" },
          { value: "4", name: "4 — quad (default)" },
          { value: String(optimalJobs), name: `${optimalJobs} — auto (optimal)` },
          { value: "8", name: "8 — octa (if HT)" },
        ],
      });
      jobs = parseInt(customJobs as string, 10) as any;
    } else {
      jobs = "auto";
    }
  } catch {
    jobs = "auto";
  }

  // Auto-discover schemas from DB — no need for config schemas
  let availableSchemas: string[] = [];
  const discoverSpinner = ora("Discovering schemas from database...").start();
  try {
    const discovered = await getSchemas(config.pgBin, db);
    if (discovered.length > 0) {
      availableSchemas = discovered;
      discoverSpinner.succeed(`Found schemas: ${discovered.join(", ")} (auto-discovered)`);
    } else if (db.schemas && db.schemas.length > 0) {
      availableSchemas = db.schemas;
      discoverSpinner.succeed(`Using schemas from config: ${availableSchemas.join(", ")}`);
    } else {
      availableSchemas = ["public"];
      discoverSpinner.warn(`Auto-discovery failed, using default: ${availableSchemas.join(", ")} (select all for full DB)`);
    }
  } catch {
    if (db.schemas && db.schemas.length > 0) {
      availableSchemas = db.schemas;
      discoverSpinner.succeed(`Using schemas from config: ${availableSchemas.join(", ")}`);
    } else {
      availableSchemas = ["public"];
      discoverSpinner.warn(`Auto-discovery failed, using default: ${availableSchemas.join(", ")}`);
    }
  }

  // If schemas preset in config.json, pre-check only those (e.g. ["public"] -> only public checked)
  const presetSchemas = db.schemas && db.schemas.length > 0 ? db.schemas.map((s) => s.trim()).filter(Boolean) : null;
  if (presetSchemas) {
    logInfo(`Using schemas preset from config.json for "${dbKey}": ${presetSchemas.join(", ")} (pre-checked)`);
  }
  let schemas: string[] = [];
  try {
    schemas = await checkbox({
      message: "Select schemas to backup (space to select, enter to confirm):",
      choices: availableSchemas.map((s) => ({
        value: s,
        name: s,
        checked: presetSchemas ? presetSchemas.includes(s) : true,
      })),
      required: false,
    });
  } catch {
    console.log(chalk.yellow("Cancelled."));
    return;
  }
  const finalSchemas = schemas.length === 0 ? [] : schemas;
  if (presetSchemas) {
    const missing = presetSchemas.filter((s) => !availableSchemas.includes(s));
    if (missing.length) logWarn(`Preset schemas not found in DB: ${missing.join(", ")} (available: ${availableSchemas.join(", ")})`);
  }

  // Table-level selection: respect preset from config.json, else interactive whitelist/blacklist
  let includeTables: string[] = [...(db.includeTables || [])];
  let excludeTables: string[] = [...(db.excludeTables || [])];
  let excludeTableData: string[] = [...(db.excludeTableData || [])];
  const hasPreset = includeTables.length > 0 || excludeTables.length > 0 || excludeTableData.length > 0;

  if (hasPreset) {
    logInfo(`Using table filter from config.json for "${dbKey}":`);
    if (includeTables.length) logInfo(`  includeTables (--table whitelist): ${includeTables.join(", ")}`);
    if (excludeTables.length) logInfo(`  excludeTables (--exclude-table): ${excludeTables.join(", ")}`);
    if (excludeTableData.length) logInfo(`  excludeTableData (--exclude-table-data): ${excludeTableData.join(", ")}`);
    if (includeTables.length && (excludeTables.length || excludeTableData.length)) {
      logWarn(`includeTables takes precedence — exclude* will be ignored (pg_dump --table whitelists)`);
    }
    // Still allow user to override preset interactively if they want
    try {
      const usePreset = await confirm({ message: "Use table filter from config.json?", default: true });
      if (!usePreset) {
        includeTables = [];
        excludeTables = [];
        excludeTableData = [];
        logInfo("Ignoring preset — switching to interactive selection");
        // fall through to interactive
        const tableMode = await select({
          message: "Table selection (backup scope):",
          choices: [
            { value: "all", name: "All tables in selected schemas", description: "Backup semua tabel (default)" },
            { value: "include", name: "Only selected tables", description: "Hanya backup tabel terpilih (--table)" },
            { value: "exclude", name: "Exclude tables entirely", description: "Backup semua kecuali tabel terpilih (--exclude-table)" },
            { value: "exclude-data", name: "Exclude data only", description: "Backup schema saja tanpa data (--exclude-table-data)" },
          ],
        });
        if (tableMode !== "all" && ok) {
          const schemasForTables = finalSchemas.length > 0 ? finalSchemas : availableSchemas;
          const tableSpinner = ora("Fetching tables...").start();
          const allTables: string[] = [];
          for (const sch of schemasForTables) allTables.push(...(await getTables(config.pgBin, db, sch)));
          tableSpinner.succeed(`Found ${allTables.length} tables in ${schemasForTables.join(", ")}`);
          if (allTables.length > 0) {
            const displayTables = allTables.slice(0, 100);
            if (allTables.length > 100) logWarn(`Showing first 100 of ${allTables.length} tables`);
            if (tableMode === "include") includeTables = (await checkbox({ message: "Select tables to BACKUP (whitelist --table):", choices: displayTables.map((t) => ({ value: t, name: t })), required: true })) as string[];
            else if (tableMode === "exclude") excludeTables = (await checkbox({ message: "Select tables to EXCLUDE entirely (--exclude-table):", choices: displayTables.map((t) => ({ value: t, name: t })), required: false })) as string[];
            else if (tableMode === "exclude-data") excludeTableData = (await checkbox({ message: "Select tables to EXCLUDE DATA only (--exclude-table-data):", choices: displayTables.map((t) => ({ value: t, name: t })), required: false })) as string[];
          }
        }
      }
    } catch {
      // keep preset on cancel
    }
  } else if (ok) {
    try {
      const tableMode = await select({
        message: "Table selection (backup scope):",
        choices: [
          { value: "all", name: "All tables in selected schemas", description: "Backup semua tabel (default)" },
          { value: "include", name: "Only selected tables", description: "Hanya backup tabel terpilih (--table)" },
          { value: "exclude", name: "Exclude tables entirely", description: "Backup semua kecuali tabel terpilih (--exclude-table)" },
          { value: "exclude-data", name: "Exclude data only", description: "Backup schema saja tanpa data (--exclude-table-data)" },
        ],
      });
      if (tableMode !== "all") {
        const schemasForTables = finalSchemas.length > 0 ? finalSchemas : availableSchemas;
        if (schemasForTables.length === 0) {
          logWarn("No schemas available for table discovery.");
        } else {
          const tableSpinner = ora("Fetching tables...").start();
          const allTables: string[] = [];
          for (const sch of schemasForTables) {
            const tbls = await getTables(config.pgBin, db, sch);
            allTables.push(...tbls);
          }
          tableSpinner.succeed(`Found ${allTables.length} tables in ${schemasForTables.join(", ")}`);
          if (allTables.length > 0) {
            const displayTables = allTables.slice(0, 100);
            if (allTables.length > 100) {
              logWarn(`Showing first 100 of ${allTables.length} tables (too many to display all). Use includeTables/excludeTables in config if needed.`);
            }
            if (tableMode === "include") {
              const picked = await checkbox({
                message: "Select tables to BACKUP (whitelist --table):",
                choices: displayTables.map((t) => ({ value: t, name: t })),
                required: true,
              });
              includeTables = picked as string[];
              if (includeTables.length === 0) logWarn("No tables selected for include — will backup all.");
            } else if (tableMode === "exclude") {
              const picked = await checkbox({
                message: "Select tables to EXCLUDE entirely (--exclude-table):",
                choices: displayTables.map((t) => ({ value: t, name: t })),
                required: false,
              });
              excludeTables = picked as string[];
            } else if (tableMode === "exclude-data") {
              const picked = await checkbox({
                message: "Select tables to EXCLUDE DATA only (--exclude-table-data):",
                choices: displayTables.map((t) => ({ value: t, name: t })),
                required: false,
              });
              excludeTableData = picked as string[];
            }
          } else {
            logWarn("No tables found for selected schemas.");
          }
        }
      }
    } catch {
      // ignore cancel -> default all
    }
  } else if (!ok) {
    logWarn("Skipping table discovery (no connection). You can still set includeTables/excludeTables manually via config.json.");
    if (hasPreset) logInfo(`Will use preset from config despite no connection: ${[...includeTables, ...excludeTables, ...excludeTableData].join(", ")}`);
  }

  let formats: BackupFormat[] = [];
  try {
    formats = (await checkbox({
      message: "Select backup formats:",
      choices: [
        { value: "tar", name: "tar — compat with disdag_ukm.tar" },
        { value: "custom", name: "custom — fastest, compressed (.dump) - needs pg_restore" },
        { value: "plain", name: "plain — SQL text (.sql) - human readable" },
        { value: "directory", name: "directory — fastest parallel (-Fd -j) for large DB" },
      ],
      required: true,
    })) as BackupFormat[];
  } catch {
    console.log(chalk.yellow("Cancelled."));
    return;
  }

  if (formats.length === 0) {
    // default
    formats = ["tar", "custom"];
  }

  const ts = (() => {
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
    const p = fmt.formatToParts(new Date()).reduce((acc: any, part) => ({ ...acc, [part.type]: part.value }), {});
    return `${p.year}${p.month}${p.day}_${p.hour}${p.minute}${p.second}`;
  })();

  logInfo(`Backup will be saved to: ${config.outputDir}`);
  logInfo(`Schemas: ${finalSchemas.length ? finalSchemas.join(", ") : "all"} | Formats: ${formats.join(", ")} | Jobs: ${jobs} (${jobs === "auto" ? "auto" : jobs} parallel${jobs === "auto" ? `, HT ${getCpuInfo().hyperThreading ? "ON" : "OFF"}` : ""})`);
  if (includeTables.length) logInfo(`Include tables (whitelist --table): ${includeTables.join(", ")}`);
  if (excludeTables.length) logInfo(`Exclude tables: ${excludeTables.join(", ")}`);
  if (excludeTableData.length) logInfo(`Exclude data: ${excludeTableData.join(", ")}`);
  if (includeTables.length) logWarn(`Whitelist mode: only ${includeTables.length} table(s) will be dumped (--table), --schema filter will be skipped`);

  let doBackup = false;
  try {
    doBackup = await confirm({ message: "Start backup?", default: true });
  } catch {
    return;
  }
  if (!doBackup) {
    console.log(chalk.yellow("Cancelled."));
    return;
  }

  // Estimate total tables + bytes + per-table sizes for progress bar
  let totalTables = 0;
  let estimatedBytes = 0;
  const tableSizes = new Map<string, number>(); // per-table total size for Bytes per-table bar
  const tableDataSizes = new Map<string, number>(); // data-only size for exclude-data
  try {
    if (ok) {
      if (includeTables.length > 0) {
        totalTables = includeTables.length;
        let sum = 0;
        for (const t of includeTables) {
          try {
            const sz = await getTableSize(config.pgBin, db, t);
            tableSizes.set(t, sz);
            sum += sz;
          } catch {}
        }
        estimatedBytes = sum;
        if (estimatedBytes === 0) {
          try { const s = await getDatabaseSize(config.pgBin, db); estimatedBytes = parseSizeToBytes(s); } catch {}
        }
      } else {
        const schemasForCount = finalSchemas.length > 0 ? finalSchemas : availableSchemas;
        for (const sch of schemasForCount) totalTables += await getTableCount(config.pgBin, db, sch);
        if (totalTables > 0 && excludeTables.length > 0) totalTables = Math.max(0, totalTables - excludeTables.length);
        try { const s = await getDatabaseSize(config.pgBin, db); estimatedBytes = parseSizeToBytes(s); } catch {}
        if (estimatedBytes > 0) {
          if (excludeTables.length > 0) {
            let excl = 0;
            for (const t of excludeTables) {
              try {
                const sz = await getTableSize(config.pgBin, db, t);
                tableSizes.set(t, sz);
                excl += sz;
              } catch {}
            }
            estimatedBytes = Math.max(0, estimatedBytes - excl);
          }
          if (excludeTableData.length > 0) {
            let exclData = 0;
            for (const t of excludeTableData) {
              try {
                const dsz = await getTableDataSize(config.pgBin, db, t);
                const tsz = dsz || Math.round((await getTableSize(config.pgBin, db, t)) * 0.7);
                tableDataSizes.set(t, tsz);
                exclData += tsz;
              } catch {}
            }
            estimatedBytes = Math.max(0, estimatedBytes - exclData);
          }
        }
        if (estimatedBytes === 0 && totalTables > 0) {
          try { const s = await getDatabaseSize(config.pgBin, db); estimatedBytes = parseSizeToBytes(s); } catch {}
        }
        // Pre-fetch per-table sizes for all tables in selected schemas for per-table Bytes bar (single query, efficient)
        if (totalTables > 0 && totalTables <= 400) {
          try {
            const allSizes = await getTablesWithSizes(config.pgBin, db, schemasForCount);
            for (const [k, v] of allSizes) if (!tableSizes.has(k)) tableSizes.set(k, v);
          } catch {}
        }
      }
    }
  } catch {}
  // Dual progressbar: bar 1 = tables (overall), bar 2 = bytes per-table (current table being dumped)
  const startTime = Date.now();
  let processedTables = 0;
  let lastShort = "starting...";
  let writtenBytes = 0;
  let currentTableName: string | null = null;
  let currentTableSize = 0;
  let currentTableStartBytes = 0;
  const expectedFolderBase = join(config.outputDir, `${db.database}_${ts}`);

  const pollBytes = () => {
    try {
      let folder = expectedFolderBase;
      if (!existsSync(folder)) {
        for (let i = 1; i <= 5; i++) {
          const alt = `${expectedFolderBase}_${i}`;
          if (existsSync(alt)) { folder = alt; break; }
        }
        if (!existsSync(folder)) return 0;
      }
      let total = 0;
      const stack: string[] = [folder];
      while (stack.length) {
        const dir = stack.pop()!;
        let entries: any[] = [];
        try { entries = readdirSync(dir, { withFileTypes: true } as any); } catch { continue; }
        for (const e of entries) {
          const p = join(dir, e.name);
          if (e.isDirectory()) stack.push(p);
          else try { total += statSync(p).size; } catch {}
        }
      }
      return total;
    } catch { return 0; }
  };

  const extractTableName = (msg: string): string | null => {
    let m = msg.match(/dumping contents of table\s+"([^"]+)"\."([^"]+)"/i);
    if (m) return `${m[1]}.${m[2]}`;
    m = msg.match(/dumping contents of table\s+"([^"]+)"/i);
    if (m) {
      const raw = m[1]!.replace(/"/g, "");
      if (raw.includes(".")) return raw;
      return `public.${raw}`;
    }
    m = msg.match(/dumping contents of table\s+([^\s]+)/i);
    if (m) return m[1]!.replace(/"/g, "").replace(/,$/, "");
    return null;
  };

  // Use cli-progress MultiBar for 2 stacked bars + status line below
  const { default: cliProgress } = await import("cli-progress");
  const padLeft = (s: string, w: number) => s.padStart(w);
  const pctStr = (cur: number, total: number) => {
    if (total <= 0) return "  0%".padStart(4);
    const p = Math.round((Math.min(cur, total) / total) * 100);
    return `${String(p).padStart(3)}%`;
  };
  const valueWidth = 20;
  const pctWidth = 4;
  const elapsedWidth = 8;
  const multibar = new cliProgress.MultiBar({
    clearOnComplete: false,
    hideCursor: true,
    barCompleteChar: "█",
    barIncompleteChar: "░",
    barsize: 22,
    format: `{bar} {pctStr} | {valueStr} | {elapsedStr}`,
    stopOnComplete: false,
  }, cliProgress.Presets.shades_classic);

  const tableTotal = totalTables || 1;
  const tableBar = multibar.create(tableTotal, 0, {
    pctStr: padLeft("0%", pctWidth),
    valueStr: padLeft(`0/${totalTables || "?"}`, valueWidth),
    elapsedStr: padLeft("0s", elapsedWidth),
  });
  tableBar.setTotal(tableTotal);
  // Status line below progressbar: only pg_dump message (time now in bar)
  const statusBar = multibar.create(1, 1, { status: chalk.dim("starting...") }, {
    format: ` {status}`,
    barCompleteChar: " ",
    barIncompleteChar: " ",
    barsize: 0,
  });
  // Ensure bars start at 0
  tableBar.update(0, {
    pctStr: padLeft(pctStr(0, tableTotal), pctWidth),
    valueStr: padLeft(`0/${totalTables || "?"}`, valueWidth),
    elapsedStr: padLeft("0s", elapsedWidth),
  });
  statusBar.update(1, { status: chalk.dim(`starting...`) });

  let pollTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    writtenBytes = pollBytes();
    const elapsed = formatDuration(Date.now() - startTime);
    const curTable = Math.min(processedTables, tableTotal);
    tableBar.update(curTable, {
      pctStr: padLeft(pctStr(curTable, tableTotal), pctWidth),
      valueStr: padLeft(`${curTable}/${totalTables || "?"}`, valueWidth),
      elapsedStr: padLeft(elapsed, elapsedWidth),
    });
    statusBar.update(1, { status: chalk.dim(lastShort) });
  }, 600);

  const onProgress = (msg: string) => {
    const short = msg.length > 65 ? msg.slice(0, 65) + "..." : msg;
    lastShort = short;
    const lower = msg.toLowerCase();
    if (lower.includes("dumping contents of table") || lower.includes("dumping table") || lower.includes("processing table")) {
      const tbl = extractTableName(msg);
      if (tbl) {
        currentTableName = tbl;
        let sz = tableSizes.get(tbl) || 0;
        if (!sz) for (const [k, v] of tableSizes) if (k.toLowerCase() === tbl.toLowerCase()) { sz = v; break; }
        if (!sz) sz = tableDataSizes.get(tbl) || 0;
        if (sz) lastShort = `${short} • ${prettyBytes(sz)}`;
      }
      processedTables++;
    }
    const elapsed = formatDuration(Date.now() - startTime);
    const curTable = Math.min(processedTables, tableTotal);
    tableBar.update(curTable, {
      pctStr: padLeft(pctStr(curTable, tableTotal), pctWidth),
      valueStr: padLeft(`${curTable}/${totalTables || "?"}`, valueWidth),
      elapsedStr: padLeft(elapsed, elapsedWidth),
    });
    statusBar.update(1, { status: chalk.dim(short) });
  };

  let files: string[] = [];
  let log = "";
  let folder = "";
  try {
    const result = await backupDatabase({
      pgBin: config.pgBin,
      db,
      schemas: finalSchemas,
      formats,
      outputDir: config.outputDir,
      jobs,
      timestamp: ts,
      onProgress,
      includeTables,
      excludeTables,
      excludeTableData,
    });
    files = result.files;
    log = result.log;
    folder = result.folder;
    if (pollTimer) clearInterval(pollTimer);
    writtenBytes = pollBytes();
    const totalElapsed = formatDuration(Date.now() - startTime);
    // Force bar to 100% at done
    const tableValFinal = `${totalTables || processedTables}/${totalTables || processedTables}`;
    tableBar.update(tableTotal, {
      pctStr: padLeft("100%", pctWidth),
      valueStr: padLeft(tableValFinal, valueWidth),
      elapsedStr: padLeft(totalElapsed, elapsedWidth),
    });
    statusBar.update(1, { status: chalk.dim(`done • ${prettyBytes(writtenBytes)}`) });
    multibar.stop();
    // Tampilkan size backup yang sebenarnya (total file di folder)
    const totalBackupSize = (() => {
      try {
        let total = 0;
        const stack: string[] = [folder];
        while (stack.length) {
          const dir = stack.pop()!;
          let entries: any[] = [];
          try { entries = readdirSync(dir, { withFileTypes: true } as any); } catch { continue; }
          for (const e of entries) {
            const p = join(dir, e.name);
            if (e.isDirectory()) stack.push(p);
            else try { total += statSync(p).size; } catch {}
          }
        }
        return total;
      } catch { return writtenBytes; }
    })();
    console.log(chalk.green(`✔ Backup completed ${tableValFinal} tables • ${prettyBytes(totalBackupSize)} • ${totalElapsed}`));
    console.log(chalk.cyan(`  Backup size: ${prettyBytes(totalBackupSize)} • ${folder}`));

    logSuccess(`Folder created: ${folder}`);
    logSuccess(`Files created:`);
    for (const f of files) {
      try {
        const st = statSync(f);
        const isDir = st.isDirectory();
        let sizeStr = "";
        if (isDir) {
          const entries = readdirSync(f, { recursive: true } as any) as string[];
          let total = 0;
          for (const e of entries) {
            try {
              total += statSync(join(f, e as any)).size;
            } catch {}
          }
          sizeStr = prettyBytes(total);
        } else {
          sizeStr = prettyBytes(st.size);
        }
        logInfo(`  ${chalk.cyan(basename(f))} — ${sizeStr} — ${f}`);
      } catch {
        logInfo(`  ${f}`);
      }
    }
    logInfo(`Log: ${log}`);

    if (config.retentionDays && config.retentionDays > 0) {
      const { readdirSync: rd, statSync: st, unlinkSync, rmSync } = await import("node:fs");
      try {
        const filesInDir = rd(config.outputDir);
        const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
        for (const file of filesInDir) {
          if (file === ".gitkeep") continue;
          const full = join(config.outputDir, file);
          try {
            const s = st(full);
            if (s.mtimeMs < cutoff) {
              if (s.isDirectory()) rmSync(full, { recursive: true, force: true });
              else unlinkSync(full);
              logInfo(`Cleaned old: ${file}`);
            }
          } catch {}
        }
      } catch {}
    }
  } catch (e: any) {
    if (pollTimer) clearInterval(pollTimer);
    try { multibar.stop(); } catch {}
    console.log(chalk.red(`✖ Backup failed: ${e.message}`));
    logError(e.message);
  }
}

async function handleRestore(config: ReturnType<typeof loadConfig>) {
  const outDir = config.outputDir;
  if (!existsSync(outDir)) {
    logError(`Backup directory not found: ${outDir}`);
    return;
  }

  // Collect all backup files: support both legacy (files in outDir) and new (folders {db}_{timestamp}/*)
  const entries = readdirSync(outDir, { withFileTypes: true });
  const allFiles: { value: string; name: string }[] = [];

  for (const e of entries) {
    if (e.name === ".gitkeep") continue;
    const full = join(outDir, e.name);
    if (e.isDirectory()) {
      try {
        const inner = readdirSync(full, { withFileTypes: true });
        // Check if this dir is a backup container (contains .tar/.dump/.sql or dir dumps with toc.dat)
        const hasBackupFiles = inner.some((i) => {
          if (i.name.endsWith(".tar") || i.name.endsWith(".dump") || i.name.endsWith(".sql") || i.name.endsWith(".custom")) return true;
          if (i.isDirectory()) {
            try {
              const sub = readdirSync(join(full, i.name));
              return sub.includes("toc.dat");
            } catch {
              return false;
            }
          }
          return false;
        });
        // Also check if the directory itself is a directory dump (contains toc.dat)
        const isDirectDump = (() => {
          try {
            return readdirSync(full).includes("toc.dat");
          } catch {
            return false;
          }
        })();

        if (hasBackupFiles) {
          for (const innerEntry of inner) {
            const innerFull = join(full, innerEntry.name);
            if (innerEntry.name.startsWith("backup_") || innerEntry.name.endsWith(".log") || innerEntry.name.endsWith(".restore.log")) continue;
            let isDumpDir = false;
            let validDump = false;
            try {
              const st = statSync(innerFull);
              isDumpDir = st.isDirectory();
              if (isDumpDir) {
                // Directory dump: must contain toc.dat
                const dirInner = readdirSync(innerFull);
                validDump = dirInner.includes("toc.dat");
              } else {
                validDump = innerEntry.name.endsWith(".tar") || innerEntry.name.endsWith(".dump") || innerEntry.name.endsWith(".sql") || innerEntry.name.endsWith(".custom");
              }
              if (!validDump) continue;
            } catch {
              continue;
            }
            let size = 0;
            let mtime = "";
            try {
              const st = statSync(innerFull);
              mtime = st.mtime.toISOString().slice(0, 19).replace("T", " ");
              if (st.isDirectory()) {
                const innerFiles = readdirSync(innerFull, { recursive: true } as any) as string[];
                for (const f of innerFiles) {
                  try {
                    size += statSync(join(innerFull, f as any)).size;
                  } catch {}
                }
              } else {
                size = st.size;
              }
            } catch {}
            allFiles.push({
              value: innerFull,
              name: `${e.name}/${innerEntry.name} — ${prettyBytes(size)} — ${mtime}`,
            });
          }
        } else if (isDirectDump) {
          // This directory itself is a dump (legacy direct)
          let size = 0;
          let mtime = "";
          try {
            const st = statSync(full);
            mtime = st.mtime.toISOString().slice(0, 19).replace("T", " ");
            const innerFiles = readdirSync(full, { recursive: true } as any) as string[];
            for (const f of innerFiles) {
              try {
                size += statSync(join(full, f as any)).size;
              } catch {}
            }
          } catch {}
          allFiles.push({
            value: full,
            name: `${e.name} — ${prettyBytes(size)} — ${mtime}`,
          });
        } else if (inner.length > 0 && !hasBackupFiles && !isDirectDump) {
          // Fallback: treat container with other files (should not happen)
          continue;
        }
      } catch {
        continue;
      }
    } else if (e.name.endsWith(".tar") || e.name.endsWith(".dump") || e.name.endsWith(".sql") || e.name.endsWith(".custom")) {
      // Legacy file directly in outDir
      let size = 0;
      let mtime = "";
      try {
        const st = statSync(full);
        size = st.size;
        mtime = st.mtime.toISOString().slice(0, 19).replace("T", " ");
      } catch {}
      allFiles.push({
        value: full,
        name: `${e.name} — ${prettyBytes(size)} — ${mtime}`,
      });
    }
  }

  const files = allFiles.sort((a, b) => b.name.localeCompare(a.name));

  if (files.length === 0) {
    logError(`No backup files found in ${outDir}`);
    logInfo("Run Backup first.");
    return;
  }

  let dumpFile: string;
  try {
    dumpFile = await select({
      message: "Select dump file to restore:",
      choices: files,
    });
  } catch {
    console.log(chalk.yellow("Cancelled."));
    return;
  }

  const targets = Object.keys(config.restoreTargets || {});
  if (targets.length === 0) {
    logError("No restoreTargets defined in config.json");
    return;
  }

  let targetKey: string;
  try {
    targetKey = await select({
      message: "Select restore target:",
      choices: targets.map((k) => {
        const t = config.restoreTargets[k]!;
        return { value: k, name: `${k} — ${t.database} @ ${t.host}:${t.port}` };
      }),
    });
  } catch {
    console.log(chalk.yellow("Cancelled."));
    return;
  }

  const target = config.restoreTargets[targetKey]!;

  logWarn(`This will restore ${chalk.bold(basename(dumpFile))} -> ${chalk.bold(target.database)} @ ${target.host}`);
  logWarn(`Existing data in ${target.database} may be overwritten (--clean --if-exists).`);

  let confirmRestore = false;
  try {
    confirmRestore = await confirm({ message: `Restore to ${target.database}?`, default: false });
  } catch {
    return;
  }
  if (!confirmRestore) {
    console.log(chalk.yellow("Cancelled."));
    return;
  }

  const cpu = getCpuInfo();
  const jobs = getEffectiveJobs(config.jobs);
  logInfo(`Restore jobs: ${jobs} (logical:${cpu.logical}, HT:${cpu.hyperThreading ? "ON" : "OFF"})`);
  const isDirDump = (() => { try { return statSync(dumpFile).isDirectory(); } catch { return false; } })();
  let estimatedRestoreTotal = 0;
  // Estimate total objects for progress: for directory dump count files, for sql estimate lines, else guess
  try {
    if (isDirDump) {
      const tocFiles = readdirSync(dumpFile);
      // directory dumps have many .dat.gz + toc.dat; use file count as proxy
      estimatedRestoreTotal = tocFiles.length;
    } else if (dumpFile.endsWith(".sql")) {
      const st = statSync(dumpFile);
      // rough: 1 object per ~50KB guess, or at least 1
      estimatedRestoreTotal = Math.max(1, Math.round(st.size / (50 * 1024)));
    } else {
      // custom/tar: guess from file size
      const st = statSync(dumpFile);
      estimatedRestoreTotal = Math.max(1, Math.round(st.size / (100 * 1024)));
    }
  } catch {}
  const restoreStart = Date.now();
  let restoredCount = 0;
  let lastRestoreMsg = "starting...";

  // Stacked bar like Backup (parity): top = objects, bottom = status line
  const { default: cliProgress } = await import("cli-progress");
  const padLeft = (s: string, w: number) => s.padStart(w);
  const pctStr = (cur: number, total: number) => {
    if (total <= 0) return "  0%".padStart(4);
    const p = Math.round((Math.min(cur, total) / total) * 100);
    return `${String(p).padStart(3)}%`;
  };
  const valueWidth = 20;
  const pctWidth = 4;
  const elapsedWidth = 8;
  const multibar = new cliProgress.MultiBar({
    clearOnComplete: false,
    hideCursor: true,
    barCompleteChar: "█",
    barIncompleteChar: "░",
    barsize: 22,
    format: `{bar} {pctStr} | {valueStr} | {elapsedStr}`,
    stopOnComplete: false,
  }, cliProgress.Presets.shades_classic);

  const restoreTotal = estimatedRestoreTotal || 1;
  const restoreBar = multibar.create(restoreTotal, 0, {
    pctStr: padLeft("0%", pctWidth),
    valueStr: padLeft(`0/${estimatedRestoreTotal || "?"}`, valueWidth),
    elapsedStr: padLeft("0s", elapsedWidth),
  });
  restoreBar.setTotal(restoreTotal);
  const statusBar = multibar.create(1, 1, { status: chalk.dim("starting...") }, {
    format: ` {status}`,
    barCompleteChar: " ",
    barIncompleteChar: " ",
    barsize: 0,
  });
  restoreBar.update(0, {
    pctStr: padLeft(pctStr(0, restoreTotal), pctWidth),
    valueStr: padLeft(`0/${estimatedRestoreTotal || "?"}`, valueWidth),
    elapsedStr: padLeft("0s", elapsedWidth),
  });
  statusBar.update(1, { status: chalk.dim("starting...") });

  let pollTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    const elapsed = formatDuration(Date.now() - restoreStart);
    const cur = Math.min(restoredCount, restoreTotal);
    restoreBar.update(cur, {
      pctStr: padLeft(pctStr(cur, restoreTotal), pctWidth),
      valueStr: padLeft(`${cur}/${estimatedRestoreTotal || "?"}`, valueWidth),
      elapsedStr: padLeft(elapsed, elapsedWidth),
    });
    statusBar.update(1, { status: chalk.dim(lastRestoreMsg) });
  }, 600);

  const onProgress = (msg: string) => {
    const short = msg.length > 65 ? msg.slice(0, 65) + "..." : msg;
    lastRestoreMsg = short;
    const lower = msg.toLowerCase();
    if (lower.includes("processing") || lower.includes("restoring") || lower.includes("creating") || lower.includes("executing") || lower.includes("table")) {
      if (lower.includes("table") || lower.includes("index") || lower.includes("sequence") || lower.includes("constraint") || lower.includes("data") || lower.includes("processing")) {
        restoredCount++;
      }
    }
    const elapsed = formatDuration(Date.now() - restoreStart);
    const cur = Math.min(restoredCount, restoreTotal);
    restoreBar.update(cur, {
      pctStr: padLeft(pctStr(cur, restoreTotal), pctWidth),
      valueStr: padLeft(`${cur}/${estimatedRestoreTotal || "?"}`, valueWidth),
      elapsedStr: padLeft(elapsed, elapsedWidth),
    });
    statusBar.update(1, { status: chalk.dim(short) });
  };

  try {
    await restoreDatabase({
      pgBin: config.pgBin,
      target,
      dumpFile,
      jobs,
      onProgress,
    });
    if (pollTimer) clearInterval(pollTimer);
    const totalElapsed = formatDuration(Date.now() - restoreStart);
    const curFinal = estimatedRestoreTotal ? `${estimatedRestoreTotal}/${estimatedRestoreTotal}` : `${restoredCount}/${restoredCount || 1}`;
    restoreBar.update(restoreTotal, {
      pctStr: padLeft("100%", pctWidth),
      valueStr: padLeft(curFinal, valueWidth),
      elapsedStr: padLeft(totalElapsed, elapsedWidth),
    });
    statusBar.update(1, { status: chalk.dim("done") });
    multibar.stop();
    console.log(chalk.green(`✔ Restore completed ${curFinal} objects • ${totalElapsed}`));
    logSuccess(`Restored ${basename(dumpFile)} -> ${target.database}`);
  } catch (e: any) {
    if (pollTimer) clearInterval(pollTimer);
    try { multibar.stop(); } catch {}
    console.log(chalk.red(`✖ Restore failed: ${e.message}`));
    logError(e.message);
  }
}

main().catch((e) => {
  logError(e.message);
  process.exit(1);
});
