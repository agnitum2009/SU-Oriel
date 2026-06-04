import { isAbsolute, relative, resolve } from "node:path";

export function resolveProjectPath(projectRoot: string, filePath: string): { absolutePath: string; relativePath: string } {
  const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(projectRoot, filePath);
  const relativePath = relative(projectRoot, absolutePath).replace(/\\/g, "/");
  if (!relativePath || relativePath.startsWith("../") || relativePath === ".." || isAbsolute(relativePath)) {
    throw new Error(`artifact path escapes project root: ${filePath}`);
  }
  return { absolutePath, relativePath };
}
