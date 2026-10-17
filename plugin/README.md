# Virtuv for Claude Code

Plan every project as a flowchart first, approve it in the browser, then let Claude build exactly that —
with independent review, tests and a commit for every change.

## Install

```bash
claude plugin marketplace add plutunieer/virtuv-plugin
claude plugin install virtuv@virtuv
```

Needs Claude Code and Node.js 20 or newer.

## Use

In any project folder, inside Claude Code:

```
/virtuv:plan a step counter app
```

The flowchart opens in your browser (http://127.0.0.1:8832). Comment, edit blocks, answer questions, then press
**Approve**. Only you can approve. After that Claude builds the approved version: code → review → test → commit.

The plan lives in the project's `.urs/` folder, so the Virtuv app shows the same blocks, comments and approval state.

More: https://virtuv.dev
