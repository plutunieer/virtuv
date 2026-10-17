# Virtuv

Plan first. Then let Claude Code build.

Virtuv is a Mac app: on the left your Claude Code terminal, on the right your idea as a flowchart with short,
testable requirements. You comment, move blocks and answer Claude's open questions. Nothing gets built until you
click **Approve** — then Claude builds exactly that version in the same terminal: code, independent review, test, commit.

## Requirements

- macOS (only tested on Macs with Apple chip)
- [Node.js](https://nodejs.org) 23.6 or newer
- [Claude Code](https://claude.com/claude-code), installed and logged in with your Claude subscription

## Install and start

```bash
git clone https://github.com/plutunieer/virtuv.git
cd virtuv
npm install
npm run app:start
```

## Build your own .dmg

```bash
npm run app
```

The .dmg lands in `release/` and is built for Apple chip (arm64) only. Raise `version` in `package.json` before
building again. The app is ad-hoc signed (no Apple developer account): if macOS blocks it, go to
**System Settings → Privacy & Security** and click **Open Anyway**.

## Claude Code plugin

Prefer working in your normal terminal? Use the plugin instead: [plutunieer/virtuv-plugin](https://github.com/plutunieer/virtuv-plugin).

## Security

Virtuv listens only on `127.0.0.1`. In the Mac app every request needs a random key created at each start.
The browser and plugin mode (`npm start`, the plugin) has no such key yet: other programs on your Mac can reach it.
The approval lock guards against mistakes; it is not a hard security boundary.

## Tests

```bash
npm test
```

## License

MIT — see [LICENSE](LICENSE).
