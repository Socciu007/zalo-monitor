import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { flushPending } from "./flush.js";
import { buildRecordId, enqueueCapture, listPendingRecords, type PendingRecord } from "./queue.js";

function makeRecord(id: string, receivedAt: string): PendingRecord {
  return {
    id: buildRecordId("g1", id),
    messageId: id,
    platform: "zalo",
    content: `nội dung ${id}`,
    groupId: "g1",
    groupName: "G",
    userId: "u1",
    senderName: "An",
    mentioned: false,
    receivedAt,
  };
}

test("flushPending gửi hết pending và xoá file sau 2xx", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-flush-"));
  await enqueueCapture(dir, makeRecord("m1", "2026-11-24T10:00:00.000Z"));
  await enqueueCapture(dir, makeRecord("m2", "2026-11-24T10:00:01.000Z"));
  const received: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => { received.push(body); res.writeHead(200); res.end("{}"); });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address() as AddressInfo;
  try {
    await flushPending(dir, { backendUrl: `http://127.0.0.1:${port}/x`, timeoutMs: 2000, maxAttempts: 2, retryDelaysMs: [1, 1] });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
  assert.equal(received.length, 2);
  assert.equal((await listPendingRecords(dir)).length, 0);
});

test("flushPending dừng khi backend lỗi mạng và giữ pending", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-flush-"));
  await enqueueCapture(dir, makeRecord("m1", "2026-11-24T10:00:00.000Z"));
  await flushPending(dir, { backendUrl: "http://127.0.0.1:1/none", timeoutMs: 500, maxAttempts: 1, retryDelaysMs: [] });
  assert.equal((await listPendingRecords(dir)).length, 1);
});
