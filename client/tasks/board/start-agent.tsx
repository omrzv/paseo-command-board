import React, { useEffect, useMemo, useState } from "react";
import { Pressable, TextInput, View, type TextStyle } from "react-native";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { withAlpha } from "../../components/theme-tokens";
import { TaskText as Text, TasksTypography, HOST_FONT as F } from "../typography";
import { taskTokens, type TaskTokens } from "../cards/tokens";
import type { Todo } from "../../../shared/todos-rpc";
import { agentPrompt } from "./todo-model";

const INPUT = { outlineStyle: "none" } as unknown as TextStyle;

type Project = { key: string; name: string; rootPath: string; kind: "directory" | "git" | "non_git" };
type Model = { id: string; label: string; thinking: Array<{ id: string; label: string }>; defaultThinking: string | null; isDefault: boolean };
type Provider = { id: string; label: string; models: Model[]; modes: Array<{ id: string; label: string }>; defaultMode: string | null };

/** A slug for a worktree's folder and branch: lower case words joined by dashes. */
export function worktreeSlug(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
}

/**
 * Starts an agent from one of My tasks: pick the project, a name for the new
 * workspace (a git project can branch off into a worktree), the provider,
 * model, thinking and mode, read and edit the first message (the task, its
 * notes, links and Slack origin), add more context, and start.
 */
export function StartAgentDialog(props: {
  todo: Todo;
  paseo: PaseoApi;
  theme: PluginTheme;
  onClose(): void;
  onStarted(agentId: string): void;
}) {
  const tokens = taskTokens(props.theme);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [name, setName] = useState(props.todo.title.slice(0, 60));
  const [worktree, setWorktree] = useState(true);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [thinkingId, setThinkingId] = useState<string | null>(null);
  const [modeId, setModeId] = useState<string | null>(null);
  const [message, setMessage] = useState(() => agentPrompt(props.todo, ""));
  const [extra, setExtra] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([props.paseo.projects.list(), props.paseo.providers.snapshot()]).then(([projectList, snapshot]) => {
      if (!live) return;
      const found: Project[] = (projectList.projects ?? []).map((project) => ({
        key: project.projectKey ?? project.projectId,
        name: project.projectCustomName || project.projectDisplayName,
        rootPath: project.projectRootPath,
        kind: project.projectKind,
      })).sort((left, right) => left.name.localeCompare(right.name));
      const ready: Provider[] = snapshot.entries
        .filter((entry) => entry.enabled !== false && entry.status === "ready" && (entry.models?.length ?? 0) > 0)
        .map((entry) => ({
          id: entry.provider,
          label: entry.label ?? entry.provider,
          models: (entry.models ?? []).filter((model) => model.isSelectable !== false).map((model) => ({
            id: model.id,
            label: model.label,
            thinking: (model.thinkingOptions ?? []).map((option) => ({ id: option.id, label: option.label })),
            defaultThinking: model.defaultThinkingOptionId ?? model.thinkingOptions?.find((option) => option.isDefault)?.id ?? null,
            isDefault: model.isDefault === true,
          })),
          modes: (entry.modes ?? []).map((mode) => ({ id: mode.id, label: mode.label })),
          defaultMode: entry.defaultModeId ?? null,
        }));
      setProjects(found);
      setProviders(ready);
      setProjectKey((current) => current ?? found[0]?.key ?? null);
      const provider = ready.find((entry) => entry.id === "claude") ?? ready[0];
      if (provider) pickProvider(provider);
    }, (caught: unknown) => {
      if (live) setLoadError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => { live = false; };
  }, [props.paseo]);

  function pickProvider(provider: Provider) {
    setProviderId(provider.id);
    const model = provider.models.find((entry) => entry.isDefault) ?? provider.models[0];
    setModelId(model?.id ?? null);
    setThinkingId(model?.defaultThinking ?? null);
    setModeId(provider.defaultMode ?? provider.modes[0]?.id ?? null);
  }

  const project = projects?.find((entry) => entry.key === projectKey) ?? null;
  const provider = providers?.find((entry) => entry.id === providerId) ?? null;
  const model = provider?.models.find((entry) => entry.id === modelId) ?? null;
  const prompt = useMemo(() => (extra.trim() ? `${message.trim()}\n\nAdditional context:\n${extra.trim()}` : message.trim()), [message, extra]);
  const canStart = !!project && !!provider && !!model && name.trim().length > 0 && prompt.length > 0 && !starting;

  const start = async () => {
    if (!canStart || !project || !provider || !model) return;
    setStarting(true);
    setError(null);
    try {
      const title = name.trim();
      const workspace = await props.paseo.workspaces.create({
        title,
        source: project.kind === "git" && worktree
          ? { kind: "worktree", cwd: project.rootPath, projectId: project.key, action: "branch-off", worktreeSlug: worktreeSlug(title) }
          : { kind: "directory", path: project.rootPath, projectId: project.key },
      });
      const agent = await workspace.agents.create({
        config: {
          provider: `${provider.id}/${model.id}`,
          ...(modeId ? { modeId } : {}),
          ...(thinkingId ? { thinkingOptionId: thinkingId } : {}),
        },
        prompt,
        title,
      });
      props.onStarted(agent.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setStarting(false);
    }
  };

  return (
    <Modal title="Start an agent from this task" open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <Modal.Content contentContainerStyle={{ padding: 16, gap: 14, minWidth: 520 }}>
        <TasksTypography theme={props.theme}>
          <View style={{ gap: 14 }}>
            {loadError ? <Text style={{ fontSize: F.sm, color: tokens.danger }}>{loadError}</Text> : null}
            {projects === null || providers === null ? <Text style={{ fontSize: F.sm, color: tokens.foregroundMuted }}>Loading projects and models…</Text> : (
              <>
                <Field label="Project" tokens={tokens}>
                  <Chips tokens={tokens} value={projectKey} onChange={setProjectKey} options={projects.map((entry) => ({ id: entry.key, label: entry.name, hint: entry.rootPath }))} />
                </Field>
                <Field label="New workspace" tokens={tokens}>
                  <TextInput value={name} onChangeText={setName} placeholder="Workspace name" placeholderTextColor={tokens.foregroundMuted}
                    style={[boxStyle(tokens), { height: 36 }, INPUT]} />
                  {project?.kind === "git" ? (
                    <Chips tokens={tokens} value={worktree ? "worktree" : "folder"} onChange={(value) => setWorktree(value === "worktree")}
                      options={[{ id: "worktree", label: `New branch and worktree (${worktreeSlug(name)})` }, { id: "folder", label: "In the project folder" }]} />
                  ) : project ? <Text style={{ fontSize: F.sm, color: tokens.foregroundMuted }}>{`In ${project.rootPath}`}</Text> : null}
                </Field>
                <Field label="Agent" tokens={tokens}>
                  <Chips tokens={tokens} value={providerId} onChange={(id) => { const next = providers.find((entry) => entry.id === id); if (next) pickProvider(next); }}
                    options={providers.map((entry) => ({ id: entry.id, label: entry.label }))} />
                  {provider ? <Chips tokens={tokens} value={modelId} onChange={(id) => { setModelId(id); setThinkingId(provider.models.find((entry) => entry.id === id)?.defaultThinking ?? null); }}
                    options={provider.models.map((entry) => ({ id: entry.id, label: entry.label }))} /> : null}
                </Field>
                {model && model.thinking.length > 0 ? (
                  <Field label="Thinking" tokens={tokens}>
                    <Chips tokens={tokens} value={thinkingId} onChange={setThinkingId} options={model.thinking} />
                  </Field>
                ) : null}
                {provider && provider.modes.length > 0 ? (
                  <Field label="Mode" tokens={tokens}>
                    <Chips tokens={tokens} value={modeId} onChange={setModeId} options={provider.modes} />
                  </Field>
                ) : null}
                <Field label="First message (from the task)" tokens={tokens}>
                  <TextInput value={message} onChangeText={setMessage} multiline style={[boxStyle(tokens), { minHeight: 120, maxHeight: 260, textAlignVertical: "top" }, INPUT]} />
                </Field>
                <Field label="More context" tokens={tokens}>
                  <TextInput value={extra} onChangeText={setExtra} multiline placeholder="Anything else the agent should know or do…" placeholderTextColor={tokens.foregroundMuted}
                    style={[boxStyle(tokens), { minHeight: 70, textAlignVertical: "top" }, INPUT]} />
                </Field>
              </>
            )}
            {error ? <Text style={{ fontSize: F.sm, color: tokens.danger }}>{error}</Text> : null}
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
              <Pressable accessibilityRole="button" onPress={props.onClose} style={{ height: 34, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: tokens.card.border, justifyContent: "center" }}>
                <Text style={{ fontSize: F.sm, color: tokens.foreground }}>Cancel</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Start agent" disabled={!canStart} onPress={() => { void start(); }} testID="start-agent-submit"
                style={{ height: 34, paddingHorizontal: 16, borderRadius: 8, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: tokens.accent, opacity: canStart ? 1 : 0.45 }}>
                <Icon name={starting ? "Loader" : "Play"} size={14} color="#ffffff" />
                <Text style={{ fontSize: F.sm, fontWeight: "700", color: "#ffffff" }}>{starting ? "Starting…" : "Start agent"}</Text>
              </Pressable>
            </View>
          </View>
        </TasksTypography>
      </Modal.Content>
    </Modal>
  );
}

function boxStyle(tokens: TaskTokens): TextStyle {
  return { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: tokens.card.border, fontSize: F.sm, color: tokens.foreground, backgroundColor: tokens.card.background };
}

function Field(props: { label: string; tokens: TaskTokens; children: React.ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: F.sm, fontWeight: "600", color: props.tokens.foregroundMuted }}>{props.label}</Text>
      {props.children}
    </View>
  );
}

function Chips(props: { tokens: TaskTokens; value: string | null; onChange(id: string): void; options: Array<{ id: string; label: string; hint?: string }> }) {
  const { tokens } = props;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {props.options.map((option) => {
        const selected = option.id === props.value;
        return (
          <Pressable key={option.id} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityHint={option.hint} onPress={() => props.onChange(option.id)}
            style={{ height: 28, paddingHorizontal: 10, borderRadius: 14, justifyContent: "center", borderWidth: 1, borderColor: selected ? tokens.accent : tokens.card.border, backgroundColor: selected ? withAlpha(tokens.accent, 0.14) : "transparent" }}>
            <Text style={{ fontSize: F.sm, color: selected ? tokens.accentText : tokens.foreground, fontWeight: selected ? "600" : "400" }}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
