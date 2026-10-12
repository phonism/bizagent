import type { HomeAddress, ProjectSeatAddress } from './domain.js'
import type { FormalProject, ProjectSeat } from './project-ledger.js'

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
    `Project ID: ${context.projectId}`,
    `Project revision: ${context.projectRevision}`,
    `Project status: ${context.status}`,
    `Project title: ${context.title}`,
    `Project lead: ${context.lead}`,
    `Your Seat address: ${context.seatAddress}`,
    `Your execution Home: ${context.homeAddress}`,
    `Your responsibility: ${context.responsibility}`,
    `Project goal: ${context.goal}`,
    `Done when: ${context.doneWhen}`,
    '',
    'This Session uses the execution Home above. The Seat address routes and attributes Project messages; it does not change tool authority.',
    'Read the current Project with bizagent_project_read before relying on its Work or artifacts. The revision above may become stale.',
    'For a Project reply, use bizagent_inbox_send with reply_to. A new Project message needs project_id. An ordinary reply does not complete formal Work.',
  ].join('\n')
}
