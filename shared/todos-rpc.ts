import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** A to-do of the person's own: not from Slack, not an agent's. */
export const todoSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string(),
  /** A day to do it by (YYYY-MM-DD), or null. */
  due: z.string().nullable(),
  done: z.boolean(),
  createdAt: z.number(),
  doneAt: z.number().nullable(),
  /** Links kept with the task (from the Slack message it came from, or added). */
  links: z.array(z.string()).default([]),
  /** Where it came from: a Slack message keeps who wrote it, where, and its permalink. */
  source: z.object({ kind: z.literal("slack"), from: z.string(), where: z.string(), permalink: z.string(), slackId: z.string(), threadTs: z.string().optional(), direct: z.boolean().optional() }).nullable().default(null),
  /** The agent started from this task, once there is one. */
  agentId: z.string().nullable().default(null),
});
export type Todo = z.output<typeof todoSchema>;

/** Open to-dos, and the ones done in the last week. */
export const todosListRpc = defineRpc({
  name: "todos.list",
  input: z.object({}),
  output: z.object({ todos: z.array(todoSchema) }),
});

export const todosAddRpc = defineRpc({
  name: "todos.add",
  input: z.object({
    title: z.string().trim().min(1).max(500),
    notes: z.string().max(10_000).optional(),
    due: z.string().nullable().optional(),
    links: z.array(z.string().max(2000)).max(20).optional(),
    source: todoSchema.shape.source.optional(),
  }),
  output: z.object({ todo: todoSchema }),
});

export const todosUpdateRpc = defineRpc({
  name: "todos.update",
  input: z.object({
    id: z.string().min(1),
    title: z.string().trim().min(1).max(500).optional(),
    notes: z.string().max(10_000).optional(),
    due: z.string().nullable().optional(),
    done: z.boolean().optional(),
    agentId: z.string().nullable().optional(),
  }),
  output: z.object({ todo: todoSchema.nullable() }),
});

export const todosDeleteRpc = defineRpc({
  name: "todos.delete",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ ok: z.boolean() }),
});
