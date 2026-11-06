import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View, type TextStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { withAlpha } from "../../components/theme-tokens";
import { TaskText as Text, HOST_FONT as F } from "../typography";
import { taskTokens, type TaskTokens } from "../cards/tokens";
import { LinkedText } from "../cards/linked-text";
import { localDay, moveId, sortTodos } from "./todo-model";
import { onTodosChanged } from "./todo-events";
import { StartAgentDialog } from "./start-agent";
import { SlackReply } from "./slack-column";
import { openLink } from "../../components/open-link";
import type { PaseoApi } from "@getpaseo/client";
import { type Todo, todosAddRpc, todosDeleteRpc, todosListRpc, todosReorderRpc, todosUpdateRpc } from "../../../shared/todos-rpc";
import { type Member, memberColor, teamListRpc, teamSaveTaskRpc } from "../../../shared/team-rpc";
import { DragHandle, useDragReorder, withDropLines, type DragReorder } from "./drag-reorder";
import { teamChanged } from "./team-events";

const POLL_MS = 30_000;
const COLLAPSED_WIDTH = 40;
const INPUT = { outlineStyle: "none" } as unknown as TextStyle;

function dueLabel(due: string, today: string, tomorrow: string): string {
  if (due < today) return "Overdue";
  if (due === today) return "Today";
  if (due === tomorrow) return "Tomorrow";
  const [year, month, day] = due.split("-").map(Number);
  return new Date(year!, month! - 1, day!).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/**
 * The person's own to-dos beside the lanes: things to remember that are not
 * an agent's or a Slack message. Kept on the daemon, so every client shares
 * them. Enter in the top box adds one; a press opens it for notes and a day.
 */
/** The phone's full-screen column. */
const FILL = { flex: 1, minHeight: 0, paddingLeft: 12, paddingRight: 4, paddingTop: 4 } as const;

export function TodoColumn(props: { theme: PluginTheme; width: number; visible: boolean; /** The phone: the whole screen, never collapsed. */ fill?: boolean; onShown?(shown: boolean): void; paseo?: PaseoApi; onOpenAgent?(agentId: string): void; onOpenWorkspace?(workspaceId: string): void }) {
  const [newWorkspace, setNewWorkspace] = useState(false);
  const tokens = taskTokens(props.theme);
  const listNow = useRpc(todosListRpc);
  const addNow = useRpc(todosAddRpc);
  const updateNow = useRpc(todosUpdateRpc);
  const removeNow = useRpc(todosDeleteRpc);
  const reorderNow = useRpc(todosReorderRpc);
  const teamNow = useRpc(teamListRpc);
  const giveNow = useRpc(teamSaveTaskRpc);
  const rpc = useRef({ list: listNow, add: addNow, update: updateNow, remove: removeNow, reorder: reorderNow, team: teamNow, give: giveNow });
  rpc.current = { list: listNow, add: addNow, update: updateNow, remove: removeNow, reorder: reorderNow, team: teamNow, give: giveNow };
  const [members, setMembers] = useState<Member[]>([]);
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [draft, setDraft] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [startedNote, setStartedNote] = useState<string | null>(null);
  useEffect(() => {
    if (!startedNote) return;
    const timer = setTimeout(() => setStartedNote(null), 5_000);
    return () => clearTimeout(timer);
  }, [startedNote]);
  const [showDone, setShowDone] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const alive = useRef(true);
  const [starting, setStarting] = useState<Todo | null>(null);

  const refresh = useCallback(() => {
    void rpc.current.list({}).then((result) => {
      if (alive.current && result && Array.isArray(result.todos)) setTodos(result.todos);
    }).catch(() => {
      // An older server without to-dos: the column stays away.
    });
    void rpc.current.team({}).then((result) => { if (alive.current && Array.isArray(result?.members)) setMembers(result.members); }, () => undefined);
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!props.visible) return () => { alive.current = false; };
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    const stop = onTodosChanged(refresh);
    return () => { alive.current = false; clearInterval(timer); stop(); };
  }, [refresh, props.visible]);

  const patch = useCallback((id: string, change: Partial<Pick<Todo, "title" | "notes" | "due" | "done">>) => {
    setTodos((current) => current?.map((todo) => (todo.id === id ? { ...todo, ...change, ...(change.done !== undefined ? { doneAt: change.done ? Date.now() : null } : {}) } : todo)) ?? current);
    void rpc.current.update({ id, ...change }).catch(refresh);
  }, [refresh]);

  const add = () => {
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    void rpc.current.add({ title }).then((result) => setTodos((current) => [...(current ?? []), result.todo]), refresh);
  };

  // Drag a to-do by its grip to put it where you want it.
  const drag = useDragReorder((id, target) => {
    setTodos((current) => {
      if (!current) return current;
      const ids = moveId(sortTodos(current.filter((todo) => !todo.done)).map((todo) => todo.id), id, target.index);
      void rpc.current.reorder({ ids }).catch(refresh);
      return current.map((todo) => { const at = ids.indexOf(todo.id); return at >= 0 ? { ...todo, order: at } : todo; });
    });
  });
  /** The to-do becomes a team task for that person, keeping its notes and links. */
  const give = (todo: Todo, memberId: string) => {
    const notes = [todo.notes.trim(), todo.source ? `From ${todo.source.from} in ${todo.source.where} on Slack` : ""].filter(Boolean).join("\n\n");
    void rpc.current.give({ title: todo.title, notes, assigneeId: memberId, links: [...todo.links, ...(todo.source ? [todo.source.permalink] : [])].slice(0, 30), ...(todo.due ? { due: todo.due } : {}) }).then(() => {
      setTodos((current) => current?.filter((entry) => entry.id !== todo.id) ?? current);
      void rpc.current.remove({ id: todo.id });
      teamChanged();
      setStartedNote(`Given to ${members.find((member) => member.id === memberId)?.name ?? "the team"}: ${todo.title}`);
    }, refresh);
  };

  const shown = todos !== null;
  const onShown = props.onShown;
  useEffect(() => { onShown?.(shown); }, [shown, onShown]);
  useEffect(() => () => onShown?.(false), [onShown]);
  if (todos === null) return null;
  const today = localDay(0);
  const tomorrow = localDay(1);
  const openTodos = sortTodos(todos.filter((todo) => !todo.done));
  const doneTodos = todos.filter((todo) => todo.done).sort((left, right) => (right.doneAt ?? 0) - (left.doneAt ?? 0));
  const urgent = openTodos.filter((todo) => todo.due !== null && todo.due <= today).length;

  if (collapsed && !props.fill) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel="Show my tasks" onPress={() => setCollapsed(false)} testID="todo-column-collapsed"
        style={{ width: COLLAPSED_WIDTH, alignItems: "center", paddingTop: 12, gap: 8, borderRightWidth: 1, borderRightColor: tokens.card.border }}>
        <Icon name="ListChecks" size={18} color={tokens.accentText} />
        {openTodos.length > 0 ? <Text style={{ fontSize: F.sm, fontWeight: "700", color: urgent ? tokens.status.warning : tokens.foregroundMuted }}>{openTodos.length}</Text> : null}
      </Pressable>
    );
  }

  return (
    <View testID="todo-column" style={props.fill ? FILL : { width: props.width, paddingLeft: 12, paddingTop: 4, borderRightWidth: 1, borderRightColor: tokens.card.border }}>
      <View style={{ height: 36, flexDirection: "row", alignItems: "center", gap: 6, paddingRight: 8 }}>
        <Icon name="ListChecks" size={16} color={tokens.accentText} />
        <Text style={{ fontSize: F.base, fontWeight: "600", color: tokens.foreground }}>My tasks</Text>
        <Text style={{ fontSize: F.base, color: tokens.foregroundMuted }}>{openTodos.length}</Text>
        <View style={{ flex: 1 }} />
        {props.paseo ? (
          <Pressable accessibilityRole="button" accessibilityLabel="New workspace" testID="new-workspace" onPress={() => setNewWorkspace(true)} hitSlop={4}
            style={{ height: 26, paddingHorizontal: 8, borderRadius: 6, flexDirection: "row", alignItems: "center", gap: 4, borderWidth: 1, borderColor: tokens.card.border }}>
            <Icon name="FolderPlus" size={13} color={tokens.accentText} />
            <Text style={{ fontSize: F.sm, fontWeight: "600", color: tokens.foreground }}>Workspace</Text>
          </Pressable>
        ) : null}
        {props.fill ? null : (
          <Pressable accessibilityRole="button" accessibilityLabel="Collapse" onPress={() => setCollapsed(true)} hitSlop={4}
            style={{ width: 28, height: 28, borderRadius: 6, alignItems: "center", justifyContent: "center" }}>
            <Icon name="PanelLeftClose" size={14} color={tokens.foregroundMuted} />
          </Pressable>
        )}
      </View>
      <View style={{ marginRight: 8, marginBottom: 8, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, height: 38, borderRadius: 10, borderWidth: 1.5, borderColor: withAlpha(tokens.accent, 0.55), backgroundColor: withAlpha(tokens.accent, tokens.isDark ? 0.1 : 0.05) }}>
        <Icon name="Plus" size={15} color={tokens.accentText} />
        <TextInput
          testID="todo-add-input"
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={add}
          blurOnSubmit={false}
          returnKeyType="done"
          placeholder="Add a task, press Enter"
          placeholderTextColor={tokens.foregroundMuted}
          style={[{ flex: 1, height: 36, fontSize: F.base, color: tokens.foreground }, INPUT]}
        />
      </View>
      {startedNote ? <Text testID="todo-started-note" numberOfLines={2} style={{ marginRight: 8, marginBottom: 6, fontSize: F.sm, color: tokens.success }}>{startedNote}</Text> : null}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 6, paddingRight: 8, paddingBottom: 16 }}>
        {openTodos.length === 0 ? <Text style={{ fontSize: F.sm, color: tokens.foregroundMuted, paddingVertical: 8 }}>Nothing to remember. Add anything above.</Text> : null}
        {withDropLines(openTodos, drag, "todos", tokens.accent, (todo) => (
          <TodoRow key={todo.id} todo={todo} tokens={tokens} open={open === todo.id} today={today} tomorrow={tomorrow} drag={drag} members={members} onGive={(memberId) => give(todo, memberId)}
            onToggleOpen={() => setOpen((current) => (current === todo.id ? null : todo.id))} onPatch={(change) => patch(todo.id, change)}
            onRemove={() => { setTodos((current) => current?.filter((entry) => entry.id !== todo.id) ?? current); void rpc.current.remove({ id: todo.id }).catch(refresh); }}
            onStartAgent={props.paseo ? () => setStarting(todo) : undefined} onOpenAgent={props.onOpenAgent} />
        ))}
        {doneTodos.length > 0 ? (
          <Pressable accessibilityRole="button" onPress={() => setShowDone((was) => !was)} style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 8 }}>
            <Icon name={showDone ? "ChevronDown" : "ChevronRight"} size={13} color={tokens.foregroundMuted} />
            <Text style={{ fontSize: F.sm, color: tokens.foregroundMuted }}>{`Done this week (${doneTodos.length})`}</Text>
          </Pressable>
        ) : null}
        {showDone ? doneTodos.map((todo) => (
          <TodoRow key={todo.id} todo={todo} tokens={tokens} open={open === todo.id} today={today} tomorrow={tomorrow}
            onToggleOpen={() => setOpen((current) => (current === todo.id ? null : todo.id))} onPatch={(change) => patch(todo.id, change)}
            onRemove={() => { setTodos((current) => current?.filter((entry) => entry.id !== todo.id) ?? current); void rpc.current.remove({ id: todo.id }).catch(refresh); }}
            onStartAgent={props.paseo ? () => setStarting(todo) : undefined} onOpenAgent={props.onOpenAgent} />
        )) : null}
      </ScrollView>
      {newWorkspace && props.paseo ? (
        <StartAgentDialog paseo={props.paseo} theme={props.theme} onClose={() => setNewWorkspace(false)}
          onStarted={(agentId, workspaceId) => {
            setNewWorkspace(false);
            // A new workspace is somewhere to go: open it (its agent's tab when one was started).
            if (agentId && props.onOpenAgent) props.onOpenAgent(agentId);
            else if (props.onOpenWorkspace) props.onOpenWorkspace(workspaceId);
            else setStartedNote("Workspace created");
          }} />
      ) : null}
      {starting && props.paseo ? (
        <StartAgentDialog todo={starting} paseo={props.paseo} theme={props.theme} onClose={() => setStarting(null)}
          onStarted={(agentId) => {
            const todo = starting;
            setStarting(null);
            setTodos((current) => current?.map((entry) => (entry.id === todo.id ? { ...entry, agentId, done: true, doneAt: Date.now() } : entry)) ?? current);
            void rpc.current.update({ id: todo.id, agentId, done: true }).catch(refresh);
            // Stay on the board: the new agent shows up in its lanes; "Open agent" on the task jumps to it.
            setStartedNote(`Agent started: ${todo.title}`);
          }} />
      ) : null}
    </View>
  );
}

/** Slack's purple, as on the Slack column. */
const SLACK_TINT = "#7c3085";

function TodoRow(props: {
  todo: Todo;
  tokens: TaskTokens;
  open: boolean;
  today: string;
  tomorrow: string;
  onToggleOpen(): void;
  onPatch(change: Partial<Pick<Todo, "title" | "notes" | "due" | "done">>): void;
  onRemove(): void;
  onStartAgent?(): void;
  onOpenAgent?(agentId: string): void;
  /** Open to-dos are dragged by their grip. */
  drag?: DragReorder;
  members?: Member[];
  onGive?(memberId: string): void;
}) {
  const { todo, tokens } = props;
  const [title, setTitle] = useState(todo.title);
  const [notes, setNotes] = useState(todo.notes);
  const [replying, setReplying] = useState(false);
  const [sent, setSent] = useState(false);
  useEffect(() => { setTitle(todo.title); setNotes(todo.notes); }, [todo.title, todo.notes]);
  const overdue = !todo.done && todo.due !== null && todo.due < props.today;
  const dueToday = !todo.done && todo.due === props.today;
  const dueColor = overdue ? tokens.danger : dueToday ? tokens.status.warning : tokens.foregroundMuted;
  const days: Array<{ label: string; value: string | null }> = [
    { label: "Today", value: props.today },
    { label: "Tomorrow", value: props.tomorrow },
    { label: "Next week", value: localDay(7) },
    { label: "No date", value: null },
  ];
  return (
    <View ref={props.drag ? (props.drag.row(todo.id, "todos") as never) : undefined} collapsable={false} testID={`todo-${todo.id}`} style={{ borderRadius: 10, borderWidth: 1, borderColor: props.open ? withAlpha(tokens.accent, 0.6) : tokens.card.border, backgroundColor: tokens.card.background, padding: 8, paddingLeft: props.drag ? 2 : 8, gap: 6, opacity: props.drag?.dragging === todo.id ? 0.4 : todo.done && !props.open ? 0.6 : 1 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        {props.drag ? <DragHandle drag={props.drag} dragKey={todo.id} color={withAlpha(tokens.foregroundMuted, 0.7)} /> : null}
        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: todo.done }} accessibilityLabel={todo.done ? "Mark not done" : "Mark done"} onPress={() => props.onPatch({ done: !todo.done })} hitSlop={6}
          style={{ marginTop: 2, width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: todo.done ? tokens.success : overdue ? tokens.danger : tokens.foregroundMuted, backgroundColor: todo.done ? tokens.success : "transparent", alignItems: "center", justifyContent: "center" }}>
          {todo.done ? <Icon name="Check" size={11} color="#ffffff" /> : null}
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={props.open ? "Close task" : "Open task"} onPress={props.onToggleOpen} style={{ flex: 1, gap: 3 }}>
          <Text style={{ fontSize: F.base, color: tokens.foreground, textDecorationLine: todo.done ? "line-through" : "none" }}>{todo.title}</Text>
          {todo.due || (todo.notes && !props.open) ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              {todo.due ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                  <Icon name="Calendar" size={11} color={dueColor} />
                  <Text style={{ fontSize: F.sm, color: dueColor, fontWeight: overdue || dueToday ? "600" : "400" }}>{dueLabel(todo.due, props.today, props.tomorrow)}</Text>
                </View>
              ) : null}
              {todo.notes && !props.open ? <Icon name="StickyNote" size={11} color={tokens.foregroundMuted} /> : null}
            </View>
          ) : null}
        </Pressable>
      </View>
      {props.open ? (
        <View style={{ gap: 8, paddingLeft: 26 }}>
          <TextInput value={title} onChangeText={setTitle} onBlur={() => { if (title.trim() && title.trim() !== todo.title) props.onPatch({ title: title.trim() }); }}
            placeholder="Title" placeholderTextColor={tokens.foregroundMuted}
            style={[{ fontSize: F.base, color: tokens.foreground, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 6, backgroundColor: withAlpha(tokens.foreground, 0.04) }, INPUT]} />
          <TextInput value={notes} onChangeText={setNotes} onBlur={() => { if (notes !== todo.notes) props.onPatch({ notes }); }} multiline
            placeholder="Notes, links…" placeholderTextColor={tokens.foregroundMuted}
            style={[{ minHeight: 60, fontSize: F.sm, color: tokens.foreground, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 6, backgroundColor: withAlpha(tokens.foreground, 0.04), textAlignVertical: "top" }, INPUT]} />
          {todo.notes ? <LinkedText text={todo.notes} linkColor={tokens.accentText} numberOfLines={1} style={{ fontSize: F.sm, color: tokens.foregroundMuted }} /> : null}
          {todo.links.length > 0 ? (
            <View style={{ gap: 3 }}>
              {todo.links.map((link) => <LinkedText key={link} text={link} linkColor={tokens.accentText} numberOfLines={1} style={{ fontSize: F.sm }} />)}
            </View>
          ) : null}
          {todo.source ? (
            <Pressable accessibilityRole="link" onPress={() => openLink(todo.source!.permalink)} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Icon name="Slack" size={12} color="#7c3085" />
              <Text style={{ fontSize: F.sm, color: tokens.foregroundMuted, textDecorationLine: "underline" }}>{`From ${todo.source.from} in ${todo.source.where}`}</Text>
            </Pressable>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {todo.agentId && props.onOpenAgent ? (
              <Pressable accessibilityRole="button" onPress={() => props.onOpenAgent?.(todo.agentId!)} style={{ height: 28, paddingHorizontal: 10, borderRadius: 7, flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1, borderColor: tokens.accent }}>
                <Icon name="Bot" size={13} color={tokens.accentText} />
                <Text style={{ fontSize: F.sm, fontWeight: "600", color: tokens.accentText }}>Open agent</Text>
              </Pressable>
            ) : null}
            {props.onStartAgent ? (
              <Pressable accessibilityRole="button" testID="todo-start-agent" onPress={props.onStartAgent} style={{ height: 28, paddingHorizontal: 10, borderRadius: 7, flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: tokens.accent }}>
                <Icon name="Play" size={12} color="#ffffff" />
                <Text style={{ fontSize: F.sm, fontWeight: "700", color: "#ffffff" }}>{todo.agentId ? "Start another agent" : "Start agent"}</Text>
              </Pressable>
            ) : null}
            {todo.source ? (
              <Pressable accessibilityRole="button" testID="todo-slack-reply" accessibilityState={{ expanded: replying }} onPress={() => { setReplying((was) => !was); setSent(false); }}
                style={{ height: 28, paddingHorizontal: 10, borderRadius: 7, flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1, borderColor: SLACK_TINT, backgroundColor: replying ? withAlpha(SLACK_TINT, 0.14) : "transparent" }}>
                <Icon name="Slack" size={13} color={SLACK_TINT} />
                <Text style={{ fontSize: F.sm, fontWeight: "600", color: tokens.foreground }}>Reply in Slack</Text>
              </Pressable>
            ) : null}
          </View>
          {todo.source && replying ? (
            <SlackReply keepThread tokens={tokens} tint={SLACK_TINT} item={{ id: todo.source.slackId, where: todo.source.where, direct: todo.source.direct, threadTs: todo.source.threadTs }}
              onSent={() => { setReplying(false); setSent(true); }} />
          ) : null}
          {sent ? <Text testID="todo-slack-sent" style={{ fontSize: F.sm, color: tokens.success }}>Sent to Slack.</Text> : null}
          {props.onGive && props.members?.length && !todo.done ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 5 }}>
              <Text style={{ fontSize: F.sm, color: tokens.foregroundMuted }}>Give to</Text>
              {props.members.map((member) => (
                <Pressable key={member.id} accessibilityRole="button" testID={`todo-give-${member.id}`} onPress={() => props.onGive?.(member.id)}
                  style={{ height: 22, paddingHorizontal: 8, borderRadius: 11, justifyContent: "center", borderWidth: 1, borderColor: memberColor(member, tokens.isDark) }}>
                  <Text style={{ fontSize: F.sm - 1, color: memberColor(member, tokens.isDark), fontWeight: "600" }}>{member.name}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
            {days.map((day) => {
              const selected = todo.due === day.value;
              return (
                <Pressable key={day.label} accessibilityRole="button" accessibilityState={{ selected }} onPress={() => props.onPatch({ due: day.value })}
                  style={{ height: 24, paddingHorizontal: 8, borderRadius: 12, justifyContent: "center", borderWidth: 1, borderColor: selected ? tokens.accent : tokens.card.border, backgroundColor: selected ? withAlpha(tokens.accent, 0.14) : "transparent" }}>
                  <Text style={{ fontSize: F.sm, color: selected ? tokens.accentText : tokens.foregroundMuted }}>{day.label}</Text>
                </Pressable>
              );
            })}
            <View style={{ flex: 1 }} />
            <Pressable accessibilityRole="button" accessibilityLabel="Delete task" onPress={props.onRemove} hitSlop={4}
              style={{ height: 24, paddingHorizontal: 6, flexDirection: "row", alignItems: "center", gap: 3 }}>
              <Icon name="Trash2" size={12} color={tokens.danger} />
              <Text style={{ fontSize: F.sm, color: tokens.danger }}>Delete</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}
