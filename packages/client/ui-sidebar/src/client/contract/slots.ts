/**
 * Sidebar slot contract: the registrant-side props composition for the
 * layout-owned `sidebar` slot, plus the holes this shell declares. The shell
 * owns column geometry, the brand row, New Session, and global panel rows;
 * everything between the workspace section header and the list bottom is the
 * `sidebar.workspaces` registrant's (ui-workspace), and the foot is the
 * `sidebar.settings` registrant's (ui-settings), followed by optional footer
 * actions in `sidebar.footer.action`.
 */
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ProductEventMap } from '@deepseek-ai/dsh-client-product-analytics/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Non-interactive notification inside the collapsed sidebar expand button. */
    'sidebar.toggle.badge': { kind: 'single'; scope: 'root'; owner: Record<never, never> }
    /**
     * Brand mark rendered in the expanded brand row and collapsed rail.
     * Declared by this package's `sidebar` entry; deployments may replace
     * the shell's fish fallback without replacing the surrounding controls.
     */
    'sidebar.brand.mark': { kind: 'single'; scope: 'root'; owner: SidebarBrandMarkOwnerProps }
    /**
     * Brand name rendered beside the expanded mark. Declared by this
     * package's `sidebar` entry; the shell supplies a generic text fallback.
     */
    'sidebar.brand.name': { kind: 'single'; scope: 'root'; owner: SidebarBrandNameOwnerProps }
    /**
     * Global panel icons. Each list id addresses the matching main panel;
     * the sidebar owns the button and resolves its label from list metadata.
     */
    'sidebar.panellist': { kind: 'list'; scope: 'root'; owner: SidebarPanelIconOwnerProps }
    /** Rows of the panel list's More menu; the sidebar shows More only while this list has registrations. */
    'sidebar.panellist.actions': { kind: 'list'; scope: 'root'; owner: SidebarPanelActionsOwnerProps }
    /**
     * The workspace/session browsing region: section header, search, the
     * grouped/flat session list, and every workspace dialog. Declared by this
     * package's 'sidebar' entry (declaring is claiming); ui-workspace
     * registers the browser.
     */
    'sidebar.workspaces': { kind: 'single'; scope: 'root'; owner: SidebarSectionOwnerProps }
    /**
     * The settings seat at the sidebar foot. Declared by this package's
     * 'sidebar' entry; ui-settings registers its trigger row + modal panel.
     * The sidebar passes only its column state — it holds no settings state.
     */
    'sidebar.settings': { kind: 'single'; scope: 'root'; owner: SidebarSettingsOwnerProps }
    /**
     * Optional actions beside Settings at the sidebar foot. Declared by this
     * package's 'sidebar' entry; each action receives only the column state.
     */
    'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }
    /**
     * Additional New Session actions directly under the shell's native button,
     * in ascending `order` and flush against it as one rounded button group.
     * Declared by this package's 'sidebar' entry; the whole group, native
     * button included, renders only while the global access snapshot allows
     * `session/create`. A fully hidden zero-width Desktop column renders no
     * contributed row either: a row left inside the clipped column would stay
     * keyboard-reachable without being visible, and the grouped outline would
     * override a native caption button's own geometry. The shell keeps the
     * native upper button, the outer
     * outline, the divider, and the group's accessible name; an entry supplies
     * its localized label, optional disabled state, and business callback
     * through the host's `sidebar.new-session.action` Factory, which renders the
     * standard row with its button semantics, pending guard, rejection report,
     * and optional local icon seat. Removing every entry restores the native
     * single button with its full outline.
     */
    'sidebar.session.new.action': { kind: 'list'; scope: 'root'; owner: SidebarNewSessionActionOwnerProps }
  }
}

/**
 * Owner share of the additional New Session action list: the column state only.
 * An entry renders one host-standard row through the
 * `'sidebar.new-session.action'` factory, which owns the button semantics,
 * pending guard, rejection report, and the optional local icon seat.
 */
export interface SidebarNewSessionActionOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  readonly wide: boolean
}

/** Input of one host-standard New Session action row. */
export interface SidebarNewSessionActionProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  readonly wide: boolean
  /** Localized row text; also the accessible name in the collapsed rail. */
  readonly label: string
  /** Whether the action currently refuses invocation. */
  readonly disabled?: boolean
  /** Invoke the action; the host guards repeated clicks and reports a rejection. */
  readonly onInvoke: () => void | Promise<void>
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /**
     * Host-standard one-row New Session action: the shell owns the button,
     * pending guard, failure report, and optional local icon seat; an action
     * supplies only its data and business callback.
     */
    'sidebar.new-session.action': {
      scope: 'root'
      props: SidebarNewSessionActionProps
      locale: 'sidebar'
      inject: {
        /**
         * Report one rejected action to the shell-owned transient notice.
         * @param detail - readable reason provided by the action.
         */
        reportFailure: (detail: string) => void
      }
      slots: {
        /** Optional leading glyph replacing the shell's generic New Session icon. */
        icon: { scope: 'root' }
      }
    }
  }
}

/** Geometry supplied to the sidebar brand-mark occupant. */
export interface SidebarBrandMarkOwnerProps {
  /** Requested square edge in pixels. */
  size: number
}

/** Empty owner share for the sidebar brand-name occupant. */
export interface SidebarBrandNameOwnerProps {
  /** Marker field: the occupant owns its own content and width. */
  children?: never
}

/** Icon presentation supplied by the global panel row. */
export interface SidebarPanelIconOwnerProps {
  /** Requested square edge in pixels. */
  size: number
  /** Whether this panel is selected in the main column. */
  active: boolean
}

/** Serializable metadata for one active global panel list registration. */
export interface SidebarPanelMetadata {
  /** List id and matching main panel key. */
  id: MainPanelId
  /** Ascending row order; ties retain registration order. */
  order: number
  /** Row title and accessible name: resolved label, or the id when omitted. */
  label: string
}

/** One customizable panel launcher listed in the More menu. */
export interface SidebarPanelActionEntry {
  /** Panel id. */
  readonly id: string
  /** Resolved panel label. */
  readonly label: string
  /** False while the launcher is unpinned from the sidebar. */
  readonly pinned: boolean
  /** Whether this panel is selected, independently of its pin state. */
  readonly active?: boolean
}

/** Owner share of the panel list's More menu rows. */
export interface SidebarPanelActionsOwnerProps {
  /** Customizable panels in registration order; Plugins is never listed. */
  readonly entries: readonly SidebarPanelActionEntry[]
  /**
   * Open a panel without changing its pin state.
   * @param id - Listed panel id.
   */
  readonly onOpen: (id: string) => void
  /**
   * Show (true) or unpin (false) a panel launcher.
   * @param id - Listed panel id.
   * @param pinned - Whether the launcher shows in the sidebar.
   */
  readonly onPinnedChange: (id: string, pinned: boolean) => void
  /** Close the More menu. */
  readonly onDismiss: () => void
}

/**
 * Owner share of the browser hole — the only facts crossing the shell/region
 * boundary. Business data and actions arrive through the region's own inject.
 */
export interface SidebarSectionOwnerProps {
  /** Shell fold-state output: wide renders the full browser, rail the icon column. */
  wide: boolean
  /** Ensure the sidebar is visible; safe to call while already expanded. */
  expandSidebar: () => void
}

/**
 * Owner share of the sidebar settings seat: the column display state the
 * occupant's trigger row must render against (wide row vs rail icon).
 */
export interface SidebarSettingsOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/** Owner share of an action rendered beside Settings at the sidebar foot. */
export interface SidebarFooterActionOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/**
 * Registrant-private injected share (arrives via the register inject
 * factory). The renderer binds the panel metadata source to usePanels.
 */
export type SidebarRootInjected = {
  /**
   * Start a New Session: with a workspace, reuse-or-create its blank session
   * and open it; without one, inherit the current Session Workspace, then the
   * recent Workspace, or clear into the New Session pure view when none exist.
   */
  startSession: (workspaceId?: WorkspaceId) => void
  /** Toggle the sidebar column through the layout service. */
  toggleSidebar: () => void
  /** Select the global panel addressed by a sidebar row. */
  selectPanel: (id: MainPanelId) => void
  /**
   * Show or unpin one panel launcher; Plugins is ignored.
   * @param id - Panel id.
   * @param pinned - Whether the launcher shows in the sidebar.
   */
  setPinned: (id: string, pinned: boolean) => void
  /** Record activation of an official navigation control without changing navigation. */
  trackEntryClick: (attributes: ProductEventMap['sidebar_menu_click']) => void
  /** Private reactive sources bound to framework selector hooks. */
  hooks: {
    panels: ObservableSnapshot<readonly SidebarPanelMetadata[]>
    shortcuts: ObservableSnapshot<readonly ShortcutCatalogEntry[]>
    /** Ids of unpinned panel launchers held in memory until plugin reload. */
    entryPins: ObservableSnapshot<readonly string[]>
    /** Whether `sidebar.panellist.actions` has registrations. */
    entryActions: ObservableSnapshot<boolean>
    /**
     * Whether any plugin contributes a `sidebar.session.new.action` entry. The
     * shell renders the grouped outline and the action container only while
     * true and the column is not fully hidden at zero width, so a deployment
     * without contributions keeps the native single button and its full
     * outline.
     */
    newSessionActions: ObservableSnapshot<boolean>
  }
}

/**
 * Full component props: layout owner state/actions plus the declared holes'
 * render shares, this package's injected callbacks, and the standard locale
 * seat. Panel metadata arrives through an injected observable.
 */
export type SidebarRootComponentProps =
  PropsRuntime<'sidebar'>
  & PropsRenderSlots<
    | 'sidebar.brand.mark'
    | 'sidebar.brand.name'
    | 'sidebar.toggle.badge'
    | 'sidebar.panellist'
    | 'sidebar.panellist.actions'
    | 'sidebar.session.new.action'
    | 'sidebar.workspaces'
    | 'sidebar.settings'
    | 'sidebar.footer.action'
  >
  & InjectFace<SidebarRootInjected> & PropsLocale<'sidebar'>
