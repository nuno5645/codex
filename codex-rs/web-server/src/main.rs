mod config;
mod conversations;
mod handlers;
mod models;
mod registries;
mod server;

use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let state = server::create_app_state();
    let app = server::create_router().with_state(state);

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], 4321));
    info!("listening on http://{}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

