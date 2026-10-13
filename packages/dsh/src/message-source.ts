import type { ContextFormed } from '@deepseek-ai/dsh-llm'

// DSH 0.2 has no shared `plugin` source kind; each producer declares its own.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    bizagent: { kind: 'bizagent' } & ContextFormed
  }
}

export const BIZAGENT_SOURCE_KIND = 'bizagent'
