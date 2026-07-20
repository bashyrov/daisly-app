const phone = document.querySelector(".phone");
const screens = [...document.querySelectorAll(".screen")];
const tabs = [...document.querySelectorAll(".tab")];
const tabbar = document.querySelector(".tabbar");
const root = document.documentElement;

phone.classList.remove("sheet-open", "focus-open");

function showScreen(name) {
  screens.forEach((screen) => {
    screen.classList.toggle("is-active", screen.dataset.screen === name);
  });

  tabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === name);
  });

  tabbar.classList.toggle("is-hidden", name === "onboarding" || name === "settings");
  phone.classList.remove("sheet-open", "focus-open");
}

document.querySelectorAll("[data-start]").forEach((button) => {
  button.addEventListener("click", () => showScreen("inbox"));
});

tabs.forEach((tab) => {
  tab.addEventListener("click", () => showScreen(tab.dataset.tab));
});

document.querySelector("[data-add]").addEventListener("click", () => {
  phone.classList.add("sheet-open");
});

document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => phone.classList.remove("sheet-open"));
});

document.querySelectorAll("[data-complete]").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    button.classList.toggle("is-done");
    const task = button.closest(".task") || button.closest(".timeline-item")?.querySelector(".slot");
    task?.classList.toggle("done");
  });
});

document.querySelector("[data-detail]").addEventListener("click", () => {
  phone.classList.add("focus-open");
});

document.querySelectorAll("[data-focus-close]").forEach((button) => {
  button.addEventListener("click", () => {
    phone.classList.remove("focus-open");
  });
});

document.querySelector("[data-settings]").addEventListener("click", () => showScreen("settings"));
document.querySelector("[data-profile]").addEventListener("click", () => showScreen("profile"));

document.querySelectorAll(".swatch").forEach((swatch) => {
  swatch.addEventListener("click", () => {
    const color = swatch.getAttribute("aria-label");
    const soft = color === "#FFDAB9" || color === "#EEE8AA" ? `${color}B8` : `${color}26`;
    const textAccent = color === "#FFDAB9" || color === "#EEE8AA" ? "#2E8B57" : color;
    const onAccent = color === "#FFDAB9" || color === "#EEE8AA" ? "#202822" : "#fff";

    document.querySelectorAll(".swatch").forEach((item) => item.classList.remove("active"));
    swatch.classList.add("active");

    root.style.setProperty("--accent-surface", color);
    root.style.setProperty("--on-accent", onAccent);
    root.style.setProperty("--green", textAccent);
    root.style.setProperty("--orange", textAccent);
    root.style.setProperty("--pink", color);
    root.style.setProperty("--blue", color);
    root.style.setProperty("--purple", color);
    root.style.setProperty("--green-soft", soft);
    root.style.setProperty("--orange-soft", soft);
    root.style.setProperty("--pink-soft", soft);
    root.style.setProperty("--blue-soft", soft);
    root.style.setProperty("--purple-soft", soft);
    root.style.setProperty("--shadow", `0 18px 45px ${color}24`);
  });
});
