window.addEventListener("error", (e) => {
  console.error("Error de JavaScript:", e.error || e.message);
  alert("Ocurrió un error inesperado en la página (" + (e.message || "ver consola") + "). Revisa la consola del navegador (F12) para más detalle.");
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("Promesa rechazada sin manejar:", e.reason);
});

console.log("SPOTE dashboard.js versión 2025-10-colaboradores-control cargado correctamente.");

let tasks = [];
let editingTask = null;
let collaborators = [];
let currentFilter = "todas";
let taskIdPendingDelete = null;
let taskIdPendingReopen = null;
let collaboratorSearchTimer = null;
let currentView = "tareas";
let calendarMonth = { year: new Date().getFullYear(), month: new Date().getMonth() };
let calTooltipTimer = null;

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

const PROFESSOR_NAME_RE = /^[A-Za-zÀ-ÖØ-öø-ÿÑñ\s.'-]*$/;

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
    renderCalendar();
    renderHistory();
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
    } else {
      box.style.display = "block";
      el("progressPct").textContent = `${data.porcentaje}%`;
      el("progressLabel").textContent = `Progreso general (${data.completadas}/${data.total} terminadas)`;
      el("progressFill").style.width = `${data.porcentaje}%`;
    }

    const badge = el("pendingBadge");
    if (data.total === 0) {
      badge.style.display = "none";
    } else {
      badge.style.display = "inline-block";
      badge.textContent = `${data.pendientes} pendiente${data.pendientes === 1 ? "" : "s"}`;
    }
  } catch (err) {
    console.error("No se pudo cargar el progreso:", err);
  }
}

function showEmptyMessage(text) {
  el("emptyState").textContent = text;
  el("emptyState").style.display = "block";
  el("taskList").innerHTML = "";
}

function activeTasks() {
  return tasks.filter((t) => t.status !== "terminado");
}

function completedTasks() {
  return tasks.filter((t) => t.status === "terminado");
}

function filteredTasks() {
  const active = activeTasks();
  if (currentFilter === "todas") return active;
  return active.filter((t) => t.type === currentFilter);
}

function renderTasks() {
  const list = el("taskList");
  const empty = el("emptyState");
  list.innerHTML = "";

  const visible = filteredTasks();

  if (activeTasks().length === 0) {
    empty.textContent =
      tasks.length === 0
        ? 'No tienes tareas registradas todavía. Crea la primera con el botón "+".'
        : "No tienes tareas pendientes. Las que ya completaste están en la pestaña Historial.";
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
      ? `<div class="task-collaborators">👥 ${task.collaborators.map(collaboratorLabel).join(", ")}</div>`
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
      ${task.category ? `<span class="chip">${escapeHtml(task.category)}</span>` : ""}
      <span class="chip">📅 ${formatDate(task.deadline)} (${daysLabel})</span>
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

function collaboratorLabel(c) {
  return `${escapeHtml(c.name)}${c.controlNumber ? ` (${escapeHtml(c.controlNumber)})` : ""}`;
}

function isCollaboratorAdded(user) {
  return collaborators.some((c) =>
    user.controlNumber ? c.controlNumber === user.controlNumber : !c.controlNumber && c.name === user.name
  );
}

function renderCollaboratorChips() {
  const box = el("collaboratorChips");
  box.innerHTML = collaborators
    .map(
      (c, idx) =>
        `<span class="collab-chip">${collaboratorLabel(c)} <button type="button" data-idx="${idx}" class="collab-remove" aria-label="Quitar">&times;</button></span>`
    )
    .join("");
  box.querySelectorAll(".collab-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      collaborators.splice(parseInt(btn.getAttribute("data-idx"), 10), 1);
      renderCollaboratorChips();
    });
  });
}

function clearCollaboratorResults() {
  el("collaboratorResults").innerHTML = "";
  el("collaboratorResults").classList.remove("open");
}

async function searchCollaborators(query) {
  if (!query) {
    clearCollaboratorResults();
    return;
  }
  try {
    const res = await fetch(`/api/users/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) return;
    const results = await res.json();
    renderCollaboratorResults(results);
  } catch (err) {
    console.error("Error buscando alumnos:", err);
  }
}

function renderCollaboratorResults(results) {
  const box = el("collaboratorResults");
  const available = results.filter((u) => !isCollaboratorAdded(u));

  if (available.length === 0) {
    box.innerHTML = `<div class="collab-result-empty">Sin resultados</div>`;
    box.classList.add("open");
    return;
  }

  box.innerHTML = available
    .map(
      (u, idx) => `
        <div class="collab-result-item">
          <div>
            <div class="collab-result-name">${escapeHtml(u.name)}</div>
            <div class="collab-result-meta">${u.controlNumber ? `N.° de control: ${escapeHtml(u.controlNumber)} · ` : ""}${escapeHtml(u.career || "")}${u.semester ? ` · ${escapeHtml(u.semester)}° semestre` : ""}</div>
          </div>
          <button type="button" class="btn btn-primary btn-small" data-index="${idx}">Invitar</button>
        </div>`
    )
    .join("");
  box.classList.add("open");

  box.querySelectorAll("button[data-index]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const user = available[parseInt(btn.getAttribute("data-index"), 10)];
      if (user && !isCollaboratorAdded(user)) {
        collaborators.push({ name: user.name, controlNumber: user.controlNumber || "" });
        renderCollaboratorChips();
      }
      el("task_collaborator_input").value = "";
      clearCollaboratorResults();

      const originalText = btn.textContent;
      btn.textContent = "✓ Añadido";
    });
  });
}

function setupCollaboratorSearch() {
  const input = el("task_collaborator_input");
  input.addEventListener("input", () => {
    clearTimeout(collaboratorSearchTimer);
    const value = input.value.trim();
    collaboratorSearchTimer = setTimeout(() => searchCollaborators(value), 250);
  });
  input.addEventListener("blur", () => {
    setTimeout(clearCollaboratorResults, 200);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".collaborator-search-wrap")) {
      clearCollaboratorResults();
    }
  });
}

function clearFieldErrors() {
  ["err_title", "err_subject", "err_deadline", "err_professor", "err_category"].forEach((id) => {
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
    category: el("task_category").value.trim(),
    type: el("task_type").value,
    status: el("task_status").value,
    deadline: el("task_deadline").value,
    collaborators: collaborators.map((c) => ({ name: c.name, controlNumber: c.controlNumber || "" })),
  };
}

function originalSnapshot(task) {
  return {
    title: task.title || "",
    description: task.description || "",
    subject: task.subject || "",
    professor: task.professor || "",
    category: task.category || "",
    type: task.type,
    status: task.status,
    deadline: task.deadline,
    collaborators: (task.collaborators || []).map((c) => ({ name: c.name, controlNumber: c.controlNumber || "" })),
  };
}

function snapshotsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function setupNoLeadingSpaces(ids) {
  ids.forEach((id) => {
    const input = el(id);
    const isTextarea = input.tagName === "TEXTAREA";

    input.addEventListener("keydown", (e) => {
      const blocked = e.key === " " || (isTextarea && e.key === "Enter");
      if (!blocked) return;
      const before = input.value.slice(0, input.selectionStart);
      if (before.trim() === "") e.preventDefault();
    });

    input.addEventListener("input", () => {
      const stripped = input.value.replace(/^\s+/, "");
      if (stripped !== input.value) {
        const removed = input.value.length - stripped.length;
        const pos = Math.max(0, (input.selectionStart || 0) - removed);
        input.value = stripped;
        input.setSelectionRange(pos, pos);
      }
    });
  });
}

function setSelectValue(id, value) {
  const sel = el(id);
  const v = value || "";
  sel.querySelectorAll("option[data-legacy]").forEach((o) => o.remove());
  if (v && ![...sel.options].some((o) => o.value === v)) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    opt.setAttribute("data-legacy", "1");
    sel.appendChild(opt);
  }
  sel.value = v;
}

function openTaskModal(task = null) {
  editingTask = task;
  collaborators = task && task.collaborators ? task.collaborators.map((c) => ({ ...c })) : [];
  clearFieldErrors();
  clearCollaboratorResults();
  renderCollaboratorChips();

  el("taskModalTitle").textContent = task ? "Editar Tarea" : "Nueva Tarea";
  el("saveTaskBtn").textContent = task ? "Actualizar" : "Guardar";

  el("task_title").value = task ? task.title : "";
  el("task_description").value = task ? task.description : "";
  setSelectValue("task_subject", task ? task.subject : "");
  el("task_professor").value = task ? task.professor : "";
  setSelectValue("task_category", task ? task.category : "");
  el("task_type").value = task ? task.type : "tarea";
  el("task_status").value = task ? task.status : "sin iniciar";
  el("task_deadline").value = task ? task.deadline : "";
  el("task_collaborator_input").value = "";

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

function getFormProblems() {
  const missing = [];
  const invalid = [];

  if (!el("task_title").value.trim()) missing.push("Título");
  if (!el("task_subject").value.trim()) missing.push("Materia");

  const professor = el("task_professor").value.trim();
  if (!professor) missing.push("Profesor");
  else if (!PROFESSOR_NAME_RE.test(professor)) invalid.push("Profesor: solo se permiten letras");

  if (!el("task_category").value.trim()) missing.push("Categoría");

  const deadline = el("task_deadline").value;
  if (!deadline) missing.push("Fecha de entrega");
  else if (deadline < todayIso()) invalid.push("Fecha de entrega: no puede ser anterior a hoy");

  return { missing, invalid };
}

function updateSaveTooltip(problems) {
  const tip = el("saveTooltip");
  const parts = [];
  if (problems.missing.length) {
    parts.push(
      "<strong>Falta rellenar:</strong><ul>" +
        problems.missing.map((f) => `<li>${f}</li>`).join("") +
        "</ul>"
    );
  }
  if (problems.invalid.length) {
    parts.push(
      "<strong>Corrige:</strong><ul>" +
        problems.invalid.map((f) => `<li>${f}</li>`).join("") +
        "</ul>"
    );
  }
  tip.innerHTML = parts.join("");
}

function validateTaskForm() {
  const problems = getFormProblems();
  const valid = problems.missing.length === 0 && problems.invalid.length === 0;

  el("saveTaskBtn").disabled = !valid;
  el("saveWrap").classList.toggle("is-blocked", !valid);
  updateSaveTooltip(problems);
  if (valid) el("saveWrap").classList.remove("show");
  return valid;
}

function showValidationErrors() {
  clearFieldErrors();
  let firstInvalid = null;

  if (!el("task_title").value.trim()) {
    el("err_title").textContent = "Favor de llenar este campo";
    firstInvalid = firstInvalid || el("task_title");
  }
  if (!el("task_subject").value.trim()) {
    el("err_subject").textContent = "Favor de llenar este campo";
    firstInvalid = firstInvalid || el("task_subject");
  }
  const professor = el("task_professor").value.trim();
  if (!professor) {
    el("err_professor").textContent = "Favor de llenar este campo";
    firstInvalid = firstInvalid || el("task_professor");
  } else if (!PROFESSOR_NAME_RE.test(professor)) {
    el("err_professor").textContent = "Solo se permiten letras en este campo.";
    firstInvalid = firstInvalid || el("task_professor");
  }
  if (!el("task_category").value.trim()) {
    el("err_category").textContent = "Favor de llenar este campo";
    firstInvalid = firstInvalid || el("task_category");
  }
  const deadline = el("task_deadline").value;
  if (!deadline) {
    el("err_deadline").textContent = "Favor de llenar este campo";
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

function pad2(n) {
  return String(n).padStart(2, "0");
}

function capitalize(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function statusLabel(value) {
  const opt = STATUS_OPTIONS.find((o) => o.value === value);
  return opt ? opt.label : value;
}

function formatDateTime(stamp) {
  if (!stamp) return "Sin registro";
  const [day, time] = stamp.split(" ");
  return time ? `${formatDate(day)}, ${time}` : formatDate(day);
}

function taskState(task) {
  if (task.status === "terminado") return "done";
  return task.deadline < todayIso() ? "overdue" : "pending";
}

function detailRow(label, valueHtml) {
  return `<div class="detail-row"><b>${label}</b><span>${valueHtml}</span></div>`;
}

function taskDetailRows(task) {
  const rows = [
    detailRow("Materia", escapeHtml(task.subject)),
    detailRow("Profesor", task.professor ? escapeHtml(task.professor) : "—"),
    detailRow("Categoría", task.category ? escapeHtml(task.category) : "—"),
    detailRow("Tipo", escapeHtml(capitalize(task.type))),
    detailRow("Estado", escapeHtml(statusLabel(task.status))),
    detailRow("Fecha de entrega", formatDate(task.deadline)),
  ];
  if (task.status === "terminado") {
    rows.push(detailRow("Completada el", escapeHtml(formatDateTime(task.completedAt))));
  }
  if (task.collaborators && task.collaborators.length) {
    rows.push(detailRow("Colaboradores", task.collaborators.map(collaboratorLabel).join(", ")));
  }
  return rows.join("");
}

function setView(name) {
  currentView = name;
  const ids = { tareas: "viewTasks", calendario: "viewCalendar", historial: "viewHistory" };
  Object.entries(ids).forEach(([key, id]) => {
    el(id).hidden = key !== name;
  });
  document.querySelectorAll(".bottom-nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-view") === name);
  });
  el("openAddTask").style.display = name === "tareas" ? "" : "none";
  hideCalTooltip();
  if (name === "calendario") renderCalendar();
  if (name === "historial") renderHistory();
  window.scrollTo(0, 0);
}

function tasksByDate() {
  const map = {};
  for (const t of tasks) {
    (map[t.deadline] = map[t.deadline] || []).push(t);
  }
  return map;
}

function renderCalendar() {
  const grid = el("calGrid");
  const { year, month } = calendarMonth;
  el("calTitle").textContent = `${capitalize(MONTHS_ES[month])} ${year}`;
  grid.innerHTML = "";
  hideCalTooltip();

  const byDate = tasksByDate();
  const today = todayIso();
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  for (let i = 0; i < offset; i++) {
    const blank = document.createElement("div");
    blank.className = "cal-day empty";
    grid.appendChild(blank);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${pad2(month + 1)}-${pad2(d)}`;
    const dayTasks = byDate[iso] || [];
    const cell = document.createElement(dayTasks.length ? "button" : "div");
    cell.className = "cal-day";
    if (dayTasks.length) {
      cell.type = "button";
      cell.classList.add("has-tasks");
    }
    if (iso < today) cell.classList.add("past");
    if (iso === today) cell.classList.add("today");

    const dots = dayTasks
      .slice(0, 4)
      .map((t) => `<i class="cal-dot ${taskState(t)}"></i>`)
      .join("");
    const more = dayTasks.length > 4 ? `<span class="cal-more">+${dayTasks.length - 4}</span>` : "";
    cell.innerHTML = `<span>${d}</span>${dayTasks.length ? `<span class="cal-dots">${dots}${more}</span>` : ""}`;

    if (dayTasks.length) {
      cell.setAttribute("aria-label", `${d} de ${MONTHS_ES[month]}: ${dayTasks.length} tarea(s)`);
      cell.addEventListener("mouseenter", () => showCalTooltip(cell, dayTasks));
      cell.addEventListener("focus", () => showCalTooltip(cell, dayTasks));
      cell.addEventListener("click", () => showCalTooltip(cell, dayTasks));
      cell.addEventListener("mouseleave", scheduleHideCalTooltip);
      cell.addEventListener("blur", scheduleHideCalTooltip);
    }
    grid.appendChild(cell);
  }
}

function showCalTooltip(cell, dayTasks) {
  clearTimeout(calTooltipTimer);
  document.querySelectorAll(".cal-day.active").forEach((c) => c.classList.remove("active"));
  cell.classList.add("active");

  const tip = el("calTooltip");
  tip.innerHTML = dayTasks
    .map(
      (t) => `
      <div class="cal-task">
        <h4 class="cal-task-title">${escapeHtml(t.title)}</h4>
        ${t.description ? `<p class="cal-task-desc">${escapeHtml(t.description)}</p>` : ""}
        ${taskDetailRows(t)}
      </div>`
    )
    .join("");
  tip.classList.add("open");

  const a = cell.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const margin = 8;
  let left = a.left + a.width / 2 - t.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - t.width - margin));
  let top = a.bottom + 6;
  if (top + t.height > window.innerHeight - margin) top = a.top - t.height - 6;
  if (top < margin) top = margin;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideCalTooltip() {
  clearTimeout(calTooltipTimer);
  el("calTooltip").classList.remove("open");
  document.querySelectorAll(".cal-day.active").forEach((c) => c.classList.remove("active"));
}

function scheduleHideCalTooltip() {
  clearTimeout(calTooltipTimer);
  calTooltipTimer = setTimeout(hideCalTooltip, 180);
}

function changeCalendarMonth(delta) {
  let { year, month } = calendarMonth;
  month += delta;
  if (month < 0) {
    month = 11;
    year -= 1;
  } else if (month > 11) {
    month = 0;
    year += 1;
  }
  calendarMonth = { year, month };
  renderCalendar();
}

function deliveryLabelHtml(task) {
  if (!task.completedAt) return "Sin registro";
  const doneDay = task.completedAt.split(" ")[0];
  const diff = Math.round(
    (new Date(`${doneDay}T00:00:00`) - new Date(`${task.deadline}T00:00:00`)) / 86400000
  );
  if (diff <= 0) return '<span class="history-ontime">A tiempo</span>';
  return `<span class="history-late">Con ${diff} día${diff === 1 ? "" : "s"} de retraso</span>`;
}

function renderHistory() {
  const list = el("historyList");
  const empty = el("historyEmpty");
  const badge = el("historyCount");
  list.innerHTML = "";

  const done = completedTasks().sort((a, b) => {
    const ka = a.completedAt || "";
    const kb = b.completedAt || "";
    if (ka !== kb) return kb.localeCompare(ka);
    return b.deadline.localeCompare(a.deadline);
  });

  if (done.length === 0) {
    empty.style.display = "block";
    badge.style.display = "none";
    return;
  }

  empty.style.display = "none";
  badge.style.display = "inline-block";
  badge.textContent = `${done.length} completada${done.length === 1 ? "" : "s"}`;

  for (const task of done) {
    const card = document.createElement("div");
    card.className = `task-card history-card type-${task.type}`;
    card.innerHTML = `
      <div class="task-top">
        <div>
          <h3 class="task-title">${escapeHtml(task.title)}</h3>
          <p class="task-desc">${escapeHtml(task.description || "Sin descripción")}</p>
        </div>
        <span class="chip chip-status-terminado">TERMINADO</span>
      </div>
      <div class="history-details">
        ${taskDetailRows(task)}
        ${detailRow("Entrega", deliveryLabelHtml(task))}
      </div>
      <div class="task-actions">
        <button type="button" class="btn btn-outline btn-small" data-action="reopen">↩ Reabrir tarea</button>
      </div>
    `;
    card.querySelector('[data-action="reopen"]').addEventListener("click", () => {
      openReopenModal(task);
    });
    list.appendChild(card);
  }
}

function openReopenModal(task) {
  taskIdPendingReopen = task.id;
  el("reopenTaskName").textContent = `"${task.title}"`;
  el("reopenBackdrop").classList.add("open");
}

function closeReopenModal() {
  el("reopenBackdrop").classList.remove("open");
  taskIdPendingReopen = null;
}

async function confirmReopen() {
  if (!taskIdPendingReopen) return;
  const id = taskIdPendingReopen;
  const ok = await reopenTask(id, el("confirmReopenBtn"));
  if (ok) closeReopenModal();
}

async function reopenTask(taskId, btn) {
  btn.disabled = true;
  try {
    const res = await fetch(`/api/tasks/${taskId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "en proceso" }),
    });
    if (!res.ok) {
      alert("No se pudo reabrir la tarea.");
      return false;
    }
    await loadTasks();
    return true;
  } catch (err) {
    console.error("Error reabriendo la tarea:", err);
    alert("No se pudo conectar con el servidor para reabrir la tarea.");
    return false;
  } finally {
    btn.disabled = false;
  }
}

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

document.addEventListener("DOMContentLoaded", () => {
  loadTasks();
  setupFilterTabs();
  setupCollaboratorSearch();
  setupNoLeadingSpaces(["task_title", "task_description", "task_professor", "task_collaborator_input"]);

  document.querySelectorAll(".bottom-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.getAttribute("data-view")));
  });
  el("calPrev").addEventListener("click", () => changeCalendarMonth(-1));
  el("calNext").addEventListener("click", () => changeCalendarMonth(1));
  el("calToday").addEventListener("click", () => {
    const now = new Date();
    calendarMonth = { year: now.getFullYear(), month: now.getMonth() };
    renderCalendar();
  });
  el("calTooltip").addEventListener("mouseenter", () => clearTimeout(calTooltipTimer));
  el("calTooltip").addEventListener("mouseleave", scheduleHideCalTooltip);
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".cal-day") && !e.target.closest("#calTooltip")) hideCalTooltip();
  });
  window.addEventListener("scroll", hideCalTooltip, { passive: true });
  window.addEventListener("resize", hideCalTooltip);

  el("openAddTask").addEventListener("click", () => openTaskModal(null));
  el("closeTaskModal").addEventListener("click", closeTaskModal);
  el("cancelTaskModal").addEventListener("click", closeTaskModal);
  el("saveTaskBtn").addEventListener("click", saveTask);

  el("saveWrap").addEventListener("click", () => {
    if (!el("saveWrap").classList.contains("is-blocked")) return;
    showValidationErrors();
    el("saveWrap").classList.add("show");
    clearTimeout(window.__saveTipTimer);
    window.__saveTipTimer = setTimeout(() => el("saveWrap").classList.remove("show"), 3500);
  });

  ["task_title", "task_subject", "task_deadline", "task_professor", "task_category"].forEach((id) => {
    const onChange = () => {
      validateTaskForm();
      clearFieldErrors();
    };
    el(id).addEventListener("input", onChange);
    el(id).addEventListener("change", onChange);
  });

  el("taskBackdrop").addEventListener("click", (e) => {
    if (e.target === el("taskBackdrop")) closeTaskModal();
  });

  el("cancelReopenBtn").addEventListener("click", closeReopenModal);
  el("confirmReopenBtn").addEventListener("click", confirmReopen);
  el("reopenBackdrop").addEventListener("click", (e) => {
    if (e.target === el("reopenBackdrop")) closeReopenModal();
  });

  el("cancelDeleteBtn").addEventListener("click", closeDeleteModal);
  el("confirmDeleteBtn").addEventListener("click", confirmDelete);
  el("deleteBackdrop").addEventListener("click", (e) => {
    if (e.target === el("deleteBackdrop")) closeDeleteModal();
  });
});
