#!/usr/bin/env bun
import { select, confirm, checkbox } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { loadConfig } from "./config.ts";
import { backupDatabase, restoreDatabase, testConnection, getDatabaseSize, getTableCount, getSchemas, getTables, getEffectiveJobs } from "./db.ts";
import type { BackupFormat } from "./db.ts";
import { prettyBytes, getCpuInfo, getOptimalJobs } from "./utils.ts";
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

// Handle Ctrl+C / EPIPE gracefully
process.on("SIGINT", () => {
  console.log(chalk.yellow("\nCancelled."));
  process.exit(0);
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

  let schemas: string[] = [];
  try {
    schemas = await checkbox({
      message: "Select schemas to backup (space to select, enter to confirm):",
      choices: availableSchemas.map((s) => ({ value: s, name: s, checked: true })),
      required: false,
    });
  } catch {
    console.log(chalk.yellow("Cancelled."));
    return;
  }
  const finalSchemas = schemas.length === 0 ? [] : schemas;

  // Table-level exclusion: fetch tables for selected schemas and allow user to choose
  let excludeTables: string[] = [];
  let excludeTableData: string[] = [];
  // Only offer table selection if schemas selected and DB connection ok
  if (ok && finalSchemas.length > 0) {
    try {
      const wantExclude = await confirm({ message: "Exclude specific tables? (e.g., skip backup data for large tables)", default: false });
      if (wantExclude) {
        const tableSpinner = ora("Fetching tables...").start();
        const allTables: string[] = [];
        for (const sch of finalSchemas) {
          const tbls = await getTables(config.pgBin, db, sch);
          allTables.push(...tbls);
        }
        tableSpinner.succeed(`Found ${allTables.length} tables`);
        if (allTables.length > 0) {
          // Limit to first 100 for UI performance, or show all if < 50
          const displayTables = allTables.slice(0, 100);
          if (allTables.length > 100) {
            logWarn(`Showing first 100 of ${allTables.length} tables (too many to display all). Use config.json for full list.`);
          }
          const excludeChoice = await select({
            message: "Exclude type:",
            choices: [
              { value: "none", name: "No, backup all tables" },
              { value: "table", name: "Exclude tables entirely (--exclude-table)" },
              { value: "data", name: "Exclude data only (--exclude-table-data, keep schema)" },
            ],
          });
          if (excludeChoice !== "none") {
            const picked = await checkbox({
              message: `Select tables to ${excludeChoice === "table" ? "exclude entirely" : "exclude data"}:`,
              choices: displayTables.map((t) => ({ value: t, name: t })),
              required: false,
            });
            if (excludeChoice === "table") excludeTables = picked as string[];
            else excludeTableData = picked as string[];
          }
        } else {
          logWarn("No tables found for selected schemas.");
        }
      }
    } catch {
      // ignore cancel
    }
  } else if (!ok) {
    logWarn("Skipping table discovery (no connection). You can still set excludeTables in config.json manually.");
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
  if (excludeTables.length) logInfo(`Exclude tables: ${excludeTables.join(", ")}`);
  if (excludeTableData.length) logInfo(`Exclude data: ${excludeTableData.join(", ")}`);

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

  const spin = ora("Backing up... (verbose per table)").start();

  const onProgress = (msg: string) => {
    const short = msg.length > 80 ? msg.slice(0, 80) + "..." : msg;
    spin.text = short;
  };

  try {
    const { files, log, folder } = await backupDatabase({
      pgBin: config.pgBin,
      db,
      schemas: finalSchemas,
      formats,
      outputDir: config.outputDir,
      jobs,
      timestamp: ts,
      onProgress,
      excludeTables,
      excludeTableData,
    });
    spin.succeed("Backup completed");

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
    spin.fail("Backup failed");
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
  const spin = ora("Restoring...").start();

  const onProgress = (msg: string) => {
    spin.text = msg.slice(0, 80);
  };

  try {
    await restoreDatabase({
      pgBin: config.pgBin,
      target,
      dumpFile,
      jobs,
      onProgress,
    });
    spin.succeed("Restore completed");
    logSuccess(`Restored ${basename(dumpFile)} -> ${target.database}`);
  } catch (e: any) {
    spin.fail("Restore failed");
    logError(e.message);
  }
}

main().catch((e) => {
  logError(e.message);
  process.exit(1);
});
