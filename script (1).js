'use strict';

/* ============================================================
   STUDY TIMER — APP LOGIC
   Sections:
   1. Constants & state
   2. Storage helpers
   3. Utility / formatting helpers
   4. Timer engine
   5. Stats computation
   6. Rendering (stats, goal, chart, log)
   7. Sound
   8. Theme & settings
   9. Modals & toasts
   10. Import / export / reset
   11. Init & event wiring
   ============================================================ */

/* ---------------- 1. Constants & state ---------------- */

const STORAGE_KEYS = {
  sessions: 'studyTimer_sessions_v1',
  settings: 'studyTimer_settings_v1',
  active: 'studyTimer_active_v1',
  countdowns: 'studyTimer_countdowns_v1',
};

const DEFAULT_SETTINGS = {
  theme: 'dark',
  accentColor: '#4F46E5',
  soundEnabled: true,
  animationsEnabled: true,
  lastSubject: '',
};

let sessions = [];        // array of saved study sessions
let countdowns = [];      // array of { id, title, date } day-countdown entries
let settings = { ...DEFAULT_SETTINGS };

let timerState = 'idle';  // 'idle' | 'running' | 'paused'
let sessionStartTs = null;
let pausedAtTs = null;
let totalPausedMs = 0;
let currentSessionSubject = '';

let tickIntervalId = null;
let clockIntervalId = null;
let subjectChartInstance = null;
let confirmResolver = null;

const DEFAULT_SUBJECT = 'Chưa phân loại';
const SUBJECT_COLOR_PALETTE = [
  '#4F46E5', '#0EA5E9', '#10B981', '#F59E0B', '#EC4899',
  '#8B5CF6', '#EF4444', '#14B8A6', '#F97316', '#3B82F6',
];
let currentSubjectPeriod = 'day'; // 'day' | 'week' | 'month' | 'year' | 'custom'
let currentCustomRange = { from: null, to: null }; // 'YYYY-MM-DD' strings, inclusive

/* Cached DOM references (populated in init) */
const dom = {};

/* ---------------- 2. Storage helpers ---------------- */

function loadSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.sessions);
    sessions = raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error('Không thể đọc dữ liệu phiên học:', err);
    sessions = [];
  }
}

function saveSessions() {
  try {
    localStorage.setItem(STORAGE_KEYS.sessions, JSON.stringify(sessions));
  } catch (err) {
    console.error('Không thể lưu dữ liệu phiên học:', err);
    showToast('Không thể lưu dữ liệu (bộ nhớ đầy?)', 'error');
  }
}

function loadCountdowns() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.countdowns);
    countdowns = raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error('Không thể đọc dữ liệu đếm ngược:', err);
    countdowns = [];
  }
}

function saveCountdowns() {
  try {
    localStorage.setItem(STORAGE_KEYS.countdowns, JSON.stringify(countdowns));
  } catch (err) {
    console.error('Không thể lưu dữ liệu đếm ngược:', err);
    showToast('Không thể lưu dữ liệu (bộ nhớ đầy?)', 'error');
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    settings = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch (err) {
    console.error('Không thể đọc cài đặt:', err);
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
  } catch (err) {
    console.error('Không thể lưu cài đặt:', err);
  }
}

function saveActiveState() {
  if (timerState === 'idle') {
    localStorage.removeItem(STORAGE_KEYS.active);
    return;
  }
  const activeState = { timerState, sessionStartTs, pausedAtTs, totalPausedMs, subject: currentSessionSubject };
  localStorage.setItem(STORAGE_KEYS.active, JSON.stringify(activeState));
}

function loadActiveState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.active);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

/* ---------------- 3. Utility / formatting helpers ---------------- */

function pad(n) { return String(n).padStart(2, '0'); }

/** Local YYYY-MM-DD (avoids UTC shift from toISOString) */
function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayStr() { return toDateStr(new Date()); }

/** Monday 00:00:00 of the week containing `date` */
function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfWeek(date) {
  const start = startOfWeek(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return end;
}

/** ms -> "HH:MM:SS" (can exceed 24h) */
function formatHMS(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** seconds -> "Xh Ym" readable duration */
function formatDurationReadable(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatClockTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function generateId() {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const WEEKDAY_LABELS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

/* ---------------- 4. Timer engine ---------------- */

function getElapsedMs() {
  if (timerState === 'idle') return 0;
  const now = timerState === 'paused' ? pausedAtTs : Date.now();
  return now - sessionStartTs - totalPausedMs;
}

function startTimer() {
  if (timerState !== 'idle') return;
  sessionStartTs = Date.now();
  totalPausedMs = 0;
  pausedAtTs = null;
  timerState = 'running';
  currentSessionSubject = (dom.subjectInput.value || '').trim() || DEFAULT_SUBJECT;
  dom.subjectInput.value = currentSessionSubject;
  dom.subjectInput.disabled = true;
  dom.subjectRow.classList.add('locked');
  runTickLoop();
  saveActiveState();
  updateTimerUI();
}

function pauseTimer() {
  if (timerState !== 'running') return;
  pausedAtTs = Date.now();
  timerState = 'paused';
  stopTickLoop();
  saveActiveState();
  updateTimerUI();
}

function resumeTimer() {
  if (timerState !== 'paused') return;
  totalPausedMs += Date.now() - pausedAtTs;
  pausedAtTs = null;
  timerState = 'running';
  runTickLoop();
  saveActiveState();
  updateTimerUI();
}

function endTimer() {
  if (timerState === 'idle') return;
  const elapsedMs = getElapsedMs();
  const durationSeconds = Math.floor(elapsedMs / 1000);
  const endTs = Date.now();

  stopTickLoop();

  // Only save meaningful sessions (avoid accidental 0-second entries)
  if (durationSeconds >= 1) {
    const subject = currentSessionSubject || DEFAULT_SUBJECT;
    const session = {
      id: generateId(),
      startTs: sessionStartTs,
      endTs,
      duration: durationSeconds,
      dateStr: toDateStr(new Date(sessionStartTs)),
      subject,
    };
    sessions.push(session);
    saveSessions();
    settings.lastSubject = subject;
    saveSettings();
    showToast('Đã lưu phiên học thành công', 'success');
  }

  playChime();

  // Reset state
  timerState = 'idle';
  sessionStartTs = null;
  pausedAtTs = null;
  totalPausedMs = 0;
  currentSessionSubject = '';
  saveActiveState();

  dom.subjectInput.disabled = false;
  dom.subjectRow.classList.remove('locked');
  populateSubjectDatalist();

  updateTimerUI();
  dom.timerDisplay.textContent = '00:00:00';
  renderAll();
}

function runTickLoop() {
  stopTickLoop(); // guarantee only one interval is ever active
  tick();
  tickIntervalId = setInterval(tick, 250);
}

function stopTickLoop() {
  if (tickIntervalId !== null) {
    clearInterval(tickIntervalId);
    tickIntervalId = null;
  }
}

function tick() {
  dom.timerDisplay.textContent = formatHMS(getElapsedMs());
}

function updateTimerUI() {
  dom.timerCard.classList.remove('is-running', 'is-paused');

  if (timerState === 'running') {
    dom.timerCard.classList.add('is-running');
    dom.timerStatusText.textContent = 'Đang học';
    dom.btnStart.disabled = true;
    dom.btnPause.disabled = false;
    dom.btnResume.disabled = true;
    dom.btnEnd.disabled = false;
  } else if (timerState === 'paused') {
    dom.timerCard.classList.add('is-paused');
    dom.timerStatusText.textContent = 'Đang tạm dừng';
    dom.btnStart.disabled = true;
    dom.btnPause.disabled = true;
    dom.btnResume.disabled = false;
    dom.btnEnd.disabled = false;
  } else {
    dom.timerStatusText.textContent = 'Sẵn sàng';
    dom.btnStart.disabled = false;
    dom.btnPause.disabled = true;
    dom.btnResume.disabled = true;
    dom.btnEnd.disabled = true;
  }
}

/** Restore an in-progress session after a page reload */
function restoreActiveSession() {
  const active = loadActiveState();
  if (!active) return;

  timerState = active.timerState;
  sessionStartTs = active.sessionStartTs;
  pausedAtTs = active.pausedAtTs;
  totalPausedMs = active.totalPausedMs;
  currentSessionSubject = active.subject || DEFAULT_SUBJECT;
  dom.subjectInput.value = currentSessionSubject;
  dom.subjectInput.disabled = true;
  dom.subjectRow.classList.add('locked');

  if (timerState === 'running') {
    runTickLoop();
  } else if (timerState === 'paused') {
    dom.timerDisplay.textContent = formatHMS(getElapsedMs());
  }
  updateTimerUI();
}

/* Keep the displayed time accurate even after the tab was throttled
   while hidden (setInterval can slow down in background tabs). */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && timerState === 'running') {
    tick();
  }
});

/* ---------------- 5. Stats computation ---------------- */

/** Refresh the <datalist> of subjects with every subject used so far (most recent first) */
function populateSubjectDatalist() {
  const seen = new Set();
  const ordered = [];
  [...sessions].sort((a, b) => b.startTs - a.startTs).forEach((s) => {
    const subj = s.subject || DEFAULT_SUBJECT;
    if (!seen.has(subj)) {
      seen.add(subj);
      ordered.push(subj);
    }
  });
  dom.subjectDatalist.innerHTML = ordered.map((s) => `<option value="${escapeHtml(s)}"></option>`).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** Stable color per subject name, cycling through the palette */
const subjectColorCache = new Map();
function getSubjectColor(subject) {
  if (subjectColorCache.has(subject)) return subjectColorCache.get(subject);
  let hash = 0;
  for (let i = 0; i < subject.length; i += 1) hash = (hash * 31 + subject.charCodeAt(i)) >>> 0;
  const color = SUBJECT_COLOR_PALETTE[hash % SUBJECT_COLOR_PALETTE.length];
  subjectColorCache.set(subject, color);
  return color;
}

/** Aggregate seconds studied per subject for the given period ('day'|'week'|'month'|'year') */
function computeSubjectStats(period) {
  const now = new Date();
  const today = todayStr();
  const weekStart = startOfWeek(now);
  const weekEnd = endOfWeek(now);
  const curYear = now.getFullYear();
  const curMonth = now.getMonth();

  const totals = new Map();

  for (const s of sessions) {
    const startDate = new Date(s.startTs);
    let inPeriod = false;

    if (period === 'day') {
      inPeriod = s.dateStr === today;
    } else if (period === 'week') {
      inPeriod = startDate >= weekStart && startDate < weekEnd;
    } else if (period === 'month') {
      inPeriod = startDate.getFullYear() === curYear && startDate.getMonth() === curMonth;
    } else if (period === 'year') {
      inPeriod = startDate.getFullYear() === curYear;
    } else if (period === 'custom') {
      const { from, to } = currentCustomRange;
      if (from && to) inPeriod = s.dateStr >= from && s.dateStr <= to;
    }

    if (!inPeriod) continue;
    const subj = s.subject || DEFAULT_SUBJECT;
    totals.set(subj, (totals.get(subj) || 0) + s.duration);
  }

  return [...totals.entries()]
    .map(([subject, duration]) => ({ subject, duration }))
    .sort((a, b) => b.duration - a.duration);
}

/** Read the two custom-range date inputs, validate them, and re-render the chart */
function applyCustomPeriod() {
  const from = dom.periodFromInput.value;
  const to = dom.periodToInput.value;

  if (!from || !to) {
    showToast('Vui lòng chọn cả ngày bắt đầu và ngày kết thúc', 'error');
    return;
  }
  if (from > to) {
    showToast('Ngày bắt đầu phải trước ngày kết thúc', 'error');
    return;
  }

  currentCustomRange = { from, to };
  renderSubjectChart();
}

/* ---------------- 6. Rendering ---------------- */

function renderAll() {
  renderSubjectChart();
  renderLog();
  renderCountdowns();
}

function renderSubjectChart() {
  const data = computeSubjectStats(currentSubjectPeriod);
  const rootStyles = getComputedStyle(document.documentElement);
  const cardBg = rootStyles.getPropertyValue('--bg-1').trim() || '#10121c';

  const hasData = data.length > 0;
  dom.subjectChartBody.style.display = hasData ? 'grid' : 'none';
  dom.subjectEmptyState.hidden = hasData;

  const totalDuration = data.reduce((sum, d) => sum + d.duration, 0);
  dom.subjectChartTotal.innerHTML = `Tổng: <strong>${formatDurationReadable(totalDuration)}</strong>`;

  if (!hasData) {
    if (subjectChartInstance) {
      subjectChartInstance.destroy();
      subjectChartInstance = null;
    }
    dom.subjectLegend.innerHTML = '';
    return;
  }

  const labels = data.map((d) => d.subject);
  const values = data.map((d) => +(d.duration / 3600).toFixed(2));
  const colors = data.map((d) => getSubjectColor(d.subject));

  const ctx = dom.subjectChart.getContext('2d');

  if (subjectChartInstance) {
    subjectChartInstance.data.labels = labels;
    subjectChartInstance.data.datasets[0].data = values;
    subjectChartInstance.data.datasets[0].backgroundColor = colors;
    subjectChartInstance.data.datasets[0].borderColor = cardBg;
    subjectChartInstance.options.animation.duration = settings.animationsEnabled ? 500 : 0;
    subjectChartInstance.update();
  } else {
    subjectChartInstance = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderColor: cardBg,
          borderWidth: 2,
          hoverOffset: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        animation: { duration: settings.animationsEnabled ? 500 : 0 },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (item) => `${item.label}: ${item.formattedValue}h`,
            },
          },
        },
      },
    });
  }

  dom.subjectLegend.innerHTML = data.map((d) => {
    const percent = totalDuration > 0 ? Math.round((d.duration / totalDuration) * 100) : 0;
    return `
      <div class="subject-legend-item">
        <span class="subject-legend-dot" style="background:${getSubjectColor(d.subject)}"></span>
        <span class="subject-legend-name">${escapeHtml(d.subject)}</span>
        <span class="subject-legend-meta">
          <span class="subject-legend-time">${formatDurationReadable(d.duration)}</span>
          <span class="subject-legend-percent">${percent}%</span>
        </span>
      </div>
    `;
  }).join('');
}

function renderLog() {
  const sorted = [...sessions].sort((a, b) => b.startTs - a.startTs);
  dom.logList.innerHTML = '';

  if (sorted.length === 0) {
    dom.logList.innerHTML = '<p class="empty-state">Chưa có phiên học nào. Bắt đầu học để tạo nhật ký đầu tiên!</p>';
    return;
  }

  const fragment = document.createDocumentFragment();
  sorted.forEach((session) => fragment.appendChild(createLogItemElement(session)));
  dom.logList.appendChild(fragment);
}

function createLogItemElement(session) {
  const item = document.createElement('div');
  item.className = 'log-item';
  item.dataset.id = session.id;

  const dateObj = new Date(session.startTs);
  const dateLabel = `${WEEKDAY_LABELS[dateObj.getDay()]}, ${pad(dateObj.getDate())}/${pad(dateObj.getMonth() + 1)}/${dateObj.getFullYear()}`;

  const subject = session.subject || DEFAULT_SUBJECT;
  const subjectColor = getSubjectColor(subject);
  const rgb = hexToRgb(subjectColor) || { r: 79, g: 70, b: 229 };
  const badgeStyle = `background: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.14); color: ${subjectColor};`;

  item.innerHTML = `
    <div class="log-item-main">
      <div class="log-item-top-row">
        <span class="log-item-date">${dateLabel}</span>
        <span class="log-item-subject" style="${badgeStyle}">
          <i class="fa-solid fa-tag"></i>${escapeHtml(subject)}
        </span>
      </div>
      <span class="log-item-time">${formatClockTime(session.startTs)} → ${formatClockTime(session.endTs)}</span>
    </div>
    <div class="log-item-right">
      <span class="log-item-duration">${formatDurationReadable(session.duration)}</span>
      <button class="log-delete-btn" title="Xóa phiên này" aria-label="Xóa phiên này">
        <i class="fa-solid fa-trash"></i>
      </button>
    </div>
  `;

  item.querySelector('.log-delete-btn').addEventListener('click', async () => {
    const ok = await showConfirm('Xóa phiên học?', 'Phiên học này sẽ bị xóa vĩnh viễn khỏi nhật ký.');
    if (ok) deleteSession(session.id);
  });

  return item;
}

function deleteSession(id) {
  sessions = sessions.filter((s) => s.id !== id);
  saveSessions();
  renderAll();
  showToast('Đã xóa phiên học', 'success');
}

async function clearAllSessions() {
  const ok = await showConfirm('Xóa toàn bộ nhật ký?', 'Tất cả phiên học sẽ bị xóa vĩnh viễn. Hành động này không thể hoàn tác.');
  if (!ok) return;
  sessions = [];
  saveSessions();
  renderAll();
  showToast('Đã xóa toàn bộ nhật ký', 'success');
}

/* ---------------- 6b. Day countdown ---------------- */

/** Whole days between today (local) and a 'YYYY-MM-DD' target date. Positive = upcoming. */
function daysUntil(dateStr) {
  const target = new Date(`${dateStr}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

function openCountdownForm() {
  dom.countdownAddRow.hidden = false;
  dom.countdownToggleBtn.hidden = true;
  dom.countdownTitleInput.focus();
}

function closeCountdownForm() {
  dom.countdownAddRow.hidden = true;
  dom.countdownToggleBtn.hidden = false;
  dom.countdownTitleInput.value = '';
  dom.countdownDateInput.value = '';
}

function addCountdown() {
  const title = (dom.countdownTitleInput.value || '').trim();
  const dateVal = dom.countdownDateInput.value;

  if (!title) {
    showToast('Vui lòng nhập tên kỳ thi', 'error');
    return;
  }
  if (!dateVal) {
    showToast('Vui lòng chọn ngày', 'error');
    return;
  }

  countdowns.push({ id: generateId(), title, date: dateVal });
  saveCountdowns();

  closeCountdownForm();
  renderCountdowns();
  showToast('Đã thêm đếm ngược', 'success');
}

function deleteCountdown(id) {
  countdowns = countdowns.filter((c) => c.id !== id);
  saveCountdowns();
  renderCountdowns();
  showToast('Đã xóa đếm ngược', 'success');
}

function renderCountdowns() {
  const sorted = [...countdowns].sort((a, b) => a.date.localeCompare(b.date));
  dom.countdownList.innerHTML = '';

  if (sorted.length === 0) {
    dom.countdownList.innerHTML = '<p class="empty-state">Chưa có ngày đếm ngược nào. Nhấn "Thêm" để tạo mốc quan trọng!</p>';
    return;
  }

  const fragment = document.createDocumentFragment();
  sorted.forEach((c) => fragment.appendChild(createCountdownItemElement(c)));
  dom.countdownList.appendChild(fragment);
}

function createCountdownItemElement(c) {
  const item = document.createElement('div');
  item.className = 'countdown-item';
  item.dataset.id = c.id;

  const dateObj = new Date(`${c.date}T00:00:00`);
  const dateLabel = `${pad(dateObj.getDate())}/${pad(dateObj.getMonth() + 1)}/${dateObj.getFullYear()}`;
  const days = daysUntil(c.date);

  let daysNumber;
  let daysLabel;
  let daysClass = '';
  if (days > 0) {
    daysNumber = String(days);
    daysLabel = 'ngày nữa';
  } else if (days === 0) {
    daysNumber = '🎉';
    daysLabel = 'Hôm nay!';
    daysClass = 'is-today';
  } else {
    daysNumber = String(Math.abs(days));
    daysLabel = 'ngày trước';
    daysClass = 'is-past';
  }

  item.innerHTML = `
    <div class="countdown-item-main">
      <span class="countdown-item-title">${escapeHtml(c.title)}</span>
      <span class="countdown-item-date">${dateLabel}</span>
    </div>
    <div class="countdown-item-right">
      <div class="countdown-days ${daysClass}">
        <span class="countdown-days-number">${daysNumber}</span>
        <span class="countdown-days-label">${daysLabel}</span>
      </div>
      <button class="countdown-delete-btn" title="Xóa" aria-label="Xóa">
        <i class="fa-solid fa-trash"></i>
      </button>
    </div>
  `;

  item.querySelector('.countdown-delete-btn').addEventListener('click', async () => {
    const ok = await showConfirm('Xóa đếm ngược?', `"${c.title}" sẽ bị xóa vĩnh viễn.`);
    if (ok) deleteCountdown(c.id);
  });

  return item;
}

/* ---------------- 7. Sound ---------------- */

let audioCtx = null;

/** Synthesize a soft two-tone chime with the Web Audio API (no external file needed) */
function playChime() {
  if (!settings.soundEnabled) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    const notes = [880, 1174.66]; // A5, D6

    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = now + i * 0.16;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.22, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.9);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + 1);
    });
  } catch (err) {
    console.error('Không thể phát âm thanh:', err);
  }
}

function toggleSound() {
  settings.soundEnabled = !settings.soundEnabled;
  saveSettings();
  updateSoundButtonIcon();
  showToast(settings.soundEnabled ? 'Đã bật âm thanh' : 'Đã tắt âm thanh', 'info');
}

function updateSoundButtonIcon() {
  dom.soundToggleBtn.innerHTML = settings.soundEnabled
    ? '<i class="fa-solid fa-volume-high"></i>'
    : '<i class="fa-solid fa-volume-xmark"></i>';
}

/* ---------------- 8. Theme & settings ---------------- */

function applyTheme(theme) {
  settings.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  dom.themeToggleBtn.innerHTML = theme === 'dark'
    ? '<i class="fa-solid fa-moon"></i>'
    : '<i class="fa-solid fa-sun"></i>';
  saveSettings();
}

function toggleTheme() {
  applyTheme(settings.theme === 'dark' ? 'light' : 'dark');
  renderSubjectChart(); // refresh chart colors for new theme
}

function applyAccentColor(color) {
  settings.accentColor = color;
  document.documentElement.style.setProperty('--accent', color);
  const rgb = hexToRgb(color);
  if (rgb) {
    document.documentElement.style.setProperty('--accent-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
  }
  dom.accentColorInput.value = color;
  document.querySelectorAll('.swatch').forEach((sw) => {
    sw.classList.toggle('active', sw.dataset.color.toLowerCase() === color.toLowerCase());
  });
  saveSettings();
}

function hexToRgb(hex) {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return match
    ? { r: parseInt(match[1], 16), g: parseInt(match[2], 16), b: parseInt(match[3], 16) }
    : null;
}

function applyAnimations(enabled) {
  settings.animationsEnabled = enabled;
  document.body.classList.toggle('no-animations', !enabled);
  saveSettings();
}

function openSettings() { dom.settingsModal.classList.add('open'); }
function closeSettings() { dom.settingsModal.classList.remove('open'); }

/* ---------------- 9. Modals & toasts ---------------- */

function showConfirm(title, message) {
  dom.confirmTitle.textContent = title;
  dom.confirmMessage.textContent = message;
  dom.confirmModal.classList.add('open');
  return new Promise((resolve) => { confirmResolver = resolve; });
}

function resolveConfirm(result) {
  dom.confirmModal.classList.remove('open');
  if (confirmResolver) {
    confirmResolver(result);
    confirmResolver = null;
  }
}

const TOAST_ICONS = {
  success: 'fa-circle-check',
  error: 'fa-circle-exclamation',
  info: 'fa-circle-info',
};

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<i class="fa-solid ${TOAST_ICONS[type] || TOAST_ICONS.info}"></i><span>${message}</span>`;
  dom.toastContainer.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 350);
  }, 3000);
}

/* ---------------- 10. Import / export / reset ---------------- */

function exportData() {
  const payload = {
    exportedAt: new Date().toISOString(),
    sessions,
    settings,
    countdowns,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `study-timer-backup-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('Đã xuất dữ liệu thành công', 'success');
}

function importData(file) {
  if (!file) return;
  const reader = new FileReader();

  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!Array.isArray(parsed.sessions)) throw new Error('invalid format');

      sessions = parsed.sessions;
      saveSessions();

      if (parsed.settings) {
        settings = { ...DEFAULT_SETTINGS, ...parsed.settings };
        saveSettings();
        applySettingsToUI();
      }

      if (Array.isArray(parsed.countdowns)) {
        countdowns = parsed.countdowns;
        saveCountdowns();
      }

      populateSubjectDatalist();
      renderAll();
      showToast('Đã nhập dữ liệu thành công', 'success');
    } catch (err) {
      console.error('Import lỗi:', err);
      showToast('Tệp không hợp lệ, không thể nhập dữ liệu', 'error');
    }
  };

  reader.onerror = () => showToast('Không thể đọc tệp', 'error');
  reader.readAsText(file);
}

async function resetAllData() {
  const ok = await showConfirm('Reset toàn bộ dữ liệu?', 'Mọi phiên học và cài đặt sẽ bị xóa vĩnh viễn. Bạn chắc chắn chứ?');
  if (!ok) return;

  localStorage.removeItem(STORAGE_KEYS.sessions);
  localStorage.removeItem(STORAGE_KEYS.settings);
  localStorage.removeItem(STORAGE_KEYS.active);
  localStorage.removeItem(STORAGE_KEYS.countdowns);

  sessions = [];
  countdowns = [];
  settings = { ...DEFAULT_SETTINGS };
  timerState = 'idle';
  sessionStartTs = null;
  pausedAtTs = null;
  totalPausedMs = 0;
  stopTickLoop();

  applySettingsToUI();
  updateTimerUI();
  dom.timerDisplay.textContent = '00:00:00';
  dom.subjectInput.value = '';
  dom.subjectInput.disabled = false;
  dom.subjectRow.classList.remove('locked');
  currentSubjectPeriod = 'day';
  currentCustomRange = { from: null, to: null };
  dom.periodFromInput.value = '';
  dom.periodToInput.value = '';
  dom.periodCustomRow.hidden = true;
  document.querySelectorAll('.period-tab').forEach((t) => t.classList.toggle('active', t.dataset.period === 'day'));
  closeCountdownForm();
  populateSubjectDatalist();
  renderAll();
  closeSettings();
  showToast('Đã reset toàn bộ dữ liệu', 'success');
}

/* Apply the current `settings` object to every relevant UI control */
function applySettingsToUI() {
  applyTheme(settings.theme);
  applyAccentColor(settings.accentColor);
  applyAnimations(settings.animationsEnabled);
  updateSoundButtonIcon();
  dom.animationToggle.checked = settings.animationsEnabled;
}

/* ---------------- 11. Init & event wiring ---------------- */

function cacheDom() {
  const ids = [
    'currentDate', 'liveClock', 'soundToggleBtn', 'themeToggleBtn', 'settingsBtn',
    'timerCard', 'timerStatus', 'timerStatusText', 'timerDisplay',
    'btnStart', 'btnPause', 'btnResume', 'btnEnd',
    'countdownCard', 'countdownToggleBtn', 'countdownAddRow',
    'countdownTitleInput', 'countdownDateInput', 'countdownSaveBtn', 'countdownCancelBtn', 'countdownList',
    'logList', 'btnClearAll',
    'subjectRow', 'subjectInput', 'subjectDatalist',
    'subjectChartBody', 'subjectChart', 'subjectLegend', 'subjectEmptyState', 'subjectChartTotal',
    'periodCustomRow', 'periodFromInput', 'periodToInput', 'periodApplyBtn',
    'settingsModal', 'closeSettingsBtn', 'accentColorInput', 'animationToggle',
    'exportBtn', 'importBtn', 'importInput', 'resetDataBtn',
    'confirmModal', 'confirmTitle', 'confirmMessage', 'confirmCancelBtn', 'confirmOkBtn',
    'toastContainer',
  ];
  ids.forEach((id) => { dom[id] = document.getElementById(id); });
}

let lastKnownDateStr = todayStr();

function updateClockAndDate() {
  const now = new Date();
  dom.liveClock.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const weekday = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'][now.getDay()];
  dom.currentDate.textContent = `${weekday}, ${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;

  const currentDateStr = todayStr();
  if (currentDateStr !== lastKnownDateStr) {
    lastKnownDateStr = currentDateStr;
    renderAll(); // date rolled over past midnight — refresh stats & countdowns
  }
}

function wireEvents() {
  dom.btnStart.addEventListener('click', startTimer);
  dom.btnPause.addEventListener('click', pauseTimer);
  dom.btnResume.addEventListener('click', resumeTimer);
  dom.btnEnd.addEventListener('click', endTimer);

  dom.soundToggleBtn.addEventListener('click', toggleSound);
  dom.themeToggleBtn.addEventListener('click', toggleTheme);
  dom.settingsBtn.addEventListener('click', openSettings);
  dom.closeSettingsBtn.addEventListener('click', closeSettings);
  dom.settingsModal.addEventListener('click', (e) => {
    if (e.target === dom.settingsModal) closeSettings();
  });

  dom.btnClearAll.addEventListener('click', clearAllSessions);

  document.querySelectorAll('.period-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const period = tab.dataset.period;

      document.querySelectorAll('.period-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      currentSubjectPeriod = period;
      dom.periodCustomRow.hidden = period !== 'custom';

      renderSubjectChart();
    });
  });

  dom.periodApplyBtn.addEventListener('click', applyCustomPeriod);
  dom.periodFromInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyCustomPeriod(); });
  dom.periodToInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyCustomPeriod(); });

  document.querySelectorAll('.swatch').forEach((sw) => {
    sw.addEventListener('click', () => applyAccentColor(sw.dataset.color));
  });
  dom.accentColorInput.addEventListener('input', (e) => applyAccentColor(e.target.value));

  dom.animationToggle.addEventListener('change', (e) => applyAnimations(e.target.checked));

  dom.exportBtn.addEventListener('click', exportData);
  dom.importBtn.addEventListener('click', () => dom.importInput.click());
  dom.importInput.addEventListener('change', (e) => {
    importData(e.target.files[0]);
    e.target.value = '';
  });
  dom.resetDataBtn.addEventListener('click', resetAllData);

  dom.countdownToggleBtn.addEventListener('click', openCountdownForm);
  dom.countdownSaveBtn.addEventListener('click', addCountdown);
  dom.countdownCancelBtn.addEventListener('click', closeCountdownForm);
  dom.countdownTitleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addCountdown();
    if (e.key === 'Escape') closeCountdownForm();
  });
  dom.countdownDateInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addCountdown();
    if (e.key === 'Escape') closeCountdownForm();
  });

  dom.confirmCancelBtn.addEventListener('click', () => resolveConfirm(false));
  dom.confirmOkBtn.addEventListener('click', () => resolveConfirm(true));
  dom.confirmModal.addEventListener('click', (e) => {
    if (e.target === dom.confirmModal) resolveConfirm(false);
  });

  // Warn before leaving the page while a session is actively running
  window.addEventListener('beforeunload', (e) => {
    if (timerState === 'running' || timerState === 'paused') {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

function init() {
  cacheDom();
  loadSettings();
  loadSessions();
  loadCountdowns();

  applySettingsToUI();
  populateSubjectDatalist();
  if (settings.lastSubject && timerState === 'idle') dom.subjectInput.value = settings.lastSubject;
  wireEvents();

  updateClockAndDate();
  clockIntervalId = setInterval(updateClockAndDate, 1000);

  restoreActiveSession();
  renderAll();
}

document.addEventListener('DOMContentLoaded', init);
