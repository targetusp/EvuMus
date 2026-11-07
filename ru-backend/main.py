import os
import re
import html
import hmac
import hashlib
import base64
import time
import asyncio
import collections
from typing import Optional
from urllib.parse import urljoin

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse

load_dotenv()

PORT = int(os.getenv("PORT", "8001"))
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "*").split(",")
PROXY_SECRET = os.getenv("PROXY_SECRET", "evu-music-proxy-secret").encode()

ENABLE_MUZOFOND = os.getenv("MUZOFOND", "1") == "1"
ENABLE_YANDEX = os.getenv("YANDEX", "1") == "1"
YM_TOKEN = os.getenv("YM_TOKEN", "").strip()

DEFAULT_SC_CLIENT_ID = "nIjtjiYnjkOhMyh5xrbqEW12DxeJVnic"
SC_CLIENT_ID = (os.getenv("SC_CLIENT_ID", "") or DEFAULT_SC_CLIENT_ID).strip()
ENABLE_SOUNDCLOUD = os.getenv("SOUNDCLOUD", "1") == "1"
SC_API = "https://api-v2.soundcloud.com"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

app = FastAPI(title="EvuMusic RU Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Length", "Content-Range", "Accept-Ranges", "Content-Type"],
)

_http: Optional[httpx.AsyncClient] = None


def get_http() -> httpx.AsyncClient:
    global _http
    if _http is None:
        _http = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=10.0),
            follow_redirects=True,
            headers={"User-Agent": USER_AGENT, "Accept-Language": "ru-RU,ru;q=0.9"},
        )
    return _http


@app.on_event("shutdown")
async def _shutdown():
    if _http is not None:
        await _http.aclose()


# --- Подписанные ссылки на прокси ---
def sign(url: str) -> str:
    blob = base64.urlsafe_b64encode(url.encode("utf-8")).decode().rstrip("=")
    sig = hmac.new(PROXY_SECRET, blob.encode("ascii"), hashlib.sha256).hexdigest()[:16]
    return blob + "." + sig


def unsign(token: str) -> str:
    blob, _, sig = token.rpartition(".")
    if not blob or not sig:
        raise HTTPException(status_code=400, detail="Bad token")
    expect = hmac.new(PROXY_SECRET, blob.encode("ascii"), hashlib.sha256).hexdigest()[:16]
    if not hmac.compare_digest(sig, expect):
        raise HTTPException(status_code=403, detail="Bad signature")
    pad = "=" * (-len(blob) % 4)
    try:
        return base64.urlsafe_b64decode(blob + pad).decode("utf-8")
    except Exception:
        raise HTTPException(status_code=400, detail="Bad payload")


# --- Общие форматы ---
def fmt_duration(seconds: int) -> str:
    seconds = int(seconds or 0)
    return "%d:%02d" % (seconds // 60, seconds % 60)


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


# --- Muzofond ---
_ITEM_SPLIT = re.compile(r'<li class="item" ')
_DL_RE = re.compile(r'class="play" data-id="\d+" data-url="(https://dl[^"]+)"')
_ARTIST_RE = re.compile(r'<span class="artist">(.*?)</span>', re.S)
_TRACK_RE = re.compile(r'<span class="track">(.*?)</span>', re.S)
_IMG_RE = re.compile(r'data-img="([^"]+)"')


def _strip_tags(s: str) -> str:
    return norm(html.unescape(re.sub(r"<[^>]+>", "", s or "")))


def parse_muzofond(html_text: str) -> list:
    out = []
    by_url = {}
    for body in _ITEM_SPLIT.split(html_text)[1:]:
        idm = re.match(r'data-id="(\d+)"', body)
        dm = re.search(r'data-duration="(\d+)"', body)
        urlm = _DL_RE.search(body)
        if not (idm and urlm):
            continue
        tm = _TRACK_RE.search(body)
        am = _ARTIST_RE.search(body)
        title = _strip_tags(tm.group(1)) if tm else ""
        artist = _strip_tags(am.group(1)) if am else ""
        if not title:
            continue
        img = _IMG_RE.search(body)
        cover = ""
        if img and img.group(1).startswith("/"):
            cover = "https://muzofond.fm" + img.group(1)
        elif img:
            cover = img.group(1)
        item = {
            "ext_id": idm.group(1),
            "title": title,
            "artist": artist or "Неизвестен",
            "duration": int(dm.group(1)) if dm else 0,
            "cover": cover,
            "audio_url": urlm.group(1),
            "source": "muzofond",
        }
        prev = by_url.get(item["audio_url"])
        if prev is None:
            by_url[item["audio_url"]] = item
        elif len(item["title"]) < len(prev["title"]):
            by_url[item["audio_url"]] = item
    return list(by_url.values())


async def muzofond_fetch(url: str) -> list:
    try:
        r = await get_http().get(url)
        if r.status_code != 200:
            print(f"[MUZOFOND ERROR] HTTP {r.status_code} (Возможно, бан по IP)")
            return []
        return parse_muzofond(r.text)
    except Exception as e:
        print(f"[MUZOFOND EXCEPTION] {e}")
        return []


async def muzofond_search(query: str, limit: int) -> list:
    params_a = httpx.QueryParams({"q": query, "artist": "0"})
    params_b = httpx.QueryParams({"q": query, "artist": "1"})
    results = await asyncio.gather(
        muzofond_fetch("https://muzofond.fm/music?" + str(params_a)),
        muzofond_fetch("https://muzofond.fm/music?" + str(params_b)),
        return_exceptions=True,
    )
    merged = []
    by_url = {}
    for res in results:
        if isinstance(res, Exception) or not res:
            continue
        for t in res:
            key = t["audio_url"]
            prev = by_url.get(key)
            if prev is None:
                by_url[key] = t
                merged.append(t)
            elif len(t["title"]) < len(prev["title"]):
                prev.update(t)
    return rank(merged, query)[:limit]


# ---------------------------------------------------------------------------
# SoundCloud — полные треки
# ---------------------------------------------------------------------------

def sc_params(**extra):
    p = {"client_id": SC_CLIENT_ID}
    p.update(extra)
    return p


async def soundcloud_search(query: str, limit: int) -> list:
    if not ENABLE_SOUNDCLOUD:
        return []
    try:
        r = await get_http().get(
            SC_API + "/search/tracks",
            params=sc_params(q=query, limit=min(limit, 50)),
        )
        if r.status_code != 200:
            return []
        out = []
        for t in r.json().get("collection", [])[:limit]:
            if not t:
                continue
            out.append({
                "ext_id": str(t["id"]),
                "title": norm(t.get("title") or "Без названия"),
                "artist": norm((t.get("user") or {}).get("username") or "Неизвестен"),
                "duration": int((t.get("duration") or 0) / 1000),
                "cover": "",
                "source": "soundcloud",
                "full": True,
            })
        return out
    except Exception as e:
        print("[SC search error]", type(e).__name__, e)
        return []


_sc_cache: collections.OrderedDict = collections.OrderedDict()
SC_CACHE_SIZE = 10


async def soundcloud_stream_bytes(sc_id: str) -> bytes:
    """Резолвит HLS AAC-плейлист и склеивает сегменты в цельный MP4."""
    if sc_id in _sc_cache:
        _sc_cache.move_to_end(sc_id)
        return _sc_cache[sc_id]

    cli = get_http()
    r = await cli.get(SC_API + "/tracks/" + sc_id, params=sc_params())
    if r.status_code != 200:
        raise HTTPException(status_code=404, detail="SoundCloud track not found")

    t = r.json()
    trans = (t.get("media") or {}).get("transcodings") or []
    frag = [x for x in trans if "aac_160k" in (x.get("preset") or "")] or [
        x for x in trans if x.get("format", {}).get("protocol") == "hls"
    ]
    if not frag:
        raise HTTPException(status_code=502, detail="No HLS stream for this track")

    loc = None
    for x in frag:
        rl = await cli.get(x["url"], params=sc_params())
        if rl.status_code == 200:
            loc = (rl.json() or {}).get("url")
            if loc:
                break
    if not loc:
        raise HTTPException(status_code=502, detail="Playlist resolve failed")

    pl = await cli.get(loc)
    if pl.status_code != 200:
        raise HTTPException(status_code=502, detail="Playlist fetch failed")

    text = pl.text
    init_m = re.search(r'#EXT-X-MAP:URI="([^"]+)"', text)
    segs = [ln.strip() for ln in text.splitlines() if ln and not ln.startswith("#")]
    if not segs:
        raise HTTPException(status_code=502, detail="Empty playlist")

    blob = bytearray()
    if init_m:
        ri = await cli.get(urljoin(loc, init_m.group(1)))
        if ri.status_code == 200:
            blob += ri.content

    for s in segs:
        rs = await cli.get(urljoin(loc, s))
        if rs.status_code != 200:
            break
        blob += rs.content

    data = bytes(blob)
    if len(data) < 2048:
        raise HTTPException(status_code=502, detail="Stream assemble failed")

    _sc_cache[sc_id] = data
    while len(_sc_cache) > SC_CACHE_SIZE:
        _sc_cache.popitem(last=False)
    return data


# --- Яндекс Музыка ---
_ym_client = None


def get_ym():
    global _ym_client
    if _ym_client is None:
        try:
            from yandex_music import Client
            if YM_TOKEN:
                _ym_client = Client(YM_TOKEN)
            else:
                _ym_client = Client()
            _ym_client.init()
        except Exception as e:
            print(f"[YANDEX INIT ERROR] {e}")
            _ym_client = False
    return _ym_client if _ym_client else None


def yandex_search_sync(query: str, limit: int) -> list:
    client = get_ym()
    if not client:
        return []

    result = client.search(query, type_="track")
    tracks = getattr(getattr(result, "tracks", None), "results", None) or []
    out = []

    for t in tracks[:limit]:
        artists = getattr(t, "artists", None) or []
        artist = ", ".join(
            getattr(a, "name", "") for a in artists if getattr(a, "name", "")
        ) or "Неизвестен"

        cover = ""
        if getattr(t, "cover_uri", None):
            cover = "https://" + t.cover_uri.replace("%%", "400x400")

        out.append({
            "ext_id": str(t.id),
            "title": norm(getattr(t, "title", None) or "Без названия"),
            "artist": artist,
            "duration": (getattr(t, "duration_ms", None) or 0) // 1000,
            "cover": cover,
            "audio_url": None,
            "ym_id": str(t.id),
            "source": "yandex",
            "full": True,
        })
    return out


async def yandex_search(query: str, limit: int) -> list:
    if not ENABLE_YANDEX:
        return []
    try:
        res = await asyncio.to_thread(yandex_search_sync, query, limit + 10)
        return rank(res, query)[:limit]
    except Exception as e:
        print(f"[YANDEX SEARCH ERROR] {e}")
        return []


# --- Ранжирование ---
def rank(tracks: list, query: str) -> list:
    words = [w for w in re.split(r"\W+", (query or "").lower(), flags=re.U) if len(w) > 1]
    q = (query or "").lower().strip()

    junk_re = re.compile(
        r"(cover|кавер|кувер|remix|ремикс|remake|караоке|karaoke|instrumental|инструментал|"
        r"мини-?атюра|миниат|припев|ringtone|рингтон|reaction|реакция|live at|bootleg|"
        r"\bминус(овка)?\b|\(live\b|\blive\)|radio ?edit)",
        re.I,
    )

    def score(t):
        title = t.get("title", "").lower()
        artist = t.get("artist", "").lower()
        hay = title + " " + artist
        s = sum(2 for w in words if w in hay)
        if words and all(w in title for w in words):
            s += 10
        if q and (title.startswith(q) or hay.startswith(q)):
            s += 8
        if q and (q == title or q + "?" == title):
            s += 15
        elif q and q in title:
            s += 4
        if q and junk_re.search(title) and not junk_re.search(q):
            s -= 12
        if t.get("full", True):
            s += 1
        if not t.get("duration"):
            s -= 3
        return -s

    tracks = [t for t in tracks if t.get("title")]
    tracks.sort(key=score)
    tracks.sort(key=lambda t: 0 if t.get("full", True) else 1)
    return tracks


def pack(t: dict) -> dict:
    full = t.get("full", True)

    if t.get("audio_url"):
        stream = "/api/stream/" + sign(t["audio_url"])
    elif t.get("source") == "yandex" and t.get("ym_id"):
        stream = "/api/audio/" + t["ym_id"]
    elif t.get("source") == "soundcloud" and t.get("ext_id"):
        stream = "/api/sc/" + t["ext_id"]
    else:
        stream = ""

    cover = t.get("cover") or ""
    if cover:
        cover = "/api/cover/" + sign(cover)

    return {
        "id": t["source"] + "_" + t["ext_id"],
        "title": t["title"],
        "artist": t["artist"],
        "duration": t.get("duration", 0),
        "dur": fmt_duration(t.get("duration", 0)),
        "cover": cover,
        "stream_url": stream,
        "preview_url": stream,
        "preview": stream,
        "full": full,
        "source": t["source"],
    }


# --- Эндпоинты ---
@app.get("/api/health")
async def health():
    return {
        "ok": True,
        "service": "EvuMusic RU Backend",
        "sources": {
            "muzofond": ENABLE_MUZOFOND,
            "yandex": ENABLE_YANDEX,
            "soundcloud": ENABLE_SOUNDCLOUD,
        },
    }


@app.get("/api/search")
async def search(
    q: Optional[str] = Query(None),
    query: Optional[str] = Query(None),
    limit: int = Query(30, ge=1, le=100),
):
    try:
        term = norm(q or query or "")
        if not term:
            return {"tracks": []}

        tasks = []
        if ENABLE_MUZOFOND:
            tasks.append(muzofond_search(term, limit))
        if ENABLE_YANDEX:
            tasks.append(yandex_search(term, limit))
        if ENABLE_SOUNDCLOUD:
            tasks.append(soundcloud_search(term, limit))

        if not tasks:
            return {"tracks": []}

        results = await asyncio.gather(*tasks, return_exceptions=True)
        merged, seen = [], set()

        for res in results:
            if isinstance(res, Exception):
                print(f"[GATHER ERROR] {res}")
                continue
            if not res:
                continue
            for t in res:
                artist = str(t.get("artist") or "").lower()
                title = str(t.get("title") or "").lower()
                key = (artist, title)
                if key in seen:
                    continue
                seen.add(key)
                merged.append(t)

        merged = rank(merged, term)[:limit]
        return {"tracks": [pack(t) for t in merged]}

    except Exception as e:
        import traceback
        print(f"[CRITICAL SEARCH ERROR] {e}")
        traceback.print_exc()
        return {"tracks": []}


@app.api_route("/api/stream/{token}", methods=["GET", "HEAD", "OPTIONS"])
async def stream(token: str, request: Request):
    url = unsign(token)
    headers = {}
    if request.headers.get("range"):
        headers["Range"] = request.headers["range"]

    try:
        req = get_http().build_request("GET", url, headers=headers)
        upstream = await get_http().send(req, stream=True)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Proxy error: {e}")

    out_headers = {
        "Content-Type": upstream.headers.get("content-type", "audio/mpeg"),
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
    }
    for h in ("Content-Length", "Content-Range"):
        if h in upstream.headers:
            out_headers[h] = upstream.headers[h]

    if upstream.status_code >= 400:
        await upstream.aclose()
        raise HTTPException(status_code=502, detail="Upstream error")

    if request.method == "HEAD":
        await upstream.aclose()
        return Response(status_code=upstream.status_code, headers=out_headers)

    async def gen():
        try:
            async for chunk in upstream.aiter_raw(65536):
                yield chunk
        finally:
            await upstream.aclose()

    return StreamingResponse(
        gen(),
        status_code=upstream.status_code,
        headers=out_headers,
    )


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

    try:
        data = await soundcloud_stream_bytes(sc_id)
    except HTTPException:
        raise
    except Exception as e:
        print("[SC stream error]", type(e).__name__, e)
        raise HTTPException(status_code=502, detail="SoundCloud stream is temporarily unavailable")

    total = len(data)
    headers = {
        "Content-Type": "audio/mp4",
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
        "Cache-Control": "no-store",
        "Content-Length": str(total),
    }
    if request.method == "HEAD":
        return Response(status_code=200, headers=headers)

    rng = request.headers.get("range")
    if rng and rng.startswith("bytes="):
        try:
            range_value = rng[6:].split(",", 1)[0].strip()
            start_s, end_s = range_value.split("-", 1)
            if not start_s:
                suffix = int(end_s)
                if suffix <= 0:
                    raise ValueError("invalid suffix range")
                start = max(0, total - suffix)
                end = total - 1
            else:
                start = int(start_s)
                end = int(end_s) if end_s else total - 1
            end = min(end, total - 1)
            if start < 0 or start >= total or end < start:
                return Response(status_code=416, headers={
                    "Content-Range": f"bytes */{total}",
                    "Accept-Ranges": "bytes",
                    "Access-Control-Allow-Origin": "*",
                })
            part = data[start:end + 1]
            range_headers = dict(headers)
            range_headers["Content-Range"] = f"bytes {start}-{end}/{total}"
            range_headers["Content-Length"] = str(len(part))
            return Response(content=part, status_code=206, headers=range_headers)
        except (ValueError, TypeError):
            pass

    return Response(content=data, status_code=200, headers=headers)


@app.api_route("/api/audio/{ym_id}", methods=["GET", "HEAD", "OPTIONS"])
async def yandex_audio(ym_id: str, request: Request):
    def resolve():
        client = get_ym()
        if not client:
            raise Exception("Yandex client not initialized")
        tracks = client.tracks([ym_id])
        if not tracks:
            raise Exception("Track not found")
        info = tracks[0].get_download_info()
        if not info:
            raise Exception("No download info")
        best = max(info, key=lambda x: x.bitrate_in_kbps or 0)
        return best.get_direct_link()

    try:
        link = await asyncio.to_thread(resolve)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

    headers = {}
    if request.headers.get("range"):
        headers["Range"] = request.headers["range"]

    req = get_http().build_request("GET", link, headers=headers)
    upstream = await get_http().send(req, stream=True)
    out_headers = {
        "Content-Type": "audio/mpeg",
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
    }
    for h in ("Content-Length", "Content-Range"):
        if h in upstream.headers:
            out_headers[h] = upstream.headers[h]

    if request.method == "HEAD":
        await upstream.aclose()
        return Response(status_code=upstream.status_code, headers=out_headers)

    async def gen():
        try:
            async for chunk in upstream.aiter_raw(65536):
                yield chunk
        finally:
            await upstream.aclose()

    return StreamingResponse(
        gen(),
        status_code=upstream.status_code,
        headers=out_headers,
    )


@app.api_route("/api/cover/{token}", methods=["GET", "OPTIONS"])
async def cover(token: str):
    url = unsign(token)
    try:
        r = await get_http().get(url)
    except Exception:
        raise HTTPException(status_code=502, detail="Cover fetch failed")

    if r.status_code != 200:
        raise HTTPException(status_code=502, detail="Cover upstream error")

    return Response(
        content=r.content,
        media_type=r.headers.get("content-type", "image/jpeg"),
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=86400",
        },
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=PORT)
