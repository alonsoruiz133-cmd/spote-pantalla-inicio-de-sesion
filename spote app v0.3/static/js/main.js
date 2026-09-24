document.addEventListener("DOMContentLoaded", () => {
  // Mostrar/ocultar contraseña
  const toggleBtn = document.getElementById("togglePass");
  const passInput = document.getElementById("password");
  if (toggleBtn && passInput) {
    toggleBtn.addEventListener("click", () => {
      const isHidden = passInput.type === "password";
      passInput.type = isHidden ? "text" : "password";
      toggleBtn.textContent = isHidden ? "🙈" : "👁";
    });
  }

  // Modal de registro
  const backdrop = document.getElementById("registerBackdrop");
  const openBtn = document.getElementById("openRegister");
  const closeBtn = document.getElementById("closeRegister");

  const openModal = () => backdrop.classList.add("open");
  const closeModal = () => backdrop.classList.remove("open");

  if (openBtn) openBtn.addEventListener("click", openModal);
  if (closeBtn) closeBtn.addEventListener("click", closeModal);
  if (backdrop) {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModal();
    });
  }

  // Si venimos de un intento de registro fallido, reabrimos el modal
  if (sessionStorage.getItem("spote_open_register") === "1") {
    openModal();
    sessionStorage.removeItem("spote_open_register");
  }

  const registerForm = document.querySelector("#registerBackdrop form");
  if (registerForm) {
    registerForm.addEventListener("submit", () => {
      sessionStorage.setItem("spote_open_register", "1");
    });
  }
});
