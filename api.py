import os
import re
import json
import html
import hmac
import hashlib
import base64
import asyncio
import collections
import time
import difflib
from urllib.parse import parse_qsl, urljoin, urlparse
from typing import Optional
from contextlib import asynccontextmanager

import asyncpg
import httpx
from fastapi import FastAPI, Header, HTTPException, Depends, Query, Request, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
ENABLE_MUZOFOND = os.getenv("MUZOFOND", "1") == "1"
ENABLE_YANDEX = os.getenv("YANDEX", "1") == "1"
ENABLE_SOUNDCLOUD = os.getenv("SOUNDCLOUD", "1") == "1"
YM_TOKEN = os.getenv("YM_TOKEN", "").strip()
PROXY_SECRET = os.getenv("PROXY_SECRET", "evu-music-proxy-secret").encode()
DEFAULT_SC_CLIENT_ID = "nIjtjiYnjkOhMyh5xrbqEW12DxeJVnic"
SC_CLIENT_ID = (os.getenv("SC_CLIENT_ID", "") or DEFAULT_SC_CLIENT_ID).strip()
SC_API = "https://api-v2.soundcloud.com"
ITUNES_API = "https://itunes.apple.com"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

pool: Optional[asyncpg.Pool] = None
_http: Optional[httpx.AsyncClient] = None

# Кеши (TTL, автоматическая очистка)
_search_cache = {}
_album_cache = {}
_album_search_cache = {}
_sc_resolve_cache = {}
_sc_resolve_inflight = {}
_ym_link_cache = {}

_CACHE_TTL = 900        # 15 минут
_CACHE_MAX = 600        # максимум записей на кеш

def _cache_get(cache, key):
    ent = cache.get(key)
    if not ent: return None
    ts, val = ent
    if time.time() - ts > _CACHE_TTL:
        cache.pop(key, None)
        return None
    return val

def _cache_put(cache, key, val):
    if len(cache) >= _CACHE_MAX:
        # выкидываем ~10% самых старых записей
        stale = sorted(cache.items(), key=lambda kv: kv[1][0])[:max(1, _CACHE_MAX // 10)]
        for k, _ in stale: cache.pop(k, None)
    cache[key] = (time.time(), val)

@asynccontextmanager
async def lifespan(app: FastAPI):
    global pool, _http
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL environment variable is missing")
    pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=10)
    
    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS favorites (
              user_id BIGINT NOT NULL, track_id TEXT NOT NULL, title TEXT NOT NULL,
              artist TEXT, duration TEXT, cover TEXT, source TEXT, preview TEXT,
              added_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (user_id, track_id)
            );
            ALTER TABLE favorites ADD COLUMN IF NOT EXISTS preview TEXT;
            ALTER TABLE favorites ADD COLUMN IF NOT EXISTS cover TEXT;
            ALTER TABLE favorites ADD COLUMN IF NOT EXISTS source TEXT;

            CREATE TABLE IF NOT EXISTS library_tracks (
              id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, track_id TEXT NOT NULL,
              title TEXT NOT NULL, artist TEXT, duration TEXT, cover TEXT, source TEXT, preview TEXT,
              added_at TIMESTAMPTZ DEFAULT now(), UNIQUE (user_id, track_id)
            );
            ALTER TABLE library_tracks ADD COLUMN IF NOT EXISTS preview TEXT;

            CREATE TABLE IF NOT EXISTS playlists (
              id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, title TEXT NOT NULL,
              created_at TIMESTAMPTZ DEFAULT now()
            );

            CREATE TABLE IF NOT EXISTS playlist_tracks (
              playlist_id BIGINT NOT NULL, track_id TEXT NOT NULL, title TEXT NOT NULL,
              artist TEXT, duration TEXT, cover TEXT, source TEXT, preview TEXT,
              position INT DEFAULT 0, added_at TIMESTAMPTZ DEFAULT now(),
              PRIMARY KEY (playlist_id, track_id)
            );
            ALTER TABLE playlist_tracks ADD COLUMN IF NOT EXISTS preview TEXT;
        """)
    
    _http = httpx.AsyncClient(
        timeout=httpx.Timeout(10.0, connect=5.0),
        follow_redirects=True,
        headers={"User-Agent": USER_AGENT, "Accept-Language": "ru-RU,ru;q=0.9"},
    )
    print("[API] Connected to Neon DB")
    try:
        yield
    finally:
        if _http: await _http.aclose()
        if pool: await pool.close()

app = FastAPI(title="EvuMusic API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
    expose_headers=["Content-Length", "Content-Range", "Accept-Ranges", "Content-Type"],
)

def get_http() -> httpx.AsyncClient:
    global _http
    if _http is None:
        _http = httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, connect=5.0), follow_redirects=True,
            headers={"User-Agent": USER_AGENT, "Accept-Language": "ru-RU,ru;q=0.9"},
        )
    return _http

# ==========================================
# TELEGRAM AUTH
# ==========================================
def verify_telegram_data(init_data: str) -> dict:
    if not init_data: raise HTTPException(status_code=401, detail="No init data")
    if not BOT_TOKEN: raise HTTPException(status_code=500, detail="BOT_TOKEN missing")
    try:
        parsed_data = dict(parse_qsl(init_data))
        received_hash = parsed_data.pop("hash", None)
        if not received_hash: raise HTTPException(status_code=403, detail="Missing hash")
        data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(parsed_data.items()))
        secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        calculated_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(calculated_hash, received_hash):
            raise HTTPException(status_code=403, detail="Invalid auth")
        return json.loads(parsed_data.get("user", "{}"))
    except Exception:
        raise HTTPException(status_code=403, detail="Invalid auth")

async def get_user_id(authorization: Optional[str] = Header(None)):
    user = verify_telegram_data(authorization)
    return int(user.get("id"))

# ==========================================
# БАЗА ДАННЫХ
# ==========================================
class TrackData(BaseModel):
    id: str
    title: str
    artist: str
    duration: str = ""
    cover: str = ""
    source: str = ""
    preview: str = ""

class PlaylistData(BaseModel):
    title: str

class PlaylistTrackData(TrackData):
    playlist_id: int

@app.get("/api/user_data")
async def get_user_data(user_id: int = Depends(get_user_id)):
    async with pool.acquire() as conn:
        favs = await conn.fetch("SELECT track_id AS id, title, artist, duration, cover, source, preview FROM favorites WHERE user_id=$1", user_id)
        lib = await conn.fetch("SELECT track_id AS id, title, artist, duration, cover, source, preview FROM library_tracks WHERE user_id=$1", user_id)
        playlists = await conn.fetch("SELECT id, title AS name FROM playlists WHERE user_id=$1", user_id)
        pls = []
        for pl in playlists:
            tracks = await conn.fetch("SELECT track_id AS id, title, artist, duration, cover, source, preview FROM playlist_tracks WHERE playlist_id=$1 ORDER BY position", pl["id"])
            pls.append({"id": pl["id"], "name": pl["name"], "tracks": [dict(t) for t in tracks], "count": len(tracks)})
    return {"favorites": [dict(f) for f in favs], "library": [dict(l) for l in lib], "playlists": pls}

@app.post("/api/favorites")
async def toggle_favorite(track: TrackData, user_id: int = Depends(get_user_id)):
    async with pool.acquire() as conn:
        exists = await conn.fetchval("SELECT 1 FROM favorites WHERE user_id=$1 AND track_id=$2", user_id, track.id)
        if exists:
            await conn.execute("DELETE FROM favorites WHERE user_id=$1 AND track_id=$2", user_id, track.id)
            return {"status": "removed"}
        await conn.execute("INSERT INTO favorites (user_id, track_id, title, artist, duration, cover, source, preview) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", user_id, track.id, track.title, track.artist, track.duration, track.cover, track.source, track.preview)
        return {"status": "added"}

@app.post("/api/update_preview")
async def update_preview(track: TrackData, user_id: int = Depends(get_user_id)):
    async with pool.acquire() as conn:
        await conn.execute("UPDATE favorites SET preview=$1 WHERE user_id=$2 AND track_id=$3", track.preview, user_id, track.id)
        await conn.execute("UPDATE library_tracks SET preview=$1 WHERE user_id=$2 AND track_id=$3", track.preview, user_id, track.id)
        await conn.execute("UPDATE playlist_tracks SET preview=$1 WHERE playlist_id IN (SELECT id FROM playlists WHERE user_id=$2) AND track_id=$3", track.preview, user_id, track.id)
    return {"status": "ok"}

@app.post("/api/playlists")
async def create_playlist(data: PlaylistData, user_id: int = Depends(get_user_id)):
    async with pool.acquire() as conn:
        pl_id = await conn.fetchval("INSERT INTO playlists (user_id, title) VALUES ($1,$2) RETURNING id", user_id, data.title)
    return {"id": pl_id, "name": data.title, "tracks": [], "count": 0}

@app.delete("/api/playlists/{playlist_id}")
async def delete_playlist(playlist_id: int, user_id: int = Depends(get_user_id)):
    async with pool.acquire() as conn:
        owner = await conn.fetchval("SELECT user_id FROM playlists WHERE id=$1", playlist_id)
        if owner != user_id: raise HTTPException(status_code=403, detail="Not yours")
        await conn.execute("DELETE FROM playlists WHERE id=$1", playlist_id)
    return {"status": "ok"}

@app.post("/api/playlists/add_track")
async def add_track_to_playlist(data: PlaylistTrackData, user_id: int = Depends(get_user_id)):
    async with pool.acquire() as conn:
        owner = await conn.fetchval("SELECT user_id FROM playlists WHERE id=$1", data.playlist_id)
        if owner != user_id: raise HTTPException(status_code=403, detail="Not yours")
        await conn.execute("INSERT INTO playlist_tracks (playlist_id, track_id, title, artist, duration, cover, source, preview) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING", data.playlist_id, data.id, data.title, data.artist, data.duration, data.cover, data.source, data.preview)
    return {"status": "ok"}

# ==========================================
# ОТПРАВКА В ЧАТ (В ФОНЕ)
# ==========================================
async def send_audio_task(user_id: int, track: TrackData, audio_url: str):
    tg_url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendAudio"
    watermark = "\n\n🤖 Скачано через: @EvuMusicBot"
    caption_text = f"🎵 {track.title} — {track.artist}{watermark}"
    
    payload = {
        "chat_id": user_id, 
        "audio": audio_url, 
        "title": track.title, 
        "performer": track.artist, 
        "caption": caption_text
    }
    
    try:
        async with httpx.AsyncClient() as client:
            # Таймаут увеличен, так как файл может скачиваться долго
            res = await client.post(tg_url, json=payload, timeout=60.0)
            if res.status_code != 200:
                fallback_text = f"🎵 {track.title}\n{audio_url}{watermark}"
                await client.post(f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage", json={"chat_id": user_id, "text": fallback_text})
    except Exception as e:
        print(f"[SEND ERROR] {e}")

@app.post("/api/send_to_chat")
async def send_to_chat(track: TrackData, background_tasks: BackgroundTasks, user_id: int = Depends(get_user_id)):
    if not track.preview: raise HTTPException(status_code=400, detail="No preview")
    audio_url = track.preview
    if audio_url.startswith('/'):
        audio_url = os.getenv("API_BASE_URL", "https://evumus.onrender.com") + audio_url

    # Добавляем задачу в фон и сразу возвращаем ответ
    background_tasks.add_task(send_audio_task, user_id, track, audio_url)
    
    return {"status": "ok"}

# ==========================================
# УТИЛИТЫ
# ==========================================
def sign(url: str) -> str:
    blob = base64.urlsafe_b64encode(url.encode("utf-8")).decode().rstrip("=")
    sig = hmac.new(PROXY_SECRET, blob.encode("ascii"), hashlib.sha256).hexdigest()[:16]
    return blob + "." + sig

def unsign(token: str) -> str:
    blob, _, sig = token.rpartition(".")
    if not blob or not sig: raise HTTPException(status_code=400, detail="Bad token")
    expect = hmac.new(PROXY_SECRET, blob.encode("ascii"), hashlib.sha256).hexdigest()[:16]
    if not hmac.compare_digest(sig, expect): raise HTTPException(status_code=403, detail="Bad signature")
    pad = "=" * (-len(blob) % 4)
    try: return base64.urlsafe_b64decode(blob + pad).decode("utf-8")
    except Exception: raise HTTPException(status_code=400, detail="Bad payload")

def fmt_duration(seconds: int) -> str:
    return "%d:%02d" % (int(seconds or 0) // 60, int(seconds or 0) % 60)

def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()

def pack(t: dict) -> dict:
    full = t.get("full", True)
    if t.get("audio_url"): stream = "/api/stream/" + sign(t["audio_url"])
    elif t.get("source") == "yandex" and t.get("ym_id"): stream = "/api/audio/" + t["ym_id"]
    elif t.get("source") == "soundcloud" and t.get("ext_id"): stream = "/api/sc/" + t["ext_id"]
    else: stream = ""
    cover = t.get("cover") or ""
    if cover: cover = "/api/cover/" + sign(cover)
    return {
        "id": t["source"] + "_" + t["ext_id"], "title": t["title"], "artist": t["artist"],
        "duration": t.get("duration", 0), "dur": fmt_duration(t.get("duration", 0)),
        "cover": cover, "stream_url": stream, "preview_url": stream, "preview": stream,
        "full": full, "source": t["source"],
        "ext_id": str(t.get("ext_id") or ""),
        "ym_id": str(t.get("ym_id") or ""),
    }

def rank(tracks: list, query: str) -> list:
    words = [w for w in re.split(r"\W+", (query or "").lower(), flags=re.U) if len(w) > 1]
    q = (query or "").lower().strip()
    junk_re = re.compile(r"(cover|кавер|кувер|remix|ремикс|remake|караоке|karaoke|instrumental|инструментал|мини-?атюра|миниат|припев|ringtone|рингтон|reaction|реакция|live at|bootleg|\bминус(овка)?\b|\(live\b|\blive\)|radio ?edit)", re.I)
    def score(t):
        title = t.get("title", "").lower(); artist = t.get("artist", "").lower(); hay = title + " " + artist
        s = sum(2 for w in words if w in hay)
        if words and all(w in title for w in words): s += 10
        if q and (title.startswith(q) or hay.startswith(q)): s += 8
        if q and (q == title or q + "?" == title): s += 15
        elif q and q in title: s += 4
        if q and junk_re.search(title) and not junk_re.search(q): s -= 12
        if t.get("full", True): s += 1
        if not t.get("duration"): s -= 3
        return -s
    tracks = [t for t in tracks if t.get("title")]
    tracks.sort(key=score)
    tracks.sort(key=lambda t: (0 if t.get("full", True) else 1))
    return tracks

# ==========================================
# ПОИСКОВИКИ
# ==========================================
_ITEM_SPLIT = re.compile(r'<li class="item" ')
_DL_RE = re.compile(r'class="play" data-id="\d+" data-url="(https://dl[^"]+)"')
_ARTIST_RE = re.compile(r'<span class="artist">(.*?)</span>', re.S)
_TRACK_RE = re.compile(r'<span class="track">(.*?)</span>', re.S)
_IMG_RE = re.compile(r'data-img="([^"]+)"')

def _strip_tags(s: str) -> str:
    return norm(html.unescape(re.sub(r"<[^>]+>", "", s or "")))

def parse_muzofond(html_text: str) -> list:
    out, by_url = [], {}
    for body in _ITEM_SPLIT.split(html_text)[1:]:
        idm = re.match(r'data-id="(\d+)"', body); dm = re.search(r'data-duration="(\d+)"', body); urlm = _DL_RE.search(body)
        if not (idm and urlm): continue
        tm = _TRACK_RE.search(body); am = _ARTIST_RE.search(body)
        title = _strip_tags(tm.group(1)) if tm else ""; artist = _strip_tags(am.group(1)) if am else ""
        if not title: continue
        img = _IMG_RE.search(body); cover = ""
        if img and img.group(1).startswith("/"): cover = "https://muzofond.fm" + img.group(1)
        elif img: cover = img.group(1)
        item = {"ext_id": idm.group(1), "title": title, "artist": artist or "Неизвестен", "duration": int(dm.group(1)) if dm else 0, "cover": cover, "audio_url": urlm.group(1), "source": "muzofond"}
        prev = by_url.get(item["audio_url"])
        if prev is None: by_url[item["audio_url"]] = item
        elif len(item["title"]) < len(prev["title"]): by_url[item["audio_url"]] = item
    return list(by_url.values())

async def muzofond_fetch(url: str) -> list:
    try:
        r = await get_http().get(url)
        return parse_muzofond(r.text) if r.status_code == 200 else []
    except Exception: return []

async def muzofond_search(query: str, limit: int) -> list:
    params_a = httpx.QueryParams({"q": query, "artist": "0"}); params_b = httpx.QueryParams({"q": query, "artist": "1"})
    results = await asyncio.gather(muzofond_fetch("https://muzofond.fm/music?" + str(params_a)), muzofond_fetch("https://muzofond.fm/music?" + str(params_b)), return_exceptions=True)
    merged, by_url = [], {}
    for res in results:
        if isinstance(res, Exception) or not res: continue
        for t in res:
            key = t["audio_url"]; prev = by_url.get(key)
            if prev is None: by_url[key] = t; merged.append(t)
            elif len(t["title"]) < len(prev["title"]): prev.update(t)
    return rank(merged, query)[:limit]

def sc_params(**extra):
    p = {"client_id": SC_CLIENT_ID}; p.update(extra); return p

async def soundcloud_search(query: str, limit: int) -> list:
    if not ENABLE_SOUNDCLOUD: return []
    try:
        r = await get_http().get(SC_API + "/search/tracks", params=sc_params(q=query, limit=min(limit, 50)))
        if r.status_code != 200: return []
        out = []
        for t in r.json().get("collection", [])[:limit]:
            if not t: continue
            artwork = t.get("artwork_url")
            if artwork: artwork = artwork.replace("-large.jpg", "-t500x500.jpg")
            else:
                user = t.get("user") or {}
                artwork = user.get("avatar_url")
                if artwork: artwork = artwork.replace("-large.jpg", "-t500x500.jpg")
            out.append({
                "ext_id": str(t["id"]), "title": norm(t.get("title") or "Без названия"),
                "artist": norm((t.get("user") or {}).get("username") or "Неизвестен"),
                "duration": int((t.get("duration") or 0) / 1000), "cover": artwork or "",
                "track_authorization": t.get("track_authorization") or "",
                "source": "soundcloud", "full": True
            })
        return out
    except Exception: return []

async def _prewarm_sc_impl(sc_id):
    """Resolve SoundCloud to a browser-playable stream, retrying transient API failures."""
    sc_id = str(sc_id)
    if sc_id in _sc_resolve_cache:
        return

    cli = get_http()
    track = None
    # SoundCloud can intermittently return 429/5xx or an incomplete response.
    for attempt in range(3):
        try:
            response = await cli.get(
                SC_API + "/tracks/" + sc_id,
                params=sc_params(),
                headers={"Accept": "application/json"},
                timeout=httpx.Timeout(connect=8.0, read=18.0, write=10.0, pool=8.0),
            )
            if response.status_code == 200:
                track = response.json()
                if isinstance(track, dict) and (track.get("media") or {}).get("transcodings"):
                    break
                print(f"[SOUNDCLOUD RESOLVE] {sc_id}: incomplete track metadata")
            else:
                print(f"[SOUNDCLOUD RESOLVE] {sc_id}: track endpoint HTTP {response.status_code}: {response.text[:200]}")
                if response.status_code not in (408, 425, 429) and response.status_code < 500:
                    return
        except (httpx.HTTPError, ValueError) as exc:
            print(f"[SOUNDCLOUD RESOLVE] {sc_id}: metadata attempt {attempt + 1} failed: {exc}")
        if attempt < 2:
            await asyncio.sleep(0.35 * (attempt + 1))

    if not isinstance(track, dict):
        return

    trans = (track.get("media") or {}).get("transcodings") or []
    authorization = str(track.get("track_authorization") or "").strip()
    resolve_params = sc_params()
    if authorization:
        resolve_params["track_authorization"] = authorization
    if not trans:
        print(f"[SOUNDCLOUD RESOLVE] {sc_id}: track metadata has no transcodings")
        return

    def mime_of(item):
        return str((item.get("format") or {}).get("mime_type") or "").lower()

    progressive = [x for x in trans if (x.get("format") or {}).get("protocol") == "progressive"]
    def progressive_priority(item):
        mime = mime_of(item)
        if "audio/mpeg" in mime or "audio/mp3" in mime:
            return 0
        if "audio/mp4" in mime or "audio/aac" in mime:
            return 1
        if "audio/ogg" in mime or "opus" in mime:
            return 3
        return 2

    progressive.sort(key=progressive_priority)
    # Try every compatible progressive transcoding, not just the first one.
    for item in progressive:
        mime = mime_of(item)
        if "audio/ogg" in mime or "opus" in mime:
            continue
        endpoint = item.get("url")
        if not endpoint:
            continue
        for attempt in range(2):
            try:
                resolved = await cli.get(endpoint, params=resolve_params)
                if resolved.status_code == 200:
                    direct_url = (resolved.json() or {}).get("url")
                    if direct_url:
                        _sc_resolve_cache[sc_id] = {
                            "type": "direct",
                            "url": direct_url,
                            "mime": mime or "audio/mpeg",
                        }
                        return
                if resolved.status_code not in (408, 425, 429) and resolved.status_code < 500:
                    break
            except (httpx.HTTPError, ValueError, KeyError) as exc:
                print(f"[SOUNDCLOUD RESOLVE] {sc_id}: progressive attempt failed: {exc}")
            if attempt == 0:
                await asyncio.sleep(0.25)

    # HLS is the compatibility fallback for Safari/iOS and tracks without
    # a usable progressive stream. Keep the playlist intact; never fake an MP4.
    hls = [x for x in trans if (x.get("format") or {}).get("protocol") == "hls"]
    for item in hls:
        endpoint = item.get("url")
        if not endpoint:
            continue
        for attempt in range(2):
            try:
                resolved = await cli.get(endpoint, params=resolve_params)
                if resolved.status_code != 200:
                    if resolved.status_code not in (408, 425, 429) and resolved.status_code < 500:
                        break
                    if attempt == 0:
                        await asyncio.sleep(0.25)
                    continue
                loc = (resolved.json() or {}).get("url")
                if not loc:
                    break
                manifest = await cli.get(
                    loc,
                    headers={"Accept": "application/vnd.apple.mpegurl,application/x-mpegURL,*/*"},
                    timeout=httpx.Timeout(connect=8.0, read=25.0, write=10.0, pool=8.0),
                )
                manifest.raise_for_status()
                if manifest.text.lstrip("\\ufeff\\n\\r ").startswith("#EXTM3U"):
                    _sc_resolve_cache[sc_id] = {"type": "hls", "url": str(manifest.url)}
                    return
                print(f"[SOUNDCLOUD RESOLVE] {sc_id}: HLS response is not a playlist")
                break
            except (httpx.HTTPError, ValueError, KeyError) as exc:
                print(f"[SOUNDCLOUD RESOLVE] {sc_id}: HLS attempt {attempt + 1} failed: {type(exc).__name__}: {exc}")
                if attempt == 0:
                    await asyncio.sleep(0.25)

    print(f"[SOUNDCLOUD RESOLVE] {sc_id}: no usable progressive or HLS transcoding (count={len(trans)})")

async def prewarm_sc(sc_id):
    """Coalesce simultaneous requests so background warm-up and Play share one resolve."""
    sc_id = str(sc_id)
    if sc_id in _sc_resolve_cache:
        return
    task = _sc_resolve_inflight.get(sc_id)
    if task is None:
        task = asyncio.create_task(_prewarm_sc_impl(sc_id))
        _sc_resolve_inflight[sc_id] = task
    try:
        await task
    finally:
        if _sc_resolve_inflight.get(sc_id) is task:
            _sc_resolve_inflight.pop(sc_id, None)

async def _proxy_audio_url(url: str, request: Request, default_type: str = "audio/mpeg"):
    cli = get_http()
    if request.method == "OPTIONS":
        return Response(status_code=204, headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "Range, Content-Type",
        })

    headers = {"Accept": "audio/*,*/*;q=0.8", "Accept-Encoding": "identity"}
    range_header = request.headers.get("range")
    if range_header:
        headers["Range"] = range_header
    method = "HEAD" if request.method == "HEAD" else "GET"
    try:
        timeout = httpx.Timeout(connect=10.0, read=45.0, write=15.0, pool=10.0)
        upstream = await cli.send(
            cli.build_request(method, url, headers=headers, timeout=timeout),
            stream=(method != "HEAD"),
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Audio upstream error: {exc}")

    if upstream.status_code >= 400:
        status = upstream.status_code
        await upstream.aclose()
        raise HTTPException(status_code=502, detail=f"Audio provider returned HTTP {status}")

    content_type = (upstream.headers.get("content-type") or "").split(";")[0].strip().lower()
    content_type = {
        "audio/mp3": "audio/mpeg",
        "audio/x-mpeg": "audio/mpeg",
        "audio/mpeg3": "audio/mpeg",
        "audio/x-m4a": "audio/mp4",
        "application/mp4": "audio/mp4",
    }.get(content_type, content_type)
    path = urlparse(url).path.lower()
    if not content_type or content_type in ("application/octet-stream", "binary/octet-stream"):
        if path.endswith((".m4a", ".mp4")):
            content_type = "audio/mp4"
        elif path.endswith(".aac"):
            content_type = "audio/aac"
        elif path.endswith(".ogg") or path.endswith(".opus"):
            content_type = "audio/ogg"
        elif path.endswith(".wav"):
            content_type = "audio/wav"
        else:
            content_type = default_type
    if content_type in ("text/html", "text/plain", "application/json"):
        await upstream.aclose()
        raise HTTPException(status_code=502, detail="Audio provider returned a non-audio response")

    out_headers = {
        "Content-Type": content_type,
        "Accept-Ranges": upstream.headers.get("accept-ranges", "bytes"),
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
        "Cache-Control": "no-store",
    }
    for name in ("Content-Length", "Content-Range", "Last-Modified", "ETag"):
        value = upstream.headers.get(name)
        # aiter_bytes() transparently decompresses; do not forward a compressed length.
        if value and not (name == "Content-Length" and upstream.headers.get("content-encoding", "identity").lower() not in ("", "identity")):
            out_headers[name] = value
    status_code = upstream.status_code
    if method == "HEAD":
        await upstream.aclose()
        return Response(status_code=status_code, headers=out_headers)

    async def body():
        try:
            async for chunk in upstream.aiter_bytes(64 * 1024):
                if chunk:
                    yield chunk
        finally:
            await upstream.aclose()
    return StreamingResponse(body(), status_code=status_code, headers=out_headers)


@app.api_route("/api/sc/{sc_id}", methods=["GET", "HEAD", "OPTIONS"])
async def soundcloud_audio(sc_id: str, request: Request):
    if not ENABLE_SOUNDCLOUD:
        raise HTTPException(status_code=503, detail="SoundCloud disabled")
    if request.method == "OPTIONS":
        return Response(status_code=204, headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "Range, Content-Type",
        })
    if sc_id not in _sc_resolve_cache:
        await prewarm_sc(sc_id)
    cached = _sc_resolve_cache.get(sc_id)
    if not cached:
        raise HTTPException(status_code=415, detail="SoundCloud did not provide a browser-compatible audio stream")
    if cached["type"] == "direct":
        return await _proxy_audio_url(cached["url"], request, cached.get("mime", "audio/mpeg").split(";")[0])
    if cached["type"] == "hls":
        return await _serve_hls_manifest(cached["url"])
    raise HTTPException(status_code=415, detail="Unsupported SoundCloud stream format")

@app.get("/api/sc/resolve/{sc_id}")
async def soundcloud_resolve(sc_id: str, refresh: bool = False):
    """Resolve SoundCloud before Play; refresh retries a stale/transient HLS URL."""
    if not ENABLE_SOUNDCLOUD:
        raise HTTPException(status_code=503, detail="SoundCloud disabled")
    if refresh:
        old_task = _sc_resolve_inflight.get(str(sc_id))
        if old_task is not None:
            try: await old_task
            except Exception: pass
        _sc_resolve_cache.pop(str(sc_id), None)
    if sc_id not in _sc_resolve_cache:
        await prewarm_sc(sc_id)
    cached = _sc_resolve_cache.get(sc_id)
    if not cached:
        raise HTTPException(status_code=415, detail="No compatible SoundCloud stream")
    if cached["type"] == "direct":
        return {"type": "direct", "url": "/api/sc/" + sc_id}
    return {"type": "hls", "url": "/api/hls/" + sign(cached["url"])}

async def _serve_hls_manifest(url: str):
    """Fetch an HLS playlist and rewrite every playlist/key/map/segment URL through this API."""
    try:
        timeout = httpx.Timeout(connect=10.0, read=35.0, write=15.0, pool=10.0)
        response = await get_http().get(url, headers={"Accept-Encoding": "identity"}, timeout=timeout)
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"HLS manifest fetch failed: {type(exc).__name__}: {exc}")

    body = response.text.lstrip("\ufeff\n\r ")
    if not body.startswith("#EXTM3U"):
        content_type = response.headers.get("content-type", "unknown")
        raise HTTPException(status_code=502, detail=f"Invalid HLS manifest (content-type: {content_type})")

    base = str(response.url)
    output = []

    def proxy_uri(raw: str) -> str:
        target = urljoin(base, raw.strip())
        parsed = urlparse(target)
        if parsed.scheme not in ("http", "https"):
            raise HTTPException(status_code=502, detail="Unsupported HLS resource URL")
        path = (parsed.path or "").lower()
        # A playlist URI may have auth query parameters, so inspect only the path.
        if path.endswith((".m3u8", ".m3u")):
            return "/api/hls/" + sign(target)
        return "/api/stream/" + sign(target)

    uri_attr = re.compile(r'URI=("|\')(.*?)\1', re.IGNORECASE)
    for raw_line in body.splitlines():
        stripped = raw_line.strip()
        if not stripped:
            output.append("")
        elif stripped.startswith("#"):
            # Covers EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, SESSION-KEY, etc.
            output.append(uri_attr.sub(lambda m: "URI=" + m.group(1) + proxy_uri(m.group(2)) + m.group(1), raw_line))
        else:
            output.append(proxy_uri(stripped))

    return Response(
        "\n".join(output) + "\n",
        media_type="application/vnd.apple.mpegurl",
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "Range, Content-Type",
            "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )

@app.api_route("/api/hls/{token}", methods=["GET", "HEAD", "OPTIONS"])
async def hls_proxy(token: str, request: Request):
    if request.method == "OPTIONS":
        return Response(status_code=204, headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "Range, Content-Type",
        })
    url = unsign(token)
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    # SoundCloud now serves HLS from playback.media-streaming.soundcloud.cloud.
    allowed = ("sndcdn.com", "soundcloud.com", "scdn.co", "soundcloud.cloud")
    if parsed.scheme != "https" or not any(host == suffix or host.endswith("." + suffix) for suffix in allowed):
        raise HTTPException(status_code=403, detail="HLS host is not allowed")
    return await _serve_hls_manifest(url)

_ym_client = None
def get_ym():
    global _ym_client
    if _ym_client is None:
        try:
            from yandex_music import Client
            _ym_client = Client(YM_TOKEN) if YM_TOKEN else Client(); _ym_client.init()
        except Exception: return None
    return _ym_client

def yandex_search_sync(query: str, limit: int) -> list:
    client = get_ym()
    if not client: return []
    res = client.search(query)
    if not res or not res.tracks: return []
    out, full = [], bool(YM_TOKEN)
    for t in res.tracks.results[:limit]:
        artist = t.artists[0].name if t.artists else "Неизвестен"
        cover = "https://" + t.cover_uri.replace("%%", "400x400") if t.cover_uri else ""
        out.append({"ext_id": str(t.id), "title": norm(t.title or "Без названия"), "artist": artist, "duration": (t.duration_ms or 0) // 1000, "cover": cover, "audio_url": None, "ym_id": str(t.id), "source": "yandex", "full": full})
    return out

async def yandex_search(query: str, limit: int) -> list:
    if not ENABLE_YANDEX: return []
    try:
        res = await asyncio.to_thread(yandex_search_sync, query, limit + 10)
        return rank(res, query)[:limit]
    except Exception: return []

def _ym_resolve_link(ym_id: str) -> Optional[str]:
    client = get_ym()
    if not client: return None
    tracks = client.tracks([ym_id])
    if not tracks: return None
    info = tracks[0].get_download_info()
    if not info: return None
    # Prefer MP3 for maximum compatibility with mobile WebViews.
    mp3 = [x for x in info if str(getattr(x, "codec", "")).lower() == "mp3"]
    aac = [x for x in info if str(getattr(x, "codec", "")).lower() in ("aac", "m4a")]
    candidates = mp3 or aac or info
    candidates = sorted(candidates, key=lambda x: x.bitrate_in_kbps or 0, reverse=True)
    return candidates[0].get_direct_link()

async def prewarm_ym(ym_id: str):
    """Заранее резолвит прямую ссылку Яндекс.Музыки, чтобы play стартовал мгновенно."""
    if not ym_id or _cache_get(_ym_link_cache, ym_id): return
    try:
        link = await asyncio.to_thread(_ym_resolve_link, ym_id)
        if link: _cache_put(_ym_link_cache, ym_id, link)
    except Exception: pass

# ==========================================
# ЭНДПОИНТЫ ПОИСКА (С КЕШЕМ)
# ==========================================
@app.get("/api/search")
async def search(q: Optional[str] = Query(None), query: Optional[str] = Query(None), limit: int = Query(30, ge=1, le=100)):
    try:
        term = norm(q or query or "")
        if not term: return {"tracks": []}
        
        cache_key = f"{term}_{limit}"
        cached = _cache_get(_search_cache, cache_key)
        if cached is not None:
            return cached

        tasks = []
        if ENABLE_MUZOFOND: tasks.append(asyncio.create_task(muzofond_search(term, limit)))
        if ENABLE_YANDEX: tasks.append(asyncio.create_task(yandex_search(term, limit)))
        if ENABLE_SOUNDCLOUD: tasks.append(asyncio.create_task(soundcloud_search(term, limit)))

        if not tasks: return {"tracks": []}

        merged, seen = [], set()

        def _usable(t):
            return t.get("full") is not False and t.get("source") not in ("itunes", "deezer")

        def _collect(chunk):
            # Фильтруем сразу: ранний выход должен опираться только на
            # треки, которые реально дойдут до пользователя.
            for task in chunk:
                try:
                    if task.cancelled(): continue
                    res = task.result()
                    if not res: continue
                    for t in res:
                        if not _usable(t): continue
                        key = (str(t.get("artist") or "").lower(), str(t.get("title") or "").lower())
                        if key in seen: continue
                        seen.add(key); merged.append(t)
                except BaseException: continue

        # Отдаём результат сразу, как только есть что показать.
        # Медленные источники (Yandex 2-4с) догоняют в фоне и дополняют кеш.
        start = time.monotonic()
        soft_deadline = start + 1.6   # уже есть что показать — не ждём медленных
        hard_deadline = start + 5.0   # пустой результат ждём дольше, чтобы не показывать ложное «не найдено»
        pending = set(tasks)
        while pending and len(merged) < limit:
            now = time.monotonic()
            if len(merged) >= 6 and (now - start) >= 0.4: break   # быстрый ответ
            ceiling = soft_deadline if merged else hard_deadline
            if now >= ceiling: break
            done, pending = await asyncio.wait(pending, timeout=ceiling - now, return_when=asyncio.FIRST_COMPLETED)
            _collect(done)
        leftovers = set(pending)   # НЕ отменяем — их дособерёт _finish_search

        merged = rank(merged, term)[:limit]
        result_tracks = [pack(t) for t in merged]
        response_data = {"tracks": result_tracks}

        # Пустой результат не кешируем, чтобы повторный поиск не залипал в "ничего не найдено"
        if result_tracks:
            _cache_put(_search_cache, cache_key, response_data)

        # Фоновое уточнение: дособираем медленные источники и обновим кеш,
        # чтобы повторный запрос того же трека вернул полный список.
        if leftovers:
            asyncio.create_task(_finish_search(cache_key, leftovers, merged, seen, term, limit))

        # Заранее резолвим ссылки, чтобы воспроизведение стартовало мгновенно
        for t in merged:
            if t.get("source") == "soundcloud" and t.get("ext_id"):
                asyncio.create_task(prewarm_sc(t["ext_id"]))
            elif t.get("source") == "yandex" and t.get("ym_id"):
                asyncio.create_task(prewarm_ym(t["ym_id"]))

        return response_data
    except Exception: return {"tracks": []}


async def _finish_search(cache_key, pending, merged, seen, term, limit):
    """Дособирает источники, которые не успели, и дополняет кеш."""
    if not pending: return
    try:
        done, pending = await asyncio.wait(pending, timeout=3.0)
        for task in done:
            try:
                if task.cancelled(): continue
                res = task.result()
                if not res: continue
                for t in res:
                    if t.get("full") is False or t.get("source") in ("itunes", "deezer"): continue
                    key = (str(t.get("artist") or "").lower(), str(t.get("title") or "").lower())
                    if key in seen: continue
                    seen.add(key); merged.append(t)
            except BaseException: continue
        for task in pending: task.cancel()
        full = rank(merged, term)[:limit]
        packed = []
        for t in full:
            try: packed.append(pack(t))
            except Exception: continue
        if not packed: return
        _cache_put(_search_cache, cache_key, {"tracks": packed})
        for t in full:
            try:
                if t.get("source") == "soundcloud" and t.get("ext_id"):
                    asyncio.create_task(prewarm_sc(t["ext_id"]))
                elif t.get("source") == "yandex" and t.get("ym_id"):
                    asyncio.create_task(prewarm_ym(t["ym_id"]))
            except Exception: continue
    except BaseException: pass

# ==========================================
# ПОЛНЫЙ ТРЕК ПО НАЗВАНИЮ (ДЛЯ ПЕСЕН ИЗ ITUNES-АЛЬБОМОВ)
# ==========================================
_track_resolve_cache = {}

def _match_text(value: str) -> str:
    value = norm(value).lower()
    value = re.sub(r"\([^)]*(?:remaster|deluxe|bonus|explicit|clean)[^)]*\)", " ", value, flags=re.I)
    return re.sub(r"[^\w\s]", " ", value, flags=re.U)

@app.get("/api/track/resolve")
async def resolve_full_track(title: str = Query(...), artist: str = Query(""), duration: int = Query(0, ge=0)):
    title, artist = norm(title), norm(artist)
    if not title:
        raise HTTPException(status_code=400, detail="Track title is required")
    cache_key = (_match_text(title), _match_text(artist))
    cached = _cache_get(_track_resolve_cache, cache_key)
    if cached is not None:
        return cached

    query = (artist + " " + title).strip()
    tasks = []
    if ENABLE_MUZOFOND: tasks.append(asyncio.create_task(muzofond_search(query, 15)))
    if ENABLE_YANDEX: tasks.append(asyncio.create_task(yandex_search(query, 15)))
    if ENABLE_SOUNDCLOUD: tasks.append(asyncio.create_task(soundcloud_search(query, 15)))
    if not tasks:
        raise HTTPException(status_code=404, detail="No full-track sources enabled")

    results = await asyncio.gather(*tasks, return_exceptions=True)
    wanted_title = _match_text(title)
    wanted_artist = _match_text(artist)
    candidates = []
    for group in results:
        if isinstance(group, Exception) or not group:
            continue
        for item in group:
            if item.get("full") is False or item.get("source") in ("itunes", "deezer"):
                continue
            if not (item.get("audio_url") or item.get("ym_id") or (item.get("source") == "soundcloud" and item.get("ext_id"))):
                continue
            got_title = _match_text(item.get("title", ""))
            title_score = difflib.SequenceMatcher(None, wanted_title, got_title).ratio()
            got_artist = _match_text(item.get("artist", ""))
            artist_score = difflib.SequenceMatcher(None, wanted_artist, got_artist).ratio() if wanted_artist else 1.0
            got_duration = int(item.get("duration") or 0)
            duration_ok = not duration or not got_duration or abs(duration - got_duration) <= max(20, int(duration * 0.12))
            # Reject different songs and obvious remix/cover matches.
            if title_score < 0.84 or not duration_ok:
                continue
            if wanted_artist and artist_score < 0.35 and title_score < 0.96:
                continue
            score = title_score * 0.78 + artist_score * 0.17 + (0.05 if duration_ok else 0)
            candidates.append((score, item))

    if not candidates:
        raise HTTPException(status_code=404, detail="Full version not found for this album track")
    candidates.sort(key=lambda pair: pair[0], reverse=True)
    packed = pack(candidates[0][1])
    if not packed.get("preview"):
        raise HTTPException(status_code=404, detail="Full audio stream is unavailable")
    _cache_put(_track_resolve_cache, cache_key, packed)
    chosen = candidates[0][1]
    if chosen.get("source") == "soundcloud":
        asyncio.create_task(prewarm_sc(chosen.get("ext_id")))
    elif chosen.get("source") == "yandex":
        asyncio.create_task(prewarm_ym(chosen.get("ym_id")))
    return packed

# ==========================================
# АЛЬБОМЫ (С КЕШЕМ)
# ==========================================
@app.get("/api/search/albums")
async def search_albums(q: Optional[str] = Query(None), query: Optional[str] = Query(None), limit: int = Query(30, ge=1, le=50)):
    term = norm(q or query or "")
    if not term: return {"albums": []}
    try:
        cache_key = f"{term}_{limit}"
        cached = _cache_get(_album_search_cache, cache_key)
        if cached is not None: return cached
        r = await get_http().get(ITUNES_API + "/search", params={"term": term, "entity": "album", "limit": limit})
        if r.status_code != 200: return {"albums": []}
        data = r.json()
        albums = []
        for album in data.get("results", []):
            cover = album.get("artworkUrl100", "").replace("100x100bb", "600x600bb")
            albums.append({
                "id": str(album.get("collectionId", "")), "title": album.get("collectionName", ""),
                "artist": album.get("artistName", "Неизвестен"), "cover": cover,
                "track_count": album.get("trackCount", 0), "release_date": (album.get("releaseDate") or "")[:10], "source": "itunes",
            })
        resp = {"albums": albums}
        _cache_put(_album_search_cache, cache_key, resp)
        return resp
    except Exception: return {"albums": []}

@app.get("/api/itunes/album/{album_id}")
async def get_album(album_id: str):
    if not album_id.isdigit(): raise HTTPException(status_code=400, detail="Invalid ID")
    
    cached = _cache_get(_album_cache, album_id)
    if cached is not None:
        return cached

    try:
        r = await get_http().get(ITUNES_API + "/lookup", params={"id": album_id, "entity": "song"})
        data = r.json().get("results", [])
        if not data: raise HTTPException(status_code=404, detail="Not found")
        album_info = data[0]
        tracks = []
        for t in data[1:]:
            cover = t.get("artworkUrl100", "").replace("100x100bb", "600x600bb")
            tracks.append({
                "id": str(t.get("trackId", "")), "title": t.get("trackName", ""), "artist": t.get("artistName", "Неизвестен"),
                "duration": (t.get("trackTimeMillis") or 0) // 1000, "dur": fmt_duration((t.get("trackTimeMillis") or 0) // 1000),
                "cover": cover, "preview": t.get("previewUrl", ""), "preview_url": t.get("previewUrl", ""), "stream_url": t.get("previewUrl", ""),
                "source": "itunes", "full": False,
            })
        result = {"album": {"id": str(album_info.get("collectionId", "")), "title": album_info.get("collectionName", ""), "artist": album_info.get("artistName", ""), "cover": album_info.get("artworkUrl100", "").replace("100x100bb", "600x600bb")}, "tracks": tracks}
        
        _cache_put(_album_cache, album_id, result)
        return result
    except Exception: raise HTTPException(status_code=502, detail="Error")

@app.get("/api/track-cover")
async def get_track_cover(title: str = Query(...), artist: str = Query("")):
    title, artist = norm(title), norm(artist)
    if not title: return {"cover": ""}
    search_query = f"{artist} {title}".strip()
    try:
        r = await get_http().get(ITUNES_API + "/search", params={"term": search_query, "entity": "song", "limit": 1})
        if r.status_code == 200:
            tracks = r.json().get("results", [])
            if tracks:
                cover_url = tracks[0].get("artworkUrl100", "").replace("100x100bb", "600x600bb")
                if cover_url: return {"cover": cover_url}
    except Exception: pass
    return {"cover": ""}

@app.api_route("/api/stream/{token}", methods=["GET", "HEAD", "OPTIONS"])
async def stream(token: str, request: Request):
    return await _proxy_audio_url(unsign(token), request, "audio/mpeg")

@app.api_route("/api/audio/{ym_id}", methods=["GET", "HEAD", "OPTIONS"])
async def yandex_audio(ym_id: str, request: Request):
    link = _cache_get(_ym_link_cache, ym_id)
    if not link:
        try:
            link = await asyncio.to_thread(_ym_resolve_link, ym_id)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Yandex link resolve failed: {e}")
        if not link:
            raise HTTPException(status_code=404, detail="Yandex audio link is unavailable")
        _cache_put(_ym_link_cache, ym_id, link)
    return await _proxy_audio_url(link, request, "audio/mpeg")

@app.api_route("/api/cover/{token}", methods=["GET", "OPTIONS"])
async def cover(token: str):
    url = unsign(token)
    try: r = await get_http().get(url)
    except Exception: raise HTTPException(status_code=502, detail="Cover fetch failed")
    if r.status_code != 200: raise HTTPException(status_code=502, detail="Cover upstream error")
    return Response(content=r.content, media_type=r.headers.get("content-type", "image/jpeg"), headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400"})

app.mount("/", StaticFiles(directory=".", html=True), name="static")
