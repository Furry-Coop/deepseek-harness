# Agent Note: Keep internal Agent presets out of user choices with an owner write check

Status: implemented

English | [中文](2026-10-26-internal-agent-presets.zh.md)

## Problem

Nodes runs three presets that must be mountable and recoverable by id but must not appear as user choices: the context, extraction, and indexing roles copy a Session under a composition that is not a general-purpose mode. Without a host vocabulary, a preset was only a public choice: the roster listed every declared preset, `select` and `recompose` accepted any declared id, a saved default or a user creation/fork could start a Session on one, and nothing named the presets' internal status.

The first implementation added `Settings.registerValidator(owner, path, validate)`, a public settings seam, so the registry could reject an internal `selectedDefault` before the write persisted, plus a third `validate` parameter on `ConfigEditor.edit`. A later attempt moved the check to the owner fiber's `internal/config` hook and removed both. That hook runs for every config resolution of the fiber, including the direct live updates the Loader applies from a profile patch. It therefore rejected a reload that used to keep the value and fall back to the deployment default. No public hook identifies a configuration write transaction, so the check belongs at the narrower write boundary.

## Decision

`PresetDefinition.userSelectable` (absent means selectable) is the one declaration of internal status. The registry owns the native gate at the executors: `remoteExportList` omits internal presets from the user roster; `select` and `recompose` refuse them; `retain` refuses them for an omitted identity and for user paths; a saved `selectedDefault` naming one falls back to the deployment `default`; and `register` refuses an internal preset as the deployment default. SessionController applies the same check when a user creates or reuses a Session and when forking, while resume composes without it. `resolve`, `readDocument`, `mount`, `acquireScope`, and cold recovery keep addressing the preset by id.

The registry registers `Settings.registerValidator(ctx, ['selectedDefault'], ...)` from its optional `settings` child. `ConfigEditor.edit` resolves a candidate exactly once inside its write lock through `fiber.resolveConfig`, which runs the fiber's config hooks and schema, and passes that resolved config together with the fiber it just checked for activation. The check therefore runs inside the same acceptance as `update`, `replace`, and `mutate`, after `!!js` expressions and schema validation, and before the profile patch changes. The validator reads the values behind Volatile references, so the normalized `selectedDefault` reference cannot hide an internal string. The registration is an effect of the owner fiber, so a reload registers it again and unloading removes it. A direct live config update outside Settings is not a write: it keeps the supplied value and `defaultId` falls back to the deployment `default` with one warning, and a definition that registers after the write is re-checked at use.

## Alternatives considered

**Use the owner's `internal/config` hook.** It reuses the hook the configuration path already runs and removes the generic settings surface. But the hook observes every resolution of the fiber, not only the Settings transaction inside `ConfigEditor.edit`. A direct live update that preserves the original fallback behavior then became a rejected reload. The hook cannot name the write boundary, so it cannot express the rule.

**Hide internal presets in Nodes.** The roster, new-session, switch, default, and fork executors run in the host; a plugin-side list filter would be bypassed by direct Remote calls and could not protect a saved default.

**Treat internal presets as an access boundary.** It is not one: trusted plugins mount them by id, which internal roles and cold recovery require. The flag only governs user choices.

## Testing

`packages/settings/settings/tests/configuration.spec.ts` covers the owner seam itself: a rejected field leaves the file, value, and revision unchanged; the check sees the resolved `!!js` value behind its Volatile reference; and the write callback receives the actual fiber checked for activation. `packages/preset/agent-preset-registry/tests/settings-integration.spec.ts` drives the real Settings service, ConfigEditor, and profile file through update, replace, and mutate, including a constant `!!js` expression; a selectable expression writes through, while an internal one leaves revision, value, effective default, and file unchanged. It also covers the two entries separately: a direct Loader update keeps an internal value and falls back, while the same value through Settings is refused; an HMR profile reload keeps the gate for the next Settings write; a hand-edited internal saved default starts and falls back; a registry fiber reload re-registers the gate; and a saved selectable default that becomes internal after the write falls back. `packages/preset/agent-preset-registry/tests/registry.spec.ts` covers the roster, select and recompose refusal, trusted mount and cold-read lease by id, a direct live update that falls back, the deployment-default refusal, and the retained-generation race. `packages/api/session-controller/tests/session-presets.host.spec.ts` and `commands-create-fork.host.spec.ts` cover user creation and fork refusal. `packages/preset/agent-preset/tests/config.spec.ts` covers the declarative boolean.

## Consequences

The host keeps one narrow settings write seam with one production consumer, because no public hook identifies a configuration write transaction. Direct live updates and hand-edited patches that name an internal preset remain accepted and fall back, while Settings writes reject before persistence. Internal selectability stays a presentation rule, not authorization.
