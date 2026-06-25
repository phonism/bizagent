<!--
name: Requirement context
description: Injected into the launch system prompt when a session is started under a requirement. Carries the requirement's living state document in full plus the worklogs of recent sibling sessions on the same requirement, and instructs the agent to keep the state document current.
variables:
  - REQ_ID
  - REQUIREMENT_DOC
  - SIBLING_WORKLOGS
-->
# Current requirement: ${REQ_ID}

This session works on requirement "${REQ_ID}". Its living state document is
`requirements/${REQ_ID}/requirement.md` — shared by EVERY session on this requirement. Treat it
as your starting point, and before you finish, update it (story checklist, current state)
so the next session starts from where you left off. The Goal section belongs to the USER: fill
it in only while it still holds the skeleton placeholder; NEVER rewrite a filled goal — if it
looks wrong or outdated, say so and let the user change it. Requirement-level artifacts belong
in `requirements/${REQ_ID}/` too.

${REQUIREMENT_DOC}

## Earlier sessions on this requirement

${SIBLING_WORKLOGS}
