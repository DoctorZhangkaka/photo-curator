"""FastAPI 应用：本地单用户相册精选助手。"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.staticfiles import StaticFiles

from . import __version__
from .api import albums, health, media, operations, photos
from .config import Settings
from .context import bootstrap, build_context
from .errors import ApiError, ErrorCode
from .security import LocalSecurityMiddleware


def _error_json(code: str, message: str, details: dict | None = None, status_code: int = 400) -> JSONResponse:
    return JSONResponse(
        {"error": {"code": code, "message": message, "details": jsonable_encoder(details or {})}},
        status_code=status_code,
        headers={"Cache-Control": "no-store"},
    )


def create_app(settings: Settings | None = None) -> FastAPI:
    active_settings = settings or Settings.load()

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        context = build_context(active_settings)
        context.events.bind_loop(asyncio.get_running_loop())
        app.state.context = context
        bootstrap(context, background_scan=active_settings.startup_scan)
        try:
            yield
        finally:
            context.shutdown()

    app = FastAPI(
        title="相册精选助手",
        version=__version__,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )

    # 安全中间件先于 lifespan 构造，因此使用同一个配置对象（显式传入优先）。
    app.add_middleware(LocalSecurityMiddleware, settings=active_settings)

    app.include_router(health.router)
    app.include_router(albums.router)
    app.include_router(photos.router)
    app.include_router(media.router)
    app.include_router(operations.router)

    @app.exception_handler(ApiError)
    async def handle_api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return _error_json(exc.code, exc.message, exc.details, exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        return _error_json(
            ErrorCode.INVALID_REQUEST,
            "请求参数无效，请检查后重试。",
            {"errors": jsonable_encoder(exc.errors())},
            status_code=400,
        )

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_error(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = ErrorCode.NOT_FOUND if exc.status_code == 404 else "HTTP_ERROR"
        message = "请求的资源不存在。" if exc.status_code == 404 else str(exc.detail)
        return _error_json(code, message, status_code=exc.status_code)

    web_dist = active_settings.web_dist
    serve_static = active_settings.serve_static
    index_file = (web_dist / "index.html") if web_dist else None
    if serve_static and web_dist is not None and index_file is not None and index_file.is_file():
        assets_dir = web_dist / "assets"
        if assets_dir.is_dir():
            app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False, response_model=None)
        async def spa_fallback(full_path: str) -> Response:
            if full_path.startswith("api/") or full_path == "api":
                return _error_json(ErrorCode.NOT_FOUND, "接口不存在。", status_code=404)
            parts = Path(full_path).parts
            if any(part in {"..", "."} for part in parts):
                return _error_json(ErrorCode.PATH_OUTSIDE_ROOT, "路径非法。", status_code=403)
            candidate = (web_dist / full_path).resolve() if full_path else index_file
            try:
                if full_path:
                    candidate.relative_to(web_dist.resolve())
            except ValueError:
                return _error_json(ErrorCode.PATH_OUTSIDE_ROOT, "路径非法。", status_code=403)
            if full_path and candidate.is_file():
                return FileResponse(candidate)
            return FileResponse(
                index_file,
                headers={
                    "Cache-Control": "no-store",
                    "Content-Security-Policy": (
                        "default-src 'self'; img-src 'self' data: blob:; "
                        "style-src 'self' 'unsafe-inline'; script-src 'self'; "
                        "connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'"
                    ),
                },
            )
    else:

        @app.get("/", include_in_schema=False)
        async def root() -> JSONResponse:
            return JSONResponse(
                {
                    "app": "相册精选助手",
                    "version": __version__,
                    "message": "前端构建产物不存在，请先运行 npm run build，或使用 npm run dev 启动开发服务器。",
                    "health": "/api/health",
                }
            )

    return app


app = create_app()
