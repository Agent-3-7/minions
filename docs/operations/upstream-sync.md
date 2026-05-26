# AgentControl Git Operations

## Remotes

- `origin`: `https://github.com/rewasa/jarvis-mission-control.git`
- `upstream`: `https://github.com/Agent-3-7/minions.git`

## Sync from upstream Minions

```bash
cd /Users/renatowasescha/GIT/jarvis-mission-control
git fetch upstream
git checkout main
git merge upstream/main
npm run build
git push origin main
```

## Feature work

Use branches or worktrees per task:

```bash
git fetch origin main
git worktree add ../jmc-cloudflare -b feat/cloudflare-tunnel origin/main
```

Before committing:

```bash
git status --short --branch
git diff --stat
npm run build
git diff --cached --check
```

Public OSS commit identity should use Renato's public email:

```bash
git config user.name 'Renato Wasescha'
git config user.email 'rewalu@gmail.com'
```
