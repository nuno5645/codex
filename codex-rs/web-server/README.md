Codex Web Server (experimental)

A minimal Axum-based HTTP server exposing a simple browser UI and SSE event stream for the Codex agent.

How to run (macOS):

1. Install Rust toolchain
   - brew install rustup
   - rustup-init -y
   - Restart your shell or source $HOME/.cargo/env
2. Build and run
   - cd codex-rs
   - cargo run -p codex-web-server [-- --working-directory /path/to/project]
3. Open the UI
   - Visit http://localhost:4321

Command Line Options:
- `--working-directory <DIR>` or `-w <DIR>` - Specify the working directory to serve (defaults to current directory)

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
- All file operations are restricted to the specified working directory for security.

Web CLI UI (served from `/`):
- Terminal-like streaming of agent events (SSE)
- Start runs with Enter; Shift+Enter inserts newline
- Full-auto toggle (approval-policy never)
- Optional `cwd` input and image attachments
- Live tokens/model/session indicators
- Conversation list sidebar; click to load and continue
- Cancel and Compact actions for the current task

Static assets live under `src/public/index.html`.
