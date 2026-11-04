import 'dotenv/config';
import pg from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('neon.tech') ? { rejectUnauthorized: false } : undefined,
});

const SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT UNIQUE NOT NULL,
  username      TEXT,
  first_name    TEXT,
  last_name     TEXT,
  language_code TEXT DEFAULT 'ru',
  theme         TEXT DEFAULT 'blue' CHECK (theme IN ('blue','white','black')),
  is_admin      BOOLEAN DEFAULT FALSE,
  is_banned     BOOLEAN DEFAULT FALSE,
  invited_by    BIGINT REFERENCES users(telegram_id),
  created_at    TIMESTAMPTZ DEFAULT now(),
  last_seen_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invite_codes (
  code        TEXT PRIMARY KEY,
  created_by  BIGINT NOT NULL,
  used_by     BIGINT UNIQUE,
  created_at  TIMESTAMPTZ DEFAULT now(),
  used_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS channel_tracks (
  id          BIGSERIAL PRIMARY KEY,
  file_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  artist      TEXT,
  duration    TEXT,
  unique_key  TEXT UNIQUE NOT NULL,
  message_id  BIGINT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS library_tracks (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  track_id    BIGINT NOT NULL,
  title       TEXT NOT NULL,
  artist      TEXT,
  duration    TEXT,
  added_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, track_id)
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id     BIGINT NOT NULL,
  track_id    BIGINT NOT NULL,
  title       TEXT NOT NULL,
  artist      TEXT,
  duration    TEXT,
  added_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, track_id)
);

CREATE TABLE IF NOT EXISTS playlists (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  title       TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id BIGINT NOT NULL,
  track_id    BIGINT NOT NULL,
  title       TEXT NOT NULL,
  artist      TEXT,
  duration    TEXT,
  position    INT DEFAULT 0,
  added_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (playlist_id, track_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_tracks_title ON channel_tracks USING gin (to_tsvector('simple', title || ' ' || coalesce(artist,'')));
CREATE INDEX IF NOT EXISTS idx_library_user ON library_tracks(user_id);
CREATE INDEX IF NOT EXISTS idx_fav_user ON favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id);
`;

async function main() {
  await pool.query(SQL);
  console.log('Neon schema OK (incl. channel_tracks)');
  await pool.end();
}

main().catch((e) => { console.error('DB init failed:', e.message); process.exit(1); });
