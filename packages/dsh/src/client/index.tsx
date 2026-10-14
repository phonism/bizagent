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
import { createAgentMentionSource } from './agent-mentions.js'
import { FrameParticipationDock } from './frame-participants.js'
import { BizAgentUiHttpPort } from './api.js'
import { BizAgentDashboard, BizAgentLauncher, type BizAgentUiFace } from './components.js'
import { BizAgentUiController } from './controller.js'
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
export const inject = ['slots', 'locale', 'inputTriggers', 'sessions', 'workspaces', 'uiWorkspace']

export function apply(ctx: Context): void {
  const controller = new BizAgentUiController()
  const api = new BizAgentUiHttpPort()
  const face = (): BizAgentUiFace => ({ controller, api,
    openAgentSession: async input => {
      const opened = await api.openAgentSession(input)
      // The host already attached the Session to its Home Workspace; register that Workspace in
      // this page and refresh the Session list so the client knows the Session before opening it.
      await ctx.workspaces.create({ path: opened.workspacePath })
      await ctx.sessions.refresh()
      ctx.uiWorkspace.openSession(opened.sessionId as SessionId)
      controller.close()
    },
    openWorkspaceChat: async path => {
      const workspace = await ctx.workspaces.create({ path })
      await ctx.uiWorkspace.openWorkspace(workspace.workspaceId)
      controller.close()
    },
  })

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'bizagent-ui: dictionaries')
  ctx.effect(() => ctx.inputTriggers.registerSource(createAgentMentionSource(api)), 'bizagent-ui: @Agent source')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset['bizagentUi'] = 'true'
    style.textContent = BIZAGENT_UI_CSS
    document.head.append(style)
    return () => { style.remove() }
  }, 'bizagent-ui: styles')

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'bizagent-learning-observatory',
    order: 40,
    locale: NS,
    inject: face,
  }, BizAgentLauncher))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'bizagent-learning-observatory',
    order: 40,
    locale: NS,
    inject: face,
  }, BizAgentDashboard))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'bizagent-frame-participation',
    order: 45,
    locale: NS,
    inject: () => ({ api }),
  }, FrameParticipationDock))
}
