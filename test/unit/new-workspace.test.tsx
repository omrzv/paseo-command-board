import React from "react";
import TestRenderer, { act, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-native", async () => import("./helpers/rn-mock"));
vi.mock("@getpaseo/plugin/client/react-native", async () => {
  const react = await import("react");
  return {
    Icon: () => null,
    Modal: Object.assign(
      (props: { open: boolean; title?: string; children?: React.ReactNode }) => (props.open ? react.createElement("HostModal", props, props.children) : null),
      { Content: (props: { children?: React.ReactNode }) => react.createElement("ModalContent", props, props.children) },
    ),
  };
});
import "./helpers/quiet-renderer";
import { StartAgentDialog } from "../../client/tasks/board/start-agent";
import { sideColumnWidth } from "../../client/tasks/board/side-columns";
import type { PluginTheme } from "@getpaseo/plugin";

const LIGHT_THEME = {
  colors: {
    surface0: "#ffffff",
    surface1: "#f7f7f8",
    surface2: "#efeff1",
    border: "#e2e2e6",
    foreground: "#1b1b1f",
    foregroundMuted: "#6b6b75",
    accent: "#3b6fe0",
    accentForeground: "#ffffff",
    statusSuccess: "#1f8a5b",
    statusWarning: "#a36a00",
    statusDanger: "#d93636",
  },
};
const LIGHT = LIGHT_THEME as unknown as PluginTheme;

let renderer: ReactTestRenderer | undefined;
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined; });

function fakePaseo() {
  const agentsCreate = vi.fn(async () => ({ id: "agent-1" }));
  const create = vi.fn(async () => ({ id: "ws-1", agents: { create: agentsCreate } }));
  const paseo = {
    projects: { list: async () => ({ projects: [{ projectKey: "host:srv:/repo", projectId: "prj_1", projectDisplayName: "Repo", projectRootPath: "/repo", projectKind: "directory" }] }) },
    providers: { snapshot: async () => ({ entries: [{ provider: "claude", label: "Claude", enabled: true, status: "ready", models: [{ id: "opus", label: "Opus", isDefault: true }], modes: [] }] }) },
    workspaces: { create },
  };
  return { paseo, create, agentsCreate };
}

const byLabel = (label: string) => renderer!.root.find((node) => typeof node.type !== "string" && node.props.accessibilityLabel === label && typeof node.props.onPress === "function");

describe("side columns", () => {
  it("size from the window, so the lanes they leave cannot feed back into them", () => {
    expect(sideColumnWidth(1512, 0.18, 260, 340)).toBe(272);
    expect(sideColumnWidth(800, 0.18, 260, 340)).toBe(260);
    expect(sideColumnWidth(3000, 0.18, 260, 340)).toBe(340);
  });
});

describe("New workspace", () => {
  it("creates the workspace alone when the first message is empty", async () => {
    const { paseo, create, agentsCreate } = fakePaseo();
    const onStarted = vi.fn();
    await act(async () => { renderer = TestRenderer.create(<StartAgentDialog paseo={paseo as never} theme={LIGHT} onClose={() => {}} onStarted={onStarted} />); });
    expect(renderer!.root.findByType("HostModal" as never).props.title).toBe("New workspace");
    const name = renderer!.root.find((node) => node.props.placeholder === "Workspace name");
    act(() => name.props.onChangeText("Threat intel"));
    await act(async () => { byLabel("Create workspace").props.onPress(); });
    expect(create).toHaveBeenCalledWith({ title: "Threat intel", source: { kind: "directory", path: "/repo", projectId: "prj_1" } });
    expect(agentsCreate).not.toHaveBeenCalled();
    expect(onStarted).toHaveBeenCalledWith(null, "ws-1");
  });

  it("starts an agent in it when a first message is written", async () => {
    const { paseo, agentsCreate } = fakePaseo();
    const onStarted = vi.fn();
    await act(async () => { renderer = TestRenderer.create(<StartAgentDialog paseo={paseo as never} theme={LIGHT} onClose={() => {}} onStarted={onStarted} />); });
    act(() => renderer!.root.find((node) => node.props.placeholder === "Workspace name").props.onChangeText("News"));
    act(() => renderer!.root.find((node) => node.props.placeholder === "What should the agent do?").props.onChangeText("Find news APIs"));
    await act(async () => { byLabel("Start agent").props.onPress(); });
    expect(agentsCreate).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Find news APIs", title: "News" }));
    expect(onStarted).toHaveBeenCalledWith("agent-1", "ws-1");
  });
});
