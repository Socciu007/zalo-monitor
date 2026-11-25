import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setCaptureStateDir } from "./capture.js";
import { enqueueCapture, listPendingRecords, type PendingRecord } from "./queue.js";
import { startCaptureRuntime } from "./runtime.js";

const record: PendingRecord = {
  id: "rec-1",
  messageId: "m1",
  platform: "zalo",
  content: "xin chào",
  groupId: "g1",
  groupName: "G",
  userId: "u1",
  senderName: "An",
  mentioned: false,
  receivedAt: "2026-11-24T10:00:00.000Z",
};

/** Chờ có điều kiện thỏa mãn trong hạn chót — không dùng sleep cố định. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("startCaptureRuntime replay backlog bằng backendUrl trong plugin config", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-runtime-"));
  setCaptureStateDir(dir);
  await enqueueCapture(dir, record);
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => { bodies.push(body); res.writeHead(200); res.end("{}"); });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address() as AddressInfo;
  try {
    startCaptureRuntime({ backendUrl: `http://127.0.0.1:${port}/x`, timeoutMs: 2_000, maxAttempts: 1, retryDelaysMs: [] });
    assert.ok(await waitFor(() => bodies.length > 0), "không có request nào tới backend đã cấu hình");
    assert.equal(bodies.length, 1);
    assert.deepEqual(JSON.parse(bodies[0] ?? "{}"), {
      platform: "zalo",
      content: "xin chào",
      groupId: "g1",
      groupName: "G",
      userId: "u1",
      senderName: "An",
    });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (await listPendingRecords(dir)).length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal((await listPendingRecords(dir)).length, 0, "record pending phải được xoá sau khi giao");
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
});
