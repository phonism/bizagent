import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import type { BizAgentService } from './service.js'
import type { InboxMessage } from './domain.js'
import type { WorkRunner } from './work-runner.js'
import type { LearningSessionRunner } from './learning-session-runner.js'
import type { FormalWork } from './work-ledger.js'

const JSON_OUTPUT = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{
    type: 'text' as const,
    text: JSON.stringify(value, null, 2),
  }],
}

const TAGS = {
  type: 'array' as const,
  description: 'Optional short retrieval tags.',
  items: { type: 'string' as const },
}

export function registerTools(ctx: Context, service: BizAgentService, workRunner: WorkRunner,
  learningRunner: LearningSessionRunner,
  onInboxSent?: (message: InboxMessage) => void): void {
  ctx.tools.register(defineTool({
    name: 'bizagent_home_status',
    description: 'Inspect the current session\'s immutable Agent Home binding, revision, memory counts, and proposal queue.',
    parameters: {},
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => jsonResult(service.homeStatus(requireAgent(exec.agent))),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_episodes',
    description: 'List DSH Sessions bound to the current Agent Home, newest first. Use a returned session id to read one episode.',
    parameters: {
      before_session_id: { type: 'string', description: 'Pagination cursor returned as nextBeforeSessionId.' },
      limit: { type: 'integer', description: 'Maximum sessions, from 1 to 100. Defaults to 20.' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.listEpisodes(requireAgent(exec.agent), {
      ...(args.before_session_id !== undefined ? { beforeSessionId: args.before_session_id } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_episode_read',
    description: 'Read a bounded page of raw DSH events from a Session bound to the current Agent Home. Events are evidence, not automatically validated learning.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Session id returned by bizagent_episodes.' },
      after_seq: { type: 'integer', description: 'Read events after this sequence. Use nextAfterSeq to continue.' },
      limit: { type: 'integer', description: 'Maximum events, from 1 to 24. Defaults to 24.' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.readEpisode(requireAgent(exec.agent), {
      sessionId: args.session_id,
      ...(args.after_seq !== undefined ? { afterSeq: args.after_seq } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_worklog_record',
    description: 'Save an immutable revision of this Session\'s work summary, backed by its DSH event fingerprint and optional retained Workspace file snapshots. This is work history, not validated Memory.',
    parameters: {
      description: { type: 'string', required: true, description: 'Short searchable summary, up to 240 characters.' },
      body: { type: 'string', required: true, description: 'Outcome, decisions, and useful context, up to 16000 characters.' },
      status: { type: 'string', required: true, enum: ['ongoing', 'completed', 'blocked', 'failed'] },
      idempotency_key: { type: 'string', required: true, description: 'Stable key for this exact revision. Use a new key when revising.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Up to 10 canonical paths relative to this Session Workspace; each file must be at most 8 MiB and its bytes are retained in the Home archive.' },
      project_id: { type: 'string', description: 'Optional visible Project id.' },
      work_id: { type: 'string', description: 'Optional formal Work id owned by this exact Session.' },
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.recordWorklog(requireAgent(exec.agent), {
      description: args.description, body: args.body, status: args.status,
      idempotencyKey: args.idempotency_key,
      ...(args.files !== undefined ? { files: args.files } : {}),
      ...(args.project_id !== undefined ? { projectId: args.project_id } : {}),
      ...(args.work_id !== undefined ? { workId: args.work_id } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_worklogs',
    description: 'Search the latest Worklog revision per Session in the current Home. Returns short descriptions; read a matching Worklog for its body and source status.',
    parameters: {
      query: { type: 'string', description: 'Case-insensitive substring across summary, body, links, and file paths.' },
      status: { type: 'string', enum: ['ongoing', 'completed', 'blocked', 'failed'] },
      before_session_id: { type: 'string', description: 'Pagination cursor returned as nextBeforeSessionId.' },
      limit: { type: 'integer', description: 'Maximum results, from 1 to 100. Defaults to 20.' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.searchWorklogs(requireAgent(exec.agent), {
      ...(args.query !== undefined ? { query: args.query } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.before_session_id !== undefined ? { beforeSessionId: args.before_session_id } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_worklog_read',
    description: 'Read one Worklog revision in the current Home, with its full body, prior revision index, Session evidence status, and current and retained file status.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Session id from bizagent_worklogs or bizagent_episodes.' },
      revision: { type: 'integer', description: 'Specific positive revision number; defaults to the latest.' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.readWorklog(requireAgent(exec.agent), {
      sessionId: args.session_id,
      ...(args.revision !== undefined ? { revision: args.revision } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_worklog_file_read',
    description: 'Read a bounded byte range from a file snapshot retained by one Worklog revision. Returns base64 bytes even if the Workspace file later changed or disappeared.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Session id that owns the Worklog.' },
      revision: { type: 'integer', description: 'Specific positive Worklog revision; defaults to the latest.' },
      path: { type: 'string', required: true, description: 'Canonical relative file path listed by bizagent_worklog_read.' },
      offset: { type: 'integer', description: 'Byte offset, from 0 to the snapshot size. Defaults to 0.' },
      limit: { type: 'integer', description: 'Maximum bytes, from 1 to 65536. Defaults to 8192.' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.readWorklogFile(requireAgent(exec.agent), {
      sessionId: args.session_id, path: args.path,
      ...(args.revision !== undefined ? { revision: args.revision } : {}),
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_learning_materials',
    description: 'Scan earlier Sessions and authored Worklog revisions bound to this Home for new or changed learning material. Reading does not mark it reviewed; each result freezes one source fingerprint.',
    parameters: {
      before_session_id: { type: 'string', description: 'Pagination cursor returned as nextBeforeSessionId.' },
      limit: { type: 'integer', description: 'Maximum Sessions to inspect, from 1 to 20. Defaults to 10.' },
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.scanLearningMaterials(requireAgent(exec.agent), {
      ...(args.before_session_id !== undefined ? { beforeSessionId: args.before_session_id } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_learning_review',
    description: 'Record that one frozen, current-Home learning material was deliberately reviewed. This does not publish memory. A changed Session will appear as new material on the next scan.',
    parameters: {
      material_id: { type: 'string', required: true, description: 'Material id returned by bizagent_learning_materials.' },
      summary: { type: 'string', required: true, description: 'What was learned, retained, or deliberately left unchanged, with a concrete reason.' },
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.reviewLearningMaterial(requireAgent(exec.agent), {
      materialId: args.material_id,
      summary: args.summary,
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_learning_batch_start',
    description: 'Freeze up to eight unreviewed Session or authored Worklog materials for a dedicated current-Home learning review. Only one batch may be open per Home. This Session is excluded from later learning scans.',
    parameters: {}, output: JSON_OUTPUT,
    execute: async (_args, exec) => jsonResult(service.startLearningBatch(requireAgent(exec.agent), String(exec.callId))),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_learning_batch_status',
    description: 'Read durable progress of a current-Home learning batch after a restart or lost response.',
    parameters: { run_id: { type: 'string', required: true } }, output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.learningBatchStatus(requireAgent(exec.agent), args.run_id)),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_learning_batch_change_read',
    description: 'Read retained before or after bytes for one actual managed Home file change recorded when a learning batch finished. Changes show concurrent writes too; they do not establish which Session caused them.',
    parameters: {
      run_id: { type: 'string', required: true },
      path: { type: 'string', required: true, description: 'Exact path from run.libraryChanges.' },
      side: { type: 'string', required: true, enum: ['before', 'after'] },
      offset: { type: 'integer', description: 'Byte offset in the retained snapshot, default 0.' },
      limit: { type: 'integer', description: 'Bytes to read, default 8192, maximum 65536.' },
    }, output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.readLearningBatchChange(requireAgent(exec.agent), {
      runId: args.run_id, path: args.path, side: args.side,
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_learning_batch_settle',
    description: 'Review one frozen material. Session candidates cite bounded event ranges; Worklog candidates cite the exact frozen Worklog revision and omit event sequence fields. All remain inactive until published. Empty candidates records a reasoned no-change review.',
    parameters: {
      run_id: { type: 'string', required: true },
      material_id: { type: 'string', required: true },
      summary: { type: 'string', required: true },
      candidates: { type: 'array', items: {
        type: 'object', additionalProperties: false, properties: {
          kind: { type: 'string', required: true, enum: ['memory', 'insight', 'knowledge', 'method'] },
          description: { type: 'string', required: true },
          body: { type: 'string', required: true },
          from_seq: { type: 'integer', description: 'Required for Session event material; omit for Worklog material.' },
          to_seq: { type: 'integer', description: 'Required for Session event material; omit for Worklog material.' },
          tags: TAGS,
        },
      } },
    }, output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.settleLearningBatchMaterial(requireAgent(exec.agent), {
      runId: args.run_id, materialId: args.material_id, summary: args.summary,
      ...(args.candidates !== undefined ? { candidates: args.candidates.map(item => ({
        kind: item.kind, description: item.description, body: item.body,
        ...(item.from_seq !== undefined ? { fromSeq: item.from_seq } : {}),
        ...(item.to_seq !== undefined ? { toSeq: item.to_seq } : {}),
        ...(item.tags !== undefined ? { tags: item.tags } : {}),
      })) } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_learning_batch_finish',
    description: 'Complete a fully reviewed batch in its reviewer Session, or abandon an interrupted batch from the same Home with a reason. Unreviewed materials remain available after abandonment.',
    parameters: {
      run_id: { type: 'string', required: true },
      action: { type: 'string', required: true, enum: ['complete', 'abandon'] },
      summary: { type: 'string', required: true },
    }, output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.finishLearningBatch(requireAgent(exec.agent), {
      runId: args.run_id, action: args.action, summary: args.summary,
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_learning_launch',
    description: 'Explicitly reserve and start one dedicated learning Session in the current Home mapped Workspace. A lost factory result is held for inspection; this tool never blindly creates another Session.',
    parameters: {
      idempotency_key: { type: 'string', required: true, description: 'Stable key for this exact launch.' },
      model: { type: 'string', description: 'Optional model for the dedicated Session.' },
    }, output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(learningRunner.request(requireAgent(exec.agent),
      args.idempotency_key, args.model)),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_learning_launch_read',
    description: 'Read current-Home learning launch, batch, and reported worker Session token usage. Missing usage stays unavailable; USD cost is unknown.',
    parameters: { launch_id: { type: 'string', required: true } }, output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(learningRunner.read(requireAgent(exec.agent), args.launch_id)),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_learning_launch_abandon',
    description: 'After inspection, abandon an uncertain learning launch only when its worker is not live and it has no open batch. Requires a concrete reason.',
    parameters: {
      launch_id: { type: 'string', required: true },
      reason: { type: 'string', required: true },
    }, output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(learningRunner.abandon(requireAgent(exec.agent),
      args.launch_id, args.reason)),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_agent_search',
    description: 'Find active Home addresses by name or address in this organization. Returns the current Personal Home and shared Business, Role, and Capability Homes; use the canonical address for Inbox, Work, or Project.',
    parameters: {
      query: { type: 'string', description: 'Optional case-insensitive Home name, type, or address fragment.' },
      limit: { type: 'integer', description: 'Maximum results, from 1 to 50. Defaults to 20.' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.searchHomes(requireAgent(exec.agent), {
      ...(args.query !== undefined ? { query: args.query } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_frame_status',
    description: 'Inspect read-only Agent Frames active in this Session, including whether context needs refreshing after DSH compaction. The primary Home and tool authority remain unchanged.',
    parameters: {},
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => jsonResult(service.frameStatus(requireAgent(exec.agent))),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_frame_open',
    description: 'Explicitly attach a shared Business, Role, or Capability Home as read-only context in the current Session. Every result carries mode-specific participation guidance; opened, changed, or refreshed Frames also return bounded Identity and active asset index. Does not create an independent Agent or grant write access.',
    parameters: {
      address: { type: 'string', required: true, description: 'Canonical target Home address or a unique display name from bizagent_agent_search.' },
      mode: { type: 'string', enum: ['lead', 'contribute', 'reference'], description: 'lead guides domain reasoning, contribute adds a specialist perspective, reference supplies attributed material; defaults to lead. This does not change tool authority.' },
      refresh: { type: 'boolean', description: 'Force a new context epoch and return the full bounded Frame context. A successful DSH compaction triggers this automatically on the next open.' },
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.openFrame(requireAgent(exec.agent), {
      address: args.address,
      ...(args.mode !== undefined ? { mode: args.mode } : {}),
      ...(args.refresh !== undefined ? { refresh: args.refresh } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_frame_search',
    description: 'Search active assets of an explicitly opened read-only Agent Frame. Uses the most recently opened Frame when address is omitted.',
    parameters: {
      address: { type: 'string', description: 'An open Frame address; defaults to the current focus.' },
      query: { type: 'string', description: 'Optional case-insensitive text query.' },
      kind: { type: 'string', enum: ['memory', 'insight', 'knowledge', 'method', 'identity'] },
      limit: { type: 'integer', description: 'Maximum results, from 1 to 100. Defaults to 20.' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.searchFrame(requireAgent(exec.agent), {
      ...(args.address !== undefined ? { address: args.address } : {}),
      ...(args.query !== undefined ? { query: args.query } : {}),
      ...(args.kind !== undefined ? { kind: args.kind } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_frame_read',
    description: 'Read one active asset body from an explicitly opened Agent Frame and record a retrieval receipt; no cross-Home write permission is granted.',
    parameters: {
      asset_id: { type: 'string', required: true },
      address: { type: 'string', description: 'An open Frame address; defaults to the current focus.' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.readFrame(requireAgent(exec.agent), String(exec.callId), {
      assetId: args.asset_id,
      ...(args.address !== undefined ? { address: args.address } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_frame_close',
    description: 'Close one read-only Agent Frame; defaults to the current focus. Earlier tool results remain in the DSH transcript.',
    parameters: {
      address: { type: 'string', description: 'An open Frame address; defaults to the current focus.' },
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.closeFrame(requireAgent(exec.agent), args.address)),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_inbox_send',
    description: 'Send immutable Inbox mail to Agent Homes or users. In a Project, project_id resolves joined Homes to Seat addresses; replies inherit the parent Project and preserve historical sender addresses. A conclusion requires an existing Workspace file. An escalation requires a primary user:<id>, due, and human_action. Delivered means stored in the recipient inbox; it does not prove a push, read, or completed work.',
    parameters: {
      to: { type: 'array', required: true, items: { type: 'string' }, description: 'One to eight primary Home or user:<id> addresses.' },
      cc: { type: 'array', items: { type: 'string' }, description: 'Optional copy recipients; eight distinct recipients maximum overall.' },
      subject: { type: 'string', required: true },
      body: { type: 'string', required: true, description: 'Markdown message, up to 16000 characters.' },
      kind: { type: 'string', enum: ['ordinary', 'conclusion', 'escalation'], description: 'Defaults to ordinary. Conclusion or escalation closes the topic without waking an Agent.' },
      priority: { type: 'string', enum: ['normal', 'urgent'], description: 'Urgent messages wake an eligible primary recipient immediately; normal messages follow that Home\'s Inbox policy.' },
      due: { type: 'string', description: 'Optional ISO date-time for a one-time reminder if a primary recipient has not handled the letter.' },
      context_refs: { type: 'array', items: { type: 'string' }, description: 'Up to 16 source references. A conclusion requires one existing relative file path inside the bound Workspace.' },
      human_action: {
        type: 'object', additionalProperties: false,
        description: 'Required for escalation to a person: the requested decision and reason.',
        properties: {
          request: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          recommendation: { type: 'string' },
          href: { type: 'string', description: 'Optional application page path.' },
          label: { type: 'string' },
        },
      },
      reply_to: { type: 'string', description: 'Visible thread message id to reply to.' },
      project_id: { type: 'string', description: 'Optional Project context. Requires lead or active Seat membership; joined recipients route to their Seat addresses.' },
      idempotency_key: { type: 'string', description: 'Stable key for safe retry; defaults to the DSH tool call id.' },
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => {
      const result = await service.sendInboxMessage(requireAgent(exec.agent), String(exec.callId), {
        to: args.to,
        ...(args.cc !== undefined ? { cc: args.cc } : {}),
        subject: args.subject, body: args.body,
        ...(args.kind !== undefined ? { kind: args.kind as 'ordinary' | 'conclusion' | 'escalation' } : {}),
        ...(args.priority !== undefined ? { priority: args.priority as 'normal' | 'urgent' } : {}),
        ...(args.due !== undefined ? { due: args.due } : {}),
        ...(args.context_refs !== undefined ? { contextRefs: args.context_refs } : {}),
        ...(args.human_action !== undefined ? { humanAction: args.human_action } : {}),
        ...(args.reply_to !== undefined ? { replyTo: args.reply_to } : {}),
        ...(args.project_id !== undefined ? { projectId: args.project_id } : {}),
        ...(args.idempotency_key !== undefined ? { idempotencyKey: args.idempotency_key } : {}),
      })
      const message = result.message as InboxMessage
      if (message.kind === 'ordinary') onInboxSent?.(message)
      return jsonResult(Promise.resolve(result))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_inbox',
    description: 'List incoming, outgoing, or both message headers for the current Home. Incoming defaults to all delivered messages; pending_only selects unhandled messages.',
    parameters: {
      direction: { type: 'string', enum: ['incoming', 'outgoing', 'both'] },
      pending_only: { type: 'boolean' },
      before_message_id: { type: 'string' },
      limit: { type: 'integer', description: 'Maximum 100 headers; defaults to 20.' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.listInbox(requireAgent(exec.agent), {
      ...(args.direction !== undefined ? { direction: args.direction as 'incoming' | 'outgoing' | 'both' } : {}),
      ...(args.pending_only !== undefined ? { pendingOnly: args.pending_only } : {}),
      ...(args.before_message_id !== undefined ? { beforeMessageId: args.before_message_id } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_inbox_read',
    description: 'Read one Inbox message visible to the current Home. Reading does not mark it handled.',
    parameters: { message_id: { type: 'string', required: true } },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.readInboxMessage(requireAgent(exec.agent), args.message_id)),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_inbox_handle',
    description: 'Mark one delivered message handled in the current Home inbox. This is a mailbox receipt, not a Work result or approval.',
    parameters: { message_id: { type: 'string', required: true } },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.handleInboxMessage(requireAgent(exec.agent), args.message_id)),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_project_create',
    description: 'Create one durable Project owned by the current Home, with a goal and completion standard. Reuse the idempotency key on retry.',
    parameters: {
      title: { type: 'string', required: true },
      goal: { type: 'string', required: true },
      done_when: { type: 'string', required: true, description: 'Concrete completion standard for later review.' },
      idempotency_key: { type: 'string', required: true },
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.createProject(requireAgent(exec.agent), {
      title: args.title, goal: args.goal, doneWhen: args.done_when, idempotencyKey: args.idempotency_key,
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_projects',
    description: 'List Projects led by the current Home or visible through an active Project Seat. A Project status is not evidence that DSH agents are currently running.',
    parameters: {
      status: { type: 'string', enum: ['open', 'awaiting_acceptance', 'accepted'] },
      before_project_id: { type: 'string', description: 'Pagination cursor returned as nextBeforeProjectId.' },
      limit: { type: 'integer', description: 'Maximum 100 Projects; defaults to 20.' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.listProjects(requireAgent(exec.agent), {
      ...(args.status !== undefined ? { status: args.status as 'open' | 'awaiting_acceptance' | 'accepted' } : {}),
      ...(args.before_project_id !== undefined ? { beforeProjectId: args.before_project_id } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_project_read',
    description: 'As the lead or an active Project Seat Home, read one Project, its versioned submissions and reviews, and its linked formal Work.',
    parameters: { project_id: { type: 'string', required: true } },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.readProject(requireAgent(exec.agent), args.project_id)),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_project_turn_join',
    description: 'Bind the current DSH turn to an open Project before doing Project work in an ordinary Home Session. Unrelated later turns remain independent. Repeat in each new Project turn.',
    parameters: { project_id: { type: 'string', required: true } },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.joinProjectTurn(requireAgent(exec.agent), args.project_id)),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_project_invite',
    description: 'As the lead of an open Project, invite an active shared Agent Home to a durable Project Seat with a stated responsibility. The invitation grants Project read access; it does not dispatch or accept Work.',
    parameters: {
      project_id: { type: 'string', required: true },
      home_address: { type: 'string', required: true },
      responsibility: { type: 'string', required: true },
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.inviteProjectSeat(requireAgent(exec.agent), {
      projectId: args.project_id, homeAddress: args.home_address,
      responsibility: args.responsibility,
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_project_seat_release',
    description: 'As the Project lead, release a Seat with no unsettled linked formal Work and revoke its Project read access.',
    parameters: {
      project_id: { type: 'string', required: true },
      seat_address: { type: 'string', required: true },
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.releaseProjectSeat(requireAgent(exec.agent), {
      projectId: args.project_id, seatAddress: args.seat_address,
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_project_submit',
    description: 'Submit one result claim against the Project completion standard after all linked formal Work is terminal. Reference up to ten Workspace artifacts to retain their exact bytes; without artifacts, a delivered formal Work result is required. This does not prove no DSH run is active.',
    parameters: {
      project_id: { type: 'string', required: true },
      summary: { type: 'string', required: true },
      body: { type: 'string', required: true },
      done_when_assessment: { type: 'string', required: true },
      artifact_refs: { type: 'array', items: { type: 'string' }, description: 'Canonical files under artifacts/ in this Session Workspace; up to 10, each at most 8 MiB.' },
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.submitProject(requireAgent(exec.agent), {
      projectId: args.project_id, summary: args.summary, body: args.body,
      doneWhenAssessment: args.done_when_assessment,
      ...(args.artifact_refs !== undefined ? { artifactRefs: args.artifact_refs } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_project_artifact_read',
    description: 'Read a bounded byte range from an immutable artifact snapshot in one Project result claim. The source Workspace file may have changed or disappeared.',
    parameters: {
      project_id: { type: 'string', required: true },
      claim_id: { type: 'string', required: true },
      path: { type: 'string', required: true, description: 'Artifact path listed in the claim.' },
      offset: { type: 'integer', description: 'Byte offset, defaults to 0.' },
      limit: { type: 'integer', description: 'Maximum bytes, from 1 to 65536. Defaults to 8192.' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.readProjectArtifact(requireAgent(exec.agent), {
      projectId: args.project_id, claimId: args.claim_id, path: args.path,
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_project_review',
    description: 'As the lead Home, request rework on the exact pending Project claim. Final acceptance requires the authenticated human Project review route.',
    parameters: {
      project_id: { type: 'string', required: true },
      claim_id: { type: 'string', required: true },
      decision: { type: 'string', required: true, enum: ['rework'] },
      reason: { type: 'string', required: true },
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.reviewProject(requireAgent(exec.agent), {
      projectId: args.project_id, claimId: args.claim_id,
      decision: args.decision as 'accept' | 'rework', reason: args.reason,
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_work_dispatch',
    description: 'Create one formal Work responsibility and request notification, then start an independent DSH worker Session when the assignee has a mapped Workspace and both Homes have the same owner. Otherwise the Work stays open for the assignee\'s own Sessions. A launch failure is returned separately; the Work remains durable and can be retried with bizagent_work_start.',
    parameters: {
      to_address: { type: 'string', required: true, description: 'Assignee Agent Home address.' },
      goal: { type: 'string', required: true, description: 'What the assignee must achieve.' },
      acceptance_criteria: { type: 'string', required: true, description: 'Concrete completion criteria.' },
      idempotency_key: { type: 'string', required: true, description: 'Stable key for this responsibility; retries must reuse it.' },
      project_id: { type: 'string', description: 'Optional existing open Project led by the requester Home.' },
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => {
      const agent = requireAgent(exec.agent)
      const result = await service.dispatchWork(agent, {
        toAddress: args.to_address, goal: args.goal, acceptanceCriteria: args.acceptance_criteria,
        idempotencyKey: args.idempotency_key,
        ...(args.project_id !== undefined ? { projectId: args.project_id } : {}),
      })
      const work = result.work as FormalWork | undefined
      if (work?.status === 'open' && work.autoStart !== true
        && service.workAutoStartBlock(work.requester, work.assignee) === 'different-owner') {
        return JSON.parse(JSON.stringify({ ...result, workerLaunch: { status: 'not-started',
          reason: 'different-owner',
          detail: 'The requester and assignee Homes do not have the same owner, so no worker Session was started. '
            + 'The Work stays open for the assignee to accept from its own Session.' } })) as JsonValue
      }
      if (work?.status !== 'open' || work.autoStart !== true) return JSON.parse(JSON.stringify(result)) as JsonValue
      try {
        const workerLaunch = await workRunner.start(agent, work.id)
        return JSON.parse(JSON.stringify({ ...result, workerLaunch })) as JsonValue
      } catch (error) {
        service.recordRuntimeError(`Work start ${work.id}`, error)
        return JSON.parse(JSON.stringify({ ...result, workerLaunch: {
          status: 'failed', reason: error instanceof Error ? error.message : String(error),
        } })) as JsonValue
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_work_start',
    description: 'As the requester, create or resume the one reserved DSH worker Session for an existing Work and wake it with the request. Requires an assignee Workspace mapping and the same owner for the requester and assignee Homes. Safe to retry after a launch failure.',
    parameters: { work_id: { type: 'string', required: true } },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(workRunner.start(requireAgent(exec.agent), args.work_id)),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_work',
    description: 'List formal Work assigned to or requested by the current Home. Work status is separate from Inbox message handling.',
    parameters: {
      direction: { type: 'string', enum: ['assigned', 'requested', 'both'] },
      status: { type: 'string', enum: ['open', 'accepted', 'completing', 'completed', 'cancelled'] },
      before_work_id: { type: 'string' },
      limit: { type: 'integer', description: 'Maximum 100 Work records; defaults to 20.' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.listWork(requireAgent(exec.agent), {
      ...(args.direction !== undefined ? { direction: args.direction as 'assigned' | 'requested' | 'both' } : {}),
      ...(args.status !== undefined ? { status: args.status as 'open' | 'accepted' | 'completing' | 'completed' | 'cancelled' } : {}),
      ...(args.before_work_id !== undefined ? { beforeWorkId: args.before_work_id } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_work_accept',
    description: 'As the assigned Home, bind one formal Work to this exact DSH Session before executing or completing it. A second Session cannot take the same Work.',
    parameters: { work_id: { type: 'string', required: true } },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.acceptWork(requireAgent(exec.agent), args.work_id)),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_work_read',
    description: 'Read one formal Work and its request/result delivery status if the current Home is requester or assignee.',
    parameters: { work_id: { type: 'string', required: true } },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.readWork(requireAgent(exec.agent), args.work_id)),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_work_complete',
    description: 'As the assigned Home, reserve and deliver the single formal Work result. Competing completions return the first reserved result; an ordinary Inbox reply cannot complete Work.',
    parameters: {
      work_id: { type: 'string', required: true },
      subject: { type: 'string', required: true },
      body: { type: 'string', required: true, description: 'Concrete deliverable and evidence, up to 15000 characters.' },
      artifact_refs: { type: 'array', items: { type: 'string' }, description: 'Optional files under artifacts/ in the bound worker Workspace; up to 10 files of at most 8 MiB each.' },
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => {
      const result = await service.completeWork(requireAgent(exec.agent), {
        workId: args.work_id, subject: args.subject, body: args.body,
        ...(args.artifact_refs !== undefined ? { artifactRefs: args.artifact_refs } : {}),
      })
      workRunner.releaseWhenIdle(args.work_id)
      return JSON.parse(JSON.stringify(result)) as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_work_artifact_read',
    description: 'Read a bounded byte range from a completed formal Work result artifact snapshot. Available to requester and assignee.',
    parameters: {
      work_id: { type: 'string', required: true },
      path: { type: 'string', required: true, description: 'Artifact path recorded in the Work result.' },
      offset: { type: 'integer', description: 'Byte offset, defaults to 0.' },
      limit: { type: 'integer', description: 'Maximum bytes, from 1 to 65536. Defaults to 8192.' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.readWorkArtifact(requireAgent(exec.agent), {
      workId: args.work_id, path: args.path,
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_work_output_eval',
    description: 'Inspect frozen formal Work deliverables with deterministic empty-text and placeholder assertions. Each checked source cites retained SHA-256; skip is not pass.',
    parameters: { work_id: { type: 'string', required: true } },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.evaluateWorkOutput(requireAgent(exec.agent), args.work_id)),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_work_cancel',
    description: 'As the requester Home, cancel an open or accepted Work with a reason and notify the assignee. Result-reserved or completed Work cannot be cancelled.',
    parameters: {
      work_id: { type: 'string', required: true },
      reason: { type: 'string', required: true, description: 'Why this Work is no longer required.' },
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => {
      const result = await service.cancelWork(requireAgent(exec.agent), {
        workId: args.work_id, reason: args.reason,
      })
      workRunner.releaseWhenIdle(args.work_id)
      return JSON.parse(JSON.stringify(result)) as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_memory_search',
    description: 'Search the current Agent Home\'s long-term asset index. Read a useful hit before relying on its body.',
    parameters: {
      query: { type: 'string', description: 'Optional case-insensitive text query.' },
      kind: {
        type: 'string',
        enum: ['memory', 'insight', 'knowledge', 'method', 'identity'],
        description: 'Optional asset kind filter.',
      },
      status: {
        type: 'string',
        enum: ['candidate', 'active', 'superseded', 'retired'],
        description: 'Optional lifecycle filter. Defaults to active.',
      },
      limit: { type: 'integer', description: 'Maximum results, from 1 to 100. Defaults to 20.' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.searchMemory(requireAgent(exec.agent), {
      ...(args.query !== undefined ? { query: args.query } : {}),
      ...(args.kind !== undefined ? { kind: args.kind } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_memory_read',
    description: 'Read one long-term asset body from the current Agent Home and record a retrieved receipt.',
    parameters: {
      asset_id: { type: 'string', required: true, description: 'Asset id returned by bizagent_memory_search.' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.readMemory(
      requireAgent(exec.agent),
      String(exec.callId),
      args.asset_id,
    )),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_evidence_read',
    description: 'Read validated evidence cited by one current-Home learning asset.',
    parameters: {
      asset_id: { type: 'string', required: true, description: 'Asset whose evidence should be inspected.' },
      source_index: { type: 'integer', description: 'Zero-based sourceRefs index. Defaults to 0.' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.readEvidence(requireAgent(exec.agent), {
      assetId: args.asset_id,
      ...(args.source_index !== undefined ? { sourceIndex: args.source_index } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_memory_remember',
    description: 'Save evidence-backed learning to the current Home. Use candidate for unverified learning; only active assets enter future session indexes.',
    parameters: {
      kind: {
        type: 'string',
        enum: ['memory', 'insight', 'knowledge', 'method'],
        description: 'memory: contextual observation (default); insight: supported inference; knowledge: reusable facts; method: repeatable procedure.',
      },
      status: {
        type: 'string',
        enum: ['candidate', 'active'],
        description: 'Use candidate when validation is still needed. Defaults to active for established observations and explicit corrections.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'One concise index line describing when this memory is useful.',
      },
      body: { type: 'string', required: true, description: 'The complete reusable observation.' },
      tags: TAGS,
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.remember(requireAgent(exec.agent), String(exec.callId), {
      ...(args.kind !== undefined ? { kind: args.kind } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      description: args.description,
      body: args.body,
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_memory_update',
    description: 'Revise, retire, or publish learning owned by the current Home. Revise preserves lifecycle status. Read and validate a candidate before publishing it with expected_revision.',
    parameters: {
      asset_id: { type: 'string', required: true },
      action: { type: 'string', required: true, enum: ['revise', 'retire', 'publish'] },
      expected_revision: { type: 'integer', description: 'Revision returned by memory_read. Required for publish; recommended for revise/retire to reject stale edits.' },
      description: { type: 'string', description: 'Replacement index description for revise.' },
      body: { type: 'string', description: 'Replacement body for revise.' },
      tags: TAGS,
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.updateMemory(requireAgent(exec.agent), {
      assetId: args.asset_id,
      action: args.action,
      ...(args.expected_revision !== undefined ? { expectedRevision: args.expected_revision } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.body !== undefined ? { body: args.body } : {}),
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_memory_propose',
    description: 'Propose evidence-backed learning to another Agent Home. Never writes the target Home directly.',
    parameters: {
      to_address: {
        type: 'string',
        required: true,
        description: 'Canonical target such as role:growth-strategy.',
      },
      proposed_kind: {
        type: 'string',
        enum: ['memory', 'insight', 'knowledge', 'method'],
        description: 'Suggested maturity. Defaults to memory.',
      },
      target_asset_id: { type: 'string',
        description: 'Replace this active asset after opening its Home Frame; the proposal freezes its revision and body hash.' },
      description: { type: 'string', required: true, description: 'One concise target index line.' },
      body: { type: 'string', required: true, description: 'Full proposed content.' },
      tags: TAGS,
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.proposeMemory(requireAgent(exec.agent), String(exec.callId), {
      toAddress: args.to_address,
      ...(args.proposed_kind !== undefined ? { proposedKind: args.proposed_kind } : {}),
      ...(args.target_asset_id !== undefined ? { targetAssetId: args.target_asset_id } : {}),
      description: args.description,
      body: args.body,
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_knowledge_propose',
    description: 'Propose shared product-line or platform Knowledge. A human administrator must publish it.',
    parameters: {
      scope: { type: 'string', required: true, enum: ['line', 'common'] },
      line: { type: 'string', description: 'Product line ID, required for line scope.' },
      description: { type: 'string', required: true },
      body: { type: 'string', required: true },
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.proposeSharedKnowledge(
      requireAgent(exec.agent), String(exec.callId),
      args.scope === 'line'
        ? { scope: 'line', line: args.line ?? '', description: args.description, body: args.body }
        : { scope: 'common', description: args.description, body: args.body },
    )),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_knowledge_search',
    description: 'Search platform and authorized product-line shared Knowledge source indexes.',
    parameters: { query: { type: 'string', description: 'Optional case-insensitive text query.' } },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.searchSharedKnowledge(
      requireAgent(exec.agent), args.query,
    )),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_knowledge_read',
    description: 'Read one shared Knowledge document from its governed source directory.',
    parameters: {
      document_id: { type: 'string', required: true },
      scope: { type: 'string', required: true, enum: ['line', 'common'] },
      line: { type: 'string', description: 'Product line ID, required for line scope.' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.readSharedKnowledge(
      requireAgent(exec.agent), args.document_id,
      args.scope === 'line' ? { scope: 'line', line: args.line ?? '' } : { scope: 'common' },
    )),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_knowledge_proposals',
    description: 'List shared Knowledge proposals visible to the current Agent Home.',
    parameters: {
      status: { type: 'string', enum: ['pending', 'accepted', 'rejected'] },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.sharedKnowledgeProposals(
      requireAgent(exec.agent), args.status,
    )),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_proposals',
    description: 'List or inspect memory proposals visible to the current Agent Home.',
    parameters: {
      id: { type: 'string', description: 'Read one proposal by id.' },
      direction: { type: 'string', enum: ['incoming', 'outgoing', 'both'], description: 'Defaults to incoming.' },
      status: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'withdrawn'] },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.proposals(requireAgent(exec.agent), {
      ...(args.id !== undefined ? { id: args.id } : {}),
      ...(args.direction !== undefined ? { direction: args.direction } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_learning_checkpoint',
    description: 'Settle one BizAgent-issued explicit-correction checkpoint. Use exactly once when prompted by BizAgent.',
    parameters: {
      checkpoint_id: { type: 'string', required: true },
      action: { type: 'string', required: true, enum: ['remember', 'skip'] },
      description: { type: 'string', description: 'Required concise retrieval description for remember.' },
      body: { type: 'string', description: 'Required reusable rule or preference for remember.' },
      tags: TAGS,
      decision: { type: 'string', description: 'Required reason for skip; optional rationale for remember.' },
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => {
      const result = await service.settleLearningCheckpoint(requireAgent(exec.agent), {
        checkpointId: args.checkpoint_id,
        action: args.action,
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.body !== undefined ? { body: args.body } : {}),
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
        ...(args.decision !== undefined ? { decision: args.decision } : {}),
      })
      exec.concludeTurn()
      return JSON.parse(JSON.stringify(result)) as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_memory_use_outcomes',
    description: 'Inspect whether a Home asset was read or self-reported as applied before completed formal Work in the same worker Session. Shows source checks and submitted results, without assigning benefit.',
    parameters: {
      asset_id: { type: 'string', required: true },
      before_work_id: { type: 'string', description: 'Cursor returned by a previous use-outcomes page.' },
      limit: { type: 'integer', description: 'Maximum completed Work results, from 1 to 100. Defaults to 20.' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => jsonResult(service.memoryUseOutcomes(requireAgent(exec.agent), {
      assetId: args.asset_id,
      ...(args.before_work_id !== undefined ? { beforeWorkId: args.before_work_id } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'bizagent_memory_feedback',
    description: 'Record whether a recalled asset was applied, confirmed, contradicted, or failed in the current work.',
    parameters: {
      asset_id: { type: 'string', required: true },
      signal: {
        type: 'string',
        required: true,
        enum: ['applied', 'confirmed', 'contradicted', 'failed'],
      },
      outcome: { type: 'string', description: 'Short evidence-backed outcome note.' },
    },
    output: JSON_OUTPUT,
    execute: async (args, exec) => jsonResult(service.feedback(requireAgent(exec.agent), String(exec.callId), {
      assetId: args.asset_id,
      signal: args.signal,
      ...(args.outcome !== undefined ? { outcome: args.outcome } : {}),
    })),
  }))
}

function requireAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new Error('BizAgent tools require a live DSH Agent session')
  return agent
}

async function jsonResult(value: Promise<unknown>): Promise<JsonValue> {
  return JSON.parse(JSON.stringify(await value)) as JsonValue
}
