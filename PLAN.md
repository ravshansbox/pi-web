# Plan

## Goal
Extend the current pi web UI to support a home-rooted folder browser, session selection, session creation, and bookmarkable URLs that restore the chosen folder and session.

## Product flow
1. On first load, show folders from the user's home directory.
2. Let the user either enter a folder to browse deeper or choose a folder to work on.
3. After a folder is chosen, show sessions for that folder.
4. Let the user choose an existing session or create a new one.
5. After a session is chosen, show the chat UI for that folder and session.

## Path model
- Treat the user's home directory as the root.
- Do not allow browsing or selecting anything outside the home directory.
- Represent folders everywhere in the UI and URL as home-relative paths.
- Do not expose absolute paths in the browser.

Examples:
- home root: `folder=`
- nested folder: `folder=Projects/pi-web`
- session URL: `?folder=Projects/pi-web&session=abc123`

## URL model
- Make the selected folder and selected session bookmarkable.
- Keep the URL minimal.
- Store only:
  - `folder` as a home-relative path
  - `session` as the session id
- Do not store provider or model in the URL.

## Backend responsibilities
- Resolve all requested folder paths relative to the user's home directory.
- Reject absolute paths.
- Reject any path that escapes the home directory via `..` or similar traversal.
- List folders for a given relative path.
- Select a working folder.
- List sessions for the selected folder.
- Create a new session for the selected folder.
- Open an existing session for the selected folder.
- Hydrate the chosen session so the UI can restore message history and current session metadata.

## Frontend responsibilities
- Start in folder browsing mode.
- Show the current relative folder path being browsed.
- Provide one action to enter a folder and one action to choose it.
- After folder selection, show session selection UI.
- After session selection, show the existing chat UI.
- Read `folder` and `session` from the URL on load.
- Update the URL when folder or session selection changes.

## Suggested protocol additions
Client → server:
- `list_folders`
- `set_folder`
- `list_sessions`
- `create_session`
- `set_session`
- `hydrate_session`

Server → client:
- `folders_list`
- `folder_selected`
- `sessions_list`
- `session_created`
- `session_selected`
- `session_hydrated`
- `run_failed`

## Stages

### Stage 1: folder browser
- Add backend support for listing folders under home.
- Add backend validation for home-relative paths.
- Add a minimal frontend folder browser.
- Support entering a folder and choosing a folder.
- Keep this state separate from the chat UI.

### Stage 2: session picker
- Add backend support for listing sessions for a chosen folder.
- Use pi session management primitives for listing and opening sessions.
- Add frontend session selection UI.
- Add a minimal action to create a new session.

### Stage 3: session hydration
- Open the selected session on the backend.
- Return its existing messages to the frontend.
- Return current session metadata needed by the UI.
- Ensure prompt submission continues inside the selected session.

### Stage 4: bookmarkable URL
- Read `folder` and `session` from the URL on load.
- If only `folder` is present, open the session picker for that folder.
- If both `folder` and `session` are present, restore directly into chat.
- Use `history.replaceState` for selection changes.

## UI notes
- Keep the interface single-screen and minimal.
- Maintain the current mobile-first layout.
- Preserve Enter-to-submit behaviour in the prompt form.
- Keep Provider and Model inline.
- Keep the prompt composer compact on iPhone.

## Data notes
- Sessions are scoped to the chosen folder.
- Provider and model should come from the active or restored session state.
- If needed, the last assistant message can be used only as a fallback hint for display, not as the source of truth.

## Validation
- Run `npm run build`.
- Verify folder browsing never escapes home.
- Verify choosing a folder shows only that folder's sessions.
- Verify creating a session opens a fresh chat.
- Verify choosing an existing session restores its history.
- Verify bookmarkable URLs with `folder` and `session` restore correctly.
- Verify small-screen behaviour on iPhone remains usable.

## Done when
- The app starts with a home-rooted folder browser.
- The user can enter folders and choose a working folder.
- The user can choose or create a session for that folder.
- The chosen folder and session are reflected in the URL.
- Reloading with the same URL restores the same folder and session.
- The implementation stays minimal and local.
