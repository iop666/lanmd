use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

/// API 错误类型：携带 HTTP 状态码与 JSON 响应体
#[derive(Debug)]
pub enum ApiError {
    Bad(String),
    NotFound,
    Conflict {
        payload: serde_json::Value,
    },
    Unauthorized,
    Forbidden,
    TooManyRequests,
    SseBusy,
    PortInUse(u16),
    Internal(String),
}

impl ApiError {
    pub fn bad(msg: impl Into<String>) -> Self {
        Self::Bad(msg.into())
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self::Internal(msg.into())
    }
    pub fn conflict(current_version: Option<&str>, content: &str) -> Self {
        Self::Conflict {
            payload: json!({
                "error": "conflict",
                "currentVersion": current_version,
                "content": content,
            }),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, payload) = match self {
            Self::Bad(m) => (StatusCode::BAD_REQUEST, json!({ "error": m })),
            Self::NotFound => (StatusCode::NOT_FOUND, json!({ "error": "not found" })),
            Self::Conflict { payload } => (StatusCode::CONFLICT, payload),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" })),
            Self::Forbidden => (StatusCode::FORBIDDEN, json!({ "error": "forbidden" })),
            Self::TooManyRequests => (
                StatusCode::TOO_MANY_REQUESTS,
                json!({ "error": "too many attempts" }),
            ),
            Self::SseBusy => (
                StatusCode::SERVICE_UNAVAILABLE,
                json!({ "error": "too many sse connections" }),
            ),
            Self::PortInUse(p) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": format!("端口 {p} 已被占用"), "port": p }),
            ),
            Self::Internal(m) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": "internal error", "detail": m }),
            ),
        };
        (status, axum::Json(payload)).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
