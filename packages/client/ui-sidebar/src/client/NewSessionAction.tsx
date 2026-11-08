/**
 * Host-standard New Session action row, contributed through the
 * `'sidebar.new-session.action'` Factory so plugins keep business data and
 * callbacks while the shell keeps the button semantics, pending guard, and row
 * geometry. Its failure reports leave the row for a shell-owned transient
 * notice, so withdrawing the contribution cannot remove a notice already shown.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconNewChatOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  FactoryComponentPropsOf, HostObservable, InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the frame's shell.overlay slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import css from './SidebarRoot.module.css'

/** Props of one host-standard action row occurrence. */
type ActionRowProps = FactoryComponentPropsOf<'sidebar.new-session.action'>

/** One transient action failure held by the shell until its banner fades. */
export interface NewSessionActionFailureState {
  /** Per-report sequence so a repeated report restarts the banner. */
  readonly seq: number
  /** Readable reason contributed by the action. */
  readonly detail: string
}

/** Default leading glyph when an entry selects no local icon. */
function DefaultActionIcon() {
  return <IconNewChatOutlineRegular size={16} />
}

/**
 * Render one grouped New Session row.
 * @param props - entry data, the host's icon seat, and the failure report.
 * @returns one standard row.
 */
export function NewSessionActionRow({
  wide,
  label,
  disabled,
  onInvoke,
  reportFailure,
  useFactorySlot,
}: ActionRowProps): ReactNode {
  const Icon = useFactorySlot('icon', DefaultActionIcon)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  // Repeatable setup/cleanup so a StrictMode effect replay keeps the row live.
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  return (
    <button
      type="button"
      className={css.newSessionAction}
      aria-label={wide ? undefined : label}
      title={wide ? undefined : label}
      disabled={busy || disabled === true}
      aria-busy={busy}
      onClick={() => {
        // The button is disabled while busy or disabled, and unmount removes
        // its listener; this guard only covers an event queued across that change.
        /* v8 ignore next -- queued event after the disabled/unmount transition */
        if (busy || disabled === true || !mounted.current) return
        setBusy(true)
        let pending: Promise<void> | undefined
        try {
          // Invoke synchronously while this row is still live; a later
          // withdrawal may not revoke started work but must not receive a
          // queued invoke or report a late failure.
          pending = onInvoke() ?? undefined
        } catch (reason: unknown) {
          setBusy(false)
          reportFailure(describe(reason))
          return
        }
        void Promise.resolve(pending).catch((reason: unknown) => {
          if (mounted.current) reportFailure(describe(reason))
        }).finally(() => {
          if (mounted.current) setBusy(false)
        })
      }}
    >
      <span className={css.newSessionActionIcon} aria-hidden="true"><Icon /></span>
      {wide && <span className={css.newSessionActionLabel}>{label}</span>}
    </button>
  )
}

/** Injection face of the shell-owned failure banner. */
export interface NewSessionActionFailureInjected {
  readonly hooks: { readonly actionFailure: HostObservable<NewSessionActionFailureState | null> }
  /** Clear the banner after its fade; a newer report replaces it. */
  readonly clearActionFailure: () => void
}

/** Props of the frame-wide failure banner. */
export type NewSessionActionFailureProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'sidebar'>
  & InjectFace<NewSessionActionFailureInjected>

/**
 * Render the shell-owned transient failure banner. It lives in the frame-wide
 * overlay, so removing the contributing action does not remove an already
 * reported failure.
 * @param props - action-failure source, clear action, and copy seat.
 * @returns the banner, or null while there is no failure.
 */
export function NewSessionActionFailure({ useActionFailure, clearActionFailure, t }: NewSessionActionFailureProps): ReactNode {
  const failure = useActionFailure(current => current)
  if (failure === null) return null
  return (
    <Toast
      key={failure.seq}
      text={`${t('session.new.actionFailed')}: ${failure.detail}`}
      holdMs={4000}
      onDone={clearActionFailure}
    />
  )
}

/**
 * Readable failure detail; the shell owns only this generic report.
 * @param error - rejection reason or thrown value.
 * @returns the message, the string itself, or the value's text form.
 */
function describe(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return typeof error === 'string' && error !== '' ? error : String(error)
}
