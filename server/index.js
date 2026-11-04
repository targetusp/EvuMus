import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';
import { Bot, InlineKeyboard, GrammyError, HttpError } from 'grammy';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = (process.env.WEBAPP_URL || 'http://localhost:8080').replace(/\/+$/, '');
const PORT = Number(process.env.PORT || 8080);
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean).map(Number);
const MUSIC_CHANNELS = (process.env.MUSIC_CHANNELS || process.env.MUSIC_CHANNEL || '').split(',').map(function(s){return s.trim().replace(/^@/,'');}).filter(Boolean);

if (!BOT_TOKEN) { console.error('BOT_TOKEN missing'); process.exit(1); }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('neon.tech') ? { rejectUnauthorized: false } : undefined,
});

/* ================= DB ================= */

async function upsertUser(user, invitedBy = null) {
  const isAdmin = ADMIN_IDS.includes(user.id);
  await pool.query(
    `INSERT INTO users (telegram_id, username, first_name, last_name, language_code, is_admin, invited_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (telegram_id) DO UPDATE SET
       username=EXCLUDED.username, first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
       language_code=EXCLUDED.language_code, is_admin=EXCLUDED.is_admin, last_seen_at=now()`,
    [user.id, user.username || null, user.first_name || null, user.last_name || null,
     user.language_code || 'ru', isAdmin, invitedBy]
  );
}

async function saveTrackFromChannel(msg) {
  const audio = msg.audio || msg.voice;
  if (!audio) return null;
  const title = audio.title || msg.caption || 'Без названия';
  const artist = audio.performer || (msg.caption_entities ? '' : '') || 'Неизвестен';
  const duration = audio.duration ? `${Math.floor(audio.duration / 60)}:${String(audio.duration % 60).padStart(2, '0')}` : null;
  const fileId = audio.file_id;
  const uniqueKey = `${title}|${artist}`.toLowerCase();

  const { rows } = await pool.query(
    `INSERT INTO channel_tracks (file_id, title, artist, duration, unique_key, message_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (unique_key) DO UPDATE SET file_id=EXCLUDED.file_id, title=EXCLUDED.title, artist=EXCLUDED.artist, updated_at=now()
     RETURNING id`,
    [fileId, title, artist, duration, uniqueKey, msg.message_id]
  );
  return rows[0];
}

async function searchTracks(q, limit = 30) {
  const { rows } = await pool.query(
    `SELECT id, title, artist, duration FROM channel_tracks
     WHERE title ILIKE $1 OR artist ILIKE $1
     ORDER BY title LIMIT $2`,
    [`%${q}%`, limit]
  );
  return rows;
}

async function getTrack(id) {
  const { rows } = await pool.query('SELECT * FROM channel_tracks WHERE id=$1', [id]);
  return rows[0] || null;
}

async function useInviteCode(code, telegramId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT created_by FROM invite_codes WHERE code=$1 AND used_by IS NULL FOR UPDATE`, [code]);
    if (!rows.length) { await client.query('ROLLBACK'); return { ok: false }; }
    await client.query(
      `UPDATE invite_codes SET used_by=$1, used_at=now() WHERE code=$2 AND used_by IS NULL`,
      [telegramId, code]);
    await client.query('COMMIT');
    return { ok: true, inviter: rows[0].created_by };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function createInviteCode(telegramId) {
  const code = crypto.randomBytes(4).toString('hex');
  await pool.query(`INSERT INTO invite_codes (code, created_by) VALUES ($1,$2)`, [code, telegramId]);
  return code;
}

/* ================= Bot ================= */

const bot = new Bot(BOT_TOKEN);

function appBtn(label = 'Открыть EvuMusic') {
  return InlineKeyboard.webApp(label, `${WEBAPP_URL}/index.html`);
}

function startKb() {
  return new InlineKeyboard()
    .webApp('Открыть EvuMusic', `${WEBAPP_URL}/index.html`)
    .url('Канал с обновлениями', 'https://t.me/EvuMusic');
}

bot.command('start', async (ctx) => {
  const payload = ctx.match || '';
  let invitedBy = null;
  if (payload.startsWith('ref_')) {
    const id = Number(payload.slice(4));
    if (Number.isFinite(id)) invitedBy = id;
  }
  if (payload.startsWith('inv_')) {
    try {
      const res = await useInviteCode(payload.slice(4), ctx.from.id);
      if (res.ok) invitedBy = res.inviter;
    } catch (e) { console.error(e); }
  }
  await upsertUser(ctx.from, invitedBy);
  await ctx.reply(
    'Твоя музыка, всегда рядом.\n\n' +
    'Напиши название песни или открой плеер: поиск, любимые треки и личные плейлисты.',
    { reply_markup: startKb() }
  );
});

bot.command('app', async (ctx) => {
  await ctx.reply('Открывай EvuMusic 👇', { reply_markup: appBtn() });
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    'EvuMusic — закрытый музыкальный клуб.\n\n' +
    '/start — открыть приложение\n' +
    '/app — кнопка приложения\n' +
    '/search запрос — найти трек\n' +
    '/invite — создать инвайт (админ)\n' +
    '/stats — статистика (админ)',
    { reply_markup: appBtn() }
  );
});

bot.command('search', async (ctx) => {
  const q = (ctx.match || '').toString().trim();
  if (!q) { await ctx.reply('Используй: /search название'); return; }
  const tracks = await searchTracks(q, 10);
  if (!tracks.length) { await ctx.reply('Ничего не нашёл 😔'); return; }
  const kb = new InlineKeyboard();
  tracks.forEach((t) => kb.text(`${t.title} — ${t.artist || ''}`.slice(0, 60), `play:${t.id}`));
  await ctx.reply(`Нашёл ${tracks.length}:`, { reply_markup: kb });
});

bot.command('invite', async (ctx) => {
  const can = ADMIN_IDS.includes(ctx.from.id) ||
    (await pool.query('SELECT is_admin FROM users WHERE telegram_id=$1', [ctx.from.id])).rows[0]?.is_admin;
  if (!can) { await ctx.reply('Инвайты выдаёт администрация.'); return; }
  const code = await createInviteCode(ctx.from.id);
  const me = await bot.api.getMe();
  await ctx.reply(
    `Код: <code>${code}</code>\nСсылка: https://t.me/${me.username}?start=inv_${code}`,
    { parse_mode: 'HTML', reply_markup: appBtn() }
  );
});

bot.command('stats', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*) FROM users) users,
      (SELECT count(*) FROM users WHERE last_seen_at > now() - interval '7 days') active,
      (SELECT count(*) FROM channel_tracks) tracks,
      (SELECT count(*) FROM invite_codes WHERE used_by IS NOT NULL) invites
  `);
  const s = rows[0];
  await ctx.reply(`👥 ${s.users} | ⚡ ${s.active} | 🎵 ${s.tracks} | 🎟 ${s.invites}`);
});

/* play callback — прислать трек */
bot.callbackQuery(/^play:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const t = await getTrack(id);
  if (!t) { await ctx.answerCallbackQuery('Трек не найден'); return; }
  await ctx.answerCallbackQuery();
  await ctx.replyWithAudio(t.file_id, {
    title: t.title,
    performer: t.artist || undefined,
    caption: `${t.title} — ${t.artist || ''}`,
  });
});

/* сохраняем музыку из канала (бот — админ канала) */
bot.on('channel_post', async (ctx) => {
  try {
    if (MUSIC_CHANNELS.length && ctx.chat.username && !MUSIC_CHANNELS.some(function(ch){return ch.toLowerCase()===ctx.chat.username.toLowerCase();})) return;
    const saved = await saveTrackFromChannel(ctx.message || ctx.channelPost);
    if (saved) console.log('Saved track from channel:', saved.id);
  } catch (e) { console.error('channel_post save error', e); }
});

/* аудио в ЛС (sync.py пересылает файлы боту) */
bot.on('message:audio', async (ctx) => {
  try {
    const saved = await saveTrackFromChannel(ctx.message);
    if (saved) {
      console.log('Saved track from DM:', saved.id, saved.title);
      if (ADMIN_IDS.includes(ctx.from.id)) {
        await ctx.reply(`✅ Сохранено: ${saved.title}`);
      }
    }
  } catch (e) { console.error('audio save error', e); }
});

bot.on('message:voice', async (ctx) => {
  try { await saveTrackFromChannel(ctx.message); } catch (e) { console.error(e); }
});

/* любой текст — подсказка */
bot.on('message:text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  const q = ctx.message.text.trim();
  if (q.length >= 2) {
    const tracks = await searchTracks(q, 8);
    if (tracks.length) {
      const kb = new InlineKeyboard();
      tracks.forEach((t) => kb.text(`${t.title}`.slice(0, 50), `play:${t.id}`));
      await ctx.reply(`По запросу «${q}»:`, { reply_markup: kb });
      return;
    }
  }
  await ctx.reply('Открой приложение для поиска 👇', { reply_markup: appBtn('Открыть поиск') });
});

bot.catch((err) => console.error('Bot error', err.error));

/* ================= API ================= */

function validInitData(initData) {
  if (!initData) return false;
  try {
    const url = new URLSearchParams(initData);
    const hash = url.get('hash') || '';
    url.delete('hash');
    const pairs = [...url.entries()].sort(([a], [b]) => a.localeCompare(b));
    const dataCheck = pairs.map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expected = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
  } catch { return false; }
}

function userFromInitData(initData) {
  const url = new URLSearchParams(initData);
  const user = url.get('user');
  if (!user) return null;
  try { return JSON.parse(user); } catch { return null; }
}

const app = express();
app.use(express.json());

/* статика сайта */
app.use(express.static(ROOT, { index: 'index.html' }));

/* поиск */
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ tracks: [] });
  const tracks = await searchTracks(q, 30);
  res.json({ tracks: tracks.map((t) => ({ id: t.id, title: t.title, artist: t.artist, duration: t.duration })) });
});

/* треки канала (лента) */
app.get('/api/tracks', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, title, artist, duration FROM channel_tracks ORDER BY id DESC LIMIT 50`);
  res.json({ tracks: rows });
});

/* прислать трек в чат */
app.post('/api/send', async (req, res) => {
  const { initData, trackId } = req.body || {};
  const user = userFromInitData(initData);
  if (!user || !validInitData(initData)) return res.status(401).json({ error: 'auth' });
  const t = await getTrack(Number(trackId));
  if (!t) return res.status(404).json({ error: 'not_found' });
  try {
    await bot.api.sendAudio(user.id, t.file_id, {
      title: t.title,
      performer: t.artist || undefined,
      caption: `${t.title} — ${t.artist || ''}`,
    });
    await upsertUser(user);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'send_failed', description: e.description || e.message });
  }
});

/* расширенный поиск — музыка из канала + локальная подсказка */
app.get('/api/advanced', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ tracks: [] });
  const tracks = await searchTracks(q, 50);
  res.json({
    tracks: tracks.map((t) => ({
      id: t.id, title: t.title, artist: t.artist, duration: t.duration, source: 'channel',
    })),
  });
});

/* health */
app.get('/api/health', (_req, res) => res.json({ ok: true }));

/* ================= Start ================= */

bot.api.setMyCommands([
  { command: 'start', description: 'Открыть EvuMusic' },
  { command: 'app', description: 'Кнопка приложения' },
  { command: 'search', description: 'Поиск трека' },
  { command: 'invite', description: 'Создать инвайт' },
  { command: 'help', description: 'Помощь' },
  { command: 'stats', description: 'Статистика (админ)' },
]);

bot.start({
  onStart: (me) => console.log(`Bot @${me.username} online`),
});

app.listen(PORT, () => {
  console.log(`EvuMusic server → http://localhost:${PORT}`);
  console.log(`WebApp URL: ${WEBAPP_URL}`);
  if (MUSIC_CHANNEL) console.log(`Music channel: @${MUSIC_CHANNEL}`);
});
