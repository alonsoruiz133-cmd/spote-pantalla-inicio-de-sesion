document.addEventListener("DOMContentLoaded", () => {
  // Floating particles
  const container = document.getElementById("particles");
  if (container) {
    const count = 20;
    for (let i = 0; i < count; i++) {
      const p = document.createElement("div");
      p.className = "particle";
      p.style.left = Math.random() * 100 + "vw";
      p.style.top = Math.random() * 100 + "vh";
      const duration = Math.random() * 15 + 10;
      p.style.animationDuration = duration + "s";
      p.style.animationDelay = -(Math.random() * duration) + "s";
      container.appendChild(p);
    }
  }

  // Password visibility toggle
  const toggleBtn = document.getElementById("togglePass");
  const passInput = document.getElementById("password");
  if (toggleBtn && passInput) {
    toggleBtn.addEventListener("click", () => {
      const isText = passInput.type === "text";
      passInput.type = isText ? "password" : "text";
      toggleBtn.textContent = isText ? "👁" : "🙈";
    });
  }

  // Register modal
  const backdrop = document.getElementById("registerBackdrop");
  const openBtn = document.getElementById("openRegister");
  const closeBtn = document.getElementById("closeRegister");

  if (openBtn && backdrop) {
    openBtn.addEventListener("click", () => backdrop.classList.add("open"));
  }
  if (closeBtn && backdrop) {
    closeBtn.addEventListener("click", () => backdrop.classList.remove("open"));
  }
  if (backdrop) {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.classList.remove("open");
    });
  }
});
