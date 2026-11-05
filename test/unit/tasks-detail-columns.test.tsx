import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Animated, StyleSheet } from "react-native";
import "./helpers/quiet-renderer";

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("../../client/ui/use-reduced-motion", () => ({ useReducedMotion: () => motion.reduced, getReducedMotion: () => motion.reduced }));

vi.mock("react-native", async () => {
  const rn = await import("./helpers/rn-mock");
  return {
    ...rn,
    ScrollView: (props: React.ComponentProps<typeof rn.ScrollView>) => <rn.ScrollView {...props}>
      {React.Children.map(props.children, (child, index) => {
        if (!(props.stickyHeaderIndices as number[] | undefined)?.includes(index) || !React.isValidElement<{ style?: unknown }>(child)) return child;
        // Native ScrollViewStickyHeader transfers the direct child's style to its wrapper.
        return <rn.View style={child.props.style}>{React.cloneElement(child, { style: { flex: 1 } })}</rn.View>;
      })}
    </rn.ScrollView>,
  };
});
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => vi.fn() }));
vi.mock("@getpaseo/plugin/client/react-native", async () => {
  const rn = await import("react-native");
  return { Icon: () => null, ScrollView: (props: React.ComponentProps<typeof rn.ScrollView>) => <rn.ScrollView {...props} />, copyText: vi.fn(), useToast: () => ({ show() {}, error() {} }) };
});
vi.mock("../../client/components/markdown/markdown-view", () => ({ MarkdownView: () => null }));

import { TaskDetailCards, type TaskDetailCardsProps } from "../../client/tasks/cards/detail-cards";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { taskTokens } from "../../client/tasks/cards/tokens";
import { permissionButtons } from "../../client/tasks/actions";
import { useLastMessage } from "../../client/tasks/data/last-message";
import { resetSectionChoices, setSectionClosed } from "../../client/tasks/cards/detail-collapse";
import { BOARD_STRINGS } from "../../client/tasks/board/strings";
import { cardStrings } from "../../client/tasks/cards/strings";
import { previewSampleCards } from "../../client/tasks/sample-cards";
import { MarkdownView } from "../../client/components/markdown/markdown-view";
import { TasksTypography, TasksTypographyScale, HOST_FONT } from "../../client/tasks/typography";
import { variantMetrics } from "../../client/components/markdown/render/styles";

const NOW = Date.parse("2026-10-20T09:00:00Z");
const THEME = { colors: {
  surface0: "#ffffff", surface1: "#f7f7f8", surface2: "#efeff1", border: "#e2e2e6",
  foreground: "#1b1b1f", foregroundMuted: "#6b6b75", accent: "#3b6fe0", accentForeground: "#ffffff",
  statusSuccess: "#1f8a5b", statusWarning: "#a36a00", statusDanger: "#d93636",
} };
// The messages lead (the latest reply first), then properties.
const ORDER = ["detail-header", "detail-message", "detail-prompt", "detail-location", "detail-subtasks", "detail-usage", "detail-activity"];
let renderer: TestRenderer.ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetSectionChoices();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  motion.reduced = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function props(children: boolean): TaskDetailCardsProps {
  const card = previewSampleCards(NOW).find((card) => card.id === "sample-running")!;
  return {
    card: children ? card : { ...card, children: [] }, theme: THEME, now: NOW,
    language: "en", strings: BOARD_STRINGS.en.sidebar, columns: true, touch: true,
    firstPrompt: { prompt: { state: "none" }, load() {} },
    lastMessage: { prompt: { state: "none" }, load() {} },
  };
}
function host(root: ReactTestInstance, id: string) {
  return root.find((node) => typeof node.type === "string" && node.props.testID === id);
}
function order(root: ReactTestInstance) {
  return root.findAll((node) => typeof node.type === "string" && ORDER.includes(node.props.testID)).map((node) => node.props.testID);
}

describe("details columns", () => {
  it.each([false, true])("shows a read-only pending question with selection marks (multiSelect: %s)", async (multiSelect) => {
    const base = props(false);
    const card = { ...base.card, lane: "needs_input" as const, permission: {
      requestId: "q", kind: "question" as const, title: "Question", summary: "Keep the timer?", actions: [], remaining: 0,
      questions: [{ question: "Keep the timer?", multiSelect, options: [{ label: "Keep", description: "Shows elapsed time" }, { label: "Remove", description: "Matches iOS" }] }],
    } };
    await act(async () => { renderer = TestRenderer.create(<TaskDetailCards {...base} card={card} columns={false} tabs scrollHeader />); });
    const messages = host(renderer!.root, "detail-tab-messages-content");
    const question = host(messages, "detail-pending-questions");
    const text = question.findAll((node) => (node.type as unknown) === "Text").map((node) => node.props.children);
    expect(text).toEqual(expect.arrayContaining(["Keep the timer?", "Keep", "Shows elapsed time", "Remove", "Matches iOS"]));
    const questionText = question.find((node) => (node.type as unknown) === "Text" && node.props.children === "Keep the timer?");
    expect(StyleSheet.flatten(questionText.props.style).fontSize).toBe(HOST_FONT.base);
    expect(StyleSheet.flatten(host(question, "detail-pending-question").props.style)).toMatchObject({ borderWidth: 1, backgroundColor: THEME.colors.surface1 });
    const options = question.findAll((node) => typeof node.type === "string" && node.props.testID === "detail-pending-option");
    expect(options).toHaveLength(2);
    for (const option of options) {
      expect(option.findByType(Icon).props.name).toBe(multiSelect ? "Square" : "Circle");
      expect(option.props.onPress).toBeUndefined();
    }
  });
  it.each([false, true])("answers a pending question from the details (multiSelect: %s)", async (multiSelect) => {
    const base = props(false);
    const card = { ...base.card, lane: "needs_input" as const, permission: {
      requestId: "q", kind: "question" as const, title: "Question", summary: "Keep the timer?", actions: [], remaining: 0,
      questions: [{ question: "Keep the timer?", multiSelect, options: [{ label: "Keep" }, { label: "Remove" }] }],
    } };
    const onAnswer = vi.fn(() => Promise.resolve());
    await act(async () => { renderer = TestRenderer.create(<TaskDetailCards {...base} card={card} columns={false} tabs scrollHeader onAnswer={onAnswer} />); });
    const submit = () => host(renderer!.root, "detail-pending-submit");
    expect(submit().props.disabled).toBe(true);
    const options = () => renderer!.root.findAll((node) => typeof node.type === "string" && node.props.testID === "detail-pending-option");
    await act(async () => options()[0]!.props.onPress());
    await act(async () => options()[1]!.props.onPress());
    await act(async () => submit().props.onPress());
    expect(onAnswer).toHaveBeenCalledWith({ "Keep the timer?": multiSelect ? "Keep, Remove" : "Remove" });
  });
  it("dismisses a pending question and types an Other answer", async () => {
    const base = props(false);
    const card = { ...base.card, lane: "needs_input" as const, permission: {
      requestId: "q2", kind: "question" as const, title: "Question", summary: "Where?", actions: [], remaining: 0,
      questions: [{ question: "Where?", multiSelect: false, options: [{ label: "Here" }] }],
    } };
    const onAnswer = vi.fn(() => Promise.resolve());
    await act(async () => { renderer = TestRenderer.create(<TaskDetailCards {...base} card={card} columns={false} tabs scrollHeader onAnswer={onAnswer} />); });
    await act(async () => host(renderer!.root, "detail-pending-other").props.onChangeText("Somewhere else"));
    await act(async () => host(renderer!.root, "detail-pending-submit").props.onPress());
    expect(onAnswer).toHaveBeenLastCalledWith({ "Where?": "Somewhere else" });
  });
  it("keeps an unsent reply per agent when the details close, and clears it once sent", async () => {
    const written: string[] = [];
    (globalThis as Record<string, unknown>).__betterPaseoDraftStorageForTests = { read: () => null, write: (value: string) => { written.push(value); } };
    delete (globalThis as Record<string, unknown>).__betterPaseoReplyDrafts;
    vi.useFakeTimers();
    try {
      const base = props(false);
      const onReply = vi.fn(() => Promise.resolve());
      const draw = (card = base.card) => <TaskDetailCards {...base} card={card} columns={false} tabs scrollHeader onReply={onReply} />;
      await act(async () => { renderer = TestRenderer.create(draw()); });
      const input = () => host(renderer!.root, "detail-reply-input");
      await act(async () => input().props.onChangeText("half-written reply"));
      await act(async () => { vi.advanceTimersByTime(400); });
      expect(JSON.parse(written.at(-1)!)[base.card.id].text).toBe("half-written reply");
      // Away and back: another card, then this one again.
      await act(async () => { renderer!.update(draw({ ...base.card, id: "other-agent" })); });
      expect(input().props.value).toBe("");
      await act(async () => { renderer!.update(draw()); });
      expect(input().props.value).toBe("half-written reply");
      await act(async () => { host(renderer!.root, "detail-reply-send").props.onPress(); });
      expect(onReply).toHaveBeenCalledWith("half-written reply", []);
      expect(input().props.value).toBe("");
      expect(JSON.parse(written.at(-1)!)[base.card.id]).toBeUndefined();
    } finally {
      vi.useRealTimers();
      delete (globalThis as Record<string, unknown>).__betterPaseoDraftStorageForTests;
      delete (globalThis as Record<string, unknown>).__betterPaseoReplyDrafts;
    }
  });
  it("brings a saved reply back after the app restarts", async () => {
    const base = props(false);
    (globalThis as Record<string, unknown>).__betterPaseoDraftStorageForTests = { read: () => JSON.stringify({ [base.card.id]: { text: "from yesterday", at: Date.now() } }), write: () => undefined };
    delete (globalThis as Record<string, unknown>).__betterPaseoReplyDrafts;
    try {
      await act(async () => { renderer = TestRenderer.create(<TaskDetailCards {...base} columns={false} tabs scrollHeader onReply={() => Promise.resolve()} />); });
      await act(async () => { await Promise.resolve(); });
      expect(host(renderer!.root, "detail-reply-input").props.value).toBe("from yesterday");
    } finally {
      delete (globalThis as Record<string, unknown>).__betterPaseoDraftStorageForTests;
      delete (globalThis as Record<string, unknown>).__betterPaseoReplyDrafts;
    }
  });
  it("reads compactly on a short screen: two-line summary with More, a one-line reply box", async () => {
    const base = props(false);
    const card = { ...base.card, insight: { agentTitle: base.card.title, summary: "A long summary. ".repeat(20), generatedAt: 1 } };
    const draw = (shortScreen: boolean) => <TaskDetailCards {...base} card={card} columns={false} tabs scrollHeader shortScreen={shortScreen} onReply={() => Promise.resolve()} />;
    await act(async () => { renderer = TestRenderer.create(draw(true)); });
    const summaryText = () => host(renderer!.root, "detail-insight").find((node) => node.props.selectable === true && typeof node.props.text === "string");
    expect(summaryText().props.numberOfLines).toBe(2);
    await act(async () => host(renderer!.root, "detail-insight-more").props.onPress());
    expect(summaryText().props.numberOfLines).toBeUndefined();
    expect(StyleSheet.flatten(host(renderer!.root, "detail-reply-input").props.style).height).toBe(36);
    await act(async () => { renderer!.update(draw(false)); });
    expect(renderer!.root.findAll((node) => node.props.testID === "detail-insight-more")).toHaveLength(0);
    expect(StyleSheet.flatten(host(renderer!.root, "detail-reply-input").props.style).height).toBe(44);
  });
  it("uses larger detail tabs on desktop", async () => {
    await act(async () => {
      renderer = TestRenderer.create(<TaskDetailCards {...props(false)} touch={false} columns={false} tabs />);
    });
    for (const id of ["info", "messages"]) {
      const button = host(renderer!.root, `detail-tab-${id}`);
      expect(StyleSheet.flatten(button.props.style).height).toBe(32);
      expect(StyleSheet.flatten(button.find((node) => (node.type as unknown) === "Text").props.style).fontSize).toBe(HOST_FONT.base);
    }
  });

  it.each(["ios", "android", "web"])("shows a bottom shadow only while the compact tabs are pinned on %s", async (os) => {
    vi.stubGlobal("__rnMockOS", os);
    await act(async () => {
      renderer = TestRenderer.create(<TaskDetailCards {...props(false)} columns={false} tabs scrollHeader />);
    });
    const root = renderer!.root;
    const shadow = () => StyleSheet.flatten(host(root, "detail-tabs").props.style).boxShadow;
    expect(root.findByType(ScrollView).props.testID).toBe("detail-tab-short-scroll");
    const scroll = (y: number) => host(root, "detail-tab-short-scroll").props.onScroll({ nativeEvent: { contentOffset: { y } } });
    expect(shadow()).toBeUndefined();
    for (const id of ["info", "messages"]) {
      const button = host(root, `detail-tab-${id}`);
      expect(StyleSheet.flatten(button.props.style).height).toBe(30);
      expect(StyleSheet.flatten(button.find((node) => (node.type as unknown) === "Text").props.style).fontSize).toBe(HOST_FONT.sm);
    }
    await act(async () => host(root, "detail-tab-anchor").props.onLayout({ nativeEvent: { layout: { y: 200, height: 46 } } }));
    await act(async () => scroll(199));
    expect(shadow()).toBeUndefined();
    await act(async () => scroll(200));
    expect(shadow()).toContain("0px 5px 8px -4px");
    await act(async () => host(root, "detail-tab-info").props.onPress());
    await act(async () => scroll(0));
    expect(shadow()).toBeDefined();
    await act(async () => host(root, "detail-tab-info-content").props.onLayout());
    expect(shadow()).toBeDefined();
    await act(async () => scroll(150));
    expect(shadow()).toBeUndefined();
    await act(async () => scroll(250));
    await act(async () => renderer!.update(<TaskDetailCards {...props(false)} card={{ ...props(false).card, id: "another-task" }} columns={false} tabs scrollHeader />));
    expect(shadow()).toBeUndefined();
  });

  it.each(["ios", "android", "web"])("shows the same bottom shadow while a fixed tab's page is scrolled on %s", async (os) => {
    vi.stubGlobal("__rnMockOS", os);
    await act(async () => {
      renderer = TestRenderer.create(<TaskDetailCards {...props(false)} columns={false} tabs />);
    });
    const root = renderer!.root;
    const shadow = () => StyleSheet.flatten(host(root, "detail-tabs").props.style).boxShadow;
    const anchor = () => StyleSheet.flatten(host(root, "detail-tab-anchor").props.style ?? {});
    const scroll = (id: "info" | "messages", y: number) => host(root, `detail-tab-${id}-scroll`).props.onScroll({ nativeEvent: { contentOffset: { y } } });
    expect(shadow()).toBeUndefined();
    expect(anchor().zIndex).toBeUndefined();
    await act(async () => scroll("messages", 12));
    expect(shadow()).toContain("0px 5px 8px -4px");
    expect(anchor().zIndex).toBe(1);
    // The page that is hidden keeps its offset, and does not change the shadow on screen.
    await act(async () => scroll("info", 0));
    expect(shadow()).toContain("0px 5px 8px -4px");
    await act(async () => scroll("info", 40));
    await act(async () => host(root, "detail-tab-info").props.onPress());
    expect(shadow()).toContain("0px 5px 8px -4px");
    await act(async () => scroll("info", 0));
    expect(shadow()).toBeUndefined();
    expect(anchor().zIndex).toBeUndefined();
    await act(async () => host(root, "detail-tab-messages").props.onPress());
    expect(shadow()).toContain("0px 5px 8px -4px");
    await act(async () => renderer!.update(<TaskDetailCards {...props(false)} card={{ ...props(false).card, id: "another-task" }} columns={false} tabs />));
    expect(shadow()).toBeUndefined();
  });

  it.each(["ios", "android", "web"])("casts the tab shadow upward from the action bar while a fixed page runs under it on %s", async (os) => {
    vi.stubGlobal("__rnMockOS", os);
    await act(async () => {
      renderer = TestRenderer.create(<TaskDetailCards {...props(false)} columns={false} tabs onOpen={() => {}} />);
    });
    const root = renderer!.root;
    const shadow = () => StyleSheet.flatten(host(root, "detail-action-bar").props.style).boxShadow;
    const messages = host(root, "detail-tab-messages-scroll");
    const info = host(root, "detail-tab-info-scroll");
    expect(shadow()).toBeUndefined();
    await act(async () => {
      messages.props.onLayout({ nativeEvent: { layout: { height: 200 } } });
      messages.props.onContentSizeChange(100, 800);
    });
    expect(shadow()).toContain("0px -5px 8px -4px");
    await act(async () => messages.props.onScroll({ nativeEvent: { contentOffset: { y: 600 }, layoutMeasurement: { height: 200 }, contentSize: { height: 800 } } }));
    expect(shadow()).toBeUndefined();
    await act(async () => messages.props.onScroll({ nativeEvent: { contentOffset: { y: 20 }, layoutMeasurement: { height: 200 }, contentSize: { height: 800 } } }));
    expect(shadow()).toContain("0px -5px 8px -4px");
    await act(async () => {
      info.props.onLayout({ nativeEvent: { layout: { height: 200 } } });
      info.props.onContentSizeChange(100, 100);
      host(root, "detail-tab-info").props.onPress();
    });
    expect(shadow()).toBeUndefined();
    await act(async () => host(root, "detail-tab-messages").props.onPress());
    expect(shadow()).toContain("0px -5px 8px -4px");
  });

  it.each(["ios", "android", "web"])("casts the same upward shadow from the sticky sidebar's action bar on %s", async (os) => {
    vi.stubGlobal("__rnMockOS", os);
    await act(async () => {
      renderer = TestRenderer.create(<TaskDetailCards {...props(false)} columns={false} tabs scrollHeader onOpen={() => {}} />);
    });
    const root = renderer!.root;
    const shadow = () => StyleSheet.flatten(host(root, "detail-action-bar").props.style).boxShadow;
    const scroll = host(root, "detail-tab-short-scroll");
    expect(shadow()).toBeUndefined();
    await act(async () => {
      scroll.props.onLayout({ nativeEvent: { layout: { height: 400 } } });
      scroll.props.onContentSizeChange(100, 900);
    });
    expect(shadow()).toContain("0px -5px 8px -4px");
    await act(async () => scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 500 }, layoutMeasurement: { height: 400 }, contentSize: { height: 900 } } }));
    expect(shadow()).toBeUndefined();
  });

  it("reports that edge for the phone sheet, whose bar lives outside the card", async () => {
    const onScrollEdge = vi.fn();
    await act(async () => {
      renderer = TestRenderer.create(<TaskDetailCards {...props(true)} columns={false} tabs scrollHeader actions={false} onScrollEdge={onScrollEdge} />);
    });
    expect(renderer!.root.findAll((node) => node.props.testID === "detail-action-bar")).toHaveLength(0);
    expect(onScrollEdge).toHaveBeenCalledWith(false);
    const scroll = host(renderer!.root, "detail-tab-short-scroll");
    await act(async () => {
      scroll.props.onLayout({ nativeEvent: { layout: { height: 300 } } });
      scroll.props.onContentSizeChange(100, 800);
    });
    expect(onScrollEdge).toHaveBeenLastCalledWith(true);
    await act(async () => scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 500 }, layoutMeasurement: { height: 300 }, contentSize: { height: 800 } } }));
    expect(onScrollEdge).toHaveBeenLastCalledWith(false);
  });

  it.each([
    { os: "ios", offset: 0, target: 0 },
    { os: "ios", offset: 85, target: 85 },
    { os: "ios", offset: 320, target: 200 },
    { os: "android", offset: 320, target: 200 },
    { os: "web", offset: 320, target: 200 },
  ])("keeps the header's scroll position when switching to a shorter tab: %j", async ({ os, offset, target }) => {
    vi.stubGlobal("__rnMockOS", os);
    const scrollTo = vi.fn();
    await act(async () => {
      renderer = TestRenderer.create(<TaskDetailCards {...props(false)} columns={false} tabs scrollHeader />,
        { createNodeMock: (element) => element.type === "ScrollView" ? { scrollTo } : null });
    });
    const root = renderer!.root;
    const scroll = host(root, "detail-tab-short-scroll");
    await act(async () => {
      scroll.props.onLayout({ nativeEvent: { layout: { height: 500 } } });
      host(root, "detail-tab-anchor").props.onLayout({ nativeEvent: { layout: { y: 200, height: 44 } } });
    });
    await act(async () => {
      scroll.props.onScroll({ nativeEvent: { contentOffset: { y: offset } } });
      host(root, "detail-tab-info").props.onPress();
    });
    const info = host(root, "detail-tab-info-content");
    expect(StyleSheet.flatten(info.props.style).minHeight).toBe(456);
    await act(async () => {
      scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 0 } } });
      info.props.onLayout();
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ y: target, animated: false });
    await act(async () => {
      scroll.props.onScroll({ nativeEvent: { contentOffset: { y: target + 30 } } });
      host(root, "detail-tab-messages").props.onPress();
    });
    await act(async () => host(root, "detail-tab-messages-content").props.onLayout());
    expect(scrollTo).toHaveBeenLastCalledWith({ y: Math.max(offset, Math.min(target + 30, 200)), animated: false });
    await act(async () => host(root, "detail-tab-info").props.onPress());
    await act(async () => info.props.onLayout());
    expect(scrollTo).toHaveBeenLastCalledWith({ y: target + 30, animated: false });
    scrollTo.mockClear();
    await act(async () => scroll.props.onLayout({ nativeEvent: { layout: { height: 700 } } }));
    expect(StyleSheet.flatten(info.props.style).minHeight).toBe(656);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it.each(["ios", "android", "web"])("scrolls the header under sticky tabs and restores each tab's reading position on %s", async (os) => {
    vi.stubGlobal("__rnMockOS", os);
    // The first prompt folds under a reply; the reader opened it.
    setSectionClosed("prompt", false);
    const scrollTo = vi.fn();
    await act(async () => {
      renderer = TestRenderer.create(<TaskDetailCards {...props(true)} columns={false} tabs scrollHeader onOpen={() => {}}
        firstPrompt={{ prompt: { state: "ready", text: "Long prompt. ".repeat(80) }, load() {} }} />,
      { createNodeMock: (element) => element.type === "ScrollView" ? { scrollTo } : null });
    });
    const root = renderer!.root;
    const scroll = host(root, "detail-tab-short-scroll");
    const messages = host(root, "detail-tab-messages-content");
    const info = host(root, "detail-tab-info-content");
    expect(scroll.props.stickyHeaderIndices).toEqual([1]);
    expect((scroll.children[0] as ReactTestInstance).findAll((node) => typeof node.type === "string" && node.props.testID === "detail-header")).toHaveLength(1);
    expect((scroll.children[1] as ReactTestInstance).findAll((node) => typeof node.type === "string" && node.props.testID === "detail-tabs")).toHaveLength(1);
    expect(StyleSheet.flatten(host(root, "detail-tabs").props.style).backgroundColor).toBe(taskTokens(THEME).card.background);
    const tabs = host(root, "detail-tabs");
    expect(StyleSheet.flatten(tabs.props.style)).toMatchObject({ flexDirection: "row" });
    expect(tabs.children.map((child) => (child as ReactTestInstance).find((node) => typeof node.type === "string" && node.props.accessibilityRole === "tab").props.testID)).toEqual(["detail-tab-info", "detail-tab-messages"]);
    expect(scroll.findAll((node) => node.props.testID === "detail-action-bar")).toHaveLength(0);
    const bar = host(root, "detail-action-bar");
    const read = (y: number) => scroll.props.onScroll({ nativeEvent: { contentOffset: { y } } });
    await act(async () => {
      read(320);
      host(root, "detail-prompt-more").props.onPress();
      host(root, "detail-tab-info").props.onPress();
    });
    expect(host(root, "detail-tab-messages-content")).toBe(messages);
    expect(StyleSheet.flatten(messages.props.style).display).toBe("none");
    await act(async () => {
      // Native resizing can report a clamped offset before the new page's layout.
      read(0);
      messages.props.onLayout();
      info.props.onLayout();
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 0, animated: false });
    await act(async () => {
      read(85);
      host(root, "detail-tab-messages").props.onPress();
    });
    await act(async () => messages.props.onLayout());
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 320, animated: false });
    expect(host(root, "detail-prompt-text").props.style).toMatchObject({ overflow: "hidden" });
    expect(host(root, "detail-action-bar")).toBe(bar);
    scrollTo.mockClear();
    await act(async () => {
      read(400);
      messages.props.onLayout();
      host(root, "detail-tab-messages").props.onPress();
    });
    expect(scrollTo).not.toHaveBeenCalled();
    await act(async () => host(root, "detail-tab-info").props.onPress());
    await act(async () => info.props.onLayout());
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 85, animated: false });
  });

  it("keeps the shared header and actions outside independently mounted tab scrollers", async () => {
    await act(async () => { renderer = TestRenderer.create(<TaskDetailCards {...props(true)} columns={false} tabs />); });
    const root = renderer!.root;
    const info = host(root, "detail-tab-info-scroll");
    const messages = host(root, "detail-tab-messages-scroll");
    expect(order(info)).toEqual(["detail-location", "detail-subtasks", "detail-usage", "detail-activity"]);
    expect(order(messages)).toEqual(["detail-message", "detail-prompt"]);
    expect(host(root, "detail-tab-messages").props.accessibilityState.selected).toBe(true);
    expect(StyleSheet.flatten(host(root, "detail-tab-messages").props.style)).toMatchObject({ borderRadius: 999, backgroundColor: taskTokens(THEME).surface2 });
    expect(StyleSheet.flatten(host(root, "detail-tab-info").props.style)).toMatchObject({ borderRadius: 999, borderColor: taskTokens(THEME).card.pillBorder, backgroundColor: "transparent" });
    expect(host(root, "detail-header")).toBeDefined();
    await act(async () => host(root, "detail-tab-info").props.onPress());
    expect(host(root, "detail-tab-info").props.accessibilityState.selected).toBe(true);
    expect(host(root, "detail-tab-info-scroll")).toBe(info);
  });
  it("shows expanded sections and keeps archive before open in the shared footer", async () => {
    const card = previewSampleCards(NOW).find((item) => item.id === "sample-done")!;
    const onOpen = vi.fn();
    const archive = { pending: () => false, press: vi.fn() };
    await act(async () => { renderer = TestRenderer.create(<TaskDetailCards {...props(false)} card={card} columns={false} tabs onOpen={onOpen} archive={archive} />); });
    const root = renderer!.root;
    const bar = host(root, "detail-action-bar");
    const buttons = bar.findAll((node) => typeof node.type === "string" && ["detail-bar-archive", "detail-bar-open"].includes(node.props.testID));
    expect(buttons.map((node) => node.props.testID)).toEqual(["detail-bar-archive", "detail-bar-open"]);
    expect(StyleSheet.flatten(buttons[0]!.props.style).borderColor).toBe(taskTokens(THEME).card.archiveBorder);
    expect(host(root, "detail-header").findAll((node) => node.props.testID === "detail-actions")).toHaveLength(0);
    for (const id of ["detail-message", "detail-location", "detail-usage", "detail-activity"]) {
      const heading = host(root, id).find((node) => typeof node.type === "string" && typeof node.props.accessibilityState?.expanded === "boolean");
      expect(heading.props.accessibilityState.expanded).toBe(true);
    }
    // No reply yet (the last message reads "none"): the first prompt stays open.
    expect(host(root, "detail-prompt-heading").props.accessibilityState.expanded).toBe(true);
    await act(async () => buttons[0]!.props.onPress());
    await act(async () => buttons[1]!.props.onPress());
    expect(archive.press).toHaveBeenCalledWith(card.id);
    expect(onOpen).toHaveBeenCalledWith(card.id);
    await act(async () => host(root, "detail-tab-info").props.onPress());
    expect(host(root, "detail-action-bar")).toBe(bar);
  });
  it("keeps permission and stop actions in the footer", async () => {
    const card = previewSampleCards(NOW).find((item) => item.id === "sample-input")!;
    const stop = vi.fn();
    await act(async () => { renderer = TestRenderer.create(<TaskDetailCards {...props(false)} card={card} columns={false} tabs onOpen={() => {}} stop={{ phase: "idle", onPress: stop }} permissionButtons={permissionButtons(card.permission!, "en")} onPermission={() => {}} />); });
    const root = renderer!.root;
    expect(host(root, "detail-permission").findAll((node) => node.props.testID === "detail-permission-actions")).toHaveLength(0);
    expect(host(root, "detail-action-bar").findAll((node) => node.props.accessibilityRole === "button").length).toBeGreaterThan(1);
    await act(async () => host(root, "detail-bar-stop").props.onPress());
    expect(stop).toHaveBeenCalledOnce();
  });
  it("shows all three messages and remembers a manually collapsed section", async () => {
    const detailProps = { ...props(false), columns: false, humanMessage: { prompt: { state: "ready" as const, text: "Follow-up" }, load() {} } };
    await act(async () => { renderer = TestRenderer.create(<TaskDetailCards {...detailProps} tabs />); });
    const heading = () => host(renderer!.root, "detail-human").find((node) => typeof node.type === "string" && typeof node.props.accessibilityState?.expanded === "boolean");
    expect(heading().props.accessibilityState.expanded).toBe(true);
    await act(async () => heading().props.onPress());
    expect(heading().props.accessibilityState.expanded).toBe(false);
    await act(async () => renderer!.unmount());
    await act(async () => { renderer = TestRenderer.create(<TaskDetailCards {...detailProps} tabs />); });
    expect(heading().props.accessibilityState.expanded).toBe(false);
  });
  it("shows long messages in full and streams the latest reply as chunks arrive", async () => {
    const first = "First prompt. ".repeat(40);
    const human = "Latest request. ".repeat(40);
    const reply = "Live reply. ".repeat(80);
    setSectionClosed("prompt", false);
    let emit: (event: unknown) => void = () => {};
    const refetch = vi.fn(async () => ({
      error: null, epoch: "epoch", entries: [{ timestamp: "2026-10-20T09:00:00Z", seqEnd: 0, turnId: "turn", item: { type: "assistant_message", text: reply, messageId: "message" } }],
      endCursor: { epoch: "epoch", seq: 0 }, window: { nextSeq: 1 },
    }));
    const subscribe = (handler: (event: unknown) => void) => { emit = handler; return Object.assign(() => {}, { ready: Promise.resolve() }); };
    const api = { agents: { ref: () => ({ timeline: { refetch, subscribe } }) } };
    function LiveDetails() {
      const lastMessage = useLastMessage(api as never, "running", "v1", true, true);
      return <TaskDetailCards {...props(false)} columns={false} tabs firstPrompt={{ prompt: { state: "ready", text: first }, load() {} }} humanMessage={{ prompt: { state: "ready", text: human }, load() {} }} lastMessage={lastMessage} />;
    }
    await act(async () => { renderer = TestRenderer.create(<LiveDetails />); });
    for (const id of ["detail-prompt", "detail-human", "detail-message"]) {
      expect(host(renderer!.root, `${id}-text`).props.style).toBeNull();
    }
    const markdown = () => host(renderer!.root, "detail-message-text").findByType(MarkdownView);
    expect(markdown().props).toMatchObject({ text: reply.trim(), streaming: true });
    await act(async () => emit({ epoch: "epoch", seq: 1, timestamp: "2026-10-20T09:00:01Z", event: { type: "timeline", turnId: "turn", item: { type: "assistant_message", text: "More output", messageId: "message" } } }));
    expect(markdown().props.text).toBe(`${reply}More output`);
    expect(host(renderer!.root, "detail-message-text").props.style).toBeNull();
    expect(refetch).toHaveBeenCalledOnce();
    await act(async () => host(renderer!.root, "detail-message-more").props.onPress());
    expect(host(renderer!.root, "detail-message-text").props.style).toMatchObject({ overflow: "hidden" });
  });
  it("keeps usage above activity and both expanded for failed tasks", async () => {
    const card = previewSampleCards(NOW).find((item) => item.id === "sample-failed")!;
    await act(async () => { renderer = TestRenderer.create(<TaskDetailCards {...props(false)} card={card} columns={false} tabs />); });
    const info = host(renderer!.root, "detail-tab-info-scroll");
    expect(order(info)).toEqual(["detail-location", "detail-usage", "detail-activity"]);
    expect(host(info, "detail-usage").find((node) => typeof node.type === "string" && typeof node.props.accessibilityState?.expanded === "boolean").props.accessibilityState.expanded).toBe(true);
  });
  it.each(["web", "ios", "android"])("keeps properties above subtasks in separate scrollers on %s", async (os) => {
    vi.stubGlobal("__rnMockOS", os);
    for (const children of [true, false]) {
      await act(async () => { renderer = TestRenderer.create(<TaskDetailCards {...props(children)} />); });
      const root = renderer!.root;
      const left = host(root, "detail-column-head");
      const right = host(root, "detail-column-sections");
      expect(order(left)).toEqual(["detail-header", "detail-location", ...(children ? ["detail-subtasks"] : [])]);
      expect(order(right)).toEqual(["detail-message", "detail-prompt", "detail-usage", "detail-activity"]);
      expect(root.findAll((node) => (node.type as unknown) === "ScrollView")).toEqual([left, right]);
      for (const scroll of [left, right]) {
        expect(scroll.props.style).toMatchObject({ flex: 1 });
        expect(scroll.props.showsVerticalScrollIndicator).toBe(true);
        if (os === "web") expect(scroll.props.dataSet).toEqual({ bcdetails: "inset" });
        else expect(scroll.props.scrollIndicatorInsets).toEqual({ bottom: 8 });
      }
      await act(async () => renderer!.unmount());
      renderer = undefined;
    }
  });

  it("preserves single-column order and section choices when the sheet narrows", async () => {
    const detailProps = props(true);
    await act(async () => { renderer = TestRenderer.create(<TaskDetailCards {...detailProps} />); });
    const heading = () => host(renderer!.root, "detail-location").find((node) => typeof node.type === "string" && typeof node.props.accessibilityState?.expanded === "boolean");
    await act(async () => heading().props.onPress());
    expect(heading().props.accessibilityState.expanded).toBe(false);
    await act(async () => renderer!.update(<TaskDetailCards {...detailProps} columns={false} />));
    expect(order(renderer!.root)).toEqual(ORDER);
    expect(heading().props.accessibilityState.expanded).toBe(false);
    expect(renderer!.root.findAll((node) => (node.type as unknown) === "ScrollView")).toHaveLength(0);
  });
});

describe("detail message typography", () => {
  it.each(["detail-prompt", "detail-human", "detail-message"])("animates and interrupts the measured height for %s", async (id) => {
    const message = (text: string) => ({ prompt: { state: "ready" as const, text: text.repeat(80) }, load() {} });
    setSectionClosed("prompt", false);
    await act(async () => { renderer = TestRenderer.create(<TaskDetailCards {...props(false)} columns={false}
      firstPrompt={message("First prompt. ")} humanMessage={message("Follow-up. ")} lastMessage={message("Latest reply. ")} />); });
    const body = host(renderer!.root, `${id}-text`);
    const measure = body.find((node) => typeof node.type === "string" && typeof node.props.onLayout === "function");
    await act(async () => measure.props.onLayout({ nativeEvent: { layout: { height: 1000 } } }));
    const stop = vi.fn();
    const start = vi.fn();
    const timing = vi.spyOn(Animated, "timing").mockReturnValue({ start, stop, reset() {} } as never);
    await act(async () => host(renderer!.root, `${id}-more`).props.onPress());
    expect(timing).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ toValue: 1, duration: 180, useNativeDriver: false }));
    await act(async () => host(renderer!.root, `${id}-more`).props.onPress());
    expect(stop).toHaveBeenCalledOnce();
    expect(timing).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ toValue: 0, duration: 140, useNativeDriver: false }));
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("switches immediately under reduced motion", async () => {
    motion.reduced = true;
    setSectionClosed("prompt", false);
    const message = { prompt: { state: "ready" as const, text: "Long message. ".repeat(80) }, load() {} };
    await act(async () => { renderer = TestRenderer.create(<TaskDetailCards {...props(false)} columns={false} firstPrompt={message} />); });
    const body = host(renderer!.root, "detail-prompt-text");
    const measure = body.find((node) => typeof node.type === "string" && typeof node.props.onLayout === "function");
    await act(async () => measure.props.onLayout({ nativeEvent: { layout: { height: 1000 } } }));
    const timing = vi.spyOn(Animated, "timing");
    await act(async () => host(renderer!.root, "detail-prompt-more").props.onPress());
    expect(body.props.style).toBeNull();
    expect(timing).not.toHaveBeenCalled();
  });

  it.each([
    ["10 lines", Array(10).fill("line").join("\n"), false],
    ["11 lines", Array(11).fill("line").join("\n"), true],
    ["600 code units", "a".repeat(600), false],
    ["601 code units", "a".repeat(601), true],
    ["trailing blank lines", Array(10).fill("line").join("\n") + "\n\n", false],
  ])("uses the long-message threshold for all three messages: %s", async (_name, text, long) => {
    const message = (suffix: string) => ({ prompt: { state: "ready" as const, text, timestamp: suffix }, load() {} });
    setSectionClosed("prompt", false);
    await act(async () => { renderer = TestRenderer.create(<TaskDetailCards {...props(false)} columns={false}
      firstPrompt={message("2026-10-20T08:00:00Z")} humanMessage={message("2026-10-20T08:01:00Z")} lastMessage={message("2026-10-20T08:02:00Z")} />); });
    for (const id of ["detail-prompt", "detail-human", "detail-message"]) {
      expect(renderer!.root.findAll((node) => typeof node.type === "string" && node.props.testID === `${id}-more`)).toHaveLength(long ? 1 : 0);
    }
  });

  it.each(["web", "ios", "android"])("follows Paseo's body size for all three messages on %s", async (os) => {
    vi.stubGlobal("__rnMockOS", os);
    const message = (text: string) => ({ prompt: { state: "ready" as const, text: text.repeat(80) }, load() {} });
    const detailProps: TaskDetailCardsProps = {
      ...props(false), touch: os !== "web", columns: false,
      firstPrompt: message("First prompt. "),
      humanMessage: message("Follow-up. "),
      lastMessage: message("Latest reply. "),
    };
    setSectionClosed("prompt", false);
    for (const [ui, content, factor] of [[14, 15, 1], [14, 16, 1], [18, 16, 1], [18, 20, 1], [18, 20, 0.9]] as const) {
      const theme = { ...THEME, typography: { fontSize: { ui, content } } };
      const size = Math.round(content * 0.9 * factor);
      await act(async () => {
        renderer = TestRenderer.create(<TasksTypography theme={theme}><TasksTypographyScale factor={factor}><TaskDetailCards {...detailProps} theme={theme} /></TasksTypographyScale></TasksTypography>);
      });
      for (const id of ["detail-prompt", "detail-human", "detail-message"]) {
        const section = host(renderer!.root, id);
        expect(section.findByType(MarkdownView).props.size).toBe(size);
        expect(section.findByType(MarkdownView).props).toMatchObject({ variant: "document", compact: detailProps.touch });
        expect(host(section, `${id}-text`).props.style).toMatchObject({ maxHeight: 10 * variantMetrics("document", size, detailProps.touch).bodyLineHeight });
        const more = host(section, `${id}-more`);
        expect(more.findByType(Icon).props.name).toBe("ChevronsDown");
        expect(more.props.accessibilityState.expanded).toBe(false);
        expect(StyleSheet.flatten(more.find((node) => (node.type as unknown) === "Text").props.style).fontSize).toBe(Math.round(HOST_FONT.sm * ui / HOST_FONT.base * factor));
        await act(async () => more.props.onPress());
        expect(more.findByType(Icon).props.name).toBe("ChevronsUp");
        expect(more.props.accessibilityState.expanded).toBe(true);
        expect(host(section, `${id}-text`).props.style).toBeNull();
        expect(section.findByType(MarkdownView).props.size).toBe(size);
      }
      await act(async () => renderer!.unmount());
      renderer = undefined;
    }
  });
});

describe("detail message times", () => {
  function heading(root: ReactTestInstance, id: string) {
    return host(root, id).find((node) => typeof node.type === "string" && typeof node.props.accessibilityState?.expanded === "boolean");
  }
  function messageHeading(root: ReactTestInstance, id: string) {
    return host(root, `${id}-heading`);
  }
  function labels(root: ReactTestInstance) {
    return root.findAll((node) => (node.type as unknown) === "Text").map((node) => node.props.children);
  }

  it.each(["web", "ios", "android"])("shows each message's local time on the right, including when folded, on %s", async (os) => {
    vi.stubGlobal("__rnMockOS", os);
    const first = new Date(NOW);
    first.setHours(8, 13, 7, 0);
    const last = new Date(first);
    last.setDate(last.getDate() - 1);
    last.setHours(21, 47, 52, 0);
    const day = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    for (const language of ["zh", "en"] as const) {
      for (const columns of [false, true]) {
        resetSectionChoices();
        // The first prompt folds under a reply; the reader opened it.
        setSectionClosed("prompt", false);
        const detailProps: TaskDetailCardsProps = {
          ...props(true), language, strings: BOARD_STRINGS[language].sidebar, columns, touch: os !== "web",
          firstPrompt: { prompt: { state: "ready", text: "First prompt", timestamp: first.toISOString() }, load() {} },
          lastMessage: { prompt: { state: "ready", text: "Last reply", timestamp: last.toISOString() }, load() {} },
        };
        await act(async () => { renderer = TestRenderer.create(<TaskDetailCards {...detailProps} />); });
        const root = renderer!.root;
        const words = cardStrings(language).details;
        for (const [id, title, time, fullTime] of [
          ["detail-prompt", words.prompt, "08:13", `${day(first)} 08:13:07`],
          ["detail-message", words.message, `${last.getMonth() + 1}/${last.getDate()} 21:47`, `${day(last)} 21:47:52`],
        ] as const) {
          expect(labels(messageHeading(root, id))).toEqual([title, time]);
          const stamp = messageHeading(root, id).findAll((node) => (node.type as unknown) === "Text")[1]!;
          expect(stamp.props.numberOfLines).toBe(1);
          expect(stamp.props.dataSet?.bctip).toBe(os === "web" ? fullTime : undefined);
          expect(stamp.props.onPress).toBeUndefined();
          expect(heading(root, id).props.dataSet?.bctip).toBe(os === "web" ? words.collapse(title) : undefined);
          expect(StyleSheet.flatten(stamp.props.style)).toMatchObject({ flexShrink: 1, fontVariant: ["tabular-nums"] });
          await act(async () => heading(root, id).props.onPress());
          expect(heading(root, id).props.accessibilityState.expanded).toBe(false);
          expect(labels(messageHeading(root, id))).toEqual([title, time]);
          const foldedStamp = messageHeading(root, id).findAll((node) => (node.type as unknown) === "Text")[1]!;
          expect(foldedStamp.props.dataSet?.bctip).toBe(os === "web" ? fullTime : undefined);
          expect(heading(root, id).props.dataSet?.bctip).toBe(os === "web" ? words.expand(title) : undefined);
        }
        await act(async () => renderer!.unmount());
        renderer = undefined;
      }
    }
  });

  it("leaves missing, invalid and unloaded message times blank instead of using the task's times", async () => {
    const detailProps = props(true);
    for (const timestamp of [undefined, "", "invalid"]) {
      await act(async () => {
        renderer = TestRenderer.create(<TaskDetailCards {...detailProps}
          firstPrompt={{ prompt: { state: "ready", text: "No time", timestamp }, load() {} }}
          lastMessage={{ prompt: { state: "ready", text: "No time", timestamp }, load() {} }} />);
      });
      for (const id of ["detail-prompt", "detail-message"]) expect(labels(messageHeading(renderer!.root, id))).toHaveLength(1);
      await act(async () => renderer!.unmount());
    }
    for (const state of ["idle", "loading", "none", "error"] as const) {
      await act(async () => {
        renderer = TestRenderer.create(<TaskDetailCards {...detailProps}
          firstPrompt={{ prompt: { state }, load() {} }} lastMessage={{ prompt: { state }, load() {} }} />);
      });
      for (const id of ["detail-prompt", "detail-message"]) expect(labels(messageHeading(renderer!.root, id))).toHaveLength(1);
      await act(async () => renderer!.unmount());
    }
    renderer = undefined;
  });
});
