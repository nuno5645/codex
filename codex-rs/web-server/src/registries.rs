use crate::models::TaskContext;
use codex_core::protocol::Event;
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
