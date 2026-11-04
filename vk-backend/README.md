# EvuMusic VK Backend — инструкция

## Как получить VK токен

1. Открой в браузере (войди в ВК):
   https://oauth.vk.com/authorize?client_id=2685278&scope=audio&response_type=token&v=5.199

2. После авторизации браузер перенаправит на пустую страницу с URL вида:
   https://oauth.vk.com/blank.html#access_token=vk1.a.XXXXX&expires_in=86400&user_id=12345

3. Скопируй значение `access_token` (начинается с `vk1.a.`)

4. Вставь в `.env`:
   ```
   VK_TOKEN=vk1.a.XXXXX
   ```

## Запуск

```bash
cd vk-backend
python -m pip install -r requirements.txt
copy .env.example .env
# отредактируй .env (VK_TOKEN)
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

## API

- `GET /api/health` — проверка
- `GET /api/search?query=название` — поиск (нужен VK_TOKEN)
- `GET /api/stream/{audio_id}` — m3u8 манифест (audio_id = owner_id_audio_id)
- `GET /api/ts-proxy?url=...` — прокси .ts фрагментов

## Как подключить к фронтенду

В `app.js`:
```javascript
var BACKEND_URL = 'http://localhost:8000'; // или твой сервер
```

Поиск автоматически пойдёт через VK backend (полные треки).

## Архитектура

```
Mini App → /api/search → VK API (audio.search) → список треков
Mini App → /api/stream/{id} → VK API (audio.getById) → m3u8 манифест
  → парсинг m3u8 → перезапись .ts ссылок → /api/ts-proxy
Mini App (hls.js) → /api/ts-proxy?url=... → VK CDN → аудио
```

VK привязывает поток к IP сервера. Бэкенд скачивает манифест и фрагменты,
перезаписывает ссылки, чтобы клиент получал их через наш прокси.

## Важно

- Токен VK живёт 24 часа (expires_in=86400). Нужно обновлять.
- VK может заблокировать токен при подозрительной активности.
- Для продакшена используйте официальный VK API (требует регистрации приложения).
- Код эмулирует Android-клиент VK (Kate Mobile) для доступа к audio методам.
