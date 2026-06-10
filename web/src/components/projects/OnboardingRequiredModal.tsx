import { useNavigate } from "react-router";

import { projectPath } from "../../lib/project-paths.js";
import { useProjectStore } from "../../stores/project-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { Button } from "../ui/Button.js";
import { Modal } from "../ui/Modal.js";

/**
 * 未初始化时点击"项目"组导航项弹出的引导 modal。
 * 读 ui-store 的 onboardingRequiredProjectId(触发时锚定的项目),CTA 跳该项目概览复用既有引导,
 * 不在本 modal 复刻初始化动作。
 */
export function OnboardingRequiredModal() {
  const navigate = useNavigate();
  const modalOpen = useUIStore((state) => state.modalOpen);
  const modalType = useUIStore((state) => state.modalType);
  const onboardingRequiredProjectId = useUIStore((state) => state.onboardingRequiredProjectId);
  const closeModal = useUIStore((state) => state.closeModal);
  const projects = useProjectStore((state) => state.projects);

  const open = modalOpen && modalType === "onboarding-required";
  const project = projects.find((item) => item.id === onboardingRequiredProjectId) ?? null;
  const projectLabel = project?.name ?? "该项目";

  const handleGoInit = () => {
    // 跳触发时锚定的 pid 概览(非当前 selectedProjectId,避免弹框期间切项目跳错)。
    if (onboardingRequiredProjectId) {
      navigate(projectPath(onboardingRequiredProjectId, "/overview"));
    }
    closeModal();
  };

  return (
    <Modal
      footer={
        <>
          <Button onClick={closeModal} variant="secondary">
            关闭
          </Button>
          <Button onClick={handleGoInit}>去概览初始化</Button>
        </>
      }
      onClose={closeModal}
      open={open}
      title="需先完成项目初始化"
    >
      <div>
        <p>
          <strong>{projectLabel}</strong> 还没完成初始化(CCB 运行时 + 知识库),暂不能进入「项目」相关页面。
        </p>
        <p>请到「概览」按引导完成两步初始化:① 初始化 CCB 运行时 ② 初始化知识库。完成后这些入口会自动解锁。</p>
      </div>
    </Modal>
  );
}
