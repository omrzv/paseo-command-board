import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View, type TextStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { withAlpha } from "../../components/theme-tokens";
import { openLink } from "../../components/open-link";
import { TaskText as Text, HOST_FONT as F } from "../typography";
import { taskTokens, type TaskTokens } from "../cards/tokens";
import { formatRelative } from "../cards/format";
import {
  type SlackItem,
  type SlackStatus,
  slackConnectRpc,
  slackInboxRpc,
  slackScanRpc,
  slackReplyRpc,
  slackSetStateRpc,
} from "../../../shared/slack-rpc";
import { LinkedText } from "../cards/linked-text";
import { todosAddRpc } from "../../../shared/todos-rpc";
import { todosChanged } from "./todo-events";

const POLL_MS = 30_000;
const COLLAPSED_WIDTH = 40;
const KIND_ICON: Record<SlackItem["kind"], string> = { review: "FileSearch", request: "ListTodo", question: "MessageCircleQuestion" };
const KIND_LABEL: Record<SlackItem["kind"], string> = { review: "Review", request: "To do", question: "Question" };
/** Slack's aubergine, the column's mark. */
const SLACK_COLOR = "#7c3085";

function linkLabel(url: string): string {
  if (url.includes("claude.ai")) return "Claude artifact";
  if (url.includes("/pull/")) return `PR #${url.match(/\/pull\/(\d+)/)?.[1] ?? ""}`;
  if (url.includes("docs.google.com")) return "Google Doc";
  if (url.includes("notion.so")) return "Notion";
  if (url.includes("figma.com")) return "Figma";
  if (url.includes("linear.app")) return "Linear";
  return "Link";
}

/**
 * The Slack inbox beside the lanes: messages that are tasks for the person,
 * newest first, with Open in Slack, Done and Dismiss. Without a connection it
 * offers the token form; collapsed, it is a strip with the open count.
 */
/** The phone's full-screen column. */
const FILL = { flex: 1, minHeight: 0, paddingLeft: 12, paddingRight: 4, paddingTop: 4 } as const;

export function SlackColumn(props: { theme: PluginTheme; width: number; visible: boolean; /** The phone: the whole screen, never collapsed or hidden. */ fill?: boolean }) {
  const tokens = taskTokens(props.theme);
  // The RPC functions may be new on each render; refs keep the effects below from rerunning.
  const inboxNow = useRpc(slackInboxRpc);
  const setStateNow = useRpc(slackSetStateRpc);
  const scanNow = useRpc(slackScanRpc);
  const addTodoNow = useRpc(todosAddRpc);
  const rpc = useRef({ inbox: inboxNow, setState: setStateNow, scan: scanNow, addTodo: addTodoNow });
  rpc.current = { inbox: inboxNow, setState: setStateNow, scan: scanNow, addTodo: addTodoNow };
  const [items, setItems] = useState<SlackItem[]>([]);
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [hidden, setHidden] = useState(false);
  const alive = useRef(true);

  const refresh = useCallback(() => {
    void rpc.current.inbox({}).then((result) => {
      if (!alive.current) return;
      // An older server, or one without Slack, answers something else: the column stays away.
      if (!result || !Array.isArray(result.items) || typeof result.status?.connected !== "boolean") return;
      setItems(result.items);
      setStatus(result.status);
    }).catch(() => {
      // An older server without Slack: the column stays away.
    });
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!props.visible) return () => { alive.current = false; };
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => { alive.current = false; clearInterval(timer); };
  }, [refresh, props.visible]);

  // While a scan runs, look again soon.
  useEffect(() => {
    if (!status?.scanning) return;
    const timer = setTimeout(refresh, 4_000);
    return () => clearTimeout(timer);
  }, [status, refresh]);

  const change = useCallback((item: SlackItem, state: SlackItem["state"]) => {
    setItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, state } : entry)));
    void rpc.current.setState({ id: item.id, state }).catch(refresh);
  }, [refresh]);

  /** The message becomes one of My tasks, keeping what it says, its links and where it came from; the Slack item closes. */
  const makeTask = useCallback((item: SlackItem) => {
    void rpc.current.addTodo({
      title: item.title,
      notes: `${item.from} in ${item.where}:\n${item.text}`,
      links: item.links,
      source: { kind: "slack", from: item.from, where: item.where, permalink: item.permalink, slackId: item.id, ...(item.threadTs ? { threadTs: item.threadTs } : {}), direct: item.direct === true },
    }).then(() => {
      todosChanged();
      change(item, "done");
    }, () => refresh());
  }, [change, refresh]);

  if (status === null || (hidden && !props.fill)) return null;
  const open = items.filter((item) => item.state === "open");
  const closed = items.filter((item) => item.state !== "open");

  if (collapsed && !props.fill) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel="Show Slack inbox" onPress={() => setCollapsed(false)} testID="slack-column-collapsed"
        style={{ width: COLLAPSED_WIDTH, alignItems: "center", paddingTop: 12, gap: 8, borderRightWidth: 1, borderRightColor: tokens.card.border }}>
        <Icon name="Slack" size={18} color={SLACK_COLOR} />
        {open.length > 0 ? <Text style={{ fontSize: F.sm, fontWeight: "700", color: tokens.status.warning }}>{open.length}</Text> : null}
      </Pressable>
    );
  }

  return (
    <View testID="slack-column" style={props.fill ? FILL : { width: props.width, paddingLeft: 12, paddingTop: 4, borderRightWidth: 1, borderRightColor: tokens.card.border }}>
      <View style={{ height: 36, flexDirection: "row", alignItems: "center", gap: 6, paddingRight: 8 }}>
        <Icon name="Slack" size={16} color={SLACK_COLOR} />
        <Text style={{ fontSize: F.base, fontWeight: "600", color: tokens.foreground }}>Slack</Text>
        <Text style={{ fontSize: F.base, color: tokens.foregroundMuted }}>{status.connected ? open.length : ""}</Text>
        <View style={{ flex: 1 }} />
        {status.connected ? (
          <HeaderButton icon={status.scanning ? "Loader" : "RefreshCw"} label={status.scanning ? "Scanning Slack…" : "Scan Slack now"} tokens={tokens} onPress={() => { void rpc.current.scan({}).then((result) => setStatus(result.status)); }} />
        ) : props.fill ? null : (
          <HeaderButton icon="X" label="Hide until the board reopens" tokens={tokens} onPress={() => setHidden(true)} />
        )}
        {props.fill ? null : <HeaderButton icon="PanelLeftClose" label="Collapse" tokens={tokens} onPress={() => setCollapsed(true)} />}
      </View>
      {!status.connected ? (
        <ConnectForm tokens={tokens} onConnected={(next) => { setStatus(next); refresh(); }} />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 8, paddingRight: 8, paddingBottom: 16 }}>
          {status.error ? <Text style={{ fontSize: F.sm, color: tokens.danger }}>{status.error}</Text> : null}
          {open.length === 0 ? (
            <Text style={{ fontSize: F.sm, color: tokens.foregroundMuted, paddingVertical: 12 }}>
              {status.lastScanAt ? `Nothing waiting on you. Scanned ${formatRelative(Date.now() - status.lastScanAt, "en")} ago.` : "Scanning your DMs and mentions…"}
            </Text>
          ) : null}
          {open.map((item) => <SlackCard key={item.id} item={item} tokens={tokens} onState={change} onMakeTask={makeTask} />)}
          {closed.length > 0 ? <Text style={{ marginTop: 8, fontSize: F.sm, color: tokens.foregroundMuted }}>Closed today</Text> : null}
          {closed.map((item) => <SlackCard key={item.id} item={item} tokens={tokens} onState={change} />)}
        </ScrollView>
      )}
    </View>
  );
}

function HeaderButton(props: { icon: string; label: string; tokens: TaskTokens; onPress(): void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={props.label} onPress={props.onPress} hitSlop={4}
      style={{ width: 28, height: 28, borderRadius: 6, alignItems: "center", justifyContent: "center" }}>
      <Icon name={props.icon} size={14} color={props.tokens.foregroundMuted} />
    </Pressable>
  );
}

function SlackCard(props: { item: SlackItem; tokens: TaskTokens; onState(item: SlackItem, state: SlackItem["state"]): void; onMakeTask?(item: SlackItem): void }) {
  const { item, tokens } = props;
  const closed = item.state !== "open";
  const [expanded, setExpanded] = useState(false);
  const tint = item.kind === "review" ? tokens.accent : item.kind === "question" ? tokens.status.warning : SLACK_COLOR;
  return (
    // Only the message itself toggles the card: the links, buttons and reply box below take their own presses.
    <View testID={`slack-card-${item.id}`}
      style={{ borderRadius: 10, borderWidth: 1, borderColor: expanded ? tint : tokens.card.border, backgroundColor: tokens.card.background, padding: 10, paddingLeft: 13, gap: 5, opacity: closed && !expanded ? 0.55 : 1, overflow: "hidden" }}>
      <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, backgroundColor: tint }} />
      <Pressable accessibilityRole="button" accessibilityLabel={expanded ? "Collapse message" : "Show the whole message"} onPress={() => setExpanded((was) => !was)} style={{ gap: 5 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        <Icon name={KIND_ICON[item.kind]} size={13} color={tint} />
        <Text style={{ fontSize: F.sm, fontWeight: "600", color: tint }}>{KIND_LABEL[item.kind]}</Text>
        <Text numberOfLines={1} style={{ flex: 1, fontSize: F.sm, color: tokens.foregroundMuted }}>{` · ${item.from} · ${item.where}`}</Text>
        <Text style={{ fontSize: F.sm, color: tokens.foregroundMuted }}>{formatRelative(Date.now() - item.at, "en")}</Text>
      </View>
      <Text numberOfLines={2} style={{ fontSize: F.base, fontWeight: "600", color: tokens.foreground, textDecorationLine: closed ? "line-through" : "none" }}>{item.title}</Text>
      <LinkedText text={item.text} linkColor={tokens.accentText} numberOfLines={expanded ? undefined : 3} selectable={expanded}
        style={{ fontSize: expanded ? F.base : F.sm, lineHeight: expanded ? Math.round(F.base * 1.45) : undefined, color: expanded ? tokens.foreground : tokens.foregroundMuted }} />
      </Pressable>
      {item.links.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
          {item.links.map((url) => (
            <Pressable key={url} accessibilityRole="link" accessibilityLabel={url} onPress={() => openLink(url)}
              style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 7, height: 22, borderRadius: 11, backgroundColor: withAlpha(tint, 0.12) }}>
              <Icon name="ExternalLink" size={11} color={tint} />
              <Text style={{ fontSize: F.sm, color: tint }}>{linkLabel(url)}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
        {item.replied && !closed ? <Text style={{ fontSize: F.sm, color: tokens.success }}>You replied</Text> : null}
        <View style={{ flex: 1 }} />
        <CardButton icon="MessageSquare" label="Open in Slack" tokens={tokens} onPress={() => openLink(item.permalink)} />
        {closed ? (
          <CardButton icon="Undo2" label="Reopen" tokens={tokens} onPress={() => props.onState(item, "open")} />
        ) : (
          <>
            <CardButton icon="Reply" label="Reply" tokens={tokens} labelled onPress={() => setExpanded(true)} />
            {props.onMakeTask ? <CardButton icon="ListPlus" label="Task" tokens={tokens} labelled onPress={() => props.onMakeTask?.(item)} /> : null}
            <CardButton icon="X" label="Not a task" tokens={tokens} onPress={() => props.onState(item, "dismissed")} />
            <CardButton icon="Check" label="Done" tokens={tokens} strong onPress={() => props.onState(item, "done")} />
          </>
        )}
      </View>
      {expanded && item.state === "open" ? <SlackReply item={item} tokens={tokens} tint={tint} onSent={() => props.onState({ ...item, replied: true }, "done")} /> : null}
    </View>
  );
}

/** A reply posted as the person: in the message's thread, or in its DM. */
/** The message a reply answers: an inbox item, or the source a task kept. */
export type SlackReplyTarget = { id: string; where: string; direct?: boolean; threadTs?: string };

/** Always in the thread; the box also sends it to the channel or as a DM, as Slack's does. */
export function SlackReply(props: { item: SlackReplyTarget; tokens: TaskTokens; tint: string; onSent(): void; /** Ask the server to use this thread when the message left the inbox. */ keepThread?: boolean }) {
  const { tokens } = props;
  const reply = useRpc(slackReplyRpc);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [broadcast, setBroadcast] = useState(false);
  const send = () => {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    void reply({ id: props.item.id, text: message, broadcast, ...(props.keepThread && props.item.threadTs ? { threadTs: props.item.threadTs } : {}) }).then((result) => {
      if (result.ok) {
        setText("");
        props.onSent();
      } else setError(result.error);
    }, (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught))).finally(() => setBusy(false));
  };
  const where = "Reply in thread";
  // Slack's own wording for the broadcast box.
  const broadcastLabel = props.item.direct ? "Also send as direct message" : `Also send to ${props.item.where}`;
  return (
    <View style={{ marginTop: 6, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6, padding: 4, borderRadius: 8, borderWidth: 1.5, borderColor: props.tint }}>
        <TextInput
          testID="slack-reply-input"
          value={text}
          onChangeText={setText}
          multiline
          autoFocus
          editable={!busy}
          placeholder={`${where}…`}
          placeholderTextColor={tokens.foregroundMuted}
          onKeyPress={(event) => {
            const native = event.nativeEvent as unknown as { key: string; shiftKey?: boolean; isComposing?: boolean };
            if (native.key === "Enter" && !native.shiftKey && !native.isComposing) {
              (event as unknown as { preventDefault?(): void }).preventDefault?.();
              send();
            }
          }}
          style={{ flex: 1, minHeight: 34, maxHeight: 140, paddingHorizontal: 8, paddingVertical: 7, fontSize: F.sm, color: tokens.foreground, outlineStyle: "none" } as unknown as TextStyle}
        />
        <Pressable accessibilityRole="button" accessibilityLabel="Send to Slack" onPress={send} disabled={busy || !text.trim()}
          style={{ height: 30, paddingHorizontal: 10, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: props.tint, opacity: busy || !text.trim() ? 0.5 : 1 }}>
          <Text style={{ fontSize: F.sm, fontWeight: "600", color: "#ffffff" }}>{busy ? "Sending…" : "Send"}</Text>
        </Pressable>
      </View>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: broadcast }} accessibilityLabel={broadcastLabel} onPress={() => setBroadcast((was) => !was)} testID="slack-reply-broadcast"
        style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" }}>
        <View style={{ width: 16, height: 16, borderRadius: 4, borderWidth: 1.5, borderColor: broadcast ? props.tint : tokens.foregroundMuted, backgroundColor: broadcast ? props.tint : "transparent", alignItems: "center", justifyContent: "center" }}>
          {broadcast ? <Icon name="Check" size={11} color="#ffffff" /> : null}
        </View>
        <Text style={{ fontSize: F.sm, color: tokens.foreground }}>{broadcastLabel}</Text>
      </Pressable>
      {error ? <Text style={{ fontSize: F.sm, color: tokens.danger }}>{error}</Text> : null}
    </View>
  );
}

function CardButton(props: { icon: string; label: string; tokens: TaskTokens; strong?: boolean; labelled?: boolean; onPress(): void }) {
  const { tokens } = props;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={props.label} onPress={props.onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: 4, height: 26, paddingHorizontal: props.strong ? 9 : 7, borderRadius: 6, borderWidth: 1, borderColor: props.strong ? tokens.success : tokens.card.border }}>
      <Icon name={props.icon} size={13} color={props.strong ? tokens.success : tokens.foregroundMuted} />
      {props.strong ? <Text style={{ fontSize: F.sm, fontWeight: "600", color: tokens.success }}>{props.label}</Text> : props.labelled ? <Text style={{ fontSize: F.sm, color: tokens.foreground }}>{props.label}</Text> : null}
    </Pressable>
  );
}

function ConnectForm(props: { tokens: TaskTokens; onConnected(status: SlackStatus): void }) {
  const { tokens } = props;
  const connect = useRpc(slackConnectRpc);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    void connect({ token: token.trim() }).then((result) => {
      if (result.ok) {
        setToken("");
        props.onConnected(result.status);
      } else setError(result.error);
    }, (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught))).finally(() => setBusy(false));
  };
  return (
    <View testID="slack-connect" style={{ gap: 8, paddingRight: 8, paddingTop: 4 }}>
      <Text style={{ fontSize: F.sm, color: tokens.foregroundMuted }}>
        Paste your Slack User OAuth Token (xoxp-…) from your Slack app's OAuth &amp; Permissions page. It is stored only on this Paseo daemon.
      </Text>
      <TextInput
        testID="slack-token-input"
        value={token}
        onChangeText={setToken}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="xoxp-…"
        placeholderTextColor={tokens.foregroundMuted}
        onSubmitEditing={submit}
        style={{ height: 34, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: tokens.card.border, fontSize: F.sm, color: tokens.foreground, outlineStyle: "none" } as unknown as TextStyle}
      />
      {error ? <Text style={{ fontSize: F.sm, color: tokens.danger }}>{error}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Connect Slack" onPress={submit} disabled={busy || !token.trim()}
        style={{ height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: SLACK_COLOR, opacity: busy || !token.trim() ? 0.5 : 1 }}>
        <Text style={{ fontSize: F.sm, fontWeight: "600", color: "#ffffff" }}>{busy ? "Connecting…" : "Connect Slack"}</Text>
      </Pressable>
    </View>
  );
}
