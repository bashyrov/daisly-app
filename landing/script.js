const nav = document.querySelector(".nav");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const normalizeCleanUrl = () => {
  const { pathname, search, hash } = window.location;
  let nextPath = pathname;

  if (nextPath.endsWith("/index.html")) {
    nextPath = nextPath.slice(0, -10) || "/";
  } else if (nextPath.endsWith(".html")) {
    nextPath = nextPath.slice(0, -5);
  }

  if (nextPath !== pathname) {
    window.history.replaceState(null, "", `${nextPath}${search}${hash}`);
  }
};

normalizeCleanUrl();

const setNavState = () => {
  if (!nav) return;
  nav.dataset.scrolled = window.scrollY > 18 ? "true" : "false";
};

setNavState();
window.addEventListener("scroll", setNavState, { passive: true });

const revealItems = Array.from(document.querySelectorAll(".section-head, .phone-frame, .quick-item, .feature-card, .showcase-band, .price-card, .faq-list details, .legal-panel, .legal-summary div, .support-card"));

if ("IntersectionObserver" in window) {
  revealItems.forEach((item) => item.classList.add("reveal"));
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.14 });

  revealItems.forEach((item) => observer.observe(item));
} else {
  revealItems.forEach((item) => item.classList.add("visible"));
}

const scrollToSection = (targetElement) => {
  const navHeight = nav ? nav.getBoundingClientRect().height + 18 : 0;
  const nextTop = targetElement.getBoundingClientRect().top + window.scrollY - navHeight;
  window.scrollTo({
    top: clamp(nextTop, 0, document.documentElement.scrollHeight - window.innerHeight),
    behavior: reducedMotion.matches ? "auto" : "smooth",
  });
};

document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener("click", (event) => {
    const id = link.getAttribute("href");
    if (!id || id === "#") return;
    const targetElement = document.querySelector(id);
    if (!targetElement) return;

    event.preventDefault();
    history.pushState(null, "", id);
    scrollToSection(targetElement);
  });
});
