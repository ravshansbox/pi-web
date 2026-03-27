# Plan

## Goal
Build a small, clear web UI for pi-agent that supports one primary flow: enter a prompt, submit it, stream progress in real time, then show either a completed response or an error.

## Chosen architecture
- Use a small local Node backend for agent integration
- Use the pi SDK in the backend rather than spawning pi through RPC
- Use WebSocket between the browser UI and the backend for real-time updates
- Keep the first version minimal and avoid adding protocol surface the UI does not yet need

## Scope
- Keep the UI work centred on `src/App.tsx`
- Keep `src/index.css` minimal
- Add only the backend files needed to host a local WebSocket bridge to the pi SDK
- Avoid extra components, hooks, helpers, or abstractions unless the code becomes unclear without them

## Current state
- [x] Vite + React + TypeScript app is set up
- [x] Tailwind is installed and available through Vite
- [x] App content lives in `src/App.tsx` and is rendered from `src/index.tsx`
- [x] A placeholder UI is in place
- [x] No pi-agent integration exists in this repo yet

## Primary flow
- [ ] Replace the placeholder with a single-screen prompt workflow in `src/App.tsx`
- [ ] Add one prompt input area suitable for short and long requests
- [ ] Add one primary submit control
- [ ] Add one response area that can render streamed agent output
- [ ] Connect the UI to the backend over one WebSocket connection
- [ ] Keep UI state local unless the file becomes genuinely unclear

## Realtime integration
- [ ] Add a small backend entrypoint that creates and owns a pi SDK session
- [ ] Translate backend session events into a minimal browser-safe WebSocket protocol
- [ ] Support one client command in v1: `prompt`
- [ ] Support one optional client control in v1 if cheap to add safely: `abort`
- [ ] Support these server events in v1:
  - [ ] `run_started`
  - [ ] `text_delta`
  - [ ] `run_completed`
  - [ ] `run_failed`
- [ ] Keep tool events, steer, and follow-up out of v1 unless the UI genuinely needs them

## Session model
- [ ] Start with the smallest honest ownership model, preferably one backend agent session per browser connection
- [ ] Keep the first version single-user and local
- [ ] Avoid pretending to support persistence, history, or multi-client coordination before those behaviours are implemented

## Layout
- [ ] Build a simple mobile-first page shell in `src/App.tsx`
- [ ] Add sensible padding, vertical rhythm, and a readable max width
- [ ] Keep the form and output stacked on small screens
- [ ] Let the layout breathe slightly more on larger screens without changing the flow

## Styling
- [ ] Use Tailwind for the core visual styles
- [ ] Keep `src/index.css` to the Tailwind import and only truly global essentials if needed
- [ ] Define clear typography, spacing, and contrast using existing utilities
- [ ] Keep the interface visually quiet and uncluttered

## UI states
- [ ] Empty state: show the prompt field with brief helper copy
- [ ] Connecting state: show clear backend connection feedback if the socket is not ready
- [ ] Processing state: disable duplicate submission and show live activity while text streams in
- [ ] Success state: show the completed response in a readable panel
- [ ] Error state: show a short, honest error message with an obvious retry path
- [ ] Ensure every state remains clear and usable on small screens

## Content
- [ ] Use British English in labels and copy
- [ ] Keep labels short and literal
- [ ] Remove any non-essential text or controls

## Implementation approach
- [ ] Make the change incrementally rather than through broad refactors
- [ ] Reuse existing repo patterns before introducing anything new
- [ ] Choose the smallest implementation that can truthfully represent the chosen real-time flow
- [ ] Keep transport and UI contracts explicit rather than inferred from incidental code
- [ ] Avoid fake complexity such as extra components or shared state before it is needed

## Validation
- [ ] Run `npm run build`
- [ ] Run the local app and backend together
- [ ] Verify the socket connects and the prompt flow is observable end to end
- [ ] Verify `run_started`, `text_delta`, `run_completed`, and `run_failed` can each be observed or forced deliberately
- [ ] Check the layout at a small mobile width and a wider desktop width

## Done when
- [ ] The placeholder is replaced by a minimal prompt-and-response UI with live updates
- [ ] The UI talks to a local backend over WebSocket
- [ ] The backend talks to pi through the SDK
- [ ] The main states are explicit and understandable
- [ ] The implementation stays small, local, and easy to extend
