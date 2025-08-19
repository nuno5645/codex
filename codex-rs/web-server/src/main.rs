use std::sync::Arc;
use std::path::PathBuf;

use axum::extract::Path;
use axum::extract::Query;
use axum::http::HeaderMap;
use axum::http::HeaderValue;
use axum::http::Method;
use axum::http::StatusCode;
use axum::response::sse::Event as SseEvent;
use axum::response::sse::KeepAlive;
use axum::response::IntoResponse;
use axum::response::Sse;
use axum::routing::get;
use axum::routing::post;
use axum::extract::State;
use axum::Json;
use axum::Router;
use tower_http::services::ServeDir;
use codex_core::ConversationManager;
use codex_core::CodexConversation;
use codex_core::NewConversation;
use codex_core::config::Config;
use codex_core::config::ConfigOverrides;
use codex_core::protocol::Event;
use codex_core::protocol::EventMsg;
use codex_core::protocol::InputItem;
use codex_core::protocol::Op;
use codex_protocol::config_types::SandboxMode;
use serde::Deserialize;
use serde::Serialize;
use tokio_stream::wrappers::BroadcastStream;
use tower_http::cors::Any;
use tower_http::cors::CorsLayer;
use tracing::info;
use tracing::warn; // added
use uuid::Uuid;
use serde_json::Value as JsonValue;
use std::fs;
use std::time::UNIX_EPOCH;

#[derive(Clone)]
struct AppState {
    manager: Arc<ConversationManager>,
}

// Auto-detect the codex-linux-sandbox helper on Linux so sandboxed commands work.
#[cfg(target_os = "linux")]
fn detect_linux_sandbox_exe() -> Option<PathBuf> {
    // 1. Environment variable override
    if let Ok(val) = std::env::var("CODEX_LINUX_SANDBOX_EXE") {
        let p = PathBuf::from(&val);
        if p.is_file() { info!("using codex-linux-sandbox from CODEX_LINUX_SANDBOX_EXE: {}", p.display()); return Some(p); }
        warn!("CODEX_LINUX_SANDBOX_EXE set but not a file: {}", p.display());
    }
    // 2. Same directory as current executable (target/{debug,release})
    if let Ok(me) = std::env::current_exe() {
        if let Some(dir) = me.parent() {
            let candidate = dir.join("codex-linux-sandbox");
            if candidate.is_file() { info!("auto-detected codex-linux-sandbox beside executable: {}", candidate.display()); return Some(candidate); }
        }
    }
    // 3. Last resort: look in PATH by iterating PATH entries manually.
    if let Some(path_var) = std::env::var_os("PATH") {
        for entry in std::env::split_paths(&path_var) {
            let candidate = entry.join("codex-linux-sandbox");
            if candidate.is_file() { info!("found codex-linux-sandbox in PATH: {}", candidate.display()); return Some(candidate); }
        }
    }
    warn!("codex-linux-sandbox not found; sandboxed commands will fail unless DangerFullAccess is used");
    None
}

#[cfg(not(target_os = "linux"))]
fn detect_linux_sandbox_exe() -> Option<PathBuf> { None }

#[derive(Debug, Deserialize)]
struct StartQuery {
    prompt: String,
    #[serde(default)]
    full_auto: bool,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    images: Option<Vec<String>>, // data URLs or remote URLs
    #[serde(default)]
    conversation_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct StartResponse {
    task_id: String,
    conversation_id: String,
}

#[derive(Debug, Deserialize)]
struct BrowseQuery {
    path: Option<String>,
}

#[derive(Debug, Serialize)]
struct FsItem {
    name: String,
    path: String,
    is_dir: bool,
    size: Option<u64>,
}

#[derive(Debug, Serialize)]
struct BrowseResponse {
    current_path: String,
    parent_path: Option<String>,
    items: Vec<FsItem>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST])
        .allow_origin(Any)
        .allow_headers(Any);

    let state = AppState {
        manager: Arc::new(ConversationManager::default()),
    };

    // Serve static assets from this crate's public directory
    let public_dir: &'static str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/public");
    let app = Router::new()
        .route("/api/start", post(start_task))
        .route("/api/events/:task_id", get(stream_events))
        .route("/api/cancel/:task_id", post(cancel_task))
        .route("/api/browse", get(browse_directory))
        .route("/api/search_files", get(search_files))
        .route("/api/conversations", get(list_conversations))
        .route("/api/conversations/:id", get(get_conversation))
        .route("/api/conversations/:id", axum::routing::delete(delete_conversation))
        .route("/api/compact/:task_id", post(compact_task))
        .route("/api/diff", get(get_git_diff))
        .nest_service("/", ServeDir::new(public_dir))
        .with_state(state)
        .layer(cors);

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], 4321));
    info!("listening on http://{}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

async fn start_task(
    State(state): State<AppState>,
    Json(query): Json<StartQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let StartQuery { prompt, full_auto, cwd, images, conversation_id } = query;

    let sandbox_exe = detect_linux_sandbox_exe();

    // Build ConfigOverrides similar to exec run_main
    let overrides = ConfigOverrides {
        model: None,
        config_profile: None,
        approval_policy: Some(codex_core::protocol::AskForApproval::Never),
        sandbox_mode: if full_auto {
            Some(SandboxMode::WorkspaceWrite)
        } else {
            None
        },
        cwd: cwd.map(std::path::PathBuf::from),
        model_provider: None,
        codex_linux_sandbox_exe: sandbox_exe, // was None
        base_instructions: None,
        include_plan_tool: None,
        include_apply_patch_tool: None,
        disable_response_storage: Some(false),
        show_raw_agent_reasoning: None,
    };

    let config = Config::load_with_cli_overrides(Vec::new(), overrides)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

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
    let _ = conversation
        .submit(Op::UserInput { items })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;

    Ok(Json(StartResponse { task_id, conversation_id: conversation_uuid.to_string() }))
}

async fn cancel_task(Path(task_id): Path<String>) -> Result<impl IntoResponse, (StatusCode, String)> {
    let ctx = REGISTRY
        .get(&task_id)
        .await
        .ok_or_else(|| (StatusCode::NOT_FOUND, "unknown task_id".to_string()))?;
    ctx
        .conversation
        .submit(Op::Interrupt)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    #[derive(Serialize)]
    struct OkResp { ok: bool }
    Ok(Json(OkResp { ok: true }))
}

async fn stream_events(Path(task_id): Path<String>) -> Result<impl IntoResponse, (StatusCode, String)> {
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

// Simple in-memory registry for task event receivers
use tokio::sync::RwLock;
use tokio_stream::StreamExt as _;

#[derive(Clone)]
struct TaskContext {
    tx: tokio::sync::broadcast::Sender<Event>,
    conversation: Arc<CodexConversation>,
}

struct ReceiverRegistry {
    inner: RwLock<std::collections::HashMap<String, TaskContext>>,
}

impl ReceiverRegistry {
    fn new() -> Self {
        Self {
            inner: RwLock::new(std::collections::HashMap::new()),
        }
    }
    async fn insert(&self, key: String, ctx: TaskContext) {
        let mut map = self.inner.write().await;
        map.insert(key, ctx);
    }
    async fn get(&self, key: &str) -> Option<TaskContext> {
        let map = self.inner.read().await;
        map.get(key).cloned()
    }
}

static REGISTRY: once_cell::sync::Lazy<ReceiverRegistry> = once_cell::sync::Lazy::new(|| ReceiverRegistry::new());

struct ConvRegistry {
    inner: RwLock<std::collections::HashMap<Uuid, tokio::sync::broadcast::Sender<Event>>>,
}

impl ConvRegistry {
    fn new() -> Self {
        Self { inner: RwLock::new(std::collections::HashMap::new()) }
    }
    async fn insert(&self, key: Uuid, tx: tokio::sync::broadcast::Sender<Event>) {
        let mut map = self.inner.write().await;
        map.insert(key, tx);
    }
    async fn get(&self, key: &Uuid) -> Option<tokio::sync::broadcast::Sender<Event>> {
        let map = self.inner.read().await;
        map.get(key).cloned()
    }
}

static CONV_REGISTRY: once_cell::sync::Lazy<ConvRegistry> = once_cell::sync::Lazy::new(|| ConvRegistry::new());

// -------- Conversations persistence (server-backed using rollout files) --------

#[derive(Debug, Serialize)]
struct ConversationListItem {
    id: String,
    title: String,
    created_at: String,
    updated_at_ms: u128,
}

#[derive(Debug, Serialize)]
struct ConversationListResponse {
    conversations: Vec<ConversationListItem>,
}

#[derive(Debug, Serialize)]
struct ConversationMessageItem {
    role: String,
    text: String,
}

#[derive(Debug, Serialize)]
struct ConversationDetailResponse {
    id: String,
    created_at: String,
    messages: Vec<ConversationMessageItem>,
    // When full=1 is requested, include every raw JSON event (excluding the initial metadata line)
    raw_events: Option<Vec<serde_json::Value>>,
}

fn sessions_root_dir() -> std::io::Result<std::path::PathBuf> {
    let cfg = Config::load_with_cli_overrides(Vec::new(), ConfigOverrides::default())?;
    let mut p = cfg.codex_home.clone();
    p.push("sessions");
    Ok(p)
}

fn collect_rollout_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    if let Ok(rd) = fs::read_dir(dir) {
        for ent in rd.flatten() {
            let path = ent.path();
            if path.is_dir() {
                collect_rollout_files(&path, out);
                continue;
            }
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                    out.push(path);
                }
            }
        }
    }
}

fn file_modified_ms(path: &std::path::Path) -> u128 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn extract_uuid_from_filename(path: &std::path::Path) -> Option<String> {
    let name = path.file_name()?.to_str()?; // rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl
    let without_ext = name.strip_suffix(".jsonl")?;
    let last_dash = without_ext.rfind('-')?;
    Some(without_ext[last_dash + 1..].to_string())
}

fn read_first_user_title_and_created(path: &std::path::Path) -> (String, String) {
    // Defaults
    let mut created_at = String::new();
    let mut title = String::new();

    if let Ok(text) = fs::read_to_string(path) {
        let mut lines = text.lines();
        if let Some(meta_line) = lines.next() {
            if let Ok(v) = serde_json::from_str::<JsonValue>(meta_line) {
                if let Some(ts) = v.get("timestamp").and_then(|t| t.as_str()) {
                    created_at = ts.to_string();
                }
            }
        }
        for line in lines {
            if line.trim().is_empty() { continue; }
            let v: JsonValue = match serde_json::from_str(line) { Ok(v) => v, Err(_) => continue };
            if v.get("type").and_then(|t| t.as_str()) == Some("message") {
                let role = v.get("role").and_then(|r| r.as_str()).unwrap_or("");
                if role == "user" {
                    if let Some(arr) = v.get("content").and_then(|c| c.as_array()) {
                        let mut parts = Vec::new();
                        for c in arr {
                            if let Some("input_text") = c.get("type").and_then(|t| t.as_str()) {
                                if let Some(text) = c.get("text").and_then(|t| t.as_str()) {
                                    parts.push(text.trim());
                                }
                            }
                        }
                        let t = parts.join(" ");
                        if !t.is_empty() {
                            title = t.chars().take(60).collect();
                            break;
                        }
                    }
                }
            }
        }
    }
    (title, created_at)
}

async fn list_conversations() -> Result<impl IntoResponse, (StatusCode, String)> {
    let root = sessions_root_dir().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let mut files = Vec::new();
    collect_rollout_files(&root, &mut files);
    files.sort_by_key(|p| std::cmp::Reverse(file_modified_ms(p)));

    let mut list = Vec::new();
    for path in files.into_iter().take(500) {
        let id = match extract_uuid_from_filename(&path) { Some(id) => id, None => continue };
        let (title, created_at) = read_first_user_title_and_created(&path);
        list.push(ConversationListItem {
            id,
            title: if title.is_empty() { "Untitled".to_string() } else { title },
            created_at,
            updated_at_ms: file_modified_ms(&path),
        });
    }
    Ok(Json(ConversationListResponse { conversations: list }))
}

async fn get_conversation(Path(id): Path<String>, Query(full_q): Query<std::collections::HashMap<String, String>>) -> Result<impl IntoResponse, (StatusCode, String)> {
    let want_full = full_q.get("full").map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false);
    let root = sessions_root_dir().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let mut files = Vec::new();
    collect_rollout_files(&root, &mut files);
    let needle = id.to_lowercase();
    let path = files.into_iter().find(|p| extract_uuid_from_filename(p).map(|s| s.to_lowercase()) == Some(needle.clone()))
        .ok_or((StatusCode::NOT_FOUND, "conversation not found".to_string()))?;

    let text = fs::read_to_string(&path).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let mut lines = text.lines();
    let mut created_at = String::new();
    if let Some(meta_line) = lines.next() {
        if let Ok(v) = serde_json::from_str::<JsonValue>(meta_line) {
            if let Some(ts) = v.get("timestamp").and_then(|t| t.as_str()) { created_at = ts.to_string(); }
        }
    }
    let mut messages = Vec::new();
    let mut raw_events: Vec<JsonValue> = Vec::new();
    for line in lines {
        if line.trim().is_empty() { continue; }
        let v: JsonValue = match serde_json::from_str(line) { Ok(v) => v, Err(_) => continue };
        if want_full { raw_events.push(v.clone()); }
        if v.get("type").and_then(|t| t.as_str()) == Some("message") {
            let role = v.get("role").and_then(|r| r.as_str()).unwrap_or("").to_string();
            let mut buf = String::new();
            if let Some(arr) = v.get("content").and_then(|c| c.as_array()) {
                for c in arr {
                    match c.get("type").and_then(|t| t.as_str()) {
                        Some("input_text") | Some("output_text") => {
                            if let Some(text) = c.get("text").and_then(|t| t.as_str()) {
                                if !buf.is_empty() { buf.push_str("\n"); }
                                buf.push_str(text);
                            }
                        }
                        Some("input_image") => {
                            if let Some(url) = c.get("image_url").and_then(|t| t.as_str()) {
                                if !buf.is_empty() { buf.push_str("\n"); }
                                buf.push_str(&format!("[image] {url}"));
                            }
                        }
                        Some("tool_call") => {
                            // Include a concise representation of tool calls in message view.
                            if let Some(name) = c.get("name").and_then(|t| t.as_str()) {
                                if !buf.is_empty() { buf.push_str("\n"); }
                                buf.push_str(&format!("[tool_call] {name}"));
                            }
                        }
                        Some("tool_output") => {
                            if let Some(text) = c.get("text").and_then(|t| t.as_str()) {
                                if !buf.is_empty() { buf.push_str("\n"); }
                                buf.push_str(&format!("[tool_output]\n{text}"));
                            }
                        }
                        _ => {}
                    }
                }
            }
            messages.push(ConversationMessageItem { role, text: buf });
        }
    }

    Ok(Json(ConversationDetailResponse { id, created_at, messages, raw_events: if want_full { Some(raw_events) } else { None } }))
}

async fn delete_conversation(Path(id): Path<String>) -> Result<impl IntoResponse, (StatusCode, String)> {
    let root = sessions_root_dir().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let mut files = Vec::new();
    collect_rollout_files(&root, &mut files);
    let needle = id.to_lowercase();
    let path = files.into_iter().find(|p| extract_uuid_from_filename(p).map(|s| s.to_lowercase()) == Some(needle.clone()))
        .ok_or((StatusCode::NOT_FOUND, "conversation not found".to_string()))?;
    fs::remove_file(&path).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn browse_directory(Query(query): Query<BrowseQuery>) -> Result<impl IntoResponse, (StatusCode, String)> {
    let current_path = query.path.unwrap_or_else(|| std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .to_string_lossy()
        .to_string());
    
    let path_buf = PathBuf::from(&current_path);
    
    if !path_buf.exists() {
        return Err((StatusCode::NOT_FOUND, "Path does not exist".to_string()));
    }
    
    if !path_buf.is_dir() {
        return Err((StatusCode::BAD_REQUEST, "Path is not a directory".to_string()));
    }

    let mut items = Vec::new();
    
    match std::fs::read_dir(&path_buf) {
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
    
    let parent_path = path_buf.parent().map(|p| p.to_string_lossy().to_string());
    
    Ok(Json(BrowseResponse {
        current_path,
        parent_path,
        items,
    }))
}

#[derive(Debug, Deserialize)]
struct SearchFilesQuery {
    cwd: Option<String>,
    q: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
struct SearchFileItem {
    name: String,
    rel_path: String,
    abs_path: String,
    is_dir: bool,
    size: Option<u64>,
}

#[derive(Debug, Serialize)]
struct SearchFilesResponse {
    cwd: String,
    query: String,
    items: Vec<SearchFileItem>,
}

async fn search_files(Query(query): Query<SearchFilesQuery>) -> Result<impl IntoResponse, (StatusCode, String)> {
    let cwd = query
        .cwd
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).to_string_lossy().to_string());
    let cwd_path = PathBuf::from(&cwd);
    if !cwd_path.exists() || !cwd_path.is_dir() {
        return Err((StatusCode::BAD_REQUEST, "cwd must be an existing directory".to_string()));
    }

    let needle = query.q.unwrap_or_default().to_lowercase();
    let limit = query.limit.unwrap_or(200).min(1000);

    let mut items = Vec::new();
    use std::collections::VecDeque;
    let mut queue = VecDeque::new();
    queue.push_back(cwd_path.clone());
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
                .strip_prefix(&cwd_path)
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
        cwd,
        query: needle,
        items,
    }))
}

#[derive(Debug, Deserialize)]
struct DiffQuery {
    cwd: Option<String>,
}

#[derive(Debug, Serialize)]
struct DiffResponse {
    is_git_repo: bool,
    diff: String,
}

async fn get_git_diff(Query(query): Query<DiffQuery>) -> Result<impl IntoResponse, (StatusCode, String)> {
    let cwd = query.cwd.unwrap_or_else(|| std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .to_string_lossy()
        .to_string());

    // Check if inside a git repo
    use std::process::Stdio;
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

async fn compact_task(Path(task_id): Path<String>) -> Result<impl IntoResponse, (StatusCode, String)> {
    let ctx = REGISTRY
        .get(&task_id)
        .await
        .ok_or_else(|| (StatusCode::NOT_FOUND, "unknown task_id".to_string()))?;

    ctx
        .conversation
        .submit(Op::Compact)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;

    #[derive(Serialize)]
    struct OkResp { ok: bool }
    Ok(Json(OkResp { ok: true }))
}
