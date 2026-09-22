"""
SPOTE - Sistema para Organización de Tareas y Exámenes


Cómo correrla:
    python3 app.py
Luego abre: http://localhost:5000

Cuenta demo: demo@spote.mx / demo123
"""

import hashlib
import http.cookies
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import threading
import traceback
import uuid
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "spote.db")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
STATIC_DIR = os.path.join(BASE_DIR, "static")
PORT = 5000

# Todas las peticiones que tocan la base de datos se serializan con este
# candado. Esta app está pensada para uso personal/local (pocos usuarios
# simultáneos), así que renunciar a la concurrencia real es un precio muy
# bajo a cambio de eliminar por completo los errores de tipo
# "database is locked" que SQLite puede lanzar si dos peticiones llegan
# al mismo tiempo (algo que sí puede pasar incluso con un solo usuario:
# el navegador puede disparar más de una petición en paralelo).
DB_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# Base de datos
# ---------------------------------------------------------------------------
def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # WAL + busy_timeout hacen que, aun si algo más tocara el archivo
    # (un backup, un antivirus, OneDrive/Dropbox sincronizando, etc.),
    # SQLite espere en vez de fallar de inmediato.
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
            type TEXT NOT NULL,
            complexity INTEGER NOT NULL,
            deadline TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        """
    )
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
    conn.close()


# ---------------------------------------------------------------------------
# Contraseñas (PBKDF2-HMAC-SHA256, sin dependencias externas)
# ---------------------------------------------------------------------------
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
    """Crea una sesión y la guarda en la base de datos (no en memoria), para
    que reiniciar el servidor no cierre la sesión de nadie ni dé la
    impresión de que las tareas guardadas 'desaparecieron'."""
    session_id = secrets.token_hex(24)
    conn = get_db()
    conn.execute(
        "INSERT INTO sessions (id, user_id, created_at) VALUES (?, ?, ?)",
        (session_id, user_id, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    conn.close()
    return session_id


# ---------------------------------------------------------------------------
# Lógica de negocio (prioridad automática según fecha/complejidad)
# ---------------------------------------------------------------------------
VALID_STATUSES = ("sin iniciar", "en proceso", "terminado")


def days_until(deadline_str):
    deadline = datetime.strptime(deadline_str, "%Y-%m-%d").date()
    return (deadline - date.today()).days


def is_past_date(deadline_str):
    """True si la fecha ya pasó (antes de hoy). Hoy mismo SÍ se permite."""
    try:
        deadline = datetime.strptime(deadline_str, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return True  # fecha inválida/ausente: se trata como no permitida
    return deadline < date.today()


def compute_priority(complexity, deadline_str):
    d = days_until(deadline_str)
    if d <= 1 or complexity >= 9:
        return "crítico"
    if d <= 3 or complexity >= 7:
        return "alta"
    if d <= 7 or complexity >= 4:
        return "media"
    return "baja"


def serialize_task(row):
    d = days_until(row["deadline"])
    return {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"] or "",
        "subject": row["subject"],
        "professor": row["professor"] or "",
        "type": row["type"],
        "complexity": row["complexity"],
        "deadline": row["deadline"],
        "status": row["status"],
        "priority": compute_priority(row["complexity"], row["deadline"]),
        "daysUntilDeadline": d,
    }


# ---------------------------------------------------------------------------
# Utilidades HTTP (cookies, plantillas, helpers)
# ---------------------------------------------------------------------------
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
        row = conn.execute("SELECT user_id FROM sessions WHERE id = ?", (session_id,)).fetchone()
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
    # Simple percent-style encoding safe for cookie values
    return text.encode("utf-8").hex()


def _decode_cookie_value(hex_text):
    try:
        return bytes.fromhex(hex_text).decode("utf-8")
    except Exception:
        return None


def json_response(data, status=200):
    return Response(status=status, body=json.dumps(data), is_json=True)


def require_login(req):
    """Devuelve user_id o None. El caller decide qué hacer si es None."""
    return req.current_user_id()


# ---------------------------------------------------------------------------
# Rutas de páginas
# ---------------------------------------------------------------------------
@route("GET", r"/")
def index(req):
    if req.current_user_id():
        return redirect("/dashboard")
    return redirect("/login")


@route("GET", r"/login")
def login_page(req):
    if req.current_user_id():
        return redirect("/dashboard")

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

    session_id = create_session(user["id"])

    resp = redirect("/dashboard")
    resp.set_cookie("session_id", session_id)
    resp.set_cookie("user_name", _encode_cookie_value(user["name"]))
    return resp


@route("POST", r"/register")
def register(req):
    form = req.form()
    name = form.get("name", "").strip()
    career = form.get("career", "").strip()
    semester = form.get("semester", "").strip()
    email = form.get("email", "").strip().lower()
    password = form.get("password", "")
    confirm = form.get("confirm_password", "")

    if not all([name, email, password, semester]):
        return redirect("/login", flash_messages=[["error", "Por favor completa todos los campos obligatorios."]])
    if len(password) < 6:
        return redirect("/login", flash_messages=[["error", "La contraseña debe tener al menos 6 caracteres."]])
    if password != confirm:
        return redirect("/login", flash_messages=[["error", "Las contraseñas no coinciden."]])

    conn = get_db()
    existing = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if existing:
        conn.close()
        return redirect("/login", flash_messages=[["error", "Ya existe una cuenta con ese correo."]])

    user_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO users (id, name, email, password_hash, career, semester, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (user_id, name, email, hash_password(password), career, semester, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    conn.close()

    session_id = create_session(user_id)

    resp = redirect("/dashboard")
    resp.set_cookie("session_id", session_id)
    resp.set_cookie("user_name", _encode_cookie_value(name))
    return resp


@route("POST", r"/social-login/(?P<provider>\w+)")
def social_login(req):
    provider = req.params["provider"]
    return redirect(
        "/login",
        flash_messages=[["error", f"El inicio de sesión con {provider.capitalize()} no está disponible todavía."]],
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
    raw_name = req.get_cookie("user_name")
    name = _decode_cookie_value(raw_name) if raw_name else "Usuario"
    return Response(
        body=render("dashboard.html", USER_NAME=escape_html(name), TODAY=date.today().isoformat())
    )


# ---------------------------------------------------------------------------
# API de tareas
# ---------------------------------------------------------------------------
@route("GET", r"/api/tasks")
def api_list_tasks(req):
    user_id = require_login(req)
    if not user_id:
        return json_response({"error": "No autenticado"}, 401)

    conn = get_db()
    rows = conn.execute("SELECT * FROM tasks WHERE user_id = ? ORDER BY deadline ASC", (user_id,)).fetchall()
    conn.close()
    return json_response([serialize_task(r) for r in rows])


@route("POST", r"/api/tasks")
def api_create_task(req):
    user_id = require_login(req)
    if not user_id:
        return json_response({"error": "No autenticado"}, 401)

    data = req.json()
    if not all(data.get(f) for f in ("title", "deadline", "subject")):
        return json_response({"error": "Título, materia y fecha de entrega son obligatorios."}, 400)

    if is_past_date(data["deadline"]):
        return json_response(
            {"error": "La fecha de entrega no puede ser anterior al día de hoy."}, 400
        )

    task_id = str(uuid.uuid4())
    complexity = int(data.get("complexity", 5))
    task_type = data.get("type", "tarea")
    status = data.get("status", "sin iniciar")
    if status not in VALID_STATUSES:
        return json_response({"error": "Estado inválido."}, 400)

    conn = get_db()
    conn.execute(
        "INSERT INTO tasks (id, user_id, title, description, subject, professor, type, "
        "complexity, deadline, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (
            task_id,
            user_id,
            data["title"],
            data.get("description", ""),
            data["subject"],
            data.get("professor", ""),
            task_type,
            complexity,
            data["deadline"],
            status,
            datetime.now(timezone.utc).isoformat(),
        ),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
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

    if is_past_date(deadline):
        conn.close()
        return json_response(
            {"error": "La fecha de entrega no puede ser anterior al día de hoy."}, 400
        )

    if status not in VALID_STATUSES:
        conn.close()
        return json_response({"error": "Estado inválido."}, 400)

    conn.execute(
        "UPDATE tasks SET title=?, description=?, subject=?, professor=?, type=?, "
        "complexity=?, deadline=?, status=? WHERE id=?",
        (
            data.get("title", row["title"]),
            data.get("description", row["description"]),
            data.get("subject", row["subject"]),
            data.get("professor", row["professor"]),
            data.get("type", row["type"]),
            complexity,
            deadline,
            status,
            task_id,
        ),
    )
    conn.commit()

    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
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
    conn.commit()
    conn.close()
    return json_response({"ok": True})


# ---------------------------------------------------------------------------
# Servidor HTTP
# ---------------------------------------------------------------------------
class SpoteHandler(BaseHTTPRequestHandler):
    server_version = "SpoteHTTP/1.0"

    def log_message(self, fmt, *args):
        print(f'[{self.log_date_time_string()}] {self.address_string()} - {fmt % args}')

    def _dispatch(self, method, head_only=False):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        # Archivos estáticos
        if method == "GET" and path.startswith("/static/"):
            return self._serve_static(path, head_only=head_only)

        for route_method, regex, func in ROUTES:
            if route_method != method:
                continue
            match = regex.match(path)
            if match:
                req = Request(self, method, path, query, match.groupdict())
                try:
                    # Serializamos el acceso a la base de datos entre
                    # peticiones para evitar por completo los errores de
                    # "database is locked" cuando llegan dos peticiones
                    # casi al mismo tiempo (p.ej. el navegador guardando
                    # una tarea mientras recarga la lista).
                    with DB_LOCK:
                        resp = func(req)
                except Exception:  # noqa: BLE001
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
        # Cache-Control: no-store evita que el navegador reutilice una copia
        # vieja de este archivo (CSS/JS) después de que actualicemos la app.
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
        # Algunos navegadores (o extensiones) mandan HEAD antes de un GET
        # real, p.ej. al precargar un script. Sin este método, Python
        # respondía "501 Unsupported method", lo que algunos navegadores
        # interpretan como que el recurso no existe y no vuelven a pedirlo.
        self._dispatch("GET", head_only=True)

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")


def main():
    init_db()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), SpoteHandler)
    print("=" * 60)
    print("  SPOTE corriendo en http://localhost:%d" % PORT)
    print("  Cuenta demo: demo@spote.mx / demo123")
    print("  Presiona Ctrl+C para detener el servidor")
    print("=" * 60)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")


if __name__ == "__main__":
    main()
