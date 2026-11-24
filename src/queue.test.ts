import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildRecordId,
  enqueueCapture,
  isCaptured,
  listPendingRecords,
  markDelivered,
  markRejected,
  readStatus,
  toBackendPayload,
  type PendingRecord,
} from "./queue.js";

function makeRecord(overrides: Partial<PendingRecord> = {}): PendingRecord {
  return {
    id: buildRecordId("msg-1", "2026-11-24T10:00:00.000Z"),
    messageId: "msg-1",
    platform: "zalo",
    content: "xin chào",
    groupId: "g1",
    groupName: "G",
    userId: "u1",
    senderName: "An",
    mentioned: false,
    receivedAt: "2026-11-24T10:00:00.000Z",
    ...overrides,
  };
}

test("enqueueCapture ghi file pending và listPendingRecords đọc lại được", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-queue-"));
  const record = makeRecord();
  await enqueueCapture(dir, record);
  const records = await listPendingRecords(dir);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], record);
});

test("markDelivered xoá file pending và ghi checkpoint", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-queue-"));
  const record = makeRecord();
  await enqueueCapture(dir, record);
  await markDelivered(dir, record, 201);
  assert.equal((await listPendingRecords(dir)).length, 0);
  assert.equal(await isCaptured(dir, "g1", "msg-1"), true);
  assert.equal(await isCaptured(dir, "g1", "msg-2"), false);
});

test("markRejected chuyển file sang pending/rejected", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-queue-"));
  const record = makeRecord();
  await enqueueCapture(dir, record);
  await markRejected(dir, record, 400);
  assert.equal((await listPendingRecords(dir)).length, 0);
  const rejected = await readdir(path.join(dir, "pending", "rejected"));
  assert.equal(rejected.length, 1);
  assert.match(rejected[0] ?? "", /\.json$/);
});

test("status.json ghi pending/rejected/lastPostStatus/lastError", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-queue-"));
  const record = makeRecord();
  await enqueueCapture(dir, record);
  await markRejected(dir, record, 422);
  const status = await readStatus(dir);
  assert.equal(status.pending, 0);
  assert.equal(status.rejected, 1);
  assert.equal(status.lastPostStatus, 422);
  assert.match(status.lastError ?? "", /post_rejected_4xx/);
  assert.ok(status.updatedAt);
});

test("toBackendPayload chỉ giữ 6 field", () => {
  const payload = toBackendPayload(makeRecord());
  assert.deepEqual(Object.keys(payload).sort(), ["content", "groupId", "groupName", "platform", "senderName", "userId"]);
});

test("buildRecordId ổn định và không chứa ký tự lạ", () => {
  const id = buildRecordId("msg/with:weird chars", "2026-11-24T10:00:00.000Z");
  assert.match(id, /^[0-9]+-[0-9a-f]{12}$/);
  assert.equal(id, buildRecordId("msg/with:weird chars", "2026-11-24T10:00:00.000Z"));
});

test("checkpoint hỏng dạng mảng → coi như chưa có checkpoint, không throw", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-queue-"));
  await writeFile(path.join(dir, "checkpoint.json"), JSON.stringify(["not", "a", "map"]), "utf8");
  assert.equal(await isCaptured(dir, "g1", "msg-1"), false);
  const record = makeRecord();
  await enqueueCapture(dir, record);
  await markDelivered(dir, record, 201);
  assert.equal(await isCaptured(dir, "g1", "msg-1"), true);
});
