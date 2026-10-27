# SPOTE — Sistema para Organización de Tareas y Exámenes

Aplicación 100% Python: **no requiere `pip install` nada**. Solo usa módulos
de la librería estándar de Python (`http.server`, `sqlite3`, `hashlib`,
`json`, etc.).

## Cómo correrla

```bash
cd spote_app_stdlib
python3 app.py
```

Abre **http://localhost:5000**. Cuenta demo: `demo@spote.mx` / `demo123`.

## Funcionalidad (según las plantillas de casos de uso y de prueba)

### Agregar tarea nueva (GT, GT1, GT2)
- Botón flotante **"+"**. Modal con Título, Descripción, Materia, Profesor,
  Categoría, Tipo y Fecha de entrega (ya **sin** barra de complejidad).
- **Materia** y **Categoría** son listas desplegables (combo box) ordenadas alfabéticamente.
  Categorías: Equipo, Examen de unidad, Individual, Pareja, Segundas.
- Las cajas de texto (Título, Descripción, Profesor y colaborador) no aceptan espacios
  al inicio: hay que escribir primero una letra o carácter.
- Campos obligatorios: **Título, Materia, Profesor, Categoría y Fecha de entrega**
  (también se validan en el servidor).
- El campo **Profesor** solo acepta letras (con acentos/ñ, espacios,
  guiones y apóstrofos); si se escriben números se marca el error "Solo se
  permiten letras en este campo" y "GUARDAR" queda deshabilitado.
- "GUARDAR" permanece deshabilitado si falta algún obligatorio. Al pasar el
  cursor (o tocar el botón en pantallas táctiles) aparece un **globo de texto**
  con la lista exacta de campos por rellenar, y se marca "Favor de llenar este
  campo" junto a cada campo vacío.
- Al guardar: la tarea aparece en la lista, se genera un **recordatorio**
  automático y se actualiza el contador de **tareas pendientes**.

### Editar tarea (GT3, GT4, GT5)
- Ícono de lápiz abre el modal con el botón "Actualizar".
- Si no se modifica nada, se muestra "No se ha realizado ningún cambio" y no
  se manda nada al servidor.
- Si se borra un campo obligatorio (p. ej. el Título, Profesor o Categoría),
  se resalta el campo, se muestra "Favor de llenar este campo", "Actualizar"
  queda deshabilitado y el globo de texto indica qué campos faltan.

### Eliminar tarea (GT6, GT7)
- Ícono de papelera abre la ventana "¿Estás seguro de eliminar?" con los
  botones **CONFIRMAR** / **CANCELAR**.
- CONFIRMAR: la tarea desaparece de la lista y el contador de pendientes
  disminuye. CANCELAR: el modal se cierra y la tarea sigue igual.

### Visualizar avance (GT8)
- Barra de **progreso general** (gráfico de barra simple) con el porcentaje
  de tareas terminadas, mostrada al comienzo de la lista.
- Pestañas TODAS / TAREAS / EXÁMENES / PROYECTOS para filtrar.
- Contador de tareas pendientes junto al título.

### Añadir colaborador (GT9)
- En el modal de tarea, el campo "Añadir colaborador" busca en tiempo real
  entre los alumnos **registrados** (tabla `users`) por nombre.
- Al escribir aparecen resultados con nombre, carrera y semestre; se
  selecciona uno y se oprime **"Invitar"** para confirmar.
- El colaborador aparece de inmediato como chip en el formulario y, al
  guardar, queda asociado a la tarea.

### Estado de la tarea
Sin iniciar / En proceso / Terminado, editable desde el menú desplegable de
cada tarjeta o desde el modal de edición.

## Estructura

```
spote_app_stdlib/
├── app.py                  # Backend: servidor HTTP, rutas, DB, reglas de negocio
├── spote.db                 # Se crea sola al primer arranque
├── templates/
│   ├── login.html
│   └── dashboard.html
└── static/
    ├── css/style.css
    └── js/
        ├── main.js
        └── dashboard.js
```

## Tablas en `spote.db`

- `users`, `sessions` — cuentas y sesiones activas.
- `tasks` — tareas/exámenes/proyectos (incluye `category` y `collaborators`
  como JSON).
- `recordatorio` — un recordatorio automático por tarea.
- `progreso` — snapshot del progreso de cada alumno (total, terminadas,
  pendientes, porcentaje), recalculado en cada creación, edición o
  eliminación de tareas.

## Endpoints de la API

- `GET/POST /api/tasks`, `PUT/DELETE /api/tasks/<id>`
- `GET /api/progress` — progreso y contador de pendientes.
- `GET /api/users/search?q=...` — búsqueda de alumnos para colaboradores.

## Pestañas Calendario e Historial

- El menú inferior tiene tres pestañas: **Tareas**, **Calendario** e **Historial**.
- **Calendario:** vista mensual con las tareas pasadas y futuras. Los días con tareas llevan
  puntos de color (azul pendiente, rojo vencida sin completar, verde completada). Al pasar
  el mouse (o tocar, en pantallas táctiles) sobre uno de esos días se muestra el detalle de la tarea.
- **Historial:** al marcar una tarea como "Terminado" desaparece del dashboard de Tareas, pero no se
  elimina: queda en el Historial con su fecha de entrega, la fecha y hora en que se completó, si se
  entregó a tiempo y todos los demás datos. Desde ahí se puede "Reabrir" para devolverla al dashboard; antes de hacerlo se pide confirmación mostrando el nombre de la tarea.
- La base de datos agrega automáticamente la columna `completed_at` a las bases ya existentes.

## Inicio de sesión y registro

- Solo se puede entrar con correo y contraseña (se quitaron los botones de Google y GitHub), por lo que
  hay que registrarse primero. La cuenta demo (`demo@spote.mx` / `demo123`) se sigue creando al arrancar.
- Registro: todos los campos son obligatorios: Nombre(s), Apellido paterno, Apellido materno, Carrera
  (lista desplegable), Semestre, Número de control, Número de teléfono, Correo, Confirmar correo,
  Contraseña y Confirmar contraseña.
- Reglas: nombres solo con letras; número de control de 8 dígitos o la letra C seguida de 8 dígitos (si no empieza con C, el máximo es 8 caracteres);
  teléfono de 10 dígitos; el correo debe ser institucional (`número_de_control@saltillo.tecnm.mx`) y corresponder al número de control; los correos deben coincidir; contraseña de mínimo 6 caracteres y coincidente.
  Se validan en el navegador y también en el servidor (`app.py`). No se permiten correos ni números de control repetidos.
- El botón "Crear cuenta" permanece deshabilitado hasta que todo esté correcto; al pasar el cursor
  (o tocarlo) muestra qué campos faltan o qué hay que corregir.
- Al crear la cuenta se regresa a la pantalla de inicio de sesión con un mensaje de éxito; no se inicia sesión
  automáticamente. Al cerrar sesión también se regresa al inicio de sesión.
- Las bases de datos existentes se actualizan solas con las columnas nuevas (nombre y apellidos, número de control y teléfono).

## Colaboradores, prioridad y carreras

- El buscador de colaboradores acepta nombre o número de control; muestra el número de control en los resultados,
  en las etiquetas del formulario, en la tarjeta del dashboard y en los detalles del calendario e historial.
- Prioridad: si faltan más de 14 días para la entrega la tarea es de prioridad **baja** (color verde);
  las demás reglas (crítica, alta, media) se mantienen.
- Semestres disponibles: 1 a 14. Se agregaron las carreras Distancia Industrial (77), Distancia Industrial (99),
  Distancia Sistemas y Distancia Gestión.

## Administración de usuarios

- Hay un rol de **administrador**. Al iniciar sesión, un administrador entra a `/admin` (panel de usuarios) y un
  alumno entra al dashboard de tareas. Cada ruta de administración revisa el rol en el servidor.
- Crear el primer administrador (cualquiera de las dos formas):
  - `python3 app.py --crear-admin` (pregunta correo, nombre y contraseña de al menos 8 caracteres), o
  - con variables de entorno al arrancar: `ADMIN_EMAIL=correo ADMIN_PASSWORD=contraseña python3 app.py`
    (en Windows PowerShell: `$env:ADMIN_EMAIL="correo"; $env:ADMIN_PASSWORD="contraseña"; python app.py`).
  Si el correo ya existe, solo se le asigna el rol de administrador y su contraseña no cambia.
- El panel muestra una tabla con búsqueda (nombre, número de control, correo o teléfono), filtros por carrera, rol y
  estado, y contadores de usuarios.
- **Agregar / Editar:** mismo formulario y mismas reglas que el registro (correo institucional, número de control, etc.).
  Para un administrador solo se piden nombre, apellido paterno, correo y contraseña. Al editar, la contraseña es opcional.
  Las cuentas antiguas sin número de control se pueden completar poco a poco.
- **Desactivar / Activar:** bloquea o devuelve el acceso sin borrar nada (se cierra su sesión abierta).
  Un usuario desactivado ve el mensaje "Tu cuenta está desactivada" al intentar entrar.
- **Eliminar:** borrado definitivo de la cuenta, sus tareas, recordatorios y progreso. Pide escribir ELIMINAR.
  El correo y el número de control quedan libres. En las tareas de otros alumnos donde era colaborador solo queda su nombre como texto.
- Protecciones: el administrador no puede eliminar, desactivar ni cambiar el rol de su propia cuenta, y siempre debe quedar un administrador activo.
  Al cambiar el correo o la contraseña de un usuario se cierran sus sesiones abiertas.
