import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigateMock = vi.fn();
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useNavigate: () => navigateMock
}));

import { projectPath } from "../../lib/project-paths.js";
import { useProjectStore } from "../../stores/project-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { OnboardingRequiredModal } from "./OnboardingRequiredModal.js";

const project = {
  id: "p9",
  name: "Proj9",
  localPath: "/tmp/p9",
  summary: null,
  initStatus: "initialized" as const,
  syncStatus: "idle" as const,
  lastScanAt: null
};

beforeEach(() => {
  navigateMock.mockClear();
  useProjectStore.setState({ projects: [project] });
  useUIStore.setState({ modalOpen: true, modalType: "onboarding-required", onboardingRequiredProjectId: "p9" });
});

afterEach(() => {
  useUIStore.setState({ modalOpen: false, modalType: null, onboardingRequiredProjectId: null });
});

describe("OnboardingRequiredModal", () => {
  it("renders with the anchored project name when open", () => {
    render(<OnboardingRequiredModal />);
    expect(screen.getByText(/需先完成项目初始化/)).toBeInTheDocument();
    expect(screen.getByText(/Proj9/)).toBeInTheDocument();
  });

  it("CTA navigates to the anchored project's overview and closes the modal", () => {
    render(<OnboardingRequiredModal />);
    fireEvent.click(screen.getByText("去概览初始化"));
    expect(navigateMock).toHaveBeenCalledWith(projectPath("p9", "/overview"));
    expect(useUIStore.getState().modalOpen).toBe(false);
    expect(useUIStore.getState().onboardingRequiredProjectId).toBeNull();
  });

  it("close button dismisses without navigating", () => {
    render(<OnboardingRequiredModal />);
    fireEvent.click(screen.getByText("关闭"));
    expect(navigateMock).not.toHaveBeenCalled();
    expect(useUIStore.getState().modalOpen).toBe(false);
  });

  it("is not rendered when modalType differs", () => {
    useUIStore.setState({ modalOpen: true, modalType: "create-project", onboardingRequiredProjectId: null });
    render(<OnboardingRequiredModal />);
    expect(screen.queryByText(/需先完成项目初始化/)).toBeNull();
  });
});
