import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const memberSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Their Slack user id, for DMs from the team agent; null until linked. */
  slackUserId: z.string().nullable().default(null),
  role: z.string().default(""),
});
export type Member = z.output<typeof memberSchema>;

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
});
export type TeamFile = z.output<typeof teamFileSchema>;

export const teamListRpc = defineRpc({
  name: "team.list",
  input: z.object({}),
  output: z.object({ members: z.array(memberSchema), tasks: z.array(teamTaskSchema), suggestions: z.array(suggestionSchema) }),
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
