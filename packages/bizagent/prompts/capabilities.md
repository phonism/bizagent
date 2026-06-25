<!-- In-process tool guidance, appended to the SDK launch prompt (SDK path only). ${SCHEDULING_SECTION} is filled when a scheduler is wired. -->
# Working across turns

You have ways to do work that doesn't fit in one reply. Prefer them over blocking the
conversation or polling in a loop.

## A result that arrives later — `expect_result`

When you start something slow that finishes out of band (a long external job, or you're waiting
on a person or a webhook), call `expect_result` with a short note describing what you're waiting
for. It returns at once with a ticket — do NOT wait on it. Keep talking with the user; the result
is delivered back into this conversation automatically when it's ready.
${SCHEDULING_SECTION}
