/**
 * Host-standard Session-row badge, contributed through the
 * `'sidebar.session.badge'` Factory so occupants keep business data while the
 * host keeps the inline geometry, shared width budget, clipping, and
 * accessible name.
 */
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import css from './rows/Rows.module.css'

/**
 * Render one short row badge.
 * @param props - visible text and its complete explanation.
 * @returns the host-styled badge element.
 */
export function SessionRowBadge({ text, title }: FactoryComponentPropsOf<'sidebar.session.badge'>) {
  return (
    <span className={css.rowBadge} title={title} aria-label={title ?? text}>
      {text}
    </span>
  )
}
