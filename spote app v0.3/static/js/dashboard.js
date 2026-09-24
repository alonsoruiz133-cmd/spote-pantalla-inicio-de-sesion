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
console.log("SPOTE dashboard.js versión 2025-09-cu cargado correctamente.");

// ---------------------------------------------------------------------------
// Estado y helpers
// ---------------------------------------------------------------------------
let tasks = [];
let editingTask = null; // objeto de la tarea original mientras se edita, o null si es nueva
let collaborators = []; // colaboradores de la tarea que se está creando/editando
let currentFilter = "todas";
let taskIdPendingDelete = null;

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

function todayIso() {
  const d = new Date();
  const offsetMs = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - offsetMs).toISOString().split("T")[0];
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
      showEmptyMessage("No se pudieron cargar las tareas (error del servidor). Intenta recargar la página.");
      return;
    }
    tasks = await res.json();
    renderTasks();
    loadProgress();
  } catch (err) {
    console.error("No se pudo conectar con el servidor:", err);
    showEmptyMessage("No se pudo conectar con el servidor. Verifica que 'python3 app.py' siga corriendo y recarga la página.");
  }
}

async function loadProgress() {
  try {
    const res = await fetch("/api/progress");
    if (!res.ok) return;
    const data = await res.json();
    const box = el("progressSummary");
    if (data.total === 0) {
      box.style.display = "none";
      return;
    }
    box.style.display = "block";
    el("progressPct").textContent = `${data.porcentaje}%`;
    el("progressLabel").textContent = `Progreso general (${data.completadas}/${data.total} terminadas)`;
    el("progressFill").style.width = `${data.porcentaje}%`;
  } catch (err) {
    console.error("No se pudo cargar el progreso:", err);
  }
}

function showEmptyMessage(text) {
  el("emptyState").textContent = text;
  el("emptyState").style.display = "block";
  el("taskList").innerHTML = "";
}

function filteredTasks() {
  if (currentFilter === "todas") return tasks;
  return tasks.filter((t) => t.type === currentFilter);
}

function renderTasks() {
  const list = el("taskList");
  const empty = el("emptyState");
  list.innerHTML = "";

  const visible = filteredTasks();

  if (tasks.length === 0) {
    empty.textContent = 'No tienes tareas registradas todavía. Crea la primera con el botón "+".';
    empty.style.display = "block";
    return;
  }

  if (visible.length === 0) {
    empty.textContent = "No hay tareas en esta categoría.";
    empty.style.display = "block";
    return;
  }

  empty.style.display = "none";
  for (const task of visible) {
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

  const collaboratorsHtml =
    task.collaborators && task.collaborators.length
      ? `<div class="task-collaborators">👥 ${task.collaborators.map(escapeHtml).join(", ")}</div>`
      : "";

  const reminderHtml = task.reminderAt
    ? `<div class="task-reminder">🔔 Recordatorio: ${formatDate(task.reminderAt)}</div>`
    : "";

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

    ${collaboratorsHtml}
    ${reminderHtml}

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
  card.querySelector('[data-action="delete"]').addEventListener("click", () => openDeleteModal(task.id));
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
// Filtro por tipo (TODAS, TAREAS, EXÁMENES, PROYECTOS)
// ---------------------------------------------------------------------------
function setupFilterTabs() {
  document.querySelectorAll(".filter-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentFilter = btn.getAttribute("data-filter");
      renderTasks();
    });
  });
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
// Colaboradores (chips en el modal de nueva/editar tarea)
// ---------------------------------------------------------------------------
function renderCollaboratorChips() {
  const box = el("collaboratorChips");
  box.innerHTML = collaborators
    .map(
      (name, idx) =>
        `<span class="collab-chip">${escapeHtml(name)} <button type="button" data-idx="${idx}" class="collab-remove" aria-label="Quitar">&times;</button></span>`
    )
    .join("");
  box.querySelectorAll(".collab-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      collaborators.splice(parseInt(btn.getAttribute("data-idx"), 10), 1);
      renderCollaboratorChips();
    });
  });
}

function addCollaboratorFromInput() {
  const input = el("task_collaborator_input");
  const value = input.value.trim();
  if (!value) return;
  if (!collaborators.includes(value)) {
    collaborators.push(value);
    renderCollaboratorChips();
  }
  input.value = "";
}

// ---------------------------------------------------------------------------
// Modal Nueva/Editar tarea
// ---------------------------------------------------------------------------
function clearFieldErrors() {
  ["err_title", "err_subject", "err_deadline"].forEach((id) => {
    el(id).textContent = "";
  });
  el("err_nochange").style.display = "none";
}

function currentFormSnapshot() {
  return {
    title: el("task_title").value.trim(),
    description: el("task_description").value.trim(),
    subject: el("task_subject").value.trim(),
    professor: el("task_professor").value.trim(),
    type: el("task_type").value,
    status: el("task_status").value,
    deadline: el("task_deadline").value,
    complexity: parseInt(el("task_complexity").value, 10),
    collaborators: [...collaborators],
  };
}

function originalSnapshot(task) {
  return {
    title: task.title || "",
    description: task.description || "",
    subject: task.subject || "",
    professor: task.professor || "",
    type: task.type,
    status: task.status,
    deadline: task.deadline,
    complexity: task.complexity,
    collaborators: [...(task.collaborators || [])],
  };
}

function snapshotsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function openTaskModal(task = null) {
  editingTask = task;
  collaborators = task && task.collaborators ? [...task.collaborators] : [];
  clearFieldErrors();
  renderCollaboratorChips();

  el("taskModalTitle").textContent = task ? "Editar Tarea" : "Nueva Tarea";
  el("saveTaskBtn").textContent = task ? "Actualizar" : "Guardar";

  el("task_title").value = task ? task.title : "";
  el("task_description").value = task ? task.description : "";
  el("task_subject").value = task ? task.subject : "";
  el("task_professor").value = task ? task.professor : "";
  el("task_type").value = task ? task.type : "tarea";
  el("task_status").value = task ? task.status : "sin iniciar";
  el("task_deadline").value = task ? task.deadline : "";
  el("task_complexity").value = task ? task.complexity : 5;
  el("complexityValue").textContent = task ? task.complexity : 5;

  // No permitir elegir una fecha que ya pasó.
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
  editingTask = null;
  collaborators = [];
}

function validateTaskForm() {
  const title = el("task_title").value.trim();
  const subject = el("task_subject").value.trim();
  const deadline = el("task_deadline").value;
  const isFutureOrToday = !deadline || deadline >= todayIso();

  const valid = title && subject && deadline && isFutureOrToday;
  el("saveTaskBtn").disabled = !valid;
  return valid;
}

function showValidationErrors() {
  clearFieldErrors();
  let firstInvalid = null;

  if (!el("task_title").value.trim()) {
    el("err_title").textContent = "Campo obligatorio";
    firstInvalid = firstInvalid || el("task_title");
  }
  if (!el("task_subject").value.trim()) {
    el("err_subject").textContent = "Campo obligatorio";
    firstInvalid = firstInvalid || el("task_subject");
  }
  const deadline = el("task_deadline").value;
  if (!deadline) {
    el("err_deadline").textContent = "Campo obligatorio";
    firstInvalid = firstInvalid || el("task_deadline");
  } else if (deadline < todayIso()) {
    el("err_deadline").textContent = "La fecha no puede ser anterior a hoy.";
    firstInvalid = firstInvalid || el("task_deadline");
  }

  if (firstInvalid) firstInvalid.focus();
}

async function saveTask() {
  clearFieldErrors();

  if (!validateTaskForm()) {
    showValidationErrors();
    return;
  }

  // CU Editar tarea, Alternativa 1: si el usuario no hizo ningún cambio,
  // se muestra la leyenda y no se manda nada al servidor.
  if (editingTask) {
    const before = originalSnapshot(editingTask);
    const after = currentFormSnapshot();
    if (snapshotsEqual(before, after)) {
      el("err_nochange").style.display = "block";
      return;
    }
  }

  const payload = currentFormSnapshot();

  const url = editingTask ? `/api/tasks/${editingTask.id}` : "/api/tasks";
  const method = editingTask ? "PUT" : "POST";

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
      // respuesta sin cuerpo JSON
    }

    if (!res.ok) {
      alert((data && data.error) || `No se pudo guardar la tarea (código ${res.status}).`);
      return;
    }

    closeTaskModal();
    await loadTasks();
  } catch (err) {
    console.error("Error guardando la tarea:", err);
    alert("No se pudo conectar con el servidor para guardar la tarea. Revisa que app.py siga corriendo e inténtalo de nuevo.");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = originalLabel;
  }
}

// ---------------------------------------------------------------------------
// Modal de confirmación de eliminación
// ---------------------------------------------------------------------------
function openDeleteModal(taskId) {
  taskIdPendingDelete = taskId;
  el("deleteBackdrop").classList.add("open");
}

function closeDeleteModal() {
  el("deleteBackdrop").classList.remove("open");
  taskIdPendingDelete = null;
}

async function confirmDelete() {
  if (!taskIdPendingDelete) return;
  const id = taskIdPendingDelete;
  const btn = el("confirmDeleteBtn");
  btn.disabled = true;
  try {
    const res = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
    if (!res.ok) {
      alert("No se pudo eliminar la tarea.");
      return;
    }
    closeDeleteModal();
    await loadTasks();
  } catch (err) {
    console.error("Error eliminando la tarea:", err);
    alert("No se pudo conectar con el servidor para eliminar la tarea.");
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  loadTasks();
  setupFilterTabs();

  el("openAddTask").addEventListener("click", () => openTaskModal(null));
  el("closeTaskModal").addEventListener("click", closeTaskModal);
  el("cancelTaskModal").addEventListener("click", closeTaskModal);
  el("saveTaskBtn").addEventListener("click", saveTask);

  ["task_title", "task_subject", "task_deadline"].forEach((id) => {
    el(id).addEventListener("input", () => {
      validateTaskForm();
      clearFieldErrors();
    });
  });

  el("task_complexity").addEventListener("input", (e) => {
    el("complexityValue").textContent = e.target.value;
  });

  el("addCollaboratorBtn").addEventListener("click", addCollaboratorFromInput);
  el("task_collaborator_input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addCollaboratorFromInput();
    }
  });

  el("taskBackdrop").addEventListener("click", (e) => {
    if (e.target === el("taskBackdrop")) closeTaskModal();
  });

  el("cancelDeleteBtn").addEventListener("click", closeDeleteModal);
  el("confirmDeleteBtn").addEventListener("click", confirmDelete);
  el("deleteBackdrop").addEventListener("click", (e) => {
    if (e.target === el("deleteBackdrop")) closeDeleteModal();
  });
});
