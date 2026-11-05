import React, { useCallback, useMemo, useRef, useState } from "react";
import { PanResponder, View, type GestureResponderEvent, type PanResponderGestureState } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";

type Rect = { y: number; height: number };
type Measurable = { measureInWindow?(callback: (x: number, y: number, width: number, height: number) => void): void };
export type DropTarget = { group: string; index: number };

/** How far from the nearest row or header a pointer may be and still drop. */
const REACH = 48;

/**
 * Where a row dropped at `y` goes: next to the nearest row (above its middle
 * or below it), its position counted among the group's rows with the dragged
 * one left out; on a group's header, that group's top. Null when the pointer
 * is far from every row and header.
 */
export function dropTarget(
  y: number,
  dragged: string,
  rows: Array<{ key: string; group: string; rect: Rect }>,
  headers: Array<{ group: string; rect: Rect }>,
): DropTarget | null {
  for (const header of headers) {
    if (y >= header.rect.y && y <= header.rect.y + header.rect.height) return { group: header.group, index: 0 };
  }
  const others = rows.filter((row) => row.key !== dragged);
  const distance = (rect: Rect) => (y < rect.y ? rect.y - y : y > rect.y + rect.height ? y - rect.y - rect.height : 0);
  let nearest: (typeof others)[number] | null = null;
  for (const row of others) if (!nearest || distance(row.rect) < distance(nearest.rect)) nearest = row;
  if (!nearest || distance(nearest.rect) > REACH) {
    // An empty group: its header with some room under it.
    const header = headers.find((entry) => y > entry.rect.y && y < entry.rect.y + entry.rect.height + REACH && !others.some((row) => row.group === entry.group));
    return header ? { group: header.group, index: 0 } : null;
  }
  const siblings = others.filter((row) => row.group === nearest!.group).sort((a, b) => a.rect.y - b.rect.y);
  const position = siblings.indexOf(nearest);
  return { group: nearest.group, index: y < nearest.rect.y + nearest.rect.height / 2 ? position : position + 1 };
}

/** On the web, a drag must not select the text it passes over. */
function selection(allowed: boolean): void {
  const page = globalThis as unknown as { document?: { body?: { style: Record<string, string> } }; getSelection?(): { removeAllRanges?(): void } | null };
  const style = page.document?.body?.style;
  if (!style) return;
  style.userSelect = allowed ? "" : "none";
  style.webkitUserSelect = allowed ? "" : "none";
  if (!allowed) page.getSelection?.()?.removeAllRanges?.();
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
    selection(false);
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
    selection(true);
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
      style={{ width: 16, alignSelf: "stretch", alignItems: "center", justifyContent: "center", cursor: "grab", userSelect: "none" } as object}>
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
