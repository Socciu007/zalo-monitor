import { createHash } from "node:crypto";
import { readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { BackendPayload } from "./normalize.js";
import {
  ensureStateDirs,
  readJsonIfExists,
  resolveCheckpointPath,
  resolvePendingDir,
  resolveRejectedDir,
  resolveStatusPath,
  writeJsonAtomic,
} from "./state.js";

/** Một tin nhắn đã capture, đang nằm trong hàng đợi trên đĩa. */
export interface PendingRecord extends BackendPayload {
  id: string;
  messageId: string;
  mentioned: boolean;
  receivedAt: string;
}

/** Map groupId → map messageId → thời điểm đã giao, dùng để dedupe khi replay. */
export interface Checkpoint {
  [groupId: string]: { [messageId: string]: { at: string } };
}

/** Trạng thái tổng quan của queue, ghi ra `status.json`. */
export interface CaptureStatus {
  pending: number;
  rejected: number;
  lastPostAt: string | null;
  lastPostStatus: number | null;
  lastError: string | null;
  updatedAt: string;
}

/**
 * Id ổn định cho file pending: 32 ký tự hex SHA-1 của `(groupId, messageId)`.
 *
 * Id không phụ thuộc thời điểm capture → capture lại cùng một tin sẽ ghi đè
 * đúng file cũ thay vì tạo thêm file thứ hai (tránh gửi trùng lên backend).
 * Id chỉ gồm ký tự hex nên luôn an toàn cho filesystem (messageId có thể chứa
 * `/`, `:` hoặc ký tự lạ).
 */
export function buildRecordId(groupId: string, messageId: string): string {
  return createHash("sha1").update(`${groupId}\u0000${messageId}`).digest("hex").slice(0, 32);
}

/** Chỉ giữ đúng 6 field backend mong đợi. */
export function toBackendPayload(record: PendingRecord): BackendPayload {
  return {
    platform: record.platform,
    content: record.content,
    groupId: record.groupId,
    groupName: record.groupName,
    userId: record.userId,
    senderName: record.senderName,
  };
}

/** Ghi record vào `pending/` — phải xong trước khi thử gọi mạng. */
export async function enqueueCapture(stateDir: string, record: PendingRecord): Promise<void> {
  await ensureStateDirs(stateDir);
  await writeJsonAtomic(path.join(resolvePendingDir(stateDir), `${record.id}.json`), record);
}

/**
 * Đọc lại các record đang chờ trong `pending/`, sắp xếp theo `receivedAt` tăng dần
 * để flush gửi đúng thứ tự capture. Bỏ qua mọi thứ không phải file `*.json`
 * (kể cả file `.tmp-*` đang được `writeJsonAtomic` ghi dở) và file JSON hỏng.
 */
export async function listPendingRecords(stateDir: string): Promise<PendingRecord[]> {
  const dir = resolvePendingDir(stateDir);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const records: PendingRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const record = await readJsonIfExists<PendingRecord>(path.join(dir, entry));
    if (!record || typeof record.id !== "string" || typeof record.messageId !== "string") continue;
    records.push(record);
  }
  records.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  return records;
}

/**
 * Đọc checkpoint. JSON hợp lệ nhưng sai shape (mảng, chuỗi…) → coi như chưa có checkpoint.
 * Nếu không, markCheckpoint sẽ gắn key lên mảng và JSON.stringify sẽ **drop** mọi entry
 * → gửi trùng tin đã nhận.
 */
export async function readCheckpoint(stateDir: string): Promise<Checkpoint> {
  const raw = await readJsonIfExists<unknown>(resolveCheckpointPath(stateDir));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Checkpoint;
}

/** Tin này đã được giao thành công chưa (dùng để dedupe khi replay). */
export async function isCaptured(stateDir: string, groupId: string, messageId: string): Promise<boolean> {
  const checkpoint = await readCheckpoint(stateDir);
  return Boolean(checkpoint[groupId]?.[messageId]);
}

async function markCheckpoint(stateDir: string, record: PendingRecord): Promise<void> {
  const checkpoint = await readCheckpoint(stateDir);
  const group = (checkpoint[record.groupId] ??= {});
  group[record.messageId] = { at: new Date().toISOString() };
  await writeJsonAtomic(resolveCheckpointPath(stateDir), checkpoint);
}

export async function countPending(stateDir: string): Promise<number> {
  return (await listPendingRecords(stateDir)).length;
}

export async function countRejected(stateDir: string): Promise<number> {
  try {
    const entries = await readdir(resolveRejectedDir(stateDir));
    return entries.filter((entry) => entry.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/** Đọc `status.json`; file hỏng hoặc sai shape → trả trạng thái mặc định. */
export async function readStatus(stateDir: string): Promise<CaptureStatus> {
  const stored = await readJsonIfExists<unknown>(resolveStatusPath(stateDir));
  const fallback: CaptureStatus = {
    pending: 0,
    rejected: 0,
    lastPostAt: null,
    lastPostStatus: null,
    lastError: null,
    updatedAt: new Date().toISOString(),
  };
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return fallback;
  return { ...fallback, ...(stored as Partial<CaptureStatus>) };
}

/** Ghi `status.json`; `pending`/`rejected` luôn được tính lại từ đĩa, không tin patch. */
export async function updateStatus(stateDir: string, patch: Partial<CaptureStatus>): Promise<void> {
  const current = await readStatus(stateDir);
  const next: CaptureStatus = {
    ...current,
    ...patch,
    pending: await countPending(stateDir),
    rejected: await countRejected(stateDir),
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(resolveStatusPath(stateDir), next);
}

/**
 * Xoá file pending mà không đụng tới checkpoint.
 * Dùng khi phát hiện tin đã được giao trước đó (file pending bị sót lại sau crash).
 */
export async function removePendingRecord(stateDir: string, record: PendingRecord): Promise<void> {
  await rm(path.join(resolvePendingDir(stateDir), `${record.id}.json`), { force: true });
}

/**
 * Backend đã nhận (2xx): ghi checkpoint TRƯỚC, rồi mới xoá file pending.
 *
 * Đảm bảo at-least-once — không mất tin. Nếu tiến trình chết sau khi backend
 * trả 2xx nhưng trước khi ghi checkpoint, record vẫn nằm trong `pending/` và sẽ
 * được giao lại (backend phải chịu được duplicate). Xoá file trước rồi chết thì
 * tin đó mất hẳn, vì zca-js không bảo đảm giao lại tin đã gửi.
 */
export async function markDelivered(stateDir: string, record: PendingRecord, status: number): Promise<void> {
  await markCheckpoint(stateDir, record);
  await removePendingRecord(stateDir, record);
  await updateStatus(stateDir, { lastPostAt: new Date().toISOString(), lastPostStatus: status, lastError: null });
}

/**
 * Backend từ chối (4xx): chuyển file sang `pending/rejected/` để không gửi lại nữa.
 * Rename thất bại (ví dụ khác device) → ghi file mới rồi xoá file cũ.
 */
export async function markRejected(stateDir: string, record: PendingRecord, status: number): Promise<void> {
  await ensureStateDirs(stateDir);
  const source = path.join(resolvePendingDir(stateDir), `${record.id}.json`);
  const target = path.join(resolveRejectedDir(stateDir), `${record.id}.json`);
  try {
    await rename(source, target);
  } catch {
    await writeJsonAtomic(target, record);
    await rm(source, { force: true });
  }
  await updateStatus(stateDir, {
    lastPostAt: new Date().toISOString(),
    lastPostStatus: status,
    lastError: `post_rejected_4xx:${status}`,
  });
}
