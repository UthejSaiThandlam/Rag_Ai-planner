import os
import hashlib
import sqlite3
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
import jwt
from fastapi import HTTPException, Security, status, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from backend.db import get_db, get_db_connection

SECRET_KEY = os.environ.get("JWT_SECRET", "easylearn-secret-key-production-change-in-env-9827361")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = 30
ADMIN_EMAIL = "uthejsaithandlam@gmail.com"

security = HTTPBearer(auto_error=False)

def is_admin_email(email: Optional[str]) -> bool:
    """Strictly verifies if an email matches the hardcoded superadmin."""
    return bool(email and email.strip().lower() == ADMIN_EMAIL.lower())

def hash_password(password: str) -> str:
    """Secure PBKDF2 HMAC-SHA256 password hashing."""
    salt = os.environ.get("PASSWORD_SALT", "easylearn_secure_salt_2026")
    return hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 100000).hex()

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return hash_password(plain_password) == hashed_password

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS))
    to_encode.update({"exp": expire, "iat": datetime.utcnow()})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

def decode_access_token(token: str) -> Optional[Dict[str, Any]]:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except Exception:
        return None

def get_current_user_optional(
    auth: Optional[HTTPAuthorizationCredentials] = Security(security),
    conn: sqlite3.Connection = Depends(get_db)
) -> Optional[Dict[str, Any]]:
    """Retrieves authenticated user from JWT Bearer token or None."""
    if not auth or not auth.credentials:
        return None

    payload = decode_access_token(auth.credentials)
    if not payload or "sub" not in payload:
        return None

    user_id = str(payload["sub"]).strip()  # Ensure plain str — PyJWT can return non-str types
    if not user_id:
        return None
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    row = cursor.fetchone()
    if not row:
        return None

    user = dict(row)
    if is_admin_email(user.get("email")):
        user["role"] = "admin"
    else:
        user["role"] = user.get("role") or "user"
    return user

def get_current_user(
    current_user: Optional[Dict[str, Any]] = Depends(get_current_user_optional)
) -> Dict[str, Any]:
    """Enforces JWT authentication."""
    if not current_user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid, missing, or expired JWT credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return current_user

def get_current_admin(
    current_user: Dict[str, Any] = Depends(get_current_user)
) -> Dict[str, Any]:
    """Enforces hardcoded superadmin access."""
    if not is_admin_email(current_user.get("email")) and current_user.get("role") != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access forbidden: Hardcoded administrator privileges required."
        )
    return current_user

