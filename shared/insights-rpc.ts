import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * A model-written view of one agent, refreshed when a turn completes: a very
 * short description of the task for the card (`title`), and two sentences for
 * the details (`summary`): what the task is, and where it stands now.
 */
export const agentInsightSchema = z.object({
  agentId: z.string(),
  title: z.string(),
  summary: z.string(),
  /** Epoch ms the insight was written. */
  generatedAt: z.number(),
});
export type AgentInsight = z.output<typeof agentInsightSchema>;

/** The stored insights of these agents; agents without one are left out. */
export const insightsGetRpc = defineRpc({
  name: "insights.get",
  input: z.object({
    agentIds: z.array(z.string().min(1)).max(500),
    /** Agents to write an insight for when they have none yet (the board's active cards), a few per call. */
    ensure: z.array(z.string().min(1)).max(50).optional(),
  }),
  output: z.object({ insights: z.array(agentInsightSchema), available: z.boolean() }),
});

/** Writes the agent's insight again now (the details' refresh button). */
export const insightsRefreshRpc = defineRpc({
  name: "insights.refresh",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable(), insight: agentInsightSchema.nullable() }),
});
