import os
import json
import hashlib
import hmac
from urllib.parse import parse_qsl
from typing import Optional
from contextlib import asynccontextmanager

import asyncpg
from fastapi import FastAPI, Header, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

# Глобальный пул соединений
pool: Optional[asyncpg.Pool] = None

# Современный способ управления жизненным циклом приложения (вместо on_event)
@asynccontextmanager
async def lifespan(app: FastAPI):
    global pool
    # Подключаемся к Neon при старте
    pool = await asyncpg.create_pool(os.getenv("DATABASE_URL"), min_size=1, max_size=10)
    print("Connected to Neon DB")
    yield
    # Закрываем пул при остановке
    if pool:
        await pool.close()

app = FastAPI(title="EvuMusic User Data API", lifespan=lifespan)

# Разрешаем запросы с любых доменов (чтобы Render и локальный тест работали)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

BOT_TOKEN = os.getenv("BOT_TOKEN")

# Модели данных для приема запросов от сайта
class TrackData(BaseModel):
    id: str
    title: str
    artist: str
    duration: str = ""
    cover: str = ""
    source: str = ""

class PlaylistData(BaseModel):
    title: str

class PlaylistTrackData(TrackData):
    playlist_id: int

# Функция проверки подписи Telegram (чтобы хакеры не могли слать левые запросы)
def verify_telegram_data(init_data: str) -> dict:
    if not init_data:
        raise HTTPException(status_code=401, detail="No init data")
    try:
        parsed_data = dict(parse_qsl(init_data))
        hash_str = parsed_data.pop('hash')
        
        # Собираем строку для проверки
        data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(parsed_data.items()))
        
        # Вычисляем хэш на основе BOT_TOKEN
        secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        calculated_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
        
        if hmac.compare_digest(calculated_hash, hash_str):
            return json.loads(parsed_data['user'])
        raise HTTPException(status_code=403, detail="Invalid auth data")
    except Exception as e:
        raise HTTPException(status_code=403, detail=str(e))

# Зависимость: вытаскиваем ID пользователя из заголовка Authorization
async def get_user_id(authorization: str = Header(None)):
    user = verify_telegram_data(authorization)
    return user['id']


# --- ЭНДПОИНТЫ (API) ---

# 1. Получить ВСЕ данные пользователя при загрузке приложения
@app.get("/api/user_data")
async def get_user_data(user_id: int = Depends(get_user_id)):
    async with pool.acquire() as conn:
        # Любимые треки
        favs = await conn.fetch("SELECT track_id as id, title, artist, duration, cover, source FROM favorites WHERE user_id=$1", user_id)
        # Коллекция
        lib = await conn.fetch("SELECT track_id as id, title, artist, duration, cover, source FROM library_tracks WHERE user_id=$1", user_id)
        
        # Плейлисты
        playlists = await conn.fetch("SELECT id, title as name FROM playlists WHERE user_id=$1", user_id)
        pls = []
        for pl in playlists:
            tracks = await conn.fetch("SELECT track_id as id, title, artist, duration, cover, source FROM playlist_tracks WHERE playlist_id=$1 ORDER BY position", pl['id'])
            pls.append({
                "id": pl['id'],
                "name": pl['name'],
                "tracks": [dict(t) for t in tracks],
                "count": len(tracks)
            })
            
    return {
        "favorites": [dict(f) for f in favs],
        "library": [dict(l) for l in lib],
        "playlists": pls
    }

# 2. Добавить/удалить из Любимого
@app.post("/api/favorites")
async def toggle_favorite(track: TrackData, user_id: int = Depends(get_user_id)):
    async with pool.acquire() as conn:
        exists = await conn.fetchval("SELECT 1 FROM favorites WHERE user_id=$1 AND track_id=$2", user_id, track.id)
        if exists:
            await conn.execute("DELETE FROM favorites WHERE user_id=$1 AND track_id=$2", user_id, track.id)
            return {"status": "removed"}
        else:
            await conn.execute(
                "INSERT INTO favorites (user_id, track_id, title, artist, duration, cover, source) VALUES ($1,$2,$3,$4,$5,$6,$7)",
                user_id, track.id, track.title, track.artist, track.duration, track.cover, track.source
            )
            return {"status": "added"}

# 3. Добавить/удалить из Коллекции (Моя музыка)
@app.post("/api/library")
async def toggle_library(track: TrackData, user_id: int = Depends(get_user_id)):
    async with pool.acquire() as conn:
        exists = await conn.fetchval("SELECT 1 FROM library_tracks WHERE user_id=$1 AND track_id=$2", user_id, track.id)
        if exists:
            await conn.execute("DELETE FROM library_tracks WHERE user_id=$1 AND track_id=$2", user_id, track.id)
            return {"status": "removed"}
        else:
            await conn.execute(
                "INSERT INTO library_tracks (user_id, track_id, title, artist, duration, cover, source) VALUES ($1,$2,$3,$4,$5,$6,$7)",
                user_id, track.id, track.title, track.artist, track.duration, track.cover, track.source
            )
            return {"status": "added"}

# 4. Создать плейлист
@app.post("/api/playlists")
async def create_playlist(data: PlaylistData, user_id: int = Depends(get_user_id)):
    async with pool.acquire() as conn:
        pl_id = await conn.fetchval(
            "INSERT INTO playlists (user_id, title) VALUES ($1,$2) RETURNING id",
            user_id, data.title
        )
        return {"id": pl_id, "name": data.title, "tracks": [], "count": 0}

# 5. Добавить трек в плейлист
@app.post("/api/playlists/add_track")
async def add_track_to_playlist(data: PlaylistTrackData, user_id: int = Depends(get_user_id)):
    async with pool.acquire() as conn:
        # Проверяем, что плейлист принадлежит этому юзеру
        owner = await conn.fetchval("SELECT user_id FROM playlists WHERE id=$1", data.playlist_id)
        if owner != user_id:
            raise HTTPException(status_code=403, detail="Not your playlist")
            
        await conn.execute(
            """INSERT INTO playlist_tracks (playlist_id, track_id, title, artist, duration, cover, source) 
               VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING""",
            data.playlist_id, data.id, data.title, data.artist, data.duration, data.cover, data.source
        )
        return {"status": "ok"}
