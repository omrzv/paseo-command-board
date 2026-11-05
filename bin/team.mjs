#!/usr/bin/env node
// The team agent's tool: reads and changes the board's team tasks, and talks to
// team members on Slack with the board's Slack token. Output is JSON.
//
//   team status                                   members, open tasks, suggestions
//   team update <taskId> <text> [--by slack|agent]
//   team set <taskId> [--status todo|doing|blocked|done] [--due YYYY-MM-DD|none]
//   team asked <taskId...>                        record that the assignee was just asked
//   team suggest --title T [--assignee NAME] [--from WHO] [--link URL] [--notes N]
//   team dm <member> <text>                       DM a member (name or id) as you
//   team replies <member> [--since ISO|epoch]     their DM messages to you since then
//   team slack-search <query>                     Slack search (your messages scope)
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DATA = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "better-paseo");
const TEAM = join(DATA, "team.json");
const SLACK = join(DATA, "slack.json");
const STATUSES = ["todo", "doing", "blocked", "done"];

const out = (value) => { process.stdout.write(JSON.stringify(value, null, 2) + "\n"); };
const fail = (message) => { process.stderr.write(`team: ${message}\n`); process.exit(1); };

function load() {
  try {
    const data = JSON.parse(readFileSync(TEAM, "utf8"));
    return { members: data.members ?? [], tasks: data.tasks ?? [], suggestions: data.suggestions ?? [] };
  } catch {
    return { members: [], tasks: [], suggestions: [] };
  }
}
function save(data) {
  mkdirSync(dirname(TEAM), { recursive: true });
  const temp = `${TEAM}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(temp, TEAM);
}
function flags(args) {
  const named = {}; const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) { named[args[i].slice(2)] = args[i + 1] ?? ""; i++; } else rest.push(args[i]);
  }
  return { named, rest };
}
function member(data, who) {
  const key = String(who ?? "").toLowerCase();
  const found = data.members.find((m) => m.id === who) ?? data.members.find((m) => m.name.toLowerCase() === key) ?? data.members.find((m) => m.name.toLowerCase().includes(key));
  if (!found) fail(`no team member "${who}"`);
  return found;
}
function task(data, id) {
  const found = data.tasks.find((t) => t.id === id || t.id.startsWith(id));
  if (!found) fail(`no task "${id}"`);
  return found;
}
async function slack(method, params) {
  let token = null;
  try { token = JSON.parse(readFileSync(SLACK, "utf8")).token; } catch { /* none */ }
  if (!token) fail("Slack is not connected on the board");
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])),
  });
  const body = await response.json();
  if (!body.ok) fail(`Slack ${method}: ${body.error}`);
  return body;
}
async function dmChannel(m) {
  if (!m.slackUserId) fail(`${m.name} is not linked to Slack (link them in the board's Team panel)`);
  return (await slack("conversations.open", { users: m.slackUserId })).channel.id;
}
const since = (value) => (value ? (/^\d+(\.\d+)?$/.test(value) ? Number(value) * (value.length > 11 ? 1 : 1000) : Date.parse(value)) : Date.now() - 7 * 86_400_000);

const [command, ...args] = process.argv.slice(2);
const { named, rest } = flags(args);
const data = load();
const nameOf = (id) => data.members.find((m) => m.id === id)?.name ?? null;

switch (command) {
  case "status": {
    out({
      members: data.members.map((m) => ({ id: m.id, name: m.name, role: m.role, slackLinked: Boolean(m.slackUserId) })),
      tasks: data.tasks.filter((t) => t.status !== "done").map((t) => ({
        id: t.id, title: t.title, assignee: nameOf(t.assigneeId), status: t.status, due: t.due, topic: t.topic,
        lastUpdate: t.updates.at(-1) ?? null, lastAskedAt: t.lastAskedAt ? new Date(t.lastAskedAt).toISOString() : null,
        updatedAt: new Date(t.updatedAt).toISOString(),
      })),
      pendingSuggestions: data.suggestions.map((s) => ({ title: s.title, assignee: nameOf(s.assigneeId), permalink: s.permalink })),
    });
    break;
  }
  case "update": {
    const [id, ...words] = rest;
    const text = words.join(" ").trim();
    if (!id || !text) fail("usage: team update <taskId> <text>");
    const t = task(data, id);
    const by = ["slack", "agent"].includes(named.by) ? named.by : "agent";
    t.updates.push({ at: Date.now(), text, by });
    t.updatedAt = Date.now();
    save(data);
    out({ ok: true, task: t.id });
    break;
  }
  case "set": {
    const t = task(data, rest[0]);
    if (named.status) {
      if (!STATUSES.includes(named.status)) fail(`status must be one of ${STATUSES.join(", ")}`);
      if (named.status !== t.status) t.updates.push({ at: Date.now(), text: `Status: ${t.status} → ${named.status}`, by: "agent" });
      t.status = named.status;
      t.doneAt = named.status === "done" ? Date.now() : null;
    }
    if (named.due !== undefined) t.due = named.due === "none" ? null : named.due;
    t.updatedAt = Date.now();
    save(data);
    out({ ok: true, task: t.id, status: t.status, due: t.due });
    break;
  }
  case "asked": {
    for (const id of rest) task(data, id).lastAskedAt = Date.now();
    save(data);
    out({ ok: true, asked: rest.length });
    break;
  }
  case "suggest": {
    if (!named.title) fail("usage: team suggest --title T [--assignee NAME] [--from WHO] [--link URL] [--notes N]");
    if (named.link && (data.suggestions.some((s) => s.permalink === named.link) || data.tasks.some((t) => t.links.includes(named.link)))) {
      out({ ok: true, skipped: "already suggested or a task" });
      break;
    }
    data.suggestions.push({
      id: randomUUID(), title: named.title, notes: named.notes ?? "", assigneeId: named.assignee ? member(data, named.assignee).id : null,
      from: named.from ?? "", permalink: named.link ?? "", createdAt: Date.now(),
    });
    save(data);
    out({ ok: true });
    break;
  }
  case "dm": {
    const [who, ...words] = rest;
    const text = words.join(" ").trim();
    if (!who || !text) fail("usage: team dm <member> <text>");
    const m = member(data, who);
    const channel = await dmChannel(m);
    const sent = await slack("chat.postMessage", { channel, text });
    out({ ok: true, to: m.name, channel, ts: sent.ts });
    break;
  }
  case "replies": {
    const m = member(data, rest[0]);
    const channel = await dmChannel(m);
    const oldest = (since(named.since) / 1000).toFixed(6);
    const history = await slack("conversations.history", { channel, oldest, limit: 100 });
    out({
      from: m.name,
      messages: (history.messages ?? []).filter((msg) => msg.user === m.slackUserId).reverse()
        .map((msg) => ({ at: new Date(Number(msg.ts) * 1000).toISOString(), text: msg.text })),
    });
    break;
  }
  case "slack-search": {
    const query = rest.join(" ");
    if (!query) fail("usage: team slack-search <query>");
    const result = await slack("search.messages", { query, count: 30, sort: "timestamp" });
    out((result.messages?.matches ?? []).map((msg) => ({
      at: new Date(Number(msg.ts) * 1000).toISOString(), from: msg.username, where: msg.channel?.name, text: msg.text, permalink: msg.permalink,
    })));
    break;
  }
  default:
    fail("commands: status, update, set, asked, suggest, dm, replies, slack-search");
}
