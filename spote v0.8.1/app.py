"""
SPOTE - Sistema para Organización de Tareas y Exámenes
Versión SIN DEPENDENCIAS: usa únicamente la librería estándar de Python
(http.server, sqlite3, hashlib, json, etc.). No requiere "pip install" nada.

Cómo correrla:
    python3 app.py
Luego abre: http://localhost:5000

Cuenta demo: demo@spote.mx / demo123
"""

import getpass
import hashlib
import http.cookies
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import threading
import traceback
import uuid
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "spote.db")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
STATIC_DIR = os.path.join(BASE_DIR, "static")
PORT = 5000

DB_LOCK = threading.Lock()


def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def init_db():
    conn = get_db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            career TEXT,
            semester TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            subject TEXT NOT NULL,
            professor TEXT,
            category TEXT,
            type TEXT NOT NULL,
            complexity INTEGER NOT NULL,
            deadline TEXT NOT NULL,
            status TEXT NOT NULL,
            collaborators TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS recordatorio (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            remind_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS progreso (
            user_id TEXT PRIMARY KEY,
            total_tareas INTEGER NOT NULL DEFAULT 0,
            tareas_terminadas INTEGER NOT NULL DEFAULT 0,
            porcentaje REAL NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        """
    )
    conn.commit()

    existing_cols = [r["name"] for r in conn.execute("PRAGMA table_info(tasks)").fetchall()]
    if "collaborators" not in existing_cols:
        conn.execute("ALTER TABLE tasks ADD COLUMN collaborators TEXT")
        conn.commit()
    if "category" not in existing_cols:
        conn.execute("ALTER TABLE tasks ADD COLUMN category TEXT")
        conn.commit()
    if "completed_at" not in existing_cols:
        conn.execute("ALTER TABLE tasks ADD COLUMN completed_at TEXT")
        conn.commit()

    user_cols = [r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()]
    for col in ("first_name", "last_name_paterno", "last_name_materno", "control_number", "phone"):
        if col not in user_cols:
            conn.execute(f"ALTER TABLE users ADD COLUMN {col} TEXT")
    if "role" not in user_cols:
        conn.execute("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'estudiante'")
    if "active" not in user_cols:
        conn.execute("ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_control_number ON users(control_number)")
    conn.commit()

    demo = conn.execute("SELECT id FROM users WHERE email = ?", ("demo@spote.mx",)).fetchone()
    if not demo:
        conn.execute(
            "INSERT INTO users (id, name, email, password_hash, career, semester, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                str(uuid.uuid4()),
                "Estudiante Demo",
                "demo@spote.mx",
                hash_password("demo123"),
                "Ing. en Sistemas Computacionales",
                "5",
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        conn.commit()
    ensure_admin_from_env(conn)
    conn.close()


def upsert_admin(conn, email, password, name):
    row = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if row:
        conn.execute("UPDATE users SET role = 'admin', active = 1 WHERE id = ?", (row["id"],))
        conn.commit()
        return False
    conn.execute(
        "INSERT INTO users (id, name, email, password_hash, created_at, first_name, role, active) "
        "VALUES (?, ?, ?, ?, ?, ?, 'admin', 1)",
        (
            str(uuid.uuid4()),
            name,
            email,
            hash_password(password),
            datetime.now(timezone.utc).isoformat(),
            name,
        ),
    )
    conn.commit()
    return True


def ensure_admin_from_env(conn):
    email = os.environ.get("ADMIN_EMAIL", "").strip().lower()
    password = os.environ.get("ADMIN_PASSWORD", "")
    if not email or not password:
        return
    if not ADMIN_EMAIL_RE.match(email) or len(password) < 8:
        print("ADMIN_EMAIL o ADMIN_PASSWORD no son válidos (la contraseña necesita al menos 8 caracteres).")
        return
    upsert_admin(conn, email, password, "Administrador")


def create_admin_cli():
    print("Crear (o promover) una cuenta de administrador")
    email = input("Correo del administrador: ").strip().lower()
    if not ADMIN_EMAIL_RE.match(email):
        print("Correo no válido.")
        return
    name = " ".join(input("Nombre (Enter para 'Administrador'): ").split()) or "Administrador"
    password = getpass.getpass("Contraseña (mínimo 8 caracteres): ")
    if len(password) < 8:
        print("La contraseña necesita al menos 8 caracteres.")
        return
    if password != getpass.getpass("Confirma la contraseña: "):
        print("Las contraseñas no coinciden.")
        return
    conn = get_db()
    created = upsert_admin(conn, email, password, name)
    conn.close()
    if created:
        print("Administrador creado. Ya puedes iniciar sesión con ese correo.")
    else:
        print("Esa cuenta ya existía: solo se le asignó el rol de administrador (su contraseña no cambió).")


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000)
    return f"{salt}${dk.hex()}"


def verify_password(password, stored):
    try:
        salt, hash_hex = stored.split("$", 1)
    except ValueError:
        return False
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000)
    return secrets.compare_digest(dk.hex(), hash_hex)


def create_session(user_id):
    session_id = secrets.token_hex(24)
    conn = get_db()
    conn.execute(
        "INSERT INTO sessions (id, user_id, created_at) VALUES (?, ?, ?)",
        (session_id, user_id, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    conn.close()
    return session_id


VALID_STATUSES = ("sin iniciar", "en proceso", "terminado")


CAREERS = (
    "Ingeniería en Sistemas Computacionales",
    "Ingeniería Mecatrónica",
    "Ingeniería Mecánica",
    "Ingeniería en Materiales",
    "Ingeniería Eléctrica",
    "Ingeniería Electrónica",
    "Ingeniería Industrial",
    "Ingeniería en Gestión Empresarial",
    "Distancia Industrial (77)",
    "Distancia Industrial (99)",
    "Distancia Sistemas",
    "Distancia Gestión",
)

PERSON_NAME_RE = re.compile(r"^[A-Za-zÀ-ÖØ-öø-ÿ\s.'’-]+$")
CONTROL_NUMBER_RE = re.compile(r"^C?\d{8}$")
INSTITUTIONAL_EMAIL_RE = re.compile(r"^([a-z]?)(\d{8})@saltillo\.tecnm\.mx$")
PHONE_RE = re.compile(r"^\d{10}$")
ADMIN_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def now_local_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def days_until(deadline_str):
    deadline = datetime.strptime(deadline_str, "%Y-%m-%d").date()
    return (deadline - date.today()).days


def is_past_date(deadline_str):
    try:
        deadline = datetime.strptime(deadline_str, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return True
    return deadline < date.today()


def compute_priority(complexity, deadline_str):
    d = days_until(deadline_str)
    if d > 14:
        return "baja"
    if d <= 1 or complexity >= 9:
        return "crítico"
    if d <= 3 or complexity >= 7:
        return "alta"
    if d <= 7 or complexity >= 4:
        return "media"
    return "baja"


PROFESSOR_NAME_RE = re.compile(r"^[A-Za-zÀ-ÖØ-öø-ÿÑñ\s.'\-]*$")


REQUIRED_FIELDS = (
    ("title", "Título"),
    ("subject", "Materia"),
    ("professor", "Profesor"),
    ("category", "Categoría"),
    ("deadline", "Fecha de entrega"),
)


def missing_required_fields(data):
    return [label for key, label in REQUIRED_FIELDS if not str(data.get(key) or "").strip()]


def is_valid_professor_name(value):
    return bool(PROFESSOR_NAME_RE.match(value or ""))


def serialize_task(row):
    d = days_until(row["deadline"])
    keys = row.keys()
    return {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"] or "",
        "subject": row["subject"],
        "professor": row["professor"] or "",
        "category": row["category"] or "" if "category" in keys else "",
        "type": row["type"],
        "complexity": row["complexity"],
        "deadline": row["deadline"],
        "status": row["status"],
        "completedAt": row["completed_at"] if "completed_at" in keys else None,
        "priority": compute_priority(row["complexity"], row["deadline"]),
        "daysUntilDeadline": d,
        "collaborators": collaborators_from_json(row["collaborators"]) if "collaborators" in keys else [],
        "reminderAt": row["reminder_at"] if "reminder_at" in keys else None,
    }


def fetch_task_with_reminder(conn, task_id):
    return conn.execute(
        "SELECT t.*, r.remind_at AS reminder_at FROM tasks t "
        "LEFT JOIN recordatorio r ON r.task_id = t.id "
        "WHERE t.id = ?",
        (task_id,),
    ).fetchone()


def fetch_tasks_with_reminder(conn, user_id):
    return conn.execute(
        "SELECT t.*, r.remind_at AS reminder_at FROM tasks t "
        "LEFT JOIN recordatorio r ON r.task_id = t.id "
        "WHERE t.user_id = ? ORDER BY t.deadline ASC",
        (user_id,),
    ).fetchall()


def split_collaborator(item):
    if isinstance(item, dict):
        name = str(item.get("name") or "").strip()
        control = str(item.get("controlNumber") or item.get("control_number") or "").strip().upper()
    else:
        name = str(item).strip()
        control = ""
    return name, control


def parse_collaborators(data):
    raw = data.get("collaborators", [])
    if isinstance(raw, str):
        raw = [c.strip() for c in raw.split(",") if c.strip()]
    if not isinstance(raw, list):
        return []

    conn = get_db()
    result, seen = [], set()
    for item in raw:
        name, control = split_collaborator(item)
        if control:
            row = conn.execute(
                "SELECT name, control_number FROM users WHERE control_number = ?", (control,)
            ).fetchone()
            if row:
                name, control = row["name"], row["control_number"]
            else:
                control = ""
        elif name:
            rows = conn.execute(
                "SELECT name, control_number FROM users WHERE name = ?", (name,)
            ).fetchall()
            if len(rows) == 1 and rows[0]["control_number"]:
                control = rows[0]["control_number"]
        if not name:
            continue
        key = (name, control)
        if key in seen:
            continue
        seen.add(key)
        result.append({"name": name, "controlNumber": control})
    conn.close()
    return result[:20]


def collaborators_to_json(lst):
    return json.dumps(lst, ensure_ascii=False)


def collaborators_from_json(raw):
    if not raw:
        return []
    try:
        val = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(val, list):
        return []
    result = []
    for item in val:
        name, control = split_collaborator(item)
        if name:
            result.append({"name": name, "controlNumber": control})
    return result


def compute_reminder_date(deadline_str):
    deadline = datetime.strptime(deadline_str, "%Y-%m-%d").date()
    today = date.today()
    remind = deadline - timedelta(days=2)
    if remind < today:
        remind = today if deadline >= today else deadline
    return remind.isoformat()


def upsert_reminder(conn, task_id, user_id, deadline_str):
    conn.execute("DELETE FROM recordatorio WHERE task_id = ?", (task_id,))
    conn.execute(
        "INSERT INTO recordatorio (id, task_id, user_id, remind_at, created_at) VALUES (?,?,?,?,?)",
        (
            str(uuid.uuid4()),
            task_id,
            user_id,
            compute_reminder_date(deadline_str),
            datetime.now(timezone.utc).isoformat(),
        ),
    )


def recalc_progress(conn, user_id):
    total = conn.execute("SELECT COUNT(*) AS c FROM tasks WHERE user_id = ?", (user_id,)).fetchone()["c"]
    done = conn.execute(
        "SELECT COUNT(*) AS c FROM tasks WHERE user_id = ? AND status = 'terminado'", (user_id,)
    ).fetchone()["c"]
    pct = round((done / total) * 100, 1) if total else 0.0
    pendientes = total - done
    conn.execute(
        "INSERT INTO progreso (user_id, total_tareas, tareas_terminadas, porcentaje, updated_at) "
        "VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(user_id) DO UPDATE SET "
        "total_tareas=excluded.total_tareas, tareas_terminadas=excluded.tareas_terminadas, "
        "porcentaje=excluded.porcentaje, updated_at=excluded.updated_at",
        (user_id, total, done, pct, datetime.now(timezone.utc).isoformat()),
    )
    return {"total": total, "completadas": done, "pendientes": pendientes, "porcentaje": pct}


def load_template(name):
    with open(os.path.join(TEMPLATES_DIR, name), "r", encoding="utf-8") as f:
        return f.read()


def render(name, **tokens):
    html = load_template(name)
    for key, value in tokens.items():
        html = html.replace("{{" + key + "}}", value)
    return html


def escape_html(text):
    return (
        (text or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def flash_html(messages):
    if not messages:
        return ""
    items = "".join(
        f'<div class="flash flash-{cat}">{escape_html(msg)}</div>' for cat, msg in messages
    )
    return f'<div class="flash-messages">{items}</div>'


ROUTES = []


def route(method, pattern):
    regex = re.compile("^" + pattern + "$")

    def decorator(func):
        ROUTES.append((method, regex, func))
        return func

    return decorator


class Request:
    def __init__(self, handler, method, path, query, params):
        self.handler = handler
        self.method = method
        self.path = path
        self.query = query
        self.params = params
        self.cookies = http.cookies.SimpleCookie()
        cookie_header = handler.headers.get("Cookie")
        if cookie_header:
            self.cookies.load(cookie_header)

        self._body = None
        length = int(handler.headers.get("Content-Length", 0))
        if length:
            self._body = handler.rfile.read(length)

    def form(self):
        if not self._body:
            return {}
        parsed = parse_qs(self._body.decode("utf-8"))
        return {k: v[0] for k, v in parsed.items()}

    def json(self):
        if not self._body:
            return {}
        return json.loads(self._body.decode("utf-8"))

    def get_cookie(self, name):
        if name in self.cookies:
            return self.cookies[name].value
        return None

    def current_user_id(self):
        session_id = self.get_cookie("session_id")
        if not session_id:
            return None
        conn = get_db()
        row = conn.execute(
            "SELECT s.user_id FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.id = ? AND u.active = 1",
            (session_id,),
        ).fetchone()
        conn.close()
        return row["user_id"] if row else None


class Response:
    def __init__(self, status=200, body=b"", headers=None, is_json=False, is_text=True):
        self.status = status
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.body = body
        self.headers = headers or {}
        if is_json:
            self.headers.setdefault("Content-Type", "application/json; charset=utf-8")
        elif is_text and "Content-Type" not in self.headers:
            self.headers.setdefault("Content-Type", "text/html; charset=utf-8")
        self.cookies_to_set = []

    def set_cookie(self, name, value, max_age=None, delete=False):
        parts = [f"{name}={value}", "Path=/", "HttpOnly"]
        if delete:
            parts.append("Max-Age=0")
        elif max_age is not None:
            parts.append(f"Max-Age={max_age}")
        self.cookies_to_set.append("; ".join(parts))


def redirect(location, flash_messages=None):
    resp = Response(status=302, headers={"Location": location})
    if flash_messages is not None:
        payload = json.dumps(flash_messages)
        resp.set_cookie("flash", _encode_cookie_value(payload))
    return resp


def _encode_cookie_value(text):
    return text.encode("utf-8").hex()


def _decode_cookie_value(hex_text):
    try:
        return bytes.fromhex(hex_text).decode("utf-8")
    except Exception:
        return None


def json_response(data, status=200):
    return Response(status=status, body=json.dumps(data), is_json=True)


def require_login(req):
    return req.current_user_id()


def get_user_role(user_id):
    conn = get_db()
    row = conn.execute("SELECT role FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    return row["role"] if row else None


def home_path(user_id):
    return "/admin" if get_user_role(user_id) == "admin" else "/dashboard"


def require_admin(req):
    user_id = req.current_user_id()
    if not user_id:
        return None, json_response({"error": "No autenticado"}, 401)
    if get_user_role(user_id) != "admin":
        return None, json_response({"error": "No tienes permiso para esta acción."}, 403)
    return user_id, None


@route("GET", r"/")
def index(req):
    user_id = req.current_user_id()
    if user_id:
        return redirect(home_path(user_id))
    return redirect("/login")


@route("GET", r"/login")
def login_page(req):
    user_id = req.current_user_id()
    if user_id:
        return redirect(home_path(user_id))

    messages = []
    raw = req.get_cookie("flash")
    resp = Response(body=render("login.html", FLASH=""))
    if raw:
        decoded = _decode_cookie_value(raw)
        if decoded:
            try:
                messages = json.loads(decoded)
            except Exception:
                messages = []
    resp.body = render("login.html", FLASH=flash_html(messages)).encode("utf-8")
    if raw:
        resp.set_cookie("flash", "", delete=True)
    return resp


@route("POST", r"/login")
def do_login(req):
    form = req.form()
    email = form.get("email", "").strip().lower()
    password = form.get("password", "")

    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    conn.close()

    if not user or not verify_password(password, user["password_hash"]):
        return redirect("/login", flash_messages=[["error", "Correo o contraseña incorrectos."]])

    if not user["active"]:
        return redirect(
            "/login",
            flash_messages=[["error", "Tu cuenta está desactivada. Contacta al administrador."]],
        )

    session_id = create_session(user["id"])

    resp = redirect("/admin" if user["role"] == "admin" else "/dashboard")
    resp.set_cookie("session_id", session_id)
    resp.set_cookie("user_name", _encode_cookie_value(user["name"]))
    return resp


@route("POST", r"/register")
def register(req):
    form = req.form()
    first_name = " ".join(form.get("first_name", "").split())
    last_p = " ".join(form.get("last_name_p", "").split())
    last_m = " ".join(form.get("last_name_m", "").split())
    career = form.get("career", "").strip()
    semester = form.get("semester", "").strip()
    control = form.get("control_number", "").strip().upper()
    phone = form.get("phone", "").strip()
    email = form.get("email", "").strip().lower()
    confirm_email = form.get("confirm_email", "").strip().lower()
    password = form.get("password", "")
    confirm = form.get("confirm_password", "")

    required = (
        ("Nombre", first_name),
        ("Apellido paterno", last_p),
        ("Apellido materno", last_m),
        ("Carrera", career),
        ("Semestre", semester),
        ("Número de control", control),
        ("Número de teléfono", phone),
        ("Correo electrónico", email),
        ("Confirmar correo electrónico", confirm_email),
        ("Contraseña", password),
        ("Confirmar contraseña", confirm),
    )
    errors = []
    missing = [label for label, value in required if not value]
    if missing:
        errors.append("Falta rellenar: " + ", ".join(missing) + ".")
    else:
        for label, value in (("Nombre", first_name), ("Apellido paterno", last_p), ("Apellido materno", last_m)):
            if not PERSON_NAME_RE.match(value):
                errors.append(f"{label}: solo se permiten letras.")
        if career not in CAREERS:
            errors.append("Selecciona una carrera de la lista.")
        if not semester.isdigit() or not 1 <= int(semester) <= 14:
            errors.append("Selecciona un semestre válido.")
        if not CONTROL_NUMBER_RE.match(control):
            errors.append("Número de control: debe tener 8 dígitos, o la letra C seguida de 8 dígitos.")
        if not PHONE_RE.match(phone):
            errors.append("Número de teléfono: debe tener 10 dígitos.")
        institutional = INSTITUTIONAL_EMAIL_RE.match(email)
        if not institutional:
            errors.append(
                "Correo electrónico: debe ser institucional, con el formato número_de_control@saltillo.tecnm.mx."
            )
        elif CONTROL_NUMBER_RE.match(control) and institutional.group(2) != control[-8:]:
            errors.append("El correo institucional debe corresponder a tu número de control.")
        elif email != confirm_email:
            errors.append("Los correos electrónicos no coinciden.")
        if len(password) < 6:
            errors.append("La contraseña debe tener al menos 6 caracteres.")
        elif password != confirm:
            errors.append("Las contraseñas no coinciden.")

    conn = get_db()
    if not errors:
        if conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone():
            errors.append("Ya existe una cuenta con ese correo.")
        if conn.execute("SELECT id FROM users WHERE control_number = ?", (control,)).fetchone():
            errors.append("Ya existe una cuenta con ese número de control.")
    if errors:
        conn.close()
        return redirect("/login?register=1", flash_messages=[["error", m] for m in errors])

    full_name = f"{first_name} {last_p} {last_m}"
    conn.execute(
        "INSERT INTO users (id, name, email, password_hash, career, semester, created_at, "
        "first_name, last_name_paterno, last_name_materno, control_number, phone) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            str(uuid.uuid4()),
            full_name,
            email,
            hash_password(password),
            career,
            semester,
            datetime.now(timezone.utc).isoformat(),
            first_name,
            last_p,
            last_m,
            control,
            phone,
        ),
    )
    conn.commit()
    conn.close()

    return redirect(
        "/login",
        flash_messages=[["success", "Cuenta creada correctamente. Inicia sesión con tu correo y contraseña."]],
    )


@route("GET", r"/logout")
def logout(req):
    session_id = req.get_cookie("session_id")
    if session_id:
        conn = get_db()
        conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        conn.commit()
        conn.close()
    resp = redirect("/login")
    resp.set_cookie("session_id", "", delete=True)
    resp.set_cookie("user_name", "", delete=True)
    return resp


@route("GET", r"/dashboard")
def dashboard(req):
    user_id = req.current_user_id()
    if not user_id:
        return redirect("/login")
    if get_user_role(user_id) == "admin":
        return redirect("/admin")
    raw_name = req.get_cookie("user_name")
    name = _decode_cookie_value(raw_name) if raw_name else "Usuario"
    return Response(
        body=render("dashboard.html", USER_NAME=escape_html(name), TODAY=date.today().isoformat())
    )



def clean_text(value):
    return " ".join(str(value or "").split())


def validate_admin_form(data, existing=None):
    role = str(data.get("role") or "estudiante").strip()
    if role not in ("estudiante", "admin"):
        return ["Rol no válido."], None

    first = clean_text(data.get("first_name"))
    last_p = clean_text(data.get("last_name_p"))
    last_m = clean_text(data.get("last_name_m"))
    career = str(data.get("career") or "").strip()
    semester = str(data.get("semester") or "").strip()
    control = str(data.get("control_number") or "").strip().upper()
    phone = str(data.get("phone") or "").strip()
    email = str(data.get("email") or "").strip().lower()
    password = str(data.get("password") or "")

    creating = existing is None
    legacy = (not creating) and existing["role"] == "estudiante" and not existing["control_number"]

    if role == "admin":
        required = [("Nombre", first), ("Apellido paterno", last_p), ("Correo electrónico", email)]
    elif legacy:
        required = [("Nombre", first), ("Correo electrónico", email)]
    else:
        required = [
            ("Nombre", first),
            ("Apellido paterno", last_p),
            ("Apellido materno", last_m),
            ("Carrera", career),
            ("Semestre", semester),
            ("Número de control", control),
            ("Número de teléfono", phone),
            ("Correo electrónico", email),
        ]
    if creating:
        required.append(("Contraseña", password))

    missing = [label for label, value in required if not value]
    if missing:
        return ["Falta rellenar: " + ", ".join(missing) + "."], None

    errors = []
    for label, value in (("Nombre", first), ("Apellido paterno", last_p), ("Apellido materno", last_m)):
        if value and not PERSON_NAME_RE.match(value):
            errors.append(f"{label}: solo se permiten letras.")

    if role == "estudiante":
        old_career = (existing["career"] or "") if existing else ""
        if career and career not in CAREERS and career != old_career:
            errors.append("Selecciona una carrera de la lista.")
        if semester and (not semester.isdigit() or not 1 <= int(semester) <= 14):
            errors.append("Selecciona un semestre válido.")
        if control and not CONTROL_NUMBER_RE.match(control):
            errors.append("Número de control: debe tener 8 dígitos, o la letra C seguida de 8 dígitos.")
        if phone and not PHONE_RE.match(phone):
            errors.append("Número de teléfono: debe tener 10 dígitos.")
        if not (existing and email == existing["email"]):
            institutional = INSTITUTIONAL_EMAIL_RE.match(email)
            if not institutional:
                errors.append(
                    "Correo electrónico: debe ser institucional, con el formato número_de_control@saltillo.tecnm.mx."
                )
            elif control and CONTROL_NUMBER_RE.match(control) and institutional.group(2) != control[-8:]:
                errors.append("El correo institucional debe corresponder al número de control.")
    else:
        career = semester = control = phone = ""
        if not ADMIN_EMAIL_RE.match(email):
            errors.append("Correo electrónico: formato no válido.")

    if password and len(password) < 6:
        errors.append("La contraseña debe tener al menos 6 caracteres.")

    if errors:
        return errors, None

    return [], {
        "role": role,
        "first_name": first,
        "last_name_p": last_p,
        "last_name_m": last_m,
        "name": " ".join(part for part in (first, last_p, last_m) if part),
        "career": career or None,
        "semester": semester or None,
        "control_number": control or None,
        "phone": phone or None,
        "email": email,
        "password": password,
    }


def duplicate_user_errors(conn, email, control, exclude_id=None):
    errors = []
    row = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if row and row["id"] != exclude_id:
        errors.append("Ya existe una cuenta con ese correo.")
    if control:
        row = conn.execute("SELECT id FROM users WHERE control_number = ?", (control,)).fetchone()
        if row and row["id"] != exclude_id:
            errors.append("Ya existe una cuenta con ese número de control.")
    return errors


def other_active_admins(conn, exclude_id):
    return conn.execute(
        "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND id != ?", (exclude_id,)
    ).fetchone()["c"]


def serialize_admin_user(row, admin_id):
    return {
        "id": row["id"],
        "name": row["name"],
        "firstName": row["first_name"] or "",
        "lastNameP": row["last_name_paterno"] or "",
        "lastNameM": row["last_name_materno"] or "",
        "career": row["career"] or "",
        "semester": row["semester"] or "",
        "controlNumber": row["control_number"] or "",
        "phone": row["phone"] or "",
        "email": row["email"],
        "role": row["role"],
        "active": bool(row["active"]),
        "createdAt": row["created_at"],
        "tasksCount": row["tasks_count"] if "tasks_count" in row.keys() else 0,
        "isSelf": row["id"] == admin_id,
    }


USER_WITH_TASKS_SQL = (
    "SELECT u.*, (SELECT COUNT(*) FROM tasks t WHERE t.user_id = u.id) AS tasks_count FROM users u"
)


@route("GET", r"/admin")
def admin_page(req):
    user_id = req.current_user_id()
    if not user_id:
        return redirect("/login")
    if get_user_role(user_id) != "admin":
        return redirect("/dashboard")
    raw_name = req.get_cookie("user_name")
    name = _decode_cookie_value(raw_name) if raw_name else "Administrador"
    career_options = "".join(
        f'<option value="{escape_html(c)}">{escape_html(c)}</option>' for c in CAREERS
    )
    semester_options = "".join(
        f'<option value="{i}">{i}° Semestre</option>' for i in range(1, 15)
    )
    return Response(
        body=render(
            "admin.html",
            USER_NAME=escape_html(name),
            CAREER_OPTIONS=career_options,
            SEMESTER_OPTIONS=semester_options,
        )
    )


@route("GET", r"/api/admin/users")
def api_admin_list_users(req):
    admin_id, error = require_admin(req)
    if error:
        return error

    q = (req.query.get("q", [""])[0] or "").strip()
    career = (req.query.get("career", [""])[0] or "").strip()
    status = (req.query.get("status", [""])[0] or "").strip()
    role = (req.query.get("role", [""])[0] or "").strip()

    sql = USER_WITH_TASKS_SQL + " WHERE 1 = 1"
    params = []
    if q:
        sql += " AND (u.name LIKE ? OR u.email LIKE ? OR u.control_number LIKE ? OR u.phone LIKE ?)"
        params += [f"%{q}%"] * 4
    if career:
        sql += " AND u.career = ?"
        params.append(career)
    if status == "activo":
        sql += " AND u.active = 1"
    elif status == "desactivado":
        sql += " AND u.active = 0"
    if role in ("estudiante", "admin"):
        sql += " AND u.role = ?"
        params.append(role)
    sql += " ORDER BY u.name COLLATE NOCASE"

    conn = get_db()
    rows = conn.execute(sql, params).fetchall()
    counts = conn.execute(
        "SELECT COUNT(*) AS total, "
        "COALESCE(SUM(active = 1), 0) AS activos, "
        "COALESCE(SUM(active = 0), 0) AS desactivados, "
        "COALESCE(SUM(role = 'admin'), 0) AS admins FROM users"
    ).fetchone()
    conn.close()
    return json_response(
        {
            "users": [serialize_admin_user(r, admin_id) for r in rows],
            "summary": {
                "total": counts["total"],
                "activos": counts["activos"],
                "desactivados": counts["desactivados"],
                "admins": counts["admins"],
            },
        }
    )


@route("POST", r"/api/admin/users")
def api_admin_create_user(req):
    admin_id, error = require_admin(req)
    if error:
        return error

    errors, clean = validate_admin_form(req.json())
    conn = get_db()
    if not errors:
        errors = duplicate_user_errors(conn, clean["email"], clean["control_number"])
    if errors:
        conn.close()
        return json_response({"errors": errors}, 400)

    user_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO users (id, name, email, password_hash, career, semester, created_at, "
        "first_name, last_name_paterno, last_name_materno, control_number, phone, role, active) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
        (
            user_id,
            clean["name"],
            clean["email"],
            hash_password(clean["password"]),
            clean["career"],
            clean["semester"],
            datetime.now(timezone.utc).isoformat(),
            clean["first_name"],
            clean["last_name_p"],
            clean["last_name_m"],
            clean["control_number"],
            clean["phone"],
            clean["role"],
        ),
    )
    conn.commit()
    row = conn.execute(USER_WITH_TASKS_SQL + " WHERE u.id = ?", (user_id,)).fetchone()
    conn.close()
    return json_response(serialize_admin_user(row, admin_id), 201)


@route("PUT", r"/api/admin/users/(?P<user_id>[\w-]+)")
def api_admin_update_user(req):
    admin_id, error = require_admin(req)
    if error:
        return error

    target_id = req.params["user_id"]
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (target_id,)).fetchone()
    if not row:
        conn.close()
        return json_response({"error": "Usuario no encontrado."}, 404)

    errors, clean = validate_admin_form(req.json(), existing=row)
    if not errors:
        if target_id == admin_id and clean["role"] != row["role"]:
            errors.append("No puedes cambiar tu propio rol.")
        if row["role"] == "admin" and clean["role"] != "admin" and other_active_admins(conn, target_id) == 0:
            errors.append("Debe quedar al menos un administrador activo.")
        errors += duplicate_user_errors(conn, clean["email"], clean["control_number"], exclude_id=target_id)
    if errors:
        conn.close()
        return json_response({"errors": errors}, 400)

    password_hash = hash_password(clean["password"]) if clean["password"] else row["password_hash"]
    conn.execute(
        "UPDATE users SET name = ?, email = ?, password_hash = ?, career = ?, semester = ?, "
        "first_name = ?, last_name_paterno = ?, last_name_materno = ?, control_number = ?, phone = ?, role = ? "
        "WHERE id = ?",
        (
            clean["name"],
            clean["email"],
            password_hash,
            clean["career"],
            clean["semester"],
            clean["first_name"],
            clean["last_name_p"],
            clean["last_name_m"],
            clean["control_number"],
            clean["phone"],
            clean["role"],
            target_id,
        ),
    )
    if clean["password"] or clean["email"] != row["email"]:
        keep = req.get_cookie("session_id") if target_id == admin_id else ""
        conn.execute("DELETE FROM sessions WHERE user_id = ? AND id != ?", (target_id, keep or ""))
    conn.commit()
    updated = conn.execute(USER_WITH_TASKS_SQL + " WHERE u.id = ?", (target_id,)).fetchone()
    conn.close()
    return json_response(serialize_admin_user(updated, admin_id))


@route("POST", r"/api/admin/users/(?P<user_id>[\w-]+)/status")
def api_admin_set_user_status(req):
    admin_id, error = require_admin(req)
    if error:
        return error

    target_id = req.params["user_id"]
    active = bool(req.json().get("active"))
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (target_id,)).fetchone()
    if not row:
        conn.close()
        return json_response({"error": "Usuario no encontrado."}, 404)
    if not active:
        if target_id == admin_id:
            conn.close()
            return json_response({"error": "No puedes desactivar tu propia cuenta."}, 400)
        if row["role"] == "admin" and other_active_admins(conn, target_id) == 0:
            conn.close()
            return json_response({"error": "Debe quedar al menos un administrador activo."}, 400)

    conn.execute("UPDATE users SET active = ? WHERE id = ?", (1 if active else 0, target_id))
    if not active:
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (target_id,))
    conn.commit()
    updated = conn.execute(USER_WITH_TASKS_SQL + " WHERE u.id = ?", (target_id,)).fetchone()
    conn.close()
    return json_response(serialize_admin_user(updated, admin_id))


@route("DELETE", r"/api/admin/users/(?P<user_id>[\w-]+)")
def api_admin_delete_user(req):
    admin_id, error = require_admin(req)
    if error:
        return error

    target_id = req.params["user_id"]
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (target_id,)).fetchone()
    if not row:
        conn.close()
        return json_response({"error": "Usuario no encontrado."}, 404)
    if target_id == admin_id:
        conn.close()
        return json_response({"error": "No puedes eliminar tu propia cuenta."}, 400)
    if row["role"] == "admin" and other_active_admins(conn, target_id) == 0:
        conn.close()
        return json_response({"error": "Debe quedar al menos un administrador activo."}, 400)

    tasks_deleted = conn.execute(
        "SELECT COUNT(*) AS c FROM tasks WHERE user_id = ?", (target_id,)
    ).fetchone()["c"]
    conn.execute("DELETE FROM users WHERE id = ?", (target_id,))
    conn.commit()
    conn.close()
    return json_response({"deleted": True, "tasks": tasks_deleted})


@route("GET", r"/api/tasks")
def api_list_tasks(req):
    user_id = require_login(req)
    if not user_id:
        return json_response({"error": "No autenticado"}, 401)

    conn = get_db()
    rows = fetch_tasks_with_reminder(conn, user_id)
    conn.close()
    return json_response([serialize_task(r) for r in rows])


@route("GET", r"/api/progress")
def api_get_progress(req):
    user_id = require_login(req)
    if not user_id:
        return json_response({"error": "No autenticado"}, 401)

    conn = get_db()
    progress = recalc_progress(conn, user_id)
    conn.commit()
    conn.close()
    return json_response(progress)


@route("GET", r"/api/users/search")
def api_search_users(req):
    user_id = require_login(req)
    if not user_id:
        return json_response({"error": "No autenticado"}, 401)

    q = (req.query.get("q", [""])[0] or "").strip()
    if not q:
        return json_response([])

    conn = get_db()
    rows = conn.execute(
        "SELECT id, name, career, semester, control_number FROM users "
        "WHERE (name LIKE ? OR control_number LIKE ?) AND id != ? ORDER BY name LIMIT 8",
        (f"%{q}%", f"%{q}%", user_id),
    ).fetchall()
    conn.close()
    return json_response(
        [
            {
                "id": r["id"],
                "name": r["name"],
                "career": r["career"] or "",
                "semester": r["semester"] or "",
                "controlNumber": r["control_number"] or "",
            }
            for r in rows
        ]
    )


@route("POST", r"/api/tasks")
def api_create_task(req):
    user_id = require_login(req)
    if not user_id:
        return json_response({"error": "No autenticado"}, 401)

    data = req.json()
    missing = missing_required_fields(data)
    if missing:
        return json_response({"error": "Falta rellenar: " + ", ".join(missing) + "."}, 400)

    professor = (data.get("professor") or "").strip()
    if not is_valid_professor_name(professor):
        return json_response({"error": "Solo se permiten letras en este campo."}, 400)

    if is_past_date(data["deadline"]):
        return json_response(
            {"error": "La fecha de entrega no puede ser anterior al día de hoy."}, 400
        )

    task_id = str(uuid.uuid4())
    complexity = int(data.get("complexity", 5))
    task_type = data.get("type", "tarea")
    status = data.get("status", "sin iniciar")
    collaborators = parse_collaborators(data)
    if status not in VALID_STATUSES:
        return json_response({"error": "Estado inválido."}, 400)

    conn = get_db()
    conn.execute(
        "INSERT INTO tasks (id, user_id, title, description, subject, professor, category, type, "
        "complexity, deadline, status, collaborators, created_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            task_id,
            user_id,
            data["title"],
            data.get("description", ""),
            data["subject"],
            professor,
            data["category"].strip(),
            task_type,
            complexity,
            data["deadline"],
            status,
            collaborators_to_json(collaborators),
            datetime.now(timezone.utc).isoformat(),
            now_local_str() if status == "terminado" else None,
        ),
    )
    upsert_reminder(conn, task_id, user_id, data["deadline"])
    recalc_progress(conn, user_id)
    conn.commit()
    row = fetch_task_with_reminder(conn, task_id)
    conn.close()
    return json_response(serialize_task(row), 201)


@route("PUT", r"/api/tasks/(?P<task_id>[\w-]+)")
def api_update_task(req):
    user_id = require_login(req)
    if not user_id:
        return json_response({"error": "No autenticado"}, 401)

    task_id = req.params["task_id"]
    data = req.json()

    conn = get_db()
    row = conn.execute("SELECT * FROM tasks WHERE id = ? AND user_id = ?", (task_id, user_id)).fetchone()
    if not row:
        conn.close()
        return json_response({"error": "Tarea no encontrada"}, 404)

    complexity = int(data.get("complexity", row["complexity"]))
    deadline = data.get("deadline", row["deadline"])
    status = data.get("status", row["status"])
    professor = data.get("professor", row["professor"])
    collaborators = parse_collaborators(data) if "collaborators" in data else collaborators_from_json(row["collaborators"])

    if any(k in data for k in ("title", "subject", "professor", "category", "deadline")):
        merged = {
            "title": data.get("title", row["title"]),
            "subject": data.get("subject", row["subject"]),
            "professor": data.get("professor", row["professor"]),
            "category": data.get("category", row["category"] if "category" in row.keys() else ""),
            "deadline": deadline,
        }
        missing = missing_required_fields(merged)
        if missing:
            conn.close()
            return json_response({"error": "Falta rellenar: " + ", ".join(missing) + "."}, 400)

    if not is_valid_professor_name(professor):
        conn.close()
        return json_response({"error": "Solo se permiten letras en este campo."}, 400)

    if deadline != row["deadline"] and is_past_date(deadline):
        conn.close()
        return json_response(
            {"error": "La fecha de entrega no puede ser anterior al día de hoy."}, 400
        )

    if status not in VALID_STATUSES:
        conn.close()
        return json_response({"error": "Estado inválido."}, 400)

    if status == "terminado":
        completed_at = row["completed_at"] if row["status"] == "terminado" and row["completed_at"] else now_local_str()
    else:
        completed_at = None

    conn.execute(
        "UPDATE tasks SET title=?, description=?, subject=?, professor=?, category=?, type=?, "
        "complexity=?, deadline=?, status=?, collaborators=?, completed_at=? WHERE id=?",
        (
            data.get("title", row["title"]),
            data.get("description", row["description"]),
            data.get("subject", row["subject"]),
            professor,
            data.get("category", row["category"] if "category" in row.keys() else ""),
            data.get("type", row["type"]),
            complexity,
            deadline,
            status,
            collaborators_to_json(collaborators),
            completed_at,
            task_id,
        ),
    )
    if deadline != row["deadline"]:
        upsert_reminder(conn, task_id, user_id, deadline)
    recalc_progress(conn, user_id)
    conn.commit()

    row = fetch_task_with_reminder(conn, task_id)
    conn.close()
    return json_response(serialize_task(row))


@route("DELETE", r"/api/tasks/(?P<task_id>[\w-]+)")
def api_delete_task(req):
    user_id = require_login(req)
    if not user_id:
        return json_response({"error": "No autenticado"}, 401)

    task_id = req.params["task_id"]
    conn = get_db()
    conn.execute("DELETE FROM tasks WHERE id = ? AND user_id = ?", (task_id, user_id))
    recalc_progress(conn, user_id)
    conn.commit()
    conn.close()
    return json_response({"ok": True})


class SpoteHandler(BaseHTTPRequestHandler):
    server_version = "SpoteHTTP/1.0"

    def log_message(self, fmt, *args):
        print(f'[{self.log_date_time_string()}] {self.address_string()} - {fmt % args}')

    def _dispatch(self, method, head_only=False):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if method == "GET" and path.startswith("/static/"):
            return self._serve_static(path, head_only=head_only)

        for route_method, regex, func in ROUTES:
            if route_method != method:
                continue
            match = regex.match(path)
            if match:
                req = Request(self, method, path, query, match.groupdict())
                try:
                    with DB_LOCK:
                        resp = func(req)
                except Exception:
                    traceback.print_exc()
                    resp = json_response(
                        {"error": "Ocurrió un error interno en el servidor. Revisa la consola donde corre app.py."},
                        500,
                    )
                return self._send(resp, head_only=head_only)

        self._send(Response(status=404, body="<h1>404 - No encontrado</h1>"), head_only=head_only)

    def _serve_static(self, path, head_only=False):
        rel_path = path[len("/static/"):]
        full_path = os.path.normpath(os.path.join(STATIC_DIR, rel_path))
        if not full_path.startswith(STATIC_DIR) or not os.path.isfile(full_path):
            self._send(Response(status=404, body="Not found"), head_only=head_only)
            return
        content_type, _ = mimetypes.guess_type(full_path)
        with open(full_path, "rb") as f:
            body = f.read()
        self._send(
            Response(
                body=body,
                headers={
                    "Content-Type": content_type or "application/octet-stream",
                    "Cache-Control": "no-store, no-cache, must-revalidate",
                },
            ),
            head_only=head_only,
        )

    def _send(self, resp, head_only=False):
        self.send_response(resp.status)
        resp.headers.setdefault("Cache-Control", "no-store, no-cache, must-revalidate")
        for key, value in resp.headers.items():
            self.send_header(key, value)
        for cookie in resp.cookies_to_set:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", str(len(resp.body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(resp.body)

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("GET", head_only=True)

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")


def main():
    init_db()
    if len(sys.argv) > 1 and sys.argv[1] == "--crear-admin":
        create_admin_cli()
        return
    server = ThreadingHTTPServer(("0.0.0.0", PORT), SpoteHandler)
    print("=" * 60)
    print("  SPOTE corriendo en http://localhost:%d" % PORT)
    print("  Cuenta demo: demo@spote.mx / demo123")
    print("  Administrador: python3 app.py --crear-admin")
    print("  Presiona Ctrl+C para detener el servidor")
    print("=" * 60)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")


if __name__ == "__main__":
    main()
