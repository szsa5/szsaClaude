# szsaClaude: dev-comments for Claude Code

Click on your running website, pin a comment to an element, and Claude picks it up: it reads the comment,
screenshots the spot at your screen width, fixes it, replies and resolves. Works with any stack (Vite, Astro,
Next.js, Django, Rails, Laravel, WordPress, plain static sites). Paste or drop screenshots into a note, or double-tap
C to comment on whatever is under the cursor. Also included: the Comment Desk (a local page with a private workbench
per comment, before/after shots, a "Ready to push" tick, options shown as pictures to choose from), optional Telegram
alerts, and a phone version of the desk.

## Install

In Claude Code (the terminal, or the **Code tab of Claude Desktop**):

```
/plugin marketplace add szsa5/szsaClaude
/plugin install dev-comments@szsa
```

Restart Claude Code (or run `/reload-plugins`). Then, in a project, type `/comments`: the first run sets it up.

Had the old copy-paste install? Remove it first, or everything shows up twice:
`rm -rf ~/.claude/skills/dev-comments ~/.claude/commands/comments.md`. Projects you already set up keep working.

It runs on your own computer (it starts a small local server next to your dev server), so it needs Claude Code;
Claude's plain chat cannot run it.

## Updates

```
/plugin marketplace update szsa
```

then `/plugin` → Installed → update `dev-comments` if it offers one (its version changes whenever its content does).

## What is in it

<!-- items: written by share.py -->

### dev-comments

`/plugin install dev-comments@szsa` · Click on your running website, pin a comment to an element, and Claude reads it, fixes it, replies and resolves. /comments opens the Comment Desk.

- `/comments`: Comments (dev-comments) - open the Comment Desk + watcher and show the menu
- `dev-comments`: Use when the user wants to click on their running website and leave comments for Claude, "like Figma comments", instead of screenshotting and describing where a change…

<!-- /items -->

Needs Node 18+ (the overlay, CLI and desk have no other dependencies; screenshots use Playwright). The Telegram
alerts and the phone desk read secrets from the macOS Keychain and use launchd; on Linux, use the environment
variables and a systemd timer the skill mentions.

## How the repo is built

```
.claude-plugin/marketplace.json                  the catalogue (marketplace "szsa")
plugins/dev-comments/
  .claude-plugin/plugin.json                     name, version, description
  commands/comments.md                           the /comments command
  skills/dev-comments/SKILL.md                   the spec: behaviour, file format, interface, security rules, agent loop
  skills/dev-comments/assets/                    the reference implementation (browser JS + Node)
  skills/dev-comments/examples/hosted-desk/      one worked example of the phone desk (WordPress)
```

## How sharing works

Nothing here is written by hand. I keep the skill in my private library and run `/share dev-comments` there after a
change. That copies it into this repo, cleans the copy (names of people, clients and projects, hosts and dated notes
are replaced with generic words or the placeholders Noor, Tobias and bluefinch), checks every file against a list of
private words, bumps the version, and pushes.

So **don't edit files here**: the next share overwrites them. Found a bug or have an improvement? Open an issue or a
pull request; I take it into the library and it comes back with the next share.

Want to pass it on? Send them this repo's link: installed from here it keeps updating, a copy of the files does not.
