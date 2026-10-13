// Building blocks for hosts that bring their own user authentication, notification channels,
// or backup jobs. The local single-user setup does not need them: `@bizagent/dsh/local-human-host`
// mounts the review and Inbox routes for one person on 127.0.0.1.

export { BIZAGENT_PROJECT_REVIEW_API } from './ui-contract.js'
export { createProjectReviewHttpHandler, registerProjectReviewRoute } from './project-review-transport.js'
export type { ProjectReviewPrincipal, ProjectReviewRouteOptions } from './project-review-transport.js'
export { BIZAGENT_PROPOSAL_REVIEW_API, createProposalReviewHttpHandler,
  registerProposalReviewRoute } from './proposal-review-transport.js'
export type { ProposalReviewPrincipal, ProposalReviewRouteOptions } from './proposal-review-transport.js'
export { SHARED_KNOWLEDGE_REVIEW_API, createSharedKnowledgeReviewHttpHandler,
  registerSharedKnowledgeReviewRoute } from './shared-knowledge-review-transport.js'
export type { SharedKnowledgeReviewOptions } from './shared-knowledge-review-transport.js'
export { HUMAN_INBOX_API, createHumanInboxHttpHandler, registerHumanInboxRoute } from './human-inbox-transport.js'
export type { HumanInboxPrincipal, HumanInboxRouteOptions } from './human-inbox-transport.js'

export { HumanNotificationRunner } from './human-notification-runner.js'
export type { HumanNotificationProvider, HumanNotificationRequest, HumanNotificationOutcome,
  HumanNotificationPass, HumanNotificationRunnerOptions, HumanNotificationPolicyDecision } from './human-notification-runner.js'
export { HumanNotificationWebhook } from './human-notification-webhook.js'
export type { HumanNotificationWebhookOptions } from './human-notification-webhook.js'
export { HumanTurnCompletionNotifier } from './human-turn-completion.js'
export type { HumanTurnCandidate, HumanTurnDestination, HumanTurnCompletionSource,
  HumanTurnPersistence, HumanTurnCompletionPass } from './human-turn-completion.js'
export { InboxStalledEscalationRunner } from './inbox-stalled-escalation-runner.js'
export type { EscalationOwnerDecision, StalledEscalationPass } from './inbox-stalled-escalation-runner.js'
export { stalledInboxTopics } from './inbox-stalled-topic.js'
export type { StalledInboxTopic } from './inbox-stalled-topic.js'

export { exportHomeArchive, verifyHomeArchive, importHomeArchive } from './home-archive.js'
export type { HomeArchiveManifest } from './home-archive.js'
