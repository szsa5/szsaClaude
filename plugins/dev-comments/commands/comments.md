---
description: Comments (dev-comments) - open the Comment Desk + watcher and show the menu. Args - help | alerts [status|test|stop] | phone | review
---
Load the `dev-comments` skill. Everything about comments in this project goes through this one command.

**No argument: open the desk and work.** This is what the owner types in an empty session.
1. Not set up yet (no `.comment-desk.json` at the repo root)? Set it up first: the overlay (skill: How it is built),
   the desk (skill: Comment Desk, "Set up in a project"), and ask once, in plain words: "Do you also want (1) a
   Telegram message when someone comments, and (2) the desk on your phone?" Set up what they say yes to (`alerts`,
   `phone` below).
2. Make sure the desk server runs (`node <desk>/desk.mjs serve`) as a long-running process in its own terminal tab
   or pane, not in this session's shell; reuse one that already runs.
3. Start `node <desk>/desk.mjs wait` in the background of THIS session and open `http://127.0.0.1:<port>/`.
4. Every time the watcher exits: handle each printed message (look at pasted images), answer in that card's
   workbench with `desk.mjs say`, keep each card's note current (`desk.mjs note`), then start `wait` again.
   Never post to a public source (staging) unless the owner uses its own reply box; never commit, push or deploy
   unless they say so for that work.

**Building or changing any part of it** (a new project, a new stack, a new feature on the overlay, CLI, desk or a
shared endpoint): follow the skill's **"Security: what every build must get right"** in full, and run its hostile
notes test (rule 8) before calling it done. In short:
- a comment's fields are untrusted;
- escape everything that goes into HTML;
- a comment's url is only a same-site path;
- local servers check Host and Origin and accept JSON only;
- the agent's channel takes writes from the owner only;
- a shared site closes the framework's generic write path.

**Always end** (no argument, and `help`) **with this menu**, filled in for this project (✓ = set up, – = not yet),
so the owner never has to remember the options:

```
/comments            open the desk + watcher (what you just ran)        ✓
/comments alerts     Telegram message when someone comments             ✓/–
                     alerts status · alerts test · alerts stop
/comments phone      the desk on your phone (2FA, approve on Telegram)  ✓/–
/comments review     the older review board (artifact)
Desk: http://127.0.0.1:<port>/ · approve phone messages: reply "ok" on Telegram (or "pending")
```
`help` shows only the menu and does nothing else.

**`phone`**: set up the phone copy of the desk (skill: Hosted desk). Its requirements are mandatory; the
implementation fits the project's stack (`examples/hosted-desk/wordpress/` in the skill is one worked example).
Register the project with the Telegram listener. Test everything, including the planted message, before asking the
owner to go live; never deploy it without their go-ahead.

**`alerts`**: the hourly check of the project's staging comments with a Telegram message when someone writes
(skill: Comment watch). Set up or repair, skipping what is done. `alerts status` = job loaded, last log lines, chat
id; `alerts test` = a test message; `alerts stop` = unload the job (keep its definition). The bot token is in the
OS keychain (`dev-comments-telegram`), shared by all projects; never ask for it in chat.

**`review`**: the older artifact board of every unresolved comment (skill: Comment review board), and carrying out
the answers typed on it.

$ARGUMENTS
