# Paseo Command Board (fork of Better Paseo)

A personal fork of [RoundRedDot/better-paseo](https://github.com/RoundRedDot/better-paseo) that
turns its Tasks board into one place to manage work. `upstream` points at Better Paseo; new code
lives in its own modules so upstream changes merge cleanly. The plugin id stays `better-paseo`,
so settings and turn history carry over.

## What the fork adds

- **Sticky review.** A finished turn stays in *To review* after its tab is opened. It leaves only
  when you reply (a new turn starts), press **Done** (formerly Mark as read), or archive it. The
  server keeps the marks in `tasks-reviews.json` (`server/tasks/register.ts`; the client side is
  `withReadMark` and `syncPendingReviews` in `client/tasks/data/index.ts`).
- **Insights.** When a top-level agent's turn completes, a small model (`claude -p --model haiku`,
  through your own Claude Code login) writes a 3–7 word task description and a two-sentence
  summary: what the task is, and where it stands (`server/insights.ts`, `shared/insights-rpc.ts`).
  Cards show the description as their title. The details panel shows the summary under the header.
- **Reply from the board.** The details panel puts the agent's last reply first, then a reply box
  that sends straight to the agent (`agents.ref(id).send`). The first prompt starts folded.
- **Project colour.** Each card carries a stripe in its project's colour (the icon's colour, or
  Paseo's identity colour), and its project › workspace line is bold in that colour.

## Planned

- Slack inbox: Slack messages that are tasks for you (especially review requests for Claude
  artifacts, PRs and docs) as cards on the board.

## Install

```bash
paseo plugin remove better-paseo   # the upstream install shares the plugin id
paseo plugin install git:omrzv/paseo-command-board
```
