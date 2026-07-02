from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import select

from app.api import router as api_router
from app.config import settings
from app.database import Base, SessionLocal, engine
from app.models import User, UserRole
from app.network import get_local_ip
from app.services import get_app_settings, hash_password

BASE_DIR = Path(__file__).resolve().parent


def init_db() -> None:
    data_dir = Path("data")
    data_dir.mkdir(exist_ok=True)
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        admin = db.scalar(select(User).where(User.email == settings.admin_email))
        if not admin:
            db.add(
                User(
                    email=settings.admin_email,
                    password_hash=hash_password(settings.admin_password),
                    role=UserRole.ADMIN,
                )
            )
            db.commit()
        get_app_settings(db)
    finally:
        db.close()


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    ip = get_local_ip()
    print(f"\n  Parking SPB запущен:")
    print(f"  На Mac:     http://127.0.0.1:8000")
    print(f"  На телефоне: http://{ip}:8000  (та же Wi‑Fi сеть)\n")
    yield


app = FastAPI(title="Parking SPB", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")
app.include_router(api_router)


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse(
        request,
        "index.html",
        {
            "city_center_lat": settings.city_center_lat,
            "city_center_lng": settings.city_center_lng,
            "city_zoom": settings.city_default_zoom,
        },
    )


@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    return templates.TemplateResponse(request, "login.html")


@app.get("/register", response_class=HTMLResponse)
def register_page(request: Request):
    return templates.TemplateResponse(request, "register.html")


@app.get("/admin", response_class=HTMLResponse)
def admin_page(request: Request):
    return templates.TemplateResponse(
        request,
        "admin.html",
        {
            "city_center_lat": settings.city_center_lat,
            "city_center_lng": settings.city_center_lng,
            "city_zoom": settings.city_default_zoom,
        },
    )
