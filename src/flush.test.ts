import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { flushPending } from "./flush.js";
import { buildRecordId, enqueueCapture, listPendingRecords, readStatus, type PendingRecord } from "./queue.js";

function makeRecord(id: string, receivedAt: string, content = `nội dung ${id}`): PendingRecord {
  return {
    id: buildRecordId("g1", id),
    messageId: id,
    platform: "zalo",
    content,
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

test("flushPending bỏ qua record đã giao trước đó và dọn file pending sót lại", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-flush-"));
  const record = makeRecord("m1", "2026-11-24T10:00:00.000Z");
  // Tin đã được giao trước đó (đã có checkpoint) nhưng file pending còn sót lại.
  await writeFile(
    path.join(dir, "checkpoint.json"),
    JSON.stringify({ g1: { m1: { at: "2026-11-24T10:00:00.000Z" } } }),
    "utf8",
  );
  await enqueueCapture(dir, record);
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    res.writeHead(200);
    res.end("{}");
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address() as AddressInfo;
  try {
    await flushPending(dir, { backendUrl: `http://127.0.0.1:${port}/x`, timeoutMs: 2000, maxAttempts: 2, retryDelaysMs: [1, 1] });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
  assert.equal(calls, 0, "tin đã có checkpoint không được gửi lại");
  assert.equal((await listPendingRecords(dir)).length, 0, "file pending sót lại phải bị dọn");
});

test("flush không quét lại thư mục pending sau mỗi record", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-flush-"));
  for (let i = 0; i < 5; i += 1) {
    await enqueueCapture(dir, makeRecord(`m${i}`, new Date(Date.UTC(2026, 10, 24, 10, 0, i)).toISOString()));
  }
  // File lạ xuất hiện trong pending/ giữa lúc flush. Nếu status.json còn được
  // tính lại bằng cách quét thư mục sau mỗi record, giá trị pending cuối cùng
  // sẽ là 1 (file lạ) thay vì 0.
  const stray = path.join(dir, "pending", "stray.json");
  let strayWritten = false;
  const server = http.createServer((req, res) => {
    req.resume();
    void (async () => {
      if (!strayWritten) {
        strayWritten = true;
        await writeFile(stray, JSON.stringify(makeRecord("stray", "2026-11-24T10:00:09.000Z")), "utf8");
      }
      res.writeHead(200);
      res.end("{}");
    })();
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address() as AddressInfo;
  try {
    await flushPending(dir, { backendUrl: `http://127.0.0.1:${port}/x`, timeoutMs: 2000, maxAttempts: 1, retryDelaysMs: [] });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
  const status = await readStatus(dir);
  assert.equal(status.pending, 0, "status.pending phải lấy từ số liệu đo sẵn, không quét lại thư mục");
  assert.equal(status.rejected, 0);
});

/**
 * File rác trong `pending/`: nội dung không phải record nên `listPendingRecords`
 * đọc xong bỏ qua. Chúng làm chi phí MỘT LẦN quét thư mục to hơn, nên nếu flush
 * quét lại thư mục sau mỗi record thì tổng thời gian nhảy theo bậc hai — đúng
 * thứ ta muốn phát hiện. Payload thật vẫn nhỏ để phần tuyến tính (gửi mạng)
 * không bị nhiễu bởi dung lượng dữ liệu.
 */
async function seedNoiseFiles(dir: string, count: number): Promise<void> {
  const pendingDir = path.join(dir, "pending");
  for (let i = 0; i < count; i += 1) {
    await writeFile(path.join(pendingDir, `noise-${i}.json`), JSON.stringify({ noise: true }), "utf8");
  }
}

async function timeFlush(count: number): Promise<{ elapsedMs: number; requests: number }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-flush-"));
  for (let i = 0; i < count; i += 1) {
    await enqueueCapture(dir, makeRecord(`m${i}`, new Date(Date.UTC(2026, 10, 24, 10, 0, 0, i)).toISOString()));
  }
  await seedNoiseFiles(dir, count * 10);
  let requests = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    requests += 1;
    res.writeHead(200);
    res.end("{}");
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address() as AddressInfo;
  const started = performance.now();
  try {
    await flushPending(dir, { backendUrl: `http://127.0.0.1:${port}/x`, timeoutMs: 10_000, maxAttempts: 1, retryDelaysMs: [] });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
  return { elapsedMs: performance.now() - started, requests };
}

test("flush chạy tuyến tính theo số record, không quét lại queue theo bậc hai", async () => {
  // Chạy xen kẽ và lấy kết quả nhanh nhất của mỗi bên: một lần nghẽn tạm thời
  // của hệ điều hành (GC, quét virus) không được làm fail test.
  const runs = 3;
  let small = Number.POSITIVE_INFINITY;
  let large = Number.POSITIVE_INFINITY;
  let smallRequests = 0;
  let largeRequests = 0;
  for (let round = 0; round < runs; round += 1) {
    const smallRun = await timeFlush(40);
    small = Math.min(small, smallRun.elapsedMs);
    smallRequests = smallRun.requests;
    const largeRun = await timeFlush(80);
    large = Math.min(large, largeRun.elapsedMs);
    largeRequests = largeRun.requests;
  }
  console.log(
    `[flush timing] N=40: ${small.toFixed(0)}ms (${smallRequests} request) — ` +
      `N=80: ${large.toFixed(0)}ms (${largeRequests} request) — ` +
      `tỉ lệ ${(large / small).toFixed(2)}×`,
  );
  assert.equal(smallRequests, 40);
  assert.equal(largeRequests, 80);
  // Tuyến tính ⇒ N=80 tốn khoảng 2× N=40; quét lại thư mục sau mỗi record ⇒ ~4×.
  // Ngưỡng 3× tách hai trường hợp rõ ràng.
  assert.ok(
    large < small * 3,
    `flush N=80 phải < 3× flush N=40 (N=40: ${small.toFixed(0)}ms, N=80: ${large.toFixed(0)}ms)`,
  );
});
