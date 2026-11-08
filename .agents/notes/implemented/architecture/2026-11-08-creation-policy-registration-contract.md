# Agent Note: Keep creation-policy coordination Host-internal

Status: implemented

English | [中文](2026-11-08-creation-policy-registration-contract.zh.md)

## Problem

Plugins that own a Session mode (for example Nodes) need the native Session Controller to remain the only creator while the plugin supplies the mode's persisted application and a per-operation preparation step. The first implementation added `SessionCreationPolicyRegistry` with `register`, `get`, `claim`, `isLive`, `inspect`, `resolveSource`, and `coordinate` and re-exported every coordination type from the package index.

Only `register` has a production caller outside the package (Nodes); the diagnostic probes read `get`; `claim`, `isLive`, `inspect`, `resolveSource`, and `coordinate` are called only by `src/commands.ts`. The public method set therefore describes the Controller's own transaction rather than a plugin-facing contract, and an external caller could capture an activation or serialize unrelated creations without owning either fact.

## Decision

`SessionCreationPolicyRegistry` is the plugin-facing ledger and exposes `register` and `get`. It keeps one policy per provider-namespaced id for the caller's effect lifetime and returns the disposer that removes exactly that registration. `get` remains public because the Nodes diagnostic probes read the live policy object to replay a known application.

`commands.ts` reads a module-internal `SessionCreationPolicyRuntime` built by `creationPolicyRuntime(registry)`. The package index does not export that runtime or its `SessionCreationPolicyClaim`, `SessionCreationInspection`, and `PolicySourceResolution` shapes. The runtime owns claim capture, activation liveness, ownership aggregation, and the short serial scope around one create-or-reuse attempt; the Controller remains the only creator.

Ownership aggregation keeps a definite claim over another policy's unreadable answer. `unknown` decides only when no policy claims: an ordinary intent then creates a fresh Session, and a named policy does not reuse its candidate. Two definite claims are a conflict. The native entries apply the same rule: an ordinary candidate is reusable only when every policy answers with a definite non-claim; a named policy reuses a candidate it alone definitely claims; a source continuation resolves to the registering policy.

## Alternatives considered

**Leave the whole registry public.** It is the shape the first implementation shipped, and no external caller currently misuses it. It still makes the Controller's transaction look like a plugin capability, and the package rules reject a public method whose only caller is internal coordination.

**Make `unknown` dominate a definite claim.** This would refuse every reuse and continuation whenever any unrelated policy's storage is unreadable, including a pending-but-unidentified application in the registering plugin. The contract distinguishes "the identity must not be treated as ordinary" from "a definite claim is unknown": a claimed identity is not ordinary, and blocking it on an unrelated answer turns a diagnostic into a Host-wide outage. The behavior is locked by real-controller cases instead.

**Add a second public service for coordination.** No consumer needs it, and it would create the API the narrowing is meant to remove.

## Testing

`packages/api/session-controller/tests/creation-policy.host.spec.ts` drives the real `SessionCommandController` and the real registry. Cases cover a policy removed with its contributing fiber, an ordinary candidate claimed by one policy while another is unreadable, a named policy reusing its own candidate under the same split, a source continuation resolved to the claiming policy, activation withdrawal and same-id re-registration, in-flight de-duplication, bounded settled results, prepare failure with a known id, and the ordinary drop of claimed, conflicting, and unreadable candidates. The real composition cases boot the Session Controller Remote over the real Workspace registry, durable storage, and JSONL Session persistence: a fiber withdrawal plus same-id remount that keeps a queued operation out of the new activation, a cold Host restart over the same durable root that enforces reuse in both directions (an ordinary intent never reuses a claimed blank, a named policy reuses only its own), and a failed preparation that reports the stored identity and is never rebuilt.

## Consequences

The package index exposes the registration and participation contract only: `SessionCreationPolicy`, `SessionCreationOwnership`, `SessionCreationOperation`, `SessionCreationParticipant`, `SessionCreationPreparation`, `SessionCreationOutcome`, `SessionCreationStage`, `SessionCreationKnowledge`, and the `register`/`get` ledger. The Controller keeps its transaction private. Nodes continues to register and diagnose through the same two methods; the declaration projection keeps those declarations. The aggregation rule is unchanged and is now stated in the package README and covered by real-controller cases. No durable format, Session log, or model-visible text changes.
