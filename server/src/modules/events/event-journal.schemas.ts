import { z } from "zod";

import { EVENT_JOURNAL_EVENT_TYPES, EVENT_STORE_SCHEMA_VERSION } from "./event-journal.types.js";

const nonEmptyStringSchema = z.string().trim().min(1);
const nullableNonEmptyStringSchema = nonEmptyStringSchema.nullable();
const stringArraySchema = z.array(nonEmptyStringSchema);
const openObjectSchema = z.record(z.unknown());
const devTaskDocumentPathSchema = nonEmptyStringSchema.refine(
  (value) => value.replace(/\\/g, "/").startsWith("docs/03_开发计划/"),
  "dev task document path must point to docs/03_开发计划/"
);

export const codexReceiptReadyPayloadSchema = z
  .object({
    receipt_ref: nonEmptyStringSchema,
    provider: nonEmptyStringSchema,
    receipt_summary: nonEmptyStringSchema,
    unsolicited_findings: z.array(z.unknown()),
    job_id: nonEmptyStringSchema.optional(),
    reply_id: nonEmptyStringSchema.optional(),
    spec_id: nonEmptyStringSchema.optional(),
    status: nonEmptyStringSchema.optional(),
    completed_at: z.string().datetime().optional()
  })
  .strict();

const requirementMaterializedPayloadSchema = z
  .object({
    requirement_id: nonEmptyStringSchema,
    subtask_count: z.number().int().nonnegative(),
    plan_spec_path: devTaskDocumentPathSchema,
    draft_hash: z.string().regex(/^[a-f0-9]{64}$/i)
  })
  .strict();

const subtaskPlanningInheritedPayloadSchema = z
  .object({
    requirement_id: nonEmptyStringSchema,
    subtask_id: nonEmptyStringSchema,
    section_id: nonEmptyStringSchema,
    linked_spec_id: devTaskDocumentPathSchema
  })
  .strict();

const anchorDispatchQueuedPayloadSchema = z
  .object({
    jobId: nonEmptyStringSchema,
    command: nonEmptyStringSchema,
    dispatchPayload: openObjectSchema.optional(),
    step: nonEmptyStringSchema.optional()
  })
  .strict();

const anchorDispatchSubmittedPayloadSchema = z
  .object({
    jobId: nonEmptyStringSchema,
    traceRef: nonEmptyStringSchema.optional(),
    readinessWarning: z.boolean().optional()
  })
  .strict();

const anchorDispatchFailedPayloadSchema = z
  .object({
    jobId: nonEmptyStringSchema,
    errorCode: nonEmptyStringSchema,
    errorMessage: nonEmptyStringSchema
  })
  .strict();

const slotBoundPayloadSchema = z
  .object({
    slotId: nonEmptyStringSchema,
    requirementId: nonEmptyStringSchema,
    reason: z.enum(["new_requirement", "startup_recovery", "manual_rebind"])
  })
  .strict();

const slotReleasedPayloadSchema = z
  .object({
    slotId: nonEmptyStringSchema,
    requirementId: nonEmptyStringSchema,
    reason: z.enum(["requirement_archived", "requirement_cancelled", "manual_release", "force_release"]),
    releasedBy: z.enum(["system", "user"]),
    operatorReason: nullableNonEmptyStringSchema.optional()
  })
  .strict();

const slotQueuedRequestPayloadSchema = z
  .object({
    jobId: nonEmptyStringSchema,
    slotId: nullableNonEmptyStringSchema.optional(),
    command: nonEmptyStringSchema,
    dispatchPayload: openObjectSchema.optional(),
    step: nonEmptyStringSchema.optional(),
    reason: z.enum(["no_idle_slot", "sticky_slot_unavailable", "slot_recovering"])
  })
  .strict();

const slotRuntimeDegradedPayloadSchema = z
  .object({
    slotId: nonEmptyStringSchema,
    reason: z.enum(["socket_lost", "pane_dead", "busy_timeout", "provider_unready"]),
    severity: z.enum(["warning", "error"])
  })
  .strict();

const slotStalePayloadSchema = z
  .object({
    requirementId: nonEmptyStringSchema,
    lastActivityAt: z.string().datetime(),
    staleDays: z.number().int().nonnegative(),
    policyVersion: nonEmptyStringSchema
  })
  .strict();

const slotRecoveredPayloadSchema = z
  .object({
    slotId: nonEmptyStringSchema,
    recoveredAt: z.string().datetime(),
    recoveryRef: nonEmptyStringSchema.optional()
  })
  .strict();

export const eventJournalPayloadSchema = z.union([
  codexReceiptReadyPayloadSchema,
  requirementMaterializedPayloadSchema,
  subtaskPlanningInheritedPayloadSchema,
  anchorDispatchQueuedPayloadSchema,
  anchorDispatchSubmittedPayloadSchema,
  anchorDispatchFailedPayloadSchema,
  slotBoundPayloadSchema,
  slotReleasedPayloadSchema,
  slotQueuedRequestPayloadSchema,
  slotRuntimeDegradedPayloadSchema,
  slotStalePayloadSchema,
  slotRecoveredPayloadSchema
]);

const eventEnvelopeSchema = {
  event_id: z.string().trim().uuid(),
  schema_version: z.literal(EVENT_STORE_SCHEMA_VERSION).default(EVENT_STORE_SCHEMA_VERSION),
  project_id: nonEmptyStringSchema.optional(),
  subject_type: z.enum(["requirement", "subtask"]).optional(),
  subject_id: nonEmptyStringSchema.optional(),
  subject_key: nullableNonEmptyStringSchema.optional(),
  task_id: nonEmptyStringSchema.optional(),
  anchor_id: nullableNonEmptyStringSchema.optional(),
  emitted_at: z.string().datetime(),
  source_actor: z.enum(["claude", "codex", "user", "system"]).optional(),
  source_component: z
    .enum(["scheduler", "primitive_executor", "guard", "hook", "console", "codex-receipt-bridge"])
    .optional(),
  causation_id: nonEmptyStringSchema.optional(),
  correlation_id: nonEmptyStringSchema.optional(),
  state_revision_seen: z.number().int().nonnegative().optional(),
  idempotency_key: nonEmptyStringSchema.optional()
} as const;

export const emitEventSchema = z.discriminatedUnion("event_type", [
  z
    .object({
      ...eventEnvelopeSchema,
      event_type: z.literal("codex_receipt_ready"),
      payload: codexReceiptReadyPayloadSchema
    })
    .strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      event_type: z.literal("user_arbitration_submitted"),
      payload: z
        .object({
          decision_ref: nonEmptyStringSchema,
          verdict: nonEmptyStringSchema,
          notes: nonEmptyStringSchema.optional(),
          reentry_node: z
            .enum(["implementation", "task_breakdown", "technical_design", "requirement_analysis"])
            .optional()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      event_type: z.literal("session_resumed"),
      payload: z
        .object({
          resume_source: nonEmptyStringSchema,
          waiting_ref: nonEmptyStringSchema,
          resumed_by: nonEmptyStringSchema
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      event_type: z.literal("state_write_conflict"),
      payload: z
        .object({
          resource_type: nonEmptyStringSchema,
          expected_revision: z.number().int().nonnegative(),
          actual_revision: z.number().int().nonnegative(),
          writer: nonEmptyStringSchema,
          primitive: nonEmptyStringSchema
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      event_type: z.literal("verification_finished"),
      payload: z
        .object({
          result: nonEmptyStringSchema,
          build: openObjectSchema,
          test: openObjectSchema,
          artifact_refs: stringArraySchema
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      event_type: z.literal("batch_cancelled"),
      payload: z
        .object({
          reason: nonEmptyStringSchema,
          cancelled_by: nonEmptyStringSchema,
          affected_task_ids: stringArraySchema
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      event_type: z.literal("tool_call_denied"),
      payload: z
        .object({
          tool: nonEmptyStringSchema,
          capability: nonEmptyStringSchema,
          reason: nonEmptyStringSchema,
          policy_profile: nonEmptyStringSchema
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      event_type: z.literal("codex_picked_up"),
      payload: z
        .object({
          dispatch_id: nonEmptyStringSchema,
          agent_id: nonEmptyStringSchema,
          workspace_ref: nonEmptyStringSchema.optional()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      event_type: z.literal("codex_rejected"),
      payload: z
        .object({
          reason: nonEmptyStringSchema,
          spec_path: devTaskDocumentPathSchema,
          diagnostics: openObjectSchema.optional()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      event_type: z.literal("requirement_materialized"),
      payload: requirementMaterializedPayloadSchema
    })
    .strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      event_type: z.literal("subtask_planning_inherited"),
      payload: subtaskPlanningInheritedPayloadSchema
    })
    .strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      event_type: z.literal("anchor_dispatch_queued"),
      payload: anchorDispatchQueuedPayloadSchema
    })
    .strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      event_type: z.literal("anchor_dispatch_submitted"),
      payload: anchorDispatchSubmittedPayloadSchema
    })
    .strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      event_type: z.literal("anchor_dispatch_failed"),
      payload: anchorDispatchFailedPayloadSchema
    })
    .strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      event_type: z.literal("slot_bound"),
      payload: slotBoundPayloadSchema
    })
    .strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      event_type: z.literal("slot_released"),
      payload: slotReleasedPayloadSchema
    })
    .strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      event_type: z.literal("slot_queued_request"),
      payload: slotQueuedRequestPayloadSchema
    })
    .strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      event_type: z.literal("slot_runtime_degraded"),
      payload: slotRuntimeDegradedPayloadSchema
    })
    .strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      event_type: z.literal("slot_stale"),
      payload: slotStalePayloadSchema
    })
    .strict(),
  z
    .object({
      ...eventEnvelopeSchema,
      event_type: z.literal("slot_recovered"),
      payload: slotRecoveredPayloadSchema
    })
    .strict()
]);

export const submitEventJournalSchema = emitEventSchema;

export const listEventJournalQuerySchema = z
  .object({
    project_id: nonEmptyStringSchema.optional(),
    subject_type: z.enum(["requirement", "subtask"]).optional(),
    subject_id: nonEmptyStringSchema.optional(),
    task_id: nonEmptyStringSchema.optional(),
    event_type: z.enum(EVENT_JOURNAL_EVENT_TYPES).optional(),
    emitted_from: z.string().datetime().optional(),
    emitted_to: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0)
  })
  .strict();

export type EmitEventInput = z.input<typeof emitEventSchema>;
export type ParsedEmitEventInput = z.output<typeof emitEventSchema>;
export type SubmitEventJournalInput = EmitEventInput;
export type ListEventJournalQuery = z.infer<typeof listEventJournalQuerySchema>;
