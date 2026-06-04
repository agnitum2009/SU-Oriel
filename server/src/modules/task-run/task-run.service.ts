import { prisma } from "../../db/prisma.js";
import {
  CONSOLE_WORKTREE_APPLY_DISABLED_MESSAGE,
  KernelApplyConflictError,
  KernelApplyGoneError,
  KernelApplyNotFoundError,
  KernelApplyValidationError,
  kernelApply
} from "../kernel/apply.routes.js";
import {
  assertTaskRunTransition,
  type TaskRunState
} from "./task-run.state-machine.js";

export class TaskRunConflictError extends Error {
  public constructor(message: string) {
    super(message);
  }
}

export class TaskRunInputError extends Error {
  public constructor(message: string) {
    super(message);
  }
}

export type SerializedTaskRun = {
  id: string;
  task_id: string;
  status: string;
  attempt_n: number;
  dispatched_at: string | null;
  completed_at: string | null;
  error_summary: string | null;
  workspace_path: string | null;
  worktree_branch: string | null;
  transitions: unknown[];
  idempotent: boolean;
  created_at: string;
  updated_at: string;
};

export type TaskRunApplyResponse = {
  success: true;
  apply_id: string;
  primitive: string;
  task_run: SerializedTaskRun;
};

export type DispatchTaskRunOptions = {
  force?: boolean;
};

function normalizeAttempt(attempt_n: number | undefined): number {
  if (attempt_n === undefined) {
    return 1;
  }
  if (!Number.isInteger(attempt_n) || attempt_n < 1) {
    throw new TaskRunInputError("attempt_n 必须是正整数");
  }
  return attempt_n;
}

function assertDispatchTransition(from: TaskRunState): void {
  try {
    assertTaskRunTransition(from, "dispatched");
  } catch (error) {
    throw new TaskRunConflictError(error instanceof Error ? error.message : "TaskRun transition not allowed");
  }
}

function assertTaskRunServiceTransition(from: TaskRunState, to: TaskRunState): void {
  try {
    assertTaskRunTransition(from, to);
  } catch (error) {
    throw new TaskRunConflictError(error instanceof Error ? error.message : "TaskRun transition not allowed");
  }
}

async function getLatestTaskRun(taskId: string): Promise<{ status: string } | null> {
  return await prisma.taskRun.findFirst({
    where: {
      taskId
    },
    orderBy: [{ attemptN: "desc" }, { createdAt: "desc" }],
    select: {
      status: true
    }
  });
}

async function applyTaskRunK1Transition(
  taskId: string,
  primitive: "pause_task" | "resume_task" | "cancel_task",
  to: TaskRunState
): Promise<TaskRunApplyResponse> {
  const latestRun = await getLatestTaskRun(taskId);

  if (!latestRun) {
    throw new TaskRunConflictError("TaskRun 不存在");
  }

  assertTaskRunServiceTransition(latestRun.status as TaskRunState, to);

  const applied = await kernelApply(primitive, {
    taskId
  });
  return mapKernelResult(applied);
}

async function assertDispatchAllowed(taskId: string, attempt_n: number): Promise<{ checkDirty: boolean }> {
  const existing = await prisma.taskRun.findFirst({
    where: {
      taskId,
      attemptN: attempt_n
    },
    orderBy: {
      createdAt: "desc"
    }
  });

  if (existing?.status === "dispatched") {
    return {
      checkDirty: false
    };
  }
  if (existing) {
    if (existing.status !== "pending") {
      throw new TaskRunConflictError("同 attempt_n 的 TaskRun 状态不可 dispatch");
    }
    assertDispatchTransition("pending");
    return {
      checkDirty: true
    };
  }

  if (attempt_n === 1) {
    assertDispatchTransition("pending");
    return {
      checkDirty: true
    };
  }

  const previousRun = await prisma.taskRun.findFirst({
    where: {
      taskId,
      attemptN: attempt_n - 1
    },
    orderBy: {
      createdAt: "desc"
    }
  });
  if (!previousRun || previousRun.status !== "failed") {
    throw new TaskRunConflictError("retry dispatch 需要上一 attempt_n 为 failed");
  }
  assertDispatchTransition("failed");
  return {
    checkDirty: true
  };
}

function mapKernelResult(applied: Awaited<ReturnType<typeof kernelApply>>): TaskRunApplyResponse {
  return {
    success: true,
    apply_id: applied.applyId,
    primitive: applied.primitive,
    task_run: applied.result as SerializedTaskRun
  };
}

export async function dispatchTaskRun(
  taskId: string,
  attempt_n?: number,
  options: DispatchTaskRunOptions = {}
): Promise<TaskRunApplyResponse> {
  void taskId;
  void attempt_n;
  void options;
  throw new KernelApplyGoneError(CONSOLE_WORKTREE_APPLY_DISABLED_MESSAGE);
}

export async function retryTaskRun(taskId: string): Promise<TaskRunApplyResponse> {
  const latestRun = await prisma.taskRun.findFirst({
    where: {
      taskId
    },
    orderBy: [{ attemptN: "desc" }, { createdAt: "desc" }]
  });

  if (!latestRun) {
    throw new TaskRunConflictError("retry 需要已有 failed TaskRun");
  }

  if (latestRun.status === "failed") {
    return await dispatchTaskRun(taskId, latestRun.attemptN + 1);
  }

  if (latestRun.status === "dispatched" && latestRun.attemptN > 1) {
    const previousRun = await prisma.taskRun.findFirst({
      where: {
        taskId,
        attemptN: latestRun.attemptN - 1
      },
      orderBy: {
        createdAt: "desc"
      }
    });
    if (previousRun?.status === "failed") {
      return await dispatchTaskRun(taskId, latestRun.attemptN);
    }
  }

  throw new TaskRunConflictError("当前 TaskRun 状态不可 retry");
}

export async function pauseTaskRun(taskId: string): Promise<TaskRunApplyResponse> {
  return await applyTaskRunK1Transition(taskId, "pause_task", "paused");
}

export async function resumeTaskRun(taskId: string): Promise<TaskRunApplyResponse> {
  return await applyTaskRunK1Transition(taskId, "resume_task", "running");
}

export async function cancelTaskRun(taskId: string): Promise<TaskRunApplyResponse> {
  return await applyTaskRunK1Transition(taskId, "cancel_task", "cancelled");
}

export function taskRunErrorToStatus(error: unknown): { statusCode: number; body: Record<string, unknown> } | null {
  if (error instanceof TaskRunInputError || error instanceof KernelApplyValidationError) {
    return {
      statusCode: 400,
      body: {
        message: error.message
      }
    };
  }
  if (error instanceof KernelApplyNotFoundError) {
    return {
      statusCode: 404,
      body: {
        message: error.message
      }
    };
  }
  if (error instanceof KernelApplyGoneError) {
    return {
      statusCode: 410,
      body: {
        message: error.message
      }
    };
  }
  if (error instanceof TaskRunConflictError || error instanceof KernelApplyConflictError) {
    return {
      statusCode: 409,
      body: {
        message: error.message
      }
    };
  }
  return null;
}
