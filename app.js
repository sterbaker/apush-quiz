(function () {
  "use strict";

  const STORAGE_KEY = "apush_road_to_5_state_v1";
  const CUSTOM_QS_KEY = "apush_road_to_5_custom_qs_v1";

  // Application State
  let userStats = loadStats();
  let customGeneratedData = loadCustomQuestions();

  // Merge built-in APUSH_DATA with any AI-generated custom stimuli/questions
  function getFullBank() {
    const base = window.APUSH_DATA || { units: [], stimuli: {}, questions: [] };
    const mergedStimuli = Object.assign({}, base.stimuli, customGeneratedData.stimuli || {});
    const mergedQuestions = [...base.questions, ...(customGeneratedData.questions || [])];
    return {
      units: base.units,
      stimuli: mergedStimuli,
      questions: mergedQuestions
    };
  }

  function loadStats() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.warn("Could not read localStorage stats:", e);
    }
    return {
      theme: "light",
      quizzesCompleted: 0,
      questionHistory: {}, // qId -> { attempts, correct, lastCorrect, lastSeen }
      topicStats: {},      // topicId -> { attempts, correct }
      skillStats: {},      // skillName -> { attempts, correct }
      recentQuizzes: []    // [{ date, scorePct, correct, total, label }]
    };
  }

  function saveStats() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(userStats));
    } catch (e) {
      console.warn("Could not save localStorage stats:", e);
    }
  }

  function loadCustomQuestions() {
    try {
      const raw = localStorage.getItem(CUSTOM_QS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { stimuli: {}, questions: [] };
  }

  function saveCustomQuestions() {
    try {
      localStorage.setItem(CUSTOM_QS_KEY, JSON.stringify(customGeneratedData));
    } catch (e) {}
  }

  // Active Quiz Session State
  let activeQuiz = null;
  let timerInterval = null;

  // ==================== INITIALIZATION ====================
  document.addEventListener("DOMContentLoaded", () => {
    initTheme();
    initNavigation();
    renderUnitsFilterUI([3]); // Default to Unit 3 selected
    initBuilderControls();
    initQuizControls();
    initResultsControls();
    initAiModalControls();
    refreshDashboardAndMastery();
  });

  // ==================== THEME ====================
  function initTheme() {
    applyTheme(userStats.theme || "light");
    const btn = document.getElementById("themeToggleBtn");
    if (btn) {
      btn.addEventListener("click", () => {
        const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
        applyTheme(next);
        userStats.theme = next;
        saveStats();
      });
    }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const sun = document.getElementById("themeIconSun");
    const moon = document.getElementById("themeIconMoon");
    if (sun && moon) {
      if (theme === "dark") {
        sun.classList.remove("hidden");
        moon.classList.add("hidden");
      } else {
        sun.classList.add("hidden");
        moon.classList.remove("hidden");
      }
    }
  }

  // ==================== VIEW NAVIGATION ====================
  function initNavigation() {
    const tabs = document.querySelectorAll(".nav-tab");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const target = tab.getAttribute("data-view");
        switchView(target);
      });
    });

    const brandHome = document.getElementById("brandHomeBtn");
    if (brandHome) {
      brandHome.addEventListener("click", () => switchView("dashboard"));
    }
  }

  function switchView(viewName) {
    if (viewName !== "quiz" && timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }

    document.querySelectorAll(".view-section").forEach((sec) => {
      sec.classList.remove("active");
    });
    const targetSec = document.getElementById(`view-${viewName}`);
    if (targetSec) targetSec.classList.add("active");

    document.querySelectorAll(".nav-tab").forEach((tab) => {
      tab.classList.toggle("active", tab.getAttribute("data-view") === viewName);
    });

    if (viewName === "dashboard" || viewName === "mastery") {
      refreshDashboardAndMastery();
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ==================== DASHBOARD & BUILDER UI ====================
  let showCumulativeDrawer = false;

  function renderUnitsFilterUI(defaultSelectedUnitIds, explicitTopicsList) {
    const bank = getFullBank();
    const container = document.getElementById("unitsFilterContainer");
    if (!container) return;
    container.innerHTML = "";

    // Always put Unit 3 FIRST as urgent primary focus, followed by Units 1 and 2 inside a collapsible general-knowledge drawer
    const unit3 = bank.units.find((u) => u.id === 3);
    const earlierUnits = bank.units.filter((u) => u.id !== 3);

    function buildUnitBox(unit, isPrimary) {
      const box = document.createElement("div");
      box.className = `unit-filter-box ${isPrimary ? "primary-unit-box" : ""}`;

      const topicsHtml = unit.topics
        .map((t) => {
          const isChecked = explicitTopicsList
            ? explicitTopicsList.includes(t.id)
            : defaultSelectedUnitIds.includes(unit.id);
          const st = userStats.topicStats[t.id] || { attempts: 0, correct: 0 };
          const qCount = bank.questions.filter((q) => q.topic === t.id).length;
          let badgeClass = "acc-none";
          let badgeText = `${qCount} Qs`;
          if (st.attempts > 0) {
            const pct = Math.round((st.correct / st.attempts) * 100);
            badgeText = `${pct}%`;
            badgeClass = pct >= 80 ? "acc-high" : pct >= 60 ? "acc-med" : "acc-low";
          }
          return `
            <div class="topic-check-item">
              <label class="topic-check-left">
                <input type="checkbox" class="topic-checkbox" data-unit="${unit.id}" value="${t.id}" ${isChecked ? "checked" : ""} />
                <span><strong>${t.id}</strong> ${t.title}</span>
              </label>
              <div class="topic-check-right">
                <span class="topic-acc-mini ${badgeClass}" title="${qCount} questions in bank">${badgeText}</span>
                <button type="button" class="btn-only-topic" data-only-topic="${t.id}" title="Check ONLY section ${t.id}">Only</button>
                <button type="button" class="btn-only-topic" data-launch-topic="${t.id}" data-launch-title="${t.title}" title="Start immediate quiz on section ${t.id}">Quiz &rarr;</button>
              </div>
            </div>
          `;
        })
        .join("");

      const anyChecked = explicitTopicsList
        ? unit.topics.some((t) => explicitTopicsList.includes(t.id))
        : defaultSelectedUnitIds.includes(unit.id);

      box.innerHTML = `
        <div class="unit-filter-header">
          <label class="unit-header-left">
            <input type="checkbox" class="unit-master-checkbox" data-unit="${unit.id}" ${anyChecked ? "checked" : ""} />
            <span>${unit.code}: ${unit.title} — <em>${unit.subtitle}</em></span>
          </label>
          <span class="unit-weight-pill">${unit.weight}</span>
        </div>
        <div class="topics-checkbox-grid">
          ${topicsHtml}
        </div>
      `;
      return box;
    }

    if (unit3) {
      container.appendChild(buildUnitBox(unit3, true));
    }

    // Optional collapsible section for General / Cumulative Knowledge (Units 1 & 2)
    if (earlierUnits.length > 0) {
      const hasEarlierSelected =
        defaultSelectedUnitIds.some((id) => id !== 3) ||
        (explicitTopicsList && explicitTopicsList.some((t) => !t.startsWith("3.")));
      if (hasEarlierSelected) showCumulativeDrawer = true;

      const toggleDivider = document.createElement("div");
      toggleDivider.className = "general-knowledge-divider";
      toggleDivider.innerHTML = `
        <span><strong>General / Cumulative Knowledge (Units 1–2: 1491–1754)</strong> — Keep collapsed to focus 100% on Unit 3, or expand when ready</span>
        <span>${showCumulativeDrawer ? "Hide Units 1–2 &#9650;" : "Show Units 1–2 &#9660;"}</span>
      `;

      const drawerWrap = document.createElement("div");
      drawerWrap.style.display = showCumulativeDrawer ? "flex" : "none";
      drawerWrap.style.flexDirection = "column";
      drawerWrap.style.gap = "0.75rem";

      earlierUnits.forEach((u) => {
        drawerWrap.appendChild(buildUnitBox(u, false));
      });

      toggleDivider.addEventListener("click", () => {
        showCumulativeDrawer = !showCumulativeDrawer;
        drawerWrap.style.display = showCumulativeDrawer ? "flex" : "none";
        toggleDivider.querySelector("span:last-child").innerHTML = showCumulativeDrawer
          ? "Hide Units 1–2 &#9650;"
          : "Show Units 1–2 &#9660;";
      });

      container.appendChild(toggleDivider);
      container.appendChild(drawerWrap);
    }

    // Bind master unit checkboxes
    container.querySelectorAll(".unit-master-checkbox").forEach((masterCb) => {
      masterCb.addEventListener("change", () => {
        const uId = masterCb.getAttribute("data-unit");
        container.querySelectorAll(`.topic-checkbox[data-unit="${uId}"]`).forEach((cb) => {
          cb.checked = masterCb.checked;
        });
        clearClusterHighlight();
        updateMatchingPoolBadge();
      });
    });

    // Bind individual topic checkboxes
    container.querySelectorAll(".topic-checkbox").forEach((topicCb) => {
      topicCb.addEventListener("change", () => {
        const uId = topicCb.getAttribute("data-unit");
        const allInUnit = Array.from(container.querySelectorAll(`.topic-checkbox[data-unit="${uId}"]`));
        const masterCb = container.querySelector(`.unit-master-checkbox[data-unit="${uId}"]`);
        if (masterCb) {
          masterCb.checked = allInUnit.some((c) => c.checked);
        }
        clearClusterHighlight();
        updateMatchingPoolBadge();
      });
    });

    // Bind "Only" single-section buttons
    container.querySelectorAll("[data-only-topic]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const targetTopic = btn.getAttribute("data-only-topic");
        container.querySelectorAll(".topic-checkbox").forEach((cb) => {
          cb.checked = cb.value === targetTopic;
        });
        container.querySelectorAll(".unit-master-checkbox").forEach((mCb) => {
          const uId = mCb.getAttribute("data-unit");
          mCb.checked = targetTopic.startsWith(`${uId}.`);
        });
        clearClusterHighlight();
        updateMatchingPoolBadge();
      });
    });

    // Bind instant "Quiz ->" single-section launch buttons
    container.querySelectorAll("[data-launch-topic]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const targetTopic = btn.getAttribute("data-launch-topic");
        const targetTitle = btn.getAttribute("data-launch-title");
        generateAndStartQuiz({
          label: `Section ${targetTopic}: ${targetTitle}`,
          strategy: "smart",
          topics: [targetTopic],
          format: "all",
          count: 8,
          feedbackMode: "tutor",
          timerEnabled: true,
          shuffleOptions: true
        });
      });
    });

    updateMatchingPoolBadge();
  }

  function clearClusterHighlight() {
    document.querySelectorAll(".cluster-pill").forEach((p) => p.classList.remove("active"));
  }

  function initBuilderControls() {
    // Strategy radio cards visual highlight
    const strategyRadios = document.querySelectorAll('input[name="quizStrategy"]');
    strategyRadios.forEach((radio) => {
      radio.addEventListener("change", () => {
        document.querySelectorAll("#quizStrategyGrid .mode-option").forEach((opt) => {
          opt.classList.remove("selected");
        });
        if (radio.closest(".mode-option")) {
          radio.closest(".mode-option").classList.add("selected");
        }
        updateMatchingPoolBadge();
      });
    });

    // Unit 3 Only / Clear All / Cumulative Quick Toggles
    const btnUnit3Only = document.getElementById("selectUnit3OnlyBtn");
    const btnClearTopics = document.getElementById("clearTopicsBtn");
    const btnAllUnits = document.getElementById("selectAllUnitsBtn");

    if (btnUnit3Only) {
      btnUnit3Only.addEventListener("click", () => {
        btnUnit3Only.classList.add("active");
        btnClearTopics?.classList.remove("active");
        btnAllUnits?.classList.remove("active");
        clearClusterHighlight();
        showCumulativeDrawer = false;
        renderUnitsFilterUI([3]);
      });
    }

    if (btnClearTopics) {
      btnClearTopics.addEventListener("click", () => {
        btnClearTopics.classList.add("active");
        btnUnit3Only?.classList.remove("active");
        btnAllUnits?.classList.remove("active");
        clearClusterHighlight();
        renderUnitsFilterUI([], []);
      });
    }

    if (btnAllUnits) {
      btnAllUnits.addEventListener("click", () => {
        btnAllUnits.classList.add("active");
        btnUnit3Only?.classList.remove("active");
        btnClearTopics?.classList.remove("active");
        clearClusterHighlight();
        showCumulativeDrawer = true;
        renderUnitsFilterUI([1, 2, 3]);
      });
    }

    // Unit 3 Module Cluster Pills (3.2-3.4, 3.5-3.6, 3.7-3.9, 3.10-3.12)
    document.querySelectorAll(".cluster-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        const topicsList = (pill.getAttribute("data-cluster") || "").split(",").filter(Boolean);
        document.querySelectorAll(".cluster-pill").forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
        btnUnit3Only?.classList.remove("active");
        btnClearTopics?.classList.remove("active");
        btnAllUnits?.classList.remove("active");
        renderUnitsFilterUI([3], topicsList);
      });
    });

    const formatSelect = document.getElementById("questionFormatSelect");
    if (formatSelect) {
      formatSelect.addEventListener("change", updateMatchingPoolBadge);
    }

    // Start Custom Quiz Button
    const startBtn = document.getElementById("startCustomQuizBtn");
    if (startBtn) {
      startBtn.addEventListener("click", () => {
        const config = readBuilderConfig();
        generateAndStartQuiz(config);
      });
    }

    // 1-Click Smart Preset Chips
    document.querySelectorAll(".preset-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const preset = chip.getAttribute("data-preset");
        launchPresetQuiz(preset);
      });
    });

    // Hero inline action buttons
    const quickU3Btn = document.getElementById("quickUnit3DrillBtn");
    if (quickU3Btn) {
      quickU3Btn.addEventListener("click", () => launchPresetQuiz("unit3-adaptive"));
    }

    const quickWeakBtn = document.getElementById("quickWeakDrillBtn");
    if (quickWeakBtn) {
      quickWeakBtn.addEventListener("click", () => launchPresetQuiz("weak-remediation"));
    }

    const masteryWeakBtn = document.getElementById("masteryWeakestDrillBtn");
    if (masteryWeakBtn) {
      masteryWeakBtn.addEventListener("click", () => launchPresetQuiz("weak-remediation"));
    }

    const resetBtn = document.getElementById("resetStatsBtn");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        if (confirm("Reset your quiz history and mastery analytics? Your question bank will remain intact.")) {
          userStats = {
            theme: userStats.theme || "light",
            quizzesCompleted: 0,
            questionHistory: {},
            topicStats: {},
            skillStats: {},
            recentQuizzes: []
          };
          saveStats();
          renderUnitsFilterUI([3]);
          refreshDashboardAndMastery();
        }
      });
    }
  }

  function getSelectedTopicsFromUI() {
    const checked = Array.from(document.querySelectorAll(".topic-checkbox:checked"));
    return checked.map((cb) => cb.value);
  }

  function readBuilderConfig() {
    const strategyEl = document.querySelector('input[name="quizStrategy"]:checked');
    const strategy = strategyEl ? strategyEl.value : "smart";
    let topics = getSelectedTopicsFromUI();
    if (topics.length === 0) {
      alert("Please check at least one section to quiz (or click one of the Unit 3 Module buttons)!");
      const bank = getFullBank();
      const u3 = bank.units.find((u) => u.id === 3);
      topics = u3 ? u3.topics.map((t) => t.id) : [];
      renderUnitsFilterUI([3]);
    }
    const format = document.getElementById("questionFormatSelect")?.value || "all";
    const count = parseInt(document.getElementById("questionCountSelect")?.value || "10", 10);
    const feedbackMode = document.getElementById("feedbackModeSelect")?.value || "tutor";
    const timerEnabled = document.getElementById("apTimerCheckbox")?.checked ?? true;
    const shuffleOptions = document.getElementById("shuffleOptionsCheckbox")?.checked ?? true;

    const label =
      topics.length <= 3
        ? `Unit 3 Sections (${topics.join(", ")})`
        : strategy === "weak"
        ? "Weak Section Remediation"
        : "Unit 3 Custom Practice";

    return {
      label,
      strategy,
      topics,
      format,
      count,
      feedbackMode,
      timerEnabled,
      shuffleOptions
    };
  }

  function updateMatchingPoolBadge() {
    const bank = getFullBank();
    const topics = getSelectedTopicsFromUI();
    const format = document.getElementById("questionFormatSelect")?.value || "all";

    const matching = bank.questions.filter((q) => {
      if (!topics.includes(q.topic)) return false;
      if (format === "stimulus" && !q.stimulusId) return false;
      if (format === "standalone" && q.stimulusId) return false;
      return true;
    });

    const badge = document.getElementById("poolCountBadge");
    if (badge) {
      badge.textContent = `${topics.length} Section${topics.length === 1 ? "" : "s"} (${matching.length} Questions)`;
    }
  }

  function launchPresetQuiz(presetName) {
    const bank = getFullBank();
    const u3Topics = bank.units.find((u) => u.id === 3)?.topics.map((t) => t.id) || [];
    const allTopics = bank.units.flatMap((u) => u.topics.map((t) => t.id));

    if (presetName === "u3-part-a") {
      generateAndStartQuiz({
        label: "Unit 3A: Imperial Crisis & Taxes (3.2–3.4)",
        strategy: "smart",
        topics: ["3.2", "3.3", "3.4"],
        format: "all",
        count: 10,
        feedbackMode: "tutor",
        timerEnabled: true,
        shuffleOptions: true
      });
    } else if (presetName === "u3-part-b") {
      generateAndStartQuiz({
        label: "Unit 3B: Revolutionary War & Ideals (3.5–3.6)",
        strategy: "smart",
        topics: ["3.5", "3.6"],
        format: "all",
        count: 9,
        feedbackMode: "tutor",
        timerEnabled: true,
        shuffleOptions: true
      });
    } else if (presetName === "u3-part-c") {
      generateAndStartQuiz({
        label: "Unit 3C: Articles & Constitution (3.7–3.9)",
        strategy: "smart",
        topics: ["3.7", "3.8", "3.9"],
        format: "all",
        count: 12,
        feedbackMode: "tutor",
        timerEnabled: true,
        shuffleOptions: true
      });
    } else if (presetName === "u3-part-d") {
      generateAndStartQuiz({
        label: "Unit 3D: Early Republic & Hamilton (3.10–3.12)",
        strategy: "smart",
        topics: ["3.10", "3.11", "3.12"],
        format: "all",
        count: 12,
        feedbackMode: "tutor",
        timerEnabled: true,
        shuffleOptions: true
      });
    } else if (presetName === "unit3-adaptive") {
      generateAndStartQuiz({
        label: "Unit 3 Smart Adaptive Quiz (All 3.2–3.12)",
        strategy: "smart",
        topics: u3Topics,
        format: "all",
        count: 12,
        feedbackMode: "tutor",
        timerEnabled: true,
        shuffleOptions: true
      });
    } else if (presetName === "unit3-stimulus") {
      generateAndStartQuiz({
        label: "Unit 3 AP Stimulus Set Drill",
        strategy: "smart",
        topics: u3Topics,
        format: "stimulus",
        count: 10,
        feedbackMode: "tutor",
        timerEnabled: true,
        shuffleOptions: true
      });
    } else if (presetName === "weak-remediation") {
      generateAndStartQuiz({
        label: "Weak Unit 3 Sections & Missed Qs Drill",
        strategy: "weak",
        topics: u3Topics,
        format: "all",
        count: 10,
        feedbackMode: "tutor",
        timerEnabled: true,
        shuffleOptions: true
      });
    } else if (presetName === "cumulative-exam") {
      generateAndStartQuiz({
        label: "Cumulative Units 1–3 Exam Simulation",
        strategy: "smart",
        topics: allTopics,
        format: "all",
        count: 20,
        feedbackMode: "exam",
        timerEnabled: true,
        shuffleOptions: true
      });
    }
  }

  // ==================== SMART AUTO-QUIZ GENERATOR ENGINE ====================
  function shuffleArray(arr) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function computeQuestionPriorityScore(q, strategy) {
    const qHist = userStats.questionHistory[q.id];
    const tStat = userStats.topicStats[q.topic];
    const topicAcc = tStat && tStat.attempts > 0 ? tStat.correct / tStat.attempts : null;

    if (strategy === "random") {
      return Math.random() * 100;
    }

    if (strategy === "unseen") {
      if (!qHist || qHist.attempts === 0) return 100 + Math.random() * 20;
      return Math.random() * 10;
    }

    if (strategy === "weak") {
      let score = 0;
      // Highest priority: previously missed questions
      if (qHist && !qHist.lastCorrect) score += 80;
      // Next priority: belongs to a weak topic (<75% accuracy)
      if (topicAcc !== null && topicAcc < 0.75) score += (1 - topicAcc) * 60;
      // Unseen questions in unpracticed topics
      if (!qHist) score += 25;
      return score + Math.random() * 15;
    }

    // Default: "smart" adaptive mix
    let score = 40;
    if (!qHist || qHist.attempts === 0) {
      score += 35; // Favor unseen questions first
    } else if (!qHist.lastCorrect) {
      score += 50; // Strongly favor missed questions
    } else {
      score -= Math.min(30, qHist.attempts * 10); // De-prioritize already mastered questions
    }

    if (topicAcc !== null && topicAcc < 0.75) {
      score += (0.8 - topicAcc) * 40;
    }
    if (q.unit === 3) {
      score += 8; // Slight boost for Unit 3 primary focus
    }
    return score + Math.random() * 15;
  }

  function generateAndStartQuiz(config) {
    const bank = getFullBank();

    // 1. Filter candidate pool
    let candidates = bank.questions.filter((q) => {
      if (config.specificQuestionIds && config.specificQuestionIds.length > 0) {
        return config.specificQuestionIds.includes(q.id);
      }
      if (!config.topics.includes(q.topic)) return false;
      if (config.format === "stimulus" && !q.stimulusId) return false;
      if (config.format === "standalone" && q.stimulusId) return false;
      return true;
    });

    if (candidates.length === 0) {
      // Fallback if strict filter yielded 0
      candidates = bank.questions.filter((q) => config.topics.includes(q.topic));
    }
    if (candidates.length === 0) {
      candidates = [...bank.questions];
    }

    // 2. Score and sort candidates
    const scored = candidates.map((q) => ({
      q,
      weight: computeQuestionPriorityScore(q, config.strategy)
    }));
    scored.sort((a, b) => b.weight - a.weight);

    // 3. Select top N questions, keeping stimulus sets grouped nicely together!
    const targetCount = Math.min(config.count, scored.length);
    const selectedQuestions = [];
    const usedIds = new Set();

    for (const item of scored) {
      if (selectedQuestions.length >= targetCount) break;
      if (usedIds.has(item.q.id)) continue;

      if (item.q.stimulusId && config.strategy !== "random" && !config.specificQuestionIds) {
        // Pull sibling questions sharing the same stimulus so it feels like a real AP stimulus set (2-3 Qs per source)
        const siblings = candidates.filter((cand) => cand.stimulusId === item.q.stimulusId);
        for (const sib of siblings) {
          if (selectedQuestions.length < targetCount && !usedIds.has(sib.id)) {
            selectedQuestions.push(sib);
            usedIds.add(sib.id);
          }
        }
      } else {
        selectedQuestions.push(item.q);
        usedIds.add(item.q.id);
      }
    }

    // 4. Prepare session items with shuffled options if enabled
    const letters = ["A", "B", "C", "D"];
    const sessionItems = selectedQuestions.map((q) => {
      const rawOptions = q.options.map((opt) => Object.assign({}, opt));
      const finalOptions = config.shuffleOptions ? shuffleArray(rawOptions) : rawOptions;
      finalOptions.forEach((opt, idx) => {
        opt.displayLetter = letters[idx] || String.fromCharCode(65 + idx);
      });

      return {
        question: q,
        options: finalOptions,
        selectedIndex: null,
        eliminatedIndices: new Set(),
        isSubmitted: false,
        isCorrect: false,
        flagged: false
      };
    });

    activeQuiz = {
      config,
      items: sessionItems,
      currentIndex: 0,
      startTimeMs: Date.now(),
      elapsedSeconds: 0
    };

    startQuizSessionUI();
  }

  // ==================== ACTIVE QUIZ RUNNER UI ====================
  function initQuizControls() {
    document.getElementById("exitQuizBtn")?.addEventListener("click", () => {
      if (confirm("Exit current quiz and return to dashboard?")) {
        switchView("dashboard");
      }
    });

    document.getElementById("flagQuestionBtn")?.addEventListener("click", () => {
      if (!activeQuiz) return;
      const item = activeQuiz.items[activeQuiz.currentIndex];
      item.flagged = !item.flagged;
      renderCurrentQuestion();
    });

    document.getElementById("prevQuestionBtn")?.addEventListener("click", () => {
      if (!activeQuiz || activeQuiz.currentIndex <= 0) return;
      activeQuiz.currentIndex--;
      renderCurrentQuestion();
    });

    document.getElementById("submitAnswerBtn")?.addEventListener("click", () => {
      handleCheckOrLockAnswer();
    });

    document.getElementById("nextQuestionBtn")?.addEventListener("click", () => {
      if (!activeQuiz) return;
      // In Exam Mode, if user selected an option and clicks Next, lock it automatically
      const item = activeQuiz.items[activeQuiz.currentIndex];
      if (activeQuiz.config.feedbackMode === "exam" && item.selectedIndex !== null && !item.isSubmitted) {
        commitItemSubmission(item);
      }

      if (activeQuiz.currentIndex < activeQuiz.items.length - 1) {
        activeQuiz.currentIndex++;
        renderCurrentQuestion();
      } else {
        finishQuizAndShowResults();
      }
    });

    // Keyboard shortcuts (A-D / 1-4, Enter, Arrows, F)
    document.addEventListener("keydown", (e) => {
      const quizSec = document.getElementById("view-quiz");
      if (!quizSec || !quizSec.classList.contains("active") || !activeQuiz) return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;

      const key = e.key.toUpperCase();
      const item = activeQuiz.items[activeQuiz.currentIndex];

      if (["1", "2", "3", "4"].includes(key)) {
        const idx = parseInt(key, 10) - 1;
        selectOptionIndex(idx);
      } else if (["A", "B", "C", "D"].includes(key)) {
        const idx = key.charCodeAt(0) - 65;
        selectOptionIndex(idx);
      } else if (key === "F") {
        item.flagged = !item.flagged;
        renderCurrentQuestion();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (!item.isSubmitted && item.selectedIndex !== null && activeQuiz.config.feedbackMode === "tutor") {
          handleCheckOrLockAnswer();
        } else {
          document.getElementById("nextQuestionBtn")?.click();
        }
      }
    });
  }

  function startQuizSessionUI() {
    switchView("quiz");

    const modeBadge = document.getElementById("activeQuizModeBadge");
    if (modeBadge) {
      modeBadge.textContent =
        activeQuiz.config.feedbackMode === "tutor"
          ? "Tutor Mode (Instant Rationale)"
          : "Exam Simulation Mode";
    }

    const timerBox = document.getElementById("quizTimerBox");
    if (timerBox) {
      timerBox.classList.toggle("hidden", !activeQuiz.config.timerEnabled);
    }

    if (timerInterval) clearInterval(timerInterval);
    activeQuiz.elapsedSeconds = 0;
    updateTimerDisplay();

    if (activeQuiz.config.timerEnabled) {
      timerInterval = setInterval(() => {
        activeQuiz.elapsedSeconds++;
        updateTimerDisplay();
      }, 1000);
    }

    renderCurrentQuestion();
  }

  function updateTimerDisplay() {
    if (!activeQuiz) return;
    const secs = activeQuiz.elapsedSeconds;
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    const timerText = document.getElementById("timerText");
    if (timerText) {
      timerText.textContent = `${String(mins).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
    }

    const paceEl = document.getElementById("paceIndicator");
    if (paceEl) {
      const targetSecsSoFar = (activeQuiz.currentIndex + 1) * 60;
      if (secs <= targetSecsSoFar) {
        paceEl.textContent = "AP Pace OK";
        paceEl.classList.remove("behind");
      } else {
        paceEl.textContent = "Behind 1m/Q Pace";
        paceEl.classList.add("behind");
      }
    }
  }

  function renderCurrentQuestion() {
    if (!activeQuiz) return;
    const bank = getFullBank();
    const idx = activeQuiz.currentIndex;
    const total = activeQuiz.items.length;
    const item = activeQuiz.items[idx];
    const q = item.question;

    document.getElementById("currentQIndex").textContent = idx + 1;
    document.getElementById("totalQCount").textContent = total;

    // Flag state
    const flagBtn = document.getElementById("flagQuestionBtn");
    if (flagBtn) {
      flagBtn.classList.toggle("active", item.flagged);
    }

    // Navigation dots
    const dotsContainer = document.getElementById("quizNavDots");
    if (dotsContainer) {
      dotsContainer.innerHTML = "";
      activeQuiz.items.forEach((it, i) => {
        const dot = document.createElement("button");
        dot.className = "q-dot";
        if (i === idx) dot.classList.add("current");
        if (it.flagged) dot.classList.add("flagged");
        if (it.isSubmitted) {
          if (activeQuiz.config.feedbackMode === "tutor") {
            dot.classList.add(it.isCorrect ? "correct" : "incorrect");
          } else {
            dot.classList.add("answered-exam");
          }
        } else if (it.selectedIndex !== null && activeQuiz.config.feedbackMode === "exam") {
          dot.classList.add("answered-exam");
        }
        dot.textContent = i + 1;
        dot.addEventListener("click", () => {
          activeQuiz.currentIndex = i;
          renderCurrentQuestion();
        });
        dotsContainer.appendChild(dot);
      });
    }

    // Stimulus Pane
    const workspace = document.getElementById("quizWorkspace");
    const stimPane = document.getElementById("stimulusPane");
    const stimObj = q.stimulusId ? bank.stimuli[q.stimulusId] : null;

    if (stimObj) {
      workspace.classList.remove("no-stimulus");
      stimPane.classList.remove("hidden");
      document.getElementById("stimulusTypeBadge").textContent = stimObj.type || "Primary Source";

      // Find which question numbers in this quiz share this stimulus
      const sharingIndices = [];
      activeQuiz.items.forEach((it, i) => {
        if (it.question.stimulusId === q.stimulusId) sharingIndices.push(i + 1);
      });
      const setLabel =
        sharingIndices.length > 1
          ? `Questions ${sharingIndices[0]}–${sharingIndices[sharingIndices.length - 1]} refer to the following source`
          : `Question ${idx + 1} refers to the following source`;

      document.getElementById("stimulusSetInfo").textContent = setLabel;
      document.getElementById("stimulusTitle").textContent = stimObj.title || "";
      document.getElementById("stimulusBody").innerHTML = stimObj.content || "";
      document.getElementById("stimulusAttribution").textContent = stimObj.attribution || "";
    } else {
      workspace.classList.add("no-stimulus");
      stimPane.classList.add("hidden");
    }

    // Question Meta Badges
    document.getElementById("qUnitBadge").textContent = `Unit ${q.unit}`;
    document.getElementById("qTopicBadge").textContent = `${q.topic} ${q.topicTitle || ""}`;
    document.getElementById("qSkillBadge").textContent = `Skill: ${q.skill || "Historical Analysis"}`;
    document.getElementById("qDiffBadge").textContent = q.difficulty || "Medium";
    document.getElementById("questionStem").textContent = q.stem;

    // Options List
    const optionsList = document.getElementById("optionsList");
    optionsList.innerHTML = "";
    const showTutorFeedback = item.isSubmitted && activeQuiz.config.feedbackMode === "tutor";

    item.options.forEach((opt, optIdx) => {
      const row = document.createElement("div");
      row.className = "option-row";

      const isSelected = item.selectedIndex === optIdx;
      const isEliminated = item.eliminatedIndices.has(optIdx);

      const card = document.createElement("button");
      card.type = "button";
      card.className = "option-card";
      if (isSelected) card.classList.add("selected");
      if (isEliminated && !showTutorFeedback) card.classList.add("eliminated");
      if (showTutorFeedback) {
        card.classList.add("locked");
        if (opt.isCorrect) {
          card.classList.add("correct-reveal");
        } else if (isSelected && !opt.isCorrect) {
          card.classList.add("wrong-reveal");
        }
      }

      let explanationHtml = "";
      if (showTutorFeedback) {
        const badgeHtml = opt.isCorrect
          ? `<span class="correct-pill">&#10003; Correct Answer</span>`
          : `<span class="distractor-pill">${opt.distractorType || "Distractor"}</span>`;
        explanationHtml = `
          <div class="option-explanation">
            ${badgeHtml} ${opt.explanation || ""}
          </div>
        `;
      }

      card.innerHTML = `
        <span class="option-letter">${opt.displayLetter}</span>
        <div class="option-content-wrap">
          <div class="option-text">${opt.text}</div>
          ${explanationHtml}
        </div>
      `;

      card.addEventListener("click", () => {
        selectOptionIndex(optIdx);
      });

      // Right-click to toggle strikethrough elimination
      card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        toggleEliminateOption(optIdx);
      });

      const strikeBtn = document.createElement("button");
      strikeBtn.type = "button";
      strikeBtn.className = `btn-strike ${isEliminated ? "active" : ""}`;
      strikeBtn.title = "Cross out / Eliminate this choice";
      strikeBtn.innerHTML = `<del>${opt.displayLetter}</del>`;
      strikeBtn.addEventListener("click", () => {
        toggleEliminateOption(optIdx);
      });

      row.appendChild(card);
      row.appendChild(strikeBtn);
      optionsList.appendChild(row);
    });

    // Action Buttons & Rationale Drawer
    const prevBtn = document.getElementById("prevQuestionBtn");
    const submitBtn = document.getElementById("submitAnswerBtn");
    const nextBtn = document.getElementById("nextQuestionBtn");

    if (prevBtn) prevBtn.disabled = idx === 0;

    if (activeQuiz.config.feedbackMode === "tutor") {
      submitBtn.classList.toggle("hidden", item.isSubmitted);
      submitBtn.disabled = item.selectedIndex === null;
      submitBtn.textContent = "Check Answer";
    } else {
      // Exam mode: no instant check needed
      submitBtn.classList.add("hidden");
    }

    if (nextBtn) {
      nextBtn.textContent = idx === total - 1 ? "Finish & Score Quiz \u2192" : "Next Question \u2192";
    }

    // Rationale Box
    const ratBox = document.getElementById("rationaleBox");
    if (showTutorFeedback) {
      ratBox.classList.remove("hidden");
      const banner = document.getElementById("rationaleBanner");
      banner.className = `rationale-banner ${item.isCorrect ? "correct" : "incorrect"}`;
      document.getElementById("rationaleHeadline").textContent = item.isCorrect
        ? "Correct! Spot-on historical analysis."
        : "Not quite — review the distractor breakdown above.";
      document.getElementById("rationaleSubline").textContent = item.isCorrect
        ? `Topic ${q.topic} (${q.skill}) mastery updated.`
        : `This question has been added to your Weak/Missed remediation queue so you can master it.`;
      document.getElementById("rationaleTakeawayText").textContent = q.keyTakeaway || "";
      document.getElementById("rationaleTestTipText").textContent = q.testTip || "";
    } else {
      ratBox.classList.add("hidden");
    }
  }

  function selectOptionIndex(optIdx) {
    if (!activeQuiz) return;
    const item = activeQuiz.items[activeQuiz.currentIndex];
    if (item.isSubmitted && activeQuiz.config.feedbackMode === "tutor") return;
    if (optIdx < 0 || optIdx >= item.options.length) return;

    // Un-eliminate if user selects it
    item.eliminatedIndices.delete(optIdx);
    item.selectedIndex = optIdx;
    renderCurrentQuestion();
  }

  function toggleEliminateOption(optIdx) {
    if (!activeQuiz) return;
    const item = activeQuiz.items[activeQuiz.currentIndex];
    if (item.isSubmitted && activeQuiz.config.feedbackMode === "tutor") return;

    if (item.eliminatedIndices.has(optIdx)) {
      item.eliminatedIndices.delete(optIdx);
    } else {
      item.eliminatedIndices.add(optIdx);
      if (item.selectedIndex === optIdx) {
        item.selectedIndex = null;
      }
    }
    renderCurrentQuestion();
  }

  function commitItemSubmission(item) {
    if (item.isSubmitted) return;
    item.isSubmitted = true;
    const chosen = item.selectedIndex !== null ? item.options[item.selectedIndex] : null;
    item.isCorrect = Boolean(chosen && chosen.isCorrect);

    // Record to persistent userStats
    const q = item.question;
    if (!userStats.questionHistory[q.id]) {
      userStats.questionHistory[q.id] = { attempts: 0, correct: 0, lastCorrect: false, lastSeen: 0 };
    }
    userStats.questionHistory[q.id].attempts++;
    if (item.isCorrect) userStats.questionHistory[q.id].correct++;
    userStats.questionHistory[q.id].lastCorrect = item.isCorrect;
    userStats.questionHistory[q.id].lastSeen = Date.now();

    if (!userStats.topicStats[q.topic]) {
      userStats.topicStats[q.topic] = { attempts: 0, correct: 0 };
    }
    userStats.topicStats[q.topic].attempts++;
    if (item.isCorrect) userStats.topicStats[q.topic].correct++;

    const skillKey = q.skill || "Historical Analysis";
    if (!userStats.skillStats[skillKey]) {
      userStats.skillStats[skillKey] = { attempts: 0, correct: 0 };
    }
    userStats.skillStats[skillKey].attempts++;
    if (item.isCorrect) userStats.skillStats[skillKey].correct++;

    saveStats();
  }

  function handleCheckOrLockAnswer() {
    if (!activeQuiz) return;
    const item = activeQuiz.items[activeQuiz.currentIndex];
    if (item.selectedIndex === null) return;
    commitItemSubmission(item);
    renderCurrentQuestion();
  }

  // ==================== RESULTS & DIAGNOSTIC REPORT ====================
  function finishQuizAndShowResults() {
    if (!activeQuiz) return;
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }

    // Ensure all questions are scored
    activeQuiz.items.forEach((item) => {
      if (!item.isSubmitted) {
        commitItemSubmission(item);
      }
    });

    const total = activeQuiz.items.length;
    const correct = activeQuiz.items.filter((it) => it.isCorrect).length;
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;

    userStats.quizzesCompleted = (userStats.quizzesCompleted || 0) + 1;
    userStats.recentQuizzes.unshift({
      date: new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
      scorePct: pct,
      correct,
      total,
      label: activeQuiz.config.label || "Practice Quiz"
    });
    userStats.recentQuizzes = userStats.recentQuizzes.slice(0, 8);
    saveStats();

    renderResultsScreen();
    switchView("results");
  }

  function initResultsControls() {
    document.getElementById("retryMissedBtn")?.addEventListener("click", () => {
      if (!activeQuiz) return;
      const missedIds = activeQuiz.items.filter((it) => !it.isCorrect).map((it) => it.question.id);
      if (missedIds.length === 0) return;

      generateAndStartQuiz({
        label: "Missed Questions Re-Test",
        strategy: "weak",
        topics: activeQuiz.config.topics,
        specificQuestionIds: missedIds,
        format: "all",
        count: missedIds.length,
        feedbackMode: "tutor",
        timerEnabled: true,
        shuffleOptions: true
      });
    });

    document.getElementById("drillWeakFromResultsBtn")?.addEventListener("click", () => {
      launchPresetQuiz("weak-remediation");
    });

    document.getElementById("backToDashboardFromResultsBtn")?.addEventListener("click", () => {
      renderUnitsFilterUI([3]);
      switchView("dashboard");
    });

    document.querySelectorAll("[data-review-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("[data-review-filter]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        renderQuestionReviewAccordion(btn.getAttribute("data-review-filter"));
      });
    });
  }

  function getProjectedApScoreInfo(pct) {
    if (pct >= 75) return { score: 5, label: "AP Score 5 Pace (Extremely Well Qualified)", headline: "Outstanding Command of APUSH!" };
    if (pct >= 62) return { score: 4, label: "AP Score 4 Pace (Well Qualified)", headline: "Strong Performance — Knocking on a 5!" };
    if (pct >= 50) return { score: 3, label: "AP Score 3 Pace (Qualified / Passing)", headline: "Solid Foundation — Room to Sharpen!" };
    return { score: 2, label: "Developing Mastery (Target: 62%+ for a 4/5)", headline: "Great Diagnostic Run — Let's Drill the Gaps!" };
  }

  function renderResultsScreen() {
    if (!activeQuiz) return;
    const total = activeQuiz.items.length;
    const correct = activeQuiz.items.filter((it) => it.isCorrect).length;
    const missed = total - correct;
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
    const apInfo = getProjectedApScoreInfo(pct);

    document.getElementById("resultPctText").textContent = `${pct}%`;
    document.getElementById("resultFractionText").textContent = `${correct} / ${total} Correct`;
    document.getElementById("resultApLevelBadge").textContent = apInfo.label;
    document.getElementById("resultHeadlineText").textContent = apInfo.headline;

    const secs = activeQuiz.elapsedSeconds || 1;
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    document.getElementById("resultTotalTime").textContent = `${String(mins).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
    document.getElementById("resultAvgPace").textContent = `${Math.round(secs / total)}s / question`;
    document.getElementById("resultFlaggedCount").textContent = activeQuiz.items.filter((i) => i.flagged).length;

    const retryBtn = document.getElementById("retryMissedBtn");
    const missedSpan = document.getElementById("missedCountBtnSpan");
    if (missedSpan) missedSpan.textContent = missed;
    if (retryBtn) retryBtn.disabled = missed === 0;

    // Topic & Skill breakdown in this quiz
    const topicMap = {};
    const skillMap = {};
    activeQuiz.items.forEach((it) => {
      const tKey = `${it.question.topic} ${it.question.topicTitle || ""}`;
      if (!topicMap[tKey]) topicMap[tKey] = { correct: 0, total: 0 };
      topicMap[tKey].total++;
      if (it.isCorrect) topicMap[tKey].correct++;

      const sKey = it.question.skill || "Historical Analysis";
      if (!skillMap[sKey]) skillMap[sKey] = { correct: 0, total: 0 };
      skillMap[sKey].total++;
      if (it.isCorrect) skillMap[sKey].correct++;
    });

    renderBreakdownBars("resultTopicBreakdown", topicMap);
    renderBreakdownBars("resultSkillBreakdown", skillMap);
    renderQuestionReviewAccordion("all");
  }

  function renderBreakdownBars(containerId, dataMap) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = Object.entries(dataMap)
      .map(([name, obj]) => {
        const p = Math.round((obj.correct / obj.total) * 100);
        return `
          <div class="breakdown-row">
            <div class="breakdown-row-top">
              <span>${name}</span>
              <span>${obj.correct}/${obj.total} (${p}%)</span>
            </div>
            <div class="progress-bar-track">
              <div class="progress-bar-fill" style="width: ${p}%"></div>
            </div>
          </div>
        `;
      })
      .join("");
  }

  function renderQuestionReviewAccordion(filterMode) {
    const container = document.getElementById("resultsQuestionReviewList");
    if (!container || !activeQuiz) return;

    const filtered = activeQuiz.items.filter((it) => {
      if (filterMode === "missed") return !it.isCorrect;
      if (filterMode === "flagged") return it.flagged;
      return true;
    });

    if (filtered.length === 0) {
      container.innerHTML = `<p style="color: var(--text-muted); padding: 1rem 0;">No questions match this filter.</p>`;
      return;
    }

    container.innerHTML = filtered
      .map((it) => {
        const q = it.question;
        const statusBadge = it.isCorrect
          ? `<span class="correct-pill">&#10003; Correct</span>`
          : `<span class="distractor-pill">&#10007; Missed</span>`;

        const optsHtml = it.options
          .map((opt, idx) => {
            const isUserChoice = it.selectedIndex === idx;
            let cls = "review-opt";
            if (opt.isCorrect) cls += " is-correct";
            else if (isUserChoice && !opt.isCorrect) cls += " is-user-wrong";

            const tag = opt.isCorrect
              ? `<span class="correct-pill">Correct Answer</span>`
              : isUserChoice
              ? `<span class="distractor-pill">Your Choice (${opt.distractorType || "Distractor"})</span>`
              : `<span class="distractor-pill">${opt.distractorType || "Distractor"}</span>`;

            return `
              <div class="${cls}">
                <div><strong>(${opt.displayLetter})</strong> ${opt.text}</div>
                <div style="margin-top: 0.3rem; font-size: 0.79rem; color: var(--text-secondary);">
                  ${tag} ${opt.explanation || ""}
                </div>
              </div>
            `;
          })
          .join("");

        return `
          <div class="review-q-item">
            <div class="review-q-top">
              <div>
                ${statusBadge}
                <span class="meta-badge unit-badge">Unit ${q.unit}</span>
                <span class="meta-badge topic-badge">${q.topic} ${q.topicTitle || ""}</span>
                <span class="meta-badge skill-badge">${q.skill || ""}</span>
              </div>
            </div>
            <div class="review-q-stem">${q.stem}</div>
            <div class="review-options-stack">${optsHtml}</div>
            <div style="margin-top: 0.65rem; font-size: 0.82rem; color: var(--text-secondary);">
              <strong>Key Takeaway:</strong> ${q.keyTakeaway || ""}
            </div>
          </div>
        `;
      })
      .join("");
  }

  // ==================== DASHBOARD & MASTERY ANALYTICS REFRESH ====================
  function refreshDashboardAndMastery() {
    const bank = getFullBank();

    // Compute overall totals
    let totalAttempts = 0;
    let totalCorrect = 0;
    Object.values(userStats.topicStats).forEach((st) => {
      totalAttempts += st.attempts;
      totalCorrect += st.correct;
    });

    const overallPct = totalAttempts > 0 ? Math.round((totalCorrect / totalAttempts) * 100) : null;
    document.getElementById("overallAccuracyVal").textContent = overallPct !== null ? `${overallPct}%` : "--%";
    document.getElementById("overallAnsweredSub").textContent = `${totalAttempts} questions answered across ${userStats.quizzesCompleted || 0} quizzes`;
    document.getElementById("overallProgressFill").style.width = `${overallPct || 0}%`;

    const projBadge = document.getElementById("projectedApBadge");
    if (projBadge) {
      if (overallPct === null) projBadge.textContent = "Take a Quiz";
      else projBadge.textContent = `Projected AP Score: ${getProjectedApScoreInfo(overallPct).score}`;
    }

    // Unit 3 specific mastery
    const u3 = bank.units.find((u) => u.id === 3);
    let u3Attempts = 0;
    let u3Correct = 0;
    let u3PracticedTopics = 0;
    if (u3) {
      u3.topics.forEach((t) => {
        const st = userStats.topicStats[t.id];
        if (st && st.attempts > 0) {
          u3Attempts += st.attempts;
          u3Correct += st.correct;
          u3PracticedTopics++;
        }
      });
    }
    const u3Pct = u3Attempts > 0 ? Math.round((u3Correct / u3Attempts) * 100) : null;
    document.getElementById("unit3AccuracyVal").textContent = u3Pct !== null ? `${u3Pct}%` : "--%";
    document.getElementById("unit3CoverageSub").textContent = `${u3PracticedTopics} / ${u3 ? u3.topics.length : 11} Unit 3 sub-topics practiced`;

    // Identify weakest practiced topic (or suggest diagnostic)
    const allTopicsFlat = bank.units.flatMap((u) => u.topics);
    let weakestTopic = null;
    let lowestAcc = 999;

    allTopicsFlat.forEach((t) => {
      const st = userStats.topicStats[t.id];
      if (st && st.attempts > 0) {
        const acc = Math.round((st.correct / st.attempts) * 100);
        if (acc < lowestAcc) {
          lowestAcc = acc;
          weakestTopic = t;
        }
      }
    });

    const weakBadge = document.getElementById("weakestBadge");
    const weakName = document.getElementById("weakestTopicName");
    if (weakestTopic) {
      weakBadge.textContent = `${lowestAcc}% Accuracy`;
      weakName.textContent = `Topic ${weakestTopic.id}: ${weakestTopic.title}`;
    } else {
      weakBadge.textContent = "Ready to Start";
      weakName.textContent = "Take a Unit 3 Adaptive Quiz to pinpoint your weakest sub-topics";
    }

    // Recent quiz history list
    const histContainer = document.getElementById("recentHistoryList");
    if (histContainer) {
      if (!userStats.recentQuizzes || userStats.recentQuizzes.length === 0) {
        histContainer.innerHTML = `<p style="font-size: 0.82rem; color: var(--text-muted);">No quizzes completed yet. Pick a preset above or click "Generate & Start Quiz"!</p>`;
      } else {
        histContainer.innerHTML = userStats.recentQuizzes
          .map((rq) => {
            const cls = rq.scorePct >= 75 ? "acc-high" : rq.scorePct >= 60 ? "acc-med" : "acc-low";
            return `
              <div class="history-item">
                <div>
                  <strong>${rq.label}</strong>
                  <div style="font-size: 0.72rem; color: var(--text-muted);">${rq.date} &bull; ${rq.correct}/${rq.total} Qs</div>
                </div>
                <span class="history-score ${cls}">${rq.scorePct}%</span>
              </div>
            `;
          })
          .join("");
      }
    }

    renderMasteryMatrixView(bank);
  }

  function renderMasteryMatrixView(bank) {
    // 1. Skills Grid
    const skillsGrid = document.getElementById("skillsMasteryGrid");
    if (skillsGrid) {
      const defaultSkills = [
        "Causation",
        "Comparison",
        "Continuity & Change",
        "Contextualization",
        "Sourcing & Situation",
        "Claims & Evidence"
      ];
      skillsGrid.innerHTML = defaultSkills
        .map((sk) => {
          const st = userStats.skillStats[sk] || { attempts: 0, correct: 0 };
          const pct = st.attempts > 0 ? `${Math.round((st.correct / st.attempts) * 100)}%` : "--%";
          return `
            <div class="skill-stat-box">
              <div class="skill-stat-name">${sk}</div>
              <div class="skill-stat-val">${pct}</div>
              <div style="font-size: 0.74rem; color: var(--text-muted);">${st.correct}/${st.attempts} correct</div>
            </div>
          `;
        })
        .join("");
    }

    // 2. Unit & Sub-Topic Tables with 1-Click Drill Buttons
    const unitStack = document.getElementById("unitMasteryContainers");
    if (!unitStack) return;
    unitStack.innerHTML = "";

    // Show Unit 3 first on Mastery view since the student is in Unit 3, followed by Units 1 and 2
    const orderedUnits = [...bank.units].sort((a, b) => (a.id === 3 ? -1 : b.id === 3 ? 1 : a.id - b.id));

    orderedUnits.forEach((unit) => {
      const card = document.createElement("div");
      card.className = "card";

      const rowsHtml = unit.topics
        .map((t) => {
          const qCount = bank.questions.filter((q) => q.topic === t.id).length;
          const st = userStats.topicStats[t.id] || { attempts: 0, correct: 0 };
          const pct = st.attempts > 0 ? Math.round((st.correct / st.attempts) * 100) : null;
          const badgeCls = pct === null ? "acc-none" : pct >= 80 ? "acc-high" : pct >= 60 ? "acc-med" : "acc-low";
          const statusLabel = pct === null ? "Not Practiced" : `${pct}% (${st.correct}/${st.attempts})`;

          return `
            <tr>
              <td><strong>${t.id}</strong></td>
              <td>${t.title}</td>
              <td>${qCount} Qs</td>
              <td><span class="topic-acc-mini ${badgeCls}">${statusLabel}</span></td>
              <td>
                <button class="btn-xs drill-single-topic-btn" data-topic="${t.id}" data-title="${t.title}">
                  Drill Topic ${t.id} &rarr;
                </button>
              </td>
            </tr>
          `;
        })
        .join("");

      card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
          <div>
            <h3>${unit.code}: ${unit.title} — ${unit.subtitle}</h3>
            <p style="font-size:0.82rem; color:var(--text-secondary);">${unit.weight}</p>
          </div>
          <button class="btn-secondary drill-unit-btn" data-unit="${unit.id}">
            Quiz All ${unit.code} Topics
          </button>
        </div>
        <table class="topic-mastery-table">
          <thead>
            <tr>
              <th>Topic</th>
              <th>Title</th>
              <th>Bank Size</th>
              <th>Accuracy</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      `;
      unitStack.appendChild(card);
    });

    // Bind 1-click topic drills
    unitStack.querySelectorAll(".drill-single-topic-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const topicId = btn.getAttribute("data-topic");
        const topicTitle = btn.getAttribute("data-title");
        generateAndStartQuiz({
          label: `Topic ${topicId}: ${topicTitle} Drill`,
          strategy: "smart",
          topics: [topicId],
          format: "all",
          count: 8,
          feedbackMode: "tutor",
          timerEnabled: true,
          shuffleOptions: true
        });
      });
    });

    unitStack.querySelectorAll(".drill-unit-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const uId = parseInt(btn.getAttribute("data-unit"), 10);
        const unitObj = bank.units.find((u) => u.id === uId);
        if (!unitObj) return;
        generateAndStartQuiz({
          label: `${unitObj.code} Comprehensive Practice`,
          strategy: "smart",
          topics: unitObj.topics.map((t) => t.id),
          format: "all",
          count: 12,
          feedbackMode: "tutor",
          timerEnabled: true,
          shuffleOptions: true
        });
      });
    });
  }

  // ==================== OPTIONAL AI QUESTION GENERATOR MODAL ====================
  function initAiModalControls() {
    const backdrop = document.getElementById("aiModalBackdrop");
    const openBtn = document.getElementById("openAiModalBtn");
    const closeBtn = document.getElementById("closeAiModalBtn");
    const cancelBtn = document.getElementById("cancelAiModalBtn");
    const genBtn = document.getElementById("generateAiQuestionsBtn");
    const topicSelect = document.getElementById("aiTopicSelect");

    // Populate topics dropdown in AI modal
    const bank = getFullBank();
    if (topicSelect) {
      topicSelect.innerHTML = bank.units
        .flatMap((u) =>
          u.topics.map(
            (t) => `<option value="${t.id}" ${t.id === "3.3" ? "selected" : ""}>Unit ${u.id} — ${t.id}: ${t.title}</option>`
          )
        )
        .join("");
    }

    const openModal = () => {
      backdrop?.classList.remove("hidden");
      const savedKey = localStorage.getItem("apush_ai_api_key") || "";
      const keyInput = document.getElementById("aiApiKeyInput");
      if (keyInput && savedKey) keyInput.value = savedKey;
    };
    const closeModal = () => backdrop?.classList.add("hidden");

    openBtn?.addEventListener("click", openModal);
    closeBtn?.addEventListener("click", closeModal);
    cancelBtn?.addEventListener("click", closeModal);

    genBtn?.addEventListener("click", async () => {
      const provider = document.getElementById("aiProviderSelect")?.value || "gemini";
      const apiKey = document.getElementById("aiApiKeyInput")?.value.trim();
      const topicId = document.getElementById("aiTopicSelect")?.value || "3.3";
      const style = document.getElementById("aiStyleSelect")?.value || "stimulus";
      const statusEl = document.getElementById("aiStatusMessage");

      if (!apiKey) {
        statusEl.classList.remove("hidden");
        statusEl.textContent = "Please enter a valid Gemini or OpenAI API key.";
        return;
      }

      localStorage.setItem("apush_ai_api_key", apiKey);
      const unitNum = parseInt(topicId.split(".")[0], 10);
      const topicObj = bank.units.flatMap((u) => u.topics).find((t) => t.id === topicId);
      const topicTitle = topicObj ? topicObj.title : topicId;

      statusEl.classList.remove("hidden");
      statusEl.textContent = `Generating fresh APUSH questions for Topic ${topicId} (${topicTitle})...`;
      genBtn.disabled = true;

      try {
        const result = await callAiQuestionGenerator({ provider, apiKey, unitNum, topicId, topicTitle, style });
        if (result.stimulus) {
          customGeneratedData.stimuli[result.stimulus.id] = result.stimulus;
        }
        const newIds = [];
        if (Array.isArray(result.questions)) {
          result.questions.forEach((q) => {
            customGeneratedData.questions.push(q);
            newIds.push(q.id);
          });
        }
        saveCustomQuestions();
        statusEl.textContent = `Success! Added ${newIds.length} new questions to your bank. Launching quiz...`;
        setTimeout(() => {
          closeModal();
          genBtn.disabled = false;
          generateAndStartQuiz({
            label: `AI Generated: Topic ${topicId}`,
            strategy: "smart",
            topics: [topicId],
            specificQuestionIds: newIds,
            format: "all",
            count: newIds.length,
            feedbackMode: "tutor",
            timerEnabled: true,
            shuffleOptions: true
          });
        }, 700);
      } catch (err) {
        statusEl.textContent = `Error generating questions: ${err.message}`;
        genBtn.disabled = false;
      }
    });
  }

  async function callAiQuestionGenerator({ provider, apiKey, unitNum, topicId, topicTitle, style }) {
    const stamp = Date.now();
    const stimId = style === "stimulus" ? `stim_ai_${stamp}` : null;
    const prompt = `You are an AP US History College Board exam writer. Generate 3 authentic APUSH multiple-choice questions for Unit ${unitNum}, Topic ${topicId} (${topicTitle}).
Return ONLY valid JSON matching this structure:
{
  "stimulus": ${
    stimId
      ? `{ "id": "${stimId}", "unit": ${unitNum}, "type": "Primary Source", "title": "...", "content": "80-120 word historical excerpt", "attribution": "— Author, Title, Year" }`
      : `null`
  },
  "questions": [
    {
      "id": "q_ai_${stamp}_1",
      "unit": ${unitNum},
      "topic": "${topicId}",
      "topicTitle": "${topicTitle}",
      "skill": "Causation",
      "difficulty": "Medium",
      "stimulusId": ${stimId ? `"${stimId}"` : "null"},
      "stem": "Question stem...",
      "options": [
        { "id": "A", "text": "...", "isCorrect": true, "explanation": "Correct. ..." },
        { "id": "B", "text": "...", "isCorrect": false, "distractorType": "Out of Period", "explanation": "Incorrect. ..." },
        { "id": "C", "text": "...", "isCorrect": false, "distractorType": "Reversed Causation", "explanation": "Incorrect. ..." },
        { "id": "D", "text": "...", "isCorrect": false, "distractorType": "Wrong Theme", "explanation": "Incorrect. ..." }
      ],
      "keyTakeaway": "...",
      "testTip": "..."
    }
  ]
}`;

    if (provider === "gemini") {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" }
        })
      });
      if (!res.ok) throw new Error(`Gemini API returned ${res.status}`);
      const data = await res.json();
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      return JSON.parse(rawText);
    } else {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: prompt }]
        })
      });
      if (!res.ok) throw new Error(`OpenAI API returned ${res.status}`);
      const data = await res.json();
      const rawText = data.choices?.[0]?.message?.content || "{}";
      return JSON.parse(rawText);
    }
  }
})();
