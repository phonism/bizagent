import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { createAgentMentionSource } from './agent-mentions.js'
import { FrameParticipationDock } from './frame-participants.js'
import { BizAgentUiHttpPort } from './api.js'
import { BizAgentDashboard, BizAgentMark, type BizAgentUiFace } from './components.js'
import { BizAgentUiController } from './controller.js'
import { SessionSurfaces } from './session-resource.js'
import { SessionHomeAction, SessionQuickActions, SessionRowLeading, SessionRowHover, SessionRowMenu,
  SessionWorkView, SessionTurnCard, type SessionSurfaceFace } from './session-surfaces.js'
import { en, NS, zh, type BizAgentKey } from './locales.js'
import { BIZAGENT_UI_CSS } from './styles.js'

export type { BizAgentUiPort } from './api.js'
export { BizAgentUiController } from './controller.js'
export type { BizAgentKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    bizagent: BizAgentKey
  }
}

export const name = 'bizagent-ui'
export const inject = ['slots', 'locale', 'inputTriggers', 'sessions', 'workspaces', 'uiWorkspace', 'layout']
const PANEL_ID = 'bizagent' as MainPanelId

export function apply(ctx: Context): void {
  const controller = new BizAgentUiController()
  const api = new BizAgentUiHttpPort()
  const surfaces = new SessionSurfaces(api)
  const openDashboard: SessionSurfaceFace['openDashboard'] = target => {
    controller.open(target)
    ctx.layout.selectPanel(PANEL_ID)
  }
  const closeDashboard = () => { controller.close(); ctx.layout.selectPanel(null) }
  const sessionFace = (): SessionSurfaceFace => ({ surfaces, openDashboard,
    openSession: async id => {
      const revealed = await api.revealSession(id)
      if (revealed.workspacePath) await ctx.workspaces.create({ path: revealed.workspacePath })
      await ctx.sessions.refresh()
      ctx.uiWorkspace.openSession(id as SessionId)
      ctx.layout.selectPanel(null)
    },
  })
  const face = (): BizAgentUiFace => ({ controller, api,
    openDashboard, closeDashboard,
    openAgentSession: async input => {
      const opened = await api.openAgentSession(input)
      // The host already attached the Session to its Home Workspace; register that Workspace in
      // this page and refresh the Session list so the client knows the Session before opening it.
      await ctx.workspaces.create({ path: opened.workspacePath })
      await ctx.sessions.refresh()
      ctx.uiWorkspace.openSession(opened.sessionId as SessionId)
      ctx.layout.selectPanel(null)
      controller.close()
    },
    openWorkspaceChat: async path => {
      const workspace = await ctx.workspaces.create({ path })
      await ctx.uiWorkspace.openWorkspace(workspace.workspaceId)
      ctx.layout.selectPanel(null)
      controller.close()
    },
  })

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'bizagent-ui: dictionaries')
  ctx.effect(() => () => surfaces.dispose(), 'bizagent-ui: session resources')
  ctx.effect(() => ctx.inputTriggers.registerSource(createAgentMentionSource(api)), 'bizagent-ui: @Agent source')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset['bizagentUi'] = 'true'
    style.textContent = BIZAGENT_UI_CSS
    document.head.append(style)
    return () => { style.remove() }
  }, 'bizagent-ui: styles')

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 40,
    locale: NS,
    label: () => ctx.locale.bind(NS)('launcher.label'),
  }, ({ size }) => <span className="ba-panel-icon" style={{ width: size, height: size }}><BizAgentMark /></span>))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: face,
  }, BizAgentDashboard))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'bizagent-home', order: 20,
    locale: NS, inject: sessionFace,
  }, SessionHomeAction))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'bizagent-inbox', order: 20,
    locale: NS, inject: sessionFace,
  }, SessionQuickActions))
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view', id: 'bizagent-work', order: 40,
    label: () => ctx.locale.bind(NS)('sessionUI.workView'), locale: NS, inject: sessionFace,
  }, SessionWorkView))
  ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
    name: 'sidebar.session.row.leading', id: 'bizagent-home', order: 20,
    locale: NS, inject: sessionFace,
  }, SessionRowLeading))
  ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({
    name: 'sidebar.session.row.hover', id: 'bizagent-home', order: 20,
    locale: NS, inject: sessionFace,
  }, SessionRowHover))
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item', id: 'bizagent-home', order: 460,
    locale: NS, inject: sessionFace,
  }, SessionRowMenu))
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: 'bizagent-results', order: 30,
    locale: NS, inject: sessionFace,
  }, SessionTurnCard))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'bizagent-frame-participation',
    order: 45,
    locale: NS,
    inject: () => ({ surfaces, openDashboard }),
  }, FrameParticipationDock))
}
