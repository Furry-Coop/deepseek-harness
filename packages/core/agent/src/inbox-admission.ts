/**
 * Agent-facing re-export of the Session-owned pure Inbox admission policy.
 *
 * The single implementation lives in `@deepseek-ai/dsh-session/inbox-admission`
 * so cold-read storage validation can reuse it without importing Agent or
 * Workspace; this module preserves the established Agent import surface.
 * @module @deepseek-ai/dsh-agent/inbox-admission
 */

export * from '@deepseek-ai/dsh-session/inbox-admission'
