import os
from typing import Optional, List

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, RedirectResponse
from dotenv import load_dotenv
from yandex_music import Client

load_dotenv()

CORS_ORIGINS = os.getenv("CORS_ORIGINS", "*").split(",")
PORT = int(os.getenv("PORT", "8002"))

app = FastAPI(title="EvuMusic Yandex Music Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Яндекс Музыка клиент (анонимный, без токена)
_ym_client: Optional[Client] = None


def get_ym_client() -> Client:
    global _ym_client
    if _ym_client is None:
        _ym_client = Client()
        _ym_client.init()
    return _ym_client


# Кеш прямых ссылок (track_id -> url)
_link_cache: dict = {}


def format_duration(ms: int) -> str:
    seconds = ms // 1000
    m = seconds // 60
    s = seconds % 60
    return f"{m}:{s:02d}"


@app.get("/api/health")
async def health():
    return {"ok": True, "service": "EvuMusic Yandex Music Backend"}


@app.get("/api/search")
async def search(query: str = Query(None, min_length=1), q: str = Query(None, min_length=1), limit: int = 30):
    if not query and q:
        query = q
    """
    Поиск треков в Яндекс Музыке (анонимный доступ, без токена).
    """
    try:
        client = get_ym_client()
        results = client.search(query)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Yandex Music search error: {e}")

    if not results or not results.tracks:
        return {"tracks": []}

    tracks = []
    for t in results.tracks.results[:limit]:
        artist = t.artists[0].name if t.artists else "Неизвестен"
        cover = None
        if t.cover_uri:
            cover = "https://" + t.cover_uri.replace("%%", "400x400")

        tracks.append(
            {
                "id": str(t.id),
                "title": t.title or "Без названия",
                "artist": artist,
                "duration": t.duration_ms or 0,
                "dur": format_duration(t.duration_ms or 0),
                "cover": cover,
                "stream_url": f"/api/audio/{t.id}",
                "preview": f"/api/audio/{t.id}",
                "preview_url": f"/api/audio/{t.id}",
            }
        )

    return {"tracks": tracks}


@app.get("/api/stream/{track_id}")
async def stream(track_id: str):
    """
    Получает прямую ссылку на аудио из Яндекс Музыки
    и редиректит на неё (или проксирует).
    """
    try:
        client = get_ym_client()
        tracks = client.tracks([track_id])
        if not tracks:
            raise HTTPException(status_code=404, detail="Track not found")
        track = tracks[0]
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Yandex Music error: {e}")

    # Получаем прямую ссылку
    try:
        download_info = track.get_download_info()
        if not download_info:
            raise HTTPException(status_code=404, detail="No download info available")

        # Берём лучшее качество (mp3 192 или 320)
        best = max(download_info, key=lambda x: x.bitrate_in_kbps or 0)
        direct_url = best.get_direct_link()
        if not direct_url:
            raise HTTPException(status_code=404, detail="No direct link available")

        _link_cache[track_id] = direct_url
        return RedirectResponse(url=direct_url)

    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to get stream URL: {e}")


@app.get("/api/audio/{track_id}")
async def audio_proxy(track_id: str):
    """
    Проксирует аудио (если прямая ссылка не работает из-за CORS/истечения).
    """
    # Сначала получаем прямую ссылку
    try:
        client = get_ym_client()
        tracks = client.tracks([track_id])
        if not tracks:
            raise HTTPException(status_code=404, detail="Track not found")
        track = tracks[0]
        download_info = track.get_download_info()
        if not download_info:
            raise HTTPException(status_code=404, detail="No download info")
        best = max(download_info, key=lambda x: x.bitrate_in_kbps or 0)
        direct_url = best.get_direct_link()
        if not direct_url:
            raise HTTPException(status_code=404, detail="No direct link")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Yandex Music error: {e}")

    # Стримим аудио
    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
        try:
            resp = await client.get(direct_url)
            if resp.status_code != 200:
                raise HTTPException(status_code=502, detail="Failed to fetch audio")
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"HTTP error: {e}")

        async def stream_generator():
            async for chunk in resp.aiter_bytes(chunk_size=8192):
                yield chunk

        return StreamingResponse(
            stream_generator(),
            media_type=resp.headers.get("content-type", "audio/mpeg"),
            headers={
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "public, max-age=3600",
            },
        )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=True)
