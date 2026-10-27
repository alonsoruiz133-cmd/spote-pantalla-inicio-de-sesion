const PERSON_NAME_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ\s.'’-]+$/;
const CONTROL_NUMBER_RE = /^C?\d{8}$/;
const PHONE_RE = /^\d{10}$/;
const INSTITUTIONAL_EMAIL_RE = /^([a-z]?)(\d{8})@saltillo\.tecnm\.mx$/;
const ADMIN_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const el = (id) => document.getElementById(id);

let users = [];
let editingUser = null;
let pendingStatus = null;
let pendingDelete = null;
let searchTimer = null;
let flashTimer = null;

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showFlash(message) {
  const box = el("adminFlash");
  box.textContent = message;
  box.style.display = "block";
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    box.style.display = "none";
  }, 4500);
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("no-auth");
  }
  if (res.status === 403) {
    window.location.href = "/dashboard";
    throw new Error("forbidden");
  }
  return res;
}

async function loadUsers() {
  const params = new URLSearchParams();
  const q = el("userSearch").value.trim();
  if (q) params.set("q", q);
  if (el("filterCareer").value) params.set("career", el("filterCareer").value);
  if (el("filterRole").value) params.set("role", el("filterRole").value);
  if (el("filterStatus").value) params.set("status", el("filterStatus").value);

  try {
    const res = await apiFetch(`/api/admin/users?${params.toString()}`);
    if (!res.ok) return;
    const data = await res.json();
    users = data.users;
    el("statTotal").textContent = data.summary.total;
    el("statActive").textContent = data.summary.activos;
    el("statInactive").textContent = data.summary.desactivados;
    el("statAdmins").textContent = data.summary.admins;
    renderUsers();
  } catch (err) {
    if (err.message !== "no-auth" && err.message !== "forbidden") {
      console.error("Error cargando usuarios:", err);
    }
  }
}

function dash(value) {
  return value ? escapeHtml(value) : "—";
}

function renderUsers() {
  const body = el("usersBody");
  el("usersEmpty").style.display = users.length ? "none" : "block";
  body.innerHTML = users
    .map((u) => {
      const toggleLabel = u.active ? "Desactivar" : "Activar";
      const selfNote = u.isSelf ? ' title="No puedes hacer esto con tu propia cuenta"' : "";
      return `
      <tr class="${u.active ? "" : "inactive"}">
        <td class="cell-wrap"><strong>${escapeHtml(u.name)}</strong>${u.isSelf ? " (tú)" : ""}</td>
        <td>${dash(u.controlNumber)}</td>
        <td class="cell-wrap">${dash(u.career)}${u.semester ? `<br /><small>${escapeHtml(u.semester)}° semestre</small>` : ""}</td>
        <td>${dash(u.phone)}</td>
        <td class="cell-wrap">${escapeHtml(u.email)}</td>
        <td>
          <div class="admin-badges">
            <span class="badge ${u.role === "admin" ? "badge-admin" : "badge-student"}">${u.role === "admin" ? "Administrador" : "Alumno"}</span>
            <span class="badge ${u.active ? "badge-active" : "badge-inactive"}">${u.active ? "Activo" : "Desactivado"}</span>
          </div>
        </td>
        <td>${u.tasksCount}</td>
        <td>
          <div class="admin-actions">
            <button type="button" class="btn btn-outline btn-small" data-action="edit" data-id="${u.id}">Editar</button>
            <button type="button" class="btn btn-outline btn-small" data-action="status" data-id="${u.id}" ${u.isSelf ? `disabled${selfNote}` : ""}>${toggleLabel}</button>
            <button type="button" class="btn btn-danger btn-small" data-action="delete" data-id="${u.id}" ${u.isSelf ? `disabled${selfNote}` : ""}>Eliminar</button>
          </div>
        </td>
      </tr>`;
    })
    .join("");
}

function findUser(id) {
  return users.find((u) => u.id === id);
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

function isLegacyStudent() {
  return Boolean(editingUser) && editingUser.role === "estudiante" && !editingUser.controlNumber;
}

function currentRole() {
  return el("u_role").value;
}

function applyRoleLayout() {
  const isAdmin = currentRole() === "admin";
  el("studentFields").style.display = isAdmin ? "none" : "";
  el("u_last2_label").textContent = isAdmin ? "Apellido materno" : "Apellido materno *";
}

function showUserErrors(messages) {
  const box = el("userErrors");
  if (!messages || messages.length === 0) {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `<ul>${messages.map((m) => `<li>${escapeHtml(m)}</li>`).join("")}</ul>`;
  box.style.display = "block";
}

function openUserModal(user) {
  editingUser = user || null;
  el("userModalTitle").textContent = user ? "Editar usuario" : "Agregar usuario";
  el("userSaveBtn").textContent = user ? "Actualizar" : "Guardar";
  showUserErrors([]);

  el("u_role").value = user ? user.role : "estudiante";
  el("u_role").disabled = Boolean(user && user.isSelf);
  el("u_first").value = user ? user.firstName || user.name : "";
  el("u_last1").value = user ? user.lastNameP : "";
  el("u_last2").value = user ? user.lastNameM : "";
  setSelectValue("u_career", user ? user.career : "");
  setSelectValue("u_semester", user ? user.semester : "");
  el("u_control").value = user ? user.controlNumber : "";
  el("u_control").maxLength = user && user.controlNumber && !user.controlNumber.startsWith("C") ? 8 : 9;
  el("u_phone").value = user ? user.phone : "";
  el("u_email").value = user ? user.email : "";
  el("u_password").value = "";
  el("u_password").type = "password";
  el("togglePassword").textContent = "Mostrar contraseña";
  el("u_password_label").textContent = user ? "Nueva contraseña (opcional)" : "Contraseña *";
  el("u_password").placeholder = user ? "Dejar en blanco para no cambiarla" : "Mínimo 6 caracteres";
  el("legacyNote").style.display = isLegacyStudent() ? "block" : "none";

  applyRoleLayout();
  validateUserForm();
  el("userBackdrop").classList.add("open");
}

function closeUserModal() {
  el("userBackdrop").classList.remove("open");
  editingUser = null;
}

function getUserProblems() {
  const text = (id) => el(id).value.trim();
  const role = currentRole();
  const creating = !editingUser;
  const legacy = isLegacyStudent();
  const missing = [];
  const invalid = [];

  const need = (id, label) => {
    if (!text(id)) missing.push(label);
  };

  need("u_first", "Nombre");
  if (role === "admin" || !legacy) need("u_last1", "Apellido paterno");
  if (role === "estudiante" && !legacy) {
    need("u_last2", "Apellido materno");
    need("u_career", "Carrera");
    need("u_semester", "Semestre");
    need("u_control", "Número de control");
    need("u_phone", "Número de teléfono");
  }
  need("u_email", "Correo electrónico");
  if (creating && !el("u_password").value) missing.push("Contraseña");

  [["u_first", "Nombre"], ["u_last1", "Apellido paterno"], ["u_last2", "Apellido materno"]].forEach(([id, label]) => {
    if (text(id) && !PERSON_NAME_RE.test(text(id))) invalid.push(`${label}: solo se permiten letras`);
  });

  const email = text("u_email").toLowerCase();
  const control = text("u_control").toUpperCase();
  if (role === "estudiante") {
    if (text("u_control") && !CONTROL_NUMBER_RE.test(control)) {
      invalid.push("Número de control: 8 dígitos, o la letra C seguida de 8 dígitos");
    }
    if (text("u_phone") && !PHONE_RE.test(text("u_phone"))) {
      invalid.push("Número de teléfono: debe tener 10 dígitos");
    }
    const unchangedEmail = editingUser && email === editingUser.email;
    if (email && !unchangedEmail) {
      const institutional = INSTITUTIONAL_EMAIL_RE.exec(email);
      if (!institutional) {
        invalid.push("Correo electrónico: debe ser institucional (número de control@saltillo.tecnm.mx)");
      } else if (CONTROL_NUMBER_RE.test(control) && institutional[2] !== control.slice(-8)) {
        invalid.push("El correo debe corresponder al número de control");
      }
    }
  } else if (email && !ADMIN_EMAIL_RE.test(email)) {
    invalid.push("Correo electrónico: formato no válido");
  }

  const pass = el("u_password").value;
  if (pass && pass.length < 6) invalid.push("Contraseña: mínimo 6 caracteres");

  return { missing, invalid };
}

function renderSaveTooltip(problems) {
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
  el("userSaveTooltip").innerHTML = parts.join("");
}

function validateUserForm() {
  const problems = getUserProblems();
  const valid = problems.missing.length === 0 && problems.invalid.length === 0;
  el("userSaveBtn").disabled = !valid;
  el("userSaveWrap").classList.toggle("is-blocked", !valid);
  renderSaveTooltip(problems);
  if (valid) el("userSaveWrap").classList.remove("show");
  return valid;
}

async function saveUser(e) {
  e.preventDefault();
  if (!validateUserForm()) return;

  const payload = {
    role: currentRole(),
    first_name: el("u_first").value,
    last_name_p: el("u_last1").value,
    last_name_m: el("u_last2").value,
    career: el("u_career").value,
    semester: el("u_semester").value,
    control_number: el("u_control").value,
    phone: el("u_phone").value,
    email: el("u_email").value,
    password: el("u_password").value,
  };

  const btn = el("userSaveBtn");
  btn.disabled = true;
  try {
    const url = editingUser ? `/api/admin/users/${editingUser.id}` : "/api/admin/users";
    const res = await apiFetch(url, {
      method: editingUser ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      showUserErrors(data.errors || [data.error || "No se pudo guardar el usuario."]);
      validateUserForm();
      return;
    }
    const wasEditing = Boolean(editingUser);
    closeUserModal();
    await loadUsers();
    showFlash(wasEditing ? `Usuario "${data.name}" actualizado.` : `Usuario "${data.name}" agregado.`);
  } catch (err) {
    if (err.message !== "no-auth" && err.message !== "forbidden") {
      console.error("Error guardando usuario:", err);
      showUserErrors(["No se pudo conectar con el servidor."]);
      validateUserForm();
    }
  }
}

function openStatusModal(user) {
  pendingStatus = user;
  const deactivating = user.active;
  el("statusTitle").textContent = deactivating ? "Desactivar cuenta" : "Activar cuenta";
  el("statusMessage").textContent = deactivating
    ? `¿Estás seguro de desactivar la cuenta de "${user.name}"?`
    : `¿Estás seguro de activar la cuenta de "${user.name}"?`;
  el("statusNote").textContent = deactivating
    ? "No podrá iniciar sesión y se cerrará su sesión actual. Sus tareas y datos se conservan, y puedes reactivarla cuando quieras."
    : "Podrá volver a iniciar sesión con su correo y contraseña.";
  el("statusBackdrop").classList.add("open");
}

function closeStatusModal() {
  el("statusBackdrop").classList.remove("open");
  pendingStatus = null;
}

async function confirmStatus() {
  if (!pendingStatus) return;
  const user = pendingStatus;
  const btn = el("confirmStatusBtn");
  btn.disabled = true;
  try {
    const res = await apiFetch(`/api/admin/users/${user.id}/status`, {
      method: "POST",
      body: JSON.stringify({ active: !user.active }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "No se pudo cambiar el estado de la cuenta.");
      return;
    }
    closeStatusModal();
    await loadUsers();
    showFlash(data.active ? `Cuenta de "${data.name}" activada.` : `Cuenta de "${data.name}" desactivada.`);
  } catch (err) {
    if (err.message !== "no-auth" && err.message !== "forbidden") {
      console.error("Error cambiando estado:", err);
      alert("No se pudo conectar con el servidor.");
    }
  } finally {
    btn.disabled = false;
  }
}

function openDeleteModal(user) {
  pendingDelete = user;
  el("deleteUserName").textContent = `${user.name}${user.controlNumber ? ` (${user.controlNumber})` : ""}`;
  el("deleteUserDetails").textContent =
    `Se borrarán de forma permanente su cuenta, sus ${user.tasksCount} tarea(s), recordatorios e historial. ` +
    "Su correo y su número de control quedarán libres para volver a registrarse.";
  el("deleteConfirmInput").value = "";
  el("confirmDeleteUserBtn").disabled = true;
  el("deleteUserBackdrop").classList.add("open");
  el("deleteConfirmInput").focus();
}

function closeDeleteModal() {
  el("deleteUserBackdrop").classList.remove("open");
  pendingDelete = null;
}

async function confirmDelete() {
  if (!pendingDelete) return;
  const user = pendingDelete;
  const btn = el("confirmDeleteUserBtn");
  btn.disabled = true;
  try {
    const res = await apiFetch(`/api/admin/users/${user.id}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "No se pudo eliminar el usuario.");
      btn.disabled = false;
      return;
    }
    closeDeleteModal();
    await loadUsers();
    showFlash(`Usuario "${user.name}" eliminado definitivamente.`);
  } catch (err) {
    if (err.message !== "no-auth" && err.message !== "forbidden") {
      console.error("Error eliminando usuario:", err);
      alert("No se pudo conectar con el servidor.");
      btn.disabled = false;
    }
  }
}

function setupFormSanitizers() {
  el("u_phone").addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 10);
  });
  el("u_control").addEventListener("input", (e) => {
    const raw = e.target.value.toUpperCase();
    const startsWithC = raw.startsWith("C");
    const digits = raw.replace(/\D/g, "").slice(0, 8);
    e.target.value = startsWithC ? `C${digits}` : digits;
    e.target.maxLength = startsWithC ? 9 : 8;
  });
  el("u_email").addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/\s/g, "");
  });
  ["u_first", "u_last1", "u_last2"].forEach((id) => {
    el(id).addEventListener("input", (e) => {
      e.target.value = e.target.value.replace(/^\s+/, "");
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  el("openAddUser").addEventListener("click", () => openUserModal(null));
  el("closeUserModal").addEventListener("click", closeUserModal);
  el("cancelUserBtn").addEventListener("click", closeUserModal);
  el("userBackdrop").addEventListener("click", (e) => {
    if (e.target === el("userBackdrop")) closeUserModal();
  });
  el("userForm").addEventListener("submit", saveUser);

  setupFormSanitizers();
  ["u_first", "u_last1", "u_last2", "u_career", "u_semester", "u_control", "u_phone", "u_email", "u_password"].forEach(
    (id) => {
      el(id).addEventListener("input", validateUserForm);
      el(id).addEventListener("change", validateUserForm);
    }
  );
  el("u_role").addEventListener("change", () => {
    applyRoleLayout();
    validateUserForm();
  });

  el("togglePassword").addEventListener("click", () => {
    const hidden = el("u_password").type === "password";
    el("u_password").type = hidden ? "text" : "password";
    el("togglePassword").textContent = hidden ? "Ocultar contraseña" : "Mostrar contraseña";
  });

  el("userSaveWrap").addEventListener("click", () => {
    const wrap = el("userSaveWrap");
    if (!wrap.classList.contains("is-blocked")) return;
    wrap.classList.add("show");
    clearTimeout(window.__userTipTimer);
    window.__userTipTimer = setTimeout(() => wrap.classList.remove("show"), 4000);
  });

  el("usersBody").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn || btn.disabled) return;
    const user = findUser(btn.getAttribute("data-id"));
    if (!user) return;
    const action = btn.getAttribute("data-action");
    if (action === "edit") openUserModal(user);
    if (action === "status") openStatusModal(user);
    if (action === "delete") openDeleteModal(user);
  });

  el("cancelStatusBtn").addEventListener("click", closeStatusModal);
  el("confirmStatusBtn").addEventListener("click", confirmStatus);
  el("statusBackdrop").addEventListener("click", (e) => {
    if (e.target === el("statusBackdrop")) closeStatusModal();
  });

  el("cancelDeleteUserBtn").addEventListener("click", closeDeleteModal);
  el("confirmDeleteUserBtn").addEventListener("click", confirmDelete);
  el("deleteUserBackdrop").addEventListener("click", (e) => {
    if (e.target === el("deleteUserBackdrop")) closeDeleteModal();
  });
  el("deleteConfirmInput").addEventListener("input", () => {
    el("confirmDeleteUserBtn").disabled = el("deleteConfirmInput").value.trim().toUpperCase() !== "ELIMINAR";
  });

  el("userSearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadUsers, 250);
  });
  ["filterCareer", "filterRole", "filterStatus"].forEach((id) => {
    el(id).addEventListener("change", loadUsers);
  });

  loadUsers();
});
