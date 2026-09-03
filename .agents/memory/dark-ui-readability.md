---
name: Dark UI readability
description: Contrast and interaction rules for the project's premium dark interface.
---

Keep the premium dark theme, but do not use faint text as decoration: explanatory copy, form labels, placeholders, selected states, and disabled-state guidance must remain easy to read at normal laptop brightness.

**Why:** The user explicitly flagged several core flows as difficult to use because low-opacity text and unclear controls blended into dark panels.

**How to apply:** When creating or revising dark UI, give primary actions a clear visual priority, make selected choices unambiguous, and accompany disabled actions with a short explanation of what the user needs to do next.

Keep a primary action's accessible name stable across idle, disabled, and loading states; show progress as secondary text rather than replacing the action name.

**Why:** Replacing the action label while a request is running makes the control harder to locate for keyboard and assistive-technology users.

**How to apply:** Keep the main verb (for example, “Get Clips”) present and add a short visible status such as “Creating…” beside it.