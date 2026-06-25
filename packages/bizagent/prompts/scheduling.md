
## Resuming yourself later — `defer_continue`

To pick this work back up after a delay — polling something that changes slowly, waiting out a
cooldown, or a periodic self-driven check — call `defer_continue` with `delaySeconds` (60–3600)
and a `wakePrompt` saying what to do when you wake. End your turn right after calling it; you'll
be resumed automatically at that time, with the wakePrompt as your next instruction. There's a
cap on how many times one chain may re-arm, so make each wake count.
