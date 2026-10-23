# Standalone project

This folder is a **complete, self-contained project**. It does not read anything
from the parent repository — all Swiggy code it needs is in `vendor/`.

## Create the GitHub repo (one time)

The sandbox token cannot create repositories, so this step is manual:

1. Open <https://github.com/new>
2. Repository name: **bossbot** · **Private** · do **not** add README/.gitignore/license
3. Create repository

Then either push from this folder:

```bash
git clone https://github.com/hulm0408/ammi-abbu-ka-sacha-beta.git parent
cd parent/bossbot
git init -b main
git add -A
git commit -m "bossbot: two links in, one tap, tracking out"
git remote add origin https://github.com/hulm0408/bossbot.git
git push -u origin main
```

…or copy this folder anywhere and do the same three steps.

## Deploy to Render

Use `render.yaml` in this folder (root directory = repo root, since this *is* the
repo root in the new repository). Set:

- `BOT_TOKEN` — from @BotFather
- `BOSS_IDS` — numeric Telegram IDs, comma separated
- mount a disk at `vendor/data` so sessions and orders survive redeploys

## Verify

```bash
npm install --omit=dev --ignore-scripts
npm test        # 49 checks, no network needed
```

## What is intentionally NOT here

- the parent bot's 12k-line `index.js`, panel code, topic flows, competitor flows
- any hardcoded repo/domain: the cloud vault stays **off** unless
  `GITHUB_VAULT_OWNER` + `GITHUB_VAULT_REPO` are set, so this project can never
  write sessions into another project's repository
