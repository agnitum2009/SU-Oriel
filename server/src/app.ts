import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";

import { prisma } from "./db/prisma.js";
import { SU_ORIEL_VERSION } from "./generated/version.js";
import {
  FileWatcherService,
  isFileWatcherEnabled,
  type FileWatcherLifecycle
} from "./fs/file-watcher-service.js";
import {
  StartupProjectScanService,
  type StartupProjectScanLifecycle
} from "./indexer/startup-project-scan.js";
import { registerActivityRoutes } from "./modules/activity/activity.routes.js";
import { registerAiCliRoutes } from "./modules/ai-cli/ai-cli.routes.js";
import { registerAiCliWs } from "./modules/ai-cli/ai-cli.ws.js";
import { registerAiToolsRoutes } from "./modules/ai-tools/ai-tools.routes.js";
import { registerCapabilityRoutes } from "./modules/capabilities/capabilities.routes.js";
import { registerCapabilityStatusRoutes } from "./modules/capabilities/status/status.routes.js";
import { registerCcbBridgeReceiptRoutes } from "./modules/ccb-bridge/receipt.routes.js";
import { registerCheckpointsRoutes } from "./modules/checkpoints/checkpoints.routes.js";
import { registerConsultRequestsRoutes } from "./modules/consult-requests/consult-requests.routes.js";
import {
  registerBreakdownDraftRoutes,
  type BreakdownDraftRouteDependencies
} from "./modules/breakdown-draft/breakdown-draft.routes.js";
import {
  registerAnchorRoutes,
  type AnchorRouteDependencies
} from "./modules/anchor-broker/anchor.routes.js";
import { registerDocumentRoutes } from "./modules/document/document.routes.js";
import { registerEventJournalRoutes } from "./modules/events/event-journal.routes.js";
import { registerEventStreamRoutes } from "./modules/events/event-stream.routes.js";
import { registerExecutorProfileRoutes } from "./modules/executor-profile/executor-profile.routes.js";
import { registerHookRoutes } from "./modules/hooks/hooks.routes.js";
import { registerKernelApplyRoutes } from "./modules/kernel/apply.routes.js";
import {
  registerPluginHookRoutes,
  type PluginHookRouteDependencies
} from "./modules/plugin-hooks/plugin-hooks.routes.js";
import { registerNodeRunRoutes } from "./modules/noderuns/noderuns.routes.js";
import { registerProjectRoutes } from "./modules/project/project.routes.js";
import {
  registerProjectOnboardingRoutes,
  type ProjectOnboardingRouteDependencies
} from "./modules/project/project-onboarding.routes.js";
import { PrismaProjectStore } from "./modules/project/project.store.prisma.js";
import {
  registerRequirementRoutes,
  type RequirementRouteDependencies
} from "./modules/requirement/requirement.routes.js";
import { registerRoleProfileRoutes } from "./modules/role-profile/role-profile.routes.js";
import { registerSettingsRoutes } from "./modules/settings/settings.routes.js";
import {
  registerSlotRoutes,
  type SlotRouteDependencies
} from "./modules/slot-binding/slot.routes.js";
import { registerSlotTerminalRoutes } from "./modules/slot-terminal/slot-terminal.routes.js";
import { registerSlotTerminalWebSocketRoutes } from "./modules/slot-terminal/slot-terminal.ws.js";
import { registerSyncRoutes } from "./modules/sync/sync.routes.js";
import { registerTaskRunRoutes } from "./modules/task-run/task-run.routes.js";
import { registerSprintRoutes } from "./modules/sprint/sprint.routes.js";
import { registerDeriveRoutes } from "./modules/task/derive.routes.js";
import { registerTaskRoutes } from "./modules/task/task.routes.js";
import { registerConsultRecordsRoutes } from "./modules/tasks/consult-records.routes.js";
import {
  registerStartAiSessionRoutes,
  type StartAiSessionRouteDependencies
} from "./modules/tasks/start-ai-session.routes.js";
import { registerTaskConsultationRoutes } from "./modules/tasks/task-consultation.routes.js";
import { registerTaskNodeFlowRoutes } from "./modules/tasks/task-node-flow.routes.js";
import { registerTaskEventViewRoutes } from "./modules/task-event-view/task-event-view.routes.js";
import { registerPendingInteractionsRoutes } from "./modules/tasks/pending-interactions.routes.js";
import {
  registerUserIntentRoutes,
  type UserIntentRouteDependencies
} from "./modules/user-intent/user-intent.routes.js";
import { registerTransitionProposalRoutes } from "./modules/transitions/transition-proposal.routes.js";
import { registerWorkspaceRoutes } from "./modules/workspace/workspace.routes.js";
import type { ProjectStore } from "./modules/project/project.types.js";

export interface AppDependencies {
  projectStore?: ProjectStore;
  enableFileWatcher?: boolean;
  fileWatcherService?: FileWatcherLifecycle | null;
  startupProjectScan?: StartupProjectScanLifecycle | null;
  startAiSession?: StartAiSessionRouteDependencies;
  breakdownDraft?: BreakdownDraftRouteDependencies;
  anchorBroker?: AnchorRouteDependencies;
  slots?: SlotRouteDependencies;
  projectOnboarding?: ProjectOnboardingRouteDependencies;
  requirementReanalyze?: RequirementRouteDependencies;
  pluginHooks?: PluginHookRouteDependencies;
  userIntent?: UserIntentRouteDependencies;
}

export function getAllowedCorsOrigins(): string[] {
  return (process.env.CCB_CORS_ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function buildApp(dependencies: AppDependencies = {}): FastifyInstance {
  const app = Fastify({
    disableRequestLogging: true,
    logger: {
      level: "info"
    }
  });

  void app.register(cors, {
    origin: getAllowedCorsOrigins()
  });
  void app.register(multipart);
  void app.register(websocket);

  app.get("/api/health", async () => {
    return {
      status: "ok",
      message: "服务运行正常",
      version: SU_ORIEL_VERSION
    };
  });

  app.get("/api/version", async () => {
    return SU_ORIEL_VERSION;
  });

  const watcherEnabled = dependencies.enableFileWatcher ?? isFileWatcherEnabled(process.env.CCB_INDEXER_WATCH);
  const fileWatcherService =
    dependencies.fileWatcherService === undefined
      ? process.env.NODE_ENV === "test"
        ? null
        : new FileWatcherService({ prisma, logger: app.log })
      : dependencies.fileWatcherService;

  void app.register(registerProjectRoutes, {
    projectStore: dependencies.projectStore ?? new PrismaProjectStore(prisma),
    fileWatcherService: watcherEnabled ? fileWatcherService : null
  });
  void app.register(registerProjectOnboardingRoutes, dependencies.projectOnboarding ?? {});
  void app.register(registerCcbBridgeReceiptRoutes);
  void app.register(registerCheckpointsRoutes);
  void app.register(registerConsultRequestsRoutes);
  void app.register(registerDocumentRoutes);
  void app.register(registerEventJournalRoutes);
  void app.register(registerEventStreamRoutes);
  void app.register(registerExecutorProfileRoutes);
  void app.register(registerTransitionProposalRoutes);
  void app.register(registerTaskRoutes);
  void app.register(registerDeriveRoutes);
  void app.register(registerAnchorRoutes, dependencies.anchorBroker ?? {});
  void app.register(registerSlotRoutes, dependencies.slots ?? {});
  void app.register(registerBreakdownDraftRoutes, dependencies.breakdownDraft ?? {});
  void app.register(registerStartAiSessionRoutes, dependencies.startAiSession ?? {});
  void app.register(registerSprintRoutes);
  void app.register(registerConsultRecordsRoutes);
  void app.register(registerTaskConsultationRoutes);
  void app.register(registerTaskNodeFlowRoutes);
  void app.register(registerTaskEventViewRoutes);
  void app.register(registerUserIntentRoutes, dependencies.userIntent ?? {});
  void app.register(registerPendingInteractionsRoutes);
  void app.register(registerActivityRoutes);
  void app.register(registerTaskRunRoutes);
  void app.register(registerRequirementRoutes, dependencies.requirementReanalyze ?? {});
  void app.register(registerRoleProfileRoutes);
  void app.register(registerSettingsRoutes, { fileWatcherService });
  void app.register(registerHookRoutes);
  void app.register(registerPluginHookRoutes, dependencies.pluginHooks ?? {});
  void app.register(registerKernelApplyRoutes);
  void app.register(registerWorkspaceRoutes);
  void app.register(registerSyncRoutes);
  void app.register(registerCapabilityRoutes);
  void app.register(registerCapabilityStatusRoutes);
  void app.register(registerNodeRunRoutes);
  void app.register(registerAiCliRoutes);
  void app.register(registerAiCliWs);
  void app.register(registerSlotTerminalRoutes);
  void app.register(registerSlotTerminalWebSocketRoutes, { allowedOrigins: getAllowedCorsOrigins() });
  void app.register(registerAiToolsRoutes);

  if (watcherEnabled && fileWatcherService) {
    app.addHook("onReady", async () => {
      await fileWatcherService.start();
    });
  }
  if (fileWatcherService) {
    app.addHook("onClose", async () => {
      await fileWatcherService.stop();
    });
  }

  const startupProjectScan =
    dependencies.startupProjectScan === undefined
      ? process.env.NODE_ENV === "test"
        ? null
        : new StartupProjectScanService({ prisma, logger: app.log })
      : dependencies.startupProjectScan;
  if (startupProjectScan) {
    app.addHook("onReady", async () => {
      void startupProjectScan.start().catch((error) => {
        app.log.warn(
          { event: "indexer.startup_scan.failed", err: error },
          "startup project scan failed; server will continue"
        );
      });
    });
  }

  return app;
}
