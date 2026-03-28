# Agent Instructions

- Use British English for interface text and written content.
- Keep everything minimal.
- Make the smallest change that fully solves the request.
- Do not refactor, rename, reorganize, or reformat unless explicitly asked.
- Do not add dependencies, files, components, hooks, helpers, or abstractions unless required.
- Reuse existing code, patterns, and styles before creating anything new.
- Do not fix unrelated issues or add optional improvements.
- When multiple solutions work, choose the one with the fewest files changed and the fewest lines added.
- Prefer editing existing files over creating new ones.
- Keep responses brief and avoid suggesting extras unless asked.
- Prioritise clear, mobile-first layouts.
- Prefer semantic HTML for interactive UI. For prompt or search inputs with an action button, use a form so Enter submits by default.
- For iPhone and small screens, prefer stacked controls, 16px input text, adequate tap targets, `dvh`, and safe-area-aware spacing.
- This project is a web UI for pi-agent.
- Prefer using Tailwind classes rather than adding CSS declarations.
- When the user says "remember" or "note", update this `AGENTS.md` file with the instruction to retain it for future work.
