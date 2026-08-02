/**
 * Schema for a workspace-scoped `.aca/state.db`.
 *
 * Every table here exists to close a specific hole in the original flow
 * diagram; the `F` references point at docs/01-flow-review.md.
 */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
    -- F18: append-only provenance. Everything else is derivable from this.
    CREATE TABLE IF NOT EXISTS events (
      seq     INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id  TEXT NOT NULL,
      node_id TEXT,
      ts      INTEGER NOT NULL,
      type    TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

    CREATE TABLE IF NOT EXISTS runs (
      id         TEXT PRIMARY KEY,
      status     TEXT NOT NULL,
      goal       TEXT NOT NULL,
      spec       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nodes (
      run_id        TEXT NOT NULL,
      id            TEXT NOT NULL,
      title         TEXT NOT NULL,
      persona       TEXT NOT NULL,
      status        TEXT NOT NULL,
      deps          TEXT NOT NULL,
      read_set      TEXT NOT NULL,
      write_set     TEXT NOT NULL,
      contract      TEXT NOT NULL DEFAULT '',
      -- F1: the attempt counter lives here, not in the classifier
      attempts      INTEGER NOT NULL DEFAULT 0,
      -- F2: bounded review loop
      review_rounds INTEGER NOT NULL DEFAULT 0,
      route         TEXT,
      checkpoint_id TEXT,
      dirty_reason  TEXT,
      PRIMARY KEY (run_id, id)
    );

    -- F3: canonical-order acquisition needs a durable lock table.
    -- F5: parked nodes RETAIN their locks; releasing them would let a sibling
    --     mutate the resource and invalidate the parked node's checkpoint.
    CREATE TABLE IF NOT EXISTS locks (
      resource    TEXT PRIMARY KEY,
      run_id      TEXT NOT NULL,
      node_id     TEXT NOT NULL,
      mode        TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      parked      INTEGER NOT NULL DEFAULT 0
    );

    -- F7: monotonic epoch per resource; part of every cache key so a mutating
    --     write invalidates reads of that resource automatically.
    CREATE TABLE IF NOT EXISTS resource_epochs (
      resource TEXT PRIMARY KEY,
      epoch    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_cache (
      key        TEXT PRIMARY KEY,
      tool       TEXT NOT NULL,
      result     TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id      TEXT PRIMARY KEY,
      run_id  TEXT NOT NULL,
      node_id TEXT,
      path    TEXT NOT NULL,
      bytes   INTEGER NOT NULL,
      sha256  TEXT NOT NULL,
      pinned  INTEGER NOT NULL DEFAULT 1,
      summary TEXT NOT NULL DEFAULT '',
      trust   TEXT NOT NULL DEFAULT 'untrusted'
    );

    -- Memory tiers T2 / T4 (T3 index lands with the retrieval milestone)
    CREATE TABLE IF NOT EXISTS mem_task (
      id      TEXT PRIMARY KEY,
      run_id  TEXT NOT NULL,
      node_id TEXT,
      kind    TEXT NOT NULL,
      content TEXT NOT NULL,
      ts      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mem_lessons (
      id         TEXT PRIMARY KEY,
      scope      TEXT NOT NULL,
      trigger    TEXT NOT NULL,
      lesson     TEXT NOT NULL,
      evidence   TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0,
      uses       INTEGER NOT NULL DEFAULT 0,
      wins       INTEGER NOT NULL DEFAULT 0,
      confirmed  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS model_scorecards (
      provider    TEXT NOT NULL,
      model       TEXT NOT NULL,
      probed_at   INTEGER NOT NULL,
      tools       TEXT NOT NULL,
      structured  TEXT NOT NULL,
      real_ctx    INTEGER NOT NULL,
      tok_per_sec REAL NOT NULL DEFAULT 0,
      ttft_ms     REAL NOT NULL DEFAULT 0,
      reliability REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (provider, model)
    );

    CREATE TABLE IF NOT EXISTS threads (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL DEFAULT '',
      model      TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS thread_messages (
      id        TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role      TEXT NOT NULL,
      content   TEXT NOT NULL,
      meta      TEXT NOT NULL DEFAULT '{}',
      ts        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msgs_thread ON thread_messages(thread_id, ts);
    `,
  },
];
