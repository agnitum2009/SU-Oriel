import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 把 src/ 下的非 TS 运行时资源（当前为内置 docs-structure 契约 .yaml）镜像到 dist/。
// tsc 只把 .ts 编译成 .js，从不拷贝同目录的资源文件；任何在运行时按 import.meta.url
// 相对读取的文件都必须在此手动镜像，否则 `pnpm start`(node dist/…) 会缺资源而报错，
// 而 `pnpm dev`(tsx src/…) 因直接跑 src 不受影响 —— 二者由本脚本保持一致。
const scriptDir = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(scriptDir, "..");
const srcRoot = join(serverRoot, "src");
const distRoot = join(serverRoot, "dist");

function collectAssets(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectAssets(full));
    else if (entry.isFile() && entry.name.endsWith(".yaml")) out.push(full);
  }
  return out;
}

let copied = 0;
for (const file of collectAssets(srcRoot)) {
  const rel = relative(srcRoot, file);
  const dest = join(distRoot, rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(file, dest);
  copied += 1;
  console.log(`[copy-dist-assets] ${rel}`);
}
console.log(`[copy-dist-assets] copied ${copied} asset(s) into dist/`);
