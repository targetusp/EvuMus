"""Синхронизация истории музыкального канала → боту (файлы попадают в Neon).

Как работает:
1) Твой аккаунт читает историю @MUSIC_CHANNEL
2) Каждый аудиофайл пересылается боту в ЛС
3) Бот (server/index.js) ловит audio и пишет file_id в channel_tracks

Запуск:
  pip install telethon python-dotenv
  python sync.py

.env:
  TG_API_ID=...
  TG_API_HASH=...
  TG_PHONE=+79...
  BOT_USERNAME=EvuMusicBot
  MUSIC_CHANNELS=yourplaylist,soundlippsing
"""
import os
import asyncio
from telethon import TelegramClient
from telethon.tl.types import MessageMediaDocument, DocumentAttributeAudio
from dotenv import load_dotenv

load_dotenv()

TG_API_ID = int(os.environ["TG_API_ID"])
TG_API_HASH = os.environ["TG_API_HASH"]
TG_PHONE = os.environ.get("TG_PHONE", "")
TG_SESSION = os.environ.get("TG_SESSION", "evumusic_sync")
BOT_USERNAME = os.environ["BOT_USERNAME"].lstrip("@")
MUSIC_CHANNELS = [ch.strip().lstrip("@") for ch in os.environ.get("MUSIC_CHANNELS", os.environ.get("MUSIC_CHANNEL","")).split(",") if ch.strip()]


async def main():
    client = TelegramClient(TG_SESSION, TG_API_ID, TG_API_HASH)
    await client.start(phone=TG_PHONE or None)

    bot = await client.get_entity(BOT_USERNAME)
    channels = [await client.get_entity(ch) for ch in MUSIC_CHANNELS]

    count = 0
    for channel in channels:
        print("Syncing:", channel.username or channel.id)
        async for msg in client.iter_messages(channel, limit=10000):
        if not msg.media or not isinstance(msg.media, MessageMediaDocument):
            continue
        doc = msg.media.document
        if not doc:
            continue
        if not any(isinstance(a, DocumentAttributeAudio) for a in (doc.attributes or [])):
            continue

        try:
            # пересылаем аудио боту — он сохранит file_id в Neon
            await client.send_file(bot, msg.media, caption=f"sync:{msg.id}")
            count += 1
            if count % 25 == 0:
                print(f"sent {count} tracks to bot...")
            await asyncio.sleep(0.35)  # не долбить антиспам
        except Exception as e:
            print("skip", msg.id, e)

    print(f"Done. Sent {count} tracks to @{BOT_USERNAME}")
    await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
