import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

export const PLUGIN_ID = "zalo-monitor";

export function resolvePluginStateDir(): string {
  return path.join(resolveStateDir(), "plugin-state", PLUGIN_ID);
}

export function resolvePendingDir(stateDir: string): string {
  return path.join(stateDir, "pending");
}

export function resolveRejectedDir(stateDir: string): string {
  return path.join(stateDir, "pending", "rejected");
}

export function resolveCheckpointPath(stateDir: string): string {
  return path.join(stateDir, "checkpoint.json");
}

export function resolveStatusPath(stateDir: string): string {
  return path.join(stateDir, "status.json");
}

export async function ensureStateDirs(stateDir: string): Promise<void> {
  await mkdir(resolvePendingDir(stateDir), { recursive: true });
  await mkdir(resolveRejectedDir(stateDir), { recursive: true });
}

const RENAME_MAX_ATTEMPTS = 5;
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Windows hay trả EPERM khi target đang bị tranh chấp — thử lại vài lần rồi mới bỏ. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw err;
      lastError = err;
      const delay =
        RENAME_RETRY_DELAYS_MS[attempt] ??
        RENAME_RETRY_DELAYS_MS[RENAME_RETRY_DELAYS_MS.length - 1] ??
        100;
      await sleep(delay);
    }
  }
  throw lastError;
}

/** Ghi JSON bằng tmp-file + rename để không bao giờ để lại file nửa vời. */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await renameWithRetry(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** JSON hỏng hoặc file không tồn tại → null (không được làm sập plugin). */
export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
