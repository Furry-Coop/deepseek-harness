---
kind: upgrade-guide
description: Sessions that record a surface reordering require this build or newer to reopen.
---

# Session surface ordering is required on read

English | [中文](guide.zh.md)

## Change

A Session can now record a full permutation of its current surface nodes as a `surface/order` event, and `agent/history-assembling` is the final snapshot point where a plugin commits such a change before the request is frozen. The event is required on read rather than ignorable: a reader that skipped it would assemble a different transcript than the writer sent.

## Migration

No action is needed for ordinary sessions, models, or operators; a session that never records a reordering is unaffected. A build older than this change refuses to open a session whose log contains `surface/order` and reports the unknown required event; open that session with this build or newer instead of editing or migrating the log. Plugins that arrange model-visible material should commit `surface/order` from an `agent/history-assembling` listener, using the permutation of `session.surface.nodes` and keeping the first node first; move material out of later requests with a `replace`, never by copying messages, and expect the following request to start a new message series.
