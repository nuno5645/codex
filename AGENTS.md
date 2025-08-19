# Repository Guidelines

This guide applies only to the `codex-rs/web-server` crate. Please avoid changing unrelated crates.

## Project Structure & Module Organization
- Location: `codex-rs/web-server` (crate name: `codex-web-server`).
- Entry point: `src/main.rs` (Axum server + API routes, SSE streaming).
- Static assets: `src/public/` (served at `/`).
- Dependencies: `axum`, `tokio`, `tower-http`, `serde`, `tracing`, plus internal crates `codex-core` and `codex-protocol`.

## Build, Test, and Development Commands
- Run locally: `cd codex-rs && cargo run -p codex-web-server` → open `http://localhost:4321`.
- Release build: `cargo build -p codex-web-server --release`.
- Tests: `cargo test -p codex-web-server` (add tests under `web-server/tests/`).
- Format/lint (workspace): `cargo fmt` and `cargo clippy --all-features --tests`.
- Logs: `RUST_LOG=info` (or `debug,trace`) to control verbosity.

## Coding Style & Naming Conventions
- Rust edition 2024; `rustfmt` config in `codex-rs/rustfmt.toml`.
- Clippy rules deny `unwrap`/`expect`; use `?` and typed errors (`anyhow::Result` in `main`).
- Naming: `snake_case` for functions/vars, `PascalCase` for types.
- Route handlers should return `impl IntoResponse` and keep pure logic testable in small helpers.

## Testing Guidelines
- Prefer integration tests in `web-server/tests/*.rs` using `tokio::test`.
- Spin up the `Router` and call endpoints with a test client; assert status codes and JSON shapes.
- Example: `cargo test -p codex-web-server start_task` filters tests by name.

## Commit & Pull Request Guidelines
- Conventional Commits: `feat(web-server): ...`, `fix(web-server): ...` to scope changes.
- PRs must include: concise description, rationale, linked issues, and manual test steps (URLs/endpoints invoked). Update `web-server/README.md` if behavior or routes change.

## Security & Configuration Tips
- The server binds `127.0.0.1:4321` and enables wide CORS for local dev. Do not expose externally (`0.0.0.0`) without reviewing CORS and auth.
- No secrets should be hardcoded. Use `RUST_LOG` for diagnostics; avoid leaking sensitive paths or data in logs.
