import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
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
    id: buildRecordId("g1", "msg-1"),
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

test("buildRecordId chỉ gồm 32 ký tự hex, ổn định theo (groupId, messageId)", () => {
  const id = buildRecordId("g1", "msg/with:weird chars");
  assert.match(id, /^[0-9a-f]{32}$/);
  // Cùng (groupId, messageId) → cùng id, không phụ thuộc thời điểm capture.
  assert.equal(id, buildRecordId("g1", "msg/with:weird chars"));
  // Khác group hoặc khác message → khác id.
  assert.notEqual(id, buildRecordId("g2", "msg/with:weird chars"));
  assert.notEqual(id, buildRecordId("g1", "msg/with:weird char"));
});

test("capture lại cùng (groupId, messageId) chỉ tạo một file pending", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-queue-"));
  const first = makeRecord({ receivedAt: "2026-11-24T10:00:00.000Z" });
  const second = makeRecord({ receivedAt: "2026-11-24T10:00:05.000Z" });
  assert.equal(first.id, second.id);
  await enqueueCapture(dir, first);
  await enqueueCapture(dir, second);
  const records = await listPendingRecords(dir);
  assert.equal(records.length, 1);
  assert.match(records[0]?.id ?? "", /^[0-9a-f]{32}$/);
  const files = (await readdir(path.join(dir, "pending"))).filter((entry) => entry.endsWith(".json"));
  assert.equal(files.length, 1);
  assert.equal(files[0], `${first.id}.json`);
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

test("markDelivered ghi checkpoint trước rồi mới xoá file pending — crash giữa chừng không mất tin", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-queue-"));
  const record = makeRecord();
  await enqueueCapture(dir, record);
  // checkpoint.json là thư mục → bước ghi checkpoint chắc chắn fail.
  await mkdir(path.join(dir, "checkpoint.json"));
  await assert.rejects(() => markDelivered(dir, record, 201));
  // File pending phải còn nguyên để lần flush sau giao lại được.
  assert.equal((await listPendingRecords(dir)).length, 1);
});
