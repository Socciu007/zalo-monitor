import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function readMonitorSource(): Promise<string> {
  const distDir = path.join(repoRoot, "dist", "zalouser");
  const entries = await readdir(distDir);
  for (const entry of entries) {
    if (!entry.endsWith(".js")) continue;
    const text = await readFile(path.join(distDir, entry), "utf8");
    if (text.includes("async function processMessage(")) return text;
  }
  throw new Error("không tìm thấy file monitor trong dist/zalouser");
}

test("tap nằm sau access gate và trước mention gate", async () => {
  const source = await readMonitorSource();
  const accessGate = source.indexOf("routeAccess.allowed");
  const senderGate = source.indexOf("accessDecision.senderAccess");
  const tap = source.indexOf("captureZaloMessage({");
  const mentionGate = source.indexOf("mentionDecision.shouldSkip");
  assert.ok(accessGate > 0, "không thấy group access gate");
  assert.ok(senderGate > 0, "không thấy sender access gate");
  assert.ok(tap > 0, "không thấy tap");
  assert.ok(mentionGate > 0, "không thấy mention gate");
  assert.ok(tap > accessGate, "tap phải nằm sau group access gate");
  assert.ok(tap > senderGate, "tap phải nằm sau sender access gate");
  assert.ok(tap < mentionGate, "tap phải nằm trước mention gate");
});

test("tap truyền đủ field (content, groupId, groupName, userId, senderName, mentioned)", async () => {
  const source = await readMonitorSource();
  const tap = source.indexOf("captureZaloMessage({");
  assert.ok(tap > 0);
  const block = source.slice(tap, tap + 600);
  for (const field of ["rawBody", "chatId", "groupName", "senderId", "senderName", "mentioned", "messageId", "rootConfig"]) {
    assert.ok(block.includes(field), `tap thiếu field ${field}`);
  }
});

test("bản vendor có import capture từ ../capture.js", async () => {
  const source = await readMonitorSource();
  assert.ok(source.includes('import { captureZaloMessage } from "../capture.js";'));
});

test("tap lấy message.content (chưa trim) chứ không phải rawBody đã trim", async () => {
  const source = await readMonitorSource();
  const tap = source.indexOf("captureZaloMessage({");
  assert.ok(tap > 0);
  const block = source.slice(tap, tap + 600);
  assert.ok(block.includes("rawBody: message.content"), "tap phải lấy message.content để giữ nguyên văn");
  assert.ok(!/rawBody,\s*\n/.test(block), "tap không được dùng biến rawBody (đã bị trim)");
});

test("dist/capture.js export captureZaloMessage", async () => {
  const mod = await import(pathToFileURL(path.join(repoRoot, "dist", "capture.js")).href);
  assert.equal(typeof mod.captureZaloMessage, "function");
});
