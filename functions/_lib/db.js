// 第一次访问时自动建表（幂等），所以部署时只需要创建 D1 数据库并绑定成 DB，不用手动跑迁移。
let ready = null;
export function getDb(env) {
  if (!env.DB) throw new Error('D1 binding "DB" is missing');
  if (!ready) {
    ready = env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS annotations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page TEXT NOT NULL,
        exact TEXT NOT NULL,
        prefix TEXT NOT NULL DEFAULT '',
        suffix TEXT NOT NULL DEFAULT '',
        start INTEGER,
        body TEXT NOT NULL,
        nickname TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'visible',
        reply TEXT,
        replied_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        ip_hash TEXT NOT NULL DEFAULT ''
      )`),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_ann_page ON annotations(page, status)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_ann_ip ON annotations(ip_hash, created_at)'),
    ]).catch((e) => { ready = null; throw e; });
  }
  return ready.then(() => env.DB);
}
