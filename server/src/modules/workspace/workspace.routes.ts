import type { FastifyInstance } from "fastify";

const CONSOLE_WORKSPACE_WRITE_DISABLED_MESSAGE =
  "Console 任务工作区建删入口已关闭；per-需求 worktree 由 CCB plugin 生命周期管理";

export async function registerWorkspaceRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/tasks/:taskId/workspaces", async (request, reply) => {
    void request;
    reply.status(410);
    return {
      message: CONSOLE_WORKSPACE_WRITE_DISABLED_MESSAGE
    };
  });

  app.delete("/api/task-workspaces/:workspaceId", async (request, reply) => {
    void request;
    reply.status(410);
    return {
      message: CONSOLE_WORKSPACE_WRITE_DISABLED_MESSAGE
    };
  });
}
