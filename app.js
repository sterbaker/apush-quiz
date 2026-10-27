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
      totalStudySeconds: 0,
      lastActiveIso: null,
      questionHistory: {}, // qId -> { attempts, correct, lastCorrect, lastSeen }
      topicStats: {},      // topicId -> { attempts, correct }
      skillStats: {},      // skillName -> { attempts, correct }
      recentQuizzes: []    // [{ date, scorePct, correct, total, label, durationSeconds, sections, missedQuestions }]
    };
  }

  function saveStats() {
    userStats.lastActiveIso = new Date().toISOString();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(userStats));
    } catch (e) {
      console.warn("Could not save localStorage stats:", e);
    }
    pushStatsToCloudIfSignedIn();
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

  // Cloud / Firebase State (Pre-configured for project ushap-ae945)
  const FIREBASE_CFG_KEY = "apush_firebase_config_v1";
  const DEFAULT_FIREBASE_CONFIG = {
    apiKey: "AIzaSyDJvKDBKUKO45CazAutPpyr-yDek8deZlk",
    authDomain: "ushap-ae945.firebaseapp.com",
    projectId: "ushap-ae945",
    storageBucket: "ushap-ae945.firebasestorage.app",
    messagingSenderId: "126023447629",
    appId: "1:126023447629:web:ee0f38107607763daa1804"
  };
  let firebaseApp = null;
  let firebaseAuth = null;
  let firestoreDb = null;
  let currentGoogleUser = null;
  let cloudStudentsCache = {}; // uid -> { uid, displayName, email, photoURL, updatedAt, stats }
  let selectedParentStudentId = "local";

  // ==================== INITIALIZATION ====================
  document.addEventListener("DOMContentLoaded", () => {
    initTheme();
    initNavigation();
    renderUnitsFilterUI([3]); // Default to Unit 3 selected
    initBuilderControls();
    initQuizControls();
    initResultsControls();
    initAiModalControls();
    initCloudAndParentControls();
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
    } else if (viewName === "parent") {
      renderParentTrackerView();
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
    const durationSecs = activeQuiz.elapsedSeconds || 0;
    const uniqueSections = Array.from(new Set(activeQuiz.items.map((it) => it.question.topic)));
    const missedDetails = activeQuiz.items
      .filter((it) => !it.isCorrect)
      .map((it) => {
        const chosenOpt = it.selectedIndex !== null ? it.options[it.selectedIndex] : null;
        const correctOpt = it.options.find((o) => o.isCorrect);
        return {
          id: it.question.id,
          topic: it.question.topic,
          stem: it.question.stem,
          chosenText: chosenOpt ? chosenOpt.text : "(Unanswered)",
          correctText: correctOpt ? correctOpt.text : ""
        };
      });

    userStats.quizzesCompleted = (userStats.quizzesCompleted || 0) + 1;
    userStats.totalStudySeconds = (userStats.totalStudySeconds || 0) + durationSecs;
    userStats.recentQuizzes.unshift({
      date: new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
      isoDate: new Date().toISOString(),
      scorePct: pct,
      correct,
      total,
      durationSeconds: durationSecs,
      sections: uniqueSections,
      missedQuestions: missedDetails,
      label: activeQuiz.config.label || "Practice Quiz"
    });
    userStats.recentQuizzes = userStats.recentQuizzes.slice(0, 30);
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

  // ==================== GOOGLE SIGN-IN, CLOUD SYNC & PARENT PROGRESS PORTAL ====================
  function parseFirebaseConfigText(rawInput) {
    if (!rawInput || !rawInput.trim()) return null;
    let cleaned = rawInput.trim();
    // Extract {...} if user pasted `const firebaseConfig = { ... };`
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
    try {
      return JSON.parse(cleaned);
    } catch (e) {
      // Handle unquoted JS keys like `apiKey: "..."`
      const jsonNormalized = cleaned
        .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":')
        .replace(/,\s*}/g, "}");
      return JSON.parse(jsonNormalized);
    }
  }

  function buildShareableSetupLink(cfgObj) {
    try {
      const b64 = btoa(JSON.stringify(cfgObj));
      const url = new URL(window.location.href);
      url.searchParams.set("cloud", b64);
      return url.toString();
    } catch (e) {
      return "";
    }
  }

  function loadSavedFirebaseConfig() {
    // 1. Check URL query parameter `?cloud=` for 1-click setup on son's or parent's device
    try {
      const params = new URLSearchParams(window.location.search);
      const cloudParam = params.get("cloud");
      if (cloudParam) {
        const decoded = JSON.parse(atob(cloudParam));
        if (decoded && decoded.apiKey && decoded.projectId) {
          localStorage.setItem(FIREBASE_CFG_KEY, JSON.stringify(decoded));
          // Clean URL query param cleanly
          const cleanUrl = window.location.origin + window.location.pathname;
          window.history.replaceState({}, document.title, cleanUrl);
          return decoded;
        }
      }
    } catch (e) {
      console.warn("Could not parse ?cloud= setup link:", e);
    }

    // 2. Check window.APUSH_FIREBASE_CONFIG if hardcoded
    if (window.APUSH_FIREBASE_CONFIG && window.APUSH_FIREBASE_CONFIG.apiKey) {
      return window.APUSH_FIREBASE_CONFIG;
    }

    // 3. Check localStorage
    try {
      const saved = localStorage.getItem(FIREBASE_CFG_KEY);
      if (saved) return JSON.parse(saved);
    } catch (e) {}

    // 4. Built-in default project config (ushap-ae945)
    return DEFAULT_FIREBASE_CONFIG;
  }

  function initCloudAndParentControls() {
    const signInBtn = document.getElementById("googleSignInBtn");
    const signOutBtn = document.getElementById("googleSignOutBtn");
    const openSetupBtn = document.getElementById("openCloudSetupBtn");
    const parentSetupBtn = document.getElementById("parentSetupCloudBtn");
    const closeSetupBtn = document.getElementById("closeCloudModalBtn");
    const cancelSetupBtn = document.getElementById("cancelCloudModalBtn");
    const saveSetupBtn = document.getElementById("saveCloudConfigBtn");
    const copyLinkBtn = document.getElementById("copyShareLinkBtn");
    const backdrop = document.getElementById("cloudModalBackdrop");
    const studentSelect = document.getElementById("parentStudentSelect");
    const refreshBtn = document.getElementById("refreshParentDataBtn");

    const openCloudModal = () => {
      backdrop?.classList.remove("hidden");
      const existing = loadSavedFirebaseConfig();
      const inputEl = document.getElementById("firebaseConfigInput");
      const shareEl = document.getElementById("familyShareLinkInput");
      if (existing && inputEl) {
        inputEl.value = JSON.stringify(existing, null, 2);
        if (shareEl) shareEl.value = buildShareableSetupLink(existing);
      }
    };

    const closeCloudModal = () => backdrop?.classList.add("hidden");

    openSetupBtn?.addEventListener("click", openCloudModal);
    parentSetupBtn?.addEventListener("click", openCloudModal);
    closeSetupBtn?.addEventListener("click", closeCloudModal);
    cancelSetupBtn?.addEventListener("click", closeCloudModal);

    copyLinkBtn?.addEventListener("click", () => {
      const shareEl = document.getElementById("familyShareLinkInput");
      if (shareEl && shareEl.value) {
        navigator.clipboard?.writeText(shareEl.value);
        copyLinkBtn.textContent = "Copied!";
        setTimeout(() => {
          copyLinkBtn.textContent = "Copy Link";
        }, 1800);
      }
    });

    saveSetupBtn?.addEventListener("click", () => {
      const raw = document.getElementById("firebaseConfigInput")?.value || "";
      const statusMsg = document.getElementById("cloudModalStatusMsg");
      try {
        const cfg = parseFirebaseConfigText(raw);
        if (!cfg || !cfg.apiKey || !cfg.projectId) {
          throw new Error("Config must include at least apiKey, authDomain, and projectId.");
        }
        localStorage.setItem(FIREBASE_CFG_KEY, JSON.stringify(cfg));
        const shareEl = document.getElementById("familyShareLinkInput");
        if (shareEl) shareEl.value = buildShareableSetupLink(cfg);

        initializeFirebaseInstance(cfg);
        if (statusMsg) {
          statusMsg.classList.remove("hidden");
          statusMsg.textContent = "Firebase connected! Clicking 'Sign in with Google' now...";
        }
        setTimeout(() => {
          closeCloudModal();
          triggerGoogleSignInPopup();
        }, 600);
      } catch (err) {
        if (statusMsg) {
          statusMsg.classList.remove("hidden");
          statusMsg.textContent = `Invalid Firebase config: ${err.message}`;
        }
      }
    });

    signInBtn?.addEventListener("click", () => {
      if (!firebaseAuth) {
        openCloudModal();
      } else {
        triggerGoogleSignInPopup();
      }
    });

    signOutBtn?.addEventListener("click", async () => {
      if (firebaseAuth) {
        await firebaseAuth.signOut();
      }
      currentGoogleUser = null;
      updateAuthHeaderUI();
    });

    studentSelect?.addEventListener("change", () => {
      selectedParentStudentId = studentSelect.value;
      renderParentTrackerView();
    });

    refreshBtn?.addEventListener("click", () => {
      fetchAllStudentsFromFirestore();
    });

    // Auto-initialize if config already saved or passed via ?cloud= link
    const savedCfg = loadSavedFirebaseConfig();
    if (savedCfg) {
      initializeFirebaseInstance(savedCfg);
    }
  }

  function initializeFirebaseInstance(cfg) {
    if (!window.firebase) {
      console.warn("Firebase SDK not loaded.");
      return;
    }
    try {
      if (!firebase.apps.length) {
        firebaseApp = firebase.initializeApp(cfg);
      } else {
        firebaseApp = firebase.app();
      }
      firebaseAuth = firebase.auth();
      firestoreDb = firebase.firestore();

      // Listen for Google Auth state changes
      firebaseAuth.onAuthStateChanged(async (user) => {
        currentGoogleUser = user || null;
        updateAuthHeaderUI();

        if (user) {
          await syncUserStatsOnLogin(user);
          subscribeToCloudStudentsLive();
        }
      });

      // Also subscribe to student list for Parent View
      subscribeToCloudStudentsLive();
    } catch (err) {
      console.error("Firebase init error:", err);
    }
  }

  async function triggerGoogleSignInPopup() {
    if (!firebaseAuth) return;
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await firebaseAuth.signInWithPopup(provider);
    } catch (err) {
      alert(`Google Sign-In error: ${err.message}\n\nMake sure Google Sign-In is enabled in Firebase Authentication and '${window.location.hostname}' is added to Authorized Domains.`);
    }
  }

  function updateAuthHeaderUI() {
    const signInBtn = document.getElementById("googleSignInBtn");
    const profilePill = document.getElementById("userProfilePill");
    const avatarImg = document.getElementById("userAvatarImg");
    const nameText = document.getElementById("userNameText");

    if (currentGoogleUser) {
      signInBtn?.classList.add("hidden");
      profilePill?.classList.remove("hidden");
      if (avatarImg) {
        avatarImg.src =
          currentGoogleUser.photoURL ||
          `https://ui-avatars.com/api/?name=${encodeURIComponent(currentGoogleUser.displayName || "S")}&background=1d4ed8&color=fff`;
      }
      if (nameText) {
        nameText.textContent = currentGoogleUser.displayName || currentGoogleUser.email || "Signed In";
      }
    } else {
      signInBtn?.classList.remove("hidden");
      profilePill?.classList.add("hidden");
    }
  }

  async function syncUserStatsOnLogin(user) {
    if (!firestoreDb || !user) return;
    try {
      const docRef = firestoreDb.collection("apush_students").doc(user.uid);
      const snap = await docRef.get();

      if (snap.exists) {
        const cloudData = snap.data();
        const cloudStats = cloudData.stats;
        // Merge if cloud has more completed quizzes than local
        if (cloudStats && (cloudStats.quizzesCompleted || 0) > (userStats.quizzesCompleted || 0)) {
          userStats = Object.assign({}, userStats, cloudStats);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(userStats));
          renderUnitsFilterUI([3]);
          refreshDashboardAndMastery();
        }
      }
      await pushStatsToCloudIfSignedIn();
    } catch (err) {
      console.warn("Could not sync initial user stats with Firestore:", err);
    }
  }

  async function pushStatsToCloudIfSignedIn() {
    if (!firestoreDb || !currentGoogleUser) return;
    try {
      const syncDot = document.getElementById("syncStatusText");
      if (syncDot) syncDot.textContent = "\u21BB Syncing...";

      await firestoreDb
        .collection("apush_students")
        .doc(currentGoogleUser.uid)
        .set(
          {
            uid: currentGoogleUser.uid,
            displayName: currentGoogleUser.displayName || "Student",
            email: currentGoogleUser.email || "",
            photoURL: currentGoogleUser.photoURL || "",
            updatedAt: new Date().toISOString(),
            stats: userStats
          },
          { merge: true }
        );

      if (syncDot) syncDot.textContent = "\u25CF Cloud Synced";
    } catch (err) {
      console.warn("Error pushing stats to Firestore:", err);
    }
  }

  function subscribeToCloudStudentsLive() {
    if (!firestoreDb) return;
    try {
      firestoreDb.collection("apush_students").onSnapshot(
        (snapshot) => {
          snapshot.forEach((doc) => {
            cloudStudentsCache[doc.id] = doc.data();
          });
          populateParentStudentDropdown();
          const parentSec = document.getElementById("view-parent");
          if (parentSec && parentSec.classList.contains("active")) {
            renderParentTrackerView();
          }
        },
        (err) => {
          console.warn("Firestore listener warning:", err);
        }
      );
    } catch (e) {}
  }

  async function fetchAllStudentsFromFirestore() {
    if (!firestoreDb) {
      renderParentTrackerView();
      return;
    }
    try {
      const snap = await firestoreDb.collection("apush_students").get();
      snap.forEach((doc) => {
        cloudStudentsCache[doc.id] = doc.data();
      });
      populateParentStudentDropdown();
      renderParentTrackerView();
    } catch (e) {
      console.warn("Error fetching students:", e);
    }
  }

  function populateParentStudentDropdown() {
    const select = document.getElementById("parentStudentSelect");
    if (!select) return;

    const entries = Object.values(cloudStudentsCache).sort((a, b) =>
      (b.updatedAt || "").localeCompare(a.updatedAt || "")
    );

    let optionsHtml = `<option value="local">This Device (Local Browser Profile)</option>`;
    entries.forEach((st) => {
      const qCount = st.stats?.quizzesCompleted || 0;
      optionsHtml += `<option value="${st.uid}">${st.displayName} (${st.email}) — ${qCount} Quizzes</option>`;
    });

    select.innerHTML = optionsHtml;

    // Automatically select the most recently active cloud student if available
    if (selectedParentStudentId === "local" && entries.length > 0) {
      selectedParentStudentId = entries[0].uid;
    }
    select.value = selectedParentStudentId;
  }

  function renderParentTrackerView() {
    const bank = getFullBank();
    const u3 = bank.units.find((u) => u.id === 3);
    const u3Topics = u3 ? u3.topics : [];

    // Determine which stats object we are inspecting (Cloud Student vs Local Device)
    let activeProfileName = "This Device (Local Browser)";
    let targetStats = userStats;
    let isCloudProfile = false;
    let lastUpdatedIso = userStats.lastActiveIso;

    if (selectedParentStudentId !== "local" && cloudStudentsCache[selectedParentStudentId]) {
      const cloudDoc = cloudStudentsCache[selectedParentStudentId];
      targetStats = cloudDoc.stats || userStats;
      activeProfileName = `${cloudDoc.displayName} (${cloudDoc.email})`;
      lastUpdatedIso = cloudDoc.updatedAt || targetStats.lastActiveIso;
      isCloudProfile = true;
    }

    // Update Sync Banner
    const syncBadge = document.getElementById("parentSyncBadge");
    const syncDesc = document.getElementById("parentSyncDesc");
    const lastActiveTag = document.getElementById("parentLastActiveTag");

    if (syncBadge && syncDesc) {
      if (isCloudProfile) {
        syncBadge.textContent = "Live Cloud Sync";
        syncBadge.classList.add("live");
        syncDesc.innerHTML = `Streaming live progress for <strong>${activeProfileName}</strong> via Google Cloud Firestore.`;
      } else if (firestoreDb) {
        syncBadge.textContent = "Cloud Ready";
        syncBadge.classList.add("live");
        syncDesc.textContent = "Cloud sync is connected! Have your son click 'Sign in with Google' on his device so his profile appears in the dropdown above.";
      } else {
        syncBadge.textContent = "Local Device Mode";
        syncBadge.classList.remove("live");
        syncDesc.textContent = "Viewing progress stored on this browser. Click 'Connect Cloud Sync' above to link Google Sign-In across your son's device and yours.";
      }
    }

    if (lastActiveTag) {
      if (lastUpdatedIso) {
        const dt = new Date(lastUpdatedIso);
        lastActiveTag.textContent = `Last active: ${dt.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
      } else {
        lastActiveTag.textContent = "Last active: No activity yet";
      }
    }

    // Compute Parent Summary KPIs
    let totalAnswered = 0;
    Object.values(targetStats.topicStats || {}).forEach((st) => {
      totalAnswered += st.attempts || 0;
    });
    const quizzesDone = targetStats.quizzesCompleted || 0;
    const studyMins = Math.max(1, Math.round((targetStats.totalStudySeconds || 0) / 60));

    document.getElementById("parentQuizzesBadge").textContent = `${quizzesDone} Quizzes Completed`;
    document.getElementById("parentTotalQsVal").textContent = `${totalAnswered} Qs`;
    document.getElementById("parentStudyTimeSub").textContent =
      (targetStats.totalStudySeconds || 0) > 0 ? `${studyMins} min total timed practice` : "0 min timed practice";

    const latestQuiz = (targetStats.recentQuizzes || [])[0];
    document.getElementById("parentLastQuizDateSub").textContent = latestQuiz
      ? `Latest: ${latestQuiz.label} (${latestQuiz.scorePct}% on ${latestQuiz.date})`
      : "No quizzes completed yet";

    // Unit 3 Readiness
    let u3Att = 0;
    let u3Corr = 0;
    let u3PracticedCount = 0;
    const weakSections = [];

    u3Topics.forEach((t) => {
      const st = (targetStats.topicStats || {})[t.id];
      if (st && st.attempts > 0) {
        u3Att += st.attempts;
        u3Corr += st.correct;
        u3PracticedCount++;
        const acc = Math.round((st.correct / st.attempts) * 100);
        if (acc < 75) {
          weakSections.push(`${t.id} ${t.title} (${acc}%)`);
        }
      }
    });

    const u3Acc = u3Att > 0 ? Math.round((u3Corr / u3Att) * 100) : null;
    document.getElementById("parentU3AccVal").textContent = u3Acc !== null ? `${u3Acc}%` : "--%";
    document.getElementById("parentU3SectionsSub").textContent = `${u3PracticedCount} of ${u3Topics.length} Unit 3 sections practiced`;
    document.getElementById("parentU3ProgressFill").style.width = `${u3Acc || 0}%`;
    document.getElementById("parentU3ProjectedPill").textContent =
      u3Acc !== null ? `Projected AP Score: ${getProjectedApScoreInfo(u3Acc).score}` : "Needs Diagnostic";

    // Weak Sections Card
    document.getElementById("parentWeakCountPill").textContent = `${weakSections.length} Below 75%`;
    document.getElementById("parentWeakListText").textContent =
      weakSections.length > 0
        ? weakSections.join(" • ")
        : u3PracticedCount > 0
        ? "All practiced Unit 3 sections are at 75% accuracy or higher!"
        : "No sections flagged yet — have him take a Unit 3 quiz to identify weak areas.";

    // Populate Unit 3 Section-by-Section Table
    const tbody = document.getElementById("parentSectionTableBody");
    if (tbody) {
      tbody.innerHTML = u3Topics
        .map((t) => {
          const st = (targetStats.topicStats || {})[t.id] || { attempts: 0, correct: 0 };
          const pct = st.attempts > 0 ? Math.round((st.correct / st.attempts) * 100) : null;
          let statusCls = "acc-none";
          let statusText = "Not Started";
          if (pct !== null) {
            if (pct >= 80) {
              statusCls = "acc-high";
              statusText = "Mastered (80%+)";
            } else if (pct >= 65) {
              statusCls = "acc-med";
              statusText = "Developing";
            } else {
              statusCls = "acc-low";
              statusText = "Needs Drill (<65%)";
            }
          }
          return `
            <tr>
              <td><strong>${t.id}</strong></td>
              <td>${t.title}</td>
              <td>${st.correct} / ${st.attempts}</td>
              <td><strong>${pct !== null ? `${pct}%` : "--"}</strong></td>
              <td><span class="topic-acc-mini ${statusCls}">${statusText}</span></td>
            </tr>
          `;
        })
        .join("");
    }

    // Populate Detailed Quiz Log & Missed Question Inspector
    const logContainer = document.getElementById("parentQuizLogContainer");
    if (logContainer) {
      const logs = targetStats.recentQuizzes || [];
      if (logs.length === 0) {
        logContainer.innerHTML = `<p style="color: var(--text-muted); font-size: 0.85rem;">No quiz attempts recorded yet.</p>`;
      } else {
        logContainer.innerHTML = logs
          .map((rq, idx) => {
            const cls = rq.scorePct >= 75 ? "acc-high" : rq.scorePct >= 60 ? "acc-med" : "acc-low";
            const durText = rq.durationSeconds
              ? `${Math.floor(rq.durationSeconds / 60)}m ${rq.durationSeconds % 60}s`
              : "Untimed";
            const secList = rq.sections && rq.sections.length > 0 ? `Sections: ${rq.sections.join(", ")}` : "";
            const missedArr = rq.missedQuestions || [];

            const missedHtml =
              missedArr.length > 0
                ? `<div class="parent-missed-drawer">
                    <strong style="font-size:0.76rem; color:var(--danger-text);">Missed Questions (${missedArr.length}):</strong>
                    ${missedArr
                      .map(
                        (mq) => `
                        <div class="parent-missed-q">
                          <div><strong>[${mq.topic}]</strong> ${mq.stem}</div>
                          <div style="color:var(--danger-text); margin-top:0.15rem;">Chose: ${mq.chosenText}</div>
                          <div style="color:var(--success-text);">Correct: ${mq.correctText}</div>
                        </div>
                      `
                      )
                      .join("")}
                  </div>`
                : `<div style="margin-top:0.4rem; font-size:0.76rem; color:var(--success-text);">&#10003; Perfect score or no missed question details recorded.</div>`;

            return `
              <div class="parent-log-card">
                <div class="parent-log-top">
                  <strong>#${logs.length - idx}: ${rq.label}</strong>
                  <span class="history-score ${cls}">${rq.scorePct}% (${rq.correct}/${rq.total})</span>
                </div>
                <div class="parent-log-meta">
                  <span>&#128197; ${rq.date}</span>
                  <span>&#9201; Duration: ${durText}</span>
                  ${secList ? `<span>&#128218; ${secList}</span>` : ""}
                </div>
                ${missedHtml}
              </div>
            `;
          })
          .join("");
      }
    }
  }
})();
