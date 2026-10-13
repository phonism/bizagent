// A minimal in-memory DSH storage/session adapter for the learning lab.
// The production plugin gets these facilities from DSH; do not use this adapter for real data.
import { LearningLedger } from '../lib/ledger.js'
import { WorkLedger } from '../lib/work-ledger.js'
import { ProjectLedger } from '../lib/project-ledger.js'
import { WorklogLedger } from '../lib/worklog-ledger.js'

export async function createDemoRuntime() {
  const tables = new Map()
  const sessions = new Map()
  const facility = {
    async open() {
      return {
        table(name) {
          if (!tables.has(name)) {
            const records = new Map()
            tables.set(name, {
              get: key => structuredClone(records.get(key)),
              entries: () => structuredClone(records).entries(),
              async put(key, value) { records.set(key, structuredClone(value)) },
            })
          }
          return tables.get(name)
        },
        async close() {},
      }
    },
  }
  const ledger = await LearningLedger.open(facility)
  const workLedger = await WorkLedger.open(facility)
  const projectLedger = await ProjectLedger.open(facility)
  const worklogLedger = await WorklogLedger.open(facility)
  return {
    ledger,
    workLedger,
    projectLedger,
    worklogLedger,
    reopenLedger: () => LearningLedger.open(facility),
    reopenWorkLedger: () => WorkLedger.open(facility),
    reopenProjectLedger: () => ProjectLedger.open(facility),
    reopenWorklogLedger: () => WorklogLedger.open(facility),
    sessionQuery: {
      async listSessions() {
        return [...sessions.values()].map(snapshot => ({ header: structuredClone(snapshot.session), live: false, persisted: true }))
      },
      async readSession(id) {
        const session = sessions.get(id)
        if (!session) throw new Error(`Unknown demo session: ${id}`)
        return structuredClone(session)
      },
    },
    appendSessionEvent(id, event) {
      const session = sessions.get(id)
      if (!session) throw new Error(`Unknown demo session: ${id}`)
      session.events.push(structuredClone(event))
    },
    agent(id, cwd, message) {
      const events = [
        { seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } },
        { seq: 1, time: 2, type: 'user/message', data: { content: [{ type: 'text', text: message }] } },
      ]
      sessions.set(id, { session: { id, cwd }, events })
      return { id, session: liveSession({ id, cwd }, events) }
    },
  }
}

/** The part of a live DSH Session the plugin reads: its header and a snapshot of its event log. */
export function liveSession(header, events) {
  return { header, events, snapshotEvents: () => events }
}
