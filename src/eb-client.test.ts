import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { postCaptureToBackend } from "./eb-client.js";
import type { BackendPayload } from "./normalize.js";

const payload: BackendPayload = {
  platform: "zalo",
  content: "xin chào",
  groupId: "1",
  groupName: "G",
  userId: "2",
  senderName: "An",
};

async function withServer(
  status: number,
  onBody: (body: string) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      onBody(body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/analyze`);
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
}

test("2xx → delivered, body gửi đúng 6 field", async () => {
  let received = "";
  await withServer(201, (body) => { received = body; }, async (url) => {
    const outcome = await postCaptureToBackend({ backendUrl: url, timeoutMs: 2000, maxAttempts: 4, retryDelaysMs: [1, 1, 1] }, payload);
    assert.equal(outcome.kind, "delivered");
    assert.equal(outcome.status, 201);
    assert.deepEqual(Object.keys(JSON.parse(received)).sort(), ["content", "groupId", "groupName", "platform", "senderName", "userId"]);
    assert.deepEqual(JSON.parse(received), payload);
  });
});

test("4xx → rejected, không retry (đúng 1 request)", async () => {
  let calls = 0;
  await withServer(400, () => { calls += 1; }, async (url) => {
    const outcome = await postCaptureToBackend({ backendUrl: url, timeoutMs: 2000, maxAttempts: 4, retryDelaysMs: [1, 1, 1] }, payload);
    assert.equal(outcome.kind, "rejected");
    assert.equal(calls, 1);
    if (outcome.kind !== "rejected") throw new Error("expected rejected");
    assert.equal(outcome.error, "post_rejected_4xx:400");
  });
});

test("429 → failed, retry đủ maxAttempts (không bị đẩy vào rejected)", async () => {
  let calls = 0;
  await withServer(429, () => { calls += 1; }, async (url) => {
    const outcome = await postCaptureToBackend({ backendUrl: url, timeoutMs: 2000, maxAttempts: 4, retryDelaysMs: [1, 1, 1] }, payload);
    assert.equal(outcome.kind, "failed");
    assert.equal(calls, 4);
    assert.equal(outcome.status, 429);
    if (outcome.kind !== "failed") throw new Error("expected failed");
    assert.equal(outcome.error, "post_failed_retryable_4xx:429");
  });
});

test("408 → failed, retry đủ maxAttempts (không bị đẩy vào rejected)", async () => {
  let calls = 0;
  await withServer(408, () => { calls += 1; }, async (url) => {
    const outcome = await postCaptureToBackend({ backendUrl: url, timeoutMs: 2000, maxAttempts: 4, retryDelaysMs: [1, 1, 1] }, payload);
    assert.equal(outcome.kind, "failed");
    assert.equal(calls, 4);
    assert.equal(outcome.status, 408);
    if (outcome.kind !== "failed") throw new Error("expected failed");
    assert.equal(outcome.error, "post_failed_retryable_4xx:408");
  });
});

test("5xx → failed, retry tối đa 4 request", async () => {
  let calls = 0;
  await withServer(500, () => { calls += 1; }, async (url) => {
    const outcome = await postCaptureToBackend({ backendUrl: url, timeoutMs: 2000, maxAttempts: 4, retryDelaysMs: [1, 1, 1] }, payload);
    assert.equal(outcome.kind, "failed");
    assert.equal(calls, 4);
  });
});

test("lỗi mạng → failed", async () => {
  const outcome = await postCaptureToBackend({ backendUrl: "http://127.0.0.1:1/none", timeoutMs: 1000, maxAttempts: 2, retryDelaysMs: [1, 1] }, payload);
  assert.equal(outcome.kind, "failed");
});
