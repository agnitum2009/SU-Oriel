import { Prisma, type EventJournal } from "@prisma/client";

import { prisma } from "../../db/prisma.js";
import { primitiveExecutor } from "../primitive/primitive-wrapper.js";
import {
  emitEventSchema,
  type EmitEventInput,
  type ListEventJournalQuery,
  type ParsedEmitEventInput,
  type SubmitEventJournalInput
} from "./event-journal.schemas.js";
import {
  EVENT_JOURNAL_ALLOWED_EVENT_TYPE,
  EVENT_STORE_SCHEMA_VERSION,
  type EventJournalEventType,
  type EventJournalPayload,
  type EventJournalView,
  type ListEventJournalResult,
  type SubmitEventJournalResult,
  type TimelineProjectionEvent
} from "./event-journal.types.js";

const PAYLOAD_PREVIEW_MAX_LENGTH = 500;

export class EventJournalTaskNotFoundError extends Error {
  constructor() {
    super("任务不存在");
  }
}

export class EventJournalProjectMismatchError extends Error {
  constructor() {
    super("event journal project_id 与 subject 不匹配");
  }
}

export class EventJournalSubjectNotFoundError extends Error {
  constructor() {
    super("事件主体不存在");
  }
}

interface ResolvedEventSubject {
  projectId: string;
  subjectType: "requirement" | "subtask";
  subjectId: string;
  subjectKey: string | null;
}

function parsePayload(value: string): EventJournalPayload {
  const parsed = JSON.parse(value) as EventJournalPayload;
  return parsed;
}

export function serializeEventJournal(event: EventJournal): EventJournalView {
  return {
    id: event.id,
    eventId: event.eventId,
    eventType: event.eventType as EventJournalEventType,
    schemaVersion: EVENT_STORE_SCHEMA_VERSION,
    projectId: event.projectId,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    subjectKey: event.subjectKey,
    taskId: event.subjectType === "subtask" ? event.subjectId : event.subjectId,
    taskKey: event.subjectKey,
    anchorId: event.anchorId,
    slotId: event.anchorId,
    payload: parsePayload(event.payloadJson),
    emittedAt: event.emittedAt.toISOString(),
    sourceActor: event.sourceActor,
    sourceComponent: event.sourceComponent,
    causationId: event.causationId,
    correlationId: event.correlationId,
    stateRevisionSeen: event.stateRevisionSeen,
    idempotencyKey: event.idempotencyKey,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString()
  };
}

async function resolveEventSubject(
  client: Pick<Prisma.TransactionClient, "task" | "requirement">,
  input: ParsedEmitEventInput
): Promise<ResolvedEventSubject> {
  if (input.subject_type && input.subject_id) {
    if (input.subject_type === "requirement") {
      const requirement = await client.requirement.findUnique({
        where: { id: input.subject_id },
        select: { id: true, projectId: true, title: true }
      });
      if (!requirement) {
        throw new EventJournalSubjectNotFoundError();
      }
      return {
        projectId: requirement.projectId,
        subjectType: "requirement",
        subjectId: requirement.id,
        subjectKey: input.subject_key ?? requirement.title
      };
    }

    const task = await client.task.findUnique({
      where: { id: input.subject_id },
      select: { id: true, projectId: true, taskKey: true }
    });
    if (!task) {
      throw new EventJournalSubjectNotFoundError();
    }
    return {
      projectId: task.projectId,
      subjectType: "subtask",
      subjectId: task.id,
      subjectKey: input.subject_key ?? task.taskKey
    };
  }

  if (input.task_id) {
    const task = await client.task.findUnique({
      where: { id: input.task_id },
      select: { id: true, projectId: true, taskKey: true }
    });
    if (!task) {
      throw new EventJournalTaskNotFoundError();
    }
    return {
      projectId: task.projectId,
      subjectType: "subtask",
      subjectId: task.id,
      subjectKey: task.taskKey
    };
  }

  throw new EventJournalSubjectNotFoundError();
}

export async function getEventJournalByEventId(eventId: string): Promise<EventJournalView | null> {
  const event = await prisma.eventJournal.findUnique({
    where: {
      eventId
    }
  });

  return event ? serializeEventJournal(event) : null;
}

async function persistEventJournal(input: ParsedEmitEventInput): Promise<SubmitEventJournalResult> {
  const existing = await prisma.eventJournal.findUnique({
    where: {
      eventId: input.event_id
    }
  });

  if (existing) {
    return {
      success: true,
      result: "already_recorded",
      idempotent: true,
      event: serializeEventJournal(existing)
    };
  }

  const subject = await resolveEventSubject(prisma, input);

  if (input.project_id && input.project_id !== subject.projectId) {
    throw new EventJournalProjectMismatchError();
  }

  try {
    const event = await primitiveExecutor.run({
      primitive: "append_event_journal",
      mutationType: "prisma.eventJournal.create",
      idempotencyKey: input.idempotency_key ?? input.event_id,
      run: async () =>
        await prisma.eventJournal.create({
          data: {
            eventId: input.event_id,
            eventType: input.event_type,
            projectId: subject.projectId,
            subjectType: subject.subjectType,
            subjectId: subject.subjectId,
            subjectKey: subject.subjectKey,
            anchorId: input.anchor_id ?? null,
            payloadJson: JSON.stringify(input.payload),
            emittedAt: new Date(input.emitted_at),
            sourceActor: input.source_actor,
            sourceComponent: input.source_component,
            causationId: input.causation_id,
            correlationId: input.correlation_id,
            stateRevisionSeen: input.state_revision_seen,
            idempotencyKey: input.idempotency_key
          }
        })
    });

    return {
      success: true,
      result: "created",
      idempotent: false,
      event: serializeEventJournal(event)
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // 并发重复提交时仍按 event_id 返回原记录，避免 divergent payload 覆盖历史事实。
      const duplicate = await prisma.eventJournal.findUniqueOrThrow({
        where: {
          eventId: input.event_id
        }
      });
      return {
        success: true,
        result: "already_recorded",
        idempotent: true,
        event: serializeEventJournal(duplicate)
      };
    }
    throw error;
  }
}

export async function emitEventInTransaction(
  tx: Prisma.TransactionClient,
  input: EmitEventInput
): Promise<SubmitEventJournalResult> {
  const parsed = emitEventSchema.parse(input);
  const existing = await tx.eventJournal.findUnique({
    where: {
      eventId: parsed.event_id
    }
  });

  if (existing) {
    return {
      success: true,
      result: "already_recorded",
      idempotent: true,
      event: serializeEventJournal(existing)
    };
  }

  const subject = await resolveEventSubject(tx, parsed);

  if (parsed.project_id && parsed.project_id !== subject.projectId) {
    throw new EventJournalProjectMismatchError();
  }

  try {
    const event = await primitiveExecutor.run({
      primitive: "append_event_journal",
      mutationType: "prisma.eventJournal.create",
      idempotencyKey: parsed.idempotency_key ?? parsed.event_id,
      run: async () =>
        await tx.eventJournal.create({
          data: {
            eventId: parsed.event_id,
            eventType: parsed.event_type,
            projectId: subject.projectId,
            subjectType: subject.subjectType,
            subjectId: subject.subjectId,
            subjectKey: subject.subjectKey,
            anchorId: parsed.anchor_id ?? null,
            payloadJson: JSON.stringify(parsed.payload),
            emittedAt: new Date(parsed.emitted_at),
            sourceActor: parsed.source_actor,
            sourceComponent: parsed.source_component,
            causationId: parsed.causation_id,
            correlationId: parsed.correlation_id,
            stateRevisionSeen: parsed.state_revision_seen,
            idempotencyKey: parsed.idempotency_key
          }
        })
    });

    return {
      success: true,
      result: "created",
      idempotent: false,
      event: serializeEventJournal(event)
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const duplicate = await tx.eventJournal.findUniqueOrThrow({
        where: {
          eventId: parsed.event_id
        }
      });
      return {
        success: true,
        result: "already_recorded",
        idempotent: true,
        event: serializeEventJournal(duplicate)
      };
    }
    throw error;
  }
}

export async function emitEvent(input: EmitEventInput): Promise<SubmitEventJournalResult> {
  return await persistEventJournal(emitEventSchema.parse(input));
}

export async function submitEventJournal(input: SubmitEventJournalInput): Promise<SubmitEventJournalResult> {
  return await emitEvent(input);
}

export async function listEventJournal(query: ListEventJournalQuery): Promise<ListEventJournalResult> {
  const where: Prisma.EventJournalWhereInput = {
    ...(query.project_id ? { projectId: query.project_id } : {}),
    ...(query.event_type ? { eventType: query.event_type } : {}),
    ...(query.subject_type ? { subjectType: query.subject_type } : {}),
    ...(query.subject_id ? { subjectId: query.subject_id } : {}),
    ...(query.task_id ? { subjectType: "subtask", subjectId: query.task_id } : {}),
    emittedAt:
      query.emitted_from || query.emitted_to
        ? {
            ...(query.emitted_from ? { gte: new Date(query.emitted_from) } : {}),
            ...(query.emitted_to ? { lte: new Date(query.emitted_to) } : {})
          }
        : undefined
  };

  const [count, items] = await Promise.all([
    prisma.eventJournal.count({
      where
    }),
    prisma.eventJournal.findMany({
      where,
      orderBy: {
        emittedAt: "desc"
      },
      take: query.limit,
      skip: query.offset
    })
  ]);

  return {
    items: items.map((event) => serializeEventJournal(event)),
    pageInfo: {
      limit: query.limit,
      offset: query.offset,
      count
    }
  };
}

function buildPayloadPreview(payload: EventJournalPayload): string {
  const serialized = JSON.stringify(payload);
  return serialized.length > PAYLOAD_PREVIEW_MAX_LENGTH
    ? serialized.slice(0, PAYLOAD_PREVIEW_MAX_LENGTH)
    : serialized;
}

export async function buildEventJournalTimelineEvents(taskId: string): Promise<TimelineProjectionEvent[]> {
  const result = await listEventJournal({
    task_id: taskId,
    event_type: EVENT_JOURNAL_ALLOWED_EVENT_TYPE,
    limit: 100,
    offset: 0
  });

  return result.items.map((event) => ({
    kind: "event_projection",
    at: event.emittedAt,
    label: `Event projection: ${event.eventType}`,
    details: {
      eventId: event.eventId,
      eventType: event.eventType,
      payloadPreview: buildPayloadPreview(event.payload),
      projectionOnly: true
    }
  }));
}
