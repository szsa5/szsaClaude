#!/usr/bin/env bash
# EXAMPLE for a WordPress staging site reached over SSH. Fill in the settings below for your project.
# One-time setup of the hidden Comment Desk on STAGING (comment-desk.php; dev-comments skill → Hosted desk). Creates, and never prints:
#   - a random hidden path (24 characters),
#   - a token for Claude's tools on the Mac       → macOS Keychain, service "comment-desk-token:$PROJECT",
#   - the authenticator (2FA) secret               → the server's config, a QR code to scan once, and the Keychain
#     (service "comment-desk-totp:$PROJECT", the otpauth:// link, to set up a new phone),
# writes the server's config (<staging root>/.comment-desk/config.json, web access denied; secrets sent through
# ssh's input, never on a command line) and points the Mac desk at it
# (.comment-desk.local.json, git-ignored).
#   comment-desk-setup.sh            first setup (refuses when the desk already exists)
#   comment-desk-setup.sh --rotate   new path, token and 2FA secret (the old ones stop working; scan the new QR)
# Signing in: your staging login, then the 6-digit code from the authenticator app. No other password.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
# --- settings (example values: replace them, or pass them as environment variables) ---
PROJECT="${PROJECT:-bluefinch}"                       # short name, used for the Keychain entries
host="${SSH_HOST:-deploy@staging.bluefinch.example}"  # SSH user@host of the staging server
key="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
root="${STAGING_ROOT:-/var/www/staging}"               # WordPress root of STAGING (never production)
site="${STAGING_URL:-https://staging.bluefinch.example}"
login="${STAGING_LOGIN:-noor}"                           # your staging (basic auth) login
me="${DESK_ME:-Noor}"                                    # your name as it signs replies
audience="${DESK_AUDIENCE:-Tobias}"                      # who reads the staging comments (the reviewer)
ssh_() { ssh -i "$key" -o BatchMode=yes "$host" "$@"; }

if ssh_ "test -f $root/.comment-desk/config.json" && [ "${1:-}" != "--rotate" ]; then
  echo "The desk is already set up on staging. Use --rotate for a new path, token and 2FA secret."; exit 1
fi
slug="$(python3 -c "import secrets,string;a=string.ascii_lowercase+string.digits;print(''.join(secrets.choice(a) for _ in range(24)))")"
token="$(python3 -c "import secrets;print(secrets.token_hex(24))")"
secret="$(python3 -c "import secrets;print(secrets.token_hex(32))")"
totp="$(python3 -c "import base64,secrets;print(base64.b32encode(secrets.token_bytes(20)).decode().rstrip('='))")"

# the server: a folder the web can't read, and the config
ssh_ "mkdir -p $root/.comment-desk && printf 'Require all denied\n' > $root/.comment-desk/.htaccess && printf '<?php // silence\n' > $root/.comment-desk/index.php && chmod 700 $root/.comment-desk" >/dev/null   # only the desk's own folder: the web root must stay 711
printf '%s\n%s\n%s\n%s\n' "$slug" "$token" "$secret" "$totp" | ssh_ "php -r '
  [\$slug, \$token, \$secret, \$totp] = array_map(\"trim\", array_slice(explode(\"\n\", stream_get_contents(STDIN)), 0, 4));
  \$old = json_decode((string) @file_get_contents(\"$root/.comment-desk/config.json\"), true) ?: []; unset(\$old[\"passHash\"]);
  \$cfg = array_merge([\"logins\" => [\"$login\"], \"me\" => \"$me\", \"project\" => \"$PROJECT\", \"audience\" => \"$audience\", \"label\" => \"$audience · staging\", \"room\" => \"On staging · $audience sees this\"], \$old,
    [\"slug\" => \$slug, \"token\" => \$token, \"secret\" => \$secret, \"totp\" => \$totp]);
  @unlink(\"$root/.comment-desk/totp-last\"); @unlink(\"$root/.comment-desk/fails.json\");
  file_put_contents(\"$root/.comment-desk/config.json\", json_encode(\$cfg, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
  chmod(\"$root/.comment-desk/config.json\", 0600);
  echo \"server config written\n\";'"

# what the Mac desk holds so far (Claude's notes, the workbench chats, pasted images) moves to the server once, so
# nothing is lost when the Mac starts using the shared store; an existing store on the server is never overwritten
if [ -f "$here/.comment-desk/state.json" ] && ! ssh_ "test -f $root/.comment-desk/state.json"; then
  ssh_ "cat > $root/.comment-desk/state.json" < "$here/.comment-desk/state.json"
  [ -d "$here/.comment-desk/uploads" ] && tar -C "$here/.comment-desk" -cf - uploads | ssh_ "tar -C $root/.comment-desk -xf -"
  echo "moved the Mac desk's notes and chats to the server"
fi

# the Mac: the Keychain and the desk's local settings
security add-generic-password -U -s "comment-desk-token:$PROJECT" -a "$USER" -w "$token"
uri="otpauth://totp/Notes:$login?secret=$totp&issuer=Notes&algorithm=SHA1&digits=6&period=30"
security add-generic-password -U -s "comment-desk-totp:$PROJECT" -a "$USER" -w "$uri"
qr="$(mktemp -d)/scan-me.png"
uv run -q --with 'qrcode[pil]' python -c "import qrcode,sys; qrcode.make(sys.argv[1]).save(sys.argv[2])" "$uri" "$qr"
open "$qr"
echo "Scan the QR code (now open) with your authenticator app, then delete it: rm -r $(dirname "$qr")"
python3 - "$here" "$slug" "$site" "$PROJECT" <<'PY'
import json, os, sys
here, slug, site, project = sys.argv[1:]
p = os.path.join(here, '.comment-desk.local.json')
d = json.load(open(p)) if os.path.exists(p) else {}
d["remote"] = {"url": f"{site}/{slug}", "authFile": ".staging-login.txt", "tokenKeychain": f"comment-desk-token:{project}"}
json.dump(d, open(p, 'w'), indent=2); open(p, 'a').write('\n')
print('Mac desk pointed at the hosted desk (.comment-desk.local.json)')
PY
echo "Done. Sign in with your staging login and the code from your authenticator app."
