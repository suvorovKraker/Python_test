from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_admin_user, get_current_user
from app.geocode import search_streets
from app.models import Notification, ParkingZone, User, UserRole
from app.config import settings
from app.network import get_local_ip
from app.schemas import (
    AdminUserOut,
    AppSettingsOut,
    AppSettingsUpdate,
    GeocodeResultOut,
    NotificationOut,
    SessionOut,
    TokenResponse,
    TrackingUpdate,
    UserCreate,
    UserLogin,
    UserOut,
    ZoneCreate,
    ZoneOut,
)
from app.services import (
    create_access_token,
    get_active_session,
    get_app_settings,
    handle_tracking_update,
    hash_password,
    mark_session_left,
    mark_session_paid,
    process_session_notifications,
    reset_app_settings,
    verify_password,
)

router = APIRouter(prefix="/api")


@router.get("/network")
def network_info():
    ip = get_local_ip()
    return {
        "local_ip": ip,
        "port": 8000,
        "phone_url": f"http://{ip}:8000",
        "note": "Телефон и Mac должны быть в одной Wi‑Fi сети. VPN на Mac лучше отключить.",
    }


@router.get("/map-config")
def map_config():
    ip = get_local_ip()
    return {
        "yandex_api_key": settings.yandex_maps_api_key,
        "dgis_api_key": settings.dgis_api_key,
        "yandex_docs": "https://developer.tech.yandex.ru/",
        "dgis_docs": "https://platform.2gis.ru/",
        "phone_url": f"http://{ip}:8000",
    }


@router.get("/maps/yandex.js")
def yandex_maps_script(lang: str = "ru_RU", load: str | None = None):
    """Прокси Яндекс.Карт: скрипт грузится с вашего сервера, а не с api-maps.yandex.ru."""
    if not settings.yandex_maps_api_key:
        raise HTTPException(status_code=503, detail="YANDEX_MAPS_API_KEY не задан в .env")
    params: dict[str, str] = {"apikey": settings.yandex_maps_api_key, "lang": lang}
    if load:
        params["load"] = load
    try:
        with httpx.Client(timeout=30.0, follow_redirects=True) as client:
            response = client.get(
                "https://api-maps.yandex.ru/2.1/",
                params=params,
                headers={"User-Agent": "ParkingSPB/1.0"},
            )
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"Сервер не достучался до Яндекс.Карт: {exc}") from exc
    if response.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Яндекс.Карты ответили {response.status_code}. Проверьте ключ на developer.tech.yandex.ru",
        )
    return Response(
        content=response.text,
        media_type="application/javascript",
        headers={"Cache-Control": "public, max-age=1800"},
    )


@router.get("/settings", response_model=AppSettingsOut)
def public_settings(db: Session = Depends(get_db)):
    return get_app_settings(db)


@router.get("/admin/users", response_model=list[AdminUserOut])
def admin_list_users(
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
):
    return db.scalars(select(User).order_by(User.created_at.desc())).all()


@router.get("/admin/settings", response_model=AppSettingsOut)
def admin_get_settings(db: Session = Depends(get_db), _: User = Depends(get_admin_user)):
    return get_app_settings(db)


@router.put("/admin/settings", response_model=AppSettingsOut)
def admin_update_settings(
    payload: AppSettingsUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
):
    if payload.notification_interval_seconds >= payload.parking_timer_minutes * 60:
        raise HTTPException(
            status_code=400,
            detail="Интервал оповещений должен быть меньше времени парковки",
        )
    row = get_app_settings(db)
    row.parking_timer_minutes = payload.parking_timer_minutes
    row.notification_interval_seconds = payload.notification_interval_seconds
    row.stop_detection_seconds = payload.stop_detection_seconds
    row.movement_radius_meters = payload.movement_radius_meters
    db.commit()
    db.refresh(row)
    return row


@router.post("/admin/settings/reset", response_model=AppSettingsOut)
def admin_reset_settings(db: Session = Depends(get_db), _: User = Depends(get_admin_user)):
    return reset_app_settings(db)


@router.get("/geocode/search", response_model=list[GeocodeResultOut])
async def geocode_search(q: str, _: User = Depends(get_admin_user)):
    results = await search_streets(q)
    return [
        GeocodeResultOut(
            display_name=r.display_name,
            short_name=r.short_name,
            base_name=r.base_name,
            landmark=r.landmark,
            pick_id=r.pick_id,
            lat=r.lat,
            lng=r.lng,
            geojson=r.geojson,
            is_duplicate_group=r.is_duplicate_group,
        )
        for r in results
    ]


@router.post("/auth/register", response_model=TokenResponse)
def register(payload: UserCreate, db: Session = Depends(get_db)):
    if not payload.accept_policy:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Необходимо согласие с политикой конфиденциальности",
        )
    existing = db.scalar(select(User).where(User.email == payload.email))
    if existing:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email уже зарегистрирован")
    user = User(
        email=payload.email,
        first_name=payload.first_name.strip(),
        last_name=payload.last_name.strip(),
        password_hash=hash_password(payload.password),
        password_plain=payload.password,
        role=UserRole.USER,
        policy_accepted_at=datetime.now(timezone.utc),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return TokenResponse(access_token=create_access_token(user.id, user.role), role=user.role.value)


@router.post("/auth/login", response_model=TokenResponse)
def login(payload: UserLogin, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == payload.email))
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Неверный email или пароль")
    return TokenResponse(access_token=create_access_token(user.id, user.role), role=user.role.value)


@router.get("/auth/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return user


@router.delete("/admin/users/{user_id}")
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    admin: User = Depends(get_admin_user),
):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    if user.role == UserRole.ADMIN:
        raise HTTPException(status_code=400, detail="Нельзя удалить администратора")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="Нельзя удалить свой аккаунт")
    for notification in list(user.notifications):
        db.delete(notification)
    for session in list(user.sessions):
        db.delete(session)
    db.delete(user)
    db.commit()
    return {"ok": True}


@router.get("/zones", response_model=list[ZoneOut])
def list_zones(db: Session = Depends(get_db)):
    return db.scalars(select(ParkingZone).where(ParkingZone.is_active.is_(True))).all()


@router.get("/admin/zones", response_model=list[ZoneOut])
def admin_list_zones(db: Session = Depends(get_db), _: User = Depends(get_admin_user)):
    return db.scalars(select(ParkingZone).order_by(ParkingZone.name)).all()


@router.patch("/admin/zones/{zone_id}/toggle", response_model=ZoneOut)
def toggle_zone(zone_id: int, db: Session = Depends(get_db), _: User = Depends(get_admin_user)):
    zone = db.get(ParkingZone, zone_id)
    if not zone:
        raise HTTPException(status_code=404, detail="Зона не найдена")
    zone.is_active = not zone.is_active
    db.commit()
    db.refresh(zone)
    return zone


@router.post("/admin/zones", response_model=ZoneOut)
def create_zone(
    payload: ZoneCreate,
    db: Session = Depends(get_db),
    admin: User = Depends(get_admin_user),
):
    zone = ParkingZone(
        name=payload.name,
        description=payload.description,
        polygon_geojson=payload.polygon_geojson,
        created_by_id=admin.id,
    )
    db.add(zone)
    db.commit()
    db.refresh(zone)
    return zone


@router.delete("/admin/zones/{zone_id}")
def delete_zone(
    zone_id: int,
    db: Session = Depends(get_db),
    admin: User = Depends(get_admin_user),
):
    zone = db.get(ParkingZone, zone_id)
    if not zone:
        raise HTTPException(status_code=404, detail="Зона не найдена")
    zone.is_active = False
    db.commit()
    return {"ok": True}


@router.delete("/admin/zones/{zone_id}/permanent")
def permanent_delete_zone(
    zone_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
):
    zone = db.get(ParkingZone, zone_id)
    if not zone:
        raise HTTPException(status_code=404, detail="Зона не найдена")
    if zone.is_active:
        raise HTTPException(status_code=400, detail="Сначала отключите зону")
    db.delete(zone)
    db.commit()
    return {"ok": True}


@router.post("/tracking/update")
def tracking_update(
    payload: TrackingUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return handle_tracking_update(db, user, payload.lat, payload.lng, payload.is_stationary)


@router.get("/tracking/session", response_model=SessionOut | None)
def active_session(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    session = get_active_session(db, user.id)
    if not session:
        return None
    return SessionOut(
        id=session.id,
        zone_id=session.zone_id,
        zone_name=session.zone.name if session.zone else "",
        status=session.status.value,
        started_at=session.started_at,
        expires_at=session.expires_at,
    )


@router.post("/tracking/left")
def tracking_left(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    session = mark_session_left(db, user.id)
    if not session:
        raise HTTPException(status_code=404, detail="Нет активной сессии")
    db.commit()
    return {"ok": True}


@router.post("/tracking/paid")
def tracking_paid(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    session = mark_session_paid(db, user.id)
    if not session:
        raise HTTPException(status_code=404, detail="Нет активной парковочной сессии")
    db.commit()
    return {"ok": True, "session_id": session.id, "status": session.status.value}


@router.get("/notifications", response_model=list[NotificationOut])
def list_notifications(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    active = get_active_session(db, user.id)
    if active:
        app_settings = get_app_settings(db)
        process_session_notifications(db, active, app_settings)
        db.commit()

    notifications = db.scalars(
        select(Notification)
        .where(Notification.user_id == user.id, Notification.is_read.is_(False))
        .order_by(Notification.created_at.desc())
    ).all()
    return notifications


@router.post("/notifications/{notification_id}/read")
def mark_read(
    notification_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    notification = db.get(Notification, notification_id)
    if not notification or notification.user_id != user.id:
        raise HTTPException(status_code=404, detail="Уведомление не найдено")
    notification.is_read = True
    db.commit()
    return {"ok": True}
