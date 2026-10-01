# szsaClaude

Claude Code skills and commands.

## dev-comments + `/comments`

Click on your running website, pin a comment to an element, and Claude picks it up: it reads the comment,
screenshots the spot at your screen width, fixes it, replies and resolves. Works with any stack (Vite, Astro,
Next.js, Django, Rails, Laravel, WordPress, plain static sites). Also included: the Comment Desk (a local page with
a private workbench per comment), optional Telegram alerts, and a phone version of the desk.

- `skills/dev-comments/SKILL.md`: the spec (behaviour, file format, interface, security rules, agent loop)
- `skills/dev-comments/assets/`: reference implementation (browser JS + Node, no dependencies; `shot` uses Playwright)
- `skills/dev-comments/examples/hosted-desk/wordpress/`: one worked example of a staging store and the phone desk
- `commands/comments.md`: the `/comments` slash command

### Install

```sh
git clone https://github.com/szsa5/szsaClaude.git
mkdir -p ~/.claude/skills ~/.claude/commands
cp -R szsaClaude/skills/dev-comments ~/.claude/skills/
cp szsaClaude/commands/comments.md ~/.claude/commands/
```

Then, in any project, type `/comments` in Claude Code. The first run sets the project up.

The core (overlay, CLI, desk) runs anywhere Node runs. The Telegram alerts and the phone desk read secrets from the
macOS Keychain and use launchd; on Linux, use the environment variables and a systemd timer the skill mentions.
