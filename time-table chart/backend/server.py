import os
import sys
import time
import json
import base64
import io
import uuid
import sqlite3
from typing import Optional, List, Dict, Any
from datetime import datetime

from fastapi import FastAPI, Depends, HTTPException, status, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

# Setup project directories
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BACKEND_DIR)
FRONTEND_DIR = os.path.join(PROJECT_ROOT, "frontend")

for p in [BACKEND_DIR, PROJECT_ROOT]:
    if p not in sys.path:
        sys.path.insert(0, p)

# Load environment variables
from dotenv import load_dotenv
for env_path in [os.path.join(PROJECT_ROOT, '.env'), os.path.join(BACKEND_DIR, '.env')]:
    if os.path.exists(env_path):
        load_dotenv(env_path)
        print(f"[ENV] Loaded environment from {env_path}")
        break

from backend.db import init_db, get_db
from backend.services.auth import (
    hash_password, verify_password, create_access_token,
    get_current_user, get_current_user_optional,
    get_current_admin, is_admin_email, ADMIN_EMAIL
)
from backend.rag.rag_engine import rag_engine
from backend.services.ai_service import call_gemini, call_groq, ddg_search

try:
    import pypdf
except ImportError:
    pypdf = None

try:
    import docx
except ImportError:
    docx = None

# Initialize Database
init_db()

# Initialize FastAPI App
app = FastAPI(
    title="EasyLearn AI — Enterprise RAG & Study Planner",
    description="Production-grade RAG Assistant with persistent vector search, JWT auth, and telemetry.",
    version="2.0.0"
)

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Pydantic Request Models ───
class RegisterRequest(BaseModel):
    username: str
    email: str
    password: str

class LoginRequest(BaseModel):
    username: str
    password: str

class DocumentUploadBase64(BaseModel):
    filename: str
    base64: str

class SearchRequest(BaseModel):
    query: str
    mode: str = "hybrid"  # hybrid, semantic, keyword
    top_k: int = 5
    doc_filter: Optional[str] = None

class ChatRequest(BaseModel):
    message: str
    history: Optional[List[Dict[str, str]]] = []
    mode: str = "study"
    doc_filter: Optional[str] = None

class PlanRequest(BaseModel):
    topic: str
    depth: str = "beginner"
    daily_hours: float = 2.0
    deadline: Optional[str] = None

class PlannerTaskCreate(BaseModel):
    title: str
    category: Optional[str] = "Study"
    start_time: str
    end_time: str
    color: Optional[str] = "cyan"

# ─── Telemetry Logger ───
def log_telemetry(conn: sqlite3.Connection, user_id: Optional[str], endpoint: str, model: str, provider: str, latency_ms: float, tokens: int = 0, status: str = "success", error_msg: Optional[str] = None):
    try:
        cost = round((tokens / 1000.0) * 0.00015, 6)
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO telemetry_logs (user_id, endpoint, model, provider, latency_ms, tokens, cost, status, error_msg)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (user_id, endpoint, model, provider, round(latency_ms, 2), tokens, cost, status, error_msg))
        conn.commit()
    except Exception as e:
        print(f"[TELEMETRY ERROR] {e}")

def record_login_activity(conn: sqlite3.Connection, user_id: Optional[str], username: str, email: str, role: str, status: str, auth_method: str = "jwt_password", req: Optional[Request] = None):
    try:
        ip = "127.0.0.1"
        ua = "Unknown"
        if req:
            forwarded = req.headers.get("x-forwarded-for")
            ip = forwarded.split(",")[0].strip() if forwarded else (req.client.host if req.client else "127.0.0.1")
            ua = req.headers.get("user-agent", "Unknown")[:250]
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO login_activity (user_id, username, email, role, status, auth_method, ip_address, user_agent)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (user_id, username, email, role, status, auth_method, ip, ua))
        conn.commit()
    except Exception as e:
        print(f"[AUDIT LOG ERROR] {e}")

# ─── IN-MEMORY RATE LIMITER (BRUTE FORCE & SPAM PROTECTION) ───
_rate_limit_tracker: Dict[str, List[float]] = {}

def apply_rate_limit(request: Request, max_requests: int = 40, window_secs: int = 60):
    client_ip = "127.0.0.1"
    if request:
        forwarded = request.headers.get("x-forwarded-for")
        client_ip = forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else "127.0.0.1")
    
    # Exclude localhost / local developer testing from strict rate limiting
    if client_ip in ("127.0.0.1", "::1", "localhost"):
        return

    now = time.time()
    attempts = _rate_limit_tracker.get(client_ip, [])
    attempts = [t for t in attempts if now - t < window_secs]
    if len(attempts) >= max_requests:
        raise HTTPException(
            status_code=429,
            detail="Too many authentication requests from this IP. Please wait a minute before retrying."
        )
    attempts.append(now)
    _rate_limit_tracker[client_ip] = attempts

# ─── AUTHENTICATION ENDPOINTS ───
@app.post("/api/auth/register")
def register(req: RegisterRequest, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    apply_rate_limit(request, max_requests=20, window_secs=60)
    u_clean = req.username.strip()
    em_clean = req.email.strip()

    if not u_clean:
        raise HTTPException(status_code=400, detail="Username cannot be empty")
    if not em_clean or "@" not in em_clean:
        raise HTTPException(status_code=400, detail="Please enter a valid email address")
    if len(req.password) < 3:
        raise HTTPException(status_code=400, detail="Password must be at least 3 characters")

    cursor = conn.cursor()
    cursor.execute("SELECT id FROM users WHERE LOWER(username) = LOWER(?)", (u_clean,))
    if cursor.fetchone():
        record_login_activity(conn, None, u_clean, em_clean, "user", "failed", "duplicate_username", request)
        raise HTTPException(status_code=400, detail=f"Username '{u_clean}' is already taken. Please choose another username or Sign In.")

    cursor.execute("SELECT id FROM users WHERE LOWER(email) = LOWER(?)", (em_clean,))
    if cursor.fetchone():
        record_login_activity(conn, None, u_clean, em_clean, "user", "failed", "duplicate_email", request)
        raise HTTPException(status_code=400, detail=f"Email '{em_clean}' is already registered. Please Sign In with your existing password.")

    user_id = f"usr_{uuid.uuid4().hex[:12]}"
    pwd_hash = hash_password(req.password)
    # Role hardcoding: only uthejsaithandlam@gmail.com is admin, all others are user
    role = "admin" if is_admin_email(em_clean) else "user"
    now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

    cursor.execute(
        "INSERT INTO users (id, username, email, password_hash, role, is_guest, last_login, login_count) VALUES (?, ?, ?, ?, ?, 0, NULL, 0)",
        (user_id, u_clean, em_clean, pwd_hash, role)
    )
    conn.commit()

    record_login_activity(conn, user_id, u_clean, em_clean, role, "success", "account_created", request)

    return {
        "status": "success",
        "message": f"Account '{u_clean}' created successfully. Please sign in.",
        "user": {
            "id": user_id,
            "username": u_clean,
            "email": em_clean,
            "role": role,
            "is_guest": False
        }
    }

@app.post("/api/auth/login")
def login(req: LoginRequest, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    apply_rate_limit(request, max_requests=20, window_secs=60)
    ident = req.username.strip()
    cursor = conn.cursor()
    # Match either username or email
    cursor.execute("SELECT * FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)", (ident, ident))
    row = cursor.fetchone()

    if not row or not verify_password(req.password, row["password_hash"]):
        record_login_activity(
            conn,
            row["id"] if row else None,
            row["username"] if row else ident,
            row["email"] if row else ident,
            "admin" if is_admin_email(ident) else "user",
            "failed",
            "jwt_password",
            request
        )
        raise HTTPException(status_code=401, detail="Invalid username/email or password")

    user = dict(row)
    # Role guarantee: hardcoded to admin if email matches
    role = "admin" if is_admin_email(user["email"]) else "user"
    now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

    cursor.execute(
        "UPDATE users SET last_login = ?, login_count = COALESCE(login_count, 0) + 1, role = ? WHERE id = ?",
        (now_str, role, user["id"])
    )
    conn.commit()

    record_login_activity(conn, user["id"], user["username"], user["email"], role, "success", "jwt_password", request)

    token = create_access_token({"sub": user["id"], "username": user["username"], "email": user["email"], "role": role})
    return {
        "token": token,
        "user": {
            "id": user["id"],
            "username": user["username"],
            "email": user["email"],
            "role": role,
            "is_guest": bool(user.get("is_guest", 0)),
            "last_login": now_str
        }
    }

@app.post("/api/auth/guest")
def guest_login(request: Request, conn: sqlite3.Connection = Depends(get_db)):
    apply_rate_limit(request, max_requests=10, window_secs=60)
    guest_id = f"guest_{uuid.uuid4().hex[:8]}"
    username = f"Guest_{guest_id[-4:]}"
    now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO users (id, username, email, password_hash, role, is_guest, last_login, login_count) VALUES (?, ?, ?, ?, 'user', 1, ?, 1)",
        (guest_id, username, f"{guest_id}@easylearn.local", hash_password("guest_pass"), now_str)
    )
    conn.commit()

    record_login_activity(conn, guest_id, username, f"{guest_id}@easylearn.local", "user", "success", "jwt_guest", request)

    token = create_access_token({"sub": guest_id, "username": username, "email": f"{guest_id}@easylearn.local", "role": "user"})
    return {
        "token": token,
        "user": {
            "id": guest_id,
            "username": username,
            "email": f"{guest_id}@easylearn.local",
            "role": "user",
            "is_guest": True,
            "last_login": now_str
        }
    }

@app.get("/api/auth/me")
def get_me(user: Dict[str, Any] = Depends(get_current_user)):
    role = "admin" if is_admin_email(user.get("email")) else user.get("role", "user")
    return {
        "user": {
            "id": user["id"],
            "username": user["username"],
            "email": user["email"],
            "role": role,
            "is_guest": bool(user.get("is_guest", 0)),
            "last_login": user.get("last_login")
        }
    }

# ─── ADMIN AUDIT & USER ACTIVITY ENDPOINTS ───
@app.get("/api/admin/users")
def get_admin_users(user: Dict[str, Any] = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    is_admin = is_admin_email(user.get("email")) or user.get("role") == "admin"
    if is_admin:
        cursor.execute("""
            SELECT 
                u.id, u.username, u.email, u.role, u.is_guest, u.created_at, u.last_login, u.login_count,
                COUNT(d.id) as doc_count
            FROM users u
            LEFT JOIN documents d ON d.user_id = u.id
            GROUP BY u.id
            ORDER BY u.created_at DESC
        """)
    else:
        cursor.execute("""
            SELECT 
                u.id, u.username, u.email, u.role, u.is_guest, u.created_at, u.last_login, u.login_count,
                COUNT(d.id) as doc_count
            FROM users u
            LEFT JOIN documents d ON d.user_id = u.id
            WHERE u.id = ?
            GROUP BY u.id
        """, (user["id"],))

    rows = cursor.fetchall()
    users_list = []
    for r in rows:
        email = r["email"]
        role = "admin" if is_admin_email(email) else (r["role"] or "user")
        users_list.append({
            "id": r["id"],
            "username": r["username"],
            "email": email,
            "role": role,
            "is_admin": role == "admin",
            "is_guest": bool(r["is_guest"]),
            "created_at": str(r["created_at"]) if r["created_at"] else "N/A",
            "last_login": str(r["last_login"]) if r["last_login"] else "Never",
            "login_count": r["login_count"] or 0,
            "doc_count": r["doc_count"] or 0
        })
    return users_list

@app.get("/api/admin/activity")
def get_admin_activity(limit: int = 60, user: Dict[str, Any] = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    is_admin = is_admin_email(user.get("email")) or user.get("role") == "admin"
    if is_admin:
        cursor.execute("""
            SELECT id, user_id, username, email, role, status, auth_method, ip_address, user_agent, created_at
            FROM login_activity
            ORDER BY created_at DESC
            LIMIT ?
        """, (limit,))
    else:
        cursor.execute("""
            SELECT id, user_id, username, email, role, status, auth_method, ip_address, user_agent, created_at
            FROM login_activity
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT ?
        """, (user["id"], limit))

    rows = cursor.fetchall()
    return [
        {
            "id": r["id"],
            "user_id": r["user_id"],
            "username": r["username"],
            "email": r["email"],
            "role": r["role"],
            "status": r["status"],
            "auth_method": r["auth_method"],
            "ip_address": r["ip_address"] or "127.0.0.1",
            "user_agent": r["user_agent"] or "Unknown",
            "created_at": str(r["created_at"]) if r["created_at"] else "N/A"
        }
        for r in rows
    ]

@app.get("/api/admin/stats")
def get_admin_stats(user: Dict[str, Any] = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    is_admin = is_admin_email(user.get("email")) or user.get("role") == "admin"
    if is_admin:
        cursor.execute("SELECT COUNT(*) FROM users")
        total_users = cursor.fetchone()[0]

        cursor.execute("SELECT COUNT(*) FROM users WHERE LOWER(email) = LOWER(?)", (ADMIN_EMAIL,))
        admin_count = cursor.fetchone()[0]

        cursor.execute("SELECT COUNT(*) FROM login_activity WHERE status = 'success'")
        successful_logins = cursor.fetchone()[0]

        cursor.execute("SELECT COUNT(*) FROM login_activity WHERE status = 'failed'")
        failed_logins = cursor.fetchone()[0]

        cursor.execute("SELECT COUNT(DISTINCT user_id) FROM login_activity WHERE status = 'success'")
        unique_active_users = cursor.fetchone()[0]
    else:
        total_users = 1
        admin_count = 0
        cursor.execute("SELECT login_count FROM users WHERE id = ?", (user["id"],))
        r = cursor.fetchone()
        successful_logins = (r[0] if r and r[0] else 1)
        failed_logins = 0
        unique_active_users = 1

    return {
        "total_users": total_users,
        "admin_count": admin_count,
        "standard_users": max(0, total_users - admin_count),
        "successful_logins": successful_logins,
        "failed_logins": failed_logins,
        "unique_active_users": unique_active_users,
        "hardcoded_admin_email": ADMIN_EMAIL
    }

# ─── DAILY PLANNER & TIMETABLE ENDPOINTS ───
@app.get("/api/planner/tasks")
def get_planner_tasks(user: Dict[str, Any] = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("""
        SELECT id, user_id, title, category, start_time, end_time, completed, color, created_at
        FROM planner_tasks
        WHERE user_id = ?
        ORDER BY start_time ASC
    """, (user["id"],))
    rows = cursor.fetchall()

    return [
        {
            "id": r["id"],
            "title": r["title"],
            "category": r["category"],
            "start_time": r["start_time"],
            "end_time": r["end_time"],
            "completed": bool(r["completed"]),
            "color": r["color"] or "cyan"
        }
        for r in rows
    ]

@app.post("/api/planner/tasks")
def create_planner_task(req: PlannerTaskCreate, user: Dict[str, Any] = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    tid = f"task_{uuid.uuid4().hex[:8]}"
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO planner_tasks (id, user_id, title, category, start_time, end_time, completed, color)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    """, (tid, user["id"], req.title.strip(), req.category.strip() if req.category else "Study", req.start_time, req.end_time, req.color or "cyan"))
    conn.commit()
    return {"id": tid, "title": req.title, "status": "created"}

@app.put("/api/planner/tasks/{task_id}/toggle")
def toggle_planner_task(task_id: str, user: Dict[str, Any] = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("SELECT completed FROM planner_tasks WHERE id = ? AND user_id = ?", (task_id, user["id"]))
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Task not found")
    new_status = 0 if row[0] else 1
    cursor.execute("UPDATE planner_tasks SET completed = ? WHERE id = ? AND user_id = ?", (new_status, task_id, user["id"]))
    conn.commit()
    return {"id": task_id, "completed": bool(new_status)}

@app.delete("/api/planner/tasks/clear")
@app.delete("/api/planner/tasks/all")
def clear_all_planner_tasks(user: Dict[str, Any] = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("DELETE FROM planner_tasks WHERE user_id = ?", (user["id"],))
    conn.commit()
    return {"status": "cleared"}

@app.post("/api/planner/tasks/auto-schedule")
def auto_schedule_planner_tasks(user: Dict[str, Any] = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    
    # 1. Dynamically check if user has an active roadmap
    cursor.execute("SELECT topic, modules_json FROM roadmaps WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", (user["id"],))
    roadmap_row = cursor.fetchone()

    # 2. Dynamically check if user has uploaded documents
    cursor.execute("SELECT filename FROM documents WHERE user_id = ? ORDER BY created_at DESC LIMIT 3", (user["id"],))
    doc_rows = cursor.fetchall()

    schedule_blocks = []
    time_slots = [
        ("08:00", "08:45"),
        ("09:00", "09:45"),
        ("10:15", "11:15"),
        ("11:30", "12:30"),
        ("14:00", "15:00")
    ]

    if roadmap_row:
        topic = roadmap_row["topic"]
        modules = []
        try:
            modules = json.loads(roadmap_row["modules_json"]) if roadmap_row["modules_json"] else []
        except Exception:
            modules = []

        if modules and isinstance(modules, list):
            for i, mod in enumerate(modules[:5]):
                slot = time_slots[i] if i < len(time_slots) else ("15:30", "16:30")
                mod_title = mod.get("title") or mod.get("name") or f"Module {i+1}" if isinstance(mod, dict) else str(mod)
                schedule_blocks.append((
                    f"Session: {mod_title}",
                    "📖 Learning" if i % 2 == 0 else "⚡ Practice",
                    slot[0],
                    slot[1],
                    "cyan"
                ))
        else:
            schedule_blocks = [
                (f"Session: {topic} — Core Fundamentals", "📖 Learning", "08:00", "08:45", "cyan"),
                (f"Session: {topic} — Deep Dive & Analysis", "⚡ Practice", "09:00", "09:45", "cyan"),
                (f"Session: {topic} — Hands-on Drills", "💻 Coding", "10:15", "11:15", "cyan"),
                (f"Session: {topic} — Active Recall & Flashcards", "🧠 Review", "11:30", "12:30", "cyan")
            ]
    elif doc_rows:
        doc_names = [d["filename"] for d in doc_rows]
        schedule_blocks = [
            (f"Study Session: Reading & Annotating {doc_names[0]}", "📖 Learning", "08:00", "08:45", "cyan"),
            (f"Deep Work: Synthesizing Concepts from {doc_names[0]}", "⚡ Practice", "09:00", "09:45", "cyan"),
            (f"RAG Chat Drill: Asking Questions on Ingested Docs", "🧠 Review", "10:15", "11:15", "cyan")
        ]
        if len(doc_names) > 1:
            schedule_blocks.append((f"Study Session: Cross-referencing {doc_names[1]}", "📖 Learning", "11:30", "12:30", "cyan"))
    else:
        # Dynamic structured study routine
        schedule_blocks = [
            ("Session: Morning Focus & Concept Acquisition", "📖 Learning", "08:00", "08:45", "cyan"),
            ("Session: Active Practice & Practical Application", "⚡ Practice", "09:00", "09:45", "cyan"),
            ("Session: Problem Solving & Skill Development", "💻 Coding", "10:15", "11:15", "cyan"),
            ("Session: Knowledge Check & Daily Synthesis", "🧠 Review", "11:30", "12:30", "cyan")
        ]

    for title, cat, st, et, clr in schedule_blocks:
        tid = f"task_{uuid.uuid4().hex[:8]}"
        cursor.execute("""
            INSERT INTO planner_tasks (id, user_id, title, category, start_time, end_time, completed, color)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?)
        """, (tid, user["id"], title, cat, st, et, clr))
    conn.commit()
    return {"status": "auto_scheduled", "count": len(schedule_blocks)}

@app.delete("/api/planner/tasks/{task_id}")
def delete_planner_task(task_id: str, user: Dict[str, Any] = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("DELETE FROM planner_tasks WHERE id = ? AND user_id = ?", (task_id, user["id"]))
    conn.commit()
    return {"id": task_id, "status": "deleted"}


# ─── DOCUMENT INGESTION & KNOWLEDGE BASE ───
@app.get("/api/documents")
@app.get("/api/knowledge-base")
def list_documents(user: Dict[str, Any] = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    return rag_engine.get_user_knowledge_summary(conn, user["id"])

@app.post("/api/upload-document")
def upload_document_json(req: DocumentUploadBase64, user: Dict[str, Any] = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    start_t = time.time()
    try:
        filename = req.filename.strip()
        if not filename or not req.base64:
            raise HTTPException(status_code=400, detail="Filename and base64 content required")

        file_bytes = base64.b64decode(req.base64)
        file_size = len(file_bytes)

        if file_size > 15 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="File exceeds maximum 15MB limit")

        ext = os.path.splitext(filename.lower())[1]
        pages_text = []

        if ext == '.pdf':
            if not pypdf:
                raise HTTPException(status_code=500, detail="pypdf library missing on server")
            pdf_reader = pypdf.PdfReader(io.BytesIO(file_bytes))
            for i, page in enumerate(pdf_reader.pages):
                pages_text.append({"page_num": i + 1, "text": page.extract_text() or ""})
        elif ext in ('.docx', '.doc'):
            if not docx:
                raise HTTPException(status_code=500, detail="python-docx library missing")
            doc = docx.Document(io.BytesIO(file_bytes))
            text = "\n".join([p.text for p in doc.paragraphs])
            pages_text.append({"page_num": 1, "text": text})
        else:
            text = file_bytes.decode('utf-8', errors='replace')
            pages_text.append({"page_num": 1, "text": text})

        doc_id = f"doc_{int(time.time())}_{uuid.uuid4().hex[:4]}"
        result = rag_engine.ingest_document(conn, user["id"], doc_id, filename, pages_text, file_size)

        latency = (time.time() - start_t) * 1000
        log_telemetry(conn, user["id"], "/api/upload-document", "vector-ingest", "local", latency, tokens=file_size // 4, status="success")

        return {"success": True, **result}
    except HTTPException:
        raise
    except Exception as e:
        latency = (time.time() - start_t) * 1000
        log_telemetry(conn, user["id"], "/api/upload-document", "vector-ingest", "local", latency, status="error", error_msg=str(e))
        raise HTTPException(status_code=500, detail=f"Document processing failed: {str(e)[:100]}")

@app.delete("/api/documents/{doc_id}")
def delete_document(doc_id: str, user: Dict[str, Any] = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    deleted = rag_engine.delete_document(conn, user["id"], doc_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Document not found or access denied")
    return {"success": True, "deleted_id": doc_id}

# ─── RAG SEARCH & RETRIEVAL ───
@app.post("/api/rag/search")
def search_documents(req: SearchRequest, user: Dict[str, Any] = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    start_t = time.time()
    results = rag_engine.search(conn, user["id"], req.query, top_k=req.top_k, mode=req.mode, doc_filter=req.doc_filter)
    latency = (time.time() - start_t) * 1000
    log_telemetry(conn, user["id"], "/api/rag/search", "hybrid-retriever", "local", latency, tokens=len(req.query.split()) * 2, status="success")
    return {
        "query": req.query,
        "mode": req.mode,
        "count": len(results),
        "results": results
    }

# ─── RAG CHAT & ASSISTANT ───
@app.post("/api/rag/chat")
@app.post("/api/chat")
def chat_with_rag(req: ChatRequest, user: Dict[str, Any] = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    start_t = time.time()
    message = req.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message is required")

    retrieved_chunks = rag_engine.search(conn, user["id"], message, top_k=5, mode="hybrid", doc_filter=req.doc_filter)
    retrieval_ms = round((time.time() - start_t) * 1000, 2)

    context_blocks = []
    citations = []
    for r in retrieved_chunks:
        c = r['chunk']
        context_blocks.append(f"<context_source file='{c['doc_name']}' page='{c['page_num']}' score='{r['final_score']}'>\n{c['content']}\n</context_source>")
        citations.append({
            "doc_name": c['doc_name'],
            "page_num": c['page_num'],
            "chunk_id": c['chunk_id'],
            "similarity": r['similarity_score'],
            "final_score": r['final_score'],
            "snippet": c['content'][:180] + "..."
        })

    rag_context = "\n\n".join(context_blocks)

    prompt = f"""You are EasyLearn AI — an expert, rigorous AI Learning Assistant.

<RETRIEVED_DOCUMENTS>
{rag_context if rag_context else "No relevant documents were found in the user's uploaded knowledge base."}
</RETRIEVED_DOCUMENTS>

<USER_QUESTION>
{message}
</USER_QUESTION>

STRICT INSTRUCTIONS:
1. Ground your answer in the <RETRIEVED_DOCUMENTS> whenever relevant.
2. Whenever you quote or reference a detail from a document, add an exact inline citation formatted as: [filename, Page X].
3. If no relevant documents match, answer using your expert knowledge directly, but clarify politely that the information is from general AI knowledge rather than uploaded files.
4. Keep answers clear, structured, well-formatted, and educational."""

    groq_key = os.environ.get("GROQ_API_KEY", "").strip()
    gemini_key = os.environ.get("GEMINI_API_KEY", "").strip()

    provider = "gemini" if gemini_key else ("groq" if groq_key else "none")
    model_name = "gemini-2.5-flash" if provider == "gemini" else ("llama-3.3-70b" if provider == "groq" else "none")

    response_text = None
    error = None

    if provider == "gemini":
        response_text, error = call_gemini(prompt, gemini_key)
        if not response_text and groq_key:
            provider = "groq"
            model_name = "llama-3.3-70b"
            response_text, error = call_groq(prompt, groq_key, req.history)
    elif provider == "groq":
        response_text, error = call_groq(prompt, groq_key, req.history)
        if not response_text and gemini_key:
            provider = "gemini"
            model_name = "gemini-2.5-flash"
            response_text, error = call_gemini(prompt, gemini_key)

    total_latency = (time.time() - start_t) * 1000
    est_tokens = len(prompt.split()) + (len(response_text.split()) if response_text else 0)

    if not response_text:
        log_telemetry(conn, user["id"], "/api/rag/chat", model_name, provider, total_latency, tokens=est_tokens, status="fallback", error_msg=error)
        return {
            "message": f"⚠️ Notice: AI service is responding via fallback mode. ({error or 'Check API Keys in .env'})",
            "retrieved_context": retrieved_chunks,
            "citations": citations,
            "retrieval_time_ms": retrieval_ms,
            "provider": provider
        }

    log_telemetry(conn, user["id"], "/api/rag/chat", model_name, provider, total_latency, tokens=est_tokens, status="success")

    return {
        "message": response_text,
        "retrieved_context": retrieved_chunks,
        "citations": citations,
        "retrieval_time_ms": retrieval_ms,
        "provider": provider,
        "model": model_name
    }

# ─── ROADMAP PLANNER ───
@app.post("/api/generate-plan")
def generate_study_plan(req: PlanRequest, user: Dict[str, Any] = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    start_t = time.time()
    topic = req.topic.strip()
    if not topic:
        raise HTTPException(status_code=400, detail="Topic is required")

    gemini_key = os.environ.get("GEMINI_API_KEY", "").strip()
    groq_key = os.environ.get("GROQ_API_KEY", "").strip()

    plan_prompt = f"""Generate a structured JSON learning roadmap for topic: "{topic}".
Level: {req.depth}
Daily study hours: {req.daily_hours}

Return ONLY valid JSON matching this schema:
{{
  "roadmap": {{
    "name": "{topic}",
    "description": "Comprehensive learning path",
    "children": [
      {{
        "name": "Subtopic Name",
        "description": "What this subtopic covers",
        "estimated_hours": 3,
        "status": "upcoming",
        "resources": ["Official Docs", "Tutorials"]
      }}
    ]
  }},
  "modules": [
    {{
      "name": "Session: specific task name",
      "duration": 45,
      "priority": "high",
      "category": "learning",
      "subtopic_index": 0,
      "completed": false,
      "splittable": true
    }}
  ],
  "summary": {{
    "total_hours": 20,
    "daily_hours": {req.daily_hours},
    "estimated_days": 10
  }}
}}"""

    response_text = None
    error = None
    provider = "gemini" if gemini_key else "groq"

    if gemini_key:
        response_text, error = call_gemini(plan_prompt, gemini_key, expect_json=True)
    elif groq_key:
        response_text, error = call_groq(plan_prompt, groq_key, expect_json=True)

    plan_data = None
    if response_text:
        try:
            cleaned = response_text.strip()
            if cleaned.startswith("```"):
                cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned[3:]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3]
            plan_data = json.loads(cleaned.strip())
        except Exception:
            pass

    if not plan_data:
        plan_data = {
            "roadmap": {
                "name": topic,
                "description": f"Structured curriculum for {topic} ({req.depth})",
                "children": [
                    {"name": f"Foundations of {topic}", "description": "Core concepts and setup", "estimated_hours": 4, "status": "active", "resources": ["Core Docs"]},
                    {"name": f"Intermediate {topic} Patterns", "description": "Hands-on patterns", "estimated_hours": 6, "status": "upcoming", "resources": ["Tutorial Guide"]},
                    {"name": f"Advanced {topic} Implementation", "description": "Real-world engineering", "estimated_hours": 8, "status": "upcoming", "resources": ["Project Walkthrough"]}
                ]
            },
            "modules": [
                {"name": f"Intro & Setup for {topic}", "duration": 45, "priority": "high", "category": "learning", "subtopic_index": 0, "completed": False, "splittable": True},
                {"name": f"Core Principles & Exercises", "duration": 60, "priority": "high", "category": "learning", "subtopic_index": 0, "completed": False, "splittable": True}
            ],
            "summary": {"total_hours": 18, "daily_hours": req.daily_hours, "estimated_days": 9}
        }

    roadmap_id = f"rdm_{uuid.uuid4().hex[:8]}"
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO roadmaps (id, user_id, topic, level, daily_hours, deadline, roadmap_json, modules_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (roadmap_id, user["id"], topic, req.depth, req.daily_hours, req.deadline, json.dumps(plan_data.get("roadmap", {})), json.dumps(plan_data.get("modules", []))))
    conn.commit()

    latency = (time.time() - start_t) * 1000
    log_telemetry(conn, user["id"], "/api/generate-plan", "curriculum-planner", provider, latency, tokens=800, status="success")

    return plan_data

# ─── TELEMETRY & OBSERVABILITY ENDPOINTS ───
@app.get("/api/telemetry/stats")
def get_telemetry_stats(user: Dict[str, Any] = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("SELECT latency_ms, cost, status, provider FROM telemetry_logs ORDER BY created_at DESC LIMIT 200")
    logs = cursor.fetchall()
    total_reqs = len(logs)
    avg_latency = round(sum(l[0] for l in logs) / max(total_reqs, 1), 1)
    total_cost = round(sum(l[1] for l in logs), 4)
    errors = sum(1 for l in logs if l[2] == "error")
    error_rate = round((errors / max(total_reqs, 1)) * 100, 2)

    gemini_calls = sum(1 for l in logs if l[3] == "gemini")
    groq_calls = sum(1 for l in logs if l[3] == "groq")
    local_calls = sum(1 for l in logs if l[3] in ("local", "unknown"))

    return {
        "total_requests": total_reqs,
        "avg_latency_ms": avg_latency,
        "total_cost_usd": total_cost,
        "error_rate_pct": error_rate,
        "provider_breakdown": {
            "gemini": gemini_calls,
            "groq": groq_calls,
            "local": local_calls
        }
    }

@app.get("/api/telemetry/logs")
def get_telemetry_logs(user: Dict[str, Any] = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("SELECT id, endpoint, model, provider, latency_ms, tokens, cost, status, created_at FROM telemetry_logs ORDER BY created_at DESC LIMIT 15")
    rows = cursor.fetchall()
    return [
        {
            "id": r[0],
            "endpoint": r[1],
            "model": r[2],
            "provider": r[3],
            "latency_ms": r[4],
            "tokens": r[5],
            "cost": r[6],
            "status": r[7],
            "timestamp": str(r[8])[11:19] if r[8] else ""
        }
        for r in rows
    ]

# ─── STATIC SPA MOUNTING ───
app.mount("/css", StaticFiles(directory=os.path.join(FRONTEND_DIR, "css")), name="css")
app.mount("/js", StaticFiles(directory=os.path.join(FRONTEND_DIR, "js")), name="js")

@app.get("/")
def serve_index():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

@app.get("/healthz")
def health_check():
    return {"status": "healthy", "engine": "FastAPI", "version": "2.0.0"}

if __name__ == "__main__":
    import uvicorn
    print("\n🚀 [EASYLEARN AI] Starting FastAPI RAG Server on http://127.0.0.1:8000 ...")
    uvicorn.run("backend.server:app", host="127.0.0.1", port=8000, log_level="info", reload=True)
