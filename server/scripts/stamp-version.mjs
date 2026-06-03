import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(scriptDir, "..");
const suOrielRoot = resolve(serverRoot, "..");
const packageJsonPath = join(serverRoot, "package.json");
const outputPath = join(serverRoot, "src", "generated", "version.ts");

function readGitSha() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: suOrielRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function renderVersionModule(versionInfo) {
  return `export const SU_ORIEL_VERSION = ${JSON.stringify(versionInfo, null, 2)} as const;\n`;
}

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const versionInfo = {
  name: packageJson.name,
  version: packageJson.version,
  gitSha: readGitSha(),
  buildDate: new Date().toISOString()
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, renderVersionModule(versionInfo), "utf8");
