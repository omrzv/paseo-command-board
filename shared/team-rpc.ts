import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const memberSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Their Slack user id, for DMs from the team agent; null until linked. */
  slackUserId: z.string().nullable().default(null),
  role: z.string().default(""),
  /** A slot in MEMBER_COLORS, picked so no two members share one while there are slots left. */
  colorIndex: z.number().int().min(0).nullable().default(null),
});
export type Member = z.output<typeof memberSchema>;

/** Ten colours far apart on the wheel, a light and a dark variant each: [dark theme, light theme]. */
export const MEMBER_COLORS: ReadonlyArray<readonly [string, string]> = [
  ["#ff6b6b", "#d62828"], // red
  ["#4dabf7", "#1864ab"], // blue
  ["#51cf66", "#2b8a3e"], // green
  ["#ffa94d", "#d9480f"], // orange
  ["#cc5de8", "#862e9c"], // purple
  ["#3bc9db", "#0b7285"], // teal
  ["#f783ac", "#c2255c"], // pink
  ["#ffd43b", "#b08800"], // yellow
  ["#a9e34b", "#5c940d"], // lime
  ["#c0a080", "#7f5539"], // brown
];

export function memberColor(member: Pick<Member, "colorIndex" | "id">, isDark: boolean): string {
  const index = member.colorIndex ?? [...member.id].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return MEMBER_COLORS[index % MEMBER_COLORS.length]![isDark ? 0 : 1];
}

/** Your manager: not assigned tasks, but things to raise with them. */
export const managerSchema = z.object({
  name: z.string(),
  slackUserId: z.string().nullable().default(null),
});
export type Manager = z.output<typeof managerSchema>;

export const agendaItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean().default(false),
  createdAt: z.number(),
  doneAt: z.number().nullable().default(null),
});
export type AgendaItem = z.output<typeof agendaItemSchema>;

export const TEAM_STATUSES = ["todo", "doing", "blocked", "done"] as const;
export type TeamStatus = (typeof TEAM_STATUSES)[number];

export const teamUpdateSchema = z.object({
  at: z.number(),
  text: z.string(),
  /** Who wrote it: you on the board, the person on Slack (through the agent), or the agent itself. */
  by: z.enum(["me", "slack", "agent"]),
});

export const teamTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string().default(""),
  assigneeId: z.string().nullable().default(null),
  status: z.enum(TEAM_STATUSES).default("todo"),
  /** YYYY-MM-DD or null. */
  due: z.string().nullable().default(null),
  /** The research topic or project it belongs to. */
  topic: z.string().default(""),
  links: z.array(z.string()).default([]),
  updates: z.array(teamUpdateSchema).default([]),
  createdAt: z.number(),
  updatedAt: z.number(),
  doneAt: z.number().nullable().default(null),
  /** When the team agent last asked the assignee about it. */
  lastAskedAt: z.number().nullable().default(null),
});
export type TeamTask = z.output<typeof teamTaskSchema>;

/** A task the team agent spotted in Slack, waiting for your yes. */
export const suggestionSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string().default(""),
  assigneeId: z.string().nullable().default(null),
  from: z.string().default(""),
  permalink: z.string().default(""),
  createdAt: z.number(),
});
export type Suggestion = z.output<typeof suggestionSchema>;

export const teamFileSchema = z.object({
  members: z.array(memberSchema).default([]),
  tasks: z.array(teamTaskSchema).default([]),
  suggestions: z.array(suggestionSchema).default([]),
  manager: managerSchema.nullable().default(null),
  /** Things to raise with your manager. */
  agenda: z.array(agendaItemSchema).default([]),
});
export type TeamFile = z.output<typeof teamFileSchema>;

export const teamListRpc = defineRpc({
  name: "team.list",
  input: z.object({}),
  output: z.object({ members: z.array(memberSchema), tasks: z.array(teamTaskSchema), suggestions: z.array(suggestionSchema), manager: managerSchema.nullable().default(null), agenda: z.array(agendaItemSchema).default([]) }),
});

/** Sets your manager, or clears it (null). */
export const teamSetManagerRpc = defineRpc({
  name: "team.set-manager",
  input: z.object({ manager: z.object({ name: z.string().min(1).max(120), slackUserId: z.string().nullable() }).nullable() }),
  output: z.object({ manager: managerSchema.nullable() }),
});

export const teamAgendaRpc = defineRpc({
  name: "team.agenda",
  input: z.discriminatedUnion("op", [
    z.object({ op: z.literal("add"), text: z.string().min(1).max(1000) }),
    z.object({ op: z.literal("toggle"), id: z.string() }),
    z.object({ op: z.literal("delete"), id: z.string() }),
  ]),
  output: z.object({ agenda: z.array(agendaItemSchema) }),
});

export const teamSaveMemberRpc = defineRpc({
  name: "team.save-member",
  input: z.object({ id: z.string().optional(), name: z.string().min(1).max(120), slackUserId: z.string().nullable().optional(), role: z.string().max(120).optional() }),
  output: z.object({ member: memberSchema }),
});

export const teamDeleteMemberRpc = defineRpc({
  name: "team.delete-member",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

/** Adds a task (no id) or changes the given fields of one. */
export const teamSaveTaskRpc = defineRpc({
  name: "team.save-task",
  input: z.object({
    id: z.string().optional(),
    title: z.string().min(1).max(300).optional(),
    notes: z.string().max(20000).optional(),
    assigneeId: z.string().nullable().optional(),
    status: z.enum(TEAM_STATUSES).optional(),
    due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    topic: z.string().max(200).optional(),
    links: z.array(z.string().max(2000)).max(30).optional(),
  }),
  output: z.object({ task: teamTaskSchema }),
});

export const teamDeleteTaskRpc = defineRpc({
  name: "team.delete-task",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const teamAddUpdateRpc = defineRpc({
  name: "team.add-update",
  input: z.object({ id: z.string(), text: z.string().min(1).max(4000) }),
  output: z.object({ task: teamTaskSchema }),
});

export const teamSuggestionRpc = defineRpc({
  name: "team.suggestion",
  input: z.object({ id: z.string(), accept: z.boolean() }),
  output: z.object({ task: teamTaskSchema.nullable() }),
});

/** Slack people by name, to link a team member to their Slack account. */
export const teamSlackPeopleRpc = defineRpc({
  name: "team.slack-people",
  input: z.object({ query: z.string().max(80) }),
  output: z.object({ people: z.array(z.object({ id: z.string(), name: z.string(), title: z.string() })), error: z.string().nullable() }),
});
