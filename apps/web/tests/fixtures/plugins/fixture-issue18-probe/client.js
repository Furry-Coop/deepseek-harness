/** Test package registering the issue-18 Chat attachment and subagent-menu classifiers. */
window.__ModuleLoader__.load({
  id: '@fixture/issue18-probe',
  factory(require) {
    const React = require('react')
    const empty = () => new Map()
    return {
      inject: ['slots', 'uiConversation', 'subagentMenu'],
      apply(ctx) {
        const classification = {
          parentSessionId: undefined,
          support: new Set(),
          unavailable: false,
          version: 0,
        }
        const listeners = new Set()
        const revision = {
          getSnapshot: () => classification.version,
          subscribe: (listener) => {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
        }
        const bump = () => {
          classification.version += 1
          for (const listener of [...listeners]) listener()
        }
        let lastCatalogEntries = []
        let classified = []
        ctx.subagentMenu.register({
          id: '@fixture/issue18-probe',
          revision,
          classify(input) {
            lastCatalogEntries = input.entries.map(entry => ({
              id: entry.id,
              mode: entry.mode,
              activity: entry.activity,
            }))
            if (classification.unavailable) {
              classified = []
              return undefined
            }
            if (classification.parentSessionId !== input.parentSessionId) {
              classified = []
              return empty()
            }
            const result = new Map()
            for (const entry of input.entries) {
              if (classification.support.has(entry.id)) result.set(entry.id, 'support')
            }
            classified = [...result.keys()]
            return result
          },
        })
        const cardDisposers = new Map()
        const registerChatAttachment = (card) => {
          const previous = cardDisposers.get(card.id)
          if (previous !== undefined) previous()
          const disposeAnchor = ctx.uiConversation.attachments.register(card)
          let slotDispose
          const stopWaiting = ctx.slots.inject('conversation.chat.attachment', () => {
            slotDispose = ctx.slots.register({
              name: 'conversation.chat.attachment',
              key: card.id,
            }, props => React.createElement(
              'div',
              {
                'data-probe-card': props.attachment.id,
                'data-probe-site': props.site,
                'data-probe-turn': props.turn,
                'data-probe-seq': props.seq ?? '',
                'data-probe-session': props.sessionId,
              },
              React.createElement('button', {
                type: 'button',
                'data-probe-focus': props.attachment.id,
              }, `focus ${props.attachment.id}`),
              `PROBE ${props.attachment.id} ${props.site} turn ${props.turn} seq ${props.seq ?? 'none'}`,
            ))
            return slotDispose
          })
          cardDisposers.set(card.id, () => {
            if (slotDispose !== undefined) slotDispose()
            else stopWaiting()
            disposeAnchor()
          })
          return card.id
        }
        const disposeChatAttachment = (id) => {
          const dispose = cardDisposers.get(id)
          if (dispose === undefined) return false
          cardDisposers.delete(id)
          dispose()
          return true
        }
        window.__issue18Probe = {
          registerChatAttachment,
          disposeChatAttachment,
          setClassification({ parentSessionId, supportIds, unavailable = false }) {
            classification.parentSessionId = parentSessionId
            classification.support = new Set(supportIds ?? [])
            classification.unavailable = unavailable
            bump()
          },
          withdrawClassification() {
            classification.unavailable = true
            bump()
          },
          getClassificationState() {
            return {
              parentSessionId: classification.parentSessionId,
              support: [...classification.support],
              unavailable: classification.unavailable,
              classified,
            }
          },
          getLastCatalogEntries() {
            return lastCatalogEntries
          },
        }
      },
    }
  },
})
