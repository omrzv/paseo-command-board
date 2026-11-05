import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import "./helpers/quiet-renderer";

vi.mock("react-native", () => import("./helpers/rn-mock"));
vi.mock("@getpaseo/plugin/client/react-native", async () => {
  const rn = await import("./helpers/rn-mock");
  return { ...rn, Icon: (props: object) => React.createElement("Icon", props), Modal: Object.assign((props: { children?: React.ReactNode; open: boolean }) => (props.open ? React.createElement("Modal", null, props.children) : null), { Content: (props: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, props.children) }) };
});
const answers: Record<string, unknown> = {};
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: (contract: { name: string }) => () => Promise.resolve(answers[contract.name]) }));

import { TodayStrip, currentOrNext, memberIn, stackRows, untilText } from "../../client/tasks/board/today-strip";
import type { Meeting } from "../../shared/calendar-rpc";

const theme = { colors: { surface0: "#000", surface1: "#111", surface2: "#222", foreground: "#fff", foregroundMuted: "#999", border: "#333", accent: "#36f", accentForeground: "#fff", destructive: "#f33" }, isDark: true } as never;
const day = new Date(); day.setHours(0, 0, 0, 0);
const h = (hours: number) => day.getTime() + hours * 3_600_000;
const meeting = (id: string, start: number, end: number, extra: Partial<Meeting> = {}): Meeting => ({ id, title: id, start, end, allDay: false, location: "", description: "", joinUrl: null, organizer: "", attendees: [], myStatus: "accepted", ...extra });

describe("Today strip", () => {
  it("knows the meeting on now and the next one", () => {
    const list = [meeting("standup", h(9), h(9.25)), meeting("sync", h(11), h(12)), meeting("offsite", h(0), h(24), { allDay: true })];
    expect(currentOrNext(list, h(9.1))).toMatchObject({ meeting: { id: "standup" }, now: true });
    expect(currentOrNext(list, h(10))).toMatchObject({ meeting: { id: "sync" }, now: false });
    expect(currentOrNext(list, h(13))).toBeNull();
    expect(untilText(h(11), h(10.8))).toBe("In 12 min");
    expect(untilText(h(12.5), h(11))).toBe("In 1 h 30");
    expect(untilText(h(33), h(20))).toMatch(/^Tomorrow /);
  });

  it("stacks overlapping meetings and finds the team member a meeting is with", () => {
    const rows = stackRows([meeting("a", h(10), h(11)), meeting("b", h(10.5), h(11.5)), meeting("c", h(12), h(13))]);
    expect(rows.get("a")).toEqual({ row: 0, rows: 2 });
    expect(rows.get("b")).toEqual({ row: 1, rows: 2 });
    expect(rows.get("c")).toEqual({ row: 0, rows: 1 });
    const members = [{ id: "m1", name: "Dana Levi", slackUserId: null, role: "" }, { id: "m2", name: "Yossi", slackUserId: null, role: "" }];
    expect(memberIn(meeting("1:1", h(9), h(10), { attendees: [{ name: "", email: "dana.l@hero.ai", status: "accepted" }] }), members)?.id).toBe("m1");
    expect(memberIn(meeting("x", h(9), h(10), { attendees: [{ name: "Ron", email: "ron@hero.ai", status: "" }] }), members)).toBeNull();
  });

  it("offers to connect, then draws today's meetings with the next one and its Join link", async () => {
    answers["team.list"] = { members: [], tasks: [], suggestions: [] };
    answers["calendar.today"] = { status: { connected: false, name: "", fetchedAt: null, error: null }, meetings: [] };
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<TodayStrip theme={theme} visible />); });
    expect(renderer!.root.findAll((node) => node.props.testID === "today-connect").length).toBeGreaterThan(0);
    const later = Date.now() + 20 * 60_000;
    answers["calendar.today"] = { status: { connected: true, name: "me", fetchedAt: Date.now(), error: null }, meetings: [meeting("Research sync", later, later + 3_600_000, { joinUrl: "https://meet.google.com/a-b-c" })] };
    await act(async () => { renderer!.unmount(); renderer = TestRenderer.create(<TodayStrip theme={theme} visible />); });
    const ids = renderer!.root.findAll((node) => typeof node.type === "string" && typeof node.props.testID === "string").map((node) => node.props.testID);
    expect(ids).toEqual(expect.arrayContaining(["today-strip", "today-join"]));
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain("Research sync");
    expect(text).toMatch(/In (19|20) min/);
  });
});
