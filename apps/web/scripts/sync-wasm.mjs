import { access, copyFile, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourceDir = resolve(here, "../../../packages/wasm-core/dist/wasm");
const targetDir = resolve(here, "../public/wasm");
const requiredFiles = ["xppcore.js", "xppcore.wasm"];

const missing = [];
for (const fileName of requiredFiles) {
  try {
    await access(resolve(sourceDir, fileName), fsConstants.R_OK);
  } catch {
    missing.push(fileName);
  }
}

if (missing.length > 0) {
  throw new Error(
    `Missing WASM artifacts in ${sourceDir}: ${missing.join(", ")}. ` +
      "Build them first with `npm run wasm:build`."
  );
}

await mkdir(targetDir, { recursive: true });
for (const fileName of requiredFiles) {
  await copyFile(resolve(sourceDir, fileName), resolve(targetDir, fileName));
}

console.log(`Synced XPPAUT WASM artifacts to ${targetDir}`);
