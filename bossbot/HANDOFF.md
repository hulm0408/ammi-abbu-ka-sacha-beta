# Handoff — what to paste in a new chat

A new Arena session starts with **no memory of the previous conversation**. Open
the new session on the **`hulm0408/bossbot`** repository and paste the block
below. It contains everything needed to finish the job in one go.

---

## Paste this 👇

````text
Repo: hulm0408/bossbot (this repository is EMPTY, default branch main).

TASK: populate it with the finished "bossbot" project.

Source of truth: the `bossbot/` folder of hulm0408/ammi-abbu-ka-sacha-beta
on branch `main`. Read-only access to that repo is fine; do not modify it.

Steps:
1. Pull only that folder into this repo's root (it must become the ROOT of
   this repo, not a subfolder):

   curl -L https://codeload.github.com/hulm0408/ammi-abbu-ka-sacha-beta/tar.gz/refs/heads/main \
     | tar -xz --strip-components=2 ammi-abbu-ka-sacha-beta-main/bossbot

2. Delete the two parent-repo helper files (they are meaningless here):
   rm -f STANDALONE.md push.sh

3. In render.yaml remove the line `rootDir: bossbot` and change the disk
   mountPath from `/opt/render/project/src/bossbot/vendor/data` to
   `/opt/render/project/src/vendor/data` (this IS the repo root now).

4. Verify before committing:
   npm install --omit=dev --ignore-scripts
   npm test          # must print "RESULT: 49/49 checks passed"
   node --check bot.js && node --check engine.js && node --check main.js
   Also boot-smoke it: BOT_TOKEN=fake:token BOSS_IDS=1 PORT=8099 node main.js
   → must print a health line, log "Telegram launch failed", and exit code 1.

5. Commit and push:
   git init -b main && git add -A
   git commit -m "bossbot: two links in, one tap, tracking out — inside Telegram"
   git remote add origin https://github.com/hulm0408/bossbot.git
   git push -u origin main

6. Make the repo PRIVATE if it is public (it stores order/session data at
   runtime under vendor/data, which is gitignored but should not be public).

RULES:
- Do not modify anything inside vendor/ — it is a verified copy of a
  production Swiggy engine.
- No secrets in the repo: no tokens, no cookies, no .env, no data/.
- Never ask for or accept a GitHub PAT pasted into chat.
- Keep the flow exactly as designed (see README.md): boss sends/forwards the
  two links → boss confirms → QR to the boss; a user sends the links → that
  user confirms → QR to the user; after the tap everything is automatic.

When done, report: files pushed, test result, and the Render settings
(Root Directory empty, build `npm install --omit=dev --ignore-scripts`,
start `npm start`, health `/`, env BOT_TOKEN + BOSS_IDS, disk
`/opt/render/project/src/vendor/data`).
````

---

## If the new session cannot select the `bossbot` repo

Arena binds each session to one repository. If `bossbot` is not offered:

1. https://github.com/settings/installations → **Arena AI Coding Agent** →
   **Configure** → make sure `bossbot` is included (All repositories is fine).
2. Start the new session and pick `bossbot` from the repo list.

Reconnecting without changing the installation selection does nothing.

---

## After the push — Render

| Field | Value |
|---|---|
| Repository | `hulm0408/bossbot` |
| Root Directory | *(leave empty)* |
| Build Command | `npm install --omit=dev --ignore-scripts` |
| Start Command | `npm start` |
| Health Check Path | `/` |
| Env | `BOT_TOKEN`, `BOSS_IDS` |
| Disk | `/opt/render/project/src/vendor/data` |

Then open the service URL — `/` must return
`{"status":"ok","accounts":0,...}` and the bot must answer in Telegram.

---

## Security

A `github_pat_…` token was pasted into the old chat. It has been treated as
compromised and was never used. Revoke it:
<https://github.com/settings/personal-access-tokens>
