CREATE TABLE IF NOT EXISTS dead_letter_records (
  id TEXT PRIMARY KEY,
  endpoint_url TEXT NOT NULL,
  http_method TEXT NOT NULL,
  payload TEXT NOT NULL,
  headers TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  retry_policy TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempted_at TEXT,
  next_retry_at TEXT,
  claim_token TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  error_log TEXT
);
PRAGMA journal_mode=WAL;
CREATE INDEX IF NOT EXISTS idx_retry_queue
  ON dead_letter_records(status, next_retry_at);
