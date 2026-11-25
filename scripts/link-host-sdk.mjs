#!/usr/bin/env node
// scripts/link-host-sdk.mjs
//
// Trỏ `node_modules/openclaw` của repo này về bản cài openclaw của HOST.
//
// Vì `openclaw` nằm trong devDependencies nên `npm install` đặt một BẢN THẬT vào
// <repo>/node_modules/openclaw. Node sẽ resolve `openclaw/plugin-sdk/*` từ đó,
// tức là process chạy plugin dùng MỘT SDK thứ hai, khác với SDK của host → sau
// khi gateway nâng cấp, plugin vẫn chạy trên SDK cũ.
//
// Script này thay bản trong repo bằng symlink (junction trên Windows) trỏ tới
// bản cài của host, giống cách npm-installed @openclaw/zalouser làm.
//
// Script KHÔNG được build phụ thuộc vào: `npm run build` vẫn chạy được với bản
// thật trong node_modules (bản thật cũng có đủ file .d.ts của SDK).

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDir, "..");

/** Package root của openclaw theo prefix của npm global install. */
export function packageRootFromPrefix(prefix, platform = process.platform) {
  return platform === "win32"
    ? path.join(prefix, "node_modules", "openclaw")
    : path.join(prefix, "lib", "node_modules", "openclaw");
}

/** Suy ra prefix của npm global install từ đường dẫn executable `openclaw`. */
export function prefixFromExecutable(executablePath, platform = process.platform) {
  const dir = path.dirname(executablePath);
  // POSIX: <prefix>/bin/openclaw — Windows: <prefix>/openclaw.cmd
  return platform === "win32" ? dir : path.dirname(dir);
}

/** Tìm mọi executable `openclaw` trên PATH (theo thứ tự PATH). */
export function findExecutablesOnPath(name, env = process.env, platform = process.platform) {
  const rawPath = env["PATH"] ?? env["Path"] ?? env["path"] ?? "";
  const extensions = platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  const found = [];
  for (const dir of rawPath.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`);
      try {
        if (fs.statSync(candidate).isFile()) found.push(candidate);
      } catch {
        // Không tồn tại / không đọc được → thử kế tiếp.
      }
    }
  }
  return found;
}

/** Tìm executable `openclaw` đầu tiên trên PATH. */
export function findExecutableOnPath(name, env = process.env, platform = process.platform) {
  return findExecutablesOnPath(name, env, platform)[0] ?? null;
}

function defaultRun(command) {
  try {
    return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/**
 * Tìm package root của openclaw trên máy host.
 * Ưu tiên executable `openclaw` trên PATH, fallback `npm root -g` + `/openclaw`.
 *
 * PATH thường có `node_modules/.bin` của chính repo này ở đầu — shim ở đó trỏ
 * về bản trong repo, KHÔNG phải bản của host — nên phải xét từng candidate và
 * chỉ nhận candidate nào có package root tồn tại thật.
 */
export function resolveHostSdkRoot({ env = process.env, platform = process.platform, run = defaultRun } = {}) {
  for (const executable of findExecutablesOnPath("openclaw", env, platform)) {
    const root = packageRootFromPrefix(prefixFromExecutable(executable, platform), platform);
    if (fs.existsSync(root)) return root;
  }
  const npmRoot = run("npm root -g");
  if (npmRoot) {
    const root = path.join(npmRoot, "openclaw");
    if (fs.existsSync(root)) return root;
  }
  return null;
}

function isLink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function samePath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

/** Xoá link/thư mục tại `target` mà KHÔNG đụng nội dung của target nó trỏ tới. */
export function removeLinkOrDir(target, platform = process.platform) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    if (platform === "win32") {
      // Junction trên Windows phải xoá bằng rmdir; unlink sẽ báo EPERM.
      try {
        fs.rmdirSync(target);
        return;
      } catch {
        // Rơi xuống rmSync bên dưới.
      }
    } else {
      fs.unlinkSync(target);
      return;
    }
  }
  fs.rmSync(target, { recursive: true, force: true });
}

/** Đọc version của package openclaw tại `packageRoot` (null nếu không đọc được). */
export function readPackageVersion(packageRoot) {
  try {
    const raw = fs.readFileSync(path.join(packageRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Thay `node_modules/openclaw` của repo bằng symlink/junction trỏ tới host.
 * Trả về mô tả việc đã làm để script (và test) in ra.
 */
export function linkHostSdk({ repoRoot = defaultRepoRoot, hostRoot, platform = process.platform }) {
  const linkPath = path.join(repoRoot, "node_modules", "openclaw");
  fs.mkdirSync(path.join(repoRoot, "node_modules"), { recursive: true });

  let action = "linked";
  if (samePath(linkPath, hostRoot) || (isLink(linkPath) && samePath(linkPath, hostRoot))) {
    // Đã trỏ đúng host (hoặc host chính là bản trong repo) → không làm gì.
    action = "already-linked";
  } else {
    removeLinkOrDir(linkPath, platform);
    fs.symlinkSync(hostRoot, linkPath, platform === "win32" ? "junction" : "dir");
  }

  return {
    action,
    hostRoot,
    linkPath,
    hostVersion: readPackageVersion(hostRoot),
  };
}

/**
 * Luồng chính của script. Trả về exit code.
 * Không tìm thấy bản cài openclaw của host → trả 1 kèm hướng dẫn.
 */
export function runLink({
  repoRoot = defaultRepoRoot,
  env = process.env,
  platform = process.platform,
  run = defaultRun,
  log = console.log,
  error = console.error,
} = {}) {
  const hostRoot = resolveHostSdkRoot({ env, platform, run });
  if (!hostRoot) {
    error(
      "[link-host-sdk] Không tìm thấy bản cài openclaw của host trên máy này.\n" +
        "  - Kiểm tra `openclaw --version` có chạy được không (openclaw phải nằm trong PATH hoặc cài global).\n" +
        "  - Nếu host cài openclaw ở chỗ khác, hãy tự tạo link:\n" +
        "      node_modules/openclaw -> <prefix>/node_modules/openclaw (Windows) hoặc <prefix>/lib/node_modules/openclaw (POSIX)\n" +
        "  - Hoặc giữ nguyên bản SDK trong repo và chấp nhận phải nâng phiên bản openclaw trong devDependencies\n" +
        "    theo đúng phiên bản của host.",
    );
    return 1;
  }

  const result = linkHostSdk({ repoRoot, hostRoot, platform });
  const version = result.hostVersion ? ` (v${result.hostVersion})` : "";
  log(`[link-host-sdk] host openclaw${version}: ${result.hostRoot}`);
  log(`[link-host-sdk] link trong repo: ${result.linkPath}`);
  if (result.action === "already-linked") {
    log("[link-host-sdk] đã trỏ sẵn tới host — không thay đổi gì.");
  } else {
    log("[link-host-sdk] đã thay bản cài trong repo bằng symlink tới host.");
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  process.exit(runLink({ repoRoot: defaultRepoRoot }));
}
