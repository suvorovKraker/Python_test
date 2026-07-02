# Parking SPB

Кроссплатформенный веб-сервис парковки для Санкт-Петербурга.

## Ветки Git

| Ветка | Назначение |
|-------|------------|
| **main** | Стабильная версия, проверенная и готовая к релизу. Не менять напрямую. |
| **dev** | Разработка и тесты. Новые функции сюда; после проверки — merge в `main`. |

```bash
# Работа над новым функционалом
git checkout dev

# После тестов — слияние в стабильную ветку
git checkout main
git merge dev
git push origin main
```

## Запуск

```bash
pip install -r requirements.txt
cp .env.example .env
python run.py
```

- Mac: http://127.0.0.1:8000
- Телефон (Wi‑Fi): адрес в админке → «Доступ с телефона»

**Админ:** `admin@parking-spb.ru` / `admin123`

## Ключи карт (опционально)

В `.env`:
- `YANDEX_MAPS_API_KEY` — https://developer.tech.yandex.ru/
- `DGIS_API_KEY` — https://platform.2gis.ru/

Ключи привязаны к аккаунту разработчика, получить их может только владелец аккаунта.
