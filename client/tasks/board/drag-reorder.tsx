import React, { useCallback, useMemo, useRef, useState } from "react";
import { PanResponder, View, type GestureResponderEvent, type PanResponderGestureState } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";

type Rect = { y: number; height: number };
type Measurable = { measureInWindow?(callback: (x: number, y: number, width: number, height: number) => void): void };
export type DropTarget = { group: string; index: number };

/**
 * Where a row dropped at `y` goes: the position among the group's rows (the
 * dragged one left out), above a row's middle or below it; a group's header
 * takes it to that group's top. Null when `y` is over nothing.
 */
export function dropTarget(
  y: number,
  dragged: string,
  rows: Array<{ key: string; group: string; rect: Rect }>,
  headers: Array<{ group: string; rect: Rect }>,
): DropTarget | null {
  const others = rows.filter((row) => row.key !== dragged);
  for (const row of others) {
    if (y < row.rect.y || y > row.rect.y + row.rect.height) continue;
    const siblings = others.filter((entry) => entry.group === row.group).sort((a, b) => a.rect.y - b.rect.y);
    const position = siblings.indexOf(row);
    return { group: row.group, index: y < row.rect.y + row.rect.height / 2 ? position : position + 1 };
  }
  for (const header of headers) {
    if (y >= header.rect.y && y <= header.rect.y + header.rect.height) return { group: header.group, index: 0 };
  }
  // Below a group's last row and above the next group's header: the end of that group.
  const sorted = [...others].sort((a, b) => a.rect.y - b.rect.y);
  const nextHeaderAt = (from: number) => Math.min(...headers.filter((header) => header.rect.y > from).map((header) => header.rect.y), Number.POSITIVE_INFINITY);
  for (let index = sorted.length - 1; index >= 0; index--) {
    const row = sorted[index]!;
    const bottom = row.rect.y + row.rect.height;
    if (y > bottom && y < nextHeaderAt(bottom) && y < bottom + 60) {
      return { group: row.group, index: others.filter((entry) => entry.group === row.group).length };
    }
  }
  return null;
}

export interface DragReorder {
  dragging: string | null;
  target: DropTarget | null;
  row(key: string, group: string): (node: unknown) => void;
  header(group: string): (node: unknown) => void;
  handle(key: string): ReturnType<typeof PanResponder.create>["panHandlers"];
}

/**
 * Drag to reorder, within a list or across groups (a person's tasks). Rows and
 * group headers register their views; a row's grip starts the drag; the drop
 * calls `onDrop` with the group and the position among its other rows.
 */
export function useDragReorder(onDrop: (key: string, target: DropTarget) => void): DragReorder {
  const rows = useRef(new Map<string, { group: string; node: Measurable | null }>());
  const headers = useRef(new Map<string, Measurable | null>());
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const live = useRef<{ key: string; startY: number; rows: Array<{ key: string; group: string; rect: Rect }>; headers: Array<{ group: string; rect: Rect }>; target: DropTarget | null } | null>(null);
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;
  const responders = useRef(new Map<string, ReturnType<typeof PanResponder.create>>());

  const measure = (node: Measurable | null) => new Promise<Rect | null>((resolve) => {
    if (!node?.measureInWindow) return resolve(null);
    node.measureInWindow((_x, y, _width, height) => resolve({ y, height }));
  });

  const start = useCallback((key: string, event: GestureResponderEvent) => {
    const state = { key, startY: event.nativeEvent.pageY, rows: [] as Array<{ key: string; group: string; rect: Rect }>, headers: [] as Array<{ group: string; rect: Rect }>, target: null };
    live.current = state;
    setDragging(key);
    void Promise.all([
      ...[...rows.current].map(async ([rowKey, row]) => { const rect = await measure(row.node); if (rect) state.rows.push({ key: rowKey, group: row.group, rect }); }),
      ...[...headers.current].map(async ([group, node]) => { const rect = await measure(node); if (rect) state.headers.push({ group, rect }); }),
    ]);
  }, []);

  const move = useCallback((gesture: PanResponderGestureState) => {
    const state = live.current;
    if (!state) return;
    const next = dropTarget(state.startY + gesture.dy, state.key, state.rows, state.headers);
    if (next && (next.group !== state.target?.group || next.index !== state.target?.index)) {
      state.target = next;
      setTarget(next);
    }
  }, []);

  const end = useCallback((commit: boolean) => {
    const state = live.current;
    live.current = null;
    setDragging(null);
    setTarget(null);
    if (commit && state?.target) dropRef.current(state.key, state.target);
  }, []);

  return useMemo(() => ({
    dragging,
    target,
    row: (key: string, group: string) => (node: unknown) => {
      if (node) rows.current.set(key, { group, node: node as Measurable });
      else rows.current.delete(key);
    },
    header: (group: string) => (node: unknown) => {
      if (node) headers.current.set(group, node as Measurable);
      else headers.current.delete(group);
    },
    handle: (key: string) => {
      let responder = responders.current.get(key);
      if (!responder) {
        responder = PanResponder.create({
          onStartShouldSetPanResponder: () => true,
          onMoveShouldSetPanResponder: () => true,
          onPanResponderTerminationRequest: () => false,
          onPanResponderGrant: (event) => start(key, event),
          onPanResponderMove: (_event, gesture) => move(gesture),
          onPanResponderRelease: () => end(true),
          onPanResponderTerminate: () => end(false),
        });
        responders.current.set(key, responder);
      }
      return responder.panHandlers;
    },
  }), [dragging, target, start, move, end]);
}

/** The grip a row is dragged by. */
export function DragHandle(props: { drag: DragReorder; dragKey: string; color: string }) {
  return (
    <View {...props.drag.handle(props.dragKey)} accessibilityLabel="Drag to move" testID="drag-handle"
      style={{ width: 16, alignSelf: "stretch", alignItems: "center", justifyContent: "center", cursor: "grab" } as object}>
      <Icon name="GripVertical" size={13} color={props.color} />
    </View>
  );
}

/** The line showing where a dragged row will land. */
export function DropLine(props: { color: string }) {
  return <View testID="drop-line" pointerEvents="none" style={{ height: 3, borderRadius: 2, marginVertical: -1, backgroundColor: props.color }} />;
}

/** A group's rows with the drop line where the dragged row would land (positions leave the dragged row out). */
export function withDropLines<T extends { id: string }>(items: readonly T[], drag: DragReorder, group: string, color: string, render: (item: T) => React.ReactNode): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const showsHere = drag.dragging !== null && drag.target?.group === group;
  let position = 0;
  for (const item of items) {
    if (item.id !== drag.dragging) {
      if (showsHere && drag.target!.index === position) out.push(<DropLine key={`drop-${item.id}`} color={color} />);
      position++;
    }
    out.push(render(item));
  }
  if (showsHere && drag.target!.index === position) out.push(<DropLine key="drop-end" color={color} />);
  return out;
}
