import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureZaloMessage, getLastCaptureSettings, setCaptureStateDir, setLastCaptureSettings } from "./capture.js";
import { DEFAULT_CAPTURE_SETTINGS } from "./config.js";
import { listPendingRecords } from "./queue.js";

/** Chờ có điều kiện thỏa mãn trong hạn chót — không dùng sleep cố định. */
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("captureZaloMessage gửi đúng 1 tin group lên backend với payload 6 field", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-capture-"));
  setCaptureStateDir(dir);
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => { bodies.push(body); res.writeHead(200); res.end("{}"); });
  });
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
    // Chờ request tới backend VÀ queue được dọn xong (tức là lượt giao đã xong).
    const delivered = await waitUntil(async () => bodies.length > 0 && (await listPendingRecords(dir)).length === 0);
    assert.ok(delivered, "backend không nhận được request nào trong 5 giây");
    assert.equal(bodies.length, 1, "phải gửi đúng 1 request");
    const payload = JSON.parse(bodies[0] ?? "{}") as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(payload).sort(),
      ["content", "groupId", "groupName", "platform", "senderName", "userId"],
    );
    assert.deepEqual(payload, {
      platform: "zalo",
      content: "xin chào",
      groupId: "g1",
      groupName: "G",
      userId: "u1",
      senderName: "An",
    });
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
  // Đường DM dừng ngay ở tap (không enqueue) → kiểm tra được ngay, không cần sleep.
  assert.equal((await listPendingRecords(dir)).length, 0);
});

test("setLastCaptureSettings nạp settings cache cho timer flush", () => {
  setLastCaptureSettings({ ...DEFAULT_CAPTURE_SETTINGS, backendUrl: "http://example.test/x", flushIntervalMs: 1_234 });
  assert.equal(getLastCaptureSettings().backendUrl, "http://example.test/x");
  assert.equal(getLastCaptureSettings().flushIntervalMs, 1_234);
});
