import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureStateDirs, readJsonIfExists, resolvePendingDir, resolveRejectedDir, resolveStatusPath, writeJsonAtomic } from "./state.js";

test("ensureStateDirs tạo pending/ và pending/rejected/", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-state-"));
  await ensureStateDirs(dir);
  const { stat } = await import("node:fs/promises");
  assert.ok((await stat(resolvePendingDir(dir))).isDirectory());
  assert.ok((await stat(resolveRejectedDir(dir))).isDirectory());
});

test("writeJsonAtomic ghi file JSON hợp lệ, không để lại file .tmp", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-state-"));
  const target = path.join(dir, "nested", "value.json");
  await writeJsonAtomic(target, { a: 1 });
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { a: 1 });
  const { readdir } = await import("node:fs/promises");
  const leftovers = (await readdir(path.dirname(target))).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("readJsonIfExists trả null khi file không tồn tại hoặc JSON hỏng", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-state-"));
  assert.equal(await readJsonIfExists(path.join(dir, "missing.json")), null);
  const broken = path.join(dir, "broken.json");
  await writeFile(broken, "{not json", "utf8");
  assert.equal(await readJsonIfExists(broken), null);
});

test("resolveStatusPath nằm trong state dir", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-state-"));
  assert.equal(resolveStatusPath(dir), path.join(dir, "status.json"));
});
