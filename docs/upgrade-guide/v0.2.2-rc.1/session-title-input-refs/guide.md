---
kind: upgrade-guide
description: "Session-title snapshots for rewritten Inbox input now carry inputRefs instead of human messageSeqs, and older readers refuse sessions containing the new required title events."
---
# Session title attribution uses input refs

English | [中文](guide.zh.md)

## Change

`SessionTitleSnapshot` no longer always represents a title's source as human `messageSeqs`. When the title derives from a claimed human Inbox occurrence whose admitted message replaced the human source kind, `ctx.sessionTitle.get(session)` and a provider's `currentTitle` now return `messageSeqs: []` plus `inputRefs` that may mix direct and origin entries: `{ kind: 'message', messageSeq }` or `{ kind: 'origin', originalInboxSeq, messageId, claimSeq, admittedSeq }`. Only when every selected input is a direct `message` ref does the title keep the old human `messageSeqs`; if any `origin` ref is selected, the new required event retains every selected ref in admission order. `source.kind` is independent: `user` still identifies a manual pin; `fallback` and `provider` are automatic titles.

The session log gains two required event types, `session/title-from-input` and `session/title-llm-request-from-input`. They are not ignorable: a harness that predates them refuses a session containing them with `SessionFormatUnsupportedError` before reading, writing, or repairing the log. The TypeScript and Python SDK `session.event` projections therefore carry both required types.

The [2026-11-13 title-from-input record](../../../persistence-changes/2026-11-13-title-from-input.md) owns the schema decision and reader compatibility; the [session-title subsystem](../../../subsystems/session-title.md) defines the refs.

## Migration

1. Upgrade every reader that consumes `SessionTitleSnapshot` or a provider's `currentTitle` to a release that knows `inputRefs` and both required events.
2. When `inputRefs` is present, attribute the title from those refs in admission order; the list may mix direct `message` and `origin` entries. Use the old `messageSeqs` form only when every selected ref is `message`; if any selected ref is `origin`, use `inputRefs` and retain every selected ref. When `inputRefs` is absent, keep using `messageSeqs`. Do not treat an empty `messageSeqs` as a missing title.
3. For each `inputRefs` entry, branch on `kind`: a `message` ref names a direct human `user/message` by `messageSeq`; an `origin` ref names the claimed occurrence and admitted rewrite by `originalInboxSeq`, `messageId`, `claimSeq`, and `admittedSeq`. Check `source.kind` separately: `user` is a manual pin; `fallback` and `provider` are automatic.
4. Do not downgrade a session containing either required event to an older harness; it refuses the session. No data deletion, conversion, or header bump is required.
5. Confirm by opening the session with the upgraded harness and reading `get()` or `currentTitle.inputRefs` (or the persisted event's `inputRefs`).
