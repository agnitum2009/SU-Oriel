import { join } from "node:path";

import {
  MANAGED_CCB_CONFIG_RELATIVE_PATH,
  buildManagedCcbConfig,
  ensureManagedCcbConfig,
  projectSlotTopology
} from "../project-ccbd/managed-config.service.js";

export const ANCHOR_CONFIG_RELATIVE_PATH = MANAGED_CCB_CONFIG_RELATIVE_PATH;

export function buildAnchorConfig(): string {
  return buildManagedCcbConfig(projectSlotTopology());
}

export async function writeAnchorConfig(anchorRoot: string): Promise<string> {
  const configPath = join(anchorRoot, ANCHOR_CONFIG_RELATIVE_PATH);
  await ensureManagedCcbConfig({
    projectId: "legacy-anchor-template",
    projectRoot: anchorRoot,
    topology: projectSlotTopology()
  });
  return configPath;
}

export class AnchorTemplateService {
  buildConfig(): string {
    return buildAnchorConfig();
  }

  async writeConfig(anchorRoot: string): Promise<string> {
    return await writeAnchorConfig(anchorRoot);
  }
}
