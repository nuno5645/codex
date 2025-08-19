Codex Web Server (experimental)

A minimal Axum-based HTTP server exposing a simple browser UI and SSE event stream for the Codex agent.

How to run (macOS):

1. Install Rust toolchain
   - brew install rustup
   - rustup-init -y
   - Restart your shell or source $HOME/.cargo/env
2. Build and run
   - cd codex-rs
   - cargo run -p codex-web-server
3. Open the UI
   - Visit http://localhost:4321

Endpoints:
- POST `/api/start` — body: `{ prompt, full_auto?, cwd?, images? }` → `{ task_id }`
- GET `/api/events/:task_id` — Server-Sent Events (1 JSON event per line)
- GET `/api/browse?path=/optional/abs/or/relative/path` — JSON directory listing
- POST `/api/compact/:task_id` — request conversation compaction (like CLI `/compact`)
- GET `/api/diff?cwd=/path` — return `{ is_git_repo, diff }` for Git diff (untracked included)

Notes:
- The server binds to `127.0.0.1:4321` for local development and enables permissive CORS.
- Static UI is served from `/` (files under `src/public/`).
- The directory browser hides dotfiles and returns directories first, then files.

Slash Commands (UI):
- `/new` — clear chat and start fresh
- `/init` — sends an initialization prompt to create `AGENTS.md`
- `/compact` — compacts current conversation on the server
- `/diff` — shows `git diff` (plus untracked files) for selected working dir
- `/mention` — inserts `@` at the cursor
- `/status` — renders current model, tokens, and cwd
- `/logout`, `/quit` — informational in the web UI

The UI is static assets under src/public/index.html.
