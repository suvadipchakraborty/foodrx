(() => {
  "use strict";

  const CONDITIONS = [
    { id: "diabetes",     label: "Diabetes",         icon: "🩸" },
    { id: "hypertension", label: "Hypertension",     icon: "💓" },
    { id: "cholesterol",  label: "High Cholesterol", icon: "🫀" },
    { id: "uric_acid",    label: "High Uric Acid",   icon: "🦴" },
    { id: "celiac",       label: "Celiac Disease",   icon: "🌾" },
    { id: "gerd",         label: "GERD / Acidity",   icon: "🔥" },
    { id: "ckd",          label: "Kidney Disease",   icon: "💧" },
    { id: "fatty_liver",  label: "Fatty Liver",      icon: "🫗" },
  ];

  const state = {
    selected: new Set(),
    lastResult: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const grid = $("#condition-grid");
  const generateBtn = $("#generate-btn");
  const skeleton = $("#skeleton");
  const errorBox = $("#error-box");
  const results = $("#results");

  /* ---------------- Disclaimer ---------------- */
  function initDisclaimer() {
    const overlay = $("#disclaimer");
    const ack = $("#disclaimer-ack");
    const continueBtn = $("#disclaimer-continue");
    const app = $("#app");

    ack.addEventListener("change", () => {
      continueBtn.disabled = !ack.checked;
    });

    continueBtn.addEventListener("click", () => {
      overlay.remove();
      app.removeAttribute("aria-hidden");
    });
  }

  /* ---------------- Condition chips ---------------- */
  function renderChips() {
    grid.innerHTML = "";
    CONDITIONS.forEach((c) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.dataset.id = c.id;
      btn.setAttribute("aria-pressed", "false");
      btn.innerHTML = `<span class="chip__icon" aria-hidden="true">${c.icon}</span><span class="chip__label">${c.label}</span>`;
      btn.addEventListener("click", () => toggleCondition(c.id, btn));
      grid.appendChild(btn);
    });
  }

  function toggleCondition(id, btn) {
    if (state.selected.has(id)) {
      state.selected.delete(id);
      btn.setAttribute("aria-pressed", "false");
    } else {
      state.selected.add(id);
      btn.setAttribute("aria-pressed", "true");
    }
    updateGenerateButton();
  }

  function updateGenerateButton() {
    const n = state.selected.size;
    generateBtn.disabled = n === 0;
    const label = generateBtn.querySelector(".btn__label");
    label.textContent =
      n === 0
        ? "Select at least one condition"
        : `Generate my list (${n} condition${n > 1 ? "s" : ""})`;
  }

  /* ---------------- Generate ---------------- */
  async function generate() {
    const conditionLabels = CONDITIONS.filter((c) => state.selected.has(c.id)).map((c) => c.label);
    if (conditionLabels.length === 0) return;

    errorBox.classList.add("hidden");
    results.classList.add("hidden");
    skeleton.classList.remove("hidden");
    generateBtn.disabled = true;

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conditions: conditionLabels }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }

      const data = await res.json();
      renderResults(data, conditionLabels);
    } catch (err) {
      showError(err.message || "Something went wrong while generating your list. Please try again.");
    } finally {
      skeleton.classList.add("hidden");
      updateGenerateButton();
    }
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove("hidden");
  }

  function renderResults(data, conditionLabels) {
    const greenLight = Array.isArray(data.greenLight) ? data.greenLight : [];
    const redLight = Array.isArray(data.redLight) ? data.redLight : [];
    const explanation = typeof data.explanation === "string" ? data.explanation : "";

    state.lastResult = { greenLight, redLight, explanation, conditionLabels };

    $("#results-conditions").innerHTML = conditionLabels
      .map((c) => `<span>${escapeHtml(c)}</span>`)
      .join("");
    $("#results-explanation").textContent = explanation;

    const eatList = $("#list-eat");
    const avoidList = $("#list-avoid");
    eatList.innerHTML = greenLight.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    avoidList.innerHTML = redLight.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    $("#count-eat").textContent = greenLight.length;
    $("#count-avoid").textContent = redLight.length;

    results.classList.remove("hidden");
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  /* ---------------- Accordion toggles ---------------- */
  function initAccordions() {
    document.querySelectorAll(".list-col__toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const expanded = btn.getAttribute("aria-expanded") === "true";
        btn.setAttribute("aria-expanded", String(!expanded));
      });
    });
  }

  /* ---------------- Copy / Share / Reset ---------------- */
  function buildPlainTextList() {
    if (!state.lastResult) return "";
    const { greenLight, redLight, conditionLabels } = state.lastResult;
    const lines = [];
    lines.push(`FoodRx — diet list for ${conditionLabels.join(", ")}`, "");
    lines.push("EAT FREELY");
    greenLight.forEach((i) => lines.push(`- ${i}`));
    lines.push("", "AVOID");
    redLight.forEach((i) => lines.push(`- ${i}`));
    lines.push("", "Generated by AI — confirm with your doctor. https://foodrx.suvadipchakraborty.workers.dev/");
    return lines.join("\n");
  }

  function initResultActions() {
    $("#copy-btn").addEventListener("click", async (e) => {
      const text = buildPlainTextList();
      const btn = e.currentTarget;
      try {
        await navigator.clipboard.writeText(text);
        const original = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(() => (btn.textContent = original), 1600);
      } catch {
        showError("Couldn't copy automatically — please select and copy the list manually.");
      }
    });

    $("#reset-btn").addEventListener("click", () => {
      state.selected.clear();
      document.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
      updateGenerateButton();
      results.classList.add("hidden");
      errorBox.classList.add("hidden");
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  /* ---------------- Share ---------------- */
  function initShare() {
    $("#share-btn").addEventListener("click", async () => {
      const shareData = {
        title: "FoodRx",
        text: state.lastResult
          ? `My FoodRx diet list for ${state.lastResult.conditionLabels.join(", ")}`
          : "FoodRx — know what to eat, condition by condition.",
        url: "https://foodrx.suvadipchakraborty.workers.dev/",
      };
      if (navigator.share) {
        try {
          await navigator.share(shareData);
        } catch {
          /* user cancelled — no-op */
        }
      } else {
        try {
          await navigator.clipboard.writeText(shareData.url);
          alert("Link copied to clipboard");
        } catch {
          /* ignore */
        }
      }
    });
  }

  /* ---------------- Tabs ---------------- */
  function initTabs() {
    const buttons = document.querySelectorAll(".tabbar__btn");
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        buttons.forEach((b) => b.classList.remove("tabbar__btn--active"));
        btn.classList.add("tabbar__btn--active");
        document.querySelectorAll(".view").forEach((v) => v.classList.remove("view--active"));
        document.getElementById(btn.dataset.view).classList.add("view--active");
        window.scrollTo({ top: 0 });
      });
    });
  }

  /* ---------------- Feedback mailto ---------------- */
  function initFeedback() {
    const link = $("#feedback-link");
    const subject = encodeURIComponent("FoodRx feedback");
    const body = encodeURIComponent("Hi Suva,\n\nHere's my feedback on FoodRx:\n\n");
    link.href = `mailto:suvadipchakraborty@gmail.com?subject=${subject}&body=${body}`;
  }

  /* ---------------- Service worker ---------------- */
  function initServiceWorker() {
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("sw.js").catch(() => {});
      });
    }
  }

  /* ---------------- Init ---------------- */
  document.addEventListener("DOMContentLoaded", () => {
    initDisclaimer();
    renderChips();
    updateGenerateButton();
    initAccordions();
    initResultActions();
    initShare();
    initTabs();
    initFeedback();
    initServiceWorker();
    generateBtn.addEventListener("click", generate);
  });
})();
