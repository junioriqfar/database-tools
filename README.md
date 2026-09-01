# Database Tools

> 🌐 **Languages:** **English** | [Indonesia](./README.id.md)

Interactive **Bun** CLI for **Backup & Restore** PostgreSQL — cross-platform (Windows, Linux, macOS), no hardcoding, with realtime progress.

Location: `D:\database-tools` or `~/database-tools` — output inside the app directory (`./backups`), single config `config.json` (no `.env`, not encrypted, safely ignored via `.gitignore`).

## Features

- **Interactive:** choose `Backup` / `Restore` (uses `@inquirer/prompts` + `ora` spinner, stable on Windows/Git Bash)
- **Backup:** select database → auto-test connection + info `207 tables, 132 GB` → select schemas (auto-discovered) → choose tables to exclude from data backup → select format
- **Restore:** select dump file from `backups/` → select target DB → `--clean --if-exists` + parallel
- **Formats:** `tar`, `custom` (`.dump`, fastest & smallest, via `pg_restore`), `plain` (`.sql`), `directory` (`-Fd -j`, fastest for large DBs)
- **Hyper-threading:** `jobs: "auto"` in `config.json` → detects `os.availableParallelism()` / `os.cpus().length` (e.g. `20 logical / 10 physical — HT YES` → `-j 20` for `pg_dump -Fd` and `pg_restore -j`)
- **Table selection:** after selecting schemas, you can `Exclude specific tables?` → `Exclude entirely (--exclude-table)` or `Exclude data only (--exclude-table-data)`
- **Schema auto-discovery:** `SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg_%' ...` directly from DB — **no `schemas` needed in `config.json`** (if empty, fallback to `public`)
- **Timestamp:** `20260901_100735` (`YYYYMMDD_HHMMSS` explicit `Asia/Jakarta` WIB via `Intl.DateTimeFormat`, not GMT/system)
- **Folder:** always creates folder first `backups/{database}_{timestamp}/` containing `*.tar`/`*.dump`/`*.sql`/`*_dir/` + `backup_*.log`
- **Cross-platform:** empty `pgBin` → uses `pg_dump` from `PATH` (Linux `which`, Windows `where`, macOS `brew`). If not found, **auto-downloads** PostgreSQL binaries (~80-200MB) from `get.enterprisedb.com` to `bin/pgsql/bin` (Windows `.zip` via `Expand-Archive`, Linux/macOS `.tar.gz` via `tar`)
- **Progress:** verbose `pg_dump -v` per table (`dumping contents of table ...`) + `Size: X MB` + spinner, logged to `backups/{db}_{timestamp}/backup_*.log`
- **Robust:** uses `node:child_process.spawn` (not `Bun.spawn` pipe) to avoid segfault on large DBs (132 GB)

## Requirements

- **Bun 1.4.0+** (`bun --version`)
- **PostgreSQL client** (`pg_dump`, `psql`, `pg_restore`) — if missing, the app will offer to auto-download. Manual install:
  - Windows: Laragon `C:\laragon\bin\postgresql\postgresql-16.4-1\bin` or https://www.postgresql.org/download/windows/
  - macOS: `brew install postgresql@16`
  - Linux: `sudo apt install postgresql-client-16`

## Installation

```bash
cd D:\database-tools
# or cd ~/Projects/BunProjects/database-tools
bun install

# config: copy template and fill credentials
# Windows
copy config.example.json config.json

# Linux/macOS
cp config.example.json config.json

# edit config.json (see below)
```

## Configuration — `config.json` (single file, no `.env`)

```json
{
  "pgBin": "C:\\laragon\\bin\\postgresql\\postgresql-16.4-1\\bin",
  "outputDir": "./backups",
  "jobs": "auto",
  "retentionDays": 7,
  "databases": {
    "open-po": {
      "host": "localhost",
      "port": 5432,
      "database": "open-po",
      "username": "postgres",
      "password": "YOUR_SECRET_PASSWORD"
    }
  },
  "restoreTargets": {
    "open-po": {
      "host": "localhost",
      "port": 5432,
      "database": "open-po",
      "username": "postgres",
      "password": "YOUR_SECRET_PASSWORD",
      "createIfNotExists": true
    }
  }
}
```

- `pgBin`: path to PostgreSQL `bin`. Leave `""` to use `PATH` (automatic on Linux/macOS). If not found, the app will download to `bin/pgsql/bin`.
- `outputDir`: `./backups` (inside the app, as requested) — can be absolute `C:\Backup\Database` or `D:\Backup`
- `jobs`: `"auto"` (hyper-threading detection) or number `4`, `8`, `20`
- `databases`: no `schemas` needed — auto-discovered from DB (`public`, etc). To force, add `"schemas": ["public"]`
- `restoreTargets`: restore destinations, `createIfNotExists: true` will `CREATE DATABASE` if missing

## Usage

```bash
cd D:\database-tools
bun run start
# or
bun src/index.ts
# or watch
bun run dev
```

**Backup flow:**
1. `What do you want to do?` → `Backup`
2. `Select database to backup:` → `open-po`
3. `Testing connection...` → `Connected: 207 tables, size 132 GB`
4. `CPU: 20 logical / 10 physical — Hyper-Threading: YES → optimal jobs: 20` → `Use auto jobs (20)?`
5. `Discovering schemas...` → `Found schemas: backup, public (auto-discovered)` (or fallback `public`)
6. `Select schemas to backup:` → checklist (default all checked)
7. `Exclude specific tables?` → if Yes → choose exclude type (`table` vs `data`) → checklist tables (auto `getTables()` per schema)
8. `Select backup formats:` → `tar`/`custom`/`plain`/`directory` (default `tar`+`custom`)
9. `Backup will be saved to: .../backups` → `Start backup?` → progress `Backing up...` + verbose per table → `Folder created: .../open-po_20260901_100735/` + `Files created` + `Log`

**Restore flow:**
1. `Restore` → `Select dump file:` → list `open-po_20260901_100735/open-po_20260901_100735.sql — 60.48 KB — 2026-09-01 ...` (supports legacy files in `backups/` and new folders)
2. `Select restore target:` → `open-po — ...`
3. `Restore to ...?` → `Restoring...` (for `directory`/`custom` uses `-j 20` hyper-threading) → `Restore completed`

## Output Structure

```
backups/
├── open-po_20260901_100735/
│   ├── open-po_20260901_100735.tar      # tar
│   ├── open-po_20260901_100735.dump     # custom (smallest)
│   ├── open-po_20260901_100735.sql      # plain
│   ├── open-po_20260901_100735_dir/     # directory (parallel, has toc.dat)
│   │   ├── toc.dat
│   │   └── *.dat.gz
│   └── backup_open-po_20260901_100735.log
└── open-po_20260901_153831/
    └── open-po_20260901_153831_dir/
```

## Hyper-threading

- `src/utils.ts` `getCpuInfo()` + `getOptimalJobs()` → `os.availableParallelism()` or `os.cpus().length`
- Backup `directory` (`-Fd -j`) and restore `directory`/`custom` (`pg_restore -j`) use optimal jobs — on 20-logical machine → `-j 20`, on 8-logical → `-j 8`. Set `jobs: 4` in `config.json` to force, or `"auto"` to detect.

## Troubleshooting

- **`EPIPE: broken pipe, write` on `bun run start`:** use **PowerShell / CMD / Windows Terminal**, not Git Bash `mintty`. Already fixed by switching `@clack/prompts` → `@inquirer/prompts` + `ora`.
- **`pg_dump: error: permission denied for relation ..._seq`:** user `ikhfar_programmer` is not owner of sequence (`sari_admin`/`programmer`). Fix: `GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ikhfar_programmer;` as superuser, or exclude that table, or backup as `postgres`.
- **`could not create directory ... File exists`:** fixed — `directory` is not `mkdir`'d beforehand, `pg_dump` creates it; if exists, `uniqueDir` (`_1`, `_2`) is used.
- **`Bun has crashed: Segmentation fault` for 132 GB DB:** fixed — replaced `Bun.spawn` pipe → `node:child_process.spawn` with `stdio: ["ignore","pipe","pipe"]`.
- **`SHOW timezone` still GMT:** backup timestamp is explicit `Asia/Jakarta` via `Intl.DateTimeFormat`, not dependent on system `TZ`. For DB session, you can `SET timezone = 'Asia/Jakarta'`.
- **`pg_dump not found`:** app will offer auto-download. If `pgBin` contains a Windows path but runs on Linux/macOS, it will fallback to `PATH` and download if needed.

## Cross-platform

- **Windows:** `pg_dump.exe`, `where`, `Expand-Archive`, path `C:\...`
- **Linux/macOS:** `pg_dump`, `which`, `tar -xzf`, path `/usr/bin` or `/opt/homebrew/...`, auto-download `...-linux-x64` / `...-macos-x64|arm64`

All `join()`, `process.platform`, `getExeName()` are handled.

## License

Internal — ©
