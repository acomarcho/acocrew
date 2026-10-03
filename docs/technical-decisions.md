# Technical decisions

Last updated: 2026-10-03

## What we are building

A Slack-like chat app where people in a team can talk to AI coding agents in shared threads. The users are not technical. The agent runs on one central machine (a VM, or a laptop exposed through Cloudflare Tunnel or Tailscale), and everyone connects to that machine from their browser or phone.

Think of it as one shared T3 Code machine that a whole team can use.

## Where these decisions come from

We studied two existing apps that wrap Claude Code in a GUI:

- T3 Code (github.com/pingdotgg/t3code)
- Orca (github.com/stablyai/orca)

The decisions below are based on reading their source code. We learn from their patterns but do not copy their code.

## Decision 1: Claude first

We support Claude Code only at the start. Other agents (Codex, OpenCode, pi) come later.

Why:

- Every agent has its own message format, so every agent needs its own translator. That cost repeats per agent.
- Getting one agent working end to end teaches us what the shared parts need to look like.

What this means for the code: keep the Claude-specific code in one module, behind our own event types. The rest of the app should never see a raw Claude message.

## Decision 2: Use the Claude Agent SDK, like T3 Code does

We drive Claude through `@anthropic-ai/claude-agent-sdk` and its `query()` function. We do not run Claude in a terminal and show the raw terminal output (that is what Orca does by default).

Why:

- We want chat bubbles, tool cards and simple approve buttons. The SDK gives typed messages, which is what a chat UI needs. Terminal output is a painted screen and cannot be turned into chat messages reliably.
- Our users are not technical. A raw terminal is the wrong UI for them.
- Approvals are built in. The SDK calls a function of ours (`canUseTool`) and waits for the answer.

The patterns we take from T3 Code:

1. **The prompt is a queue that stays open.** We pass `query()` an async queue, not a string. Each new user message is pushed into that queue, so one Claude process serves the whole thread.
2. **Translate before sending to any screen.** Raw SDK messages are turned into our own events. Each event carries the whole item (for example the full chat bubble as it looks now) with a stable id, so receiving the same event twice is harmless.
3. **A permission prompt is a paused function call.** `canUseTool` creates a promise, stores it under a request id, and waits. The UI shows the question. The answer resolves the promise.
4. **Number everything, then fan out.** Every event is saved to a log and gets a number that only goes up. After saving, it is sent to every device subscribed to that thread over a WebSocket.
5. **Late joiners get a snapshot plus the rest.** A device that opens a thread mid-turn gets the current state stamped with a number, then only the events after that number. The server starts listening for that device first and takes the snapshot second, so nothing falls in the gap.
6. **One message at a time per thread.** Several people can send to the same thread. Messages are handled in order through a per-thread queue.
7. **Stop and resume.** Stop interrupts and closes the Claude process. The next message starts a new process that resumes the same session.

Sign-in: the central machine uses its own Claude Code login, the same way a shared T3 Code machine would. No separate organization API key.

## Decision 3: Simplified, without Effect

T3 Code is built on Effect, a TypeScript library for managing many things happening at once. We use plain TypeScript.

Why:

- Plain Node already has what the core needs: an async iterator for the queue, a Promise for the permission wait, a set of sockets for the fan-out, and `AbortController` for stop.
- Effect changes how every function is written. It makes the code harder to read for anyone who does not know it.
- Our hard problems are logins, who can see which thread, and keeping agents isolated from each other. Effect does not solve those.

We also start with a much smaller translator than T3's. Theirs is about 7,700 lines because it covers many edge cases. Ours starts with five message types:

| SDK message                  | What we do                               |
| ---------------------------- | ---------------------------------------- |
| `assistant` with text        | Create or update a chat bubble           |
| `assistant` with a tool call | Start a tool card                        |
| `user` with a tool result    | Finish that tool card                    |
| `stream_event`               | Show live pieces while Claude is writing |
| `result`                     | End the turn                             |

Left out at the start, added only when we need them: subagent views, steering mid-turn, fork and rollback, context compaction notices, rate limit tracking.

To keep the door open: the queue, the permission wait and the fan-out each live in their own small module. If the concurrency gets messy later, Effect can be added to those modules without rewriting the app.

## Decision 4: One repo, two apps, one shared package

The repo is a monorepo: one git repo that holds several apps plus the code they share.

```
apps/server      Node. Runs Claude, stores events and serves the WebSocket.
apps/web         The browser UI.
packages/shared  Types and constants that both sides import.
```

What each part uses:

| Part                                                  | Pick                                                  |
| ----------------------------------------------------- | ----------------------------------------------------- |
| Linking the folders                                   | pnpm workspaces                                       |
| Dev server, build, tests, lint, format, running tasks | Vite+ (the `vp` command)                              |
| Web                                                   | React, Tailwind, TanStack Router                      |
| Server                                                | Hono on Node, with the `ws` library for the WebSocket |

Why:

- **No Next.** The server must be one long-running process, because it holds the Claude process per thread, paused permission prompts and connected sockets in memory. Next is built around short request handlers.
- **TanStack Router** type checks links and URL parameters, so a renamed route fails the build instead of breaking for a user.
- **Vite+** is one tool for what would otherwise be five. It came out as 1.0 on 2026-09-28, so it is new. The tools inside it (Vite, Vitest, Oxlint, Oxfmt) are mature, and going back to them directly is a small change. T3 Code uses the same setup.
- **No build step for the server or shared code.** Node runs the TypeScript files directly.

Rules to keep:

- The web app only talks to the server over HTTP (`/api/...`) and the WebSocket (`/ws`). That keeps an Electron shell cheap to add later as `apps/desktop`.
- In development, Vite serves the UI on port 5273 and forwards `/api` and `/ws` to the server on port 5274. In production the plan is for the server to serve the built web files itself, so there is one process and one port. That part is not built yet.

Commands, from the repo root:

| Command          | What it does                             |
| ---------------- | ---------------------------------------- |
| `pnpm dev`       | Runs the web app and the server together |
| `pnpm test`      | Runs tests                               |
| `pnpm typecheck` | Type checks every package                |
| `pnpm check`     | Checks formatting and lint rules         |
| `pnpm build`     | Builds the web app                       |

## Decision 5: SQLite with Drizzle

Everything is stored in one SQLite file on the server machine: `~/.acocrew/acocrew.db`. The code talks to it through Drizzle (a library that lets us describe tables in TypeScript) with the `better-sqlite3` driver.

Why:

- One machine, one file, nothing to install or run next to the server. We have no reason to want Postgres.
- `better-sqlite3` answers right away instead of "later" (it is synchronous). That lets the server sign a browser up for a thread and read what is in the thread in one step, with nothing able to slip in between.

Tables:

| Table      | What it holds                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------- |
| `channels` | One row per repository: its name and folder path.                                               |
| `threads`  | Title, model, reasoning level, status, and Claude's session id so a thread can be resumed.      |
| `events`   | A numbered log per thread. Each row is one whole item: a chat bubble, a tool card, or an error. |

The `events` log is only ever added to. A tool card is written twice (started, finished). When a thread is loaded, the newest row per item wins.

How table changes work (migrations):

1. Change `apps/server/src/schema.ts`.
2. Run `pnpm --filter @acocrew/server db:generate`. It writes a new SQL file into `apps/server/drizzle/`. Commit it.
3. Every time the server starts, it applies any SQL files that have not run yet. Nobody runs migrations by hand.

T3 Code does the same "apply on start" thing, but with hand-written SQL files and Effect's own SQL tools, not Drizzle.

## How one message travels

1. The browser posts the message to `/api/threads` (new thread) or `/api/threads/<id>/messages` (reply).
2. The server saves the user's bubble, then lines the message up behind any turn still running in that thread.
3. If the thread has no Claude process, the server starts one in the repository folder (resuming the saved session if there is one) and pushes the message into its queue.
4. The server reads Claude's messages until the turn ends and turns them into our own items (`apps/server/src/translate.ts`).
5. Words still being written are sent to open browsers right away and not saved. Finished bubbles and tool cards are saved to `events`, then sent.
6. The thread's status goes from Working to Done, or to Needs you if the turn failed.

Everything the browser shows comes down the WebSocket. On connect it gets all channels and threads. When it opens a thread it gets that thread's items, then live updates. Requests only go up over HTTP.

A Claude process is closed when the model or reasoning level changes, or after 10 minutes without a message. The next message starts a new one that resumes the same session.

## UI direction: the Inbox layout

We mocked five layouts (Slack, Topics, Inbox, Board, Focus). Marcho likes the Inbox one, so `apps/web` now holds only that. The other four are still in git history, in commit `d98b9b7`.

What it looks like: three columns, like an email app. Channels on the left, the thread list in the middle, the open thread on the right. On a phone it shows one column at a time.

URLs: `/c/<channel>` for a channel, `/c/<channel>/t/<thread>` for a thread, `/c/<channel>/new` to start one, and `/add` to add a repository.

Rules of the UI:

- A channel is one git repository. "Add repository" lets you pick a folder under the home folder of the server machine. Only folders that are git repositories can be added.
- You cannot post a loose message in a channel. Every message starts a thread ("New Thread") or replies inside one.
- For now a thread works directly in the repository folder, on whatever branch it is on. The plan is for each thread to get its own worktree (its own copy of the repo on its own branch). That is not built yet.
- The message box has a model picker and a reasoning picker. No access picker for now; threads always run with full access.

Not built yet: logins (everyone posts as "You"), approval prompts, a stop button, removing a repository, and showing Claude's answers as formatted text (they show as plain text, so `**bold**` stays as typed).

## Not decided yet

- How each thread's agent is kept away from other threads' files (sandboxing).
- What approval rules non-technical users get by default.
- Logins and who can see which thread.
