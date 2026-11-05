import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View, type TextStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { withAlpha } from "../../components/theme-tokens";
import { openLink } from "../../components/open-link";
import { TaskText as Text, HOST_FONT as F } from "../typography";
import { taskTokens, type TaskTokens } from "../cards/tokens";
import { LinkedText } from "../cards/linked-text";
import { keysChanged } from "./keys-events";
import { type CalendarStatus, type Meeting, calendarConnectRpc, calendarTodayRpc } from "../../../shared/calendar-rpc";
import { type Member, type TeamTask, memberColor, teamListRpc } from "../../../shared/team-rpc";

const POLL_MS = 2 * 60_000;
const TICK_MS = 30_000;
const INPUT = { outlineStyle: "none" } as unknown as TextStyle;
const HOUR = 3_600_000;

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function dayBounds(now: number): { start: number; end: number } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return { start: start.getTime(), end: start.getTime() + 24 * HOUR };
}

/** The meeting on now, else the next one today or tomorrow; all-day ones never count. */
export function currentOrNext(meetings: Meeting[], now: number): { meeting: Meeting; now: boolean } | null {
  const timed = meetings.filter((meeting) => !meeting.allDay && meeting.end > now);
  const on = timed.find((meeting) => meeting.start <= now);
  if (on) return { meeting: on, now: true };
  return timed[0] ? { meeting: timed[0], now: false } : null;
}

/** "In 12 min", "In 1 h 20", or tomorrow's time. */
export function untilText(start: number, now: number): string {
  const minutes = Math.max(0, Math.round((start - now) / 60_000));
  if (start >= dayBounds(now).end) return `Tomorrow ${clock(start)}`;
  if (minutes < 60) return `In ${minutes} min`;
  return `In ${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60}` : ""}`;
}

/** The team member a meeting is with, by name or by the email's first part. */
export function memberIn(meeting: Meeting, members: Member[]): Member | null {
  for (const member of members) {
    const full = member.name.toLowerCase().trim();
    const first = full.split(/\s+/)[0] ?? "";
    for (const attendee of meeting.attendees) {
      const name = attendee.name.toLowerCase();
      const local = attendee.email.split("@")[0] ?? "";
      if ((full && name.includes(full)) || (first.length >= 3 && (name.split(/\s+/)[0] === first || local.startsWith(first)))) return member;
    }
  }
  return null;
}

/** Side-by-side rows for overlapping meetings: each gets the first row free at its start (at most 3). */
export function stackRows(meetings: Meeting[]): Map<string, { row: number; rows: number }> {
  const out = new Map<string, { row: number; rows: number }>();
  let group: Meeting[] = [];
  let groupEnd = 0;
  const close = () => {
    const ends: number[] = [];
    const rows = new Map<string, number>();
    for (const meeting of group) {
      let row = ends.findIndex((end) => end <= meeting.start);
      if (row < 0) { row = ends.length; ends.push(meeting.end); } else ends[row] = meeting.end;
      rows.set(meeting.id, Math.min(row, 2));
    }
    const count = Math.min(Math.max(ends.length, 1), 3);
    for (const meeting of group) out.set(meeting.id, { row: rows.get(meeting.id)!, rows: count });
    group = [];
  };
  for (const meeting of meetings) {
    if (group.length && meeting.start >= groupEnd) close();
    group.push(meeting);
    groupEnd = Math.max(groupEnd, meeting.end);
  }
  if (group.length) close();
  return out;
}

function useCalendar(visible: boolean) {
  const todayNow = useRpc(calendarTodayRpc);
  const teamNow = useRpc(teamListRpc);
  const rpc = useRef({ today: todayNow, team: teamNow });
  rpc.current = { today: todayNow, team: teamNow };
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [team, setTeam] = useState<{ members: Member[]; tasks: TeamTask[] }>({ members: [], tasks: [] });
  const [now, setNow] = useState(Date.now());
  const refresh = useCallback((force = false) => {
    void rpc.current.today(force ? { refresh: true } : {}).then((result) => {
      if (!result?.status) return;
      setStatus(result.status);
      setMeetings(Array.isArray(result.meetings) ? result.meetings : []);
    }, () => undefined);
    void rpc.current.team({}).then((result) => { if (Array.isArray(result?.members)) setTeam({ members: result.members, tasks: result.tasks }); }, () => undefined);
  }, []);
  useEffect(() => {
    if (!visible) return;
    refresh();
    const poll = setInterval(refresh, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [visible, refresh]);
  return { status, meetings, team, now, refresh };
}

/**
 * Today's meetings as a thin timeline across the top of the board, with the
 * meeting on now or next and its Join link. Read from the calendar's private
 * iCal address, kept in the Keys panel.
 */
export function TodayStrip(props: { theme: PluginTheme; visible: boolean }) {
  const tokens = taskTokens(props.theme);
  const { status, meetings, team, now, refresh } = useCalendar(props.visible);
  const [folded, setFolded] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [picked, setPicked] = useState<Meeting | null>(null);
  if (status === null || hidden) return null;
  if (!status.connected) return <ConnectStrip tokens={tokens} onConnected={() => refresh(true)} onHide={() => setHidden(true)} />;

  const { start: dayStart, end: dayEnd } = dayBounds(now);
  const today = meetings.filter((meeting) => meeting.start < dayEnd && meeting.end > dayStart);
  const timed = today.filter((meeting) => !meeting.allDay);
  const allDay = today.filter((meeting) => meeting.allDay);
  const focus = currentOrNext(meetings, now);
  const colorOf = (meeting: Meeting) => {
    const member = memberIn(meeting, team.members);
    return member ? memberColor(member, tokens.isDark) : tokens.accent;
  };

  const next = focus ? (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 }}>
      <Pressable accessibilityRole="button" onPress={() => setPicked(focus.meeting)} style={{ flexShrink: 1 }}>
        <Text numberOfLines={1} style={{ fontSize: F.sm, color: tokens.foreground }}>
          <Text style={{ fontSize: F.sm, fontWeight: "700", color: focus.now ? tokens.success : tokens.status.warning }}>{focus.now ? `Now · until ${clock(focus.meeting.end)}` : untilText(focus.meeting.start, now)}</Text>
          {`  ${focus.meeting.title}`}
        </Text>
      </Pressable>
      {focus.meeting.joinUrl ? <JoinButton url={focus.meeting.joinUrl} tokens={tokens} /> : null}
    </View>
  ) : <Text style={{ fontSize: F.sm, color: tokens.foregroundMuted }}>No more meetings today</Text>;

  return (
    <View testID="today-strip" style={{ marginHorizontal: 12, marginBottom: 6, borderRadius: 10, borderWidth: 1, borderColor: tokens.card.border, backgroundColor: tokens.card.background, paddingHorizontal: 10, paddingVertical: folded ? 4 : 6, gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Icon name="CalendarDays" size={14} color={tokens.accentText} />
        <Text style={{ fontSize: F.sm, fontWeight: "700", color: tokens.foreground }}>Today</Text>
        <Text style={{ fontSize: F.sm, color: tokens.foregroundMuted }}>{`${timed.length} meeting${timed.length === 1 ? "" : "s"}`}</Text>
        {allDay.map((meeting) => (
          <Pressable key={meeting.id} accessibilityRole="button" onPress={() => setPicked(meeting)} style={{ paddingHorizontal: 6, height: 18, borderRadius: 9, justifyContent: "center", backgroundColor: withAlpha(tokens.accent, 0.14) }}>
            <Text numberOfLines={1} style={{ fontSize: F.sm - 1, color: tokens.accentText }}>{meeting.title}</Text>
          </Pressable>
        ))}
        <View style={{ flex: 1 }} />
        {next}
        {status.error ? <Icon name="TriangleAlert" size={13} color={tokens.danger} /> : null}
        <Pressable accessibilityRole="button" accessibilityLabel={folded ? "Show the timeline" : "Fold the timeline"} testID="today-fold" onPress={() => setFolded((was) => !was)} hitSlop={6}>
          <Icon name={folded ? "ChevronDown" : "ChevronUp"} size={14} color={tokens.foregroundMuted} />
        </Pressable>
      </View>
      {folded ? null : <Timeline meetings={timed} now={now} tokens={tokens} colorOf={colorOf} onPick={setPicked} />}
      {status.error && !folded ? <Text style={{ fontSize: F.sm - 1, color: tokens.danger }}>{status.error}</Text> : null}
      <Modal title={picked?.title ?? ""} open={picked !== null} onOpenChange={(open) => !open && setPicked(null)}>
        <Modal.Content>
          {picked ? <MeetingDetails meeting={picked} tokens={tokens} team={team} now={now} /> : null}
        </Modal.Content>
      </Modal>
    </View>
  );
}

function Timeline(props: { meetings: Meeting[]; now: number; tokens: TaskTokens; colorOf(meeting: Meeting): string; onPick(meeting: Meeting): void }) {
  const { meetings, now, tokens } = props;
  const { start: dayStart } = dayBounds(now);
  const firstHour = Math.min(8, ...meetings.map((meeting) => new Date(Math.max(meeting.start, dayStart)).getHours()));
  const lastHour = Math.max(19, ...meetings.map((meeting) => Math.min(24, Math.ceil((meeting.end - dayStart) / HOUR))));
  const from = dayStart + firstHour * HOUR;
  const span = (lastHour - firstHour) * HOUR;
  const pct = (ms: number) => Math.max(0, Math.min(100, ((ms - from) / span) * 100));
  const at = (ms: number) => `${pct(ms)}%`;
  const rows = stackRows(meetings);
  const hours = Array.from({ length: lastHour - firstHour + 1 }, (_, index) => firstHour + index);
  const BAR = 26;
  return (
    <View testID="today-timeline" style={{ height: 14 + BAR }}>
      {hours.map((hour) => (
        <View key={hour} pointerEvents="none" style={{ position: "absolute", left: at(dayStart + hour * HOUR) as never, top: 0, bottom: 0, borderLeftWidth: 1, borderLeftColor: withAlpha(tokens.foreground, 0.07) }}>
          <Text style={{ fontSize: 9, color: tokens.foregroundMuted, marginLeft: 2 }}>{String(hour % 24).padStart(2, "0")}</Text>
        </View>
      ))}
      {meetings.map((meeting) => {
        const place = rows.get(meeting.id) ?? { row: 0, rows: 1 };
        const height = BAR / place.rows;
        const color = props.colorOf(meeting);
        const past = meeting.end <= now;
        const tentative = meeting.myStatus === "tentative" || meeting.myStatus === "needs-action";
        return (
          <Pressable key={meeting.id} accessibilityRole="button" accessibilityLabel={`${clock(meeting.start)} ${meeting.title}`} testID="today-meeting" onPress={() => props.onPick(meeting)}
            style={{
              position: "absolute", left: at(meeting.start) as never, width: `${Math.max(0.4, pct(meeting.end) - pct(meeting.start) - 0.15)}%` as never,
              minWidth: 6, top: 14 + place.row * height, height: height - 2, borderRadius: 5, paddingHorizontal: 5, justifyContent: "center", overflow: "hidden",
              backgroundColor: withAlpha(color, past ? 0.12 : 0.26), borderWidth: 1, borderStyle: tentative ? "dashed" : "solid", borderColor: withAlpha(color, past ? 0.3 : 0.75),
            }}>
            <Text numberOfLines={1} style={{ fontSize: place.rows > 1 ? 9 : F.sm - 2, fontWeight: "600", color: past ? tokens.foregroundMuted : tokens.foreground }}>{meeting.title}</Text>
          </Pressable>
        );
      })}
      {now >= from && now <= from + span ? (
        <View pointerEvents="none" testID="today-now" style={{ position: "absolute", left: at(now) as never, top: 10, bottom: 0, width: 2, borderRadius: 1, backgroundColor: tokens.danger }} />
      ) : null}
    </View>
  );
}

function JoinButton(props: { url: string; tokens: TaskTokens }) {
  return (
    <Pressable accessibilityRole="link" accessibilityLabel="Join the meeting" testID="today-join" onPress={() => openLink(props.url)}
      style={{ height: 24, paddingHorizontal: 9, borderRadius: 6, flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: props.tokens.success }}>
      <Icon name="Video" size={12} color="#ffffff" />
      <Text style={{ fontSize: F.sm - 1, fontWeight: "700", color: "#ffffff" }}>Join</Text>
    </Pressable>
  );
}

function MeetingDetails(props: { meeting: Meeting; tokens: TaskTokens; team: { members: Member[]; tasks: TeamTask[] }; now: number }) {
  const { meeting, tokens } = props;
  const member = memberIn(meeting, props.team.members);
  const theirs = member ? props.team.tasks.filter((task) => task.assigneeId === member.id && task.status !== "done") : [];
  return (
    <View style={{ gap: 10, paddingBottom: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text style={{ fontSize: F.base, color: tokens.foreground }}>{meeting.allDay ? "All day" : `${clock(meeting.start)} – ${clock(meeting.end)}`}</Text>
        {meeting.myStatus && meeting.myStatus !== "accepted" ? <Text style={{ fontSize: F.sm, color: tokens.status.warning }}>{meeting.myStatus === "tentative" ? "Maybe" : "Not answered"}</Text> : null}
        <View style={{ flex: 1 }} />
        {meeting.joinUrl ? <JoinButton url={meeting.joinUrl} tokens={tokens} /> : null}
      </View>
      {meeting.location && meeting.location !== meeting.joinUrl ? <LinkedText text={meeting.location} linkColor={tokens.accentText} style={{ fontSize: F.sm, color: tokens.foregroundMuted }} /> : null}
      {member ? (
        <View testID="today-member-tasks" style={{ gap: 4, padding: 8, borderRadius: 8, borderWidth: 1, borderColor: withAlpha(memberColor(member, tokens.isDark), 0.6) }}>
          <Text style={{ fontSize: F.sm, fontWeight: "700", color: memberColor(member, tokens.isDark) }}>{`${member.name}'s open tasks (${theirs.length})`}</Text>
          {theirs.length === 0 ? <Text style={{ fontSize: F.sm, color: tokens.foregroundMuted }}>Nothing open.</Text> : null}
          {theirs.slice(0, 8).map((task) => (
            <Text key={task.id} numberOfLines={2} style={{ fontSize: F.sm, color: tokens.foreground }}>
              <Text style={{ fontSize: F.sm, fontWeight: "700", color: task.status === "blocked" ? tokens.danger : tokens.foregroundMuted }}>{`${task.status.toUpperCase()}  `}</Text>
              {task.title}
              {task.updates.at(-1) ? <Text style={{ fontSize: F.sm, color: tokens.foregroundMuted }}>{`  — ${task.updates.at(-1)!.text}`}</Text> : null}
            </Text>
          ))}
        </View>
      ) : null}
      {meeting.attendees.length > 0 ? (
        <View style={{ gap: 2 }}>
          <Text style={{ fontSize: F.sm, fontWeight: "600", color: tokens.foreground }}>{`With ${meeting.attendees.length}`}</Text>
          <Text style={{ fontSize: F.sm, color: tokens.foregroundMuted }}>{meeting.attendees.map((attendee) => `${attendee.name || attendee.email}${attendee.status === "declined" ? " (no)" : attendee.status === "tentative" ? " (maybe)" : ""}`).join(", ")}</Text>
        </View>
      ) : null}
      {meeting.description ? <LinkedText text={meeting.description} linkColor={tokens.accentText} style={{ fontSize: F.sm, color: tokens.foreground }} /> : null}
    </View>
  );
}

function ConnectStrip(props: { tokens: TaskTokens; onConnected(): void; onHide(): void }) {
  const { tokens } = props;
  const connectNow = useRpc(calendarConnectRpc);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    void connectNow({ url: url.trim() }).then((result) => {
      if (result.ok) { setUrl(""); keysChanged(); props.onConnected(); } else setError(result.error);
    }, (caught: unknown) => setError(String(caught))).finally(() => setBusy(false));
  };
  return (
    <View testID="today-connect" style={{ marginHorizontal: 12, marginBottom: 6, borderRadius: 10, borderWidth: 1, borderStyle: "dashed", borderColor: tokens.card.border, paddingHorizontal: 10, paddingVertical: 6, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="CalendarDays" size={14} color={tokens.foregroundMuted} />
        <Text style={{ fontSize: F.sm, color: tokens.foregroundMuted }}>See today's meetings here</Text>
        <Pressable accessibilityRole="button" testID="today-connect-open" onPress={() => setOpen((was) => !was)}><Text style={{ fontSize: F.sm, fontWeight: "600", color: tokens.accentText }}>Connect your calendar</Text></Pressable>
        <View style={{ flex: 1 }} />
        <Pressable accessibilityRole="button" accessibilityLabel="Hide until the board reopens" onPress={props.onHide} hitSlop={6}><Icon name="X" size={13} color={tokens.foregroundMuted} /></Pressable>
      </View>
      {open ? (
        <View style={{ gap: 6 }}>
          <Text style={{ fontSize: F.sm - 1, color: tokens.foregroundMuted }}>
            Google Calendar → Settings (gear) → your calendar under "Settings for my calendars" → Integrate calendar → copy "Secret address in iCal format". It is kept in your Mac's Keychain (Keys panel).
          </Text>
          <View style={{ flexDirection: "row", gap: 6 }}>
            <TextInput testID="today-connect-url" value={url} onChangeText={setUrl} onSubmitEditing={connect} secureTextEntry autoCapitalize="none" autoCorrect={false}
              placeholder="https://calendar.google.com/calendar/ical/…/private-…/basic.ics" placeholderTextColor={tokens.foregroundMuted}
              style={[{ flex: 1, height: 30, paddingHorizontal: 8, borderRadius: 6, fontSize: F.sm, color: tokens.foreground, backgroundColor: withAlpha(tokens.foreground, 0.05) }, INPUT]} />
            <Pressable accessibilityRole="button" testID="today-connect-save" disabled={busy || !url.trim()} onPress={connect}
              style={{ height: 30, paddingHorizontal: 12, borderRadius: 6, justifyContent: "center", backgroundColor: tokens.accent, opacity: busy || !url.trim() ? 0.5 : 1 }}>
              <Text style={{ fontSize: F.sm, fontWeight: "600", color: "#ffffff" }}>{busy ? "Reading…" : "Connect"}</Text>
            </Pressable>
          </View>
          {error ? <Text style={{ fontSize: F.sm - 1, color: tokens.danger }}>{error}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

/** The phone: one line with the meeting on now or next; a tap lists the day. */
export function PhoneToday(props: { theme: PluginTheme; visible: boolean }) {
  const tokens = taskTokens(props.theme);
  const { status, meetings, team, now } = useCalendar(props.visible);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Meeting | null>(null);
  if (!status?.connected) return null;
  const focus = currentOrNext(meetings, now);
  const { end: dayEnd } = dayBounds(now);
  const today = meetings.filter((meeting) => meeting.start < dayEnd);
  return (
    <>
      <Pressable accessibilityRole="button" testID="phone-today" onPress={() => setOpen(true)} style={{ marginHorizontal: 8, marginTop: 6, minHeight: 34, paddingHorizontal: 10, borderRadius: 8, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: tokens.card.background, borderWidth: 1, borderColor: tokens.card.border }}>
        <Icon name="CalendarDays" size={14} color={tokens.accentText} />
        <Text numberOfLines={1} style={{ flex: 1, fontSize: F.sm, color: tokens.foreground }}>
          {focus ? <Text style={{ fontSize: F.sm, fontWeight: "700", color: focus.now ? tokens.success : tokens.status.warning }}>{focus.now ? "Now  " : `${untilText(focus.meeting.start, now)}  `}</Text> : null}
          {focus ? focus.meeting.title : "No more meetings today"}
        </Text>
        {focus?.meeting.joinUrl ? <JoinButton url={focus.meeting.joinUrl} tokens={tokens} /> : null}
      </Pressable>
      <Modal title="Today" open={open} onOpenChange={setOpen}>
        <Modal.Content>
          <ScrollView contentContainerStyle={{ gap: 6, paddingBottom: 12 }}>
            {picked ? (
              <>
                <Pressable accessibilityRole="button" onPress={() => setPicked(null)}><Text style={{ fontSize: F.sm, color: tokens.accentText }}>‹ All meetings</Text></Pressable>
                <Text style={{ fontSize: F.base, fontWeight: "700", color: tokens.foreground }}>{picked.title}</Text>
                <MeetingDetails meeting={picked} tokens={tokens} team={team} now={now} />
              </>
            ) : today.map((meeting) => (
              <Pressable key={meeting.id} accessibilityRole="button" onPress={() => setPicked(meeting)} style={{ flexDirection: "row", alignItems: "center", gap: 10, padding: 8, borderRadius: 8, borderWidth: 1, borderColor: tokens.card.border, opacity: meeting.end <= now ? 0.5 : 1 }}>
                <Text style={{ width: 92, fontSize: F.sm, color: tokens.foregroundMuted }}>{meeting.allDay ? "All day" : `${clock(meeting.start)}–${clock(meeting.end)}`}</Text>
                <Text numberOfLines={1} style={{ flex: 1, fontSize: F.sm, color: tokens.foreground }}>{meeting.title}</Text>
                {meeting.joinUrl && meeting.end > now ? <JoinButton url={meeting.joinUrl} tokens={tokens} /> : null}
              </Pressable>
            ))}
          </ScrollView>
        </Modal.Content>
      </Modal>
    </>
  );
}
