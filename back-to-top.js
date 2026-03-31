(() => {
  const SHOW_AFTER_SCROLL_Y = 280;

  function initializeBackToTopButton() {
    const button = document.querySelector("[data-back-to-top]");
    if (!button) {
      return;
    }

    const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

    const setVisible = (visible) => {
      button.classList.toggle("is-visible", visible);
      button.tabIndex = visible ? 0 : -1;
      button.setAttribute("aria-hidden", String(!visible));
    };

    const syncVisibility = () => {
      setVisible(window.scrollY > SHOW_AFTER_SCROLL_Y);
    };

    button.addEventListener("click", () => {
      window.scrollTo({
        top: 0,
        behavior: reducedMotionQuery.matches ? "auto" : "smooth"
      });
    });

    window.addEventListener("scroll", syncVisibility, { passive: true });
    syncVisibility();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeBackToTopButton, { once: true });
    return;
  }

  initializeBackToTopButton();
})();
