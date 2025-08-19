use crate::models::{ConversationListItem, ConversationListResponse, ConversationDetailResponse, ConversationMessageItem};
use codex_core::config::{Config, ConfigOverrides};
use serde_json::Value as JsonValue;
use std::fs;
use std::time::UNIX_EPOCH;

pub fn sessions_root_dir() -> std::io::Result<std::path::PathBuf> {
    let cfg = Config::load_with_cli_overrides(Vec::new(), ConfigOverrides::default())?;
    let mut p = cfg.codex_home.clone();
    p.push("sessions");
    Ok(p)
}

pub fn collect_rollout_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
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

pub fn file_modified_ms(path: &std::path::Path) -> u128 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

pub fn extract_uuid_from_filename(path: &std::path::Path) -> Option<String> {
    let name = path.file_name()?.to_str()?; // rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl
    let without_ext = name.strip_suffix(".jsonl")?;
    let last_dash = without_ext.rfind('-')?;
    Some(without_ext[last_dash + 1..].to_string())
}

pub fn read_first_user_title_and_created(path: &std::path::Path) -> (String, String) {
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

pub fn get_conversation_list() -> Result<ConversationListResponse, String> {
    let root = sessions_root_dir().map_err(|e| e.to_string())?;
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
    Ok(ConversationListResponse { conversations: list })
}

pub fn get_conversation_detail(id: &str, want_full: bool) -> Result<ConversationDetailResponse, String> {
    let root = sessions_root_dir().map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    collect_rollout_files(&root, &mut files);
    let needle = id.to_lowercase();
    let path = files.into_iter().find(|p| extract_uuid_from_filename(p).map(|s| s.to_lowercase()) == Some(needle.clone()))
        .ok_or("conversation not found".to_string())?;

    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut lines = text.lines();
    let mut created_at = String::new();
    if let Some(meta_line) = lines.next() {
        if let Ok(v) = serde_json::from_str::<JsonValue>(meta_line) {
            if let Some(ts) = v.get("timestamp").and_then(|t| t.as_str()) { 
                created_at = ts.to_string(); 
            }
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

    Ok(ConversationDetailResponse { 
        id: id.to_string(), 
        created_at, 
        messages, 
        raw_events: if want_full { Some(raw_events) } else { None } 
    })
}

pub fn delete_conversation_file(id: &str) -> Result<(), String> {
    let root = sessions_root_dir().map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    collect_rollout_files(&root, &mut files);
    let needle = id.to_lowercase();
    let path = files.into_iter().find(|p| extract_uuid_from_filename(p).map(|s| s.to_lowercase()) == Some(needle.clone()))
        .ok_or("conversation not found".to_string())?;
    fs::remove_file(&path).map_err(|e| e.to_string())?;
    Ok(())
}
