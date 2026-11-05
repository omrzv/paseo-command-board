import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View, type TextStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { withAlpha } from "../../components/theme-tokens";
import { openLink } from "../../components/open-link";
import { TaskText as Text, HOST_FONT as F } from "../typography";
import { taskTokens, type TaskTokens } from "../cards/tokens";
import { LinkedText } from "../cards/linked-text";
import { formatRelative } from "../cards/format";
import { localDay } from "./todo-model";
import { ManagerCard } from "./manager-card";
import {
  type AgendaItem, type Manager, type Member, type Suggestion, type TeamStatus, type TeamTask, TEAM_STATUSES, memberColor,
  teamAddUpdateRpc, teamDeleteMemberRpc, teamDeleteTaskRpc, teamListRpc, teamSaveMemberRpc, teamSaveTaskRpc, teamSlackPeopleRpc, teamSuggestionRpc,
} from "../../../shared/team-rpc";

const POLL_MS = 30_000;
const INPUT = { outlineStyle: "none" } as unknown as TextStyle;
const FILL = { flex: 1, minHeight: 0, paddingLeft: 12, paddingRight: 4, paddingTop: 4 } as const;
const STATUS_LABEL: Record<TeamStatus, string> = { todo: "To do", doing: "Doing", blocked: "Blocked", done: "Done" };
const STATUS_RANK: Record<TeamStatus, number> = { blocked: 0, doing: 1, todo: 2, done: 3 };

function statusColor(status: TeamStatus, tokens: TaskTokens): string {
  return status === "blocked" ? tokens.danger : status === "doing" ? tokens.accent : status === "done" ? tokens.success : tokens.foregroundMuted;
}

function dueText(due: string, today: string): string {
  if (due < today) return "Overdue";
  if (due === today) return "Today";
  if (due === localDay(1)) return "Tomorrow";
  const [year, month, day] = due.split("-").map(Number);
  return new Date(year!, month! - 1, day!).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Open tasks first by status (blocked, doing, to do), then by due day; done last. */
export function sortTeamTasks(tasks: TeamTask[]): TeamTask[] {
  return [...tasks].sort((left, right) =>
    STATUS_RANK[left.status] - STATUS_RANK[right.status]
    || (left.due ?? "9999").localeCompare(right.due ?? "9999")
    || left.createdAt - right.createdAt);
}

/** A person's line: how many they are doing, blocked on, and late with. */
export function memberCounts(tasks: TeamTask[], today: string): { open: number; doing: number; blocked: number; overdue: number } {
  const open = tasks.filter((task) => task.status !== "done");
  return {
    open: open.length,
    doing: open.filter((task) => task.status === "doing").length,
    blocked: open.filter((task) => task.status === "blocked").length,
    overdue: open.filter((task) => task.due !== null && task.due < today).length,
  };
}

/**
 * The team's tasks, by person: the bottom half under Slack and My tasks.
 * Only on this Mac; the team works through Slack and the team agent, which
 * writes updates and suggestions into the same file.
 */
export function TeamColumn(props: { theme: PluginTheme; visible: boolean; /** The phone: the whole screen. */ fill?: boolean; folded?: boolean; onFold?(folded: boolean): void }) {
  const tokens = taskTokens(props.theme);
  const listNow = useRpc(teamListRpc);
  const saveTaskNow = useRpc(teamSaveTaskRpc);
  const deleteTaskNow = useRpc(teamDeleteTaskRpc);
  const updateNow = useRpc(teamAddUpdateRpc);
  const suggestionNow = useRpc(teamSuggestionRpc);
  const saveMemberNow = useRpc(teamSaveMemberRpc);
  const deleteMemberNow = useRpc(teamDeleteMemberRpc);
  const peopleNow = useRpc(teamSlackPeopleRpc);
  const rpc = useRef({ list: listNow, saveTask: saveTaskNow, deleteTask: deleteTaskNow, update: updateNow, suggestion: suggestionNow, saveMember: saveMemberNow, deleteMember: deleteMemberNow, people: peopleNow });
  rpc.current = { list: listNow, saveTask: saveTaskNow, deleteTask: deleteTaskNow, update: updateNow, suggestion: suggestionNow, saveMember: saveMemberNow, deleteMember: deleteMemberNow, people: peopleNow };

  const [members, setMembers] = useState<Member[] | null>(null);
  const [tasks, setTasks] = useState<TeamTask[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [manager, setManager] = useState<Manager | null>(null);
  const [agenda, setAgenda] = useState<AgendaItem[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void rpc.current.list({}).then((result) => {
      if (!Array.isArray(result?.members)) return;
      setMembers(result.members);
      setTasks(result.tasks);
      setSuggestions(result.suggestions);
      setManager(result.manager ?? null);
      setAgenda(result.agenda ?? []);
    }, () => undefined);
  }, []);
  useEffect(() => {
    if (!props.visible) return;
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, props.visible]);

  const fail = (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught));
  const upsert = (task: TeamTask) => setTasks((current) => [...current.filter((entry) => entry.id !== task.id), task]);
  const patch = (id: string, change: Parameters<typeof saveTaskNow>[0]) => {
    setError(null);
    void rpc.current.saveTask({ id, ...change }).then((result) => upsert(result.task), fail);
  };

  if (members === null) return null;
  const today = localDay(0);
  const openTasks = tasks.filter((task) => task.status !== "done");
  const needsYou = openTasks.filter((task) => task.status === "blocked").length + suggestions.length;

  const header = (
    <View style={{ height: 36, flexDirection: "row", alignItems: "center", gap: 6, paddingRight: 8 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={props.folded ? "Show the team" : "Team"} disabled={!props.onFold} onPress={() => props.onFold?.(!props.folded)} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="Users" size={16} color={tokens.accentText} />
        <Text style={{ fontSize: F.base, fontWeight: "600", color: tokens.foreground }}>Team</Text>
        <Text style={{ fontSize: F.base, color: tokens.foregroundMuted }}>{openTasks.length}</Text>
        {needsYou > 0 ? (
          <View style={{ paddingHorizontal: 6, height: 18, borderRadius: 9, justifyContent: "center", backgroundColor: withAlpha(tokens.status.warning, 0.18) }}>
            <Text style={{ fontSize: F.sm - 1, fontWeight: "700", color: tokens.status.warning }}>{`${needsYou} need you`}</Text>
          </View>
        ) : null}
      </Pressable>
      <View style={{ flex: 1 }} />
      {props.folded ? null : (
        <>
          <HeaderButton icon="Plus" label="Add a team task" tokens={tokens} testID="team-add" onPress={() => { setAdding((was) => !was); setManaging(false); }} />
          <HeaderButton icon="UserCog" label="Team members" tokens={tokens} testID="team-manage" onPress={() => { setManaging((was) => !was); setAdding(false); }} />
        </>
      )}
      {props.onFold ? <HeaderButton icon={props.folded ? "ChevronUp" : "ChevronDown"} label={props.folded ? "Show the team" : "Fold the team"} tokens={tokens} testID="team-fold" onPress={() => props.onFold?.(!props.folded)} /> : null}
    </View>
  );

  if (props.folded) {
    return <View testID="team-column-folded" style={{ paddingLeft: 12, borderTopWidth: 1, borderTopColor: tokens.card.border }}>{header}</View>;
  }

  const groups: Array<{ id: string | null; name: string; role: string; color: string | null; tasks: TeamTask[] }> = [
    ...members.map((member) => ({ id: member.id, name: member.name, role: member.role, color: memberColor(member, tokens.isDark), tasks: tasks.filter((task) => task.assigneeId === member.id) })),
    { id: null, name: "Unassigned", role: "", color: null, tasks: tasks.filter((task) => task.assigneeId === null || !members.some((member) => member.id === task.assigneeId)) },
  ];
  const doneCount = tasks.length - openTasks.length;

  return (
    <View testID="team-column" style={props.fill ? FILL : { flex: 1, minHeight: 0, paddingLeft: 12, paddingTop: 2, borderTopWidth: 1, borderTopColor: tokens.card.border }}>
      {header}
      {error ? <Text style={{ fontSize: F.sm, color: tokens.danger, paddingRight: 8, paddingBottom: 4 }}>{error}</Text> : null}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 8, paddingRight: 8, paddingBottom: 16 }}>
        <ManagerCard manager={manager} agenda={agenda} tokens={tokens} visible={props.visible} onChanged={refresh} />
        {managing ? (
          <MembersEditor members={members} tokens={tokens}
            search={(query) => rpc.current.people({ query })}
            onSave={(member) => { void rpc.current.saveMember(member).then(refresh, fail); }}
            onDelete={(id) => { void rpc.current.deleteMember({ id }).then(refresh, fail); }} />
        ) : null}
        {adding ? (
          <AddTask members={members} tokens={tokens} today={today}
            onAdd={(task) => { void rpc.current.saveTask(task).then((result) => upsert(result.task), fail); }}
            onClose={() => setAdding(false)} />
        ) : null}
        {suggestions.map((suggestion) => (
          <SuggestionRow key={suggestion.id} suggestion={suggestion} tokens={tokens} assignee={members.find((member) => member.id === suggestion.assigneeId)?.name ?? null}
            onAnswer={(accept) => {
              setSuggestions((current) => current.filter((entry) => entry.id !== suggestion.id));
              void rpc.current.suggestion({ id: suggestion.id, accept }).then((result) => { if (result.task) upsert(result.task); }, (caught) => { fail(caught); refresh(); });
            }} />
        ))}
        {members.length === 0 && tasks.length === 0 && !managing ? (
          <Text style={{ fontSize: F.sm, color: tokens.foregroundMuted, paddingVertical: 8 }}>
            Add your team with the people button, then add tasks with +. The team agent asks them for updates on Slack and writes the answers here.
          </Text>
        ) : null}
        {groups.map((group) => {
          const shown = sortTeamTasks(group.tasks.filter((task) => showDone || task.status !== "done"));
          if (group.id === null && shown.length === 0) return null;
          const counts = memberCounts(group.tasks, today);
          return (
            <View key={group.id ?? "none"} testID={`team-group-${group.id ?? "none"}`} style={{ gap: 4 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 2 }}>
                {group.color ? <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: group.color }} /> : null}
                <Text style={{ fontSize: F.base, fontWeight: "700", color: group.color ?? tokens.foregroundMuted }}>{group.name}</Text>
                {group.role ? <Text style={{ fontSize: F.sm, color: tokens.foregroundMuted }}>{group.role}</Text> : null}
                <View style={{ flex: 1 }} />
                <Text style={{ fontSize: F.sm, color: tokens.foregroundMuted }}>{`${counts.open} open`}</Text>
                {counts.blocked ? <Text style={{ fontSize: F.sm, fontWeight: "600", color: tokens.danger }}>{`${counts.blocked} blocked`}</Text> : null}
                {counts.overdue ? <Text style={{ fontSize: F.sm, fontWeight: "600", color: tokens.status.warning }}>{`${counts.overdue} late`}</Text> : null}
              </View>
              {shown.length === 0 ? <Text style={{ fontSize: F.sm, color: tokens.foregroundMuted }}>Nothing assigned.</Text> : null}
              {shown.map((task) => (
                <TaskRow key={task.id} task={task} tokens={tokens} today={today} members={members} open={open === task.id} tint={group.color}
                  onToggle={() => setOpen((current) => (current === task.id ? null : task.id))}
                  onPatch={(change) => patch(task.id, change)}
                  onUpdate={(text) => { void rpc.current.update({ id: task.id, text }).then((result) => upsert(result.task), fail); }}
                  onDelete={() => { setTasks((current) => current.filter((entry) => entry.id !== task.id)); void rpc.current.deleteTask({ id: task.id }).catch(fail); }} />
              ))}
            </View>
          );
        })}
        {doneCount > 0 ? (
          <Pressable accessibilityRole="button" onPress={() => setShowDone((was) => !was)} style={{ paddingVertical: 4 }}>
            <Text style={{ fontSize: F.sm, color: tokens.foregroundMuted, textDecorationLine: "underline" }}>{showDone ? "Hide done" : `Show ${doneCount} done`}</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

function HeaderButton(props: { icon: string; label: string; tokens: TaskTokens; onPress(): void; testID?: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={props.label} onPress={props.onPress} hitSlop={4} testID={props.testID}
      style={{ width: 28, height: 28, borderRadius: 6, alignItems: "center", justifyContent: "center" }}>
      <Icon name={props.icon} size={14} color={props.tokens.foregroundMuted} />
    </Pressable>
  );
}

function Chip(props: { label: string; on: boolean; tokens: TaskTokens; onPress(): void; color?: string; testID?: string }) {
  const { tokens } = props;
  const color = props.color ?? tokens.accent;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: props.on }} onPress={props.onPress} testID={props.testID}
      style={{ height: 24, paddingHorizontal: 8, borderRadius: 12, justifyContent: "center", borderWidth: 1, borderColor: props.on ? color : tokens.card.border, backgroundColor: props.on ? withAlpha(color, 0.16) : "transparent" }}>
      <Text style={{ fontSize: F.sm, color: props.on ? tokens.foreground : tokens.foregroundMuted, fontWeight: props.on ? "600" : "400" }}>{props.label}</Text>
    </Pressable>
  );
}

function dueChoices(today: string) {
  return [
    { label: "Today", value: today },
    { label: "Tomorrow", value: localDay(1) },
    { label: "Next week", value: localDay(7) },
    { label: "No date", value: null },
  ];
}

function TaskRow(props: {
  task: TeamTask;
  tokens: TaskTokens;
  today: string;
  members: Member[];
  open: boolean;
  /** The assignee's colour, as a stripe down the left edge. */
  tint: string | null;
  onToggle(): void;
  onPatch(change: { title?: string; notes?: string; assigneeId?: string | null; status?: TeamStatus; due?: string | null; topic?: string }): void;
  onUpdate(text: string): void;
  onDelete(): void;
}) {
  const { task, tokens } = props;
  const [notes, setNotes] = useState(task.notes);
  const [title, setTitle] = useState(task.title);
  const [update, setUpdate] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { setNotes(task.notes); setTitle(task.title); }, [task.notes, task.title]);
  useEffect(() => { if (!props.open) setConfirmDelete(false); }, [props.open]);
  const late = task.status !== "done" && task.due !== null && task.due < props.today;
  const last = task.updates.at(-1);
  const color = statusColor(task.status, tokens);
  const field = [{ fontSize: F.sm, color: tokens.foreground, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 6, backgroundColor: withAlpha(tokens.foreground, 0.05) }, INPUT];
  return (
    <View testID={`team-task-${task.id}`} style={{ borderRadius: 9, borderWidth: 1, borderColor: props.open ? withAlpha(props.tint ?? tokens.accent, 0.7) : tokens.card.border, backgroundColor: tokens.card.background, paddingHorizontal: 8, paddingLeft: 11, paddingVertical: 6, gap: 6, opacity: task.status === "done" && !props.open ? 0.55 : 1, overflow: "hidden" }}>
      {props.tint ? <View pointerEvents="none" testID="team-task-tint" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, backgroundColor: props.tint }} /> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={props.open ? `Close ${task.title}` : `Open ${task.title}`} onPress={props.onToggle} style={{ gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <View style={{ paddingHorizontal: 6, height: 18, borderRadius: 5, justifyContent: "center", backgroundColor: withAlpha(color, 0.16) }}>
            <Text style={{ fontSize: F.sm - 2, fontWeight: "700", color }}>{STATUS_LABEL[task.status].toUpperCase()}</Text>
          </View>
          <Text numberOfLines={props.open ? undefined : 1} style={{ flex: 1, fontSize: F.sm, color: tokens.foreground, textDecorationLine: task.status === "done" ? "line-through" : "none" }}>{task.title}</Text>
          {task.due ? <Text style={{ fontSize: F.sm - 1, fontWeight: late ? "700" : "400", color: late ? tokens.danger : tokens.foregroundMuted }}>{dueText(task.due, props.today)}</Text> : null}
        </View>
        {last && !props.open ? (
          <Text numberOfLines={1} style={{ fontSize: F.sm - 1, color: tokens.foregroundMuted, paddingLeft: 2 }}>
            {`${last.by === "slack" ? "On Slack" : last.by === "agent" ? "Agent" : "You"} · ${formatRelative(Date.now() - last.at, "en")} ago: ${last.text}`}
          </Text>
        ) : null}
      </Pressable>
      {props.open ? (
        <View style={{ gap: 7 }}>
          <TextInput value={title} onChangeText={setTitle} onBlur={() => { if (title.trim() && title.trim() !== task.title) props.onPatch({ title: title.trim() }); }} style={field} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
            {TEAM_STATUSES.map((status) => <Chip key={status} label={STATUS_LABEL[status]} on={task.status === status} color={statusColor(status, tokens)} tokens={tokens} testID={`team-status-${status}`} onPress={() => props.onPatch({ status })} />)}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
            {props.members.map((member) => <Chip key={member.id} label={member.name} on={task.assigneeId === member.id} color={memberColor(member, tokens.isDark)} tokens={tokens} onPress={() => props.onPatch({ assigneeId: task.assigneeId === member.id ? null : member.id })} />)}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
            {dueChoices(props.today).map((choice) => <Chip key={choice.label} label={choice.label} on={task.due === choice.value} tokens={tokens} onPress={() => props.onPatch({ due: choice.value })} />)}
          </View>
          <TextInput value={notes} onChangeText={setNotes} onBlur={() => { if (notes !== task.notes) props.onPatch({ notes }); }} multiline placeholder="Notes" placeholderTextColor={tokens.foregroundMuted}
            style={[...field, { minHeight: 50, textAlignVertical: "top" }]} />
          {task.links.map((link) => <LinkedText key={link} text={link} linkColor={tokens.accentText} numberOfLines={1} style={{ fontSize: F.sm }} />)}
          {task.updates.length > 0 ? (
            <View style={{ gap: 3 }}>
              {task.updates.slice(-6).map((entry, index) => (
                <Text key={index} style={{ fontSize: F.sm - 1, color: entry.by === "me" ? tokens.foregroundMuted : tokens.foreground }}>
                  <Text style={{ fontSize: F.sm - 1, fontWeight: "600", color: entry.by === "slack" ? "#7c3085" : tokens.foregroundMuted }}>{`${entry.by === "slack" ? "Slack" : entry.by === "agent" ? "Agent" : "You"} · ${formatRelative(Date.now() - entry.at, "en")} ago  `}</Text>
                  {entry.text}
                </Text>
              ))}
            </View>
          ) : null}
          <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
            <TextInput testID="team-update-input" value={update} onChangeText={setUpdate} placeholder="Add an update, press Enter" placeholderTextColor={tokens.foregroundMuted}
              onSubmitEditing={() => { if (update.trim()) { props.onUpdate(update.trim()); setUpdate(""); } }} blurOnSubmit={false} style={[...field, { flex: 1 }]} />
            <Pressable accessibilityRole="button" accessibilityLabel={confirmDelete ? "Delete the task" : "Delete"} testID="team-task-delete" onPress={() => { if (confirmDelete) props.onDelete(); else setConfirmDelete(true); }}
              style={{ height: 28, paddingHorizontal: 8, borderRadius: 6, flexDirection: "row", alignItems: "center", gap: 4, borderWidth: 1, borderColor: withAlpha(tokens.danger, 0.5) }}>
              <Icon name="Trash2" size={12} color={tokens.danger} />
              {confirmDelete ? <Text style={{ fontSize: F.sm, color: tokens.danger }}>Delete?</Text> : null}
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function AddTask(props: { members: Member[]; tokens: TaskTokens; today: string; onAdd(task: { title: string; assigneeId: string | null; due: string | null }): void; onClose(): void }) {
  const { tokens } = props;
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const add = () => {
    if (!title.trim()) return;
    props.onAdd({ title: title.trim(), assigneeId, due });
    setTitle("");
  };
  return (
    <View testID="team-add-form" style={{ padding: 8, gap: 6, borderRadius: 9, borderWidth: 1.5, borderColor: withAlpha(tokens.accent, 0.55) }}>
      <TextInput testID="team-add-title" autoFocus value={title} onChangeText={setTitle} onSubmitEditing={add} blurOnSubmit={false} placeholder="Task for the team, press Enter" placeholderTextColor={tokens.foregroundMuted}
        style={[{ fontSize: F.sm, color: tokens.foreground, height: 32, paddingHorizontal: 8, borderRadius: 6, backgroundColor: withAlpha(tokens.foreground, 0.05) }, INPUT]} />
      {props.members.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
          {props.members.map((member) => <Chip key={member.id} label={member.name} on={assigneeId === member.id} color={memberColor(member, tokens.isDark)} tokens={tokens} testID={`team-add-assignee-${member.id}`} onPress={() => setAssigneeId((current) => (current === member.id ? null : member.id))} />)}
        </View>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        {dueChoices(props.today).map((choice) => <Chip key={choice.label} label={choice.label} on={due === choice.value} tokens={tokens} onPress={() => setDue(choice.value)} />)}
        <View style={{ flex: 1 }} />
        <Pressable accessibilityRole="button" onPress={props.onClose} hitSlop={4}><Text style={{ fontSize: F.sm, color: tokens.foregroundMuted }}>Close</Text></Pressable>
      </View>
    </View>
  );
}

function SuggestionRow(props: { suggestion: Suggestion; tokens: TaskTokens; assignee: string | null; onAnswer(accept: boolean): void }) {
  const { suggestion, tokens } = props;
  return (
    <View testID={`team-suggestion-${suggestion.id}`} style={{ padding: 8, gap: 5, borderRadius: 9, borderWidth: 1, borderColor: withAlpha("#7c3085", 0.6), backgroundColor: withAlpha("#7c3085", 0.08) }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="Slack" size={12} color="#7c3085" />
        <Text style={{ fontSize: F.sm - 1, color: tokens.foregroundMuted }}>{`Suggested from Slack${suggestion.from ? ` · ${suggestion.from}` : ""}${props.assignee ? ` · for ${props.assignee}` : ""}`}</Text>
      </View>
      <Text style={{ fontSize: F.sm, fontWeight: "600", color: tokens.foreground }}>{suggestion.title}</Text>
      {suggestion.notes ? <Text numberOfLines={3} style={{ fontSize: F.sm - 1, color: tokens.foregroundMuted }}>{suggestion.notes}</Text> : null}
      <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
        <Pressable accessibilityRole="button" testID="team-suggestion-accept" onPress={() => props.onAnswer(true)} style={{ height: 26, paddingHorizontal: 10, borderRadius: 6, flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: tokens.accent }}>
          <Icon name="Check" size={12} color="#ffffff" />
          <Text style={{ fontSize: F.sm, fontWeight: "600", color: "#ffffff" }}>Add task</Text>
        </Pressable>
        <Pressable accessibilityRole="button" testID="team-suggestion-dismiss" onPress={() => props.onAnswer(false)} style={{ height: 26, paddingHorizontal: 10, borderRadius: 6, justifyContent: "center", borderWidth: 1, borderColor: tokens.card.border }}>
          <Text style={{ fontSize: F.sm, color: tokens.foreground }}>Dismiss</Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        {suggestion.permalink ? (
          <Pressable accessibilityRole="link" onPress={() => openLink(suggestion.permalink)}><Text style={{ fontSize: F.sm - 1, color: tokens.accentText, textDecorationLine: "underline" }}>Open in Slack</Text></Pressable>
        ) : null}
      </View>
    </View>
  );
}

function MembersEditor(props: {
  members: Member[];
  tokens: TaskTokens;
  search(query: string): Promise<{ people: Array<{ id: string; name: string; title: string }>; error: string | null }>;
  onSave(member: { id?: string; name: string; slackUserId?: string | null; role?: string }): void;
  onDelete(id: string): void;
}) {
  const { tokens } = props;
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<Array<{ id: string; name: string; title: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const search = useRef(props.search);
  search.current = props.search;
  useEffect(() => {
    const words = query.trim();
    if (words.length < 2) { setPeople([]); return; }
    const timer = setTimeout(() => {
      void search.current(words).then((result) => { setPeople(result.people); setError(result.error); }, (caught: unknown) => setError(String(caught)));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  const linked = new Set(props.members.map((member) => member.slackUserId).filter(Boolean));
  return (
    <View testID="team-members" style={{ padding: 8, gap: 6, borderRadius: 9, borderWidth: 1, borderColor: tokens.card.border }}>
      <Text style={{ fontSize: F.sm, fontWeight: "600", color: tokens.foreground }}>Team members</Text>
      {props.members.map((member) => (
        <View key={member.id} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: memberColor(member, tokens.isDark) }} />
          <Icon name={member.slackUserId ? "Slack" : "User"} size={12} color={member.slackUserId ? "#7c3085" : tokens.foregroundMuted} />
          <Text style={{ flex: 1, fontSize: F.sm, color: tokens.foreground }}>{member.name}{member.role ? `  · ${member.role}` : ""}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${member.name}`} onPress={() => { if (removing === member.id) props.onDelete(member.id); else setRemoving(member.id); }} hitSlop={4}>
            <Text style={{ fontSize: F.sm - 1, color: tokens.danger }}>{removing === member.id ? "Remove?" : "Remove"}</Text>
          </Pressable>
        </View>
      ))}
      <TextInput testID="team-member-search" value={query} onChangeText={setQuery} placeholder="Add someone: type their name" placeholderTextColor={tokens.foregroundMuted}
        onSubmitEditing={() => { if (query.trim() && people.length === 0) { props.onSave({ name: query.trim() }); setQuery(""); } }}
        style={[{ fontSize: F.sm, color: tokens.foreground, height: 30, paddingHorizontal: 8, borderRadius: 6, backgroundColor: withAlpha(tokens.foreground, 0.05) }, INPUT]} />
      {people.filter((person) => !linked.has(person.id)).map((person) => (
        <Pressable key={person.id} accessibilityRole="button" onPress={() => { props.onSave({ name: person.name, slackUserId: person.id, role: person.title }); setQuery(""); }}
          style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 3 }}>
          <Icon name="Plus" size={12} color={tokens.accentText} />
          <Text style={{ fontSize: F.sm, color: tokens.foreground }}>{person.name}</Text>
          {person.title ? <Text numberOfLines={1} style={{ flex: 1, fontSize: F.sm - 1, color: tokens.foregroundMuted }}>{person.title}</Text> : null}
        </Pressable>
      ))}
      {error ? <Text style={{ fontSize: F.sm - 1, color: tokens.danger }}>{error}</Text> : null}
      {query.trim().length >= 2 && people.length === 0 && !error ? (
        <Text style={{ fontSize: F.sm - 1, color: tokens.foregroundMuted }}>No Slack match: press Enter to add them by name only.</Text>
      ) : null}
    </View>
  );
}
