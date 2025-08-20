mod config;
mod conversations;
mod handlers;
mod models;
mod registries;
mod server;

use std::path::PathBuf;
use tracing::info;
use clap::Parser;
use codex_arg0::arg0_dispatch_or_else;

#[derive(Parser)]
#[command(name = "codex-web-server")]
#[command(about = "Codex AI Web Server")]
struct Args {
    /// Working directory to serve
    #[arg(short, long, value_name = "DIR")]
    working_directory: Option<PathBuf>,
}

async fn run(_codex_linux_sandbox_exe: Option<PathBuf>) -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("debug")),
        )
        .init();

    let args = Args::parse();
    
    // Use provided working directory or default to current directory
    let working_directory = args.working_directory
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    info!("Working directory: {}", working_directory.display());

    let state = server::create_app_state(working_directory);
    let app = server::create_router().with_state(state);

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], 4321));
    info!("listening on http://{}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

fn main() -> anyhow::Result<()> {
    arg0_dispatch_or_else(|codex_linux_sandbox_exe| async move { run(codex_linux_sandbox_exe).await })
}

