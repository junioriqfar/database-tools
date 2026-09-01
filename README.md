# Database Tools

Interactive **Bun** CLI untuk **Backup & Restore** PostgreSQL — cross-platform (Windows, Linux, macOS), tanpa hardcode, dengan progress realtime.

Lokasi: `D:\BunProjects\database-tools` — output di dalam direktori aplikasi (`./backups`), config tunggal `config.json` (tidak pakai `.env`, tidak di-encrypt, aman tidak ter-push via `.gitignore`).

## Fitur

- **Interaktif:** pilihan `Backup` / `Restore` (pakai `@inquirer/prompts` + `ora` spinner, stabil di Windows/Git Bash)
- **Backup:** pilih database → auto-test koneksi + info `207 tables, 132 GB` → pilih schemas (auto-discovered) → pilih tabel yang tidak perlu backup data → pilih format
- **Restore:** pilih file dump dari `backups/` → pilih target DB → `--clean --if-exists` + parallel
- **Format:** `tar` (kompatibel `disdag_ukm.tar`), `custom` (`.dump`, paling cepat & kecil, `pg_restore`), `plain` (`.sql`), `directory` (`-Fd -j`, paling cepat untuk DB besar)
- **Hyper-threading:** `jobs: "auto"` di `config.json` → deteksi `os.availableParallelism()` / `os.cpus().length` (contoh: `20 logical / 10 physical — HT YES` → `-j 20` untuk `pg_dump -Fd` dan `pg_restore -j`)
- **Pilih tabel:** setelah pilih schemas, bisa `Exclude specific tables?` → `Exclude entirely (--exclude-table)` atau `Exclude data only (--exclude-table-data)`
- **Schema auto-discovery:** `SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg_%' ...` langsung dari DB — **tidak perlu `schemas` di `config.json`** (jika kosong, fallback `public`)
- **Timestamp:** `20260901_100735` (`YYYYMMDD_HHMMSS` eksplisit `Asia/Jakarta` WIB via `Intl.DateTimeFormat`, bukan GMT/system)
- **Folder:** selalu buat folder dulu `backups/{nama_database}_{timestamp}/` berisi `*.tar`/`*.dump`/`*.sql`/`*_dir/` + `backup_*.log`
- **Cross-platform:** `pgBin` kosong → pakai `pg_dump` di `PATH` (Linux `which`, Windows `where`, macOS `brew`). Jika tidak ada, **auto-download** PostgreSQL binaries (~80-200MB) dari `get.enterprisedb.com` ke `bin/pgsql/bin` (Windows `.zip` via `Expand-Archive`, Linux/macOS `.tar.gz` via `tar`)
- **Progress:** verbose `pg_dump -v` per tabel (`dumping contents of table ...`) + `Size: X MB` + spinner, log ke `backups/{db}_{timestamp}/backup_*.log`
- **Robust:** pakai `node:child_process.spawn` (bukan `Bun.spawn` pipe) anti-segfault untuk DB besar (132 GB)

## Persyaratan

- **Bun 1.4.0+** (`bun --version`)
- **PostgreSQL client** (`pg_dump`, `psql`, `pg_restore`) — jika tidak ada, app akan tawarkan download otomatis. Manual:
  - Windows: Laragon `C:\laragon\bin\postgresql\postgresql-16.4-1\bin` atau https://www.postgresql.org/download/windows/
  - macOS: `brew install postgresql@16`
  - Linux: `sudo apt install postgresql-client-16`

## Instalasi

```bash
cd D:\BunProjects\database-tools
bun install

# config: copy template dan isi kredensial
copy config.example.json config.json   # Windows
# cp config.example.json config.json   # Linux/macOS
# edit config.json (lihat bawah)
```

## Konfigurasi — `config.json` (single file, tidak pakai `.env`)

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

- `pgBin`: path ke `bin` PostgreSQL. Kosongkan `""` untuk pakai `PATH` (otomatis di Linux/macOS). Jika tidak ditemukan, app akan download ke `bin/pgsql/bin`.
- `outputDir`: `./backups` (di dalam aplikasi, sesuai request) — bisa absolute `C:\Backup\Database` atau `D:\Backup`
- `jobs`: `"auto"` (deteksi hyper-threading) atau angka `4`, `8`, `20`
- `databases`: tanpa `schemas` — akan auto-discover dari DB (`public`, dll). Jika ingin paksa, tambah `"schemas": ["public"]`
- `restoreTargets`: tujuan restore, `createIfNotExists: true` akan `CREATE DATABASE` jika belum ada

## Penggunaan

```bash
cd D:\BunProjects\database-tools
bun run start
# atau
bun src/index.ts
# atau watch
bun run dev
```

**Alur Backup:**
1. `What do you want to do?` → `Backup`
2. `Select database to backup:` → `open-po`, `peken_dev`, `localmarketv2`
3. `Testing connection...` → `Connected: 207 tables, size 132 GB`
4. `CPU: 20 logical / 10 physical — Hyper-Threading: YES → optimal jobs: 20` → `Use auto jobs (20)?`
5. `Discovering schemas...` → `Found schemas: backup, public (auto-discovered)` (atau fallback `public`)
6. `Select schemas to backup:` → checklist (default semua tercentang)
7. `Exclude specific tables?` → jika Ya → pilih exclude type (`table` vs `data`) → checklist tabel (auto `getTables()` per schema)
8. `Select backup formats:` → `tar`/`custom`/`plain`/`directory` (default `tar`+`custom`)
9. `Backup will be saved to: .../backups` → `Start backup?` → progress `Backing up...` + verbose per tabel → `Folder created: .../open-po_20260901_100735/` + `Files created` + `Log`

**Alur Restore:**
1. `Restore` → `Select dump file:` → list `open-po_20260901_100735/open-po_20260901_100735.sql — 60.48 KB — 2026-09-01 ...` (support legacy file di `backups/` dan folder baru)
2. `Select restore target:` → `peken_dev_local — ...`
3. `Restore to ...?` → `Restoring...` (untuk `directory`/`custom` pakai `-j 20` hyper-threading) → `Restore completed`

## Struktur Output

```
backups/
├── peken_dev_20260901_100735/
│   ├── peken_dev_20260901_100735.tar      # tar
│   ├── peken_dev_20260901_100735.dump     # custom (paling kecil)
│   ├── peken_dev_20260901_100735.sql      # plain
│   ├── peken_dev_20260901_100735_dir/     # directory (parallel, ada toc.dat)
│   │   ├── toc.dat
│   │   └── *.dat.gz
│   └── backup_peken_dev_20260901_100735.log
└── open-po_20260901_153831/
    └── open-po_20260901_153831_dir/
```

## Hyper-threading

- `src/utils.ts` `getCpuInfo()` + `getOptimalJobs()` → `os.availableParallelism()` atau `os.cpus().length`
- Backup `directory` (`-Fd -j`) dan restore `directory`/`custom` (`pg_restore -j`) pakai jobs optimal — di mesin 20 logical → ` -j 20`, di 8 logical → `-j 8`. Set `jobs: 4` di `config.json` untuk paksa, atau `"auto"` untuk deteksi.

## Troubleshooting

- **`EPIPE: broken pipe, write` saat `bun run start`:** pakai **PowerShell / CMD / Windows Terminal**, jangan Git Bash `mintty`. Sudah fix dari `@clack/prompts` → `@inquirer/prompts` + `ora`.
- **`pg_dump: error: permission denied for relation ..._seq`:** user `ikhfar_programmer` bukan owner sequence (`sari_admin`/`programmer`). Solusi: `GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ikhfar_programmer;` sebagai superuser, atau exclude tabel tersebut, atau backup sebagai `postgres`.
- **`could not create directory ... File exists`:** sudah fix — `directory` tidak di-`mkdir` dulu, `pg_dump` yang buat, jika ada pakai `uniqueDir` (`_1`, `_2`).
- **`Bun has crashed: Segmentation fault` untuk DB 132 GB:** sudah fix — ganti `Bun.spawn` pipe → `node:child_process.spawn` dengan `stdio: ["ignore","pipe","pipe"]`.
- **`SHOW timezone` masih GMT:** backup timestamp sudah eksplisit `Asia/Jakarta` via `Intl.DateTimeFormat`, tidak tergantung `TZ` system. Untuk DB session, bisa `SET timezone = 'Asia/Jakarta'`.
- **`pg_dump not found`:** app akan tawarkan download otomatis. Jika `pgBin` diisi Windows path tapi dijalankan di Linux/macOS, akan fallback ke `PATH` dan download jika perlu.

## Cross-platform

- **Windows:** `pg_dump.exe`, `where`, `Expand-Archive`, path `C:\laragon\...`
- **Linux/macOS:** `pg_dump`, `which`, `tar -xzf`, path `/usr/bin` atau `/opt/homebrew/...`, auto-download `...-linux-x64` / `...-macos-x64|arm64`

Semua `join()`, `process.platform`, `getExeName()` sudah handle.

## Lisensi

Internal — ©
