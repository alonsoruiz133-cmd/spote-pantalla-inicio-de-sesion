
import hashlib
import hmac
import http.cookies
import json
import mimetypes
import os
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
USERS_FILE = os.path.join(BASE_DIR, "users.json")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
STATIC_DIR = os.path.join(BASE_DIR, "static")

SESSIONS = {}  
FLASH = {}     



def load_users():
    if not os.path.exists(USERS_FILE):
        return {}
    with open(USERS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_users(users):
    with open(USERS_FILE, "w", encoding="utf-8") as f:
        json.dump(users, f, ensure_ascii=False, indent=2)



def hash_password(password: str, salt: bytes | None = None) -> str:
    if salt is None:
        salt = secrets.token_bytes(16)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 200_000)
    return salt.hex() + ":" + derived.hex()


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, hash_hex = stored.split(":")
    except ValueError:
        return False
    salt = bytes.fromhex(salt_hex)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 200_000)
    return hmac.compare_digest(derived.hex(), hash_hex)


def seed_demo_user():
    users = load_users()
    if "demo@spote.mx" not in users:
        users["demo@spote.mx"] = {
            "name": "Estudiante Demo",
            "career": "Ingeniería en Sistemas Computacionales",
            "semester": "5to",
            "password_hash": hash_password("demo123"),
        }
        save_users(users)


seed_demo_user()



def render_template(template_name: str, **context) -> str:
    with open(os.path.join(TEMPLATES_DIR, template_name), "r", encoding="utf-8") as f:
        content = f.read()
    for key, value in context.items():
        content = content.replace("{{ " + key + " }}", str(value))
    return content


def add_flash(session_id: str, category: str, message: str):
    FLASH.setdefault(session_id, []).append((category, message))


def pop_flash_html(session_id: str) -> str:
    messages = FLASH.pop(session_id, [])
    return "".join(
        f'<div class="alert alert-{category}">{message}</div>'
        for category, message in messages
    )



class Handler(BaseHTTPRequestHandler):
    server_version = "SPOTE-stdlib/1.0"


    def get_session_id(self, create: bool = False):
        cookie_header = self.headers.get("Cookie")
        session_id = None
        if cookie_header:
            cookie = http.cookies.SimpleCookie(cookie_header)
            if "session_id" in cookie:
                session_id = cookie["session_id"].value
        if not session_id and create:
            session_id = secrets.token_hex(16)
        return session_id

    def current_user(self):
        session_id = self.get_session_id()
        if session_id and session_id in SESSIONS:
            return SESSIONS[session_id], session_id
        return None, session_id

    def set_session_cookie(self, session_id: str):
        self.send_header("Set-Cookie", f"session_id={session_id}; HttpOnly; Path=/")

  

    def send_redirect(self, location: str, session_id: str | None = None):
        self.send_response(302)
        self.send_header("Location", location)
        if session_id:
            self.set_session_cookie(session_id)
        self.end_headers()

    def send_html(self, html: str, status: int = 200, session_id: str | None = None):
        encoded = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        if session_id:
            self.set_session_cookie(session_id)
        self.end_headers()
        self.wfile.write(encoded)

    def serve_static(self, path: str):
        rel_path = path[len("/static/"):]
        full_path = os.path.normpath(os.path.join(STATIC_DIR, rel_path))
        if not full_path.startswith(STATIC_DIR) or not os.path.isfile(full_path):
            self.send_error(404, "Archivo no encontrado")
            return
        content_type, _ = mimetypes.guess_type(full_path)
        with open(full_path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def parse_form(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8")
        parsed = parse_qs(body)
        return {k: v[0] for k, v in parsed.items()}

   

    def do_GET(self):
        path = urlparse(self.path).path

        if path.startswith("/static/"):
            self.serve_static(path)
            return

        if path == "/":
            user, session_id = self.current_user()
            if user:
                self.send_redirect("/dashboard", session_id)
                return
            if not session_id:
                session_id = self.get_session_id(create=True)
            html = render_template("login.html", flash_messages=pop_flash_html(session_id))
            self.send_html(html, session_id=session_id)
            return

        if path == "/dashboard":
            user, session_id = self.current_user()
            if not user:
                if session_id:
                    add_flash(session_id, "error", "Por favor inicia sesión para continuar.")
                self.send_redirect("/", session_id)
                return
            info = load_users().get(user, {})
            html = render_template(
                "dashboard.html",
                name=info.get("name", user),
                career=info.get("career", ""),
                semester=info.get("semester", ""),
                email=user,
            )
            self.send_html(html)
            return

        if path == "/logout":
            _, session_id = self.current_user()
            if session_id in SESSIONS:
                del SESSIONS[session_id]
            self.send_redirect("/", session_id)
            return

        self.send_error(404, "Página no encontrada")

    

    def do_POST(self):
        path = urlparse(self.path).path
        form = self.parse_form()
        session_id = self.get_session_id(create=True)

        if path == "/login":
            email = form.get("email", "").strip().lower()
            password = form.get("password", "")

            if not email or not password:
                add_flash(session_id, "error", "Por favor completa todos los campos.")
                self.send_redirect("/", session_id)
                return
            if len(password) < 6:
                add_flash(session_id, "error", "La contraseña debe tener al menos 6 caracteres.")
                self.send_redirect("/", session_id)
                return

            user = load_users().get(email)
            if not user or not verify_password(password, user["password_hash"]):
                add_flash(session_id, "error", "Correo o contraseña incorrectos.")
                self.send_redirect("/", session_id)
                return

            SESSIONS[session_id] = email
            self.send_redirect("/dashboard", session_id)
            return

        if path == "/register":
            name = form.get("name", "").strip()
            career = form.get("career", "").strip()
            semester = form.get("semester", "").strip()
            email = form.get("email", "").strip().lower()
            password = form.get("password", "")
            confirm = form.get("confirm_password", "")

            if not all([name, career, semester, email, password, confirm]):
                add_flash(session_id, "error", "Por favor completa todos los campos del registro.")
                self.send_redirect("/", session_id)
                return
            if len(password) < 6:
                add_flash(session_id, "error", "La contraseña debe tener al menos 6 caracteres.")
                self.send_redirect("/", session_id)
                return
            if password != confirm:
                add_flash(session_id, "error", "Las contraseñas no coinciden.")
                self.send_redirect("/", session_id)
                return

            users = load_users()
            if email in users:
                add_flash(session_id, "error", "Ya existe una cuenta con ese correo.")
                self.send_redirect("/", session_id)
                return

            users[email] = {
                "name": name,
                "career": career,
                "semester": semester,
                "password_hash": hash_password(password),
            }
            save_users(users)
            SESSIONS[session_id] = email
            self.send_redirect("/dashboard", session_id)
            return

        if path.startswith("/social-login/"):
            provider = path.split("/social-login/")[1]
            email = f"demo@{provider}.com"
            users = load_users()
            if email not in users:
                users[email] = {
                    "name": f"Usuario de {provider.capitalize()}",
                    "career": "No especificada",
                    "semester": "N/A",
                    "password_hash": hash_password("demo123"),
                }
                save_users(users)
            SESSIONS[session_id] = email
            self.send_redirect("/dashboard", session_id)
            return

        self.send_error(404, "Página no encontrada")

    def log_message(self, format, *args):
        pass  # silencia el log por defecto en la terminal


def run(port: int = 5000):
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"SPOTE corriendo en http://localhost:{port}  (Ctrl+C para detener)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
        server.shutdown()


if __name__ == "__main__":
    run()
