import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => import("./helpers/rn-mock"));
vi.mock("@getpaseo/plugin/client/react-native", async () => ({ ...(await import("./helpers/rn-mock")), Icon: (props: object) => React.createElement("Icon", props) }));

import { dropTarget, withDropLines, type DragReorder } from "../../client/tasks/board/drag-reorder";

const rect = (y: number, height = 40) => ({ y, height });

describe("drag to reorder", () => {
  const rows = [
    { key: "a", group: "dana", rect: rect(100) },
    { key: "b", group: "dana", rect: rect(150) },
    { key: "c", group: "dana", rect: rect(200) },
    { key: "d", group: "yossi", rect: rect(300) },
  ];
  const headers = [{ group: "dana", rect: rect(70, 24) }, { group: "yossi", rect: rect(270, 24) }, { group: "ron", rect: rect(360, 24) }];

  it("places the row above or below the row under the pointer, leaving itself out", () => {
    expect(dropTarget(110, "c", rows, headers)).toEqual({ group: "dana", index: 0 });
    expect(dropTarget(135, "c", rows, headers)).toEqual({ group: "dana", index: 1 });
    expect(dropTarget(185, "a", rows, headers)).toEqual({ group: "dana", index: 1 });
  });

  it("moves across people: onto a row, a header (top), or just below a group's last row", () => {
    expect(dropTarget(330, "a", rows, headers)).toEqual({ group: "yossi", index: 1 });
    expect(dropTarget(370, "a", rows, headers)).toEqual({ group: "ron", index: 0 });
    expect(dropTarget(250, "d", rows, headers)).toEqual({ group: "dana", index: 3 });
    expect(dropTarget(5, "a", rows, headers)).toBeNull();
  });

  it("draws the drop line where the row will land", () => {
    const drag = { dragging: "c", target: { group: "dana", index: 1 } } as unknown as DragReorder;
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const out = withDropLines(items, drag, "dana", "#36f", (item) => <span key={item.id} />) as React.ReactElement[];
    expect(out.map((node) => node.key)).toEqual(["a", "drop-b", "b", "c"]);
    const atEnd = withDropLines(items, { ...drag, target: { group: "dana", index: 2 } } as DragReorder, "dana", "#36f", (item) => <span key={item.id} />) as React.ReactElement[];
    expect(atEnd.map((node) => node.key)).toEqual(["a", "b", "c", "drop-end"]);
    expect((withDropLines(items, { dragging: null, target: null } as unknown as DragReorder, "dana", "#36f", (item) => <span key={item.id} />) as React.ReactElement[]).length).toBe(3);
  });
});
