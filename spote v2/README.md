# SPOTE — Sistema para Organización de Tareas y Exámenes

Aplicación 100% Python: **no requiere `pip install` nada**. Solo usa módulos
de la librería estándar de Python (`http.server`, `sqlite3`, `hashlib`,
`json`, etc.). No usa Flask, no usa React, no usa Node.js.

## Cómo correrla

Necesitas tener **Python 3** instalado (verifica con `python3 --version`).
Nada más.

```bash
cd spote_app_stdlib
python3 app.py
```

Luego abre en tu navegador: **http://localhost:5000**

Para detenerla: `Ctrl + C` en la terminal.

## Cuenta de prueba

- Correo: `demo@spote.mx`
- Contraseña: `demo123`

(se crea sola la primera vez que arranca la app, junto con el archivo
`spote.db` donde se guardan usuarios, sesiones y tareas)

## Funcionalidad

- Registro e inicio de sesión (contraseñas con hash PBKDF2, sesiones
  guardadas en SQLite para que sobrevivan a un reinicio del servidor).
- Crear, editar y eliminar tareas/exámenes/proyectos.
- La fecha de entrega no permite elegir un día anterior a hoy (ni desde el
  formulario ni desde la API).
- La **prioridad** (baja/media/alta/crítico) se calcula automáticamente
  según los días restantes y la complejidad declarada.
- El **estado** de cada tarea se puede cambiar en cualquier momento entre:
  - **Sin iniciar**
  - **En proceso**
  - **Terminado**

  Se puede cambiar directamente desde el menú desplegable de cada tarjeta
  (sin necesidad de abrir el formulario de edición), o también al editar
  la tarea completa.

## Estructura

```
spote_app_stdlib/
├── app.py                  # Todo el backend: servidor HTTP, rutas, DB
├── spote.db                 # Se crea sola al primer arranque
├── templates/
│   ├── login.html
│   └── dashboard.html
└── static/
    ├── css/style.css
    └── js/
        ├── main.js          # Lógica de la página de login
        └── dashboard.js     # Lógica de tareas (CRUD + cambio de estado)
```

## Notas de diseño

- **Autenticación**: contraseñas con hash (`hashlib.pbkdf2_hmac`), sesiones
  guardadas en la tabla `sessions` de SQLite (no en memoria), así que
  reiniciar el servidor no cierra la sesión de nadie.
- **Prioridad automática**: se calcula en el backend según días restantes
  y complejidad.
- **Login social (Google/GitHub)**: los botones existen pero no hay OAuth
  configurado; al hacer clic, se muestra un mensaje indicando que no está
  disponible todavía.
