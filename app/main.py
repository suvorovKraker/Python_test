from datetime import datetime, timezone

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


def _migrate_db() -> None:
    import sqlite3

    db_path = Path("data/parking_spb.db")
    if not db_path.exists():
        return
    conn = sqlite3.connect(db_path)

    settings_cols = {row[1] for row in conn.execute("PRAGMA table_info(app_settings)").fetchall()}
    if "notification_interval_seconds" not in settings_cols:
        conn.execute("ALTER TABLE app_settings ADD COLUMN notification_interval_seconds INTEGER DEFAULT 300")
        if "notification_interval_minutes" in settings_cols:
            conn.execute(
                "UPDATE app_settings SET notification_interval_seconds = notification_interval_minutes * 60 "
                "WHERE notification_interval_seconds IS NULL"
            )

    user_cols = {row[1] for row in conn.execute("PRAGMA table_info(users)").fetchall()}
    if "first_name" not in user_cols:
        conn.execute("ALTER TABLE users ADD COLUMN first_name VARCHAR(100) DEFAULT ''")
    if "last_name" not in user_cols:
        conn.execute("ALTER TABLE users ADD COLUMN last_name VARCHAR(100) DEFAULT ''")
    if "password_plain" not in user_cols:
        conn.execute("ALTER TABLE users ADD COLUMN password_plain VARCHAR(255)")
    if "policy_accepted_at" not in user_cols:
        conn.execute("ALTER TABLE users ADD COLUMN policy_accepted_at DATETIME")

    conn.commit()
    conn.close()


def init_db() -> None:
    data_dir = Path("data")
    data_dir.mkdir(exist_ok=True)
    Base.metadata.create_all(bind=engine)
    _migrate_db()
    db = SessionLocal()
    try:
        admin = db.scalar(select(User).where(User.email == settings.admin_email))
        if not admin:
            db.add(
                User(
                    email=settings.admin_email,
                    first_name="Админ",
                    last_name="Parking SPB",
                    password_hash=hash_password(settings.admin_password),
                    password_plain=settings.admin_password,
                    role=UserRole.ADMIN,
                    policy_accepted_at=datetime.now(timezone.utc),
                )
            )
            db.commit()
        elif not admin.password_plain:
            admin.password_plain = settings.admin_password
            if not admin.first_name:
                admin.first_name = "Админ"
            if not admin.last_name:
                admin.last_name = "Parking SPB"
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


@app.get("/privacy", response_class=HTMLResponse)
def privacy_page(request: Request):
    policy_path = BASE_DIR / "policies" / "privacy_policy.md"
    content = policy_path.read_text(encoding="utf-8") if policy_path.exists() else "Политика не найдена."
    return templates.TemplateResponse(request, "privacy.html", {"content": content})


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
