use crate::models::TaskContext;
use codex_core::protocol::{Event, SessionConfiguredEvent, TokenUsage};
use tokio::sync::RwLock;
use uuid::Uuid;

pub struct ReceiverRegistry {
    inner: RwLock<std::collections::HashMap<String, TaskContext>>,
}

impl ReceiverRegistry {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(std::collections::HashMap::new()),
        }
    }
    
    pub async fn insert(&self, key: String, ctx: TaskContext) {
        let mut map = self.inner.write().await;
        map.insert(key, ctx);
    }
    
    pub async fn get(&self, key: &str) -> Option<TaskContext> {
        let map = self.inner.read().await;
        map.get(key).cloned()
    }
}

pub struct ConvRegistry {
    inner: RwLock<std::collections::HashMap<Uuid, tokio::sync::broadcast::Sender<Event>>>,
}

impl ConvRegistry {
    pub fn new() -> Self {
        Self { 
            inner: RwLock::new(std::collections::HashMap::new()) 
        }
    }
    
    pub async fn insert(&self, key: Uuid, tx: tokio::sync::broadcast::Sender<Event>) {
        let mut map = self.inner.write().await;
        map.insert(key, tx);
    }
    
    pub async fn get(&self, key: &Uuid) -> Option<tokio::sync::broadcast::Sender<Event>> {
        let map = self.inner.read().await;
        map.get(key).cloned()
    }
}

pub static REGISTRY: once_cell::sync::Lazy<ReceiverRegistry> = 
    once_cell::sync::Lazy::new(|| ReceiverRegistry::new());

pub static CONV_REGISTRY: once_cell::sync::Lazy<ConvRegistry> = 
    once_cell::sync::Lazy::new(|| ConvRegistry::new());

// ----------------------------------------------------------------------------
// Conversation status tracking (model, session_id, token usage)

#[derive(Clone, Debug, Default)]
pub struct ConversationStatus {
    pub model: Option<String>,
    pub session_id: Option<Uuid>,
    pub token_usage: Option<TokenUsage>,
    pub model_context_window: Option<u64>,
}

pub struct StatusRegistry {
    inner: RwLock<std::collections::HashMap<Uuid, ConversationStatus>>,
}

impl StatusRegistry {
    pub fn new() -> Self {
        Self { inner: RwLock::new(std::collections::HashMap::new()) }
    }

    pub async fn upsert_session(&self, key: Uuid, ev: &SessionConfiguredEvent) {
        let mut map = self.inner.write().await;
        let entry = map.entry(key).or_default();
        entry.model = Some(ev.model.clone());
        entry.session_id = Some(ev.session_id);
    }

    pub async fn update_tokens(&self, key: Uuid, usage: &TokenUsage) {
        let mut map = self.inner.write().await;
        let entry = map.entry(key).or_default();
        entry.token_usage = Some(usage.clone());
    }

    pub async fn set_model_context_window(&self, key: Uuid, window: Option<u64>) {
        let mut map = self.inner.write().await;
        let entry = map.entry(key).or_default();
        entry.model_context_window = window;
    }

    pub async fn get(&self, key: &Uuid) -> Option<ConversationStatus> {
        let map = self.inner.read().await;
        map.get(key).cloned()
    }
}

pub static STATUS_REGISTRY: once_cell::sync::Lazy<StatusRegistry> =
    once_cell::sync::Lazy::new(|| StatusRegistry::new());
