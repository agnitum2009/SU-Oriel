import type { FastifyInstance } from "fastify";
import type { Document, Requirement, ReviewIntent, Task } from "@prisma/client";

import { prisma } from "../../db/prisma.js";
import { buildEventJournalTimelineEvents } from "../events/event-journal.service.js";
import { primitiveExecutor } from "../primitive/primitive-wrapper.js";
import {
  rollupAllRequirementsForProject,
  rollupRequirementStatusById
} from "../requirement/requirement-status-rollup.js";
import { mapNodeToPhase } from "./phase-derive.js";
import {
  computeRequirementAggregation,
  computeProjectAggregations
} from "./progress-aggregation.js";
import {
  consumeReviewIntentSchema,
  createReviewIntentSchema,
  listReviewIntentQuerySchema,
  updateTaskSchema
} from "./task.schemas.js";
import { AnchorDispatchQueuePolicyError } from "../anchor-broker/anchor-dispatch-queue-policy.js";
import { JobSlotRouter } from "../slot-binding/job-slot-router.js";
import {
  isSlotResizeLockTimeoutError,
  slotResizeLockTimeoutBody
} from "../slot-resize/resize-lock.js";
import { loadTaskMarkdownBody, TaskMarkdownNotFoundError } from "./task-markdown.service.js";

interface TaskNodeFields {
  currentNode?: string | null;
  nodeSubstate?: string | null;
  runtimeState?: string | null;
  lastTransitionId?: string | null;
}

interface TimelineEvent {
  kind: string;
  at: string;
  label: string;
  details?: Record<string, unknown>;
}

const DOCUMENT_KIND_VALUES = new Set(["plan", "task", "state", "dev_task", "decision", "template", "index", "other"]);
const PLUGIN_CANONICAL_DEV_TASK_FIELDS = ["status", "progress", "blockedReason"] as const;

function serializeNodeFields(task: TaskNodeFields) {
  return {
    currentNode: task.currentNode ?? null,
    nodeSubstate: task.nodeSubstate ?? null,
    runtimeState: task.runtimeState ?? null,
    lastTransitionId: task.lastTransitionId ?? null
  };
}

function serializeTaskListItem(task: Task, semanticKind: string | null = null) {
  return {
    id: task.id,
    projectId: task.projectId,
    taskKey: task.taskKey,
    title: task.title,
    summary: task.summary,
    semanticKind,
    kind: "subtask",
    specSectionId: task.specSectionId,
    implementationOwner: task.implementationOwner,
    // ===== TAPD 迭代 (Phase C) =====
    sprintId: task.sprintId,
    storyPoints: task.storyPoints,
    // =========================================
    status: task.status,
    phase: mapNodeToPhase(task.currentNode),
    ...serializeNodeFields(task as TaskNodeFields),
    priority: task.priority,
    progress: task.progress,
    step: null,
    blockedReason: task.blockedReason,
    requirementId: task.requirementId,
    reviewStatus: task.reviewStatus,
    updatedAt: task.updatedAt.toISOString()
  };
}

function serializeLinkedRequirement(requirement: Requirement | null) {
  if (!requirement) {
    return null;
  }

  return {
    id: requirement.id,
    title: requirement.title,
    verbatimSource: requirement.verbatimSource ?? requirement.description
  };
}

function serializeReviewProjection(task: Task) {
  return {
    reviewStatus: task.reviewStatus ?? null,
    verificationResult: parseJsonProjection(task.verificationResultJson),
    reviewFollowup: normalizeReviewFollowup(parseJsonProjection(task.reviewFollowupJson))
  };
}

function serializeReviewIntent(intent: ReviewIntent) {
  return {
    id: intent.id,
    projectId: intent.projectId,
    taskId: intent.taskId,
    taskKey: intent.taskKey,
    intentType: intent.intentType,
    payload: parseReviewPayload(intent.payloadJson),
    status: intent.status,
    actor: intent.actor,
    consumedAt: intent.consumedAt?.toISOString() ?? null,
    consumedBy: intent.consumedBy,
    attemptCount: intent.attemptCount,
    lastError: intent.lastError,
    lastAttemptAt: intent.lastAttemptAt?.toISOString() ?? null,
    isStale: intent.status === "pending" && intent.attemptCount >= 3,
    createdAt: intent.createdAt.toISOString(),
    updatedAt: intent.updatedAt.toISOString()
  };
}

function parseJsonProjection(value: string | null): unknown {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeReviewFollowup(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function parseReviewPayload(value: string | null): string | null {
  const parsed = parseJsonProjection(value);
  if (typeof parsed === "string") {
    return parsed;
  }
  if (parsed && typeof parsed === "object" && "comment" in parsed) {
    const comment = (parsed as { comment?: unknown }).comment;
    return typeof comment === "string" ? comment : null;
  }
  return null;
}

function serializeTimelineEvent(event: TimelineEvent) {
  return {
    kind: event.kind,
    at: event.at,
    label: event.label,
    ...(event.details ? { details: event.details } : {})
  };
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseFrontmatterRecord(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function extractSemanticKind(document: Pick<Document, "kind" | "frontmatterJson">): string | null {
  const frontmatter = parseFrontmatterRecord(document.frontmatterJson);
  const rawKind = typeof frontmatter.kind === "string" ? frontmatter.kind.trim().toLowerCase() : "";
  if (!rawKind || DOCUMENT_KIND_VALUES.has(rawKind)) {
    return null;
  }
  return rawKind;
}

function selectSemanticKind(documents: Array<Pick<Document, "kind" | "frontmatterJson">>): string | null {
  const orderedKinds = ["dev_task"];
  for (const kind of orderedKinds) {
    const document = documents.find((item) => item.kind === kind);
    if (document) {
      const semanticKind = extractSemanticKind(document);
      if (semanticKind) {
        return semanticKind;
      }
    }
  }

  for (const document of documents) {
    const semanticKind = extractSemanticKind(document);
    if (semanticKind) {
      return semanticKind;
    }
  }
  return null;
}

async function loadSemanticKindByTaskKey(projectId: string, taskKeys: string[]): Promise<Map<string, string | null>> {
  if (taskKeys.length === 0) {
    return new Map();
  }

  const documents = await prisma.document.findMany({
    where: {
      projectId,
      taskKey: {
        in: taskKeys
      }
    },
    select: {
      taskKey: true,
      kind: true,
      frontmatterJson: true
    }
  });
  const grouped = new Map<string, typeof documents>();

  for (const document of documents) {
    if (!document.taskKey) {
      continue;
    }
    const bucket = grouped.get(document.taskKey) ?? [];
    bucket.push(document);
    grouped.set(document.taskKey, bucket);
  }

  return new Map(Array.from(grouped.entries()).map(([taskKey, items]) => [taskKey, selectSemanticKind(items)]));
}

function normalizeEventDate(value: unknown, fallback: Date): string {
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return fallback.toISOString();
}

async function updateTaskMetadataAsync(
  taskId: string,
  data: {
    priority?: string;
  }
): Promise<Task> {
  return await primitiveExecutor.run({
    primitive: "update_task_metadata",
    mutationType: "prisma.task.update",
    idempotencyKey: `${taskId}:update_task_metadata`,
    run: async () =>
      await prisma.task.update({
        where: {
          id: taskId
        },
        data
      })
  });
}

function hasPluginCanonicalDevTaskField(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }
  return PLUGIN_CANONICAL_DEV_TASK_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(body, field));
}

function buildRequirementCancelCommand(input: { projectId: string; requirementId: string }): string {
  return `/ccb:su-cancel --payload ${JSON.stringify({
    project_id: input.projectId,
    requirement_id: input.requirementId,
    source: "console_requirement_cancel",
    subject: "requirement"
  })}`;
}

function buildRequirementDeferCommand(input: { projectId: string; requirementId: string }): string {
  return `/ccb:su-defer --payload ${JSON.stringify({
    project_id: input.projectId,
    requirement_id: input.requirementId,
    source: "console_requirement_defer",
    subject: "requirement"
  })}`;
}

async function enqueueRequirementStatusDispatch(input: {
  requirementId: string;
  projectId: string;
  command: string;
  source: string;
}): Promise<{ jobId: string; anchorId: string; queuedAt: Date }> {
  const router = new JobSlotRouter({ prismaClient: prisma });
  const queued = await router.enqueue({
    projectId: input.projectId,
    requirementId: input.requirementId,
    subjectType: "requirement",
    subjectId: input.requirementId,
    command: input.command,
    dispatchPayload: {
      project_id: input.projectId,
      requirement_id: input.requirementId,
      source: input.source,
      subject: "requirement"
    }
  });
  return { jobId: queued.jobId, anchorId: queued.slotId ?? "slot-unassigned", queuedAt: queued.queuedAt };
}

async function enqueueRequirementCancelDispatch(input: {
  requirementId: string;
  projectId: string;
}): Promise<{ jobId: string; anchorId: string; queuedAt: Date }> {
  return await enqueueRequirementStatusDispatch({
    ...input,
    command: buildRequirementCancelCommand(input),
    source: "console_requirement_cancel"
  });
}

async function enqueueRequirementDeferDispatch(input: {
  requirementId: string;
  projectId: string;
}): Promise<{ jobId: string; anchorId: string; queuedAt: Date }> {
  return await enqueueRequirementStatusDispatch({
    ...input,
    command: buildRequirementDeferCommand(input),
    source: "console_requirement_defer"
  });
}

function buildDevTaskTimelineEvents(devTaskDocument: Document | null): TimelineEvent[] {
  if (!devTaskDocument) {
    return [];
  }

  const frontmatter = parseFrontmatterRecord(devTaskDocument.frontmatterJson);
  const fallbackAt = devTaskDocument.mtime;
  const events: TimelineEvent[] = [];
  const nodesExecuted = parseJsonArray(frontmatter.nodes_executed ?? frontmatter.nodesExecuted).map((node) =>
    String(node)
  );

  if (nodesExecuted.length > 0) {
    events.push({
      kind: "transition",
      at: fallbackAt.toISOString(),
      label: `Nodes executed: ${nodesExecuted.join(" -> ")}`,
      details: {
        nodesExecuted,
        lastTransitionId:
          typeof frontmatter.lastTransitionId === "string"
            ? frontmatter.lastTransitionId
            : typeof frontmatter.last_transition_id === "string"
              ? frontmatter.last_transition_id
              : null,
        approximate: true
      }
    });
  }

  for (const record of parseJsonArray(frontmatter.approval_records ?? frontmatter.approvalRecords)) {
    const approval = typeof record === "object" && record !== null ? (record as Record<string, unknown>) : {};
    const gate = typeof approval.gate === "string" ? approval.gate : "unknown";
    const status = typeof approval.status === "string" ? approval.status : "unknown";
    events.push({
      kind: "approval",
      at: normalizeEventDate(approval.timestamp, fallbackAt),
      label: `Approval gate: ${gate}`,
      details: {
        gate,
        status
      }
    });
  }

  const consultRoundIds = parseJsonArray(frontmatter.consult_round_ids ?? frontmatter.consultRoundIds).map((roundId) =>
    String(roundId)
  );
  if (consultRoundIds.length > 0) {
    events.push({
      kind: "consult",
      at: fallbackAt.toISOString(),
      label: `Consult rounds: ${consultRoundIds.length}`,
      details: {
        consultRoundIds
      }
    });
  }

  return events;
}

function buildReviewIntentTimelineEvents(intents: ReviewIntent[]): TimelineEvent[] {
  return intents.flatMap((intent) => {
    const events: TimelineEvent[] = [
      {
        kind: "intent_create",
        at: intent.createdAt.toISOString(),
        label: `Review intent created: ${intent.intentType}`,
        details: {
          status: intent.status,
          payload: parseReviewPayload(intent.payloadJson)
        }
      }
    ];

    if (intent.status === "cancelled") {
      events.push({
        kind: "intent_cancel",
        at: intent.updatedAt.toISOString(),
        label: `Review intent cancelled: ${intent.intentType}`,
        details: {
          payload: parseReviewPayload(intent.payloadJson)
        }
      });
    }

    return events;
  });
}

function sortTimelineEvents(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime());
}

export async function registerTaskRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/projects/:projectId/tasks", async (request) => {
    const { projectId } = request.params as { projectId: string };

    const tasks = await prisma.task.findMany({
      where: {
        projectId
      },
      orderBy: [{ updatedAt: "desc" }]
    });
    const semanticKindByTaskKey = await loadSemanticKindByTaskKey(
      projectId,
      tasks.map((task) => task.taskKey)
    );

    return {
      items: tasks.map((task) => serializeTaskListItem(task, semanticKindByTaskKey.get(task.taskKey) ?? null))
    };
  });

  app.get("/api/projects/:projectId/tasks/:taskId/markdown", async (request, reply) => {
    const { projectId, taskId } = request.params as { projectId: string; taskId: string };

    try {
      return await loadTaskMarkdownBody(prisma, projectId, taskId);
    } catch (error) {
      if (error instanceof TaskMarkdownNotFoundError) {
        reply.status(404);
        return {
          message: "任务文档不存在或尚未进入索引"
        };
      }
      throw error;
    }
  });

  app.get("/api/tasks/:taskId", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };

    const task = await prisma.task.findUnique({
      where: {
        id: taskId
      }
    });

    if (!task) {
      reply.status(404);
      return {
        message: "任务不存在"
      };
    }

    const linkedDocuments = await prisma.document.findMany({
      where: {
        projectId: task.projectId,
        taskKey: task.taskKey,
        kind: "dev_task"
      },
      orderBy: {
        path: "asc"
      }
    });
    const linkedRequirement = await prisma.requirement.findFirst({
      where: {
        projectId: task.projectId,
        id: task.requirementId ?? "__no_requirement__"
      }
    });
    const reviewIntents = await prisma.reviewIntent.findMany({
      where: {
        taskId: task.id
      },
      orderBy: {
        createdAt: "desc"
      }
    });
    const reviewProjection = serializeReviewProjection(task);
    const semanticKind = selectSemanticKind(linkedDocuments);

    return {
      id: task.id,
      projectId: task.projectId,
      taskKey: task.taskKey,
      title: task.title,
      summary: task.summary,
      semanticKind,
      kind: "subtask",
      specSectionId: task.specSectionId,
      implementationOwner: task.implementationOwner,
      status: task.status,
      phase: mapNodeToPhase(task.currentNode),
      ...serializeNodeFields(task as TaskNodeFields),
      priority: task.priority,
      progress: task.progress,
      blockedReason: task.blockedReason,
      requirementId: task.requirementId,
      linkedRequirement: serializeLinkedRequirement(linkedRequirement),
      ...reviewProjection,
      reviewProjection,
      reviewIntents: reviewIntents.map((intent) => serializeReviewIntent(intent)),
      linkedDocuments: linkedDocuments.map((document) => ({
        id: document.id,
        path: document.path,
        kind: document.kind,
        title: document.title,
        status: document.status
      })),
      updatedAt: task.updatedAt.toISOString()
    };
  });

  app.get("/api/tasks/:taskId/timeline", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = await prisma.task.findUnique({
      where: {
        id: taskId
      }
    });

    if (!task) {
      reply.status(404);
      return {
        message: "任务不存在"
      };
    }

    const [devTaskDocument, reviewIntents, eventJournalEvents] = await Promise.all([
      prisma.document.findFirst({
        where: {
          projectId: task.projectId,
          taskKey: task.taskKey,
          kind: "dev_task"
        },
        orderBy: {
          path: "asc"
        }
      }),
      prisma.reviewIntent.findMany({
        where: {
          taskId: task.id
        }
      }),
      buildEventJournalTimelineEvents(task.id)
    ]);

    return {
      taskId: task.id,
      events: sortTimelineEvents([
        ...buildDevTaskTimelineEvents(devTaskDocument),
        ...buildReviewIntentTimelineEvents(reviewIntents),
        ...eventJournalEvents
      ]).map((event) => serializeTimelineEvent(event))
    };
  });

  app.post("/api/projects/:projectId/refresh-requirement-status", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) {
      reply.status(404);
      return { message: "项目不存在" };
    }
    const result = await rollupAllRequirementsForProject(prisma, projectId);
    return { updated: result.updated, checked: result.checked };
  });

  app.post("/api/projects/:projectId/reconcile-epic-status", async (request, reply) => {
    void request;
    reply.status(410);
    return { message: "Epic 状态修复接口已废弃，请使用需求状态刷新。" };
  });

  app.post("/api/requirements/:requirementId/refresh-status", async (request, reply) => {
    const { requirementId } = request.params as { requirementId: string };
    const req = await prisma.requirement.findUnique({ where: { id: requirementId }, select: { id: true } });
    if (!req) {
      reply.status(404);
      return { message: "需求不存在" };
    }
    const result = await rollupRequirementStatusById(prisma, requirementId);
    return {
      updated: result.updated,
      oldStatus: result.oldStatus,
      newStatus: result.newStatus
    };
  });

  app.get("/api/tasks/:taskId/review-intents", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const parsedQuery = listReviewIntentQuerySchema.safeParse(request.query ?? {});

    if (!parsedQuery.success) {
      reply.status(400);
      return {
        message: "review intent 查询参数不合法",
        issues: parsedQuery.error.issues
      };
    }

    const task = await prisma.task.findUnique({
      where: {
        id: taskId
      },
      select: {
        id: true
      }
    });

    if (!task) {
      reply.status(404);
      return {
        message: "任务不存在"
      };
    }

    const intents = await prisma.reviewIntent.findMany({
      where: {
        taskId,
        ...(parsedQuery.data.status ? { status: parsedQuery.data.status } : {})
      },
      orderBy: {
        createdAt: "desc"
      }
    });

    return {
      items: intents.map((intent) => serializeReviewIntent(intent))
    };
  });

  app.post("/api/tasks/:taskId/review-intents", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const parsed = createReviewIntentSchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      reply.status(400);
      return {
        message: "review intent 参数不合法",
        issues: parsed.error.issues
      };
    }

    const task = await prisma.task.findUnique({
      where: {
        id: taskId
      },
      select: {
        id: true,
        projectId: true,
        taskKey: true
      }
    });

    if (!task) {
      reply.status(404);
      return {
        message: "任务不存在"
      };
    }

    const intent = await primitiveExecutor.run({
      primitive: "create_review_intent",
      mutationType: "prisma.reviewIntent.create",
      idempotencyKey: null,
      run: async () =>
        await prisma.reviewIntent.create({
          data: {
            projectId: task.projectId,
            taskId: task.id,
            taskKey: task.taskKey,
            intentType: parsed.data.intentType,
            payloadJson: parsed.data.payload ? JSON.stringify(parsed.data.payload) : null,
            status: "pending"
          }
        })
    });

    reply.status(201);
    return serializeReviewIntent(intent);
  });

  app.post("/api/review-intents/:intentId/consume", async (request, reply) => {
    const { intentId } = request.params as { intentId: string };
    const parsed = consumeReviewIntentSchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      reply.status(400);
      return {
        message: "review intent consume 参数不合法",
        issues: parsed.error.issues
      };
    }

    const intent = await prisma.reviewIntent.findUnique({
      where: {
        id: intentId
      }
    });

    if (!intent) {
      reply.status(404);
      return {
        message: "review intent 不存在"
      };
    }

    if (intent.status === "cancelled") {
      reply.status(409);
      return {
        message: "review intent 已取消，不能标记为 considered"
      };
    }

    if (intent.status === "consumed") {
      return {
        success: true,
        result: "already_consumed",
        idempotent: true,
        intent: serializeReviewIntent(intent)
      };
    }

    if (parsed.data.result === "failed") {
      // failureReason 不新增持久化列，按三字段迁移约束写入 lastError 前缀。
      const failureReason = parsed.data.failureReason;
      const failureError = parsed.data.error;
      const updatedIntent = await primitiveExecutor.run({
        primitive: "consume_review_intent",
        mutationType: "prisma.reviewIntent.update",
        idempotencyKey: `${intentId}:consume_review_intent:failed`,
        run: async () =>
          await prisma.reviewIntent.update({
            where: {
              id: intentId
            },
            data: {
              attemptCount: {
                increment: 1
              },
              lastAttemptAt: new Date(),
              lastError: `${failureReason}: ${failureError}`
            }
          })
      });

      return {
        success: false,
        result: "failure_recorded",
        idempotent: false,
        intent: serializeReviewIntent(updatedIntent)
      };
    }

    const updatedIntent = await primitiveExecutor.run({
      primitive: "consume_review_intent",
      mutationType: "prisma.reviewIntent.update",
      idempotencyKey: `${intentId}:consume_review_intent:considered`,
      run: async () =>
        await prisma.reviewIntent.update({
          where: {
            id: intentId
          },
          data: {
            status: "consumed",
            consumedAt: new Date(),
            consumedBy: parsed.data.consumer,
            lastError: null
          }
        })
    });

    return {
      success: true,
      result: "consumed",
      idempotent: false,
      intent: serializeReviewIntent(updatedIntent)
    };
  });

  app.delete("/api/review-intents/:intentId", async (request, reply) => {
    const { intentId } = request.params as { intentId: string };
    const intent = await prisma.reviewIntent.findUnique({
      where: {
        id: intentId
      }
    });

    if (!intent) {
      reply.status(404);
      return {
        message: "review intent 不存在"
      };
    }

    return serializeReviewIntent(
      await primitiveExecutor.run({
        primitive: "cancel_review_intent",
        mutationType: "prisma.reviewIntent.update",
        idempotencyKey: `${intentId}:cancel_review_intent`,
        run: async () =>
          await prisma.reviewIntent.update({
            where: {
              id: intentId
            },
            data: {
              status: "cancelled"
            }
          })
      })
    );
  });

  /*
   * v0.3.2: user-facing PATCH only accepts {priority}.
   * currentNode/nodeSubstate/runtimeState/lastTransitionId are written by indexer
   * from docs/03 dev_task frontmatter.
   */
  app.patch("/api/tasks/:taskId", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const rawBody = request.body;

    if (
      rawBody &&
      typeof rawBody === "object" &&
      !Array.isArray(rawBody) &&
      Object.prototype.hasOwnProperty.call(rawBody, "phase")
    ) {
      reply.status(400);
      return {
        error: "phase field is deprecated, use currentNode"
      };
    }

    if (hasPluginCanonicalDevTaskField(rawBody)) {
      reply.status(400);
      return {
        code: "plugin_canonical_dev_task",
        message: "status/progress/blockedReason 由 dev_task 文档维护，请通过 anchor dispatch / reconcile 修改"
      };
    }

    const parsed = updateTaskSchema.safeParse(request.body);

    if (!parsed.success) {
      reply.status(400);
      return {
        message: "任务更新参数不合法",
        issues: parsed.error.issues
      };
    }

    const nextTask = await updateTaskMetadataAsync(taskId, {
      priority: parsed.data.priority
    });

    return {
      ...serializeTaskListItem(nextTask),
      blockedReason: nextTask.blockedReason
    };
  });

  // ===========================================================================
  // M2-PR4: Hierarchy endpoints (ADR-0013)
  // ===========================================================================

  app.get("/api/epics/:epicId/aggregation", async (request, reply) => {
    void request;
    reply.status(410);
    return { message: "Epic 已取消，请使用需求聚合接口。" };
  });

  app.get("/api/epics/:epicId/subtasks", async (request, reply) => {
    void request;
    reply.status(410);
    return { message: "Epic 已取消，请从需求详情页查看子任务。" };
  });

  app.get("/api/requirements/:requirementId/epics", async (request, reply) => {
    void request;
    reply.status(410);
    return { message: "Epic 已取消，请使用需求详情页子任务列表。" };
  });

  app.get("/api/requirements/:requirementId/aggregation", async (request, reply) => {
    const { requirementId } = request.params as { requirementId: string };
    const agg = await computeRequirementAggregation(prisma, requirementId);
    if (!agg) {
      reply.status(404);
      return { message: "需求不存在" };
    }
    return agg;
  });

  app.get("/api/projects/:projectId/hierarchy-aggregations", async (request) => {
    const { projectId } = request.params as { projectId: string };
    return computeProjectAggregations(prisma, projectId);
  });

  app.post("/api/epics/:epicId/cancel", async (request, reply) => {
    void request;
    reply.status(410);
    return { message: "Epic 已取消，请在需求详情页使用取消需求。" };
  });

  app.post("/api/requirements/:requirementId/cancel", async (request, reply) => {
    const { requirementId } = request.params as { requirementId: string };
    const req = await prisma.requirement.findUnique({ where: { id: requirementId } });
    if (!req) {
      reply.status(404);
      return { message: "需求不存在" };
    }
    try {
      const queued = await enqueueRequirementCancelDispatch({
        projectId: req.projectId,
        requirementId
      });
      reply.status(202);
      return {
        jobId: queued.jobId,
        job_id: queued.jobId,
        anchorId: queued.anchorId,
        subjectId: requirementId,
        requirementId,
        status: "queued",
        queuedAt: queued.queuedAt.toISOString()
      };
    } catch (error) {
      if (error instanceof AnchorDispatchQueuePolicyError) {
        reply.status(error.statusCode);
        return {
          code: error.code,
          message: error.message
        };
      }
      if (isSlotResizeLockTimeoutError(error)) {
        reply.status(error.statusCode);
        return slotResizeLockTimeoutBody(error);
      }
      const code = error instanceof Error ? error.message : "anchor_dispatch_failed";
      reply.status(code === "planning_anchor_missing" || code === "planning_anchor_paused" ? 409 : 500);
      return {
        code,
        message:
          code === "planning_anchor_missing"
            ? "需求未绑定可用 planning anchor，请先启动 planning anchor"
            : code === "planning_anchor_paused"
              ? "planning anchor 运行时已暂停"
              : "取消需求指令派发失败"
      };
    }
  });

  app.post("/api/requirements/:requirementId/defer", async (request, reply) => {
    const { requirementId } = request.params as { requirementId: string };
    const req = await prisma.requirement.findUnique({ where: { id: requirementId } });
    if (!req) {
      reply.status(404);
      return { message: "需求不存在" };
    }
    try {
      const queued = await enqueueRequirementDeferDispatch({
        projectId: req.projectId,
        requirementId
      });
      reply.status(202);
      return {
        jobId: queued.jobId,
        job_id: queued.jobId,
        anchorId: queued.anchorId,
        subjectId: requirementId,
        requirementId,
        status: "queued",
        queuedAt: queued.queuedAt.toISOString()
      };
    } catch (error) {
      if (error instanceof AnchorDispatchQueuePolicyError) {
        reply.status(error.statusCode);
        return {
          code: error.code,
          message: error.message
        };
      }
      if (isSlotResizeLockTimeoutError(error)) {
        reply.status(error.statusCode);
        return slotResizeLockTimeoutBody(error);
      }
      const code = error instanceof Error ? error.message : "anchor_dispatch_failed";
      reply.status(code === "planning_anchor_missing" || code === "planning_anchor_paused" ? 409 : 500);
      return {
        code,
        message:
          code === "planning_anchor_missing"
            ? "需求未绑定可用 planning anchor，请先启动 planning anchor"
            : code === "planning_anchor_paused"
              ? "planning anchor 运行时已暂停"
              : "延期需求指令派发失败"
      };
    }
  });
}
