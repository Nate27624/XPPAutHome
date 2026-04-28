import { access } from "node:fs/promises";

const files = [
  "models/lecar.ode",
  "models/wc.ode",
  "models/fhn.ode",
  "models/simplefold.ode"
];

for (const rel of files) {
  const path = new URL(`../${rel}`, import.meta.url);
  await access(path);
}

console.log(`Verified ${files.length} benchmark model files.`);
