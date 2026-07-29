import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

if (process.platform !== "darwin") {
  throw new Error("make:mac-icon 必须在 macOS 上运行；请使用 GitHub Actions 的 macos-14 runner。");
}

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconSet = path.join(root, "build", "icon.iconset");
const output = path.join(root, "build", "icon.icns");
const source = path.join(root, "public", "project-logo.png");
const variants = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

await fs.rm(iconSet, { recursive: true, force: true });
await fs.mkdir(iconSet, { recursive: true });

await Promise.all(variants.map(async ([name, size]) => {
  await sharp(source)
    .resize(size, size, { fit: "contain", background: { r: 255, g: 248, b: 234, alpha: 1 } })
    .png()
    .toFile(path.join(iconSet, name));
}));

await fs.rm(output, { force: true });
await run("iconutil", ["-c", "icns", iconSet, "-o", output]);
await fs.rm(iconSet, { recursive: true, force: true });
