const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'ad-factory.db');

async function initDb() {
  const SQL = await initSqlJs();

  let db;
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS brands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      slug TEXT UNIQUE,
      description TEXT DEFAULT '',
      disclaimer_text TEXT DEFAULT '',
      color_primary TEXT DEFAULT '#000000',
      color_secondary TEXT DEFAULT '#333333',
      color_accent TEXT DEFAULT '#10B981',
      typography TEXT DEFAULT '',
      logo_path TEXT DEFAULT '',
      extra_notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS brand_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      category TEXT DEFAULT 'Other',
      label TEXT DEFAULT '',
      include_in_generation INTEGER DEFAULT 0,
      file_size INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS concepts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER NOT NULL,
      batch_name TEXT DEFAULT '',
      concept_name TEXT NOT NULL,
      headline TEXT DEFAULT '',
      body_copy TEXT DEFAULT '',
      visual_prompt TEXT NOT NULL,
      tags TEXT DEFAULT '[]',
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER NOT NULL,
      concept_id INTEGER,
      prompt_used TEXT NOT NULL,
      aspect_ratio TEXT DEFAULT '1:1',
      model_used TEXT DEFAULT 'gemini-2.5-flash-image',
      image_path TEXT NOT NULL,
      status TEXT DEFAULT 'completed',
      is_winner INTEGER DEFAULT 0,
      tags TEXT DEFAULT '[]',
      error_message TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  let inTransaction = false;

  const wrapper = {
    _db: db,

    prepare(sql) {
      return {
        all(...params) {
          try {
            const stmt = db.prepare(sql);
            if (params.length) stmt.bind(params);
            const results = [];
            while (stmt.step()) results.push(stmt.getAsObject());
            stmt.free();
            return results;
          } catch (e) {
            console.error('SQL all error:', e.message, sql);
            return [];
          }
        },
        get(...params) {
          try {
            const stmt = db.prepare(sql);
            if (params.length) stmt.bind(params);
            let result = null;
            if (stmt.step()) result = stmt.getAsObject();
            stmt.free();
            return result;
          } catch (e) {
            console.error('SQL get error:', e.message, sql);
            return null;
          }
        },
        run(...params) {
          try {
            db.run(sql, params);
            const lastId = db.exec("SELECT last_insert_rowid() as id")[0]?.values[0]?.[0];
            const changes = db.getRowsModified();
            if (!inTransaction) wrapper.save();
            return { lastInsertRowid: lastId, changes };
          } catch (e) {
            console.error('SQL run error:', e.message, sql);
            return { lastInsertRowid: null, changes: 0 };
          }
        }
      };
    },

    transaction(fn) {
      return (...args) => {
        db.run('BEGIN');
        inTransaction = true;
        try {
          fn(...args);
          db.run('COMMIT');
          inTransaction = false;
          wrapper.save();
        } catch (e) {
          inTransaction = false;
          try { db.run('ROLLBACK'); } catch (_) {}
          throw e;
        }
      };
    },

    save() {
      const data = db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(DB_PATH, buffer);
    }
  };

  return wrapper;
}

module.exports = { initDb };
