# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

- **Fast bounded PWA startup** — Hard-reloaded web clients now become interactive from the requested session, active processing sessions, and a bounded newest page while the remaining authorized session metadata reconciles safely in the background. Permission state travels with summaries and unopened transcripts remain lazy. ([#113](https://github.com/razumv/craft-agents/issues/113))
- **Warm Symphony restarts** — Native Symphony restores each lane’s last verified board immediately during routine server restarts, labels it stale while exact provider, Craft execution, and worktree truth reconcile, and resumes from the provider watermark instead of blanking the board or replaying a full repository scan. Cached evidence remains read-only and excludes raw issue bodies, comments, and agent final responses. ([#100](https://github.com/razumv/craft-agents/issues/100))
- **Portrait board carousel** — On upright phones, each task-board column now fills the safe usable width, snaps one column per swipe, shows the current column and total, survives rotation, and restores the exact column and vertical position after opening a card. Desktop and landscape retain the existing multi-column row. ([#88](https://github.com/razumv/craft-agents/issues/88))
- **Mobile Project Desk and zero-write shadow receipts** — Native Symphony now exposes compact issue/run/gate/directive status through existing Craft-compatible surfaces, filters heartbeat noise, honors archived session truth, and returns restart-stable shadow proposals with canonical zero-write receipt hashes. ([#9](https://github.com/razumv/craft-agents/issues/9))
- **Immutable headless release packaging** — Standalone server builds now include a same-release `craft-cli`, source/build manifest, complete Pi runtime layout validation, deterministic rollback metadata, and a default-off native Symphony lifecycle/RPC boundary. ([#8](https://github.com/razumv/craft-agents/issues/8))

## Bug Fixes

## Breaking Changes
