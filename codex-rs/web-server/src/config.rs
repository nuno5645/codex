use std::path::PathBuf;
use tracing::{info, warn};

// Auto-detect the codex-linux-sandbox helper on Linux so sandboxed commands work.
#[cfg(target_os = "linux")]
pub fn detect_linux_sandbox_exe() -> Option<PathBuf> {
    // 1. Environment variable override
    if let Ok(val) = std::env::var("CODEX_LINUX_SANDBOX_EXE") {
        let p = PathBuf::from(&val);
        if p.is_file() { 
            info!("using codex-linux-sandbox from CODEX_LINUX_SANDBOX_EXE: {}", p.display()); 
            return Some(p); 
        }
        warn!("CODEX_LINUX_SANDBOX_EXE set but not a file: {}", p.display());
    }
    // 2. Same directory as current executable (target/{debug,release})
    if let Ok(me) = std::env::current_exe() {
        if let Some(dir) = me.parent() {
            let candidate = dir.join("codex-linux-sandbox");
            if candidate.is_file() { 
                info!("auto-detected codex-linux-sandbox beside executable: {}", candidate.display()); 
                return Some(candidate); 
            }
        }
    }
    // 3. Last resort: look in PATH by iterating PATH entries manually.
    if let Some(path_var) = std::env::var_os("PATH") {
        for entry in std::env::split_paths(&path_var) {
            let candidate = entry.join("codex-linux-sandbox");
            if candidate.is_file() { 
                info!("found codex-linux-sandbox in PATH: {}", candidate.display()); 
                return Some(candidate); 
            }
        }
    }
    warn!("codex-linux-sandbox not found; sandboxed commands will fail unless DangerFullAccess is used");
    None
}

#[cfg(not(target_os = "linux"))]
pub fn detect_linux_sandbox_exe() -> Option<PathBuf> { 
    None 
}
