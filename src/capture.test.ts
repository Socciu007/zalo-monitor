import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureZaloMessage, setCaptureStateDir } from "./capture.js";
import { listPendingRecords } from "./queue.js";

test("captureZaloMessage ghi pending cho tin group và không throw", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-capture-"));
  setCaptureStateDir(dir);
  const server = http.createServer((req, res) => { res.writeHead(200); res.end("{}"); });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address() as AddressInfo;
  try {
    captureZaloMessage({
      isGroup: true,
      chatId: "g1",
      groupName: "G",
      senderId: "u1",
      senderName: "An",
      rawBody: "xin chào",
      mentioned: false,
      messageId: "m1",
      rootConfig: { plugins: { entries: { "zalo-monitor": { config: { backendUrl: `http://127.0.0.1:${port}/x`, maxAttempts: 1, retryDelaysMs: [] } } } } },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await listPendingRecords(dir)).length, 0);
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
});

test("captureZaloMessage bỏ qua tin DM khi captureDm=false", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-capture-"));
  setCaptureStateDir(dir);
  captureZaloMessage({
    isGroup: false,
    chatId: "u1",
    groupName: "",
    senderId: "u1",
    senderName: "An",
    rawBody: "dm",
    mentioned: false,
    messageId: "dm-1",
    rootConfig: {},
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await listPendingRecords(dir)).length, 0);
});
