---
name: plan
description: Plan a project or change as a flowchart (URS) in the current folder, let the user approve it in the browser, then build exactly the approved version with review, test and commit. Use when the user runs /virtuv:plan or asks to plan with Virtuv.
argument-hint: "[what you want to build]"
---

# Virtuv: plan first, then build

The project folder is the current working directory. Pass it as `projekt_ordner` to every Virtuv tool.
What the user wants: $ARGUMENTS

Answer as briefly as possible. Only what matters: result, open question, the user's next step. Leave out everything else.

## 1. Plan (before approval)

- Check the state with `urs_get_feedback` (an error just means there is no URS yet).
- If a version is already approved and nothing new is wanted, skip to step 3.
- Send the plan with `urs_submit`. On a revision, pass `stand` from `urs_get_feedback`.
  The URS is the work order: `zweck` = goal, `anforderungen` = what "done" means, `nichtEnthalten` = what stays out,
  `fragen` = open questions. Put anything unclear into `fragen` instead of guessing.
- Blocks: at most 4 words. Each requirement: at most 12 words, SMART, attached to exactly one block.
  An independent checker reviews every requirement; if `urs_submit` reports violations, fix them and submit again.
- Write blocks and requirements in English unless the user wants another language.
- The flowchart opens in the browser at http://127.0.0.1:8832. Tell the user to review, comment and press "Approve" there.
- Before approval: create or change no project files for this plan.

## 2. Revise

When the user says they commented or changed something: `urs_get_feedback`, work everything in, `urs_submit` again,
listing addressed comment ids in `erledigteKommentare`. Only the user can approve — never claim approval yourself.

## 3. Build (only after approval)

- Fetch the approved version with `urs_get_approved`. An error means it is not approved: do not build.
- Build exactly what it says — nothing more, nothing less.
- A wish that is not in the approved URS: do not build it; add it as a new version with `urs_get_feedback` + `urs_submit`
  and say it has to be planned and approved first.
- Every change goes through, without asking: **code → review → test → commit**.
  - Review: an independent reviewer that did not write the code (a separate agent you give the diff to) checks every change.
    Test only after all valid findings are fixed; briefly justify rejected findings in the terminal.
  - Test: actually run each change against its approved requirement (U number) and report "pass" or "fail" per change.
    Fail: back to code, then review and test again, no commit.
  - Commit: commit each passed change with a message on its own branch, never directly on the default branch (main/master).
    On the default branch, create a branch first. No git repository: announce `git init`, then create a branch right away.
    If the project has a GitHub remote, push after each commit.
  - Merge into the default branch only with the user's explicit consent.
