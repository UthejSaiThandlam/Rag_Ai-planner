/* ============================================================
   EasyLearn AI — Unified RAG + Planner UI Logic
   ============================================================ */

// ==================== APPLICATION STATE ====================
let state = {
    goals: [],
    activeGoalId: null,
    schedule: [],
    chatHistory: [],
    terminalLogs: [],
    timer: { taskId: null, taskName: '', duration: 0, running: false },
    streak: 0
};

let timerInterval = null;
let currentTab = 'dashboard';
let debugContextVisible = false;
let expandedSubtopicIndex = null;

const CATEGORIES = {
    rest:     { label: 'Rest/Sleep',   color: '#EC4899' },
    work:     { label: 'Work',         color: '#3B82F6' },
    meals:    { label: 'Meals',        color: '#FBBF24' },
    travel:   { label: 'Travel',       color: '#6366F1' },
    learning: { label: 'Learning',     color: '#06B6D4' },
    skill:    { label: 'Skills',       color: '#10B981' },
    personal: { label: 'Personal',     color: '#FF5E00' }
};

// ==================== INITIALIZATION ====================
function initApp() {
    loadState();
    initTimelineGrid();
    setupCurrentTimeIndicator();

    // Set today's date
    const dateEl = document.getElementById("current-planner-date");
    if (dateEl) {
        dateEl.textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    }

    // Render all components
    loadKnowledgeBase();
    updateMetrics();
    renderCoursesSlider();
    renderTimeline();
    renderRoadmapTree();
    renderActiveRoadmapsList();
    renderTerminalLogs();

    logTerminal("EasyLearn AI System initialized.", "system");

    // Resume timer if it was running
    if (state.timer.running) {
        state.timer.running = false;
        toggleTimer();
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp);
} else {
    initApp();
}

// ==================== PERSISTENCE ====================
function saveState() {
    localStorage.setItem("easylearn_rag_state", JSON.stringify(state));
    updateMetrics();
}

function loadState() {
    const data = localStorage.getItem("easylearn_rag_state");
    if (data) {
        try {
            state = { ...state, ...JSON.parse(data) };
        } catch (e) {
            console.error("Error loading state:", e);
        }
    }
}

// ==================== NAVIGATION ====================
function switchTab(tabId) {
    currentTab = tabId;
    
    // Update nav tabs
    document.querySelectorAll('.nav-tab').forEach(btn => {
        btn.classList.remove('active');
    });
    const activeNav = document.getElementById(`nav-${tabId}`);
    if (activeNav) activeNav.classList.add('active');

    // Update sidebar links
    document.querySelectorAll('.sidebar-link').forEach(link => {
        link.classList.remove('active');
    });

    // Toggle views
    const views = ['dashboard', 'knowledge', 'chat', 'search', 'roadmap', 'planner'];
    views.forEach(v => {
        const el = document.getElementById(`view-${v}`);
        if (el) el.style.display = (v === tabId) ? 'block' : 'none';
    });

    if (tabId === 'knowledge') loadKnowledgeBase();
    if (tabId === 'planner') {
        renderTimeline();
        updateTimerDisplay();
    }
    if (tabId === 'roadmap') {
        renderRoadmapTree();
        renderActiveRoadmapsList();
    }

    logTerminal(`Panel switch → [${tabId.toUpperCase()}]`, "system");
}

// ==================== TOASTS & TERMINAL ====================
function showToast(message, type = "info") {
    const container = document.getElementById("toast-container");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    const icons = { success: "🟢", error: "🔴", warning: "⚠️", info: "⚡" };
    toast.innerHTML = `<span>${icons[type] || "⚡"}</span> <span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 250);
    }, 3500);
}

function logTerminal(message, type = "normal") {
    const timestamp = new Date().toLocaleTimeString();
    state.terminalLogs.push({ text: `[${timestamp}] ${message}`, type });
    if (state.terminalLogs.length > 60) state.terminalLogs.shift();
    renderTerminalLogs();
}

function renderTerminalLogs() {
    const body = document.getElementById("terminal-body");
    if (!body) return;
    body.innerHTML = state.terminalLogs.map(log => {
        let cls = "term-line";
        if (log.type === "system") cls += " system-msg";
        if (log.type === "error") cls += " error-msg";
        if (log.type === "success") cls += " success-msg";
        return `<div class="${cls}">${log.text}</div>`;
    }).join("");
    body.scrollTop = body.scrollHeight;
}

function clearTerminalLogs() {
    state.terminalLogs = [];
    logTerminal("Logs cleared.", "system");
}

// ==================== METRICS ====================
function updateMetrics() {
    let completedSubs = 0, totalSubs = 0;
    state.goals.forEach(g => {
        if (g.roadmap && g.roadmap.children) {
            g.roadmap.children.forEach(c => {
                totalSubs++;
                if (c.status === "completed") completedSubs++;
            });
        }
    });

    const pct = totalSubs > 0 ? Math.round((completedSubs / totalSubs) * 100) : 0;

    const sidebarPct = document.getElementById("sidebar-completion-pct");
    if (sidebarPct) sidebarPct.textContent = `${pct}%`;

    const goalsCount = document.getElementById("sidebar-goals-count");
    if (goalsCount) goalsCount.textContent = state.goals.length;

    const streakEl = document.getElementById("sidebar-streak-val");
    if (streakEl) streakEl.textContent = `${state.streak || 0} Days`;

    // Dashboard active goal card
    const activeGoal = state.goals.find(g => g.id === state.activeGoalId);
    const dashGoal = document.getElementById("dashboard-active-goal");
    const dashProgress = document.getElementById("dashboard-active-progress");
    const dashBar = document.getElementById("dashboard-progress-bar");

    if (dashGoal && activeGoal) {
        dashGoal.textContent = `🎯 ${activeGoal.topic}`;
        const goalTotal = activeGoal.roadmap?.children?.length || 0;
        const goalDone = activeGoal.roadmap?.children?.filter(c => c.status === 'completed').length || 0;
        const goalPct = goalTotal > 0 ? Math.round((goalDone / goalTotal) * 100) : 0;
        if (dashProgress) dashProgress.textContent = `${goalDone}/${goalTotal} subtopics (${goalPct}%)`;
        if (dashBar) dashBar.style.width = `${goalPct}%`;
    } else if (dashGoal) {
        dashGoal.textContent = "No Active Goal";
        if (dashProgress) dashProgress.textContent = "Create a roadmap to track progress";
        if (dashBar) dashBar.style.width = "0%";
    }
}

// ==================== KNOWLEDGE BASE (RAG) ====================
async function loadKnowledgeBase() {
    try {
        const res = await fetch('/api/knowledge-base');
        const data = await res.json();
        const container = document.getElementById('kb-cards-container');
        if (!container) return;

        if (!data.documents || data.documents.length === 0) {
            container.innerHTML = `<div class="kb-card" style="grid-column: 1/-1; text-align: center; color: var(--text-dim);">
                <p>📁 No documents indexed yet. Upload a PDF/TXT document to activate Vector RAG!</p>
            </div>`;
            return;
        }

        container.innerHTML = data.documents.map(doc => `
            <div class="kb-card card-glow-cyan">
                <div class="kb-header">
                    <span class="kb-icon">📘</span>
                    <div>
                        <div class="kb-title">${doc.doc_name}</div>
                        <div class="kb-meta">${doc.chunk_count} chunks • ${doc.status}</div>
                    </div>
                </div>
            </div>
        `).join('');
    } catch (e) {
        console.error('Failed to load KB:', e);
    }
}

async function uploadDocument() {
    const fileInput = document.getElementById('file-upload-input');
    if (!fileInput || !fileInput.files[0]) return showToast('Select a file first!', 'error');

    const file = fileInput.files[0];
    logTerminal(`Uploading: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`, "info");

    const reader = new FileReader();
    reader.onload = async (e) => {
        const base64Data = e.target.result.split(',')[1];
        try {
            const res = await fetch('/api/upload-document', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: file.name, base64: base64Data })
            });
            const data = await res.json();
            if (data.success) {
                showToast(`Indexed ${file.name} → ${data.chunks_indexed} chunks!`, 'success');
                logTerminal(`Indexed: ${file.name} (${data.chunks_indexed} chunks)`, 'success');
                loadKnowledgeBase();
            } else {
                showToast('Upload error: ' + (data.error || 'Failed'), 'error');
                logTerminal('Upload failed: ' + (data.error || 'Unknown'), 'error');
            }
        } catch (err) {
            showToast('Upload error: ' + err.message, 'error');
            logTerminal('Upload network error: ' + err.message, 'error');
        }
    };
    reader.readAsDataURL(file);
}

// ==================== RAG CHAT ====================
async function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';

    const container = document.getElementById('chat-messages');
    container.innerHTML += `<div class="chat-bubble user">${escapeHtml(msg)}</div>`;
    container.scrollTop = container.scrollHeight;

    try {
        const res = await fetch('/api/rag/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg, history: state.chatHistory, mode: 'study' })
        });

        const data = await res.json();

        let providerBadge = `<span style="font-size:0.72rem; padding: 2px 6px; border-radius: 4px; background: ${data.provider === 'gemini' ? 'rgba(139,92,246,0.2)' : 'rgba(6,182,212,0.2)'}; color: ${data.provider === 'gemini' ? '#8b5cf6' : '#06b6d4'}; font-family: var(--font-mono); margin-bottom: 6px; display: inline-block;">🤖 ${(data.provider || 'AI').toUpperCase()}</span><br>`;

        let citationsHtml = '';
        if (data.citations && data.citations.length > 0) {
            citationsHtml = `<div class="citation-box"><strong>Sources:</strong><br>${
                data.citations.map(c => `• <strong>${c.doc_name}</strong> (Page ${c.page_num}) — ${(c.similarity * 100).toFixed(1)}%`).join('<br>')
            }</div>`;
        }

        let debugHtml = '';
        if (data.retrieved_context && data.retrieved_context.length > 0) {
            debugHtml = `
                <div class="debug-panel" style="display: ${debugContextVisible ? 'block' : 'none'}; margin-top: 10px;">
                    <strong>🔍 Retrieved Chunks (${data.retrieved_context.length}):</strong>
                    ${data.retrieved_context.map((rc, idx) => `
                        <div style="margin-top: 8px; padding: 8px; background: rgba(255,255,255,0.03); border-radius: 6px; border-left: 2px solid var(--accent-cyan);">
                            <div style="display: flex; justify-content: space-between; font-size: 0.78rem;">
                                <code>[#${idx + 1}] ${rc.chunk.doc_name} (Page ${rc.chunk.page_num})</code>
                                <span style="color: var(--accent-cyan);">Score: ${(rc.final_score * 100).toFixed(1)}%</span>
                            </div>
                            <div style="margin-top: 4px; color: var(--text-main); white-space: pre-wrap; font-family: var(--font-mono); font-size: 0.78rem; background: rgba(0,0,0,0.25); padding: 6px; border-radius: 4px;">${escapeHtml(rc.chunk.content)}</div>
                        </div>
                    `).join('')}
                </div>`;
        }

        container.innerHTML += `
            <div class="chat-bubble ai">
                ${providerBadge}
                ${formatMarkdown(data.message)}
                ${citationsHtml}
                ${debugHtml}
            </div>`;
        container.scrollTop = container.scrollHeight;

        state.chatHistory.push({ role: 'user', text: msg });
        state.chatHistory.push({ role: 'assistant', text: data.message });
        if (state.chatHistory.length > 40) state.chatHistory = state.chatHistory.slice(-40);
        saveState();

    } catch (err) {
        container.innerHTML += `<div class="chat-bubble ai" style="border-color: var(--accent-pink);">Error: ${err.message}</div>`;
    }
}

// ==================== SEMANTIC SEARCH ====================
async function performSemanticSearch() {
    const query = document.getElementById('search-query-input').value.trim();
    const mode = document.getElementById('search-mode-select').value;
    if (!query) return;

    try {
        const res = await fetch('/api/rag/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, mode, top_k: 5 })
        });
        const data = await res.json();
        const resultsContainer = document.getElementById('search-results-container');

        if (!data.results || data.results.length === 0) {
            resultsContainer.innerHTML = '<p class="empty-state">No vector matches found.</p>';
            return;
        }

        resultsContainer.innerHTML = data.results.map(r => `
            <div class="kb-card" style="margin-bottom: 1rem;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <strong style="color: var(--accent-cyan);">${r.chunk.doc_name}</strong>
                    <span style="font-family: var(--font-mono); font-size: 0.78rem; background: rgba(6,182,212,0.12); padding: 2px 8px; border-radius: 4px;">
                        Score: ${(r.final_score * 100).toFixed(1)}%
                    </span>
                </div>
                <p style="margin-top: 0.5rem; color: var(--text-main); font-size: 0.88rem;">${escapeHtml(r.chunk.content)}</p>
                <div style="margin-top: 0.4rem; font-size: 0.78rem; color: var(--text-dim);">Page ${r.chunk.page_num} • Chunk ID: ${r.chunk.chunk_id}</div>
            </div>
        `).join('');
    } catch (e) {
        showToast('Search error: ' + e.message, 'error');
    }
}

function toggleDebugContext() {
    debugContextVisible = !debugContextVisible;
    document.querySelectorAll('.debug-panel').forEach(el => {
        el.style.display = debugContextVisible ? 'block' : 'none';
    });
    showToast(debugContextVisible ? 'Debug view enabled' : 'Debug view hidden', 'info');
}

// ==================== COURSES SLIDER (DASHBOARD) ====================
function renderCoursesSlider() {
    const slider = document.getElementById("courses-slider");
    if (!slider) return;

    if (state.goals.length === 0) {
        slider.innerHTML = `<div class="empty-state" style="width:100%;">No active goals. Create one in the Roadmap tab.</div>`;
        return;
    }

    slider.innerHTML = state.goals.map(goal => {
        let total = 0, done = 0;
        if (goal.roadmap && goal.roadmap.children) {
            goal.roadmap.children.forEach(c => { total++; if (c.status === "completed") done++; });
        }
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const isActive = goal.id === state.activeGoalId;

        return `
            <div class="course-card" onclick="selectActiveGoal('${goal.id}')" style="${isActive ? 'border-color: var(--accent-cyan);' : ''}">
                <div class="cc-name">${goal.topic}</div>
                <div class="cc-meta-row">
                    <span class="badge-level">${goal.level}</span>
                    <span>${total} objectives</span>
                </div>
                <div class="cc-progress-val">${pct}% complete</div>
                <div class="cc-progress-bar-wrap">
                    <div class="cc-progress-bar" style="width: ${pct}%;"></div>
                </div>
            </div>
        `;
    }).join("");
}

function selectActiveGoal(goalId) {
    state.activeGoalId = goalId;
    saveState();
    const goal = state.goals.find(g => g.id === goalId);
    showToast(`Active: ${goal ? goal.topic : 'Unknown'}`, "success");
    logTerminal(`Active goal → ${goal ? goal.topic : 'Unknown'}`, "system");
    renderCoursesSlider();
    renderRoadmapTree();
    renderActiveRoadmapsList();
}

// ==================== ROADMAP GENERATION ====================
async function handleCreateGoal(event) {
    event.preventDefault();
    const topic = document.getElementById("goal-query").value.trim();
    const level = document.getElementById("goal-level").value;
    const dailyHours = parseFloat(document.getElementById("goal-hours").value);
    const deadline = document.getElementById("goal-deadline").value;

    if (!topic || !deadline) return showToast("Fill in topic and deadline.", "error");

    const submitBtn = document.querySelector('#goal-creator-form button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    logTerminal(`Generating AI roadmap for: ${topic}...`, "system");
    showToast("Constructing roadmap... 5-20s", "warning");

    try {
        const res = await fetch("/api/generate-plan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ topic, depth: level, daily_hours: dailyHours })
        });

        const data = await res.json();
        if (data.error) {
            showToast(`Error: ${data.error}`, 'error');
            logTerminal('Plan error: ' + data.error, 'error');
            return;
        }

        const newGoal = {
            id: 'g_' + Date.now(),
            topic, level, deadline, dailyHours,
            roadmap: data.roadmap || { name: topic, children: [] },
            modules: data.modules || [],
            summary: data.summary || null,
            isFallback: data.is_fallback || false
        };

        state.goals.push(newGoal);
        state.activeGoalId = newGoal.id;
        saveState();

        const src = data.is_fallback ? 'Fallback curriculum' : 'AI Generated';
        const days = data.summary ? data.summary.estimated_days : 'N/A';
        showToast(`Roadmap ready: ${newGoal.modules.length} modules, ~${days} days`, 'success');
        logTerminal(`[AI] Created roadmap for "${topic}" via ${src}. ${newGoal.modules.length} modules.`, 'success');

        if (data.is_fallback && data.message) {
            logTerminal(`[AI] ${data.message}`, 'warning');
        }

        document.getElementById('goal-creator-form').reset();
        renderCoursesSlider();
        renderActiveRoadmapsList();
        renderRoadmapTree();
        triggerAutoSchedule();

    } catch (e) {
        showToast('Network error. Is server running?', 'error');
        logTerminal('Goal error: ' + e.message, 'error');
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
}

function renderActiveRoadmapsList() {
    const container = document.getElementById("active-roadmaps-list");
    if (!container) return;

    if (state.goals.length === 0) {
        container.innerHTML = `<div class="empty-state">No learning tracks created yet.</div>`;
        return;
    }

    container.innerHTML = state.goals.map(g => {
        const isActive = g.id === state.activeGoalId;
        return `
            <div class="task-item" style="border-left-color: ${isActive ? 'var(--accent-cyan)' : 'transparent'}">
                <div class="task-dot" style="background-color: ${isActive ? 'var(--accent-cyan)' : 'var(--text-dim)'}"></div>
                <div class="task-info" onclick="selectActiveGoal('${g.id}')">
                    <div class="task-item-name">${g.topic}</div>
                    <div class="task-item-meta">${g.level} • ${g.dailyHours}h/d</div>
                </div>
                <button class="task-delete" onclick="deleteGoal('${g.id}')">🗑️</button>
            </div>
        `;
    }).join("");
}

function deleteGoal(goalId) {
    state.goals = state.goals.filter(g => g.id !== goalId);
    if (state.activeGoalId === goalId) {
        state.activeGoalId = state.goals.length > 0 ? state.goals[0].id : null;
    }
    saveState();
    showToast("Goal deleted.", "info");
    logTerminal("Deleted learning goal.", "system");
    renderCoursesSlider();
    renderActiveRoadmapsList();
    renderRoadmapTree();
}

// ==================== ROADMAP TREE ====================
function renderRoadmapTree() {
    const container = document.getElementById("tree-container");
    const badge = document.getElementById("active-roadmap-title-badge");
    if (!container) return;

    const activeGoal = state.goals.find(g => g.id === state.activeGoalId);
    if (!activeGoal) {
        if (badge) badge.textContent = "NO ACTIVE GOAL";
        container.innerHTML = `<div class="empty-state">Create a goal to display the roadmap tree.</div>`;
        return;
    }

    if (badge) badge.textContent = activeGoal.topic.toUpperCase();

    let html = `<div class="tree-root-label">🔹 ROADMAP // ${activeGoal.topic.toUpperCase()}</div>`;
    if (activeGoal.roadmap.description) {
        html += `<div class="tree-root-desc">${activeGoal.roadmap.description}</div>`;
    }
    if (activeGoal.summary) {
        const s = activeGoal.summary;
        html += `<div class="tree-summary-bar">
            <span>📅 ~${s.estimated_days} days</span>
            <span>⏱ ${s.total_hours}h total</span>
            <span>📆 ${s.daily_hours}h/day</span>
        </div>`;
    }

    if (activeGoal.roadmap && activeGoal.roadmap.children) {
        activeGoal.roadmap.children.forEach((node, idx) => {
            const isCompleted = node.status === 'completed';
            const isInProgress = node.status === 'in_progress';
            const checkedAttr = isCompleted ? 'checked' : '';

            let statusBadge = '';
            if (isCompleted) statusBadge = '<span style="color:#10B981; font-family:var(--font-mono); font-size:0.72rem; margin-left:8px;">[DONE]</span>';
            else if (isInProgress) statusBadge = '<span style="color:var(--accent-cyan); font-family:var(--font-mono); font-size:0.72rem; margin-left:8px;">[ACTIVE]</span>';

            const desc = node.description ? `<div class="tree-node-desc">${node.description}</div>` : '';
            const isExpanded = (expandedSubtopicIndex === idx);
            const expandClass = isExpanded ? 'expanded' : '';

            let tasksHtml = '';
            if (isExpanded) {
                const relatedTasks = (activeGoal.modules || [])
                    .map((m, mIdx) => ({ ...m, originalIndex: mIdx }))
                    .filter(m => m.subtopic_index === idx);

                if (relatedTasks.length === 0) {
                    tasksHtml = `<div class="tree-node-tasks-wrapper"><div class="empty-state">No tasks for this section.</div></div>`;
                } else {
                    tasksHtml = `
                        <div class="tree-node-tasks-wrapper">
                            <div class="tree-tasks-title">📋 Study Sessions (${relatedTasks.length}):</div>
                            ${relatedTasks.map(t => {
                                const isScheduled = state.schedule.some(b => b.goalId === activeGoal.id && b.name === t.name);
                                const isTaskDone = t.completed;
                                const pri = (t.priority || 'medium').toUpperCase();

                                return `
                                    <div class="tree-task-card ${isTaskDone ? 'completed' : ''} ${isScheduled ? 'scheduled' : ''}">
                                        <div class="tree-task-header">
                                            <span class="tree-task-name">${t.name}</span>
                                            <span class="tree-task-duration">${t.duration} min</span>
                                        </div>
                                        <div class="tree-task-meta">
                                            <span class="tree-task-priority pri-${t.priority || 'medium'}">${pri}</span>
                                            <span class="tree-task-status">${isTaskDone ? '✅ Done' : (isScheduled ? '📅 Scheduled' : '⏳ Ready')}</span>
                                        </div>
                                        <div class="tree-task-actions">
                                            <button class="btn-task-action focus" onclick="event.stopPropagation(); focusRoadmapTask('${activeGoal.id}', ${t.originalIndex})">▶ Focus</button>
                                            <button class="btn-task-action schedule" onclick="event.stopPropagation(); scheduleRoadmapTask('${activeGoal.id}', ${t.originalIndex})" ${isScheduled ? 'disabled' : ''}>⚡ Schedule</button>
                                            <button class="btn-task-action complete" onclick="event.stopPropagation(); toggleRoadmapTaskComplete('${activeGoal.id}', ${t.originalIndex})">${isTaskDone ? '↺ Undo' : '✓ Done'}</button>
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    `;
                }
            }

            html += `
                <div class="tree-node">
                    <div class="tree-node-content ${isCompleted ? 'completed' : ''} ${expandClass}" onclick="handleNodeHeaderClick(event, ${idx})">
                        <input type="checkbox" class="tree-node-checkbox" ${checkedAttr} onclick="event.stopPropagation(); toggleTreeNode('${activeGoal.id}', ${idx})">
                        <div class="tree-node-text">
                            <span class="tree-node-name">${node.name} ${statusBadge}</span>
                            <span class="tree-node-hours">${node.estimated_hours}h</span>
                        </div>
                    </div>
                    ${desc}
                    ${tasksHtml}
                </div>
            `;
        });
    }
    container.innerHTML = html;
}

function handleNodeHeaderClick(event, idx) {
    if (event.target.type === 'checkbox' || event.target.closest('.tree-task-card') || event.target.closest('a')) return;
    expandedSubtopicIndex = (expandedSubtopicIndex === idx) ? null : idx;
    renderRoadmapTree();
}

function toggleTreeNode(goalId, index) {
    const goal = state.goals.find(g => g.id === goalId);
    if (goal && goal.roadmap && goal.roadmap.children[index]) {
        const node = goal.roadmap.children[index];
        node.status = node.status === "completed" ? "upcoming" : "completed";
        const nextCompleted = (node.status === "completed");

        if (goal.modules) {
            goal.modules.forEach(m => {
                if (m.subtopic_index === index) {
                    m.completed = nextCompleted;
                    state.schedule.forEach(b => {
                        if (b.goalId === goalId && b.name === m.name) {
                            b.completed = nextCompleted;
                        }
                    });
                }
            });
        }

        saveState();
        logTerminal(`"${node.name}" → [${node.status.toUpperCase()}]`, "system");
        renderRoadmapTree();
        renderCoursesSlider();
        renderTimeline();
    }
}

function scheduleRoadmapTask(goalId, moduleIndex) {
    const goal = state.goals.find(g => g.id === goalId);
    if (!goal || !goal.modules || !goal.modules[moduleIndex]) return;
    const mod = goal.modules[moduleIndex];

    const slot = findNextFreeSlot(mod.duration || 45);
    if (!slot) return showToast("No free slots on timeline.", "error");

    state.schedule.push({
        id: `b_roadmap_${Date.now()}_${moduleIndex}`,
        name: mod.name,
        type: 'study',
        start: slot.start,
        end: slot.end,
        category: mod.category || 'learning',
        completed: !!mod.completed,
        goalId: goal.id
    });

    saveState();
    renderTimeline();
    renderRoadmapTree();
    logTerminal(`Scheduled: "${mod.name}" at ${formatMinutesToTime(slot.start)}`, "success");
    showToast(`Scheduled: ${formatMinutesToTime(slot.start)}`, "success");
}

function focusRoadmapTask(goalId, moduleIndex) {
    const goal = state.goals.find(g => g.id === goalId);
    if (!goal || !goal.modules || !goal.modules[moduleIndex]) return;
    const mod = goal.modules[moduleIndex];

    state.timer.taskId = `b_focus_${Date.now()}`;
    state.timer.taskName = mod.name;
    state.timer.duration = (mod.duration || 45) * 60;
    state.timer.running = false;
    saveState();

    switchTab("planner");
    const toggleBtn = document.getElementById("active-timer-toggle-btn");
    const completeBtn = document.getElementById("active-timer-complete-btn");
    if (toggleBtn) toggleBtn.removeAttribute("disabled");
    if (completeBtn) completeBtn.removeAttribute("disabled");

    toggleTimer();
    showToast(`Focus: ${mod.name}`, "success");
}

function toggleRoadmapTaskComplete(goalId, moduleIndex) {
    const goal = state.goals.find(g => g.id === goalId);
    if (!goal || !goal.modules || !goal.modules[moduleIndex]) return;
    const mod = goal.modules[moduleIndex];
    mod.completed = !mod.completed;

    state.schedule.forEach(b => {
        if (b.goalId === goalId && b.name === mod.name) b.completed = mod.completed;
    });

    checkSubtopicCompletion(goal, mod.subtopic_index);
    saveState();
    renderTimeline();
    renderRoadmapTree();
    renderCoursesSlider();
    logTerminal(`Task "${mod.name}" → ${mod.completed ? 'DONE' : 'PENDING'}`, "system");
}

function checkSubtopicCompletion(goal, subtopicIndex) {
    if (!goal.roadmap || !goal.roadmap.children || !goal.roadmap.children[subtopicIndex]) return;
    const subtopic = goal.roadmap.children[subtopicIndex];
    const subs = (goal.modules || []).filter(m => m.subtopic_index === subtopicIndex);
    if (subs.length === 0) return;
    const done = subs.filter(m => m.completed).length;
    subtopic.status = done === subs.length ? "completed" : (done > 0 ? "in_progress" : "upcoming");
}

// ==================== PLANNER / TIMELINE ====================
function initTimelineGrid() {
    const labels = document.getElementById("planner-time-labels");
    const track = document.getElementById("planner-timeline-track");
    if (!labels || !track) return;

    labels.innerHTML = "";
    for (let i = 0; i < 24; i++) {
        labels.innerHTML += `<div class="time-label">${i.toString().padStart(2, '0')}:00</div>`;
        const line = document.createElement("div");
        line.className = "hour-line";
        line.style.top = (i * 60) + "px";
        track.appendChild(line);
    }
}

function setupCurrentTimeIndicator() {
    const indicator = document.getElementById("planner-current-time-indicator");
    if (!indicator) return;
    function update() {
        const now = new Date();
        indicator.style.top = (now.getHours() * 60 + now.getMinutes()) + "px";
    }
    update();
    setInterval(update, 60000);
}

function renderTimeline() {
    const track = document.getElementById("planner-timeline-track");
    if (!track) return;

    const indicator = document.getElementById("planner-current-time-indicator");
    track.innerHTML = "";
    
    // Re-add hour lines
    for (let i = 0; i < 24; i++) {
        const line = document.createElement("div");
        line.className = "hour-line";
        line.style.top = (i * 60) + "px";
        track.appendChild(line);
    }
    
    if (indicator) track.appendChild(indicator);

    const blocks = [...state.schedule].sort((a, b) => a.start - b.start);

    // Calculate overlap groups for positioning
    let overlapGroups = [];
    blocks.forEach(b => {
        let placed = false;
        for (let group of overlapGroups) {
            if (group.some(gb => b.start < gb.end && b.end > gb.start)) {
                group.push(b);
                placed = true;
                break;
            }
        }
        if (!placed) overlapGroups.push([b]);
    });

    overlapGroups.forEach(group => {
        const cols = [];
        group.forEach(block => {
            let col = 0;
            while (cols[col] && cols[col].some(b => block.start < b.end && block.end > b.start)) col++;
            if (!cols[col]) cols[col] = [];
            cols[col].push(block);
            block.colIndex = col;
        });
        group.forEach(block => { block.totalCols = cols.length; });
    });

    blocks.forEach(block => {
        const div = document.createElement("div");
        div.className = `timeline-block block-${block.category} ${block.type}`;
        div.style.top = block.start + "px";
        div.style.height = (block.end - block.start) + "px";

        const col = block.colIndex || 0;
        const total = block.totalCols || 1;
        const widthPct = 95 / total;
        div.style.left = `${2 + (col * widthPct)}%`;
        div.style.width = `${widthPct - 1}%`;

        div.innerHTML = `
            <div class="block-name">${block.name}</div>
            <div class="block-time">${formatMinutesToTime(block.start)} - ${formatMinutesToTime(block.end)}</div>
        `;
        div.onclick = () => openBlockDetails(block);
        track.appendChild(div);
    });
}

function formatMinutesToTime(minutes) {
    if (minutes === 1440) return '12:00 AM';
    const totalMins = minutes % 1440;
    const h24 = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    const period = h24 >= 12 ? 'PM' : 'AM';
    const h12 = h24 === 0 ? 12 : (h24 > 12 ? h24 - 12 : h24);
    return `${h12}:${m.toString().padStart(2, '0')} ${period}`;
}

function parseTimeToMinutes(timeStr) {
    if (!timeStr || !timeStr.includes(':')) return NaN;
    const parts = timeStr.split(':').map(Number);
    if (parts.some(isNaN)) return NaN;
    return parts[0] * 60 + parts[1];
}

function handleAddFixedBlock(event) {
    event.preventDefault();
    const name = document.getElementById('fb-name').value.trim();
    const category = document.getElementById('fb-category').value;
    const startStr = document.getElementById('fb-start').value;
    const endStr = document.getElementById('fb-end').value;

    if (!name) return showToast('Block name required.', 'error');
    if (!startStr || !endStr) return showToast('Set start and end times.', 'error');

    const start = parseTimeToMinutes(startStr);
    const end = parseTimeToMinutes(endStr);

    if (isNaN(start) || isNaN(end)) return showToast('Invalid time format.', 'error');
    if (start === end) return showToast('Start and end can\'t be the same.', 'error');

    if (start > end) {
        const ts = Date.now();
        state.schedule.push({ id: `b_${ts}_a`, name: `${name} (Night)`, type: 'fixed', start, end: 1440, category, completed: false });
        state.schedule.push({ id: `b_${ts}_b`, name: `${name} (Morning)`, type: 'fixed', start: 0, end, category, completed: false });
    } else {
        state.schedule.push({ id: `b_${Date.now()}`, name, type: 'fixed', start, end, category, completed: false });
    }

    saveState();
    renderTimeline();
    logTerminal(`Fixed block: "${name}" ${formatMinutesToTime(start)} - ${formatMinutesToTime(end)}`, "success");
    showToast(`Block added!`, "success");
    document.getElementById('planner-fixed-form').reset();
}

function findNextFreeSlot(duration) {
    const sorted = [...state.schedule].sort((a, b) => a.start - b.start);
    let current = 480; // 8:00 AM
    for (let b of sorted) {
        if (b.start >= current + duration) return { start: current, end: current + duration };
        current = Math.max(current, b.end);
    }
    if (current + duration <= 1320) return { start: current, end: current + duration };
    return null;
}

function triggerAutoSchedule() {
    const activeGoal = state.goals.find(g => g.id === state.activeGoalId);
    if (!activeGoal) return showToast("Select an active goal first.", "error");

    logTerminal("Running auto-schedule...", "system");

    state.schedule = state.schedule.filter(b => b.type === 'fixed');
    const fixed = [...state.schedule].sort((a, b) => a.start - b.start);

    let freeGaps = [];
    let cur = 480;
    for (let b of fixed) {
        if (b.start > cur) freeGaps.push({ start: cur, end: b.start });
        cur = Math.max(cur, b.end);
    }
    if (cur < 1320) freeGaps.push({ start: cur, end: 1320 });

    const queue = [...activeGoal.modules];
    let count = 0;

    for (let gap of freeGaps) {
        let remaining = gap.end - gap.start;
        let gapStart = gap.start;

        while (queue.length > 0 && remaining >= 30) {
            const mod = queue[0];
            if (mod.duration <= remaining) {
                state.schedule.push({
                    id: `b_auto_${Date.now()}_${count}`,
                    name: mod.name,
                    type: 'study',
                    start: gapStart,
                    end: gapStart + mod.duration,
                    category: mod.category || 'learning',
                    completed: false,
                    goalId: activeGoal.id
                });
                gapStart += mod.duration;
                remaining -= mod.duration;
                queue.shift();
                count++;
            } else break;
        }
    }

    saveState();
    renderTimeline();
    logTerminal(`Auto-scheduled ${count} modules.`, "success");
    showToast(`Scheduled ${count} study blocks!`, "success");
}

function clearSchedule() {
    state.schedule = [];
    saveState();
    renderTimeline();
    logTerminal("Schedule cleared.", "system");
    showToast("Schedule cleared.", "info");
}

// ==================== MODAL ====================
let selectedBlockForModal = null;

function openBlockDetails(block) {
    selectedBlockForModal = block;
    document.getElementById("modal-title").textContent = block.name.toUpperCase();

    document.getElementById("modal-body").innerHTML = `
        <div class="detail-row"><span class="detail-label">TYPE:</span> <span>${block.type.toUpperCase()}</span></div>
        <div class="detail-row"><span class="detail-label">CATEGORY:</span> <span>${(CATEGORIES[block.category]?.label || block.category).toUpperCase()}</span></div>
        <div class="detail-row"><span class="detail-label">TIME:</span> <span>${formatMinutesToTime(block.start)} - ${formatMinutesToTime(block.end)}</span></div>
        <div class="detail-row"><span class="detail-label">STATUS:</span> <span>${block.completed ? 'COMPLETED' : 'PENDING'}</span></div>
    `;

    const isRunnable = block.type === 'study' || ['learning', 'skill', 'personal'].includes(block.category);
    document.getElementById("modal-actions").innerHTML = `
        <button class="btn btn-danger" onclick="removeSelectedBlock()">Remove</button>
        ${isRunnable && !block.completed ? `<button class="btn btn-primary" onclick="startBlockTimer()">▶ Focus</button>` : ''}
    `;

    document.getElementById("block-modal").classList.add("active");
}

function removeSelectedBlock() {
    if (selectedBlockForModal) {
        state.schedule = state.schedule.filter(b => b.id !== selectedBlockForModal.id);
        saveState();
        renderTimeline();
        logTerminal(`Removed: "${selectedBlockForModal.name}"`, "system");
        closeModal();
    }
}

function startBlockTimer() {
    if (selectedBlockForModal) {
        state.timer.taskId = selectedBlockForModal.id;
        state.timer.taskName = selectedBlockForModal.name;
        state.timer.duration = (selectedBlockForModal.end - selectedBlockForModal.start) * 60;
        state.timer.running = false;
        saveState();
        closeModal();

        document.getElementById("active-timer-toggle-btn").removeAttribute("disabled");
        document.getElementById("active-timer-complete-btn").removeAttribute("disabled");
        toggleTimer();
        showToast(`Focus: ${selectedBlockForModal.name}`, "success");
    }
}

function closeModal(event) {
    if (!event || event.target === document.getElementById("block-modal") || event.target.tagName === 'BUTTON') {
        document.getElementById("block-modal").classList.remove("active");
    }
}

// ==================== FOCUS TIMER ====================
function toggleTimer() {
    const toggleBtn = document.getElementById("active-timer-toggle-btn");

    if (state.timer.running) {
        state.timer.running = false;
        clearInterval(timerInterval);
        if (toggleBtn) toggleBtn.textContent = "Play";
        logTerminal("Timer paused.", "system");
    } else {
        state.timer.running = true;
        if (toggleBtn) toggleBtn.textContent = "Pause";
        logTerminal("Focus timer started.", "system");

        timerInterval = setInterval(() => {
            if (state.timer.duration > 0) {
                state.timer.duration--;
                updateTimerDisplay();
            } else {
                completeTimerTask();
            }
        }, 1000);
    }
    saveState();
    updateTimerDisplay();
}

function updateTimerDisplay() {
    const hrs = Math.floor(state.timer.duration / 3600).toString().padStart(2, '0');
    const mins = Math.floor((state.timer.duration % 3600) / 60).toString().padStart(2, '0');
    const secs = (state.timer.duration % 60).toString().padStart(2, '0');

    const display = document.getElementById("active-timer-display");
    const taskName = document.getElementById("active-timer-task-name");

    if (display) display.textContent = `${hrs}:${mins}:${secs}`;
    if (taskName) taskName.textContent = (state.timer.taskName || 'NO ACTIVE TASK').toUpperCase();
}

function completeTimerTask() {
    clearInterval(timerInterval);
    state.timer.running = false;

    const block = state.schedule.find(b => b.id === state.timer.taskId);
    if (block) {
        block.completed = true;
        logTerminal(`Focus complete: "${block.name}"`, "success");
        showToast("Focus session complete!", "success");
    }

    state.streak = (state.streak || 0) + 1;
    state.timer.taskId = null;
    state.timer.taskName = '';
    state.timer.duration = 0;

    const toggleBtn = document.getElementById("active-timer-toggle-btn");
    const completeBtn = document.getElementById("active-timer-complete-btn");
    if (toggleBtn) toggleBtn.setAttribute("disabled", "true");
    if (completeBtn) completeBtn.setAttribute("disabled", "true");

    saveState();
    updateTimerDisplay();
    renderTimeline();
}

// ==================== UTILITIES ====================
function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatMarkdown(text) {
    if (!text) return '';
    return text
        .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
        .replace(/`([^`]+)`/g, '<code style="background:rgba(6,182,212,0.1); padding:1px 4px; border-radius:3px; font-family:var(--font-mono); font-size:0.85em;">$1</code>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/\n/g, '<br>');
}
