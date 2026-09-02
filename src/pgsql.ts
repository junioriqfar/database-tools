import { existsSync, mkdirSync, cpSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { arch } from "node:os";

// Cross-platform pg_dump auto-download
// If pg_dump not found in pgBin nor in PATH, download from EDB

type Platform = "win32" | "linux" | "darwin";

interface DownloadInfo {
  url: string;
  fileName: string;
  extractDir: string; // relative inside archive
}

function getPlatform(): Platform {
  const p = process.platform as Platform;
  if (p === "win32" || p === "linux" || p === "darwin") return p;
  return "linux";
}

function getDownloadInfo(p: Platform, a: string): DownloadInfo | null {
  // Use PostgreSQL 16.6 binaries (latest stable 16.x)
  // EDB binaries are ~80-200MB, contain pgsql/bin/*
  const version = "16.6-1";
  if (p === "win32") {
    return {
      url: `https://get.enterprisedb.com/postgresql/postgresql-${version}-windows-x64-binaries.zip`,
      fileName: `postgresql-${version}-windows-x64-binaries.zip`,
      extractDir: `pgsql`,
    };
  }
  if (p === "linux") {
    // Linux x64
    return {
      url: `https://get.enterprisedb.com/postgresql/postgresql-${version}-linux-x64-binaries.tar.gz`,
      fileName: `postgresql-${version}-linux-x64-binaries.tar.gz`,
      extractDir: `pgsql`,
    };
  }
  if (p === "darwin") {
    // macOS: check arch
    const isArm = a === "arm64";
    const archStr = isArm ? "arm64" : "x64";
    return {
      url: `https://get.enterprisedb.com/postgresql/postgresql-${version}-macos-${archStr}-binaries.tar.gz`,
      fileName: `postgresql-${version}-macos-${archStr}-binaries.tar.gz`,
      extractDir: `pgsql`,
    };
  }
  return null;
}

function getPgDumpPath(pgBin: string): string {
  const exe = getPlatform() === "win32" ? "pg_dump.exe" : "pg_dump";
  if (pgBin) {
    const direct = join(pgBin, exe);
    if (existsSync(direct)) return direct;
  }
  return "pg_dump";
}

export function isPgDumpAvailable(pgBin: string): boolean {
  const p = getPgDumpPath(pgBin);
  if (p !== "pg_dump" && existsSync(p)) return true;
  // Check in PATH via which/where
  try {
    const cmd = getPlatform() === "win32" ? "where" : "which";
    const proc = Bun.spawnSync([cmd, "pg_dump"]);
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

function getLocalPgBinDir(projectRoot: string): string {
  return join(projectRoot, "bin", "pgsql", "bin");
}

export async function ensurePgBinaries(
  configuredPgBin: string,
  projectRoot: string,
  onProgress?: (msg: string) => void,
): Promise<string> {
  // 1. Check configured pgBin
  if (configuredPgBin) {
    const p = join(configuredPgBin, getPlatform() === "win32" ? "pg_dump.exe" : "pg_dump");
    if (existsSync(p)) {
      onProgress?.(`Found pg_dump at ${p}`);
      return configuredPgBin;
    }
    onProgress?.(`Configured pgBin not found: ${configuredPgBin}, checking PATH...`);
  }

  // 2. Check in PATH
  if (isPgDumpAvailable("")) {
    onProgress?.(`Found pg_dump in PATH`);
    return ""; // empty means use PATH
  }

  // 3. Check local bin/pgsql/bin
  const localBin = getLocalPgBinDir(projectRoot);
  const localDump = join(localBin, getPlatform() === "win32" ? "pg_dump.exe" : "pg_dump");
  if (existsSync(localDump)) {
    onProgress?.(`Found local pg_dump at ${localBin}`);
    return localBin;
  }

  // 4. Not found -> prompt to download
  const pl = getPlatform();
  const ar = arch();
  const info = getDownloadInfo(pl, ar);
  if (!info) {
    throw new Error(`Unsupported platform ${pl} ${ar} for auto-download. Please install PostgreSQL client manually.`);
  }

  onProgress?.(`PostgreSQL client not found on this device (${pl} ${ar}).`);
  onProgress?.(`Will download from: ${info.url}`);
  onProgress?.(`This provides standalone pg_dump/psql without installing full PostgreSQL.`);

  // Ask for confirmation via the caller (we don't prompt here, just download if called)
  // Download
  const downloadDir = join(projectRoot, "bin", "pgsql");
  const archivePath = join(downloadDir, info.fileName);

  if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true });

  // If already downloaded but not extracted, try extract
  if (existsSync(archivePath) && !existsSync(localDump)) {
    onProgress?.(`Found cached archive: ${archivePath}, extracting...`);
    await extractArchive(archivePath, downloadDir, onProgress);
    if (existsSync(localDump)) return localBin;
  }

  if (!existsSync(localDump)) {
    onProgress?.(`Downloading PostgreSQL binaries (~80-200MB)...`);
    onProgress?.(`From: ${info.url}`);
    onProgress?.(`To: ${archivePath}`);
    await downloadFile(info.url, archivePath, onProgress);
    onProgress?.(`Download complete. Extracting...`);
    await extractArchive(archivePath, downloadDir, onProgress);
  }

  if (existsSync(localDump)) {
    onProgress?.(`PostgreSQL binaries ready at ${localBin}`);
    // Optionally keep archive for cache, or delete to save space
    // Do not delete automatically, keep for future
    return localBin;
  }

  throw new Error(`Failed to setup PostgreSQL binaries. Tried ${info.url} -> ${localBin}`);
}

async function downloadFile(url: string, dest: string, onProgress?: (msg: string) => void): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText} for ${url}`);

  const total = parseInt(res.headers.get("content-length") || "0", 10);
  const file = Bun.file(dest);
  const writer = file.writer();

  let downloaded = 0;
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No body");

  const start = Date.now();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      await writer.write(value);
      downloaded += value.length;
      if (total > 0) {
        const pct = ((downloaded / total) * 100).toFixed(1);
        const mb = (downloaded / 1024 / 1024).toFixed(1);
        const totalMb = (total / 1024 / 1024).toFixed(1);
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        onProgress?.(`Downloading... ${pct}% (${mb}/${totalMb} MB) ${elapsed}s`);
      } else {
        const mb = (downloaded / 1024 / 1024).toFixed(1);
        onProgress?.(`Downloading... ${mb} MB`);
      }
      // Flush periodically
      await writer.flush();
    }
  }
  await writer.end();
}

async function extractArchive(archivePath: string, destDir: string, onProgress?: (msg: string) => void): Promise<void> {
  const pl = getPlatform();
  onProgress?.(`Extracting ${archivePath}...`);

  if (pl === "win32") {
    const psCmd = [
      "powershell",
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path "${archivePath}" -DestinationPath "${destDir}" -Force`,
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(psCmd[0]!, psCmd.slice(1), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let out = "";
      let err = "";
      child.stdout?.on("data", (d) => (out += d.toString()));
      child.stderr?.on("data", (d) => (err += d.toString()));
      child.on("close", (code) => {
        if (code === 0) {
          onProgress?.(`Extracted to ${destDir}`);
          resolve();
        } else {
          onProgress?.(`Extract failed: ${err || out}`);
          reject(new Error(`Expand-Archive failed: ${err || out}`));
        }
      });
      child.on("error", reject);
    });
    return;
  }

  // Linux/macOS: EDB archive contains pgsql/ at top level
  // Keep archive structure first, then normalize to destDir/bin
  const tarCmd = ["tar", "-xzf", archivePath, "-C", destDir];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(tarCmd[0]!, tarCmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar extract failed: ${err || `exit ${code}`}`));
    });
    child.on("error", reject);
  });

  // Normalize: EDB extracts to destDir/pgsql/bin but getLocalPgBinDir expects destDir/bin
  const pgsqlBin = join(destDir, "pgsql", "bin");
  const expectedBin = join(destDir, "bin");
  if (existsSync(pgsqlBin) && !existsSync(expectedBin)) {
    try {
      mkdirSync(expectedBin, { recursive: true });
      // Try native cpSync (Node 16+) for cross-platform copy
      try {
        cpSync(pgsqlBin, expectedBin, { recursive: true, force: true });
        onProgress?.(`Normalized ${pgsqlBin} -> ${expectedBin}`);
      } catch {
        // Fallback to spawn cp -r (Unix)
        const cp = spawnSync("cp", ["-r", `${pgsqlBin}/.`, expectedBin]);
        if (cp.status !== 0) throw new Error(cp.stderr?.toString() || "cp failed");
        onProgress?.(`Normalized via cp -r to ${expectedBin}`);
      }
    } catch (e: any) {
      onProgress?.(`Normalize failed: ${e.message} — will use ${pgsqlBin} directly`);
    }
  } else if (existsSync(expectedBin)) {
    onProgress?.(`Extracted to ${destDir}`);
  } else if (existsSync(pgsqlBin)) {
    onProgress?.(`Extracted to ${join(destDir, "pgsql")}`);
  }
}

export function getLocalPgBinDirForConfig(projectRoot: string): string {
  return getLocalPgBinDir(projectRoot);
}
