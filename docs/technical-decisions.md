# Technical decisions

Last updated: 2026-10-04

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
6. **Messages go straight in.** Several people can send to the same thread. A message is handed to Claude right away. If Claude is busy it picks the message up when it can, sometimes inside the turn that is already running.
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
- In development, Vite serves the UI on port 5273 and forwards `/api` and `/ws` to the server on port 5274. The dev server keeps its data in its own file, `~/.acocrew/dev.db`, so trying things out never touches real threads.
- When the web app has been built (`pnpm build`), the server serves those files itself, so there is one process and one port.

Running it for real, apart from development:

- `pnpm stable` copies this checkout to `~/acocrew-stable`, builds it there and starts it in the tmux session `acocrew-stable` on port 5280, with the real data in `~/.acocrew/acocrew.db`. Editing, building or running `pnpm dev` in the checkout does not touch it. That is what lets acocrew be used to work on acocrew.
- Run `pnpm stable` again to update it. That restarts the server, so anything Claude is doing in a thread is cut short (the thread says so, and the next message resumes).
- Two settings let copies live side by side: `PORT` (default 5274) and `ACOCREW_DB` (default `~/.acocrew/acocrew.db`).
- `ACOCREW_HTTPS=1` is for a copy people reach through an https address. `pnpm stable` sets it. See Decision 8.

Commands, from the repo root:

| Command          | What it does                             |
| ---------------- | ---------------------------------------- |
| `pnpm dev`       | Runs the web app and the server together |
| `pnpm test`      | Runs tests                               |
| `pnpm typecheck` | Type checks every package                |
| `pnpm check`     | Checks formatting and lint rules         |
| `pnpm build`     | Builds the web app                       |
| `pnpm stable`    | Updates and restarts the copy people use |

## Decision 5: SQLite with Drizzle

Everything is stored in one SQLite file on the server machine: `~/.acocrew/acocrew.db`. The code talks to it through Drizzle (a library that lets us describe tables in TypeScript) with the `better-sqlite3` driver.

Why:

- One machine, one file, nothing to install or run next to the server. We have no reason to want Postgres.
- `better-sqlite3` answers right away instead of "later" (it is synchronous). That lets the server sign a browser up for a thread and read what is in the thread in one step, with nothing able to slip in between.

Tables:

| Table      | What it holds                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------- |
| `channels` | One row per repository: its name and folder path.                                               |
| `threads`  | Title, model, reasoning level, status, folder, branch, and Claude's session id for resuming.    |
| `events`   | A numbered log per thread. Each row is one whole item: a chat bubble, a tool card, or an error. |
| `user`     | One row per account: display name, username, whether it is an admin. See Decision 8.            |

The `events` log is only ever added to. A tool card is written twice (started, finished). When a thread is loaded, the newest row per item wins.

How table changes work (migrations):

1. Change `apps/server/src/schema.ts`.
2. Run `pnpm --filter @acocrew/server db:generate`. It writes a new SQL file into `apps/server/drizzle/`. Commit it.
3. Every time the server starts, it applies any SQL files that have not run yet. Nobody runs migrations by hand.

T3 Code does the same "apply on start" thing, but with hand-written SQL files and Effect's own SQL tools, not Drizzle.

## How one message travels

1. The browser posts the message to `/api/threads` (new thread) or `/api/threads/<id>/messages` (reply).
2. The server saves the user's bubble. If the thread has no Claude process, it starts one in the thread's folder (its worktree, or the repository folder; resuming the saved session if there is one). Then it pushes the message into that process's queue.
3. Separately, the server listens to each Claude process for as long as it lives, and turns everything Claude says into our own items (`apps/server/src/translate.ts`).
4. Words still being written are sent to open browsers right away and not saved. Finished bubbles and tool cards are saved to `events`, then sent.

Everything the browser shows comes down the WebSocket. On connect it gets all channels and threads. When it opens a thread it gets that thread's items, then live updates. Requests only go up over HTTP.

## How an image travels

Most people use acocrew from a different machine than the one Claude runs on, so an image has to get from their browser to the server first. We do it the way T3 Code does, minus the parts we do not need yet.

1. Pasting, dropping, or the attach button in the message box all give the browser the image as a file.
2. The browser sends that file to the server on its own (`POST /api/images`), right away. If the image is wider or taller than 2048 pixels, or of a kind the server does not take, the browser first redraws it as a smaller JPEG. The server takes PNG, JPEG, GIF and WebP up to 10MB.
3. The server saves it in an `attachments` folder next to the database and answers with an id. The id is the file name.
4. The message carries only the ids. They are saved with the message, so every device shows the image by asking the server for it (`GET /api/images/<id>`). A click on an image, in the message box or in a sent message, opens it big over the page.
5. When the message is handed to Claude, the server reads the files and puts the images in front of the words.

Left out for now: other file types, cleaning up images that were uploaded but never sent, and telling Claude where the file is on disk so it can copy it into the repository.

## How the message box knows what Claude can run

Typing `/` in the message box suggests what Claude can run. At the very start of a message that is every command (like `/compact`) and every skill. Later in a message it is skills only, because Claude runs a command only when the message starts with it, while a skill it also picks up from the middle. The message is sent exactly as typed.

1. The message box asks the server once when it opens (`GET /api/commands?thread=<id>`, or `?channel=<id>` for a thread that has not been started yet).
2. The server asks Claude itself. It starts a Claude process in the thread's folder (or the repository folder), calls `supportedCommands()`, and closes it. No message is sent, so it costs nothing and takes under a second. The answer is kept for a minute per folder.
3. Entries Claude marks as built in are shown under Commands. Everything else is a skill: from the folder's `.claude/skills`, from `~/.claude/skills` on the server machine, or from a plugin.

Why ask Claude and not read the skill folders ourselves (T3 Code reads the folders): Claude already applies its own rules, and we checked them in a live run. A skill name used in both places shows once. A skill marked as only for Claude is left out. Plugin skills and old-style command files are included. Reading the folders would mean rebuilding those rules and still missing plugins.

Some commands are hidden with one list of names in `apps/server/src/runner.ts`. They either only change how a terminal looks, or change settings that our own pickers or the server machine's Claude account own, or cut the thread off from its conversation. This matters on a shared machine: in a live run `/config theme=dark` wrote to the real settings file of the Claude account, and `/model` switched the model behind our picker. Hiding only keeps them out of the suggestions. Typing one by hand still sends it.

Also checked live: `/compact` works and shows the "summarized" note. A skill at the start of a message always runs. A skill named later in a message is up to Claude: it usually loads it, but it can also just answer. T3 Code moves such a skill to the front to force it. We do not.

## Decision 6: Always listen, and let Claude's own signals set the status

The first version read Claude's output only right after a user message, and assumed one message gives one answer. That is wrong, and it showed in a real thread: answers appeared one step late, and Claude changed things on a server while the thread said Done. Two things break the assumption:

- Claude starts turns on its own. When background work it started finishes (a long command, a subagent), it is told and reacts.
- A message sent while Claude is busy can be folded into the turn already running, so two messages can get one answer.

So the server does not count messages and answers. It listens all the time and works the status out from three signals in Claude's stream:

| Signal                                                 | Meaning                                        |
| ------------------------------------------------------ | ---------------------------------------------- |
| The main agent says something, or background work ends | A turn is on, until the next `result`          |
| `result`                                               | That turn is over                              |
| `background_tasks_changed`                             | The full list of background work still running |

| Status          | When                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------- |
| Working         | A turn is on                                                                              |
| Waiting         | No turn, but background work is still running. The thread lists what Claude is waiting on |
| Needs attention | Claude is waiting for a yes or an answer, or the last turn failed                         |
| Done            | Nothing going on                                                                          |

We checked the SDK for a ready-made "running / idle" signal. It exists in the type definitions (`session_state_changed`) but was not sent in a live run, so we do not rely on it.

A Claude process is closed after 10 minutes with nothing going on (no turn, no background work, no open question). The model, reasoning level, context window and fast mode are fixed when a process starts, so a change needs a new process. That would kill whatever the old one is doing, so it only happens when the old one has nothing going on. Otherwise the change waits. The next message to a closed process starts a new one that resumes the same session.

Other rules that follow from listening all the time:

- **Tool cards.** A card keeps what went in and what came out. A tool that only launches background work keeps its card open until that work ends.
- **Subagents.** What a subagent does is saved with a pointer to the card that started it, and shown inside that card.
- **Stop.** Stop asks Claude to wind down, then closes the process. That also kills its background work. Cards that were still open are marked failed. The next message resumes the session.

## Decision 7: Approvals are our own yes or no

Claude always runs in its normal mode, where it asks before any action that is not plainly safe (reading files never asks). It asks through a function of ours, `canUseTool`:

- **Full access** (the default): we say yes right away.
- **Ask first**: a panel pinned above the message box shows what Claude wants to do, with Approve and Decline. The thread goes to Needs attention until someone answers. A "..." menu holds two rarer choices:
  - **Always allow this session** is a yes that also stops Claude asking about that kind of action. Which actions it covers is Claude's own suggestion, and it can be wider than it sounds: after one file edit it covers all file edits, and also shell commands that only move or delete files in the repository. It lasts as long as that Claude process lives, so after a restart Claude asks again.
  - **Cancel** is a no that also ends Claude's turn.
- **Claude's own questions** (multiple choice) come through the same function and show in the same spot, in both modes. One question at a time. Clicking a choice moves to the next question, number keys pick a choice, and the message box doubles as "type your own answer". On the last question you press Send.

This mirrors T3 Code, with one difference: when Claude suggests no rule for "Always allow this session", T3 allows that whole tool for the session. We treat it as a single yes.

Access is picked in the message box and applies from the next message on. Anyone looking at the thread can answer a prompt.

Tests replay recordings of real Claude sessions (`apps/server/src/fixtures/`). `record.ts` in that folder makes a new one.

## Decision 8: Logins with Better Auth, behind our own routes

Nothing works without a login: no page data, no API route, no WebSocket. Logins are username and password. There is no email anywhere, and no sign-up page.

We use Better Auth, a library that runs inside our server and keeps its data in our SQLite file. It hashes passwords and hands out the login cookie. We did not pick a hosted service (Clerk, WorkOS): every install would need its own account with them and internet access to log in, which fights "one machine, one file".

How it is wired (`apps/server/src/auth.ts` and the top of `server.ts`):

- Only two of Better Auth's own routes can be reached from outside: log in (`/api/auth/sign-in/username`) and log out (`/api/auth/sign-out`). Everything else about accounts goes through small routes of our own, which call Better Auth on the server side. That keeps our rules in one place.
- Better Auth wants an email for every user. We give it a made-up one (`<random>@acocrew.local`) and never show it.
- Its four tables (`user`, `session`, `account`, `verification`) are in `schema.ts` and are migrated by Drizzle like the rest. `user` has three fields of ours: `admin`, `mustChangePassword` and `deleted`.
- The secret that signs login cookies is a file next to the database (`~/.acocrew/secret`), made on the first start.

The rules:

- **First start.** When there are no users, the server makes one admin: username `admin`, password `changeme`. Every thread and every message from before logins becomes theirs.
- **Temporary passwords.** A password the person did not pick themselves (the first admin's, a new account's, an admin's reset) only opens one screen: "Pick a new password". The server refuses everything else with 403 until that is done.
- **The server makes them.** When an admin adds a user or resets a password, nobody types the temporary password. The server makes 16 random characters and sends them back once, in the answer to that admin. Settings shows them in a popup with a Copy button, and the admin passes them on. They are not kept anywhere readable and not sent to anyone else. Once the popup is closed, the way to get a password is to reset again. Only the first admin's `changeme` is a fixed one.
- **Accounts come from admins.** In Settings, an admin can add a user, reset a password, make or unmake an admin, and delete a user. There is always at least one admin, and nobody can delete their own account.
- **Forgot your password?** Ask an admin to reset it. Settings asks "are you sure" first, because a reset logs that person out everywhere.
- **Deleting keeps the name.** A deleted account loses its password, its logins and its username (which can be given out again), but the row stays. So messages it wrote still show who wrote them.
- **Who wrote what.** A message from a person carries their user id (`userId` on the item). A thread keeps who started it (`threads.created_by`) and everyone who wrote in it (`threads.people`).
- **Everyone sees everyone.** The WebSocket's first message carries the list of people (id, display name, username, admin, deleted). A change to anyone is sent to all browsers. There are no per-channel permissions.
- **Picking a new password ends the other logins.** Whoever else was logged in to that account, on any device, is logged out. The browser that made the change stays in.
- **How long a login lasts.** Seven days from when it was last used. Each request hands the browser a fresh cookie when the login was extended.
- **Https only, when told so.** With `ACOCREW_HTTPS=1` the login cookie is marked "Secure": the browser never sends it over plain http, where anyone on the same network could read it and act as that person. This is how to run any copy that people reach through an https tunnel, and `pnpm stable` does. It is off by default, because the server itself only speaks plain http on localhost and cannot tell what is in front of it. While it is on, logging in works over https and on `localhost` only. Turning it on or off logs everyone out once, because the cookie's name changes.
- **Being logged out.** When a login ends (log out, a deleted account, a password reset or change), the server also hangs up that person's open WebSockets. Tabs that are still logged in connect again by themselves. The others ask the server who they are, hear "nobody", and show the login screen. The same happens when any request is answered with "Log in first".

Not built: email, Google login, a "forgot password" link, profile pictures, per-channel permissions, and a limit on login attempts. Better Auth has such a limit built in. It counts per caller address, and behind a tunnel that address has to be read from a header the tunnel sets, which differs per setup. Until that is set up it is off.

## UI direction: the Inbox layout

We mocked five layouts (Slack, Topics, Inbox, Board, Focus). Marcho likes the Inbox one, so `apps/web` now holds only that. The other four are still in git history, in commit `d98b9b7`.

What it looks like: three columns, like an email app. Channels on the left, the thread list in the middle, the open thread on the right. On a phone it shows one column at a time.

URLs: `/c/<channel>` for a channel, `/c/<channel>/t/<thread>` for a thread, `/c/<channel>/new` to start one, and `/add` to add a repository.

Rules of the UI:

- A channel is one git repository. "Add repository" lets you pick a folder under the home folder of the server machine. Only folders that are git repositories can be added.
- The bottom of the sidebar shows who is logged in. Clicking it opens a small menu with Settings and Log out. On a phone it is at the bottom of the slide-out sidebar.
- The thread list has two filters, each on its own row: whose threads (All threads, or Yours: the ones you started or wrote in) and their status (All, Needs attention, Working, Waiting, Done).
- A thread in the list shows the people who wrote in it as small overlapping pictures: the first letter of the name, on a color that person keeps everywhere. The first four show, the rest become a number.
- A message shows the display name of who wrote it. Changing your display name in Settings changes it on your old messages too.
- You cannot post a loose message in a channel. Every message starts a thread ("New Thread") or replies inside one.
- A new thread picks where it works, with two dropdowns side by side in a row of their own under "Start a thread". The first one picks between "New worktree" (the default) and "Existing worktree". The second one picks the branch: "from origin/main" for a new worktree, "on some-branch" for an existing one. Both lists can be searched by typing.
- A new worktree is a second working copy of the repository, on its own new branch. It is made with `git worktree add` when the thread starts. The folder is `worktrees/<repository name>/<first 8 characters of the thread id>`, next to the database (so `~/.acocrew/worktrees/...`). The branch is `acocrew/<the same 8 characters>`. If git cannot make the worktree, no thread is started and the message box shows git's reason.
- The branch a new worktree starts from defaults to the remote's main branch (what `origin/HEAD` points at, usually `origin/main`). A branch kept on a remote is fetched right before the worktree is made, so the thread starts from the newest commit there. A repository with no remote defaults to the branch its folder is on. The new branch does not follow the branch it started from, so a push from it does not aim there.
- An existing worktree is any working copy git lists for the repository, the repository folder included. This is for follow up threads. Each one shows its branch and the title of the thread that last worked in it, and the ones used last come first. Two threads in one folder share its files, the same way two terminals would.
- The server only takes a branch or a folder that git itself lists for that repository (`GET /api/channels/<id>/places` is the same list the dropdowns show). The folder is saved on the thread (`threads.path`; empty means the repository folder), and every Claude process of that thread starts there.
- The thread list shows the branch each thread was last on, under its title. Claude can switch branches while it works, so the server reads the branch again every time Claude finishes a turn and saves it on the thread (`threads.branch`). Nothing shows when the folder is on no branch.
- Not built yet for worktrees: removing a worktree, and installing dependencies in the new copy (`node_modules` is not there).
- The message box has a model picker, a reasoning picker, a context window picker (200k or 1M), a fast mode picker and an access picker (Full access or Ask first). A new thread starts on medium reasoning, 1M and fast mode off. A picker is only shown for models that have that setting. While Claude is doing something, the box also has a Stop button.
- Typing `/` in the message box opens a list of commands and skills right above it. It narrows as you type (later in a message only to names that start with what was typed, so a path like `/docs` is left alone). Arrow keys move, Enter or Tab picks, Escape closes, and a row can be clicked or tapped. Picking puts `/name ` into the box as plain text. While the box is answering a question from Claude, nothing is suggested.
- The 1M context window is asked for with `[1m]` after the model name. Leaving that off is not enough for 200k: in a live run the newer models still got 1M. So 200k also sets `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` for that Claude process. Fast mode is the `fastMode` setting, and it only really runs if the Claude account has extra usage switched on.

- Claude's answers are shown as formatted text (bold, lists, tables, code blocks with colors and a copy button). We use Streamdown for this, a markdown renderer made for AI chat: it copes with half-written formatting while the answer is still streaming in. Your own messages stay plain text, so what you type shows exactly as typed.
- Hovering a message (yours or Claude's) shows a copy button at its top right. It copies the message as it was written, so Claude's answers come out as markdown. Phones have no hover, so the button does not show there.
- Color names in the CSS follow shadcn/ui (`background`, `foreground`, `muted`, `border`, `primary` and so on), because Streamdown expects those names. The colors themselves are set once in `:root` in `apps/web/src/index.css`.

Not built yet: removing a repository, diagrams (mermaid), and showing images that live in the repository.

## Not decided yet

- How each thread's agent is kept away from other threads' files (sandboxing).
- Who can see which thread (today everyone logged in sees everything).
