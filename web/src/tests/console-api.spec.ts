import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildApiUrl,
  ackAttention,
  cancelReviewIntent,
  consumeReviewIntent,
  createReviewIntent,
  createRequirement,
  dispatchRequirementAnchorCommand,
  dispatchTaskAnchorCommand,
  fetchAttention,
  fetchAttentionSettings,
  fetchProjectInitJobStatus,
  fetchProjectOnboardingStatus,
  fetchTaskTimeline,
  fetchProjects,
  initProjectKnowledgeBase,
  reindexRequirement,
  resizeSlots,
  scanProject,
  startRequirementPlanningAnchor,
  updateAttentionSettings,
  uploadRequirementAsset,
  type ConsoleApiError
} from "../lib/console-api.js";

describe("console-api 真实联调行为", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("默认使用同源 /api 路径，交给开发代理或部署网关转发", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchProjects();

    expect(fetchMock).toHaveBeenCalledWith("/api/projects");
  });

  it("可为独立部署场景拼接显式 API 基础地址", () => {
    expect(buildApiUrl("/api/projects", "http://127.0.0.1:3030/")).toBe("http://127.0.0.1:3030/api/projects");
  });

  it("attention client 使用项目级 list / ack / settings 端点", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ project_id: "p1", items: [], count: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        project_id: "p1",
        ref: "event_journal:e1",
        acked_at: "2026-06-06T12:00:00.000Z"
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        project_id: "p1",
        dnd_until: null,
        updated_at: null
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        project_id: "p1",
        dnd_until: "2026-06-06T13:00:00.000Z",
        updated_at: "2026-06-06T12:00:00.000Z"
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchAttention("p1");
    await ackAttention("p1", "event_journal:e1");
    await fetchAttentionSettings("p1");
    await updateAttentionSettings("p1", { dnd_until: "2026-06-06T13:00:00.000Z" });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects/p1/attention");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects/p1/attention/ack", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ref: "event_journal:e1" })
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/projects/p1/attention/settings");
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/projects/p1/attention/settings", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ dnd_until: "2026-06-06T13:00:00.000Z" })
    });
  });

  it("扫描失败时优先透传后端返回的 message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "项目下未找到 docs/.ccb 目录" }), {
        status: 400,
        headers: {
          "Content-Type": "application/json"
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(scanProject("project-1")).rejects.toThrow("项目下未找到 docs/.ccb 目录");
  });

  it("Requirement planning anchor 启动与 dispatch 使用项目需求双 ID 路径", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ anchorId: "anchor-1", jobId: "job-1", status: "submitted" }), {
        status: 202,
        headers: {
          "Content-Type": "application/json"
        }
      }))
    );
    vi.stubGlobal("fetch", fetchMock);

    await startRequirementPlanningAnchor("project-1", "req-1");
    await dispatchRequirementAnchorCommand("project-1", "req-1", {
      command: "su-flow",
      payload: { step: "analysis" }
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects/project-1/requirements/req-1/planning-anchor/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({})
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects/project-1/requirements/req-1/anchor-dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ command: "su-flow", payload: { step: "analysis" } })
    });
  });

  it("需求级 reindex 使用浏览器可访问的项目需求端点", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ reindexed: true, deduped: false, status: "success", issues: [] }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await reindexRequirement("project-1", "req-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-1/requirements/req-1/reindex", {
      method: "POST"
    });
  });

  it("SubTask anchor dispatch 使用任务 ID 路径", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ anchorId: "anchor-task-1", jobId: "job-task-1", status: "submitted" }), {
        status: 202,
        headers: {
          "Content-Type": "application/json"
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await dispatchTaskAnchorCommand("task-1", { command: "su-dispatch", payload: {} });

    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/task-1/anchor-dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ command: "su-dispatch", payload: {} })
    });
  });

  it("创建需求会携带 asset tmp uuid 供后端 finalize", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "req-1", title: "T" }), {
        status: 201,
        headers: {
          "Content-Type": "application/json"
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await createRequirement("project-1", {
      title: "T",
      description: "![](./assets/requirements/tmp-asset-1/a.png)",
      outputMode: "requirement_only",
      assetTmpUuid: "asset-1",
      verbatimSource: "",
      claudeInterpretation: "",
      ambiguities: "",
      fidelityDiff: ""
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-1/requirements", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title: "T",
        description: "![](./assets/requirements/tmp-asset-1/a.png)",
        outputMode: "requirement_only",
        splitMode: "direct_pr",
        source_task_id: null,
        asset_tmp_uuid: "asset-1",
        verbatim_source: undefined,
        claude_interpretation: undefined,
        ambiguities: undefined,
        fidelity_diff: undefined
      })
    });
  });

  it("上传需求图片使用 multipart FormData 且不手写 content-type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ path: "./assets/requirements/tmp-1/a.png" }), {
        status: 201,
        headers: {
          "Content-Type": "application/json"
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const file = new File(["png"], "paste.png", { type: "image/png" });
    const result = await uploadRequirementAsset("project-1", "tmp-1", file);

    expect(result.path).toBe("./assets/requirements/tmp-1/a.png");
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-1/requirements/tmp-1/assets", {
      method: "POST",
      body: expect.any(FormData)
    });
  });

  it("review intent 创建和取消使用只写 intent 的端点", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ id: "intent-1", status: "pending" }), {
        status: 201,
        headers: {
          "Content-Type": "application/json"
        }
      }))
    );
    vi.stubGlobal("fetch", fetchMock);

    await createReviewIntent("task-1", {
      intentType: "request_replan",
      payload: "补充回归测试"
    });
    await cancelReviewIntent("intent-1");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/tasks/task-1/review-intents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intentType: "request_replan",
        payload: "补充回归测试"
      })
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/review-intents/intent-1", {
      method: "DELETE"
    });
  });

  it("review intent consume 使用 considered/failed 契约", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true, result: "consumed", intent: { id: "intent-1" } }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      }))
    );
    vi.stubGlobal("fetch", fetchMock);

    await consumeReviewIntent("intent-1", {
      consumer: "su-review",
      result: "failed",
      failureReason: "parse",
      error: "payload parse failed"
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/review-intents/intent-1/consume", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        consumer: "su-review",
        result: "failed",
        failureReason: "parse",
        error: "payload parse failed"
      })
    });
  });

  it("任务 timeline 使用只读独立端点", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ taskId: "task-1", events: [] }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchTaskTimeline("task-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/task-1/timeline");
  });

  it("项目 onboarding 状态使用只读独立端点", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ projectId: "project-1", ccbRuntimeReady: true, knowledgeBaseReady: false }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchProjectOnboardingStatus("project-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-1/onboarding-status");
  });

  it("项目知识库初始化提交使用主项目 ccbd 端点", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jobId: "job-1", claudeAgentName: "project_claude" }), {
        status: 202,
        headers: {
          "Content-Type": "application/json"
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await initProjectKnowledgeBase("project-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-1/init-knowledge-base", {
      method: "POST"
    });
  });

  it("项目知识库初始化 job 查询携带 jobId query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jobId: "job 1", status: "running" }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchProjectInitJobStatus("project-1", "job 1");

    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-1/init-job-status?jobId=job%201");
  });

  it("slot resize client posts direction and preserves structured lock timeout payload", async () => {
    const successPayload = {
      project: { id: "project-1", name: "SU-CCB", slotCount: 4 },
      slotCount: 4,
      main: { slotId: "main", lane: "coordination", state: "available", canBindBusiness: false },
      slots: [],
      queue: [],
      shrinkEligibility: {
        projectId: "project-1",
        slotCount: 4,
        tailSlotId: "slot-4",
        canShrink: true,
        eligible: true,
        checks: {
          slotBindingIdle: true,
          queueClear: true,
          runtimeIdle: true
        },
        reasons: [],
        details: {}
      },
      resize: {
        ok: true,
        direction: "grow",
        mode: "reloaded",
        projectId: "project-1",
        previousSlotCount: 3,
        nextSlotCount: 4,
        reload: null,
        reset: null
      }
    };
    const lockTimeoutPayload = {
      code: "SLOT_RESIZE_LOCK_TIMEOUT",
      message: "slot resize lock wait timed out after 2000ms",
      projectId: "project-1",
      timeoutMs: 2000
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(successPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(lockTimeoutPayload), {
        status: 409,
        headers: { "Content-Type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await resizeSlots("project-1", { direction: "grow" });

    expect(result.resize.nextSlotCount).toBe(4);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects/project-1/slots/resize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ direction: "grow" })
    });
    await expect(resizeSlots("project-1", { direction: "shrink" })).rejects.toMatchObject({
      status: 409,
      code: "SLOT_RESIZE_LOCK_TIMEOUT",
      payload: lockTimeoutPayload
    } satisfies Partial<ConsoleApiError>);
  });
});
