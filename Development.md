# Development

## Publishing a new release

One-time setup:

```bash
npm config set //registry.npmjs.org/:_authToken=YOUR_TOKEN
```
This registers a token locally (writes to `~/.npmrc`, persists across sessions)

Each release:

```bash
npm version patch  # bump version: patch | minor | major
npm publish        # prepublishOnly runs the build automatically
git push --follow-tags
```

End users install with `npx agentcontrolai` — see [README.md](README.md).
