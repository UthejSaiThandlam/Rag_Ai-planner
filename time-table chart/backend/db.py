import os
import sqlite3
import json
import threading
from datetime import datetime
from typing import List, Dict, Any, Optional

DATABASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_FILE = os.path.join(DATABASE_DIR, "easylearn.db")

_local = threading.local()

def get_db_connection() -> sqlite3.Connection:
    """Thread-safe SQLite connection with busy timeout and WAL mode."""
    if not hasattr(_local, "conn") or _local.conn is None:
        # 30-second timeout to prevent 'database is locked' errors under concurrent load
        _local.conn = sqlite3.connect(DB_FILE, timeout=30.0, check_same_thread=False)
        _local.conn.row_factory = sqlite3.Row
        # Enable foreign keys, WAL mode, and busy handler
        _local.conn.execute("PRAGMA foreign_keys = ON;")
        _local.conn.execute("PRAGMA journal_mode = WAL;")
        _local.conn.execute("PRAGMA busy_timeout = 30000;")
        _local.conn.execute("PRAGMA synchronous = NORMAL;")
        _local.conn.execute("PRAGMA cache_size = -64000;")
    return _local.conn

def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()

    # 1. Users Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        is_guest INTEGER DEFAULT 0,
        last_login TIMESTAMP,
        login_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # Migrate columns if existing table lacks them
    cursor.execute("PRAGMA table_info(users)")
    user_cols = [c[1] for c in cursor.fetchall()]
    if "role" not in user_cols:
        cursor.execute("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'")
    if "last_login" not in user_cols:
        cursor.execute("ALTER TABLE users ADD COLUMN last_login TIMESTAMP")
    if "login_count" not in user_cols:
        cursor.execute("ALTER TABLE users ADD COLUMN login_count INTEGER DEFAULT 0")

    # 1b. Login Activity / Audit Logs Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS login_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        username TEXT,
        email TEXT,
        role TEXT DEFAULT 'user',
        status TEXT DEFAULT 'success',
        auth_method TEXT DEFAULT 'jwt_bearer',
        ip_address TEXT,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    """)

    # Seed Hardcoded Superadmin User
    admin_email = "uthejsaithandlam@gmail.com"
    # PBKDF2 hash of Admin@123 with salt easylearn_secure_salt_2026
    admin_pwd_hash = "63d77f27b5a054962f74067528e3a504f4946f4f70d2a2612a2429fa88cf7fcd"
    
    cursor.execute("SELECT id FROM users WHERE LOWER(email) = LOWER(?)", (admin_email,))
    existing_admin = cursor.fetchone()
    if not existing_admin:
        cursor.execute(
            "INSERT INTO users (id, username, email, password_hash, role, is_guest, login_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("usr_admin_uthej", "admin_uthej", admin_email, admin_pwd_hash, "admin", 0, 0)
        )
    else:
        cursor.execute("UPDATE users SET role = 'admin', password_hash = ? WHERE LOWER(email) = LOWER(?)", (admin_pwd_hash, admin_email))



    # 2. Documents Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        file_size INTEGER DEFAULT 0,
        mime_type TEXT DEFAULT 'application/octet-stream',
        total_pages INTEGER DEFAULT 1,
        total_chunks INTEGER DEFAULT 0,
        status TEXT DEFAULT 'Indexed',
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    """)

    # 3. Chunks Table (Dense vectors stored in vector_json)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        page_num INTEGER DEFAULT 1,
        content TEXT NOT NULL,
        char_count INTEGER DEFAULT 0,
        token_count INTEGER DEFAULT 0,
        vector_json TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    """)

    # 4. Roadmaps Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS roadmaps (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        level TEXT DEFAULT 'beginner',
        daily_hours REAL DEFAULT 2.0,
        deadline TEXT,
        roadmap_json TEXT NOT NULL,
        modules_json TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    """)

    # 5. Telemetry Logs Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS telemetry_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        endpoint TEXT NOT NULL,
        model TEXT DEFAULT 'unknown',
        provider TEXT DEFAULT 'unknown',
        latency_ms REAL DEFAULT 0.0,
        tokens INTEGER DEFAULT 0,
        cost REAL DEFAULT 0.0,
        status TEXT DEFAULT 'success',
        error_msg TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # 6. Daily Planner Tasks & Timetable
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS planner_tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        category TEXT DEFAULT 'Study',
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        completed INTEGER DEFAULT 0,
        color TEXT DEFAULT 'cyan',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    """)

    # 7. High-Performance Secondary Indexes
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chunks_user_doc ON chunks(user_id, doc_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_planner_user_time ON planner_tasks(user_id, start_time);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_telemetry_user_created ON telemetry_logs(user_id, created_at DESC);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_login_activity_user_created ON login_activity(user_id, created_at DESC);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);")

    conn.commit()
    print(f"[DB] Initialized persistent SQLite database at {DB_FILE}")

# Dependency for FastAPI with automatic rollback safeguard
def get_db():
    conn = get_db_connection()
    try:
        yield conn
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
