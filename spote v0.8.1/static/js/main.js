const PERSON_NAME_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ\s.'’-]+$/;
const CONTROL_NUMBER_RE = /^C?\d{8}$/;
const INSTITUTIONAL_EMAIL_RE = /^([a-z]?)(\d{8})@saltillo\.tecnm\.mx$/;
const PHONE_RE = /^\d{10}$/;

const REGISTER_FIELDS = [
  ["reg_first", "Nombre"],
  ["reg_last1", "Apellido paterno"],
  ["reg_last2", "Apellido materno"],
  ["reg_career", "Carrera"],
  ["reg_semester", "Semestre"],
  ["reg_control", "Número de control"],
  ["reg_phone", "Número de teléfono"],
  ["reg_email", "Correo electrónico"],
  ["reg_email_confirm", "Confirmar correo electrónico"],
  ["reg_password", "Contraseña"],
  ["reg_confirm", "Confirmar contraseña"],
];

const byId = (id) => document.getElementById(id);

function getRegisterProblems() {
  const value = (id) => byId(id).value;
  const text = (id) => value(id).trim();
  const missing = [];
  const invalid = [];
  let firstProblemId = null;
  const flag = (id) => {
    if (!firstProblemId) firstProblemId = id;
  };

  for (const [id, label] of REGISTER_FIELDS) {
    const empty = id.includes("password") || id === "reg_confirm" ? value(id) === "" : text(id) === "";
    if (empty) {
      missing.push(label);
      flag(id);
    }
  }

  const checkName = (id, label) => {
    if (text(id) && !PERSON_NAME_RE.test(text(id))) {
      invalid.push(`${label}: solo se permiten letras`);
      flag(id);
    }
  };
  checkName("reg_first", "Nombre");
  checkName("reg_last1", "Apellido paterno");
  checkName("reg_last2", "Apellido materno");

  if (text("reg_control") && !CONTROL_NUMBER_RE.test(text("reg_control"))) {
    invalid.push("Número de control: 8 dígitos, o la letra C seguida de 8 dígitos");
    flag("reg_control");
  }
  if (text("reg_phone") && !PHONE_RE.test(text("reg_phone"))) {
    invalid.push("Número de teléfono: debe tener 10 dígitos");
    flag("reg_phone");
  }

  const email = text("reg_email").toLowerCase();
  const email2 = text("reg_email_confirm").toLowerCase();
  const institutional = INSTITUTIONAL_EMAIL_RE.exec(email);
  const control = text("reg_control").toUpperCase();
  if (email && !institutional) {
    invalid.push("Correo electrónico: debe ser institucional (número de control@saltillo.tecnm.mx)");
    flag("reg_email");
  } else if (email && institutional && CONTROL_NUMBER_RE.test(control) && institutional[2] !== control.slice(-8)) {
    invalid.push("El correo debe corresponder a tu número de control");
    flag("reg_email");
  } else if (email && email2 && email !== email2) {
    invalid.push("Los correos electrónicos no coinciden");
    flag("reg_email_confirm");
  }

  const pass = value("reg_password");
  const pass2 = value("reg_confirm");
  if (pass && pass.length < 6) {
    invalid.push("Contraseña: mínimo 6 caracteres");
    flag("reg_password");
  } else if (pass && pass2 && pass !== pass2) {
    invalid.push("Las contraseñas no coinciden");
    flag("reg_confirm");
  }

  return { missing, invalid, firstProblemId };
}

function renderRegisterTooltip(problems) {
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
  byId("regTooltip").innerHTML = parts.join("");
}

function validateRegisterForm() {
  const problems = getRegisterProblems();
  const valid = problems.missing.length === 0 && problems.invalid.length === 0;
  byId("regSubmit").disabled = !valid;
  byId("regWrap").classList.toggle("is-blocked", !valid);
  renderRegisterTooltip(problems);
  if (valid) byId("regWrap").classList.remove("show");
  return problems;
}

function sanitizeRegisterInputs() {
  byId("reg_phone").addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 10);
  });
  byId("reg_control").addEventListener("input", (e) => {
    const raw = e.target.value.toUpperCase();
    const startsWithC = raw.startsWith("C");
    const digits = raw.replace(/\D/g, "").slice(0, 8);
    e.target.value = startsWithC ? `C${digits}` : digits;
    e.target.maxLength = startsWithC ? 9 : 8;
  });
  ["reg_email", "reg_email_confirm"].forEach((id) => {
    byId(id).addEventListener("input", (e) => {
      e.target.value = e.target.value.replace(/\s/g, "");
    });
  });
  ["reg_first", "reg_last1", "reg_last2"].forEach((id) => {
    byId(id).addEventListener("input", (e) => {
      e.target.value = e.target.value.replace(/^\s+/, "");
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  sessionStorage.removeItem("spote_open_register");

  const toggleBtn = byId("togglePass");
  const passInput = byId("password");
  if (toggleBtn && passInput) {
    toggleBtn.addEventListener("click", () => {
      const isHidden = passInput.type === "password";
      passInput.type = isHidden ? "text" : "password";
      toggleBtn.textContent = isHidden ? "🙈" : "👁";
    });
  }

  const backdrop = byId("registerBackdrop");
  const openBtn = byId("openRegister");
  const closeBtn = byId("closeRegister");
  const openModal = () => backdrop.classList.add("open");
  const closeModal = () => backdrop.classList.remove("open");

  if (openBtn) openBtn.addEventListener("click", openModal);
  if (closeBtn) closeBtn.addEventListener("click", closeModal);
  if (backdrop) {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModal();
    });
  }

  if (new URLSearchParams(window.location.search).get("register") === "1") {
    openModal();
    window.history.replaceState(null, "", "/login");
  }

  const registerForm = byId("registerForm");
  if (!registerForm) return;

  sanitizeRegisterInputs();
  REGISTER_FIELDS.forEach(([id]) => {
    byId(id).addEventListener("input", validateRegisterForm);
    byId(id).addEventListener("change", validateRegisterForm);
  });

  byId("regWrap").addEventListener("click", () => {
    const wrap = byId("regWrap");
    if (!wrap.classList.contains("is-blocked")) return;
    const problems = validateRegisterForm();
    if (problems.firstProblemId) byId(problems.firstProblemId).focus();
    wrap.classList.add("show");
    clearTimeout(window.__regTipTimer);
    window.__regTipTimer = setTimeout(() => wrap.classList.remove("show"), 4000);
  });

  registerForm.addEventListener("submit", (e) => {
    const problems = validateRegisterForm();
    if (problems.missing.length || problems.invalid.length) e.preventDefault();
  });

  validateRegisterForm();
});
