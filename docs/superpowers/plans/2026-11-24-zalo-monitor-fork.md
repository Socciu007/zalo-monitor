# zalo-monitor (fork zalouser) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Xây một plugin openclaw `zalo-monitor` — bản fork của channel plugin `zalouser` — cắm một capture tap **trước mention gate** để mọi tin nhắn Zalo trong group (kể cả tin không tag bot) được ghi vào queue bền vững và POST nguyên văn lên backend, trong khi bot vẫn chỉ trả lời tin nhắn tag nó.

**Architecture:** `vendor/zalouser/` chứa bản `@openclaw/zalouser` đã patch (thêm 1 import + 1 lệnh gọi `captureZaloMessage(...)` ngay trước khối mention gate trong `processMessage`). `src/` chứa code của ta: `capture.ts` (tap, fire-and-forget), `queue.ts` (queue bền vững + checkpoint + status), `eb-client.ts` (POST backend + retry/backoff), `flush.ts` (worker gửi), `config.ts` (đọc `plugins.entries["zalo-monitor"].config`), `state.ts` (đường dẫn + atomic write), `normalize.ts` (payload 6 field). Build (`tsc` + copy vendor) sinh ra `dist/` — đây là extension directory openclaw nạp.

**Tech Stack:** TypeScript (ESM, `module: NodeNext`), Node 22, `node --test`, openclaw plugin SDK (`openclaw/plugin-sdk/channel-entry-contract`, `openclaw/plugin-sdk/state-paths`, `openclaw/plugin-sdk/logging-core`), `zca-js` (kế thừa từ bản vendor).

**Spec:** `docs/superpowers/specs/2026-11-24-zalo-monitor-fork-design.md`

---

## Bối cảnh quan trọng (đã verify, không cần verify lại)

- Mention gate của `zalouser` nằm trong `processMessage()` của `dist/monitor-*.js` và `return` **trước** `core.channel.inbound.dispatchReply()` → host không thấy tin group không tag. Tap phải nằm giữa access gate và mention gate.
- Anchor chèn tap (tab-indented, đúng 1 chỗ):
  `\tif (isGroup && requireMention && !canDetectMention && !mentionDecision.effectiveWasMentioned) {`
- Tên file chứa `processMessage` **không cố định** → script patch phải dò file theo nội dung.
- Tất cả `import` của file vendor nằm ở đầu file, mỗi import một dòng, cột 0.
- `resolveZalouserMessageSid` đã được import sẵn trong file monitor (alias `o`).
- `config` trong `processMessage` là **root OpenClawConfig** (đã xác nhận qua `config.channels?.zalouser`).
- `defineBundledChannelEntry` chỉ load được module **bên trong thư mục chứa entry** (boundary root = `dirname(importMetaUrl)`) → entry và code vendor phải cùng nằm trong `dist/`.
- `openclaw.extensions` và `openclaw.runtimeExtensions` phải **cùng độ dài** (song song 1-1).
- `package.json#openclaw.channel` giữ nguyên từ bản vendor để không mất alias `zlu` và metadata channel.

---

## Cấu trúc file (lock trước khi code)

| File | Trách nhiệm |
|---|---|
| `package.json` | metadata plugin, scripts, deps, `openclaw.extensions`/`runtimeExtensions`/`setupEntry`/`channel` |
| `openclaw.plugin.json` | manifest: id `zalo-monitor`, `channels: ["zalouser"]`, `configSchema` (config plugin), `channelConfigs.zalouser` (schema channel + `preferOver`) |
| `tsconfig.json` | TS → `dist/`, ESM NodeNext |
| `.gitignore` | `node_modules/`, `dist/` |
| `src/index.ts` | entry plugin (channel entry) |
| `src/setup-entry.ts` | entry setup (QR login) |
| `src/state.ts` | resolve state dir, atomic JSON write, đọc JSON an toàn |
| `src/normalize.ts` | payload 6 field |
| `src/config.ts` | đọc + validate `plugins.entries["zalo-monitor"].config` |
| `src/eb-client.ts` | POST backend, retry/backoff |
| `src/queue.ts` | pending/rejected/checkpoint/status |
| `src/flush.ts` | worker gửi pending (single-flight) |
| `src/capture.ts` | tap entry (fire-and-forget, fail-safe) |
| `src/*.test.ts` | unit test (chạy trên JS đã build) |
| `vendor/zalouser/**` | bản `@openclaw/zalouser` đã patch, commit vào repo |
| `scripts/vendor-refresh.mjs` | copy bản npm mới từ `node_modules` → patch → swap vào `vendor/zalo-monitor` |
| `scripts/clean-dist.mjs` | xoá `dist/` trước khi build (tsc không tự dọn) |
| `scripts/copy-vendor.mjs` | copy `vendor/zalouser/dist` → `dist/zalouser` (build) |

---

### Task 1: Repo skeleton + toolchain

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/index.ts` (placeholder tạm, sẽ thay ở Task 8)

- [ ] **Step 1: Tạo `package.json`**

```json
{
  "name": "zalo-monitor",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "OpenClaw Zalo Personal fork that captures every Zalo group message (including untagged ones) and forwards it verbatim to a backend.",
  "scripts": {
    "build": "node scripts/clean-dist.mjs && tsc -p tsconfig.json && node scripts/copy-vendor.mjs",
    "test": "npm run build && node --test \"dist/**/*.test.js\"",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "vendor:refresh": "node scripts/vendor-refresh.mjs"
  },
  "dependencies": {
    "zca-js": "2.1.2",
    "typebox": "1.1.38",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@openclaw/zalouser": "2026.5.28",
    "@types/node": "22.18.1",
    "openclaw": "2026.5.28",
    "typescript": "5.9.3"
  },
  "peerDependencies": {
    "openclaw": ">=2026.5.28"
  },
  "peerDependenciesMeta": {
    "openclaw": {
      "optional": true
    }
  },
  "openclaw": {
    "extensions": [
      "./src/index.ts"
    ],
    "runtimeExtensions": [
      "./dist/index.js"
    ],
    "setupEntry": "./src/setup-entry.ts",
    "runtimeSetupEntry": "./dist/setup-entry.js",
    "compat": {
      "pluginApi": ">=2026.5.28"
    },
    "build": {
      "openclawVersion": "2026.5.28"
    },
    "channel": {
      "id": "zalouser",
      "label": "Zalo Personal",
      "selectionLabel": "Zalo (Personal Account)",
      "docsPath": "/channels/zalouser",
      "docsLabel": "zalouser",
      "blurb": "Zalo personal account via QR code login.",
      "aliases": [
        "zlu"
      ],
      "order": 85,
      "quickstartAllowFrom": false,
      "doctorCapabilities": {
        "dmAllowFromMode": "topOnly",
        "groupModel": "hybrid",
        "groupAllowFromFallbackToAllowFrom": false,
        "warnOnEmptyGroupSenderAllowlist": false
      },
      "preferOver": [
        "zalouser"
      ]
    }
  }
}
```

> **Ghi chú (sửa sau code review Task 1):**
> - `typebox` + `zod` là dependency **bắt buộc**: code vendor import tĩnh chúng
>   (`dist/shared-*.js` → `zod`, `dist/api-*.js` → `typebox`). Vendor copy không mang
>   `node_modules` theo → phải khai báo ở package của ta, đúng version upstream.
> - `node --test dist/` **hỏng** trên Node 22 (Node thử `require()` chính thư mục →
>   `MODULE_NOT_FOUND`). Phải dùng glob `node --test "dist/**/*.test.js"`. Glob cũng an toàn
>   hơn: `dist/` sẽ chứa ~20 file vendor, tuyệt đối không được chạy như test.
> - `openclaw.channel.preferOver: ["zalouser"]` khai báo quyền ưu tiên của plugin id
>   `zalo-monitor` so với plugin npm `zalouser` ngay từ Task 1 (manifest Task 10 vẫn là
>   nguồn ưu tiên chính: `existing.preferOver ?? packageChannel.preferOver`).

- [ ] **Step 2: Tạo `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "sourceMap": false,
    "declaration": false,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Tạo `.gitignore`**

```
node_modules/
dist/
```

- [ ] **Step 4: Tạo `src/index.ts` tạm (placeholder, Task 8 sẽ thay)**

```ts
export default { id: "zalo-monitor", name: "Zalo Monitor" };
```

- [ ] **Step 5: Cài deps**

Run: `npm install --legacy-peer-deps`
Expected: exit 0, `node_modules/openclaw` và `node_modules/@openclaw/zalouser` tồn tại.

- [ ] **Step 6: Verify toolchain**

Run: `npx tsc -p tsconfig.json --noEmit && node -e "console.log('ok')"`
Expected: không lỗi TS, in `ok`.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json .gitignore src/index.ts
git commit -m "chore: scaffold zalo-monitor plugin package"
```

---

### Task 2: `src/state.ts` — state dir + atomic JSON

**Files:**
- Create: `src/state.ts`
- Create: `src/state.test.ts`

- [ ] **Step 1: Viết test fail**

```ts
// src/state.test.ts
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
```

- [ ] **Step 2: Chạy test để thấy fail**

Run: `npx tsc -p tsconfig.json && node --test dist/state.test.js`
Expected: FAIL — `Cannot find module './state.js'`.

- [ ] **Step 3: Viết implementation**

```ts
// src/state.ts
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

export const PLUGIN_ID = "zalo-monitor";

export function resolvePluginStateDir(): string {
  return path.join(resolveStateDir(), "plugin-state", PLUGIN_ID);
}

export function resolvePendingDir(stateDir: string): string {
  return path.join(stateDir, "pending");
}

export function resolveRejectedDir(stateDir: string): string {
  return path.join(stateDir, "pending", "rejected");
}

export function resolveCheckpointPath(stateDir: string): string {
  return path.join(stateDir, "checkpoint.json");
}

export function resolveStatusPath(stateDir: string): string {
  return path.join(stateDir, "status.json");
}

export async function ensureStateDirs(stateDir: string): Promise<void> {
  await mkdir(resolvePendingDir(stateDir), { recursive: true });
  await mkdir(resolveRejectedDir(stateDir), { recursive: true });
}

/** Ghi JSON bằng tmp-file + rename để không bao giờ để lại file nửa vời. */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await renameWithRetry(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** JSON hỏng hoặc file không tồn tại → null (không được làm sập plugin). */
export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

const RENAME_MAX_ATTEMPTS = 5;
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Windows hay trả EPERM khi target đang bị tranh chấp — thử lại vài lần rồi mới bỏ. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw err;
      lastError = err;
      const delay = RENAME_RETRY_DELAYS_MS[attempt] ?? RENAME_RETRY_DELAYS_MS[RENAME_RETRY_DELAYS_MS.length - 1] ?? 100;
      await sleep(delay);
    }
  }
  throw lastError;
}
```

> **Sửa sau code review Task 2:** `rename` phải retry `EPERM`/`EBUSY`/`EACCES` — đo thật trên
> Windows: 8 writer đồng thời cùng target → **4 fail `EPERM`**; 8 writer khác target → 8/8 OK.
> `checkpoint.json` / `status.json` là singleton read-modify-write nên sẽ chập chờn nếu không retry.
> Lỗi không tạm thời (`ENOTEMPTY`, `ENOENT`…) phải ném ngay, không retry.
> Test phải **chốt tên thư mục literal** (`pending/`, `pending/rejected/`) — test cũ dùng resolver
> cho cả lúc tạo lẫi lúc assert nên đổi tên resolver vẫn xanh.
> Phải có test cho **error path**: rename fail (target là thư mục non-empty) → error ném ra và
> **không còn file `.tmp-`**.

- [ ] **Step 4: Chạy test để thấy pass**

Run: `npx tsc -p tsconfig.json && node --test dist/state.test.js`
Expected: PASS — 4 test pass.

- [ ] **Step 5: Commit**

```bash
git add src/state.ts src/state.test.ts
git commit -m "feat(state): add state dir helpers and atomic JSON writes"
```

---

### Task 3: `src/normalize.ts` — payload 6 field

**Files:**
- Create: `src/normalize.ts`
- Create: `src/normalize.test.ts`

- [ ] **Step 1: Viết test fail**

```ts
// src/normalize.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCapture } from "./normalize.js";

test("normalizeCapture trả đúng 6 field của backend", () => {
  const payload = normalizeCapture({
    rawBody: "  Xin chào  ",
    chatId: "123456",
    groupName: "Nhóm Test",
    senderId: "999",
    senderName: "An",
  });
  assert.deepEqual(Object.keys(payload).sort(), ["content", "groupId", "groupName", "platform", "senderName", "userId"]);
  assert.equal(payload.platform, "zalo");
  assert.equal(payload.content, "  Xin chào  ");
  assert.equal(payload.groupId, "123456");
  assert.equal(payload.groupName, "Nhóm Test");
  assert.equal(payload.userId, "999");
  assert.equal(payload.senderName, "An");
});

test("normalizeCapture không sửa nội dung (giữ newline, emoji, @tag)", () => {
  const raw = "dòng 1\ndòng 2 🚢 @bot ơi";
  const payload = normalizeCapture({ rawBody: raw, chatId: "1", groupName: "", senderId: "2", senderName: "" });
  assert.equal(payload.content, raw);
});

test("normalizeCapture dùng chuỗi rỗng cho groupName/senderName thiếu", () => {
  const payload = normalizeCapture({ rawBody: "x", chatId: "1", groupName: undefined, senderId: "2", senderName: undefined });
  assert.equal(payload.groupName, "");
  assert.equal(payload.senderName, "");
});
```

- [ ] **Step 2: Chạy test để thấy fail**

Run: `npx tsc -p tsconfig.json && node --test dist/normalize.test.js`
Expected: FAIL — `Cannot find module './normalize.js'`.

- [ ] **Step 3: Viết implementation**

```ts
// src/normalize.ts
export interface CaptureInput {
  rawBody: string;
  chatId: string;
  groupName?: string | undefined;
  senderId: string;
  senderName?: string | undefined;
  platform?: string | undefined;
}

/** Đúng 6 field backend mong đợi — không thêm, không bớt. */
export interface BackendPayload {
  platform: string;
  content: string;
  groupId: string;
  groupName: string;
  userId: string;
  senderName: string;
}

export const DEFAULT_PLATFORM = "zalo";

export function normalizeCapture(input: CaptureInput): BackendPayload {
  return {
    platform: input.platform ?? DEFAULT_PLATFORM,
    content: input.rawBody,
    groupId: input.chatId,
    groupName: input.groupName ?? "",
    userId: input.senderId,
    senderName: input.senderName ?? "",
  };
}
```

- [ ] **Step 4: Chạy test để thấy pass**

Run: `npx tsc -p tsconfig.json && node --test dist/normalize.test.js`
Expected: PASS — 3 test pass.

- [ ] **Step 5: Commit**

```bash
git add src/normalize.ts src/normalize.test.ts
git commit -m "feat(normalize): build the 6-field backend payload"
```

---

### Task 4: `src/config.ts` — đọc config plugin

**Files:**
- Create: `src/config.ts`
- Create: `src/config.test.ts`

- [ ] **Step 1: Viết test fail**

```ts
// src/config.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CAPTURE_SETTINGS, resolveCaptureSettings } from "./config.js";

test("resolveCaptureSettings trả default khi không có config", () => {
  assert.deepEqual(resolveCaptureSettings(undefined), DEFAULT_CAPTURE_SETTINGS);
  assert.deepEqual(resolveCaptureSettings({}), DEFAULT_CAPTURE_SETTINGS);
});

test("resolveCaptureSettings đọc plugins.entries['zalo-monitor'].config", () => {
  const settings = resolveCaptureSettings({
    plugins: { entries: { "zalo-monitor": { config: { backendUrl: "http://example.test/x", timeoutMs: 250, maxAttempts: 2, retryDelaysMs: [5, 10], captureDm: true } } } },
  });
  assert.equal(settings.backendUrl, "http://example.test/x");
  assert.equal(settings.timeoutMs, 250);
  assert.equal(settings.maxAttempts, 2);
  assert.deepEqual(settings.retryDelaysMs, [5, 10]);
  assert.equal(settings.captureDm, true);
});

test("resolveCaptureSettings bỏ qua giá trị sai kiểu, giữ default", () => {
  const settings = resolveCaptureSettings({
    plugins: { entries: { "zalo-monitor": { config: { backendUrl: 123, timeoutMs: -1, maxAttempts: 0, retryDelaysMs: "nope" } } } },
  });
  assert.deepEqual(settings, DEFAULT_CAPTURE_SETTINGS);
});
```

- [ ] **Step 2: Chạy test để thấy fail**

Run: `npx tsc -p tsconfig.json && node --test dist/config.test.js`
Expected: FAIL — `Cannot find module './config.js'`.

- [ ] **Step 3: Viết implementation**

```ts
// src/config.ts
export interface CaptureSettings {
  backendUrl: string;
  timeoutMs: number;
  maxAttempts: number;
  retryDelaysMs: number[];
  captureDm: boolean;
  flushIntervalMs: number;
}

export const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = {
  backendUrl: "http://localhost:3001/clientV2/sdAnalysis/analyzeAndSaveSdData",
  timeoutMs: 10_000,
  maxAttempts: 4,
  retryDelaysMs: [1_000, 4_000, 16_000],
  captureDm: false,
  flushIntervalMs: 60_000,
};

function readPluginConfig(rootConfig: unknown): Record<string, unknown> | undefined {
  if (!rootConfig || typeof rootConfig !== "object") return undefined;
  const plugins = (rootConfig as Record<string, unknown>).plugins;
  if (!plugins || typeof plugins !== "object") return undefined;
  const entries = (plugins as Record<string, unknown>).entries;
  if (!entries || typeof entries !== "object") return undefined;
  const entry = (entries as Record<string, unknown>)["zalo-monitor"];
  if (!entry || typeof entry !== "object") return undefined;
  const config = (entry as Record<string, unknown>).config;
  if (!config || typeof config !== "object") return undefined;
  return config as Record<string, unknown>;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function resolveCaptureSettings(rootConfig: unknown): CaptureSettings {
  const raw = readPluginConfig(rootConfig);
  const settings: CaptureSettings = { ...DEFAULT_CAPTURE_SETTINGS, retryDelaysMs: [...DEFAULT_CAPTURE_SETTINGS.retryDelaysMs] };
  if (!raw) return settings;
  if (typeof raw.backendUrl === "string" && raw.backendUrl.trim()) settings.backendUrl = raw.backendUrl.trim();
  const timeoutMs = positiveInt(raw.timeoutMs);
  if (timeoutMs !== undefined) settings.timeoutMs = timeoutMs;
  const maxAttempts = positiveInt(raw.maxAttempts);
  if (maxAttempts !== undefined) settings.maxAttempts = maxAttempts;
  const flushIntervalMs = positiveInt(raw.flushIntervalMs);
  if (flushIntervalMs !== undefined) settings.flushIntervalMs = flushIntervalMs;
  if (Array.isArray(raw.retryDelaysMs)) {
    const delays = raw.retryDelaysMs.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
    if (delays.length > 0) settings.retryDelaysMs = delays;
  }
  if (typeof raw.captureDm === "boolean") settings.captureDm = raw.captureDm;
  return settings;
}
```

- [ ] **Step 4: Chạy test để thấy pass**

Run: `npx tsc -p tsconfig.json && node --test dist/config.test.js`
Expected: PASS — 3 test pass.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat(config): resolve capture settings from plugin config"
```

---

### Task 5: `src/eb-client.ts` — POST backend + retry/backoff

**Files:**
- Create: `src/eb-client.ts`
- Create: `src/eb-client.test.ts`

- [ ] **Step 1: Viết test fail**

```ts
// src/eb-client.test.ts
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
```

- [ ] **Step 2: Chạy test để thấy fail**

Run: `npx tsc -p tsconfig.json && node --test dist/eb-client.test.js`
Expected: FAIL — `Cannot find module './eb-client.js'`.

- [ ] **Step 3: Viết implementation**

```ts
// src/eb-client.ts
import type { BackendPayload } from "./normalize.js";

export interface EbClientConfig {
  backendUrl: string;
  timeoutMs: number;
  maxAttempts: number;
  retryDelaysMs: number[];
}

export type PostOutcome =
  | { kind: "delivered"; status: number }
  | { kind: "rejected"; status: number; error: string }
  | { kind: "failed"; status: number | null; error: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export async function postCaptureToBackend(config: EbClientConfig, payload: BackendPayload): Promise<PostOutcome> {
  const attempts = Math.max(1, config.maxAttempts);
  let lastError = "post_failed_unknown";
  let lastStatus: number | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(config.backendUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      lastStatus = response.status;
      if (response.status >= 200 && response.status < 300) {
        return { kind: "delivered", status: response.status };
      }
      if (response.status >= 400 && response.status < 500) {
        return { kind: "rejected", status: response.status, error: `post_rejected_4xx:${response.status}` };
      }
      lastError = `post_failed_5xx:${response.status}`;
    } catch (err) {
      lastStatus = null;
      lastError = `post_failed_network:${err instanceof Error ? err.message : String(err)}`;
    }
    if (attempt < attempts) {
      const delays = config.retryDelaysMs;
      const delay = delays.length > 0 ? (delays[attempt - 1] ?? delays[delays.length - 1] ?? 0) : 0;
      if (delay > 0) await sleep(delay);
    }
  }
  return { kind: "failed", status: lastStatus, error: lastError };
}
```

- [ ] **Step 4: Chạy test để thấy pass**

Run: `npx tsc -p tsconfig.json && node --test dist/eb-client.test.js`
Expected: PASS — 4 test pass.

- [ ] **Step 5: Commit**

```bash
git add src/eb-client.ts src/eb-client.test.ts
git commit -m "feat(eb-client): POST to backend with 1s/4s/16s retry backoff"
```

---

### Task 6: `src/queue.ts` — pending / rejected / checkpoint / status

**Files:**
- Create: `src/queue.ts`
- Create: `src/queue.test.ts`

- [ ] **Step 1: Viết test fail**

```ts
// src/queue.test.ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
    id: buildRecordId("msg-1", "2026-11-24T10:00:00.000Z"),
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

test("buildRecordId ổn định và không chứa ký tự lạ", () => {
  const id = buildRecordId("msg/with:weird chars", "2026-11-24T10:00:00.000Z");
  assert.match(id, /^[0-9]+-[0-9a-f]{12}$/);
  assert.equal(id, buildRecordId("msg/with:weird chars", "2026-11-24T10:00:00.000Z"));
});
```

- [ ] **Step 2: Chạy test để thấy fail**

Run: `npx tsc -p tsconfig.json && node --test dist/queue.test.js`
Expected: FAIL — `Cannot find module './queue.js'`.

- [ ] **Step 3: Viết implementation**

```ts
// src/queue.ts
import { createHash } from "node:crypto";
import { readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { BackendPayload } from "./normalize.js";
import {
  ensureStateDirs,
  readJsonIfExists,
  resolveCheckpointPath,
  resolvePendingDir,
  resolveRejectedDir,
  resolveStatusPath,
  writeJsonAtomic,
} from "./state.js";

export interface PendingRecord extends BackendPayload {
  id: string;
  messageId: string;
  mentioned: boolean;
  receivedAt: string;
}

export interface Checkpoint {
  [groupId: string]: { [messageId: string]: { at: string } };
}

export interface CaptureStatus {
  pending: number;
  rejected: number;
  lastPostAt: string | null;
  lastPostStatus: number | null;
  lastError: string | null;
  updatedAt: string;
}

export function buildRecordId(messageId: string, receivedAt: string): string {
  const stamp = receivedAt.replace(/[^0-9]/g, "");
  const digest = createHash("sha1").update(messageId).digest("hex").slice(0, 12);
  return `${stamp}-${digest}`;
}

export function toBackendPayload(record: PendingRecord): BackendPayload {
  return {
    platform: record.platform,
    content: record.content,
    groupId: record.groupId,
    groupName: record.groupName,
    userId: record.userId,
    senderName: record.senderName,
  };
}

export async function enqueueCapture(stateDir: string, record: PendingRecord): Promise<void> {
  await ensureStateDirs(stateDir);
  await writeJsonAtomic(path.join(resolvePendingDir(stateDir), `${record.id}.json`), record);
}

export async function listPendingRecords(stateDir: string): Promise<PendingRecord[]> {
  const dir = resolvePendingDir(stateDir);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const records: PendingRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const record = await readJsonIfExists<PendingRecord>(path.join(dir, entry));
    if (!record || typeof record.id !== "string" || typeof record.messageId !== "string") continue;
    records.push(record);
  }
  records.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  return records;
}

export async function readCheckpoint(stateDir: string): Promise<Checkpoint> {
  const raw = await readJsonIfExists<unknown>(resolveCheckpointPath(stateDir));
  // JSON hợp lệ nhưng sai shape (mảng, chuỗi…) → coi như chưa có checkpoint.
  // Nếu không, markCheckpoint sẽ gắn key lên mảng và JSON.stringify sẽ **drop** mọi entry
  // → gửi trùng tin đã nhận.
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Checkpoint;
}

export async function isCaptured(stateDir: string, groupId: string, messageId: string): Promise<boolean> {
  const checkpoint = await readCheckpoint(stateDir);
  return Boolean(checkpoint[groupId]?.[messageId]);
}

async function markCheckpoint(stateDir: string, record: PendingRecord): Promise<void> {
  const checkpoint = await readCheckpoint(stateDir);
  const group = (checkpoint[record.groupId] ??= {});
  group[record.messageId] = { at: new Date().toISOString() };
  await writeJsonAtomic(resolveCheckpointPath(stateDir), checkpoint);
}

export async function countPending(stateDir: string): Promise<number> {
  return (await listPendingRecords(stateDir)).length;
}

export async function countRejected(stateDir: string): Promise<number> {
  try {
    const entries = await readdir(resolveRejectedDir(stateDir));
    return entries.filter((entry) => entry.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

export async function readStatus(stateDir: string): Promise<CaptureStatus> {
  const stored = await readJsonIfExists<unknown>(resolveStatusPath(stateDir));
  const fallback: CaptureStatus = {
    pending: 0,
    rejected: 0,
    lastPostAt: null,
    lastPostStatus: null,
    lastError: null,
    updatedAt: new Date().toISOString(),
  };
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return fallback;
  return { ...fallback, ...(stored as Partial<CaptureStatus>) };
}

export async function updateStatus(stateDir: string, patch: Partial<CaptureStatus>): Promise<void> {
  const current = await readStatus(stateDir);
  const next: CaptureStatus = {
    ...current,
    ...patch,
    pending: await countPending(stateDir),
    rejected: await countRejected(stateDir),
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(resolveStatusPath(stateDir), next);
}

export async function markDelivered(stateDir: string, record: PendingRecord, status: number): Promise<void> {
  await rm(path.join(resolvePendingDir(stateDir), `${record.id}.json`), { force: true });
  await markCheckpoint(stateDir, record);
  await updateStatus(stateDir, { lastPostAt: new Date().toISOString(), lastPostStatus: status, lastError: null });
}

export async function markRejected(stateDir: string, record: PendingRecord, status: number): Promise<void> {
  await ensureStateDirs(stateDir);
  const source = path.join(resolvePendingDir(stateDir), `${record.id}.json`);
  const target = path.join(resolveRejectedDir(stateDir), `${record.id}.json`);
  try {
    await rename(source, target);
  } catch {
    await writeJsonAtomic(target, record);
    await rm(source, { force: true });
  }
  await updateStatus(stateDir, { lastPostAt: new Date().toISOString(), lastPostStatus: status, lastError: `post_rejected_4xx:${status}` });
}
```

- [ ] **Step 4: Chạy test để thấy pass**

Run: `npx tsc -p tsconfig.json && node --test dist/queue.test.js`
Expected: PASS — 6 test pass.

- [ ] **Step 5: Commit**

```bash
git add src/queue.ts src/queue.test.ts
git commit -m "feat(queue): durable pending queue with checkpoint and status"
```

---

### Task 7: `src/flush.ts` — worker gửi pending

**Files:**
- Create: `src/flush.ts`
- Create: `src/flush.test.ts`

- [ ] **Step 1: Viết test fail**

```ts
// src/flush.test.ts
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
    id: buildRecordId(id, receivedAt),
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
```

- [ ] **Step 2: Chạy test để thấy fail**

Run: `npx tsc -p tsconfig.json && node --test dist/flush.test.js`
Expected: FAIL — `Cannot find module './flush.js'`.

- [ ] **Step 3: Viết implementation**

```ts
// src/flush.ts
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { postCaptureToBackend, type EbClientConfig } from "./eb-client.js";
import { listPendingRecords, markDelivered, markRejected, toBackendPayload, updateStatus } from "./queue.js";

const logger = createSubsystemLogger("zalo-monitor");

let inFlight: Promise<void> | null = null;

export function flushPending(stateDir: string, config: EbClientConfig): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = runFlush(stateDir, config).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runFlush(stateDir: string, config: EbClientConfig): Promise<void> {
  const records = await listPendingRecords(stateDir);
  for (const record of records) {
    const outcome = await postCaptureToBackend(config, toBackendPayload(record));
    if (outcome.kind === "delivered") {
      await markDelivered(stateDir, record, outcome.status);
      logger.info("message_forwarded", { groupId: record.groupId, messageId: record.messageId, status: outcome.status });
      continue;
    }
    if (outcome.kind === "rejected") {
      await markRejected(stateDir, record, outcome.status);
      logger.error("post_rejected_4xx", { groupId: record.groupId, messageId: record.messageId, status: outcome.status });
      continue;
    }
    await updateStatus(stateDir, { lastError: outcome.error, lastPostStatus: outcome.status });
    logger.error("post_failed_after_retries", { groupId: record.groupId, messageId: record.messageId, error: outcome.error });
    break;
  }
}
```

- [ ] **Step 4: Chạy test để thấy pass**

Run: `npx tsc -p tsconfig.json && node --test dist/flush.test.js`
Expected: PASS — 2 test pass.

- [ ] **Step 5: Commit**

```bash
git add src/flush.ts src/flush.test.ts
git commit -m "feat(flush): deliver pending captures with retry and rejection handling"
```

---

### Task 8: `src/capture.ts` — tap entry (fire-and-forget, fail-safe)

**Files:**
- Create: `src/capture.ts`
- Create: `src/capture.test.ts`

- [ ] **Step 1: Viết test fail**

```ts
// src/capture.test.ts
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
```

- [ ] **Step 2: Chạy test để thấy fail**

Run: `npx tsc -p tsconfig.json && node --test dist/capture.test.js`
Expected: FAIL — `Cannot find module './capture.js'`.

- [ ] **Step 3: Viết implementation**

```ts
// src/capture.ts
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { DEFAULT_CAPTURE_SETTINGS, resolveCaptureSettings, type CaptureSettings } from "./config.js";
import { flushPending } from "./flush.js";
import { normalizeCapture } from "./normalize.js";
import { buildRecordId, enqueueCapture, isCaptured, type PendingRecord } from "./queue.js";
import { resolvePluginStateDir } from "./state.js";

const logger = createSubsystemLogger("zalo-monitor");

export interface CaptureTapInput {
  isGroup: boolean;
  chatId: string;
  groupName: string;
  senderId: string;
  senderName: string;
  rawBody: string;
  mentioned: boolean;
  messageId: string;
  rootConfig: unknown;
}

let stateDirOverride: string | null = null;
let lastSettings: CaptureSettings = DEFAULT_CAPTURE_SETTINGS;

/** Chỉ dùng cho test; runtime dùng state dir của openclaw. */
export function setCaptureStateDir(dir: string | null): void {
  stateDirOverride = dir;
}

export function resolveCaptureStateDir(): string {
  return stateDirOverride ?? resolvePluginStateDir();
}

/** Settings resolve gần nhất từ root config — timer flush dùng lại. */
export function getLastCaptureSettings(): CaptureSettings {
  return lastSettings;
}

/** Tap: KHÔNG được ném exception ra channel, KHÔNG được chặn luồng chat. */
export function captureZaloMessage(input: CaptureTapInput): void {
  try {
    const settings = resolveCaptureSettings(input.rootConfig);
    lastSettings = settings;
    if (!input.isGroup && !settings.captureDm) return;
    void handleCapture(resolveCaptureStateDir(), settings, input);
  } catch (err) {
    logger.error("capture_failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleCapture(stateDir: string, settings: CaptureSettings, input: CaptureTapInput): Promise<void> {
  try {
    if (await isCaptured(stateDir, input.chatId, input.messageId)) return;
    const receivedAt = new Date().toISOString();
    const payload = normalizeCapture({
      rawBody: input.rawBody,
      chatId: input.chatId,
      groupName: input.groupName,
      senderId: input.senderId,
      senderName: input.senderName,
    });
    const record: PendingRecord = {
      id: buildRecordId(input.messageId, receivedAt),
      messageId: input.messageId,
      ...payload,
      mentioned: input.mentioned,
      receivedAt,
    };
    await enqueueCapture(stateDir, record);
    await flushPending(stateDir, settings);
  } catch (err) {
    logger.error("capture_failed", { error: err instanceof Error ? err.message : String(err) });
  }
}
```

- [ ] **Step 4: Chạy test để thấy pass**

Run: `npx tsc -p tsconfig.json && node --test dist/capture.test.js`
Expected: PASS — 2 test pass.

- [ ] **Step 5: Commit**

```bash
git add src/capture.ts src/capture.test.ts
git commit -m "feat(capture): add non-blocking fail-safe capture tap"
```

---

### Task 9: `scripts/vendor-refresh.mjs` — vendor + patch zalouser

**Files:**
- Create: `scripts/vendor-refresh.mjs`
- Create: `vendor/zalouser/**` (sinh ra)
- Modify: `openclaw.plugin.json` (tạo ở Task 10, script sẽ cập nhật schema ở Task 10)

> Task này **không** cần `openclaw.plugin.json` tồn tại: script chỉ cập nhật manifest nếu file có mặt.

- [ ] **Step 1: Viết script**

```js
// scripts/vendor-refresh.mjs
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(repoRoot, "node_modules", "@openclaw", "zalouser");
const vendorRoot = path.join(repoRoot, "vendor", "zalouser");
const manifestPath = path.join(repoRoot, "openclaw.plugin.json");

const ANCHOR = "\tif (isGroup && requireMention && !canDetectMention && !mentionDecision.effectiveWasMentioned) {";
const IMPORT_LINE = 'import { captureZaloMessage } from "../capture.js";';

const TAP_CALL = [
  "\tcaptureZaloMessage({",
  "\t\tisGroup,",
  "\t\tchatId,",
  "\t\tgroupName,",
  "\t\tsenderId,",
  "\t\tsenderName,",
  "\t\trawBody,",
  "\t\tmentioned: mentionDecision.effectiveWasMentioned,",
  "\t\tmessageId: resolveZalouserMessageSid({ msgId: message.msgId, cliMsgId: message.cliMsgId, fallback: String(message.timestampMs) }),",
  "\t\trootConfig: config",
  "\t});",
].join("\n");

function fail(message) {
  console.error(`[vendor-refresh] ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function patchMonitorSource(source) {
  if (source.includes(IMPORT_LINE)) return source;
  if (!source.includes(ANCHOR)) {
    fail("không tìm thấy anchor mention gate trong monitor — bản zalouser đã đổi cấu trúc");
  }
  const lines = source.split("\n");
  let lastImport = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.startsWith("import ")) {
      lastImport = i;
      continue;
    }
    if (line.trim() === "") continue;
    break;
  }
  if (lastImport < 0) fail("không tìm thấy câu lệnh import nào trong monitor");
  lines.splice(lastImport + 1, 0, IMPORT_LINE);
  const patched = lines.join("\n");
  if (!patched.includes(ANCHOR)) fail("anchor bị mất sau khi chèn import");
  return patched.replace(ANCHOR, `${TAP_CALL}\n${ANCHOR}`);
}

async function syncChannelSchema(vendorManifest) {
  if (!vendorManifest?.channelConfigs?.zalouser?.schema) return;
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return;
  }
  manifest.channelConfigs = manifest.channelConfigs ?? {};
  manifest.channelConfigs.zalouser = manifest.channelConfigs.zalouser ?? {};
  manifest.channelConfigs.zalouser.schema = vendorManifest.channelConfigs.zalouser.schema;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log("[vendor-refresh] đã đồng bộ channelConfigs.zalouser.schema");
}

async function main() {
  const sourceDist = path.join(sourceDir, "dist");
  try {
    await readdir(sourceDist);
  } catch {
    fail(`không thấy ${sourceDist} — chạy npm install trước`);
  }

  const entries = (await readdir(sourceDist)).filter((entry) => entry.endsWith(".js"));
  let monitorFile = null;
  for (const entry of entries) {
    const text = await readFile(path.join(sourceDist, entry), "utf8");
    if (text.includes("async function processMessage(")) {
      monitorFile = entry;
      break;
    }
  }
  if (!monitorFile) fail("không tìm thấy file chứa processMessage trong bản zalouser");

  const staged = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-vendor-"));
  try {
    await cp(sourceDist, path.join(staged, "dist"), { recursive: true });
    const patched = patchMonitorSource(await readFile(path.join(staged, "dist", monitorFile), "utf8"));
    await writeFile(path.join(staged, "dist", monitorFile), patched, "utf8");
    await cp(path.join(sourceDir, "openclaw.plugin.json"), path.join(staged, "openclaw.plugin.json"));
    await cp(path.join(sourceDir, "package.json"), path.join(staged, "package.json"));

    const previous = `${vendorRoot}.previous`;
    await rm(previous, { recursive: true, force: true });
    if (await readdir(vendorRoot).then(() => true, () => false)) {
      await rename(vendorRoot, previous);
    }
    await mkdir(path.dirname(vendorRoot), { recursive: true });
    await rename(staged, vendorRoot);
    await rm(previous, { recursive: true, force: true });

    const vendorManifest = JSON.parse(await readFile(path.join(vendorRoot, "openclaw.plugin.json"), "utf8"));
    await syncChannelSchema(vendorManifest);
    console.log(`[vendor-refresh] đã vendor ${monitorFile} vào vendor/zalouser`);
  } catch (err) {
    await rm(staged, { recursive: true, force: true });
    throw err;
  }
}

await main();
```

- [ ] **Step 2: Chạy vendor refresh**

Run: `node scripts/vendor-refresh.mjs`
Expected: in `[vendor-refresh] đã vendor monitor-*.js vào vendor/zalouser` và `vendor/zalouser/dist/` có các file `.js`.

- [ ] **Step 3: Verify patch đúng vị trí**

Run: `grep -n "captureZaloMessage" vendor/zalouser/dist/monitor-*.js`
Expected: 2 dòng — 1 dòng `import { captureZaloMessage } from "../capture.js";` và 1 khối `captureZaloMessage({`.

Run: `grep -n -A 12 "captureZaloMessage({" vendor/zalouser/dist/monitor-*.js | head -20`
Expected: khối tap nằm **ngay trước** dòng `if (isGroup && requireMention && !canDetectMention ...`.

- [ ] **Step 4: Verify tap nằm SAU access gate và TRƯỚC mention gate**

Run: `grep -n "routeAccess.allowed\|accessDecision.senderAccess\|captureZaloMessage({\|mentionDecision.shouldSkip" vendor/zalouser/dist/monitor-*.js`
Expected: thứ tự dòng tăng dần: `routeAccess.allowed` < `accessDecision.senderAccess` < `captureZaloMessage({` < `mentionDecision.shouldSkip`.

- [ ] **Step 5: Commit**

```bash
git add vendor scripts/vendor-refresh.mjs
git commit -m "feat(vendor): vendor patched zalouser channel with capture tap"
```

---

### Task 10: `scripts/copy-vendor.mjs` + `scripts/clean-dist.mjs` + `openclaw.plugin.json`

**Files:**
- Create: `scripts/clean-dist.mjs`
- Create: `scripts/copy-vendor.mjs`
- Create: `openclaw.plugin.json`

- [ ] **Step 1: Viết `scripts/clean-dist.mjs`**

```js
// scripts/clean-dist.mjs
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await rm(path.join(repoRoot, "dist"), { recursive: true, force: true });
console.log("[clean-dist] đã xoá dist/");
```

> `tsc` không tự dọn `dist/`, nên output cũ của file đã đổi tên/xoá có thể sót lại và bị
> entry discovery quét nhầm. `clean-dist` chạy **trước** `tsc`; `copy-vendor` chạy **sau**
> `tsc` (nếu đảo thứ tự thì copy sẽ xoá luôn output của compiler).

- [ ] **Step 2: Viết `scripts/copy-vendor.mjs`**

```js
// scripts/copy-vendor.mjs
import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDist = path.join(repoRoot, "vendor", "zalouser", "dist");
const outDir = path.join(repoRoot, "dist", "zalouser");

await mkdir(outDir, { recursive: true });
await cp(vendorDist, outDir, { recursive: true });
const copied = (await readdir(outDir)).length;
console.log(`[copy-vendor] đã copy vendor → dist/zalouser (${copied} entry cấp cao nhất)`);
```

- [ ] **Step 3: Tạo `openclaw.plugin.json`**

```json
{
  "id": "zalo-monitor",
  "name": "Zalo Monitor",
  "description": "Zalo Personal (fork of @openclaw/zalouser) with a capture tap: forwards every Zalo group message, including untagged ones, to a backend. The bot still replies only to tagged messages.",
  "activation": {
    "onStartup": false
  },
  "channels": [
    "zalouser"
  ],
  "contracts": {
    "tools": [
      "zalouser"
    ]
  },
  "channelEnvVars": {
    "zalouser": [
      "ZALOUSER_PROFILE",
      "ZCA_PROFILE"
    ]
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "backendUrl": {
        "type": "string",
        "description": "Backend nhận 6 field platform/content/groupId/groupName/userId/senderName"
      },
      "timeoutMs": {
        "type": "integer",
        "minimum": 1000,
        "maximum": 120000
      },
      "maxAttempts": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10
      },
      "retryDelaysMs": {
        "type": "array",
        "items": {
          "type": "integer",
          "minimum": 0
        }
      },
      "captureDm": {
        "type": "boolean"
      },
      "flushIntervalMs": {
        "type": "integer",
        "minimum": 1000,
        "maximum": 3600000
      }
    }
  },
  "channelConfigs": {
    "zalouser": {
      "label": "Zalo Personal",
      "description": "Zalo Personal (zalo-monitor fork)",
      "preferOver": [
        "zalouser"
      ],
      "schema": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      }
    }
  }
}
```

> `channelConfigs.zalouser.schema` ở trên là placeholder rỗng; `vendor-refresh.mjs` (Task 9) sẽ điền schema thật của channel `zalouser`. Sau Task 9 phải chạy lại `node scripts/vendor-refresh.mjs` để schema được đồng bộ.

- [ ] **Step 4: Đồng bộ schema channel từ bản vendor**

Run: `node scripts/vendor-refresh.mjs`
Expected: in `đã đồng bộ channelConfigs.zalouser.schema`.

Run: `node -e "const m=require('./openclaw.plugin.json'); console.log(Object.keys(m.channelConfigs.zalouser.schema.properties||{}).join(','))"`
Expected: in ra danh sách property của channel zalouser (ví dụ `name,enabled,markdown,profile,dmPolicy,allowFrom,historyLimit,groupAllowFrom,groupPolicy,groups`).

- [ ] **Step 5: Build thử**

Run: `npm run build`
Expected: `tsc` không lỗi; `[copy-vendor] đã copy N file vendor → dist/zalouser`; `dist/index.js`, `dist/zalouser/monitor-*.js` tồn tại.

- [ ] **Step 6: Commit**

```bash
git add scripts/clean-dist.mjs scripts/copy-vendor.mjs openclaw.plugin.json
git commit -m "feat(manifest): add zalo-monitor manifest and vendor copy step"
```

---

### Task 11: `src/index.ts` + `src/setup-entry.ts` — entry plugin

**Files:**
- Modify: `src/index.ts`
- Create: `src/setup-entry.ts`

- [ ] **Step 1: Viết `src/index.ts`**

```ts
// src/index.ts
import { defineBundledChannelEntry, loadBundledEntryExportSync } from "openclaw/plugin-sdk/channel-entry-contract";
import { startCaptureRuntime } from "./runtime.js";

export default defineBundledChannelEntry({
  id: "zalo-monitor",
  name: "Zalo Monitor",
  description: "Zalo Personal fork that captures every group message (including untagged ones) and forwards it to a backend.",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./zalouser/channel-plugin-api.js",
    exportName: "zalouserPlugin",
  },
  runtime: {
    specifier: "./zalouser/runtime-api.js",
    exportName: "setZalouserRuntime",
  },
  registerFull(api) {
    api.registerTool(
      (ctx) =>
        loadBundledEntryExportSync(import.meta.url, {
          specifier: "./zalouser/api.js",
          exportName: "createZalouserTool",
        })(ctx),
      { name: "zalouser" },
    );
    startCaptureRuntime();
  },
});
```

- [ ] **Step 2: Viết `src/setup-entry.ts`**

```ts
// src/setup-entry.ts
import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./zalouser/setup-plugin-api.js",
    exportName: "zalouserSetupPlugin",
  },
});
```

- [ ] **Step 3: Viết `src/runtime.ts` — timer flush + replay khi khởi động**

```ts
// src/runtime.ts
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { getLastCaptureSettings } from "./capture.js";
import { flushPending } from "./flush.js";
import { listPendingRecords } from "./queue.js";
import { resolvePluginStateDir } from "./state.js";

const logger = createSubsystemLogger("zalo-monitor");

let timer: NodeJS.Timeout | null = null;

/**
 * Timer flush + replay khi khởi động.
 * Settings lấy từ `getLastCaptureSettings()` — tức là settings resolve gần nhất
 * từ root config (qua tap). Trước khi có tin nào, dùng default.
 */
export function startCaptureRuntime(): void {
  if (timer) return;
  const stateDir = resolvePluginStateDir();
  void (async () => {
    try {
      const pending = await listPendingRecords(stateDir);
      if (pending.length > 0) {
        logger.info("capture_replayed_on_start", { pending: pending.length });
        await flushPending(stateDir, getLastCaptureSettings());
      }
    } catch (err) {
      logger.error("capture_replay_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  })();
  timer = setInterval(() => {
    void flushPending(stateDir, getLastCaptureSettings()).catch((err) => {
      logger.error("capture_flush_failed", { error: err instanceof Error ? err.message : String(err) });
    });
  }, getLastCaptureSettings().flushIntervalMs);
  timer.unref?.();
}
```

- [ ] **Step 4: Build và verify import resolve được**

Run: `npm run build`
Expected: không lỗi TS.

Run: `node -e "import('./dist/index.js').then(m=>console.log(m.default.id, m.default.kind))"`
Expected: in `zalo-monitor bundled-channel-entry`.

Run: `node -e "import('./dist/setup-entry.js').then(m=>console.log(m.default.kind))"`
Expected: in `bundled-channel-setup-entry`.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/setup-entry.ts src/runtime.ts
git commit -m "feat(entry): wire zalo-monitor channel entry and capture runtime"
```

---

### Task 12: Test tích hợp tap (fork channel)

**Files:**
- Create: `src/tap.integration.test.ts`

- [ ] **Step 1: Viết test**

Test này **không** boot gateway; nó kiểm tra đúng thứ đã patch trong bản vendor:

```ts
// src/tap.integration.test.ts
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

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
```

- [ ] **Step 2: Chạy test**

Run: `npm run build && node --test dist/tap.integration.test.js`
Expected: PASS — 3 test pass.

- [ ] **Step 3: Chạy toàn bộ test**

Run: `npm test`
Expected: tất cả test PASS, không test nào fail.

- [ ] **Step 4: Commit**

```bash
git add src/tap.integration.test.ts
git commit -m "test: assert capture tap position and fields in vendored channel"
```

---

### Task 13: Cài vào openclaw + kiểm chứng E2E

**Files:**
- Modify: `README.md`
- Modify (ngoài repo): `~/.openclaw/openclaw.json`

> Task này thay đổi hệ thống đang chạy. Bắt buộc: **tắt bản npm `@openclaw/zalouser`** để không có 2 kết nối Zalo.

- [ ] **Step 1: Backup config**

Run: `cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.zalo-monitor.bak`
Expected: exit 0.

- [ ] **Step 2: Build lần cuối**

Run: `npm run build`
Expected: exit 0, `dist/index.js` + `dist/zalouser/*.js` có mặt.

- [ ] **Step 3: Link plugin**

Run: `openclaw plugins install --link "e:/projectVN/zalo-monitor"`
Expected: exit 0, in đường dẫn đã link.

Run: `openclaw plugins list`
Expected: thấy `zalo-monitor` (enabled).

- [ ] **Step 4: Tắt bản npm zalouser**

Sửa `~/.openclaw/openclaw.json`: trong `plugins.entries`, đặt `"zalouser": { "enabled": false }` (giữ nguyên `zalo`, `whatsapp`, `openai`, `codex`, `minimax`).

Run: `node -e "const c=require(process.env.USERPROFILE+'/.openclaw/openclaw.json'); console.log(JSON.stringify(c.plugins.entries,null,2))"`
Expected: `zalouser.enabled === false`, `zalo-monitor` không có (chưa cần).

- [ ] **Step 5: Restart gateway**

Run: `openclaw gateway restart`
Expected: gateway restart xong.

- [ ] **Step 6: Verify channel ownership**

Run: `openclaw channels status`
Expected: `zalouser` có **đúng một** owner là `zalo-monitor`, không có cảnh báo duplicate channel.

Run: `openclaw plugins list`
Expected: `zalo-monitor` enabled, `zalouser` (npm) disabled.

- [ ] **Step 7: Verify đăng nhập Zalo vẫn dùng được (setup surface)**

Run: `openclaw channels status --probe`
Expected: channel `zalouser` probe OK, đã đăng nhập (dùng credential có sẵn ở `~/.openclaw/credentials/zalouser`).

- [ ] **Step 8: Cấu hình backend URL trong config plugin**

Thêm vào `~/.openclaw/openclaw.json`:

```json5
"plugins": {
  "entries": {
    "zalo-monitor": {
      "enabled": true,
      "config": {
        "backendUrl": "http://localhost:3001/clientV2/sdAnalysis/analyzeAndSaveSdData"
      }
    }
  }
}
```

Run: `openclaw gateway restart`
Expected: restart xong.

- [ ] **Step 9: E2E — tin group KHÔNG tag bot**

Gửi 1 tin nhắn thường (không @bot) trong group Zalo đang theo dõi.

Run: `sleep 3 && node -e "const s=require(process.env.USERPROFILE+'/.openclaw/plugin-state/zalo-monitor/status.json'); console.log(JSON.stringify(s))"`
Expected: `pending: 0` (đã gửi thành công) hoặc `pending: 1` + `lastError` khác null nếu backend chưa chạy.

Run: `openclaw channels logs --channel zalouser`
Expected: có dòng `message_forwarded`.

Run: `node -e "const c=require(process.env.USERPROFILE+'/.openclaw/plugin-state/zalo-monitor/checkpoint.json'); console.log(JSON.stringify(c))"`
Expected: có entry theo groupId với messageId của tin vừa gửi.

> Nếu backend chưa chạy ở `localhost:3001`: tin vẫn phải nằm trong `pending/` (không mất), và log phải có `post_failed_after_retries`.

- [ ] **Step 10: E2E — tin group CÓ tag bot**

Gửi 1 tin nhắn @bot trong group.

Expected:
- Log có `message_forwarded` (tin cũng được capture — README: capture **mọi** tin group).
- Bot **vẫn trả lời** tin đã tag (hành vi bot không đổi).

- [ ] **Step 11: E2E — tin DM**

Gửi 1 tin nhắn trong DM.

Expected: **không** có `message_forwarded` cho tin DM; `checkpoint.json` không có entry của DM.

- [ ] **Step 12: Cập nhật README**

Viết lại `README.md` cho khớp thực tế (fork + vendor + capture tap), giữ các phần còn đúng:
- Mục tiêu & nguyên tắc "observe → forward → persist"
- Vì sao phải fork (kèm trích dẫn dòng code đã verify)
- Cấu trúc thư mục mới
- Cài đặt: `npm install --legacy-peer-deps` → `npm run build` → `openclaw plugins install --link .` → tắt `plugins.entries.zalouser.enabled` → `openclaw gateway restart`
- Cấu hình `plugins.entries["zalo-monitor"].config`
- State dir + shape `status.json`
- Event log + câu lệnh `openclaw channels logs --channel zalouser`
- Mục "Nâng cấp zalouser": bump `@openclaw/zalouser` trong `package.json` → `npm install` → `npm run vendor:refresh` → `npm run build` → restart gateway
- Cảnh báo Zalo automation không chính thức (giữ nguyên)

- [ ] **Step 13: Commit**

```bash
git add README.md
git commit -m "docs: document fork install, config, state and upgrade flow"
```

---

## Self-review

**Spec coverage**

| Mục spec | Task |
|---|---|
| §2 facts verify | không cần task (đã verify) |
| §3.1 cây thư mục | Task 1, 9, 10, 11 |
| §3.2 vị trí tap | Task 9 (patch), Task 12 (test vị trí) |
| §3.3 dữ liệu tap | Task 3, 8, 12 |
| §3.4 fire-and-forget / fail-safe / dedupe | Task 8 |
| §3.4.1 cơ chế nối tap | Task 9, 11 |
| §4 backend 6 field + retry + 4xx/5xx | Task 3, 5, 7 |
| §5 state bền vững + checkpoint + status + replay | Task 2, 6, 7, 11 |
| §6 cấu hình | Task 4, 10, 13 |
| §7 cài & vận hành | Task 13 |
| §8 nâng cấp | Task 9, 13 (README) |
| §9 rủi ro | Task 13 (tắt bản npm), README |
| §10 kiểm thử | Task 2-8 (unit), Task 12 (tap), Task 13 (E2E) |

**Placeholder scan** — không còn khối test mẫu/sai cú pháp nào trong plan; mỗi bước code có đúng một bản code hoàn chỉnh dùng để thực thi.

**Type consistency** — `BackendPayload` (normalize.ts) dùng bởi queue.ts, eb-client.ts ✓; `PendingRecord extends BackendPayload` ✓; `CaptureSettings` (config.ts) dùng bởi capture.ts, runtime.ts ✓; `EbClientConfig` (eb-client.ts) dùng bởi flush.ts ✓ — `CaptureSettings` có `captureDm`/`flushIntervalMs` **thừa** so với `EbClientConfig` nhưng cấu trúc tương thích (structural typing) nên truyền `settings` vào `flushPending(stateDir, settings)` hợp lệ ✓. `captureZaloMessage` nhận `rootConfig` — Task 9 truyền `rootConfig: config` ✓ khớp tên field. `getLastCaptureSettings()` (capture.ts) được runtime.ts dùng ✓.

**Thứ tự build** — `npm run build` = `clean-dist.mjs` (xoá `dist/`) → `tsc` (src → dist) → `copy-vendor.mjs` (vendor/zalouser/dist → dist/zalouser). File monitor đã patch import `"../capture.js"` → resolve thành `dist/capture.js` ✓ (cùng nằm trong `dist/`, thoả boundary root của `defineBundledChannelEntry`).

**Sửa đổi sau code review Task 1** (đã áp dụng vào plan này):
1. `dependencies` thêm `typebox@1.1.38` + `zod@4.4.3` — code vendor import tĩnh chúng, vendor copy không mang `node_modules` theo.
2. `test` script: `node --test dist/` → `node --test "dist/**/*.test.js"` (bản thư mục hỏng trên Node 22; glob cũng loại trừ file vendor).
3. `openclaw.channel` thêm `preferOver: ["zalouser"]` — khai báo quyền ưu tiên ngay từ Task 1.
4. Task 9/10 copy vendor **đệ quy** thay vì chỉ copy file `.js` cấp cao nhất.
5. Task 10 thêm `scripts/clean-dist.mjs` chạy trước `tsc`.
