import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View, type TextStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { withAlpha } from "../../components/theme-tokens";
import { useCopy } from "../../ui/use-copy";
import { TaskText as Text, HOST_FONT as F, TASK_MONO as MONO } from "../typography";
import { taskTokens, type TaskTokens } from "../cards/tokens";
import { formatRelative } from "../cards/format";
import { type KeyEntry, envVarFor, keysDeleteRpc, keysImportRpc, keysListRpc, keysRevealRpc, keysSaveRpc, keysScanRpc, keysTestRpc } from "../../../shared/keys-rpc";

const COLLAPSED_WIDTH = 40;
const INPUT = { outlineStyle: "none" } as unknown as TextStyle;
/** A shown value hides itself again after this long. */
const SHOWN_MS = 30_000;
const FILL = { flex: 1, minHeight: 0, paddingLeft: 12, paddingRight: 4, paddingTop: 4 } as const;
const SERVICES = ["openai", "anthropic", "github", "slack", "other"] as const;


type Form = { id?: string; name: string; envVar: string; service: string; note: string; value: string; envTouched: boolean };
const EMPTY_FORM: Form = { name: "", envVar: "", service: "", note: "", value: "", envTouched: false };

/**
 * API keys and tokens beside the lanes, small and folded by default. Values
 * live in the macOS Keychain; the daemon sends one only when Show or Copy is
 * pressed, and a shown value hides itself after 30 s.
 */
export function KeysColumn(props: { theme: PluginTheme; width: number; visible: boolean; /** The phone: the whole screen, never collapsed. */ fill?: boolean }) {
  const tokens = taskTokens(props.theme);
  const listNow = useRpc(keysListRpc);
  const saveNow = useRpc(keysSaveRpc);
  const revealNow = useRpc(keysRevealRpc);
  const deleteNow = useRpc(keysDeleteRpc);
  const testNow = useRpc(keysTestRpc);
  const scanNow = useRpc(keysScanRpc);
  const importNow = useRpc(keysImportRpc);
  const rpc = useRef({ list: listNow, save: saveNow, reveal: revealNow, remove: deleteNow, test: testNow, scan: scanNow, importFrom: importNow });
  rpc.current = { list: listNow, save: saveNow, reveal: revealNow, remove: deleteNow, test: testNow, scan: scanNow, importFrom: importNow };

  const [keys, setKeys] = useState<KeyEntry[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [collapsed, setCollapsed] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<Array<{ file: string; envVar: string; known: boolean; picked: boolean }> | null>(null);

  const refresh = useCallback(() => {
    void rpc.current.list({}).then((result) => {
      if (!Array.isArray(result?.keys)) return;
      setKeys(result.keys);
      setAvailable(result.available !== false);
    }, () => undefined);
  }, []);
  useEffect(() => { if (props.visible) refresh(); }, [refresh, props.visible]);

  const fail = (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught));
  const upsert = (key: KeyEntry) => setKeys((current) => {
    const rest = (current ?? []).filter((entry) => entry.id !== key.id);
    return [...rest, key].sort((left, right) => left.name.localeCompare(right.name));
  });

  const save = () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name || (!form.id && !form.value)) return;
    setError(null);
    void rpc.current.save({
      ...(form.id ? { id: form.id } : {}),
      name,
      envVar: form.envVar.trim() || envVarFor(name),
      ...(form.service ? { service: form.service } : {}),
      note: form.note,
      ...(form.value ? { value: form.value } : {}),
    }).then((result) => { upsert(result.key); setForm(null); setOpen(result.key.id); }, fail);
  };

  const scan = () => {
    setError(null);
    setImporting([]);
    void rpc.current.scan({}).then((result) => setImporting(result.found.map((item) => ({ ...item, picked: !item.known }))), (caught) => { setImporting(null); fail(caught); });
  };
  const runImport = () => {
    const items = (importing ?? []).filter((item) => item.picked).map(({ file, envVar }) => ({ file, envVar }));
    if (items.length === 0) return;
    void rpc.current.importFrom({ items }).then(() => { setImporting(null); refresh(); }, fail);
  };

  if (keys === null) return null;
  const failing = keys.filter((key) => key.test && !key.test.ok).length;

  if (collapsed && !props.fill) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel="Show keys" onPress={() => setCollapsed(false)} testID="keys-column-collapsed"
        style={{ width: COLLAPSED_WIDTH, alignItems: "center", paddingTop: 12, gap: 8, borderRightWidth: 1, borderRightColor: tokens.card.border }}>
        <Icon name="KeyRound" size={18} color={tokens.foregroundMuted} />
        {failing > 0 ? <Text style={{ fontSize: F.sm, fontWeight: "700", color: tokens.danger }}>{failing}</Text> : null}
      </Pressable>
    );
  }

  const words = filter.trim().toLowerCase();
  const shown = words ? keys.filter((key) => `${key.name} ${key.envVar} ${key.service} ${key.note}`.toLowerCase().includes(words)) : keys;

  return (
    <View testID="keys-column" style={props.fill ? FILL : { width: props.width, paddingLeft: 12, paddingTop: 4, borderRightWidth: 1, borderRightColor: tokens.card.border }}>
      <View style={{ height: 36, flexDirection: "row", alignItems: "center", gap: 6, paddingRight: 8 }}>
        <Icon name="KeyRound" size={16} color={tokens.foregroundMuted} />
        <Text style={{ fontSize: F.base, fontWeight: "600", color: tokens.foreground }}>Keys</Text>
        <Text style={{ fontSize: F.base, color: tokens.foregroundMuted }}>{keys.length}</Text>
        <View style={{ flex: 1 }} />
        <HeaderButton icon="Plus" label="Add a key" tokens={tokens} testID="keys-add" onPress={() => { setForm(EMPTY_FORM); setImporting(null); }} />
        <HeaderButton icon="FileInput" label="Import from .env files" tokens={tokens} testID="keys-import" onPress={scan} />
        {props.fill ? null : <HeaderButton icon="PanelLeftClose" label="Collapse" tokens={tokens} onPress={() => setCollapsed(true)} />}
      </View>
      {!available ? <Text style={{ fontSize: F.sm, color: tokens.danger, paddingRight: 8 }}>The Keychain is only on macOS: keys cannot be stored on this host.</Text> : null}
      {error ? <Text testID="keys-error" style={{ fontSize: F.sm, color: tokens.danger, paddingRight: 8, paddingBottom: 6 }}>{error}</Text> : null}
      {form ? <KeyForm form={form} tokens={tokens} onChange={setForm} onSave={save} onCancel={() => setForm(null)} /> : null}
      {importing ? (
        <ImportList items={importing} tokens={tokens} onChange={setImporting} onImport={runImport} onCancel={() => setImporting(null)} />
      ) : null}
      {keys.length > 6 ? (
        <TextInput value={filter} onChangeText={setFilter} placeholder="Filter keys" placeholderTextColor={tokens.foregroundMuted} testID="keys-filter"
          style={[{ marginRight: 8, marginBottom: 6, height: 30, paddingHorizontal: 8, borderRadius: 7, fontSize: F.sm, color: tokens.foreground, backgroundColor: withAlpha(tokens.foreground, 0.05) }, INPUT]} />
      ) : null}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 5, paddingRight: 8, paddingBottom: 16 }}>
        {keys.length === 0 && !form && !importing ? (
          <Text style={{ fontSize: F.sm, color: tokens.foregroundMuted, paddingVertical: 8 }}>No keys yet. Add one with +, or import them from your .env files.</Text>
        ) : null}
        {shown.map((key) => (
          <KeyRow key={key.id} entry={key} tokens={tokens} open={open === key.id}
            onToggle={() => setOpen((current) => (current === key.id ? null : key.id))}
            reveal={() => rpc.current.reveal({ id: key.id }).then((result) => result.value)}
            onTest={() => { void rpc.current.test({ id: key.id }).then((result) => upsert(result.key), fail); }}
            onEdit={() => setForm({ id: key.id, name: key.name, envVar: key.envVar, service: key.service, note: key.note, value: "", envTouched: true })}
            onDelete={() => { void rpc.current.remove({ id: key.id }).then(() => setKeys((current) => (current ?? []).filter((entry) => entry.id !== key.id)), fail); }}
            onError={fail}
          />
        ))}
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

function KeyRow(props: {
  entry: KeyEntry;
  tokens: TaskTokens;
  open: boolean;
  onToggle(): void;
  reveal(): Promise<string>;
  onTest(): void;
  onEdit(): void;
  onDelete(): void;
  onError(error: unknown): void;
}) {
  const { entry, tokens } = props;
  const [value, setValue] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [testing, setTesting] = useState(false);
  const { copy } = useCopy();
  // A shown value hides itself, and when the row closes.
  useEffect(() => {
    if (value === null) return;
    const timer = setTimeout(() => setValue(null), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [value]);
  useEffect(() => { if (!props.open) { setValue(null); setConfirmDelete(false); } }, [props.open]);
  useEffect(() => { setTesting(false); }, [entry.test?.at]);

  const status = entry.test ? (entry.test.ok ? tokens.success : tokens.danger) : null;
  return (
    <View testID={`key-${entry.id}`} style={{ borderRadius: 9, borderWidth: 1, borderColor: props.open ? withAlpha(tokens.accent, 0.6) : tokens.card.border, backgroundColor: tokens.card.background, paddingHorizontal: 8, paddingVertical: 6, gap: 6 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={props.open ? `Close ${entry.name}` : `Open ${entry.name}`} onPress={props.onToggle} style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: status ?? withAlpha(tokens.foreground, 0.18) }} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontSize: F.sm, fontWeight: "600", color: tokens.foreground }}>{entry.name}</Text>
          <Text numberOfLines={1} style={{ fontSize: F.sm - 1, fontFamily: MONO, color: tokens.foregroundMuted }}>{entry.envVar}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={`Copy ${entry.name}`} testID="key-copy" hitSlop={4}
          onPress={() => { void props.reveal().then((secret) => copy(secret), props.onError); }}
          style={{ width: 26, height: 26, borderRadius: 6, alignItems: "center", justifyContent: "center" }}>
          <Icon name="Copy" size={13} color={tokens.foregroundMuted} />
        </Pressable>
      </Pressable>
      {props.open ? (
        <View style={{ gap: 6 }}>
          <Text selectable testID="key-value" style={{ fontSize: F.sm, fontFamily: MONO, color: value === null ? tokens.foregroundMuted : tokens.foreground, padding: 6, borderRadius: 6, backgroundColor: withAlpha(tokens.foreground, 0.05) }}>
            {value ?? entry.hint}
          </Text>
          {entry.note ? <Text style={{ fontSize: F.sm, color: tokens.foregroundMuted }}>{entry.note}</Text> : null}
          {entry.test ? (
            <Text style={{ fontSize: F.sm, color: entry.test.ok ? tokens.success : tokens.danger }}>
              {`${entry.test.detail} · ${formatRelative(Date.now() - entry.test.at, "en")} ago`}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
            <RowButton icon={value === null ? "Eye" : "EyeOff"} label={value === null ? "Show" : "Hide"} tokens={tokens} testID="key-show"
              onPress={() => { if (value !== null) setValue(null); else void props.reveal().then(setValue, props.onError); }} />
            {entry.service !== "other" ? (
              <RowButton icon={testing ? "Loader" : "Activity"} label="Test" tokens={tokens} testID="key-test" onPress={() => { setTesting(true); props.onTest(); }} />
            ) : null}
            <RowButton icon="Pencil" label="Edit" tokens={tokens} onPress={props.onEdit} />
            <View style={{ flex: 1 }} />
            <RowButton icon="Trash2" label={confirmDelete ? "Delete?" : ""} danger tokens={tokens} testID="key-delete"
              onPress={() => { if (confirmDelete) props.onDelete(); else setConfirmDelete(true); }} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function RowButton(props: { icon: string; label: string; tokens: TaskTokens; onPress(): void; danger?: boolean; testID?: string }) {
  const { tokens } = props;
  const color = props.danger ? tokens.danger : tokens.foreground;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={props.label || "Delete"} onPress={props.onPress} testID={props.testID}
      style={{ height: 26, paddingHorizontal: 8, borderRadius: 6, flexDirection: "row", alignItems: "center", gap: 4, borderWidth: 1, borderColor: props.danger ? withAlpha(tokens.danger, 0.5) : tokens.card.border }}>
      <Icon name={props.icon} size={12} color={props.danger ? tokens.danger : tokens.foregroundMuted} />
      {props.label ? <Text style={{ fontSize: F.sm, color }}>{props.label}</Text> : null}
    </Pressable>
  );
}

function KeyForm(props: { form: Form; tokens: TaskTokens; onChange(form: Form): void; onSave(): void; onCancel(): void }) {
  const { form, tokens } = props;
  const field = [{ fontSize: F.sm, color: tokens.foreground, height: 32, paddingHorizontal: 8, borderRadius: 6, backgroundColor: withAlpha(tokens.foreground, 0.05) }, INPUT];
  const ready = form.name.trim() !== "" && (form.id !== undefined || form.value !== "");
  return (
    <View testID="keys-form" style={{ marginRight: 8, marginBottom: 8, padding: 8, gap: 6, borderRadius: 9, borderWidth: 1.5, borderColor: withAlpha(tokens.accent, 0.55) }}>
      <TextInput testID="keys-form-name" autoFocus value={form.name} placeholder="Name (e.g. OpenAI personal)" placeholderTextColor={tokens.foregroundMuted} style={field}
        onChangeText={(name) => props.onChange({ ...form, name, envVar: form.envTouched ? form.envVar : envVarFor(name) })} />
      <TextInput testID="keys-form-env" value={form.envVar} placeholder="ENV_VAR_NAME" placeholderTextColor={tokens.foregroundMuted} autoCapitalize="characters" style={[...field, { fontFamily: MONO }]}
        onChangeText={(envVar) => props.onChange({ ...form, envVar, envTouched: true })} />
      <TextInput testID="keys-form-value" value={form.value} secureTextEntry autoCorrect={false} autoCapitalize="none" placeholder={form.id ? "New value (empty keeps the current one)" : "Value"} placeholderTextColor={tokens.foregroundMuted} style={[...field, { fontFamily: MONO }]}
        onChangeText={(value) => props.onChange({ ...form, value })} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
        {SERVICES.map((service) => {
          const on = form.service === service;
          return (
            <Pressable key={service} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => props.onChange({ ...form, service: on ? "" : service })}
              style={{ height: 22, paddingHorizontal: 7, borderRadius: 11, justifyContent: "center", borderWidth: 1, borderColor: on ? tokens.accent : tokens.card.border, backgroundColor: on ? withAlpha(tokens.accent, 0.14) : "transparent" }}>
              <Text style={{ fontSize: F.sm - 1, color: on ? tokens.accentText : tokens.foregroundMuted }}>{service}</Text>
            </Pressable>
          );
        })}
      </View>
      <TextInput value={form.note} placeholder="Note (where it is used…)" placeholderTextColor={tokens.foregroundMuted} style={field}
        onChangeText={(note) => props.onChange({ ...form, note })} />
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 6 }}>
        <RowButton icon="X" label="Cancel" tokens={tokens} onPress={props.onCancel} />
        <Pressable accessibilityRole="button" testID="keys-form-save" disabled={!ready} onPress={props.onSave}
          style={{ height: 26, paddingHorizontal: 10, borderRadius: 6, flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: tokens.accent, opacity: ready ? 1 : 0.45 }}>
          <Icon name="Check" size={12} color="#ffffff" />
          <Text style={{ fontSize: F.sm, fontWeight: "600", color: "#ffffff" }}>Save</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ImportList(props: {
  items: Array<{ file: string; envVar: string; known: boolean; picked: boolean }>;
  tokens: TaskTokens;
  onChange(items: Array<{ file: string; envVar: string; known: boolean; picked: boolean }>): void;
  onImport(): void;
  onCancel(): void;
}) {
  const { items, tokens } = props;
  const picked = items.filter((item) => item.picked).length;
  return (
    <View testID="keys-import-list" style={{ marginRight: 8, marginBottom: 8, padding: 8, gap: 5, borderRadius: 9, borderWidth: 1, borderColor: tokens.card.border }}>
      <Text style={{ fontSize: F.sm, fontWeight: "600", color: tokens.foreground }}>{items.length ? "Found in .env files" : "Looking in your .env files…"}</Text>
      {items.map((item, index) => (
        <Pressable key={`${item.file}:${item.envVar}`} accessibilityRole="checkbox" accessibilityState={{ checked: item.picked }}
          onPress={() => props.onChange(items.map((entry, at) => (at === index ? { ...entry, picked: !entry.picked } : entry)))}
          style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name={item.picked ? "SquareCheck" : "Square"} size={14} color={item.picked ? tokens.accentText : tokens.foregroundMuted} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ fontSize: F.sm, fontFamily: MONO, color: tokens.foreground }}>{item.envVar}{item.known ? "  (already saved)" : ""}</Text>
            <Text numberOfLines={1} style={{ fontSize: F.sm - 1, color: tokens.foregroundMuted }}>{item.file.replace(/^\/Users\/[^/]+/, "~")}</Text>
          </View>
        </Pressable>
      ))}
      <Text style={{ fontSize: F.sm - 1, color: tokens.foregroundMuted }}>The .env files are left as they are.</Text>
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 6 }}>
        <RowButton icon="X" label="Cancel" tokens={tokens} onPress={props.onCancel} />
        <RowButton icon="Download" label={`Import ${picked}`} tokens={tokens} testID="keys-import-run" onPress={props.onImport} />
      </View>
    </View>
  );
}
