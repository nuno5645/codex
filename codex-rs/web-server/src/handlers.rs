use crate::config::detect_linux_sandbox_exe;
use crate::conversations::{get_conversation_list, get_conversation_detail, delete_conversation_file};
use crate::models::*;
use crate::registries::{REGISTRY, CONV_REGISTRY};

use std::path::PathBuf;
use std::collections::{HashMap, VecDeque};
use std::process::Stdio;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::sse::{Event as SseEvent, KeepAlive};
use axum::response::{IntoResponse, Sse};
use axum::Json;
use tokio_stream::{wrappers::BroadcastStream, StreamExt as _};
use uuid::Uuid;
use tracing::{debug, error, info, warn};

use codex_core::{
    NewConversation,
    config::{Config, ConfigOverrides},
    protocol::{Event, EventMsg, InputItem, Op},
};
use codex_protocol::config_types::SandboxMode;
use codex_common::CliConfigOverrides;

pub async fn start_task(
    State(state): State<AppState>,
    Json(query): Json<StartQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let StartQuery { prompt, full_auto: _, cwd, images, conversation_id, model, config_profile, overrides } = query;

    let sandbox_exe = detect_linux_sandbox_exe();

    // Parse generic `-c key=value` style overrides (TOML values)
    let cli_overrides_vec = if let Some(raw) = overrides {
        let cli = CliConfigOverrides { raw_overrides: raw };
        match cli.parse_overrides() {
            Ok(v) => v,
            Err(e) => return Err((StatusCode::BAD_REQUEST, format!("invalid overrides: {e}"))),
        }
    } else {
        Vec::new()
    };

    // Build ConfigOverrides similar to exec run_main, but allow model/profile overrides from request
    let overrides = ConfigOverrides {
        model,
        config_profile,
        approval_policy: Some(codex_core::protocol::AskForApproval::Never),
        sandbox_mode: Some(SandboxMode::WorkspaceWrite),
        cwd: cwd.map(std::path::PathBuf::from).or(Some(state.working_directory.clone())),
        model_provider: None,
        codex_linux_sandbox_exe: sandbox_exe, // was None
        base_instructions: None,
        include_plan_tool: Some(true),
        include_apply_patch_tool: Some(true),
        disable_response_storage: Some(false),
        show_raw_agent_reasoning: None,
    };

    debug!("Creating config with overrides: approval_policy={:?}, sandbox_mode={:?}, include_apply_patch_tool={:?}, include_plan_tool={:?}", 
           overrides.approval_policy, overrides.sandbox_mode, overrides.include_apply_patch_tool, overrides.include_plan_tool);
    
    let config = Config::load_with_cli_overrides(cli_overrides_vec, overrides)
        .map_err(|e| {
            error!("Failed to load config: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        })?;

    // Either create a new conversation or look up an existing one
    let (conversation_uuid, conversation, maybe_session_configured) = if let Some(cid_str) = conversation_id {
        let cid = Uuid::parse_str(cid_str.trim())
            .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid conversation_id: {e}")))?;
        let conv = state
            .manager
            .get_conversation(cid)
            .await
            .map_err(|e| (StatusCode::NOT_FOUND, format!("{e:#}")))?;
        (cid, conv, None)
    } else {
        let NewConversation {
            conversation_id,
            conversation,
            session_configured,
        } = state
            .manager
            .new_conversation(config)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
        (conversation_id, conversation, Some(session_configured))
    };

    let task_id = Uuid::new_v4().to_string();

    // Acquire or create a single broadcast channel per conversation
    let tx = match CONV_REGISTRY.get(&conversation_uuid).await {
        Some(existing) => existing,
        None => {
            let (conv_tx, _rx_owner) = tokio::sync::broadcast::channel::<Event>(256);
            if let Some(session_configured) = maybe_session_configured.clone() {
                let initial_event = Event { id: "".to_string(), msg: EventMsg::SessionConfigured(session_configured) };
                let _ = conv_tx.send(initial_event);
            }
            // Spawn a single background pump task for this conversation
            let pump_tx = conv_tx.clone();
            let pump_conversation = conversation.clone();
            tokio::spawn(async move {
                loop {
                    let res = tokio::select! {
                        _ = tokio::signal::ctrl_c() => { break; }
                        res = pump_conversation.next_event() => res,
                    };
                    match res {
                        Ok(event) => {
                            let is_shutdown_complete = matches!(event.msg, EventMsg::ShutdownComplete);
                            let _ = pump_tx.send(event);
                            if is_shutdown_complete { break; }
                        }
                        Err(_) => break,
                    }
                }
            });
            CONV_REGISTRY.insert(conversation_uuid, conv_tx.clone()).await;
            conv_tx
        }
    };

    // Store the broadcast sender and conversation so SSE clients can subscribe later
    REGISTRY
        .insert(
            task_id.clone(),
            TaskContext { tx: tx.clone(), conversation: conversation.clone() },
        )
        .await;

    // Build input items: optional text + optional images
    let mut items: Vec<InputItem> = Vec::new();
    if !prompt.trim().is_empty() {
        items.push(InputItem::Text { text: prompt });
    }
    if let Some(imgs) = images {
        for image_url in imgs.into_iter().filter(|s| !s.trim().is_empty()) {
            items.push(InputItem::Image { image_url });
        }
    }
    if items.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "empty prompt and no images".to_string()));
    }

    // Kick off the task
    info!("Submitting user input with {} items to conversation {}", items.len(), conversation_uuid);
    let _ = conversation
        .submit(Op::UserInput { items })
        .await
        .map_err(|e| {
            error!("Failed to submit user input: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}"))
        })?;

    Ok(Json(StartResponse { task_id, conversation_id: conversation_uuid.to_string() }))
}

pub async fn cancel_task(Path(task_id): Path<String>) -> Result<impl IntoResponse, (StatusCode, String)> {
    let ctx = REGISTRY
        .get(&task_id)
        .await
        .ok_or_else(|| (StatusCode::NOT_FOUND, "unknown task_id".to_string()))?;
    ctx
        .conversation
        .submit(Op::Interrupt)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    Ok(Json(OkResponse { ok: true }))
}

pub async fn stream_events(Path(task_id): Path<String>) -> Result<impl IntoResponse, (StatusCode, String)> {
    let ctx = REGISTRY
        .get(&task_id)
        .await
        .ok_or_else(|| (StatusCode::NOT_FOUND, "unknown task_id".to_string()))?;
    let rx = ctx.tx.subscribe();
    
    // Convert broadcast receiver to a stream that maps events to SSE format
    let stream = BroadcastStream::new(rx)
        .map(|evt| {
            match evt {
                Ok(event) => {
                    // Log important events for debugging
                    match &event.msg {
                        EventMsg::ExecCommandBegin(ev) => {
                            debug!("Exec command begin: call_id={}, command={:?}, cwd={:?}", 
                                   ev.call_id, ev.command, ev.cwd);
                        }
                        EventMsg::ExecCommandEnd(ev) => {
                            if ev.exit_code != 0 {
                                warn!("Command failed with exit code {}: {}", ev.exit_code, ev.stderr);
                            } else {
                                debug!("Command succeeded: call_id={}, duration={:?}", ev.call_id, ev.duration);
                            }
                        }
                        EventMsg::PatchApplyEnd(ev) => {
                            info!("Patch apply ended: call_id={}, success={}, stdout={}, stderr={}", 
                                  ev.call_id, ev.success, ev.stdout, ev.stderr);
                        }
                        _ => {}
                    }
                    let json = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
                    Ok(SseEvent::default().data(json))
                }
                Err(_) => Err(std::io::Error::new(std::io::ErrorKind::Other, "broadcast error"))
            }
        });

    let sse = Sse::new(stream).keep_alive(KeepAlive::default());
    let mut headers = HeaderMap::new();
    headers.insert(
        "Cache-Control",
        HeaderValue::from_static("no-cache, no-transform"),
    );
    Ok((headers, sse))
}

pub async fn list_conversations() -> Result<impl IntoResponse, (StatusCode, String)> {
    match get_conversation_list() {
        Ok(response) => Ok(Json(response)),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e)),
    }
}

pub async fn get_conversation(
    Path(id): Path<String>, 
    Query(full_q): Query<HashMap<String, String>>
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let want_full = full_q.get("full").map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false);
    match get_conversation_detail(&id, want_full) {
        Ok(response) => Ok(Json(response)),
        Err(e) => Err((StatusCode::NOT_FOUND, e)),
    }
}

pub async fn delete_conversation(Path(id): Path<String>) -> Result<impl IntoResponse, (StatusCode, String)> {
    match delete_conversation_file(&id) {
        Ok(_) => Ok(StatusCode::NO_CONTENT),
        Err(e) => Err((StatusCode::NOT_FOUND, e)),
    }
}

pub async fn browse_directory(
    State(state): State<AppState>,
    Query(query): Query<BrowseQuery>
) -> Result<impl IntoResponse, (StatusCode, String)> {
    // Determine requested path: default to server working directory
    let requested = query
        .path
        .map(PathBuf::from)
        .unwrap_or_else(|| state.working_directory.clone());

    // Canonicalize both working directory and requested path to avoid Unicode normalization issues
    let wd_canon = state
        .working_directory
        .canonicalize()
        .unwrap_or_else(|_| state.working_directory.clone());

    // Validate existence and directory type early
    if !requested.exists() {
        return Err((StatusCode::NOT_FOUND, "Path does not exist".to_string()));
    }
    if !requested.is_dir() {
        return Err((StatusCode::BAD_REQUEST, "Path is not a directory".to_string()));
    }

    let path_canon = requested
        .canonicalize()
        .unwrap_or_else(|_| requested.clone());

    // Ensure the path is within the working directory (using canonical paths)
    if !path_canon.starts_with(&wd_canon) {
        return Err((StatusCode::FORBIDDEN, "Path is outside working directory".to_string()));
    }

    let mut items = Vec::new();

    match std::fs::read_dir(&path_canon) {
        Ok(entries) => {
            for entry in entries {
                if let Ok(entry) = entry {
                    let metadata = entry.metadata().ok();
                    let name = entry.file_name().to_string_lossy().to_string();
                    let full_path = entry.path().to_string_lossy().to_string();
                    let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                    let size = if is_dir { None } else { metadata.and_then(|m| Some(m.len())) };
                    
                    // Skip hidden files/directories (starting with .)
                    if !name.starts_with('.') {
                        items.push(FsItem {
                            name,
                            path: full_path,
                            is_dir,
                            size,
                        });
                    }
                }
            }
        }
        Err(e) => {
            return Err((StatusCode::FORBIDDEN, format!("Cannot read directory: {}", e)));
        }
    }
    
    // Sort directories first, then files, both alphabetically
    items.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    // Only expose a parent path if it remains within the working directory
    let parent_path = path_canon
        .parent()
        .and_then(|p| {
            let pc = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
            if pc.starts_with(&wd_canon) { Some(pc.to_string_lossy().to_string()) } else { None }
        });

    Ok(Json(BrowseResponse {
        current_path: path_canon.to_string_lossy().to_string(),
        parent_path,
        items,
    }))
}

pub async fn search_files(
    State(state): State<AppState>,
    Query(query): Query<SearchFilesQuery>
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let cwd_input: PathBuf = query
        .cwd
        .map(PathBuf::from)
        .unwrap_or_else(|| state.working_directory.clone());

    let wd_canon = state
        .working_directory
        .canonicalize()
        .unwrap_or_else(|_| state.working_directory.clone());

    if !cwd_input.exists() || !cwd_input.is_dir() {
        return Err((StatusCode::BAD_REQUEST, "cwd must be an existing directory".to_string()));
    }

    let cwd_canon = cwd_input
        .canonicalize()
        .unwrap_or_else(|_| cwd_input.clone());

    // Ensure the path is within the working directory (canonical paths)
    if !cwd_canon.starts_with(&wd_canon) {
        return Err((StatusCode::FORBIDDEN, "Path is outside working directory".to_string()));
    }

    let needle = query.q.unwrap_or_default().to_lowercase();
    let limit = query.limit.unwrap_or(200).min(1000);

    let mut items = Vec::new();
    let mut queue = VecDeque::new();
    queue.push_back(cwd_canon.clone());
    while let Some(dir) = queue.pop_front() {
        // Best-effort: skip hidden directories at the top-level traversal
        if let Some(name) = dir.file_name().and_then(|n| n.to_str()) {
            if name.starts_with('.') { continue; }
        }
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for ent_res in rd {
            let ent = match ent_res { Ok(e) => e, Err(_) => continue };
            let path = ent.path();
            let meta = match ent.metadata() { Ok(m) => m, Err(_) => continue };
            let is_dir = meta.is_dir();
            let name_str = ent.file_name().to_string_lossy().to_string();
            // Skip hidden
            if name_str.starts_with('.') { continue; }

            if is_dir {
                queue.push_back(path.clone());
            }

            // Filter by name or full path
            let full_lower = path.to_string_lossy().to_lowercase();
            if !needle.is_empty() && !(name_str.to_lowercase().contains(&needle) || full_lower.contains(&needle)) {
                continue;
            }

            let abs_path = path.to_string_lossy().to_string();
            let rel_path = path
                .strip_prefix(&cwd_canon)
                .unwrap_or(path.as_path())
                .to_string_lossy()
                .to_string();
            let size = if is_dir { None } else { Some(meta.len()) };

            items.push(SearchFileItem { name: name_str, rel_path, abs_path, is_dir, size });
            if items.len() >= limit { break; }
        }
        if items.len() >= limit { break; }
    }

    // Sort: prefer files over dirs; then by path
    items.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
        _ => a.rel_path.to_lowercase().cmp(&b.rel_path.to_lowercase()),
    });

    Ok(Json(SearchFilesResponse {
        cwd: cwd_canon.to_string_lossy().to_string(),
        query: needle,
        items,
    }))
}

pub async fn get_git_diff(
    State(state): State<AppState>,
    Query(query): Query<DiffQuery>
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let cwd = query.cwd.unwrap_or_else(|| state.working_directory.to_string_lossy().to_string());
    
    let cwd_path = PathBuf::from(&cwd);
    
    // Ensure the path is within the working directory
    if !cwd_path.starts_with(&state.working_directory) {
        return Err((StatusCode::FORBIDDEN, "Path is outside working directory".to_string()));
    }

    // Check if inside a git repo
    let inside_repo = match tokio::process::Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(&cwd)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
    {
        Ok(s) if s.success() => true,
        _ => false,
    };

    if !inside_repo {
        return Ok(Json(DiffResponse { is_git_repo: false, diff: String::new() }));
    }

    async fn run_git_capture_stdout(cwd: &str, args: &[&str]) -> std::io::Result<String> {
        let output = tokio::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .await?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        } else {
            Err(std::io::Error::other(format!(
                "git {:?} failed with status {}",
                args, output.status
            )))
        }
    }

    async fn run_git_capture_diff(cwd: &str, args: &[&str]) -> std::io::Result<String> {
        let output = tokio::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .await?;
        if output.status.success() || output.status.code() == Some(1) {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        } else {
            Err(std::io::Error::other(format!(
                "git {:?} failed with status {}",
                args, output.status
            )))
        }
    }

    let (tracked_diff_res, untracked_output_res) = tokio::join!(
        run_git_capture_diff(&cwd, &["diff"]),
        run_git_capture_stdout(&cwd, &["ls-files", "--others", "--exclude-standard"]),
    );
    let tracked_diff = tracked_diff_res.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let untracked_output = untracked_output_res.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut untracked_diff = String::new();
    let null_path = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let mut join_set: tokio::task::JoinSet<Result<String, (StatusCode, String)>> = tokio::task::JoinSet::new();
    for file in untracked_output
        .split('\n')
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let file = file.to_string();
        let cwd2 = cwd.clone();
        join_set.spawn(async move {
            run_git_capture_diff(&cwd2, &["diff", "--no-index", "--", null_path, &file])
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
        });
    }
    while let Some(res) = join_set.join_next().await {
        match res {
            Ok(Ok(diff)) => untracked_diff.push_str(&diff),
            Ok(Err(e)) => return Err(e),
            Err(_) => {}
        }
    }

    Ok(Json(DiffResponse { is_git_repo: true, diff: format!("{tracked_diff}{untracked_diff}") }))
}

pub async fn compact_task(Path(task_id): Path<String>) -> Result<impl IntoResponse, (StatusCode, String)> {
    let ctx = REGISTRY
        .get(&task_id)
        .await
        .ok_or_else(|| (StatusCode::NOT_FOUND, "unknown task_id".to_string()))?;

    ctx
        .conversation
        .submit(Op::Compact)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;

    Ok(Json(OkResponse { ok: true }))
}

#[derive(serde::Deserialize)]
pub struct SetWriteQuery {
    pub enabled: bool,
}

pub async fn get_write_enabled(State(state): State<AppState>) -> Result<impl IntoResponse, (StatusCode, String)> {
    let val = state.write_enabled.load(std::sync::atomic::Ordering::SeqCst);
    Ok(Json(OkResponse { ok: val }))
}

pub async fn set_write_enabled(State(state): State<AppState>, Json(body): Json<SetWriteQuery>) -> Result<impl IntoResponse, (StatusCode, String)> {
    state.write_enabled.store(body.enabled, std::sync::atomic::Ordering::SeqCst);
    Ok(Json(OkResponse { ok: body.enabled }))
}
