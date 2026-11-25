import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");

interface LinkHostSdkModule {
  packageRootFromPrefix: (prefix: string, platform?: string) => string;
  prefixFromExecutable: (executablePath: string, platform?: string) => string;
  findExecutableOnPath: (name: string, env?: NodeJS.ProcessEnv, platform?: string) => string | null;
  resolveHostSdkRoot: (options?: {
    env?: NodeJS.ProcessEnv;
    platform?: string;
    run?: (command: string) => string;
  }) => string | null;
  linkHostSdk: (options: { repoRoot?: string; hostRoot: string; platform?: string }) => {
    action: string;
    hostRoot: string;
    linkPath: string;
    hostVersion: string | null;
  };
  runLink: (options?: {
    repoRoot?: string;
    env?: NodeJS.ProcessEnv;
    platform?: string;
    run?: (command: string) => string;
    log?: (message: string) => void;
    error?: (message: string) => void;
  }) => number;
}

async function loadScript(): Promise<LinkHostSdkModule> {
  const scriptUrl = pathToFileURL(path.join(repoRoot, "scripts", "link-host-sdk.mjs")).href;
  return (await import(scriptUrl)) as LinkHostSdkModule;
}

async function makeFakePackage(root: string, version = "1.2.3"): Promise<string> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw", version }), "utf8");
  return root;
}

test("packageRootFromPrefix đúng cho Windows và POSIX", async () => {
  const mod = await loadScript();
  assert.equal(mod.packageRootFromPrefix("C:\\npm", "win32"), path.join("C:\\npm", "node_modules", "openclaw"));
  assert.equal(mod.packageRootFromPrefix("/usr/local", "linux"), path.join("/usr/local", "lib", "node_modules", "openclaw"));
});

test("prefixFromExecutable suy ra prefix từ executable trên PATH", async () => {
  const mod = await loadScript();
  assert.equal(mod.prefixFromExecutable("C:\\npm\\openclaw.cmd", "win32"), "C:\\npm");
  assert.equal(mod.prefixFromExecutable("/usr/local/bin/openclaw", "linux"), "/usr/local");
});

test("resolveHostSdkRoot ưu tiên executable openclaw trên PATH", async () => {
  const mod = await loadScript();
  const prefix = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-sdk-"));
  await writeFile(path.join(prefix, "openclaw.cmd"), "@echo off", "utf8");
  const hostRoot = await makeFakePackage(path.join(prefix, "node_modules", "openclaw"));
  const resolved = mod.resolveHostSdkRoot({
    env: { PATH: prefix },
    platform: "win32",
    run: () => "",
  });
  assert.equal(resolved, hostRoot);
});

test("resolveHostSdkRoot bỏ qua shim trong node_modules/.bin của chính repo", async () => {
  const mod = await loadScript();
  const workspace = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-sdk-"));
  // Shim của repo (node_modules/.bin) đứng trước trên PATH nhưng không có package root.
  const localBin = path.join(workspace, "repo", "node_modules", ".bin");
  await mkdir(localBin, { recursive: true });
  await writeFile(path.join(localBin, "openclaw.cmd"), "@echo off", "utf8");
  const globalPrefix = path.join(workspace, "global");
  await mkdir(globalPrefix, { recursive: true });
  await writeFile(path.join(globalPrefix, "openclaw.cmd"), "@echo off", "utf8");
  const hostRoot = await makeFakePackage(path.join(globalPrefix, "node_modules", "openclaw"));
  const resolved = mod.resolveHostSdkRoot({
    env: { PATH: [localBin, globalPrefix].join(path.delimiter) },
    platform: "win32",
    run: () => "",
  });
  assert.equal(resolved, hostRoot, "phải bỏ qua shim không có package root và lấy bản global");
});

test("resolveHostSdkRoot fallback sang npm root -g", async () => {
  const mod = await loadScript();
  const npmRoot = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-sdk-"));
  const hostRoot = await makeFakePackage(path.join(npmRoot, "openclaw"));
  const resolved = mod.resolveHostSdkRoot({
    env: { PATH: "" },
    platform: "win32",
    run: (command) => (command === "npm root -g" ? npmRoot : ""),
  });
  assert.equal(resolved, hostRoot);
});

test("resolveHostSdkRoot trả null khi không tìm thấy host", async () => {
  const mod = await loadScript();
  const resolved = mod.resolveHostSdkRoot({ env: { PATH: "" }, platform: "win32", run: () => "" });
  assert.equal(resolved, null);
});

test("linkHostSdk thay bản cài trong repo bằng junction trỏ tới host", async () => {
  const mod = await loadScript();
  const workspace = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-sdk-"));
  const repo = path.join(workspace, "repo");
  const hostRoot = await makeFakePackage(path.join(workspace, "host", "node_modules", "openclaw"), "9.9.9");
  // Bản cài "thật" trong repo (thư mục, không phải link).
  const local = path.join(repo, "node_modules", "openclaw");
  await makeFakePackage(local, "0.0.1");
  await writeFile(path.join(local, "marker.txt"), "x", "utf8");

  const result = mod.linkHostSdk({ repoRoot: repo, hostRoot, platform: "win32" });
  assert.equal(result.action, "linked");
  assert.equal(result.linkPath, local);
  assert.equal(result.hostVersion, "9.9.9");
  assert.equal(fs.lstatSync(local).isSymbolicLink(), true, "node_modules/openclaw phải là link");
  assert.equal(fs.realpathSync(local), fs.realpathSync(hostRoot));
  // Bản cài cũ trong repo đã bị thay (không còn marker.txt).
  assert.equal(fs.existsSync(path.join(local, "marker.txt")), false);
  // Nội dung của host không bị xoá nhầm.
  assert.equal(fs.existsSync(path.join(hostRoot, "package.json")), true);
});

test("linkHostSdk chạy lại thì không phá link đang có", async () => {
  const mod = await loadScript();
  const workspace = await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-sdk-"));
  const repo = path.join(workspace, "repo");
  const hostRoot = await makeFakePackage(path.join(workspace, "host", "node_modules", "openclaw"));
  await makeFakePackage(path.join(repo, "node_modules", "openclaw"), "0.0.1");

  mod.linkHostSdk({ repoRoot: repo, hostRoot, platform: "win32" });
  const again = mod.linkHostSdk({ repoRoot: repo, hostRoot, platform: "win32" });
  assert.equal(again.action, "already-linked");
  assert.equal(fs.realpathSync(path.join(repo, "node_modules", "openclaw")), fs.realpathSync(hostRoot));
});

test("runLink trả exit code khác 0 và hướng dẫn khi không tìm thấy host", async () => {
  const mod = await loadScript();
  const messages: string[] = [];
  const code = mod.runLink({
    repoRoot: await mkdtemp(path.join(os.tmpdir(), "zalo-monitor-sdk-")),
    env: { PATH: "" },
    platform: "win32",
    run: () => "",
    log: (message) => messages.push(message),
    error: (message) => messages.push(message),
  });
  assert.equal(code, 1);
  assert.ok(messages.some((message) => message.includes("openclaw")), "phải có thông báo lỗi nói rõ host openclaw");
});

test("package.json có script link:host-sdk", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(pkg.scripts?.["link:host-sdk"], "node scripts/link-host-sdk.mjs");
});
