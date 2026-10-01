use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use include_dir::{include_dir, Dir};

/// 编译期内嵌前端产物（web/dist）；重新构建前端后需重新编译
static WEB_DIST: Dir = include_dir!("$CARGO_MANIFEST_DIR/../../web/dist");

pub async fn serve(req: Request<Body>) -> Response {
    let path = req.uri().path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    if let Some(file) = WEB_DIST.get_file(path) {
        let mime = mime_of(path);
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, mime)],
            file.contents().to_vec(),
        )
            .into_response();
    }
    // SPA fallback：非 API 的未知路径返回 index.html
    if let Some(index) = WEB_DIST.get_file("index.html") {
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            index.contents().to_vec(),
        )
            .into_response();
    }
    (StatusCode::NOT_FOUND, axum::Json(serde_json::json!({"error": "not found"}))).into_response()
}

pub fn mime_of(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "map" => "application/json",
        _ => "application/octet-stream",
    }
}
