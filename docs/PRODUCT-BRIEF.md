# Product brief: underground MVP 0.5

## Summary

underground lets the omp coding agent work on the owner's mac and merge its own PRs while the owner is away.

## Problem

The owner already runs omp without approvals, but does not trust an unattended run, so the owner stays near the mac. The owner must watch only to stop harm that cannot be undone. That harm is the bottleneck.

## Target user

One owner, on one macOS laptop, with one macOS user. omp is the only agent.

## North star

An unattended agent can only do harm that you can undo.

Before each decision, ask: does this stop an irreversible harm, or keep undo and work possible? If not, it waits.

## Goals

1. Each irreversible harm that `THREAT-MODEL.md` holds in 0.5 has a control.
2. Agents sync, push, open a PR, and merge it alone, through the merge gate.
3. A bad merge can be reverted.

Agent output, tasks, schedules, memory, and budgets are arkan's job, not underground's.

## Scope

In: the sandbox, the broker, the merge gate, and an onboarding list, so that agents merge alone in any repo that passes it. `SPEC.md` lists the build work.

Out: the MVPF rows in `THREAT-MODEL.md`.

## Risks

Accepted risks are in `adr/0001-accepted-risks.md`.

## Timeline

Deadline: 2026-11-01.
