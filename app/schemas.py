from datetime import datetime

from pydantic import BaseModel, EmailStr, Field


class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6)


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str


class UserOut(BaseModel):
    id: int
    email: str
    role: str

    model_config = {"from_attributes": True}


class AdminUserOut(BaseModel):
    id: int
    email: str
    role: str
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class ZoneCreate(BaseModel):
    name: str
    description: str | None = None
    polygon_geojson: str


class ZoneOut(BaseModel):
    id: int
    name: str
    description: str | None
    polygon_geojson: str
    city: str
    is_active: bool

    model_config = {"from_attributes": True}


class TrackingUpdate(BaseModel):
    lat: float
    lng: float
    is_stationary: bool


class NotificationOut(BaseModel):
    id: int
    type: str
    title: str
    message: str
    is_read: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class AppSettingsOut(BaseModel):
    parking_timer_minutes: int
    notification_interval_minutes: int
    stop_detection_seconds: int
    movement_radius_meters: float

    model_config = {"from_attributes": True}


class AppSettingsUpdate(BaseModel):
    parking_timer_minutes: int = Field(ge=1, le=180)
    notification_interval_minutes: int = Field(ge=1, le=60)
    stop_detection_seconds: int = Field(ge=10, le=600)
    movement_radius_meters: float = Field(ge=5, le=200)


class SessionOut(BaseModel):
    id: int
    zone_id: int
    zone_name: str
    status: str
    started_at: datetime
    expires_at: datetime

    model_config = {"from_attributes": True}


class GeocodeResultOut(BaseModel):
    display_name: str
    lat: float
    lng: float
    geojson: dict | None
