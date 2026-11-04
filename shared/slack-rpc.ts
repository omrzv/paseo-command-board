import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** What a Slack message asks of the person, as the classifier read it. */
export const slackKindSchema = z.enum(["review", "request", "question"]);
export type SlackKind = z.output<typeof slackKindSchema>;

/**
 * A Slack message that is a task for the person: a review request (Claude
 * artifacts, PRs, docs), something to do, or a question to answer.
 * `replied` means the person wrote in that conversation (or thread) after it.
 */
export const slackItemSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  /** "@dana", "#eng-platform", "Group DM". */
  where: z.string(),
  from: z.string(),
  text: z.string(),
  permalink: z.string(),
  /** Epoch ms of the message. */
  at: z.number(),
  kind: slackKindSchema,
  /** A very short description of what to do. */
  title: z.string(),
  /** Review links found in the message: claude.ai artifacts, PRs, docs. */
  links: z.array(z.string()),
  state: z.enum(["open", "done", "dismissed"]),
  replied: z.boolean(),
  /** The thread the message sits in, when it is a thread reply. */
  threadTs: z.string().optional(),
  /** A DM or group DM, not a channel. */
  direct: z.boolean().optional(),
});
export type SlackItem = z.output<typeof slackItemSchema>;

export const slackStatusSchema = z.object({
  connected: z.boolean(),
  team: z.string().nullable(),
  user: z.string().nullable(),
  lastScanAt: z.number().nullable(),
  scanning: z.boolean(),
  error: z.string().nullable(),
});
export type SlackStatus = z.output<typeof slackStatusSchema>;

/** Saves a user token (xoxp-) on the daemon after checking it with Slack. The token never comes back out. */
export const slackConnectRpc = defineRpc({
  name: "slack.connect",
  input: z.object({ token: z.string().min(10).max(300) }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable(), status: slackStatusSchema }),
});

export const slackDisconnectRpc = defineRpc({
  name: "slack.disconnect",
  input: z.object({}),
  output: z.object({ status: slackStatusSchema }),
});

export const slackStatusRpc = defineRpc({
  name: "slack.status",
  input: z.object({}),
  output: z.object({ status: slackStatusSchema }),
});

/** Open items, and the ones closed in the last day so a mistaken Done can be undone. */
export const slackInboxRpc = defineRpc({
  name: "slack.inbox",
  input: z.object({}),
  output: z.object({ items: z.array(slackItemSchema), status: slackStatusSchema }),
});

export const slackSetStateRpc = defineRpc({
  name: "slack.set-state",
  input: z.object({ id: z.string().min(1), state: z.enum(["open", "done", "dismissed"]) }),
  output: z.object({ ok: z.boolean() }),
});

/** Scans now instead of at the next interval. Returns when the scan has started, not finished. */
export const slackScanRpc = defineRpc({
  name: "slack.scan",
  input: z.object({}),
  output: z.object({ status: slackStatusSchema }),
});

/**
 * Posts a reply as the person, always in the message's thread. `broadcast`
 * also shows it in the channel or DM, like Slack's "Also send to …" box.
 * Needs the chat:write user scope.
 */
export const slackReplyRpc = defineRpc({
  name: "slack.reply",
  input: z.object({ id: z.string().min(1), text: z.string().min(1).max(8000), broadcast: z.boolean().optional() }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});
