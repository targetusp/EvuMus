
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';
import { Bot, InlineKeyboard } from 'grammy';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// api.py находится в корне проекта
const PYTHON_DIR = ROOT;

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

const WEBAPP_URL = (
  process.env.WEBAPP_URL || 'http://localhost:8080'
).replace(/\/+$/, '');

const PORT = Number(process.env.PORT || 8080);
const PYTHON_API_PORT = Number(process.env.PYTHON_API_PORT || 8001);
const PYTHON_HOST = '127.0.0.1';

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);

const MUSIC_CHANNELS = (
  process.env.MUSIC_CHANNELS || process.env.MUSIC_CHANNEL || ''
)
  .split(',')
  .map(s => s.trim().replace(/^@/, ''))
  .filter(Boolean);

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN не задан в Environment');
}

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL не задан в Environment');
}

// Ищем Python API в корне проекта
const PYTHON_FILE = ['api.py', 'main.py']
  .map(name => path.join(PYTHON_DIR, name))
  .find(file => fs.existsSync(file));

if (!PYTHON_FILE) {
  throw new Error('Не найден api.py или main.py в корне проекта');
}

const PYTHON_MODULE = path.basename(PYTHON_FILE, '.py');

const VENV_PYTHON = '/opt/venv/bin/python';

const PYTHON_BIN = process.env.PYTHON_BIN || (
  fs.existsSync(VENV_PYTHON)
    ? VENV_PYTHON
    : 'python3'
);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('neon.tech')
    ? { rejectUnauthorized: false }
    : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});


/* ================= DATABASE ================= */

async function upsertUser(user, invitedBy = null) {
  const isAdmin = ADMIN_IDS.includes(Number(user.id));

  await pool.query(
    `INSERT INTO users
      (telegram_id, username, first_name, last_name, language_code, is_admin, invited_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (telegram_id) DO UPDATE SET
       username=EXCLUDED.username,
       first_name=EXCLUDED.first_name,
       last_name=EXCLUDED.last_name,
       language_code=EXCLUDED.language_code,
       is_admin=EXCLUDED.is_admin,
       last_seen_at=now()`,
    [
      user.id,
      user.username || null,
      user.first_name || null,
      user.last_name || null,
      user.language_code || 'ru',
      isAdmin,
      invitedBy
    ]
  );
}

async function saveTrackFromChannel(msg) {
  const audio = msg.audio || msg.voice;
  if (!audio) return null;

  const title = audio.title || msg.caption || 'Без названия';
  const artist = audio.performer || 'Неизвестен';

  const duration = audio.duration
    ? `${Math.floor(audio.duration / 60)}:${String(audio.duration % 60).padStart(2, '0')}`
    : null;

  const uniqueKey = `${title}|${artist}`.toLowerCase();

  const { rows } = await pool.query(
    `INSERT INTO channel_tracks
      (file_id, title, artist, duration, unique_key, message_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (unique_key) DO UPDATE SET
       file_id=EXCLUDED.file_id,
       title=EXCLUDED.title,
       artist=EXCLUDED.artist,
       updated_at=now()
     RETURNING id`,
    [
      audio.file_id,
      title,
      artist,
      duration,
      uniqueKey,
      msg.message_id
    ]
  );

  return rows[0];
}

async function searchTracks(q, limit = 30) {
  const { rows } = await pool.query(
    `SELECT id, title, artist, duration
     FROM channel_tracks
     WHERE title ILIKE $1 OR artist ILIKE $1
     ORDER BY title
     LIMIT $2`,
    [`%${q}%`, limit]
  );

  return rows;
}

async function getTrack(id) {
  const { rows } = await pool.query(
    'SELECT * FROM channel_tracks WHERE id=$1',
    [id]
  );

  return rows[0] || null;
}

async function useInviteCode(code, telegramId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT created_by
       FROM invite_codes
       WHERE code=$1 AND used_by IS NULL
       FOR UPDATE`,
      [code]
    );

    if (!rows.length) {
      await client.query('ROLLBACK');
      return { ok: false };
    }

    await client.query(
      `UPDATE invite_codes
       SET used_by=$1, used_at=now()
       WHERE code=$2 AND used_by IS NULL`,
      [telegramId, code]
    );

    await client.query('COMMIT');

    return {
      ok: true,
      inviter: rows[0].created_by
    };

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;

  } finally {
    client.release();
  }
}

async function createInviteCode(telegramId) {
  const code = crypto.randomBytes(4).toString('hex');

  await pool.query(
    'INSERT INTO invite_codes (code, created_by) VALUES ($1,$2)',
    [code, telegramId]
  );

  return code;
}


/* ================= TELEGRAM BOT ================= */

const bot = new Bot(BOT_TOKEN);

function appBtn(label = 'Открыть EvuMusic') {
  return InlineKeyboard.webApp(
    label,
    `${WEBAPP_URL}/index.html`
  );
}

function startKb() {
  return new InlineKeyboard()
    .webApp(
      'Открыть EvuMusic',
      `${WEBAPP_URL}/index.html`
    )
    .url(
      'Канал с обновлениями',
      'https://t.me/EvuMusic'
    );
}

bot.command('start', async ctx => {
  const payload = ctx.match || '';
  let invitedBy = null;

  if (payload.startsWith('ref_')) {
    const id = Number(payload.slice(4));

    if (Number.isFinite(id)) {
      invitedBy = id;
    }
  }

  if (payload.startsWith('inv_')) {
    try {
      const result = await useInviteCode(
        payload.slice(4),
        ctx.from.id
      );

      if (result.ok) {
        invitedBy = result.inviter;
      }

    } catch (error) {
      console.error('Invite error:', error);
    }
  }

  await upsertUser(ctx.from, invitedBy);

  await ctx.reply(
    'Твоя музыка, всегда рядом.\n\n' +
    'Напиши название песни или открой плеер: поиск, любимые треки и личные плейлисты.',
    {
      reply_markup: startKb()
    }
  );
});

bot.command('app', async ctx => {
  await ctx.reply('Открывай EvuMusic 👇', {
    reply_markup: appBtn()
  });
});

bot.command('help', async ctx => {
  await ctx.reply(
    'EvuMusic — закрытый музыкальный клуб.\n\n' +
    '/start — открыть приложение\n' +
    '/app — кнопка приложения\n' +
    '/search запрос — найти трек\n' +
    '/invite — создать инвайт (админ)\n' +
    '/stats — статистика (админ)',
    {
      reply_markup: appBtn()
    }
  );
});

bot.command('search', async ctx => {
  const q = (ctx.match || '').toString().trim();

  if (!q) {
    await ctx.reply('Используй: /search название');
    return;
  }

  const tracks = await searchTracks(q, 10);

  if (!tracks.length) {
    await ctx.reply('Ничего не нашёл 😔');
    return;
  }

  const keyboard = new InlineKeyboard();

  tracks.forEach(track => {
    keyboard.text(
      `${track.title} — ${track.artist || ''}`.slice(0, 60),
      `play:${track.id}`
    );
  });

  await ctx.reply(`Нашёл ${tracks.length}:`, {
    reply_markup: keyboard
  });
});

bot.command('invite', async ctx => {
  const result = await pool.query(
    'SELECT is_admin FROM users WHERE telegram_id=$1',
    [ctx.from.id]
  );

  const can = ADMIN_IDS.includes(ctx.from.id) ||
    result.rows[0]?.is_admin;

  if (!can) {
    await ctx.reply('Инвайты выдаёт администрация.');
    return;
  }

  const code = await createInviteCode(ctx.from.id);
  const me = await bot.api.getMe();

  await ctx.reply(
    `Код: <code>${code}</code>\nСсылка: https://t.me/${me.username}?start=inv_${code}`,
    {
      parse_mode: 'HTML',
      reply_markup: appBtn()
    }
  );
});

bot.command('stats', async ctx => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;

  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*) FROM users) users,
      (SELECT count(*) FROM users
       WHERE last_seen_at > now() - interval '7 days') active,
      (SELECT count(*) FROM channel_tracks) tracks,
      (SELECT count(*) FROM invite_codes
       WHERE used_by IS NOT NULL) invites
  `);

  const stats = rows[0];

  await ctx.reply(
    `👥 ${stats.users} | ⚡ ${stats.active} | 🎵 ${stats.tracks} | 🎟 ${stats.invites}`
  );
});

bot.callbackQuery(/^play:(\d+)$/, async ctx => {
  const id = Number(ctx.match[1]);
  const track = await getTrack(id);

  if (!track) {
    await ctx.answerCallbackQuery('Трек не найден');
    return;
  }

  await ctx.answerCallbackQuery();

  await ctx.replyWithAudio(track.file_id, {
    title: track.title,
    performer: track.artist || undefined,
    caption: `${track.title} — ${track.artist || ''}`
  });
});

bot.on('channel_post', async ctx => {
  try {
    if (
      MUSIC_CHANNELS.length &&
      ctx.chat.username &&
      !MUSIC_CHANNELS.some(
        channel =>
          channel.toLowerCase() ===
          ctx.chat.username.toLowerCase()
      )
    ) {
      return;
    }

    const saved = await saveTrackFromChannel(
      ctx.channelPost
    );

    if (saved) {
      console.log(
        'Saved track from channel:',
        saved.id
      );
    }

  } catch (error) {
    console.error('channel_post save error:', error);
  }
});

bot.on('message:audio', async ctx => {
  try {
    const saved = await saveTrackFromChannel(
      ctx.message
    );

    if (saved) {
      console.log(
        'Saved track from DM:',
        saved.id,
        saved.title
      );

      if (ADMIN_IDS.includes(ctx.from.id)) {
        await ctx.reply(`✅ Сохранено: ${saved.title}`);
      }
    }

  } catch (error) {
    console.error('audio save error:', error);
  }
});

bot.on('message:voice', async ctx => {
  try {
    await saveTrackFromChannel(ctx.message);
  } catch (error) {
    console.error('voice save error:', error);
  }
});

bot.on('message:text', async ctx => {
  if (ctx.message.text.startsWith('/')) return;

  const q = ctx.message.text.trim();

  if (q.length >= 2) {
    const tracks = await searchTracks(q, 8);

    if (tracks.length) {
      const keyboard = new InlineKeyboard();

      tracks.forEach(track => {
        keyboard.text(
          `${track.title}`.slice(0, 50),
          `play:${track.id}`
        );
      });

      await ctx.reply(`По запросу «${q}»:`, {
        reply_markup: keyboard
      });

      return;
    }
  }

  await ctx.reply('Открой приложение для поиска 👇', {
    reply_markup: appBtn('Открыть поиск')
  });
});

bot.catch(error => {
  console.error('Bot error:', error.error);
});


/* ================= EXPRESS ================= */

const app = express();

let pythonReady = false;
let pythonProcess = null;
let httpServer = null;
let shuttingDown = false;


/* ================= TELEGRAM AUTH ================= */

function validInitData(initData) {
  if (!initData || !BOT_TOKEN) return false;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash') || '';

    params.delete('hash');

    const pairs = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b));

    const dataCheck = pairs
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const secret = crypto
      .createHmac('sha256', 'WebAppData')
      .update(BOT_TOKEN)
      .digest();

    const expected = crypto
      .createHmac('sha256', secret)
      .update(dataCheck)
      .digest('hex');

    const actualBuffer = Buffer.from(hash, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');

    return (
      actualBuffer.length === expectedBuffer.length &&
      actualBuffer.length > 0 &&
      crypto.timingSafeEqual(
        actualBuffer,
        expectedBuffer
      )
    );

  } catch {
    return false;
  }
}

function userFromInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const user = params.get('user');

    return user ? JSON.parse(user) : null;

  } catch {
    return null;
  }
}


/* ================= NODE API ================= */

// Поиск по локальной базе канала
app.get('/api/channel-search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();

    if (q.length < 2) {
      return res.json({ tracks: [] });
    }

    const tracks = await searchTracks(q, 30);

    res.json({
      tracks: tracks.map(track => ({
        id: track.id,
        title: track.title,
        artist: track.artist,
        duration: track.duration
      }))
    });

  } catch (error) {
    console.error('Channel search error:', error);

    res.status(500).json({
      error: 'channel_search_failed'
    });
  }
});


// Треки из Telegram-канала
app.get('/api/tracks', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, artist, duration
       FROM channel_tracks
       ORDER BY id DESC
       LIMIT 50`
    );

    res.json({ tracks: rows });

  } catch (error) {
    console.error('Tracks error:', error);

    res.status(500).json({
      error: 'tracks_failed'
    });
  }
});


// Отправка трека пользователю в Telegram
app.post('/api/send', express.json(), async (req, res) => {
  try {
    const { initData, trackId } = req.body || {};

    const user = userFromInitData(initData);

    if (!user || !validInitData(initData)) {
      return res.status(401).json({
        error: 'auth'
      });
    }

    const track = await getTrack(Number(trackId));

    if (!track) {
      return res.status(404).json({
        error: 'not_found'
      });
    }

    await bot.api.sendAudio(user.id, track.file_id, {
      title: track.title,
      performer: track.artist || undefined,
      caption: `${track.title} — ${track.artist || ''}`
    });

    await upsertUser(user);

    res.json({ ok: true });

  } catch (error) {
    console.error('Send track error:', error);

    res.status(500).json({
      error: 'send_failed',
      description: error.description || error.message
    });
  }
});


// Расширенный поиск по локальной базе
app.get('/api/advanced', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();

    if (q.length < 2) {
      return res.json({ tracks: [] });
    }

    const tracks = await searchTracks(q, 50);

    res.json({
      tracks: tracks.map(track => ({
        id: track.id,
        title: track.title,
        artist: track.artist,
        duration: track.duration,
        source: 'channel'
      }))
    });

  } catch (error) {
    console.error('Advanced search error:', error);

    res.status(500).json({
      error: 'advanced_search_failed'
    });
  }
});


// Состояние Node и Python
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    node: true,
    python: pythonReady
  });
});


/* ================= PYTHON PROCESS ================= */

function startPython() {
  pythonProcess = spawn(
    PYTHON_BIN,
    [
      '-m',
      'uvicorn',
      `${PYTHON_MODULE}:app`,
      '--app-dir',
      PYTHON_DIR,
      '--host',
      PYTHON_HOST,
      '--port',
      String(PYTHON_API_PORT)
    ],
    {
      cwd: PYTHON_DIR,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  pythonProcess.stdout.on('data', data => {
    console.log(`[Python] ${data.toString().trim()}`);
  });

  pythonProcess.stderr.on('data', data => {
    console.error(`[Python] ${data.toString().trim()}`);
  });

  pythonProcess.on('error', error => {
    console.error('Python process error:', error);
  });

  pythonProcess.on('exit', (code, signal) => {
    pythonReady = false;

    console.error(
      `Python stopped: code=${code}, signal=${signal}`
    );

    if (!shuttingDown) {
      console.error(
        'Python API завершился. Перезапуск контейнера.'
      );

      process.exit(1);
    }
  });
}


// Проверяем, что FastAPI действительно запустился
function checkPythonHealth() {
  return new Promise(resolve => {
    const request = http.get(
      {
        hostname: PYTHON_HOST,
        port: PYTHON_API_PORT,
        path: '/api/health',
        timeout: 2000
      },
      response => {
        response.resume();

        resolve(
          response.statusCode >= 200 &&
          response.statusCode < 300
        );
      }
    );

    request.on('error', () => resolve(false));

    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
  });
}


async function waitForPythonReady() {
  const maxAttempts = 60;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (shuttingDown) {
      throw new Error('Startup cancelled');
    }

    if (await checkPythonHealth()) {
      pythonReady = true;
      console.log('Python API успешно запущен');
      return;
    }

    console.log(
      `Ожидание Python API: ${attempt}/${maxAttempts}`
    );

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error(
    'Python API не запустился за 60 секунд. Проверь Docker logs.'
  );
}


/* ================= PYTHON API PROXY ================= */

function proxyToPython(req, res) {
  const options = {
    hostname: PYTHON_HOST,
    port: PYTHON_API_PORT,
    path: req.originalUrl,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${PYTHON_HOST}:${PYTHON_API_PORT}`
    }
  };

  const proxyRequest = http.request(
    options,
    proxyResponse => {
      res.status(
        proxyResponse.statusCode || 502
      );

      for (const [key, value] of Object.entries(
        proxyResponse.headers
      )) {
        if (value !== undefined) {
          res.setHeader(key, value);
        }
      }

      proxyResponse.pipe(res);
    }
  );

  proxyRequest.on('error', error => {
    console.error(
      'Python proxy error:',
      error.message
    );

    if (!res.headersSent) {
      res.status(502).json({
        error: 'python_backend_unavailable',
        message: 'Python API временно недоступен'
      });
    } else {
      res.destroy(error);
    }
  });

  req.pipe(proxyRequest);

  res.on('close', () => {
    if (!proxyRequest.destroyed) {
      proxyRequest.destroy();
    }
  });
}


/* ================= STATIC FILES ================= */

// Не разрешаем скачивать внутренние файлы проекта
app.use((req, res, next) => {
  const blocked = [
    /^\/api\.py$/i,
    /^\/main\.py$/i,
    /^\/package(?:-lock)?\.json$/i,
    /^\/Dockerfile$/i,
    /^\/\.dockerignore$/i,
    /^\/requirements\.txt$/i,
    /^\/server(?:\/|$)/i,
    /^\/ru-backend(?:\/|$)/i,
    /^\/node_modules(?:\/|$)/i
  ];

  if (blocked.some(pattern => pattern.test(req.path))) {
    return res.sendStatus(404);
  }

  next();
});

app.use(express.static(ROOT, {
  index: 'index.html',
  extensions: ['html'],
  dotfiles: 'ignore'
}));


// OPTIONS для API
app.options(/^\/api\/.*/, (_req, res) => {
  res.sendStatus(204);
});


// Остальные API-маршруты обслуживает FastAPI
app.use('/api', (req, res) => {
  proxyToPython(req, res);
});


// Неизвестные страницы
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      error: 'api_route_not_found'
    });
  }

  res.status(404).send('Страница не найдена');
});


/* ================= START / SHUTDOWN ================= */

async function start() {
  await pool.query('SELECT 1');

  console.log('Neon PostgreSQL connected');

  startPython();

  // Дожидаемся запуска FastAPI
  await waitForPythonReady();

  await bot.api.setMyCommands([
    {
      command: 'start',
      description: 'Открыть EvuMusic'
    },
    {
      command: 'app',
      description: 'Кнопка приложения'
    },
    {
      command: 'search',
      description: 'Поиск трека'
    },
    {
      command: 'invite',
      description: 'Создать инвайт'
    },
    {
      command: 'help',
      description: 'Помощь'
    },
    {
      command: 'stats',
      description: 'Статистика (админ)'
    }
  ]);

  httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `EvuMusic server listening on port ${PORT}`
    );

    console.log(`WebApp URL: ${WEBAPP_URL}`);

    console.log(
      `Python API: http://${PYTHON_HOST}:${PYTHON_API_PORT}`
    );

    console.log(`Python file: ${PYTHON_FILE}`);

    if (MUSIC_CHANNELS.length) {
      console.log(
        `Music channels: ${
          MUSIC_CHANNELS.map(ch => '@' + ch).join(', ')
        }`
      );
    }
  });

  bot.start({
    onStart: me => {
      console.log(`Bot @${me.username} online`);
    }
  }).catch(error => {
    console.error(
      'Telegram bot polling error:',
      error
    );

    if (!shuttingDown) {
      process.exit(1);
    }
  });
}


async function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log(`Shutting down: ${signal}`);

  try {
    await bot.stop();
  } catch (error) {
    console.error('Bot stop error:', error);
  }

  if (httpServer) {
    await new Promise(resolve => {
      httpServer.close(resolve);
    });
  }

  if (pythonProcess && !pythonProcess.killed) {
    pythonProcess.kill('SIGTERM');
  }

  try {
    await pool.end();
  } catch (error) {
    console.error(
      'PostgreSQL shutdown error:',
      error
    );
  }

  process.exit(0);
}


process.once('SIGTERM', () => {
  shutdown('SIGTERM');
});

process.once('SIGINT', () => {
  shutdown('SIGINT');
});


start().catch(error => {
  console.error('EvuMusic startup failed:', error);
  process.exit(1);
});
