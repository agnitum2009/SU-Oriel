import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";

import { PrismaSlotTerminalStore, SlotTerminalService } from "./slot-terminal.service.js";
import {
  isSlotTerminalNotFoundError,
  isSlotTerminalTargetForbiddenError
} from "./slot-terminal.errors.js";

export type SlotTerminalRouteDependencies = {
  prismaClient?: PrismaClient;
  service?: Pick<SlotTerminalService, "resolveRequirementTerminal" | "resolveAgentGroupTerminal">;
};

export async function registerSlotTerminalRoutes(
  app: FastifyInstance,
  dependencies: SlotTerminalRouteDependencies = {}
): Promise<void> {
  const service =
    dependencies.service ??
    new SlotTerminalService({
      store: dependencies.prismaClient ? new PrismaSlotTerminalStore(dependencies.prismaClient) : undefined
    });

  app.get("/api/projects/:projectId/requirements/:requirementId/slot-terminal", async (request, reply) => {
    const { projectId, requirementId } = request.params as { projectId: string; requirementId: string };

    try {
      return await service.resolveRequirementTerminal({
        projectId,
        requirementId
      });
    } catch (error) {
      if (isSlotTerminalNotFoundError(error)) {
        reply.status(404);
        return { message: error.message };
      }
      if (isSlotTerminalTargetForbiddenError(error)) {
        reply.status(403);
        return { message: error.message };
      }
      throw error;
    }
  });

  app.get("/api/projects/:projectId/agent-terminal/:group", async (request, reply) => {
    const { projectId, group } = request.params as { projectId: string; group: string };

    try {
      return await service.resolveAgentGroupTerminal({
        projectId,
        group
      });
    } catch (error) {
      if (isSlotTerminalNotFoundError(error)) {
        reply.status(404);
        return { message: error.message };
      }
      if (isSlotTerminalTargetForbiddenError(error)) {
        reply.status(403);
        return { message: error.message };
      }
      throw error;
    }
  });
}
