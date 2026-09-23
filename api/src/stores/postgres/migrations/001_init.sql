-- LinkPulse schema v1

CREATE TABLE users (
  id            uuid PRIMARY KEY,
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         text NOT NULL,
  prefix       text NOT NULL,
  key_hash     text NOT NULL UNIQUE,  -- sha256(secret); the secret is never stored
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX api_keys_user_idx ON api_keys (user_id, created_at DESC);

-- The short-code generator leases blocks of ids: block n covers [n*1000, n*1000+999].
CREATE SEQUENCE link_id_block_seq START 1;

CREATE TABLE links (
  id            bigint PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  owner_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  url           text NOT NULL,
  title         text,
  favicon_url   text,
  is_custom     boolean NOT NULL DEFAULT false,
  password_hash text,
  expires_at    timestamptz,
  max_clicks    integer CHECK (max_clicks IS NULL OR max_clicks > 0),
  disabled      boolean NOT NULL DEFAULT false,
  public_stats  boolean NOT NULL DEFAULT false,
  click_count   bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Keyset pagination of a user's links (newest first).
CREATE INDEX links_owner_created_idx ON links (owner_id, created_at DESC, id DESC);

-- Raw click events. At scale this becomes a monthly-partitioned table (or moves to a
-- columnar store) with hourly rollups; see README "Scaling notes".
CREATE TABLE clicks (
  id            uuid PRIMARY KEY,       -- generated on the redirect path: makes redelivery idempotent
  link_id       bigint NOT NULL REFERENCES links (id) ON DELETE CASCADE,
  ts            timestamptz NOT NULL,
  visitor_hash  text NOT NULL,
  referrer      text NOT NULL,
  country       text NOT NULL,
  device        text NOT NULL,
  browser       text NOT NULL,
  os            text NOT NULL,
  is_bot        boolean NOT NULL DEFAULT false
);
CREATE INDEX clicks_link_ts_idx ON clicks (link_id, ts);
