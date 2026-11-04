import os
import re
import json
import urllib.parse
from typing import Optional, List

import httpx
from fastapi import FastAPI, HTTPException, Query, Response, Request
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Конфигурация
# ---------------------------------------------------------------------------
VK_TOKEN = os.getenv("VK_TOKEN", "")
VK_API_VERSION = "5.199"
# User-Agent официального Android-клиента VK (Kate Mobile / VK Admin)
VK_USER_AGENT = os.getenv(
    "VK_USER_AGENT",
    "VKAndroidApp/8.50-2600 (Android 13; SDK 33; arm64-v8a; Xiaomi 2201116SC; ru; 1080x2340)",
)

# Токен Kate Mobile (публичный, для тестов). В проде заменить на свой.
KATE_MOBILE_TOKEN = os.getenv("VK_TOKEN", "")

CORS_ORIGINS = os.getenv("CORS_ORIGINS", "*").split(",")

app = FastAPI(title="EvuMusic VK Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Общий httpx-клиент с нужным User-Agent
_http_client: Optional[httpx.AsyncClient] = None


def get_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(
            headers={"User-Agent": VK_USER_AGENT},
            timeout=30.0,
            follow_redirects=True,
        )
    return _http_client


# ---------------------------------------------------------------------------
# Вспомогательные функции
# ---------------------------------------------------------------------------


async def vk_api(method: str, params: dict) -> dict:
    """Вызов VK API с эмуляцией Android-клиента."""
    url = f"https://api.vk.com/method/{method}"
    params = {**params, "access_token": KATE_MOBILE_TOKEN, "v": VK_API_VERSION}
    client = get_client()
    resp = await client.get(url, params=params)
    data = resp.json()
    if "error" in data:
        err = data["error"]
        raise HTTPException(
            status_code=400,
            detail=f"VK API error {err.get('error_code')}: {err.get('error_msg')}",
        )
    return data.get("response", {})


def rewrite_m3u8(manifest_text: str, base_url: str, backend_base: str) -> str:
    """
    Парсит m3u8-манифест и перезаписывает ссылки на .ts фрагменты
    так, чтобы они вели на наш бэкенд (/api/ts-proxy?url=...).

    Поддерживает:
      - абсолютные URL
      - относительные URL (разрешаются относительно base_url)
      - HLS-теги (#EXT-X-KEY, #EXT-X-MAP и т.д. с URI="...")
    """
    lines = manifest_text.splitlines()
    result = []

    for line in lines:
        stripped = line.strip()

        # Пустые строки / комментарии без URI — оставляем как есть
        if not stripped or stripped.startswith("#"):
            # Перезаписываем URI="..." внутри тегов (например, #EXT-X-KEY)
            if 'URI="' in stripped:
                line = re.sub(
                    r'URI="([^"]+)"',
                    lambda m: 'URI="' + _proxy_url(m.group(1), base_url, backend_base) + '"',
                    line,
                )
            result.append(line)
            continue

        # Это строка с URL сегмента (или плейлиста)
        original_url = stripped
        if not original_url.startswith("http"):
            # Относительный URL — разрешаем относительно base_url
            original_url = urllib.parse.urljoin(base_url, original_url)

        # Перезаписываем на наш прокси
        proxied = f"{backend_base}/api/ts-proxy?url={urllib.parse.quote(original_url, safe='')}"
        result.append(proxied)

    return "\n".join(result)


def _proxy_url(url: str, base_url: str, backend_base: str) -> str:
    """Преобразует одиночный URL в прокси-URL."""
    if not url.startswith("http"):
        url = urllib.parse.urljoin(base_url, url)
    return f"{backend_base}/api/ts-proxy?url={urllib.parse.quote(url, safe='')}"


# ---------------------------------------------------------------------------
# Эндпоинты
# ---------------------------------------------------------------------------


@app.get("/api/health")
async def health():
    return {"ok": True, "service": "EvuMusic VK Backend"}


@app.get("/api/search")
async def search(query: str = Query(..., min_length=1)):
    """
    Поиск аудио в ВК.
    Возвращает список треков с локальным stream URL.
    """
    if not KATE_MOBILE_TOKEN:
        raise HTTPException(
            status_code=503,
            detail="VK_TOKEN not set. Get one via: https://oauth.vk.com/authorize?client_id=2685278&scope=audio&response_type=token&v=5.199",
        )
    resp = await vk_api("audio.search", {
        "q": query,
        "count": 50,
        "sort": 2,  # по популярности
    })

    items = resp.get("items", [])
    tracks = []
    for item in items:
        # Обложка
        cover = None
        if item.get("album") and item["album"].get("thumb"):
            cover = item["album"]["thumb"].get("photo_300") or item["album"]["thumb"].get("photo_600")
        # ВК может отдавать photo напрямую
        if not cover and item.get("photo"):
            cover = item["photo"]

        audio_id = f"{item['owner_id']}_{item['id']}"
        tracks.append(
            {
                "id": audio_id,
                "title": item.get("title", "Без названия"),
                "artist": item.get("artist", "Неизвестен"),
                "duration": item.get("duration", 0),
                "cover": cover,
                "stream_url": f"/api/stream/{audio_id}",
            }
        )

    return {"tracks": tracks}


@app.get("/api/stream/{audio_id}")
async def stream(audio_id: str, request: Request = None):
    """
    Получает оригинальную ссылку .m3u8 у ВК через audio.getById,
    скачивает манифест, перезаписывает ссылки на .ts фрагменты
    и отдаёт клиенту модифицированный m3u8.
    """
    # audio_id формат: owner_id_audio_id
    parts = audio_id.split("_")
    if len(parts) != 2:
        raise HTTPException(status_code=400, detail="Invalid audio_id format")
    owner_id, audio_id_num = parts

    # Запрашиваем данные трека у ВК
    resp = await vk_api("audio.getById", {"audios": f"{owner_id}_{audio_id_num}"})
    if not resp or not isinstance(resp, list) or len(resp) == 0:
        raise HTTPException(status_code=404, detail="Track not found")

    track = resp[0]
    original_url = track.get("url")
    if not original_url:
        raise HTTPException(status_code=404, detail="No stream URL available")

    # ВК может отдать прямую ссылку на mp3 (старый формат) или m3u8 (HLS)
    # Если это mp3 — просто редиректим
    if ".mp3" in original_url or ".m4a" in original_url:
        from fastapi.responses import RedirectResponse

        return RedirectResponse(url=original_url)

    # Если это m3u8 — скачиваем и перезаписываем
    client = get_client()
    try:
        manifest_resp = await client.get(original_url)
        manifest_resp.raise_for_status()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch manifest: {e}")

    manifest_text = manifest_resp.text
    base_url = str(manifest_resp.url)  # финальный URL после редиректов

    # Определяем базовый URL бэкенда из запроса
    backend_base = ""  # будет подставлен из env или запроса
    # Для локальной разработки используем localhost
    backend_base = os.getenv("BACKEND_URL", "http://localhost:8000")

    rewritten = rewrite_m3u8(manifest_text, base_url, backend_base)

    return Response(
        content=rewritten,
        media_type="application/vnd.apple.mpegurl",
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "*",
            "Cache-Control": "no-cache",
        },
    )


@app.get("/api/ts-proxy")
async def ts_proxy(url: str = Query(...)):
    """
    Проксирует .ts фрагменты HLS-потока.
    Скачивает фрагмент с серверов ВК и отдаёт клиенту.
    """
    client = get_client()
    try:
        resp = await client.get(url)
        resp.raise_for_status()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch fragment: {e}")

    content_type = resp.headers.get("content-type", "video/mp2t")
    return Response(
        content=resp.content,
        media_type=content_type,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Cache-Control": "public, max-age=3600",
        },
    )


# ---------------------------------------------------------------------------
# Запуск
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
