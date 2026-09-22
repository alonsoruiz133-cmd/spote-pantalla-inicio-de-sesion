// ---------------------------------------------------------------------------
// Red de seguridad: si algo truena en el navegador, avisa en vez de
// quedarse "sin hacer nada" en silencio.
// ---------------------------------------------------------------------------
window.addEventListener("error", (e) => {
  console.error("Error de JavaScript:", e.error || e.message);
  alert("Ocurrió un error inesperado en la página (" + (e.message || "ver consola") + "). Revisa la consola del navegador (F12) para más detalle.");
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("Promesa rechazada sin manejar:", e.reason);
});

// Si ves este mensaje en la consola (F12 > Console), estás corriendo la
// versión más reciente de dashboard.js. Si NO lo ves, tu navegador está
// usando una copia vieja en caché: haz Ctrl+Shift+R (recarga forzada).
console.log("SPOTE dashboard.js versión 2025-09-sin-ia cargado correctamente.");

// ---------------------------------------------------------------------------
// Estado y helpers
// ---------------------------------------------------------------------------
let tasks = [];
let editingTaskId = null;

const el = (id) => document.getElementById(id);

const MONTHS_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

const STATUS_OPTIONS = [
  { value: "sin iniciar", label: "Sin iniciar" },
  { value: "en proceso", label: "En proceso" },
  { value: "terminado", label: "Terminado" },
];

function formatDate(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return `${d} de ${MONTHS_ES[m - 1]}, ${y}`;
}

function slug(text) {
  return text.toLowerCase().replace(/\s+/g, "-");
}

// ---------------------------------------------------------------------------
// Carga y render de tareas
// ---------------------------------------------------------------------------
async function loadTasks() {
  try {
    const res = await fetch("/api/tasks");
    if (res.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (!res.ok) {
      console.error("Error del servidor al listar tareas:", res.status);
      el("emptyState").textContent = "No se pudieron cargar las tareas (error del servidor). Intenta recargar la página.";
      el("emptyState").style.display = "block";
      el("taskList").innerHTML = "";
      return;
    }
    tasks = await res.json();
    renderTasks();
  } catch (err) {
    // Fallo de red real (p.ej. el servidor no está corriendo).
    console.error("No se pudo conectar con el servidor:", err);
    el("emptyState").textContent = "No se pudo conectar con el servidor. Verifica que 'python3 app.py' siga corriendo y recarga la página.";
    el("emptyState").style.display = "block";
    el("taskList").innerHTML = "";
  }
}

function renderTasks() {
  const list = el("taskList");
  const empty = el("emptyState");
  list.innerHTML = "";

  if (tasks.length === 0) {
    empty.textContent = 'No tienes tareas registradas todavía. Crea la primera con "Nueva tarea".';
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  for (const task of tasks) {
    list.appendChild(renderTaskCard(task));
  }
}

function statusOptionsHtml(currentStatus) {
  return STATUS_OPTIONS.map(
    (opt) =>
      `<option value="${opt.value}" ${opt.value === currentStatus ? "selected" : ""}>${opt.label}</option>`
  ).join("");
}

function renderTaskCard(task) {
  const card = document.createElement("div");
  card.className = `task-card type-${task.type}`;

  const daysLabel =
    task.daysUntilDeadline < 0
      ? `${Math.abs(task.daysUntilDeadline)} días de retraso`
      : `${task.daysUntilDeadline} días`;

  const progress = Math.max(0, Math.min(100, ((7 - task.daysUntilDeadline) / 7) * 100));
  const isUrgent = task.daysUntilDeadline <= 3 && task.status !== "terminado";

  card.innerHTML = `
    <div class="task-top">
      <div>
        <h3 class="task-title">${escapeHtml(task.title)}</h3>
        <p class="task-desc">${escapeHtml(task.description || "")}</p>
      </div>
      <span class="chip chip-priority-${slug(task.priority)}">${task.priority.toUpperCase()}</span>
    </div>

    <div class="task-chips">
      <span class="chip chip-filled" style="background:#e3f2fd;color:#1769aa;border:none;">${escapeHtml(task.subject)}</span>
      ${task.professor ? `<span class="chip">Prof. ${escapeHtml(task.professor)}</span>` : ""}
      <span class="chip">📅 ${formatDate(task.deadline)} (${daysLabel})</span>
      <span class="chip">⚡ Complejidad: ${task.complexity}/10</span>
      <span class="chip chip-type-${task.type}">${task.type.toUpperCase()}</span>
    </div>

    <div class="status-row">
      <label class="status-label" for="status-${task.id}">Estado:</label>
      <select class="status-select chip-status-${slug(task.status)}" id="status-${task.id}" data-action="change-status">
        ${statusOptionsHtml(task.status)}
      </select>
    </div>

    ${
      isUrgent
        ? `<div class="urgency-box">
             <span class="urgency-label">⚠️ Urgencia Alta</span>
             <div class="progress-track">
               <div class="progress-fill ${task.daysUntilDeadline <= 1 ? "crit" : "warn"}" style="width:${progress}%"></div>
             </div>
           </div>`
        : ""
    }

    <div class="task-actions">
      <button class="icon-btn edit" data-action="edit" title="Editar">✏️</button>
      <button class="icon-btn delete" data-action="delete" title="Eliminar">🗑️</button>
    </div>
  `;

  card.querySelector('[data-action="edit"]').addEventListener("click", () => openTaskModal(task));
  card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteTask(task.id));
  card.querySelector('[data-action="change-status"]').addEventListener("change", (e) => {
    changeStatus(task.id, e.target.value, e.target);
  });

  return card;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Cambiar solo el estado desde la tarjeta (sin abrir el modal completo)
// ---------------------------------------------------------------------------
async function changeStatus(taskId, newStatus, selectEl) {
  const previousValue = selectEl.getAttribute("data-previous") || newStatus;
  selectEl.disabled = true;
  try {
    const res = await fetch(`/api/tasks/${taskId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      // sin cuerpo JSON
    }
    if (!res.ok) {
      alert((data && data.error) || "No se pudo actualizar el estado.");
      selectEl.value = previousValue;
      return;
    }
    await loadTasks();
  } catch (err) {
    console.error("Error actualizando el estado:", err);
    alert("No se pudo conectar con el servidor para actualizar el estado.");
    selectEl.value = previousValue;
  } finally {
    selectEl.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Modal Nueva/Editar tarea
// ---------------------------------------------------------------------------
function todayIso() {
  const d = new Date();
  const offsetMs = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - offsetMs).toISOString().split("T")[0];
}

function openTaskModal(task = null) {
  editingTaskId = task ? task.id : null;
  el("taskModalTitle").textContent = task ? "Editar Tarea" : "Nueva Tarea";

  el("task_title").value = task ? task.title : "";
  el("task_description").value = task ? task.description : "";
  el("task_subject").value = task ? task.subject : "";
  el("task_professor").value = task ? task.professor : "";
  el("task_type").value = task ? task.type : "tarea";
  el("task_status").value = task ? task.status : "sin iniciar";
  el("task_deadline").value = task ? task.deadline : "";
  el("task_complexity").value = task ? task.complexity : 5;
  el("complexityValue").textContent = task ? task.complexity : 5;

  // No permitir elegir una fecha que ya pasó. Si estamos editando una
  // tarea cuya fecha ya quedó en el pasado, la dejamos ver ese valor
  // (para no borrar la fecha original), pero no se podrá mover a otra
  // fecha pasada.
  const min = todayIso();
  el("task_deadline").min = min;
  if (!task && el("task_deadline").value && el("task_deadline").value < min) {
    el("task_deadline").value = "";
  }

  validateTaskForm();
  el("taskBackdrop").classList.add("open");
}

function closeTaskModal() {
  el("taskBackdrop").classList.remove("open");
  editingTaskId = null;
}

function validateTaskForm() {
  const deadline = el("task_deadline").value;
  const isFutureOrToday = !deadline || deadline >= todayIso();
  const valid = el("task_title").value.trim() && el("task_subject").value.trim() && deadline && isFutureOrToday;
  el("saveTaskBtn").disabled = !valid;
}

async function saveTask() {
  const payload = {
    title: el("task_title").value.trim(),
    description: el("task_description").value.trim(),
    subject: el("task_subject").value.trim(),
    professor: el("task_professor").value.trim(),
    type: el("task_type").value,
    status: el("task_status").value,
    deadline: el("task_deadline").value,
    complexity: parseInt(el("task_complexity").value, 10),
  };

  if (!payload.title || !payload.subject || !payload.deadline) return;

  if (payload.deadline < todayIso()) {
    alert("La fecha de entrega no puede ser anterior al día de hoy.");
    return;
  }

  const url = editingTaskId ? `/api/tasks/${editingTaskId}` : "/api/tasks";
  const method = editingTaskId ? "PUT" : "POST";

  const saveBtn = el("saveTaskBtn");
  saveBtn.disabled = true;
  const originalLabel = saveBtn.textContent;
  saveBtn.textContent = "Guardando...";

  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      // respuesta sin cuerpo JSON (no debería pasar, pero no truena la UI)
    }

    if (!res.ok) {
      alert((data && data.error) || `No se pudo guardar la tarea (código ${res.status}).`);
      return;
    }

    closeTaskModal();
    await loadTasks();
  } catch (err) {
    // Esto captura fallos de red reales (servidor caído, sin conexión, etc.)
    // que antes fallaban en silencio y hacían parecer que la tarea "no se guardó".
    console.error("Error guardando la tarea:", err);
    alert("No se pudo conectar con el servidor para guardar la tarea. Revisa que app.py siga corriendo e inténtalo de nuevo.");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = originalLabel;
  }
}

async function deleteTask(id) {
  if (!confirm("¿Eliminar esta tarea?")) return;
  try {
    const res = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
    if (!res.ok) {
      alert("No se pudo eliminar la tarea.");
      return;
    }
    await loadTasks();
  } catch (err) {
    console.error("Error eliminando la tarea:", err);
    alert("No se pudo conectar con el servidor para eliminar la tarea.");
  }
}

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  loadTasks();

  el("openAddTask").addEventListener("click", () => openTaskModal(null));
  el("closeTaskModal").addEventListener("click", closeTaskModal);
  el("cancelTaskModal").addEventListener("click", closeTaskModal);
  el("saveTaskBtn").addEventListener("click", saveTask);

  ["task_title", "task_subject", "task_deadline"].forEach((id) => {
    el(id).addEventListener("input", validateTaskForm);
  });

  el("task_complexity").addEventListener("input", (e) => {
    el("complexityValue").textContent = e.target.value;
  });

  el("taskBackdrop").addEventListener("click", (e) => {
    if (e.target === el("taskBackdrop")) closeTaskModal();
  });
});
