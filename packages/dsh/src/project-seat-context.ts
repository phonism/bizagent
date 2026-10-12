import type { HomeAddress, ProjectSeatAddress } from './domain.js'
import type { FormalProject, ProjectSeat } from './project-ledger.js'
import { inlineText, untrustedBlock } from './untrusted-text.js'

export interface ProjectSeatContext {
  projectId: string
  projectRevision: number
  title: string
  goal: string
  doneWhen: string
  status: FormalProject['status']
  lead: HomeAddress
  seatAddress: ProjectSeatAddress
  homeAddress: HomeAddress
  responsibility: string
}

export function projectSeatContext(project: FormalProject, seat: ProjectSeat): ProjectSeatContext {
  return {
    projectId: project.id, projectRevision: project.revision,
    title: project.title, goal: project.goal, doneWhen: project.doneWhen,
    status: project.status,
    lead: project.lead, seatAddress: seat.address as ProjectSeatAddress,
    homeAddress: seat.homeAddress, responsibility: seat.responsibility,
  }
}

/** Situates a Home-bound Session in one Seat without claiming a separate execution identity. */
export function renderProjectSeatContext(context: ProjectSeatContext): string {
  return [
    '# Project Seat context',
    `Project ID: ${inlineText(context.projectId)}`,
    `Project revision: ${context.projectRevision}`,
    `Project status: ${inlineText(context.status)}`,
    `Project title: ${inlineText(context.title)}`,
    `Project lead: ${inlineText(context.lead)}`,
    `Your Seat address: ${inlineText(context.seatAddress)}`,
    `Your execution Home: ${inlineText(context.homeAddress)}`,
    '',
    untrustedBlock('Your responsibility', context.responsibility),
    '',
    untrustedBlock('Project goal', context.goal),
    '',
    untrustedBlock('Done when', context.doneWhen),
    '',
    'This Session uses the execution Home above. The Seat address routes and attributes Project messages; it does not change tool authority.',
    'Read the current Project with bizagent_project_read before relying on its Work or artifacts. The revision above may become stale.',
    'For a Project reply, use bizagent_inbox_send with reply_to. A new Project message needs project_id. An ordinary reply does not complete formal Work.',
  ].join('\n')
}
