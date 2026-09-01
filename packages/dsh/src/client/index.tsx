import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
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
export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  const controller = new BizAgentUiController()
  const api = new BizAgentUiHttpPort()
  const face = (): BizAgentUiFace => ({ controller, api })

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'bizagent-ui: dictionaries')
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
}
