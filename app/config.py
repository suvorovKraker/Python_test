from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    secret_key: str = "dev-secret-change-me"
    database_url: str = "sqlite:///./data/parking_spb.db"
    admin_email: str = "admin@parking-spb.ru"
    admin_password: str = "admin123"
    parking_timer_minutes: int = 15
    notification_interval_minutes: int = 5
    notification_interval_seconds: int = 300
    stop_detection_seconds: int = 120
    movement_radius_meters: float = 15.0
    city_center_lat: float = 59.9343
    city_center_lng: float = 30.3351
    city_default_zoom: int = 12
    yandex_maps_api_key: str = ""
    dgis_api_key: str = ""


settings = Settings()
