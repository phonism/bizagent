<!--
name: CLAUDE.md (assistant seed)
description: The seed CLAUDE.md for an assistant workspace — the assistant's PERSONA, owned by the host that mounted the IM channel. The host overwrites this file right after newAssistant returns (with the channel-specific persona); this seed only exists so the file is non-empty before the host writes its real persona. assemble() writes this only when the file is missing or still the legacy pointer — real content is never clobbered.
variables:
  - IM
-->
<!-- bizagent:assistant-claude-md-seed — this file is still the empty skeleton; the host that mounts the IM channel overwrites it with the assistant's real persona. -->
# Assistant: ${IM}

This is an IM-channel assistant workspace. Each inbound chat from the channel runs as a session here, on behalf of the user who messaged in.

The host that mounted the channel should replace this file with the assistant's real persona — voice, scope, what it can / can't touch, formatting rules for the channel's markdown subset, and so on. Until then, this seed marks the file as "not yet filled in".
