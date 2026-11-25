import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureStateDirs, readJsonIfExists, resolvePendingDir, resolveRejectedDir, resolveStatusPath, writeJsonAtomic } from "./state.js";

test("ensureStateDirs tạo pending/ và pending/rejected/", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await ensureStateDirs(dir);
  assert.ok((await stat(resolvePendingDir(dir))).isDirectory());
  assert.ok((await stat(resolveRejectedDir(dir))).isDirectory());
  assert.ok((await stat(path.join(dir, "pending"))).isDirectory());
  assert.ok((await stat(path.join(dir, "pending", "rejected"))).isDirectory());
});

test("writeJsonAtomic ghi file JSON hợp lệ, không để lại file .tmp", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, "nested", "value.json");
  await writeJsonAtomic(target, { a: 1 });
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { a: 1 });
  const leftovers = (await readdir(path.dirname(target))).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("writeJsonAtomic dọn file .tmp khi rename thất bại", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, "value.json");
  await mkdir(path.join(target, "child"), { recursive: true });
  await assert.rejects(() => writeJsonAtomic(target, { a: 1 }));
  const leftovers = (await readdir(dir)).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("readJsonIfExists trả null khi file không tồn tại hoặc JSON hỏng", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await readJsonIfExists(path.join(dir, "missing.json")), null);
  const broken = path.join(dir, "broken.json");
  await writeFile(broken, "{not json", "utf8");
  assert.equal(await readJsonIfExists(broken), null);
});

test("resolveStatusPath nằm trong state dir", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(resolveStatusPath(dir), path.join(dir, "status.json"));
});
