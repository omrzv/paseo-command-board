import React, { useEffect, useRef, useState } from "react";
import { Pressable, TextInput, View, type TextStyle } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { withAlpha } from "../../components/theme-tokens";
import { openLink } from "../../components/open-link";
import { TaskText as Text, HOST_FONT as F } from "../typography";
import type { TaskTokens } from "../cards/tokens";
import { type AgendaItem, type Manager, teamAgendaRpc, teamSetManagerRpc, teamSlackPeopleRpc } from "../../../shared/team-rpc";
import { type SlackItem, slackInboxRpc } from "../../../shared/slack-rpc";
import { type Meeting, calendarTodayRpc } from "../../../shared/calendar-rpc";
import { clock, memberIn, untilText } from "./today-strip";

const INPUT = { outlineStyle: "none" } as unknown as TextStyle;
/** The manager's colour: gold, apart from the team's ten. */
const MANAGER_COLOR = "#e0a526";

/** Slack items your manager wrote, by their first name. */
export function fromManager(items: SlackItem[], manager: Manager): SlackItem[] {
  const first = manager.name.toLowerCase().split(/\s+/)[0] ?? "";
  if (first.length < 2) return [];
  return items.filter((item) => item.state === "open" && item.from.toLowerCase().split(/\s+/)[0] === first);
}

/**
 * A small area for your manager at the top of the Team panel: what they
 * asked you on Slack, your next meeting with them, and points to raise.
 */
export function ManagerCard(props: { manager: Manager | null; agenda: AgendaItem[]; tokens: TaskTokens; visible: boolean; onChanged(): void }) {
  const { tokens, manager } = props;
  const setManagerNow = useRpc(teamSetManagerRpc);
  const agendaNow = useRpc(teamAgendaRpc);
  const inboxNow = useRpc(slackInboxRpc);
  const calendarNow = useRpc(calendarTodayRpc);
  const rpc = useRef({ setManager: setManagerNow, agenda: agendaNow, inbox: inboxNow, calendar: calendarNow });
  rpc.current = { setManager: setManagerNow, agenda: agendaNow, inbox: inboxNow, calendar: calendarNow };
  const [agenda, setAgenda] = useState(props.agenda);
  const [asks, setAsks] = useState<SlackItem[]>([]);
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [draft, setDraft] = useState("");
  const [folded, setFolded] = useState(false);
  const [choosing, setChoosing] = useState(false);
  useEffect(() => { setAgenda(props.agenda); }, [props.agenda]);

  useEffect(() => {
    if (!manager || !props.visible) return;
    const read = () => {
      void rpc.current.inbox({}).then((result) => setAsks(Array.isArray(result?.items) ? fromManager(result.items, manager) : []), () => undefined);
      void rpc.current.calendar({}).then((result) => {
        const now = Date.now();
        const theirs = (result?.meetings ?? []).filter((entry) => !entry.allDay && entry.end > now && memberIn(entry, [{ id: "manager", name: manager.name, slackUserId: null, role: "", colorIndex: null }]));
        setMeeting(theirs[0] ?? null);
      }, () => undefined);
    };
    read();
    const timer = setInterval(read, 2 * 60_000);
    return () => clearInterval(timer);
  }, [manager, props.visible]);

  if (!manager || choosing) {
    return <ChooseManager tokens={tokens} current={manager} onCancel={manager ? () => setChoosing(false) : undefined}
      onPick={(next) => { void rpc.current.setManager({ manager: next }).then(() => { setChoosing(false); props.onChanged(); }); }} />;
  }

  const open = agenda.filter((item) => !item.done);
  const change = (input: Parameters<typeof agendaNow>[0]) => { void rpc.current.agenda(input).then((result) => setAgenda(result.agenda), () => undefined); };
  const add = () => { if (draft.trim()) { change({ op: "add", text: draft.trim() }); setDraft(""); } };

  return (
    <View testID="manager-card" style={{ borderRadius: 9, borderWidth: 1, borderColor: withAlpha(MANAGER_COLOR, 0.55), backgroundColor: withAlpha(MANAGER_COLOR, tokens.isDark ? 0.07 : 0.05), paddingHorizontal: 8, paddingVertical: 6, gap: 5 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
        <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: MANAGER_COLOR }} />
        <Pressable accessibilityRole="button" onPress={() => setFolded((was) => !was)} style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
          <Text style={{ fontSize: F.base, fontWeight: "700", color: MANAGER_COLOR }}>{manager.name}</Text>
          <Text style={{ fontSize: F.sm - 1, color: tokens.foregroundMuted }}>manager</Text>
        </Pressable>
        {asks.length ? <Text style={{ fontSize: F.sm - 1, fontWeight: "700", color: tokens.status.warning }}>{`${asks.length} asked you`}</Text> : null}
        {open.length ? <Text style={{ fontSize: F.sm - 1, color: tokens.foregroundMuted }}>{`${open.length} to raise`}</Text> : null}
        <View style={{ flex: 1 }} />
        {meeting ? (
          <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: F.sm - 1, color: tokens.foreground }}>
            <Text style={{ fontSize: F.sm - 1, fontWeight: "700", color: meeting.start <= Date.now() ? tokens.success : tokens.accentText }}>{meeting.start <= Date.now() ? "Now" : untilText(meeting.start, Date.now())}</Text>
            {`  ${meeting.title}`}
          </Text>
        ) : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Change manager" onPress={() => setChoosing(true)} hitSlop={4}><Icon name="Pencil" size={11} color={tokens.foregroundMuted} /></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={folded ? "Show" : "Fold"} testID="manager-fold" onPress={() => setFolded((was) => !was)} hitSlop={4}>
          <Icon name={folded ? "ChevronDown" : "ChevronUp"} size={13} color={tokens.foregroundMuted} />
        </Pressable>
      </View>
      {folded ? null : (
        <>
          {asks.slice(0, 3).map((item) => (
            <Pressable key={item.id} accessibilityRole="link" onPress={() => openLink(item.permalink)} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 2 }}>
              <Icon name="Slack" size={11} color="#7c3085" />
              <Text numberOfLines={1} style={{ flex: 1, fontSize: F.sm, color: tokens.foreground }}>{item.title}</Text>
            </Pressable>
          ))}
          {meeting ? <Text style={{ fontSize: F.sm - 1, color: tokens.foregroundMuted, paddingLeft: 2 }}>{`Next meeting: ${clock(meeting.start)} ${meeting.title}`}</Text> : null}
          {agenda.map((item) => (
            <View key={item.id} style={{ flexDirection: "row", alignItems: "center", gap: 7, paddingLeft: 2 }}>
              <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: item.done }} onPress={() => change({ op: "toggle", id: item.id })} hitSlop={5}
                style={{ width: 15, height: 15, borderRadius: 4, borderWidth: 1.5, borderColor: item.done ? tokens.success : tokens.foregroundMuted, backgroundColor: item.done ? tokens.success : "transparent", alignItems: "center", justifyContent: "center" }}>
                {item.done ? <Icon name="Check" size={10} color="#ffffff" /> : null}
              </Pressable>
              <Text style={{ flex: 1, fontSize: F.sm, color: item.done ? tokens.foregroundMuted : tokens.foreground, textDecorationLine: item.done ? "line-through" : "none" }}>{item.text}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Delete" onPress={() => change({ op: "delete", id: item.id })} hitSlop={5}><Icon name="X" size={11} color={tokens.foregroundMuted} /></Pressable>
            </View>
          ))}
          <TextInput testID="manager-agenda-input" value={draft} onChangeText={setDraft} onSubmitEditing={add} blurOnSubmit={false}
            placeholder={`Something to raise with ${manager.name.split(/\s+/)[0]}, press Enter`} placeholderTextColor={tokens.foregroundMuted}
            style={[{ height: 28, paddingHorizontal: 8, borderRadius: 6, fontSize: F.sm, color: tokens.foreground, backgroundColor: withAlpha(tokens.foreground, 0.05) }, INPUT]} />
        </>
      )}
    </View>
  );
}

function ChooseManager(props: { tokens: TaskTokens; current: Manager | null; onPick(manager: Manager): void; onCancel?(): void }) {
  const { tokens } = props;
  const peopleNow = useRpc(teamSlackPeopleRpc);
  const search = useRef(peopleNow);
  search.current = peopleNow;
  const [query, setQuery] = useState(props.current?.name ?? "Uri");
  const [people, setPeople] = useState<Array<{ id: string; name: string; title: string }>>([]);
  useEffect(() => {
    if (query.trim().length < 2) { setPeople([]); return; }
    const timer = setTimeout(() => { void search.current({ query: query.trim() }).then((result) => setPeople(result.people ?? []), () => setPeople([])); }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  return (
    <View testID="manager-choose" style={{ borderRadius: 9, borderWidth: 1, borderStyle: "dashed", borderColor: withAlpha(MANAGER_COLOR, 0.6), padding: 8, gap: 5 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: MANAGER_COLOR }} />
        <Text style={{ flex: 1, fontSize: F.sm, fontWeight: "600", color: tokens.foreground }}>Your manager</Text>
        {props.onCancel ? <Pressable accessibilityRole="button" onPress={props.onCancel}><Text style={{ fontSize: F.sm - 1, color: tokens.foregroundMuted }}>Cancel</Text></Pressable> : null}
      </View>
      <TextInput testID="manager-search" value={query} onChangeText={setQuery} placeholder="Their name" placeholderTextColor={tokens.foregroundMuted}
        onSubmitEditing={() => { if (query.trim() && people.length === 0) props.onPick({ name: query.trim(), slackUserId: null }); }}
        style={[{ height: 28, paddingHorizontal: 8, borderRadius: 6, fontSize: F.sm, color: tokens.foreground, backgroundColor: withAlpha(tokens.foreground, 0.05) }, INPUT]} />
      {people.map((person) => (
        <Pressable key={person.id} accessibilityRole="button" testID="manager-pick" onPress={() => props.onPick({ name: person.name, slackUserId: person.id })} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2 }}>
          <Icon name="Plus" size={12} color={tokens.accentText} />
          <Text style={{ fontSize: F.sm, color: tokens.foreground }}>{person.name}</Text>
          {person.title ? <Text numberOfLines={1} style={{ flex: 1, fontSize: F.sm - 1, color: tokens.foregroundMuted }}>{person.title}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}
