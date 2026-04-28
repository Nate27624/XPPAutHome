import { access, copyFile, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourceDir = resolve(here, "../../../packages/wasm-core/dist/wasm");
const targetDir = resolve(here, "../public/wasm");
const requiredFiles = ["xppcore.js", "xppcore.wasm"];

async function findMissingFiles(dirPath) {
  const missing = [];
  for (const fileName of requiredFiles) {
    try {
      await access(resolve(dirPath, fileName), fsConstants.R_OK);
    } catch {
      missing.push(fileName);
    }
  }
  return missing;
}

const missingInSource = await findMissingFiles(sourceDir);
if (missingInSource.length === 0) {
  await mkdir(targetDir, { recursive: true });
  for (const fileName of requiredFiles) {
    await copyFile(resolve(sourceDir, fileName), resolve(targetDir, fileName));
  }
  console.log(`Synced XPPAUT WASM artifacts to ${targetDir}`);
  process.exit(0);
}

const missingInTarget = await findMissingFiles(targetDir);
if (missingInTarget.length === 0) {
  console.warn(
    `WASM artifacts not found in ${sourceDir}; using committed artifacts from ${targetDir}.`
  );
  process.exit(0);
}

throw new Error(
  `Missing WASM artifacts in both ${sourceDir} (${missingInSource.join(", ")}) and ` +
    `${targetDir} (${missingInTarget.join(", ")}). Build them first with \`npm run wasm:build\`.`
);
