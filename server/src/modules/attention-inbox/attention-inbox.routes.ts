import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { prisma } from "../../db/prisma.js";
import {
  AttentionInboxService,
  AttentionProjectNotFoundError,
  type AttentionInboxServiceLike
} from "./attention-inbox.service.js";

const ATTENTION_ACK_REF_PREFIXES = [
  "review_intent:",
  "consult_request:",
  "event_journal:",
  "dev_task_approval:",
  "slot_binding:",
  "provider_activity:"
] as const;

const ackBodySchema = z.object({
  ref: z.string().trim().min(1).max(500).refine(isAllowedAttentionAckRef, {
    message: "attention ref 前缀不合法"
  })
});

const settingsBodySchema = z.object({
  dnd_until: z.string().trim().min(1).nullable()
});

export interface AttentionInboxRouteDependencies {
  service?: AttentionInboxServiceLike;
}

export async function registerAttentionInboxRoutes(
  app: FastifyInstance,
  dependencies: AttentionInboxRouteDependencies = {}
): Promise<void> {
  const service = dependencies.service ?? new AttentionInboxService(prisma);

  app.get("/api/projects/:projectId/attention", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    try {
      return await service.computeAttention(projectId);
    } catch (error) {
      return handleAttentionError(reply, error);
    }
  });

  app.post("/api/projects/:projectId/attention/ack", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const parsed = ackBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.status(400);
      return { message: "attention ack 参数不合法", issues: parsed.error.issues };
    }

    try {
      return await service.ackAttention(projectId, parsed.data.ref);
    } catch (error) {
      return handleAttentionError(reply, error);
    }
  });

  app.get("/api/projects/:projectId/attention/settings", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    try {
      return await service.getSettings(projectId);
    } catch (error) {
      return handleAttentionError(reply, error);
    }
  });

  app.put("/api/projects/:projectId/attention/settings", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const parsed = settingsBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.status(400);
      return { message: "attention settings 参数不合法", issues: parsed.error.issues };
    }
    const dndUntil = parseOptionalDate(parsed.data.dnd_until);
    if (dndUntil === "invalid") {
      reply.status(400);
      return { message: "dnd_until 必须是 ISO datetime 或 null" };
    }

    try {
      return await service.putSettings(projectId, dndUntil);
    } catch (error) {
      return handleAttentionError(reply, error);
    }
  });
}

function parseOptionalDate(value: string | null): Date | null | "invalid" {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "invalid" : date;
}

function isAllowedAttentionAckRef(ref: string): boolean {
  return ATTENTION_ACK_REF_PREFIXES.some((prefix) => ref.startsWith(prefix));
}

function handleAttentionError(reply: { status: (code: number) => void }, error: unknown): { message: string } {
  if (error instanceof AttentionProjectNotFoundError) {
    reply.status(404);
    return { message: error.message };
  }
  throw error;
}
