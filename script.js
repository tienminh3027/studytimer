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
};

const DEFAULT_SETTINGS = {
  theme: 'dark',
  accentColor: '#4F46E5',
  soundEnabled: true,
  animationsEnabled: true,
  dailyGoalHours: 4,
};

let sessions = [];        // array of saved study sessions
let settings = { ...DEFAULT_SETTINGS };

let timerState = 'idle';  // 'idle' | 'running' | 'paused'
let sessionStartTs = null;
let pausedAtTs = null;
let totalPausedMs = 0;

let tickIntervalId = null;
let clockIntervalId = null;
let chartInstance = null;
let confirmResolver = null;

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
  const activeState = { timerState, sessionStartTs, pausedAtTs, totalPausedMs };
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
    const session = {
      id: generateId(),
      startTs: sessionStartTs,
      endTs,
      duration: durationSeconds,
      dateStr: toDateStr(new Date(sessionStartTs)),
    };
    sessions.push(session);
    saveSessions();
    showToast('Đã lưu phiên học thành công', 'success');
  }

  playChime();

  // Reset state
  timerState = 'idle';
  sessionStartTs = null;
  pausedAtTs = null;
  totalPausedMs = 0;
  saveActiveState();

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

function computeStats() {
  const now = new Date();
  const today = todayStr();
  const weekStart = startOfWeek(now);
  const weekEnd = endOfWeek(now);
  const curYear = now.getFullYear();
  const curMonth = now.getMonth();

  let todayTotal = 0;
  let weekTotal = 0;
  let monthTotal = 0;
  let allTotal = 0;
  let sessionsToday = 0;
  let longest = 0;

  for (const s of sessions) {
    allTotal += s.duration;
    longest = Math.max(longest, s.duration);

    if (s.dateStr === today) {
      todayTotal += s.duration;
      sessionsToday += 1;
    }

    const startDate = new Date(s.startTs);
    if (startDate >= weekStart && startDate < weekEnd) {
      weekTotal += s.duration;
    }
    if (startDate.getFullYear() === curYear && startDate.getMonth() === curMonth) {
      monthTotal += s.duration;
    }
  }

  const average = sessions.length ? allTotal / sessions.length : 0;

  return { todayTotal, weekTotal, monthTotal, allTotal, sessionsToday, longest, average };
}

/** Total seconds studied on a given Date (by local day) */
function totalForDate(date) {
  const key = toDateStr(date);
  return sessions
    .filter((s) => s.dateStr === key)
    .reduce((sum, s) => sum + s.duration, 0);
}

/* ---------------- 6. Rendering ---------------- */

function renderAll() {
  const stats = computeStats();
  renderStats(stats);
  renderGoal(stats);
  renderChart();
  renderLog();
}

function renderStats(stats) {
  dom.statToday.textContent = formatDurationReadable(stats.todayTotal);
  dom.statWeek.textContent = formatDurationReadable(stats.weekTotal);
  dom.statMonth.textContent = formatDurationReadable(stats.monthTotal);
  dom.statAll.textContent = formatDurationReadable(stats.allTotal);
  dom.statSessionsToday.textContent = String(stats.sessionsToday);
  dom.statLongest.textContent = formatDurationReadable(stats.longest);
  dom.statAverage.textContent = formatDurationReadable(stats.average);
}

function renderGoal(stats) {
  const goalHours = Number(dom.goalInput.value) || settings.dailyGoalHours || 4;
  const goalSeconds = goalHours * 3600;
  const percent = goalSeconds > 0 ? Math.min(100, (stats.todayTotal / goalSeconds) * 100) : 0;
  const remainingSeconds = Math.max(0, goalSeconds - stats.todayTotal);

  dom.goalProgressFill.style.width = `${percent}%`;
  dom.goalPercentText.textContent = `${Math.round(percent)}%`;

  dom.goalRemainingText.textContent = percent >= 100
    ? 'Đã hoàn thành mục tiêu! 🎉'
    : `Còn thiếu ${formatDurationReadable(remainingSeconds)}`;
}

function renderChart() {
  const labels = [];
  const values = [];
  const today = new Date();

  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    labels.push(`${WEEKDAY_LABELS[d.getDay()]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`);
    values.push(+(totalForDate(d) / 3600).toFixed(2)); // hours, 2dp
  }

  const rootStyles = getComputedStyle(document.documentElement);
  const accent = rootStyles.getPropertyValue('--accent').trim() || '#4F46E5';
  const textColor = rootStyles.getPropertyValue('--text-2').trim() || '#999';
  const gridColor = rootStyles.getPropertyValue('--card-border').trim() || 'rgba(255,255,255,0.1)';

  const ctx = dom.weekChart.getContext('2d');

  if (chartInstance) {
    chartInstance.data.labels = labels;
    chartInstance.data.datasets[0].data = values;
    chartInstance.data.datasets[0].backgroundColor = accent;
    chartInstance.options.scales.x.ticks.color = textColor;
    chartInstance.options.scales.y.ticks.color = textColor;
    chartInstance.options.scales.y.grid.color = gridColor;
    chartInstance.update();
    return;
  }

  chartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Giờ học',
        data: values,
        backgroundColor: accent,
        borderRadius: 8,
        maxBarThickness: 34,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: settings.animationsEnabled ? 500 : 0 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => `${item.formattedValue}h học`,
          },
        },
      },
      scales: {
        x: { ticks: { color: textColor }, grid: { display: false } },
        y: {
          beginAtZero: true,
          ticks: { color: textColor, stepSize: 1 },
          grid: { color: gridColor },
        },
      },
    },
  });
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

  item.innerHTML = `
    <div class="log-item-main">
      <span class="log-item-date">${dateLabel}</span>
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

/* ---------------- 7b. Music (YouTube background player) ---------------- */

const MUSIC_STORAGE_KEY = 'studyTimer_music_v1';
let ytPlayer = null;
let ytApiPromise = null;
let currentVideoId = null;
const musicState = { lastUrl: '', volume: 70 };

function loadMusicState() {
  try {
    const raw = localStorage.getItem(MUSIC_STORAGE_KEY);
    if (raw) Object.assign(musicState, JSON.parse(raw));
  } catch (err) {
    console.error('Không thể đọc trạng thái nhạc:', err);
  }
}

function saveMusicState() {
  try {
    localStorage.setItem(MUSIC_STORAGE_KEY, JSON.stringify(musicState));
  } catch (err) {
    console.error('Không thể lưu trạng thái nhạc:', err);
  }
}

/** Extract an 11-character YouTube video ID from common URL shapes, or a raw ID */
function extractYouTubeId(input) {
  const url = input.trim();
  const patterns = [
    /youtube\.com\/watch\?[^#]*v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /youtube\.com\/embed\/([\w-]{11})/,
    /youtube\.com\/shorts\/([\w-]{11})/,
    /youtube\.com\/live\/([\w-]{11})/,
  ];
  for (const re of patterns) {
    const match = url.match(re);
    if (match) return match[1];
  }
  return /^[\w-]{11}$/.test(url) ? url : null;
}

/** Lazily inject the YouTube IFrame API script (only once) */
function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise((resolve) => {
    const previousCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previousCallback === 'function') previousCallback();
      resolve();
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });
  return ytApiPromise;
}

async function loadMusicFromInput() {
  const raw = dom.musicUrlInput.value;
  const videoId = extractYouTubeId(raw);
  if (!videoId) {
    showToast('Link YouTube không hợp lệ', 'error');
    return;
  }

  try {
    await loadYouTubeApi();
  } catch (err) {
    showToast('Không thể tải YouTube (kiểm tra kết nối mạng)', 'error');
    return;
  }

  dom.musicEmptyState.style.display = 'none';
  dom.musicFallbackLink.hidden = true;
  currentVideoId = videoId;

  if (ytPlayer && typeof ytPlayer.loadVideoById === 'function') {
    ytPlayer.loadVideoById(videoId);
  } else {
    ytPlayer = new YT.Player('youtubePlayer', {
      videoId,
      host: 'https://www.youtube-nocookie.com',
      playerVars: { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1 },
      events: {
        onReady: (e) => {
          e.target.setVolume(musicState.volume);
          dom.musicControls.hidden = false;
          dom.musicVolumeSlider.value = musicState.volume;
          // The IFrame API replaces our div with its own iframe — make sure
          // that iframe always sends a valid referrer, or YouTube may refuse
          // to play the video (Error 153: Video player configuration error).
          const iframeEl = dom.musicPlayerWrap.querySelector('iframe');
          if (iframeEl) iframeEl.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
        },
        onStateChange: onMusicStateChange,
        onError: onMusicError,
      },
    });
  }

  musicState.lastUrl = raw;
  saveMusicState();
}

function onMusicStateChange(event) {
  const isPlaying = event.data === YT.PlayerState.PLAYING;
  dom.musicPlayPauseBtn.innerHTML = isPlaying
    ? '<i class="fa-solid fa-pause"></i>'
    : '<i class="fa-solid fa-play"></i>';
}

/** YouTube failed to load/play the video — explain why and offer a direct link instead */
function onMusicError(event) {
  const MESSAGES = {
    2: 'Link YouTube không hợp lệ.',
    5: 'Trình duyệt không hỗ trợ phát video này.',
    100: 'Video không tồn tại hoặc đã ở chế độ riêng tư.',
    101: 'Chủ video không cho phép nhúng (embed) video này.',
    150: 'Chủ video không cho phép nhúng (embed) video này.',
    153: 'YouTube chặn phát nhúng ở đây (thường do mở file trực tiếp thay vì qua máy chủ web, hoặc bị trình chặn quảng cáo chặn referrer).',
  };
  showToast(MESSAGES[event.data] || 'Không thể phát video này.', 'error');

  dom.musicControls.hidden = true;
  if (currentVideoId) {
    dom.musicFallbackLink.href = `https://www.youtube.com/watch?v=${currentVideoId}`;
    dom.musicFallbackLink.hidden = false;
  }
}

function toggleMusicPlayPause() {
  if (!ytPlayer) return;
  const state = ytPlayer.getPlayerState();
  if (state === YT.PlayerState.PLAYING) {
    ytPlayer.pauseVideo();
  } else {
    ytPlayer.playVideo();
  }
}

function toggleMusicMute() {
  if (!ytPlayer) return;
  if (ytPlayer.isMuted()) {
    ytPlayer.unMute();
    dom.musicMuteBtn.innerHTML = '<i class="fa-solid fa-volume-high"></i>';
  } else {
    ytPlayer.mute();
    dom.musicMuteBtn.innerHTML = '<i class="fa-solid fa-volume-xmark"></i>';
  }
}

function setMusicVolume(value) {
  musicState.volume = Number(value);
  saveMusicState();
  if (!ytPlayer) return;
  ytPlayer.setVolume(musicState.volume);
  dom.musicMuteBtn.innerHTML = musicState.volume === 0
    ? '<i class="fa-solid fa-volume-xmark"></i>'
    : '<i class="fa-solid fa-volume-high"></i>';
}

function removeMusic() {
  if (ytPlayer && typeof ytPlayer.destroy === 'function') {
    ytPlayer.destroy();
  }
  ytPlayer = null;
  currentVideoId = null;
  dom.musicControls.hidden = true;
  dom.musicEmptyState.style.display = 'block';
  dom.musicFallbackLink.hidden = true;
  dom.musicUrlInput.value = '';
  musicState.lastUrl = '';
  saveMusicState();
  dom.musicCard.classList.remove('floating');
  dom.musicMinimizeBtn.innerHTML = '<i class="fa-solid fa-compress"></i>';
}

function toggleMusicFloating() {
  const isFloating = dom.musicCard.classList.toggle('floating');
  dom.musicMinimizeBtn.innerHTML = isFloating
    ? '<i class="fa-solid fa-expand"></i>'
    : '<i class="fa-solid fa-compress"></i>';
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
  renderChart(); // refresh chart colors for new theme
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
  renderChart();
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
  renderChart();
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

  sessions = [];
  settings = { ...DEFAULT_SETTINGS };
  timerState = 'idle';
  sessionStartTs = null;
  pausedAtTs = null;
  totalPausedMs = 0;
  stopTickLoop();

  applySettingsToUI();
  updateTimerUI();
  dom.timerDisplay.textContent = '00:00:00';
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
  dom.goalInput.value = settings.dailyGoalHours;
}

/* ---------------- 11. Init & event wiring ---------------- */

function cacheDom() {
  const ids = [
    'currentDate', 'liveClock', 'soundToggleBtn', 'themeToggleBtn', 'settingsBtn',
    'timerCard', 'timerStatus', 'timerStatusText', 'timerDisplay',
    'btnStart', 'btnPause', 'btnResume', 'btnEnd',
    'statToday', 'statWeek', 'statMonth', 'statAll',
    'statSessionsToday', 'statLongest', 'statAverage',
    'goalInput', 'goalProgressFill', 'goalPercentText', 'goalRemainingText',
    'weekChart', 'logList', 'btnClearAll',
    'musicCard', 'musicMinimizeBtn', 'musicUrlInput', 'musicLoadBtn',
    'musicPlayerWrap', 'musicEmptyState', 'musicFallbackLink', 'musicControls',
    'musicPlayPauseBtn', 'musicMuteBtn', 'musicVolumeSlider', 'musicRemoveBtn',
    'settingsModal', 'closeSettingsBtn', 'accentColorInput', 'animationToggle',
    'exportBtn', 'importBtn', 'importInput', 'resetDataBtn',
    'confirmModal', 'confirmTitle', 'confirmMessage', 'confirmCancelBtn', 'confirmOkBtn',
    'toastContainer',
  ];
  ids.forEach((id) => { dom[id] = document.getElementById(id); });
}

function updateClockAndDate() {
  const now = new Date();
  dom.liveClock.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const weekday = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'][now.getDay()];
  dom.currentDate.textContent = `${weekday}, ${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
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

  dom.goalInput.addEventListener('input', () => {
    const hours = Math.max(0.5, Math.min(24, Number(dom.goalInput.value) || 4));
    settings.dailyGoalHours = hours;
    saveSettings();
    renderGoal(computeStats());
  });

  dom.btnClearAll.addEventListener('click', clearAllSessions);

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

  dom.musicLoadBtn.addEventListener('click', loadMusicFromInput);
  dom.musicUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadMusicFromInput();
  });
  dom.musicMinimizeBtn.addEventListener('click', toggleMusicFloating);
  dom.musicPlayPauseBtn.addEventListener('click', toggleMusicPlayPause);
  dom.musicMuteBtn.addEventListener('click', toggleMusicMute);
  dom.musicVolumeSlider.addEventListener('input', (e) => setMusicVolume(e.target.value));
  dom.musicRemoveBtn.addEventListener('click', removeMusic);

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
  loadMusicState();

  applySettingsToUI();
  if (musicState.lastUrl) dom.musicUrlInput.value = musicState.lastUrl;
  if (musicState.volume !== undefined) dom.musicVolumeSlider.value = musicState.volume;
  wireEvents();

  updateClockAndDate();
  clockIntervalId = setInterval(updateClockAndDate, 1000);

  restoreActiveSession();
  renderAll();
}

document.addEventListener('DOMContentLoaded', init);
