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
