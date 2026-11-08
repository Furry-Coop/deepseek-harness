# Agent Note: Creation outcomes come from the Controller stage, not the failure code

Status: implemented

English | [中文](2026-11-09-creation-outcome-stage-evidence.zh.md)

## Problem

`session.create` classified a failed attempt by its failure code: `agent-preset/*` counted as a proven pre-create refusal, so the same operation identity stayed retryable. A plugin reached from the serial `agent/created` listener can throw any Remote failure, including one of those codes. A real AgentLoop, Session Controller, Workspace registry, and JSONL persistence reproduce it: the listener selects a model, awaits `sessions.flush` returning true, then throws `agent-preset/not-found`. Delivering the same operationId twice minted two Sessions, and an independent Host could open both logs and read one `model/selection` each. The list also mixed refusals the Controller raises before any factory call with codes any plugin can throw after one.

## Decision

The Agent Controller records the attempt stage itself. `ApiSessionCreationFailed` wraps every `createSession` failure with `enteredFactory` — set immediately before `ctx.agents.create` or `ctx.agents.resume` and never cleared — and the actual identity once such a call returned. `commands.ts` reads creation knowledge only from that record: no factory entry is `none`, a returned identity is `known`, and everything else is `unknown`. Failures `commands.ts` raises itself keep a fixed reading: pre-create validation is `none`, and `session/workspace-attach-failed` and `session/policy-prepare-failed` are `known` with the real identity.

The operation cache deletes an identity only for a proven `none`; `unknown` and `known` entries stay settled and replay without entering the factory again. A factory that may have written a Session is never retried.

The wire keeps the owner code only for a proven pre-create refusal. `agent-preset/not-found` and `agent-preset/invalid` then carry `creation: 'none'` in their details, set by the Session Controller; the preset registry never sets it, and its absence leaves the outcome unknown. A failure raised inside a factory call is delivered as `gateway/internal` with the owner code and message kept in the diagnostic text, and the same holds for a failure after the factory returned — the policy participant still receives the actual identity. The Host does not roll back events already written; the unknown outcome states only that a Session may exist.

## Alternatives considered

**Keep the code list and restrict `agent-preset/*` to pre-flight.** The value thrown inside the factory is plugin-controlled, so the same code there is indistinguishable from the Controller's own refusal.

**Treat every failure as unknown.** This would give up the safe retry of a genuinely absent preset and the preset hint a caller uses to fall back.

**Carry `creation: 'none'` in-band on every failure.** A plugin throwing from the factory could set the field. Only the Controller's out-of-band stage record is trustworthy.

**Add a dedicated wire code for post-factory failures.** No current consumer reads one; the generic failure with the owner code in its message already carries the diagnostic without new vocabulary.

## Testing

`packages/api/session-controller/tests/creation-policy.host.spec.ts` drives the production AgentLoop over the real Workspace registry and JSONL persistence. One case reproduces the durable write and refusal, replays the operation, and reads one Session after the Host ends; another proves a pre-flight preset refusal still retries and carries `creation: 'none'`. Unit cases pin the generic mapping for raw, non-Error, `gateway/internal`, and forged `agent-preset/not-found` factory failures, the known identity after the factory returned, and the unclassified default. Both changed source files keep 100% per-file v8 coverage.

## Consequences

A preset that fails to mount after adoption now reaches the caller as `gateway/internal` with the owner code in the message instead of the specific code. That is the accepted cost of not claiming a pre-create refusal that cannot be proven. Genuine pre-create refusals keep their code and gain the marker, so a client that reads only the code still retries a proven-safe failure. Durable Sessions written before a refusal stay on disk and join no Workspace; the Host reports the unknown outcome rather than promising a rollback.
