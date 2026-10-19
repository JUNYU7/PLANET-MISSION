"""FastAPI 应用工厂。

开发期前端由 Vite dev server 提供，接口开启 CORS；

生产期前端产物由本服务直接托管，同源无需 CORS。
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .api import globe, missions, regions, gazebo_export
from .settings import FRONTEND_DIST, LAYER_DEFS, REGIONS, SEMANTIC_CLASSES, TI_COLORS

__all__ = ["create_app"]


def create_app() -> FastAPI:
    """构建 FastAPI 应用并挂载路由与静态资源。"""
    app = FastAPI(
        title="PlanetMission",
        description="火星巡视器仿真环境生成与可视化平台",
        version="0.4.1",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://127.0.0.1:8000", "http://localhost:8000",
            "http://127.0.0.1:5173", "http://localhost:5173",
        ],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(regions.router)
    app.include_router(globe.router)
    app.include_router(missions.router)
    app.include_router(gazebo_export.router)

    @app.get("/api/health")
    def health():
        return {"status": "ok", "regions_configured": len(REGIONS)}

    @app.get("/api/config")
    def config():
        """图层定义与配色，供前端构建图层面板时保持配色一致。"""
        return {
            "layers": LAYER_DEFS,
            "traversability_colors": TI_COLORS,
            "semantic_classes": SEMANTIC_CLASSES,
        }

    if FRONTEND_DIST.exists():
        app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True),
                  name="frontend")
    else:
        @app.get("/")
        def missing_frontend():
            return JSONResponse(
                status_code=503,
                content={
                    "detail": "前端产物未构建。请在 frontend 目录执行 "
                              "npm install && npm run build 后重启服务。",
                    "expected_path": str(FRONTEND_DIST),
                },
            )

    return app


# 模块级实例，供 `uvicorn app.main:app` 直接加载。
# 此处会触发前端产物存在性检查，因此构建前端后需重启服务才会改为托管静态资源。
app = create_app()

