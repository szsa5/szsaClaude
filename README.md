# szsaClaude

Claude Code skills and commands, shared from my own library. It is a plugin marketplace: install it once, then pick the
plugins you want; updates come with `/plugin marketplace update`.

## Install

The repo is private: you need to be invited as a collaborator (accept the GitHub e-mail), and git on your machine must
be able to reach GitHub as you (`gh auth login`, or an SSH key).

In Claude Code:

```
/plugin marketplace add szsa5/szsaClaude
/plugin install web-workflow@szsa
```

Then restart Claude Code (or run `/reload-plugins`). In a project, type `/comments`: the first run sets the project up.

### Had the old copy-paste install?

Remove the copies first, or every skill shows up twice:

```
rm -rf ~/.claude/skills/dev-comments ~/.claude/commands/comments.md
```

Projects you already set up keep working: their `integrations/dev-comments` and `.dev-comments/` stay as they are.

## Updates

```
/plugin marketplace update szsa
```

then `/plugin` → Installed → update the plugin if it offers one. To have it happen by itself, turn on auto-update for
the `szsa` marketplace in `/plugin` → Marketplaces (background updates of a private repo need a `GITHUB_TOKEN` in your
environment).

## What is in it

<!-- items: written by share.py -->
| Plugin | Install | What is in it |
|---|---|---|
| `web-workflow` | `/plugin install web-workflow@szsa` | `/comments`: Comments (dev-comments) - open the Comment Desk + watcher and show the menu; `dev-comments`: Use when the user wants to click on their running website and leave comments for Claude, "like Figma comments", instead of screenshotting and describing where a |
<!-- /items -->

The core (overlay, CLI, desk) runs anywhere Node runs. The Telegram alerts and the phone desk read secrets from the
macOS Keychain and use launchd; on Linux, use the environment variables and a systemd timer the skill mentions.
