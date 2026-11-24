// Vendor lại channel plugin @openclaw/zalouser từ node_modules và chèn tap capture.
//
// Tap phải nằm SAU các access gate (routeAccess / senderAccess) và TRƯỚC mention gate,
// vì upstream tự return ở mention gate nên host không bao giờ thấy message untagged.
//
// Bản vendored luôn ở trạng thái "inert": package.json của bản copy không giữ key
// `openclaw` để không bao giờ bị loader nhận nhầm thành plugin thứ hai.
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
  "\t\trawBody: message.content,",
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
  // replace dạng function để không bị `$&` / `$1` trong TAP_CALL bị hiểu sai.
  return patched.replace(ANCHOR, () => `${TAP_CALL}\n${ANCHOR}`);
}

/** Bản copy trong vendor không được giữ key `openclaw` (tránh double-register channel). */
async function stripOpenclawKey(packageJsonPath) {
  const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
  delete pkg.openclaw;
  await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
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
  // Staging cuối cùng phải nằm cùng filesystem với vendor/ để rename() hoạt động
  // (os.tmpdir() có thể nằm ở ổ đĩa khác → rename sẽ ném EXDEV).
  const swapDir = path.join(path.dirname(vendorRoot), `.zalouser-staging-${process.pid}`);
  try {
    await cp(sourceDist, path.join(staged, "dist"), { recursive: true });
    const patched = patchMonitorSource(await readFile(path.join(staged, "dist", monitorFile), "utf8"));
    await writeFile(path.join(staged, "dist", monitorFile), patched, "utf8");
    await cp(path.join(sourceDir, "openclaw.plugin.json"), path.join(staged, "openclaw.plugin.json"));
    await cp(path.join(sourceDir, "package.json"), path.join(staged, "package.json"));
    await stripOpenclawKey(path.join(staged, "package.json"));

    const previous = `${vendorRoot}.previous`;
    await rm(previous, { recursive: true, force: true });
    await rm(swapDir, { recursive: true, force: true });
    await mkdir(path.dirname(vendorRoot), { recursive: true });
    await cp(staged, swapDir, { recursive: true });
    const hadPrevious = await readdir(vendorRoot).then(() => true, () => false);
    if (hadPrevious) {
      await rename(vendorRoot, previous);
    }
    try {
      await rename(swapDir, vendorRoot);
    } catch (err) {
      // Không để lại vendor/ hỏng: trả bản cũ về chỗ cũ.
      if (hadPrevious) await rename(previous, vendorRoot).catch(() => {});
      throw err;
    }
    await rm(previous, { recursive: true, force: true });

    const vendorManifest = JSON.parse(await readFile(path.join(vendorRoot, "openclaw.plugin.json"), "utf8"));
    await syncChannelSchema(vendorManifest);
    console.log(`[vendor-refresh] đã vendor ${monitorFile} vào vendor/zalouser`);
  } catch (err) {
    await rm(staged, { recursive: true, force: true });
    await rm(swapDir, { recursive: true, force: true });
    throw err;
  }
}

await main();
