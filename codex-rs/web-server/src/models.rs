use serde::{Deserialize, Serialize};
use std::sync::Arc;
use codex_core::{CodexConversation, protocol::Event};

#[derive(Clone)]
pub struct AppState {
    pub manager: Arc<codex_core::ConversationManager>,
}

#[derive(Clone)]
pub struct TaskContext {
    pub tx: tokio::sync::broadcast::Sender<Event>,
    pub conversation: Arc<CodexConversation>,
}

#[derive(Debug, Deserialize)]
pub struct StartQuery {
    pub prompt: String,
    #[serde(default)]
    pub full_auto: bool,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub images: Option<Vec<String>>, // data URLs or remote URLs
    #[serde(default)]
    pub conversation_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct StartResponse {
    pub task_id: String,
    pub conversation_id: String,
}

#[derive(Debug, Deserialize)]
pub struct BrowseQuery {
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FsItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct BrowseResponse {
    pub current_path: String,
    pub parent_path: Option<String>,
    pub items: Vec<FsItem>,
}

#[derive(Debug, Serialize)]
pub struct ConversationListItem {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at_ms: u128,
}

#[derive(Debug, Serialize)]
pub struct ConversationListResponse {
    pub conversations: Vec<ConversationListItem>,
}

#[derive(Debug, Serialize)]
pub struct ConversationMessageItem {
    pub role: String,
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct ConversationDetailResponse {
    pub id: String,
    pub created_at: String,
    pub messages: Vec<ConversationMessageItem>,
    // When full=1 is requested, include every raw JSON event (excluding the initial metadata line)
    pub raw_events: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Deserialize)]
pub struct SearchFilesQuery {
    pub cwd: Option<String>,
    pub q: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct SearchFileItem {
    pub name: String,
    pub rel_path: String,
    pub abs_path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct SearchFilesResponse {
    pub cwd: String,
    pub query: String,
    pub items: Vec<SearchFileItem>,
}

#[derive(Debug, Deserialize)]
pub struct DiffQuery {
    pub cwd: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DiffResponse {
    pub is_git_repo: bool,
    pub diff: String,
}

#[derive(Serialize)]
pub struct OkResponse {
    pub ok: bool,
}
