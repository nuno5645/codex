use crate::handlers::*;
use crate::models::AppState;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use axum::http::Method;
use axum::routing::{get, post};
use axum::Router;
use codex_core::ConversationManager;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;

pub fn create_app_state(working_directory: PathBuf) -> AppState {
    AppState {
        manager: Arc::new(ConversationManager::default()),
        working_directory,
    write_enabled: Arc::new(AtomicBool::new(true)),
    }
}

pub fn create_router() -> Router<AppState> {
    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST])
        .allow_origin(Any)
        .allow_headers(Any);

    // Serve static assets from this crate's public directory
    let public_dir: &'static str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/public");
    
    Router::new()
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
    .route("/api/write_enabled", get(get_write_enabled))
    .route("/api/write_enabled", post(set_write_enabled))
        .nest_service("/", ServeDir::new(public_dir))
        .layer(cors)
}
