import json
from datetime import datetime, timedelta, timezone

import bcrypt
from jose import JWTError, jwt
from shapely.geometry import Point, shape
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import (
    AppSettings,
    Notification,
    NotificationType,
    ParkingSession,
    ParkingZone,
    SessionStatus,
    User,
    UserRole,
)

ALGORITHM = "HS256"


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, password_hash: str) -> bool:
    return bcrypt.checkpw(password.encode(), password_hash.encode())


def create_access_token(user_id: int, role: UserRole) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=7)
    payload = {"sub": str(user_id), "role": role.value, "exp": expire}
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def decode_access_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
    except JWTError:
        return None


def get_app_settings(db: Session) -> AppSettings:
    row = db.get(AppSettings, 1)
    if not row:
        row = AppSettings(
            id=1,
            parking_timer_minutes=settings.parking_timer_minutes,
            notification_interval_minutes=settings.notification_interval_minutes,
            stop_detection_seconds=settings.stop_detection_seconds,
            movement_radius_meters=settings.movement_radius_meters,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def point_in_zone(lat: float, lng: float, zone: ParkingZone) -> bool:
    polygon = shape(json.loads(zone.polygon_geojson))
    return polygon.contains(Point(lng, lat))


def find_zone_for_point(db: Session, lat: float, lng: float) -> ParkingZone | None:
    zones = db.scalars(select(ParkingZone).where(ParkingZone.is_active.is_(True))).all()
    for zone in zones:
        if point_in_zone(lat, lng, zone):
            return zone
    return None


def get_active_session(db: Session, user_id: int) -> ParkingSession | None:
    return db.scalar(
        select(ParkingSession).where(
            ParkingSession.user_id == user_id,
            ParkingSession.status == SessionStatus.ACTIVE,
        )
    )


def _notification_exists(db: Session, session_id: int, ntype: NotificationType) -> bool:
    existing = db.scalar(
        select(Notification).where(
            Notification.session_id == session_id,
            Notification.type == ntype,
        )
    )
    return existing is not None


def _create_notification(
    db: Session,
    user_id: int,
    session_id: int,
    ntype: NotificationType,
    title: str,
    message: str,
) -> Notification:
    notification = Notification(
        user_id=user_id,
        session_id=session_id,
        type=ntype,
        title=title,
        message=message,
    )
    db.add(notification)
    return notification


def start_parking_session(
    db: Session, user: User, zone: ParkingZone, lat: float, lng: float, app_settings: AppSettings
) -> ParkingSession:
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(minutes=app_settings.parking_timer_minutes)
    session = ParkingSession(
        user_id=user.id,
        zone_id=zone.id,
        status=SessionStatus.ACTIVE,
        started_at=now,
        expires_at=expires_at,
        stopped_lat=lat,
        stopped_lng=lng,
    )
    db.add(session)
    db.flush()
    _create_notification(
        db,
        user.id,
        session.id,
        NotificationType.SESSION_STARTED,
        "Парковка начата",
        f"Вы остановились в зоне «{zone.name}». Бесплатное время: {app_settings.parking_timer_minutes} мин.",
    )
    return session


def cancel_active_session(db: Session, user_id: int) -> ParkingSession | None:
    session = get_active_session(db, user_id)
    if not session:
        return None
    session.status = SessionStatus.CANCELLED
    session.ended_at = datetime.now(timezone.utc)
    return session


def process_session_notifications(
    db: Session, session: ParkingSession, app_settings: AppSettings
) -> list[Notification]:
    if session.status != SessionStatus.ACTIVE:
        return []

    now = datetime.now(timezone.utc)
    started_at = session.started_at
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=timezone.utc)

    elapsed_minutes = (now - started_at).total_seconds() / 60
    created: list[Notification] = []
    zone_name = session.zone.name if session.zone else "парковка"

    existing_reminders = db.scalars(
        select(Notification).where(
            Notification.session_id == session.id,
            Notification.type == NotificationType.PAY_REMINDER,
        )
    ).all()
    sent_milestones = {n.message.split("прошло ")[1].split(" мин")[0] for n in existing_reminders if "прошло " in n.message}

    for minutes in range(
        app_settings.notification_interval_minutes,
        app_settings.parking_timer_minutes,
        app_settings.notification_interval_minutes,
    ):
        if elapsed_minutes >= minutes and str(minutes) not in sent_milestones:
            remaining = app_settings.parking_timer_minutes - minutes
            notification = _create_notification(
                db,
                session.user_id,
                session.id,
                NotificationType.PAY_REMINDER,
                "Оплатите парковку",
                f"Зона «{zone_name}»: прошло {minutes} мин. Осталось ~{remaining} мин до окончания бесплатного времени.",
            )
            created.append(notification)

    if elapsed_minutes >= app_settings.parking_timer_minutes:
        if not _notification_exists(db, session.id, NotificationType.TIME_EXPIRED):
            notification = _create_notification(
                db,
                session.user_id,
                session.id,
                NotificationType.TIME_EXPIRED,
                "Парковка не оплачена",
                f"Время в зоне «{zone_name}» истекло. Необходимо уехать или оплатить парковку.",
            )
            created.append(notification)
        session.status = SessionStatus.EXPIRED
        session.ended_at = now

    return created


def mark_session_paid(db: Session, user_id: int) -> ParkingSession | None:
    session = get_active_session(db, user_id)
    if not session:
        return None
    session.status = SessionStatus.PAID
    session.ended_at = datetime.now(timezone.utc)
    zone_name = session.zone.name if session.zone else "парковка"
    _create_notification(
        db,
        user_id,
        session.id,
        NotificationType.PAYMENT_CONFIRMED,
        "Оплата подтверждена",
        f"Парковка в зоне «{zone_name}» отмечена как оплаченная. Таймер остановлен.",
    )
    return session


def handle_tracking_update(
    db: Session, user: User, lat: float, lng: float, is_stationary: bool
) -> dict:
    app_settings = get_app_settings(db)
    active = get_active_session(db, user.id)

    if not is_stationary:
        if active:
            cancel_active_session(db, user.id)
            db.commit()
            return {"action": "session_cancelled", "message": "Движение обнаружено, таймер остановлен."}
        db.commit()
        return {"action": "moving", "message": "Движение — таймер не запускается."}

    zone = find_zone_for_point(db, lat, lng)
    if not zone:
        if active:
            cancel_active_session(db, user.id)
            db.commit()
            return {"action": "session_cancelled", "message": "Вы вне парковочной зоны."}
        db.commit()
        return {"action": "stationary_outside_zone", "message": "Стоите на месте, но вне зоны парковки."}

    if active and active.zone_id == zone.id:
        created = process_session_notifications(db, active, app_settings)
        db.commit()
        return {
            "action": "session_active",
            "session_id": active.id,
            "zone": {"id": zone.id, "name": zone.name},
            "expires_at": active.expires_at.isoformat(),
            "new_notifications": len(created),
        }

    if active:
        cancel_active_session(db, user.id)

    session = start_parking_session(db, user, zone, lat, lng, app_settings)
    db.commit()
    return {
        "action": "session_started",
        "session_id": session.id,
        "zone": {"id": zone.id, "name": zone.name},
        "expires_at": session.expires_at.isoformat(),
    }
