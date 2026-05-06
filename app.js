/* ===== Focusflow — Pomodoro Timer App ===== */

// ---- Sound Synthesis (Web Audio API) ----
class SoundEngine {
  constructor() {
    this.ctx = null;
    this.customSoundBuffer = null;
    this.customSoundUrl = null;
    this.tickingInterval = null;
    this.tickingGain = null;
  }

  _ensureCtx() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  playTone(freq, duration, type = 'sine', volume = 0.3) {
    const ctx = this._ensureCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  }

  playSynthSound(name) {
    switch (name) {
      case 'bell':
        this.playTone(830, 1.2, 'sine', 0.35);
        setTimeout(() => this.playTone(1050, 1.0, 'sine', 0.25), 200);
        setTimeout(() => this.playTone(1250, 0.8, 'sine', 0.2), 400);
        break;
      case 'chime':
        [523, 659, 784, 1047].forEach((f, i) => {
          setTimeout(() => this.playTone(f, 0.6, 'sine', 0.3), i * 150);
        });
        break;
      case 'ding':
        this.playTone(1200, 0.8, 'sine', 0.4);
        setTimeout(() => this.playTone(1200, 0.6, 'sine', 0.2), 300);
        break;
      case 'gong':
        this.playTone(180, 2.5, 'sine', 0.4);
        this.playTone(270, 2.0, 'triangle', 0.15);
        this.playTone(360, 1.5, 'sine', 0.1);
        break;
      case 'custom':
        this._playCustom();
        break;
      case 'none':
        break;
    }
  }

  async loadCustomSound(file) {
    const ctx = this._ensureCtx();
    const arrayBuffer = await file.arrayBuffer();
    this.customSoundBuffer = await ctx.decodeAudioData(arrayBuffer);
    this.customSoundUrl = URL.createObjectURL(file);
    // Save to localStorage as base64
    const reader = new FileReader();
    reader.onload = () => {
      try {
        localStorage.setItem('ff_custom_sound', reader.result);
        localStorage.setItem('ff_custom_sound_name', file.name);
      } catch (e) { /* storage full, ignore */ }
    };
    reader.readAsDataURL(file);
  }

  async loadCustomFromStorage() {
    const data = localStorage.getItem('ff_custom_sound');
    if (!data) return false;
    try {
      const ctx = this._ensureCtx();
      const resp = await fetch(data);
      const arrayBuffer = await resp.arrayBuffer();
      this.customSoundBuffer = await ctx.decodeAudioData(arrayBuffer);
      return true;
    } catch (e) {
      return false;
    }
  }

  _playCustom() {
    if (!this.customSoundBuffer) return;
    const ctx = this._ensureCtx();
    const source = ctx.createBufferSource();
    source.buffer = this.customSoundBuffer;
    source.connect(ctx.destination);
    source.start(0);
  }

  removeCustomSound() {
    this.customSoundBuffer = null;
    this.customSoundUrl = null;
    localStorage.removeItem('ff_custom_sound');
    localStorage.removeItem('ff_custom_sound_name');
  }

  startTicking(volume) {
    this.stopTicking();
    const vol = (volume / 100) * 0.1;
    this.tickingInterval = setInterval(() => {
      this.playTone(800, 0.03, 'square', vol);
    }, 1000);
  }

  stopTicking() {
    if (this.tickingInterval) {
      clearInterval(this.tickingInterval);
      this.tickingInterval = null;
    }
  }
}

// ---- Storage helpers ----
const storage = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('ff_' + key);
      return v !== null ? JSON.parse(v) : fallback;
    } catch { return fallback; }
  },
  set(key, val) {
    try { localStorage.setItem('ff_' + key, JSON.stringify(val)); } catch {}
  }
};

// ---- Web Worker Timer (resilient to iOS throttling) ----
let timerWorker = null;
function createTimerWorker() {
  if (timerWorker) timerWorker.terminate();
  const workerCode = `
    let intervalId = null;
    self.onmessage = function(e) {
      if (e.data === 'start') {
        if (intervalId) clearInterval(intervalId);
        intervalId = setInterval(() => self.postMessage('tick'), 1000);
      } else if (e.data === 'stop') {
        if (intervalId) { clearInterval(intervalId); intervalId = null; }
      }
    };
  `;
  try {
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    timerWorker = new Worker(URL.createObjectURL(blob));
    return timerWorker;
  } catch (e) {
    // Workers not supported — fallback to setInterval only
    return null;
  }
}

// ---- Wake Lock (keeps screen on during timer) ----
let wakeLock = null;
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) { /* wake lock failed — non-critical */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

// ---- App State ----
const state = {
  mode: 'focus', // 'focus' | 'short-break' | 'long-break'
  isRunning: false,
  timeRemaining: 25 * 60,
  totalTime: 25 * 60,
  completedSessions: 0,
  interval: null,
  sessionLabel: '',
  endTime: null,        // timestamp when timer should finish

  settings: {
    focusDuration: 25,
    shortBreakDuration: 5,
    longBreakDuration: 15,
    sessionsBeforeLong: 4,
    autoStartBreaks: false,
    autoStartFocus: false,
    browserNotifications: false,
    completionSound: 'bell',
    tickingEnabled: false,
    tickingVolume: 30,
  },

  sessions: [],   // { date, duration, label, timestamp }
  calendarYear: new Date().getFullYear(),
};

const sound = new SoundEngine();

// ---- DOM Elements ----
const $ = (id) => document.getElementById(id);

const dom = {
  timerDisplay: $('timer-display'),
  timerStatus: $('timer-status'),
  timerProgress: $('timer-progress'),
  btnStart: $('btn-start'),
  btnReset: $('btn-reset'),
  btnSkip: $('btn-skip'),
  playIcon: document.querySelector('.play-icon'),
  pauseIcon: document.querySelector('.pause-icon'),
  sessionLabel: $('session-label'),
  sessionCounter: $('session-counter'),
  statSessions: $('stat-sessions'),
  statHours: $('stat-hours'),
  statStreak: $('stat-streak'),
  calendarGrid: $('calendar-grid'),
  calendarMonths: $('calendar-months'),
  calYear: $('cal-year'),
  sessionsList: $('sessions-list'),
  tooltip: $('calendar-tooltip'),
};

// ---- Circumference for SVG ring ----
const CIRCUMFERENCE = 2 * Math.PI * 120; // r=120

// ---- Init ----
function init() {
  loadSettings();
  loadSessions();
  updateTimerDisplay();
  updateSessionCounter();
  renderCalendar();
  renderRecentSessions();
  updateTodayStats();
  setupEventListeners();
  loadCustomSoundUI();
  restoreTimerState();

  // Request notification permission if enabled
  if (state.settings.browserNotifications && 'Notification' in window) {
    Notification.requestPermission();
  }

  // ---- iOS / Background resilience ----
  // Recalculate timer from wall-clock whenever the app wakes up.
  // We use MULTIPLE events because iOS is inconsistent about which it fires.

  function handleAppResume() {
    if (!state.isRunning || !state.endTime) return;
    const remaining = Math.round((state.endTime - Date.now()) / 1000);
    if (remaining <= 0) {
      completeSession();
    } else {
      state.timeRemaining = remaining;
      updateTimerDisplay();
    }
  }

  function handleAppSuspend() {
    // Persist state so restoreTimerState works even after full process kill
    if (state.isRunning && state.endTime) {
      storage.set('timerState', {
        endTime: state.endTime,
        mode: state.mode,
        totalTime: state.totalTime,
        label: state.sessionLabel,
      });
    }
  }

  // visibilitychange — primary event, works on most browsers
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      handleAppResume();
      // Re-acquire wake lock (iOS releases it on hide)
      if (state.isRunning) requestWakeLock();
    } else {
      handleAppSuspend();
    }
  });

  // pageshow — more reliable on iOS Safari / PWA for back-forward cache
  window.addEventListener('pageshow', (e) => {
    handleAppResume();
    if (state.isRunning) requestWakeLock();
  });

  // focus — fires when the PWA window regains focus
  window.addEventListener('focus', () => {
    handleAppResume();
    if (state.isRunning) requestWakeLock();
  });

  // Re-acquire wake lock when screen turns back on
  if ('wakeLock' in navigator) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.isRunning) {
        requestWakeLock();
      }
    });
  }
}

// ---- Restore timer after app reopen ----
function restoreTimerState() {
  const saved = storage.get('timerState', null);
  if (!saved || !saved.endTime) {
    // Check if there's orphaned partial progress (app was killed while timer
    // was paused or in an unusual state)
    const orphan = storage.get('partialProgress', null);
    if (orphan && orphan.elapsed >= 5 && orphan.mode === 'focus') {
      // Credit the orphaned elapsed time
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      state.sessions.push({
        date: dateStr,
        duration: orphan.elapsed,
        label: orphan.label || 'Focus Session',
        timestamp: now.toISOString(),
      });
      saveSessions();
      updateTodayStats();
      renderCalendar();
      renderRecentSessions();
      storage.set('partialProgress', null);
    }
    return;
  }

  const remaining = Math.round((saved.endTime - Date.now()) / 1000);
  if (remaining <= 0) {
    // Timer expired while app was closed — record the full session
    storage.set('timerState', null);
    setMode(saved.mode);
    state.totalTime = saved.totalTime;
    state.sessionLabel = saved.label || '';
    dom.sessionLabel.value = state.sessionLabel;
    state.timeRemaining = 0;
    completeSession();
  } else {
    // Timer still running — resume it
    setMode(saved.mode);
    state.totalTime = saved.totalTime;
    state.timeRemaining = remaining;
    state.sessionLabel = saved.label || '';
    dom.sessionLabel.value = state.sessionLabel;
    updateTimerDisplay();
    startTimer();
  }
}

// ---- Settings Load / Save ----
function loadSettings() {
  const saved = storage.get('settings', null);
  if (saved) Object.assign(state.settings, saved);
  state.timeRemaining = state.settings.focusDuration * 60;
  state.totalTime = state.timeRemaining;

  // Populate UI
  $('focus-duration').value = state.settings.focusDuration;
  $('short-break-duration').value = state.settings.shortBreakDuration;
  $('long-break-duration').value = state.settings.longBreakDuration;
  $('sessions-before-long').value = state.settings.sessionsBeforeLong;
  $('auto-start-breaks').checked = state.settings.autoStartBreaks;
  $('auto-start-focus').checked = state.settings.autoStartFocus;
  $('browser-notifications').checked = state.settings.browserNotifications;
  $('ticking-enabled').checked = state.settings.tickingEnabled;
  $('ticking-volume').value = state.settings.tickingVolume;

  const soundRadio = document.querySelector(`input[name="completion-sound"][value="${state.settings.completionSound}"]`);
  if (soundRadio) soundRadio.checked = true;
}

function saveSettings() {
  state.settings.focusDuration = Math.max(1, Math.min(120, parseInt($('focus-duration').value) || 25));
  state.settings.shortBreakDuration = Math.max(1, Math.min(30, parseInt($('short-break-duration').value) || 5));
  state.settings.longBreakDuration = Math.max(1, Math.min(60, parseInt($('long-break-duration').value) || 15));
  state.settings.sessionsBeforeLong = Math.max(2, Math.min(10, parseInt($('sessions-before-long').value) || 4));
  state.settings.autoStartBreaks = $('auto-start-breaks').checked;
  state.settings.autoStartFocus = $('auto-start-focus').checked;
  state.settings.browserNotifications = $('browser-notifications').checked;
  state.settings.tickingEnabled = $('ticking-enabled').checked;
  state.settings.tickingVolume = parseInt($('ticking-volume').value);

  const soundRadio = document.querySelector('input[name="completion-sound"]:checked');
  state.settings.completionSound = soundRadio ? soundRadio.value : 'bell';

  storage.set('settings', state.settings);

  // Update timer if not running
  if (!state.isRunning) {
    setMode(state.mode);
  }
}

// ---- Sessions Load / Save ----
function loadSessions() {
  state.sessions = storage.get('sessions', []);
}

function saveSessions() {
  storage.set('sessions', state.sessions);
}

function addSession(durationSeconds) {
  if (durationSeconds < 5) return; // Ignore trivially short sessions (< 5 seconds)
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  state.sessions.push({
    date: dateStr,
    duration: durationSeconds,
    label: state.sessionLabel || 'Focus Session',
    timestamp: now.toISOString(),
  });
  saveSessions();
  updateTodayStats();
  renderCalendar();
  renderRecentSessions();
}

/**
 * Save any elapsed focus time as a partial session.
 * Called when the timer is reset, paused, or the app is being killed.
 * Only records if the mode is 'focus' and at least 5 seconds have elapsed.
 */
function savePartialProgress() {
  if (state.mode !== 'focus') return 0;
  let elapsed = 0;
  if (state.isRunning && state.endTime) {
    const actualRemaining = Math.max(0, Math.round((state.endTime - Date.now()) / 1000));
    elapsed = state.totalTime - actualRemaining;
  } else {
    elapsed = state.totalTime - state.timeRemaining;
  }
  if (elapsed >= 5) {
    addSession(elapsed);
  }
  return elapsed;
}

// ---- Timer Logic ----
function getDurationForMode(mode) {
  switch (mode) {
    case 'focus': return state.settings.focusDuration * 60;
    case 'short-break': return state.settings.shortBreakDuration * 60;
    case 'long-break': return state.settings.longBreakDuration * 60;
  }
}

function setMode(mode) {
  state.mode = mode;
  state.timeRemaining = getDurationForMode(mode);
  state.totalTime = state.timeRemaining;
  state.isRunning = false;
  clearInterval(state.interval);
  sound.stopTicking();

  // Update tab UI
  document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.mode-tab[data-mode="${mode}"]`).classList.add('active');

  // Update ring color
  const isBreak = mode !== 'focus';
  dom.timerProgress.classList.toggle('break-mode', isBreak);

  // Update status
  const statusMap = { focus: 'Ready to focus', 'short-break': 'Take a short break', 'long-break': 'Take a long break' };
  dom.timerStatus.textContent = statusMap[mode];

  updateTimerDisplay();
  updateStartButton(false);
}

function startTimer() {
  if (state.isRunning) {
    pauseTimer();
    return;
  }

  state.isRunning = true;
  state.endTime = Date.now() + state.timeRemaining * 1000;
  storage.set('timerState', {
    endTime: state.endTime,
    mode: state.mode,
    totalTime: state.totalTime,
    label: state.sessionLabel,
  });
  updateStartButton(true);

  const statusMap = { focus: 'Focusing...', 'short-break': 'On break...', 'long-break': 'On break...' };
  dom.timerStatus.textContent = statusMap[state.mode];

  if (state.settings.tickingEnabled && state.mode === 'focus') {
    sound.startTicking(state.settings.tickingVolume);
  }

  // Acquire Wake Lock to prevent screen sleep on iOS
  requestWakeLock();

  // Tick handler — always recalculates from wall-clock endTime
  const tickHandler = () => {
    if (!state.isRunning || !state.endTime) return;
    const remaining = Math.round((state.endTime - Date.now()) / 1000);
    state.timeRemaining = Math.max(0, remaining);
    if (state.timeRemaining <= 0) {
      completeSession();
    }
    updateTimerDisplay();
  };

  // Primary: setInterval (works when tab is active)
  state.interval = setInterval(tickHandler, 1000);

  // Secondary: Web Worker timer (survives iOS main-thread throttling)
  try {
    const worker = createTimerWorker();
    if (worker) {
      worker.onmessage = tickHandler;
      worker.postMessage('start');
    }
  } catch (e) { /* worker fallback failed — setInterval still running */ }
}

function pauseTimer() {
  state.isRunning = false;
  state.endTime = null;
  clearInterval(state.interval);
  if (timerWorker) { timerWorker.postMessage('stop'); }
  sound.stopTicking();
  releaseWakeLock();
  storage.set('timerState', null);
  updateStartButton(false);
  dom.timerStatus.textContent = 'Paused';
}

function resetTimer() {
  // Save any elapsed focus time before resetting
  if (state.isRunning || state.totalTime !== state.timeRemaining) {
    savePartialProgress();
  }

  state.isRunning = false;
  state.endTime = null;
  clearInterval(state.interval);
  if (timerWorker) { timerWorker.postMessage('stop'); }
  sound.stopTicking();
  releaseWakeLock();
  storage.set('timerState', null);
  state.timeRemaining = state.totalTime;
  updateTimerDisplay();
  updateStartButton(false);
  const statusMap = { focus: 'Ready to focus', 'short-break': 'Ready for break', 'long-break': 'Ready for break' };
  dom.timerStatus.textContent = statusMap[state.mode];
}

function skipSession() {
  completeSession();
}

function completeSession() {
  clearInterval(state.interval);
  if (timerWorker) { timerWorker.postMessage('stop'); }
  sound.stopTicking();
  releaseWakeLock();
  state.isRunning = false;
  storage.set('timerState', null);
  storage.set('partialProgress', null);

  // Play sound
  sound.playSynthSound(state.settings.completionSound);

  // Notify
  if (state.settings.browserNotifications && 'Notification' in window && Notification.permission === 'granted') {
    const title = state.mode === 'focus' ? 'Focus session complete!' : 'Break is over!';
    new Notification('Focusflow', { body: title, icon: '🍅' });
  }

  if (state.mode === 'focus') {
    const elapsed = state.totalTime - state.timeRemaining;
    addSession(elapsed > 0 ? elapsed : state.totalTime);
    state.completedSessions++;
    updateSessionCounter();

    // Decide next mode
    if (state.completedSessions % state.settings.sessionsBeforeLong === 0) {
      setMode('long-break');
    } else {
      setMode('short-break');
    }
    if (state.settings.autoStartBreaks) setTimeout(() => startTimer(), 500);
  } else {
    setMode('focus');
    if (state.settings.autoStartFocus) setTimeout(() => startTimer(), 500);
  }
}

// ---- UI Updates ----
function updateTimerDisplay() {
  const mins = Math.floor(state.timeRemaining / 60);
  const secs = state.timeRemaining % 60;
  dom.timerDisplay.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  // Update ring
  const progress = state.totalTime > 0 ? state.timeRemaining / state.totalTime : 1;
  const offset = CIRCUMFERENCE * (1 - progress);
  dom.timerProgress.style.strokeDasharray = CIRCUMFERENCE;
  dom.timerProgress.style.strokeDashoffset = offset;

  // Update page title
  document.title = `${dom.timerDisplay.textContent} — Focusflow`;
}

function updateStartButton(running) {
  dom.playIcon.classList.toggle('hidden', running);
  dom.pauseIcon.classList.toggle('hidden', !running);
}

function updateSessionCounter() {
  const total = state.settings.sessionsBeforeLong;
  const completed = state.completedSessions % total;
  let html = '';
  for (let i = 0; i < total; i++) {
    const cls = i < completed ? 'completed' : (i === completed && state.isRunning ? 'active' : '');
    html += `<span class="session-dot ${cls}"></span>`;
  }
  dom.sessionCounter.innerHTML = html;
}

function updateTodayStats() {
  const today = new Date().toISOString().slice(0, 10);
  const todaySessions = state.sessions.filter(s => s.date === today);
  const totalSec = todaySessions.reduce((a, s) => a + s.duration, 0);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);

  dom.statSessions.textContent = todaySessions.length;
  dom.statHours.textContent = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  // Streak
  let streak = 0;
  const d = new Date();
  while (true) {
    const ds = d.toISOString().slice(0, 10);
    if (state.sessions.some(s => s.date === ds)) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else {
      break;
    }
  }
  dom.statStreak.textContent = streak;
}

// ---- Calendar ----
function renderCalendar() {
  const year = state.calendarYear;
  dom.calYear.textContent = year;

  // Build data map: date -> total minutes
  const dataMap = {};
  state.sessions.forEach(s => {
    const mins = Math.round(s.duration / 60);
    dataMap[s.date] = (dataMap[s.date] || 0) + mins;
  });

  // Find max for scaling
  const vals = Object.values(dataMap);
  const maxMins = Math.max(...vals, 1);

  // Generate weeks
  const jan1 = new Date(year, 0, 1);
  const dec31 = new Date(year, 11, 31);
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // Start from the Sunday before Jan 1
  const start = new Date(jan1);
  start.setDate(start.getDate() - start.getDay());

  let html = '';
  const monthPositions = [];
  let lastMonth = -1;
  let weekIdx = 0;
  const d = new Date(start);

  while (d <= dec31 || d.getDay() !== 0) {
    if (d.getDay() === 0) {
      html += '<div class="calendar-week">';
      if (d.getMonth() !== lastMonth && d.getFullYear() === year) {
        monthPositions.push({ month: d.getMonth(), week: weekIdx });
        lastMonth = d.getMonth();
      }
      weekIdx++;
    }

    const dateStr = d.toISOString().slice(0, 10);
    const mins = dataMap[dateStr] || 0;
    let level = 0;
    if (mins > 0) {
      const ratio = mins / maxMins;
      if (ratio <= 0.25) level = 1;
      else if (ratio <= 0.5) level = 2;
      else if (ratio <= 0.75) level = 3;
      else level = 4;
    }

    const isFuture = d > today;
    const isToday = dateStr === todayStr;
    const isThisYear = d.getFullYear() === year;
    const classes = ['calendar-cell'];
    if (isFuture) classes.push('future');
    if (isToday) classes.push('today');

    if (isThisYear) {
      const hours = Math.floor(mins / 60);
      const m = mins % 60;
      const timeStr = hours > 0 ? `${hours}h ${m}m` : `${m}m`;
      html += `<div class="${classes.join(' ')}" data-level="${level}" data-date="${dateStr}" data-mins="${mins}" title="${dateStr}: ${timeStr}"></div>`;
    } else {
      html += `<div class="calendar-cell" data-level="0" style="visibility:hidden;"></div>`;
    }

    if (d.getDay() === 6) {
      html += '</div>';
    }

    d.setDate(d.getDate() + 1);
    if (d.getFullYear() > year && d.getDay() === 0) break;
  }

  dom.calendarGrid.innerHTML = html;

  // Month labels
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let monthHtml = '';
  const totalWeeks = weekIdx;
  monthPositions.forEach((mp, i) => {
    const nextWeek = i < monthPositions.length - 1 ? monthPositions[i + 1].week : totalWeeks;
    const span = nextWeek - mp.week;
    monthHtml += `<span style="flex:${span};">${monthNames[mp.month]}</span>`;
  });
  dom.calendarMonths.innerHTML = monthHtml;

  // Tooltip events
  dom.calendarGrid.querySelectorAll('.calendar-cell[data-date]').forEach(cell => {
    cell.addEventListener('mouseenter', showTooltip);
    cell.addEventListener('mouseleave', hideTooltip);
    cell.addEventListener('click', handleCellClick);
  });
}

function showTooltip(e) {
  const cell = e.target;
  const date = cell.dataset.date;
  const mins = parseInt(cell.dataset.mins) || 0;
  const hours = Math.floor(mins / 60);
  const m = mins % 60;
  const timeStr = mins > 0 ? (hours > 0 ? `${hours}h ${m}m` : `${m} min`) : 'No activity';

  const dateObj = new Date(date + 'T12:00:00');
  const dateStr = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  dom.tooltip.innerHTML = `<strong>${timeStr}</strong> on ${dateStr}`;
  dom.tooltip.classList.remove('hidden');

  const rect = cell.getBoundingClientRect();
  dom.tooltip.style.left = rect.left + rect.width / 2 - dom.tooltip.offsetWidth / 2 + 'px';
  dom.tooltip.style.top = rect.top - dom.tooltip.offsetHeight - 8 + 'px';
}

function hideTooltip() {
  dom.tooltip.classList.add('hidden');
}

function handleCellClick(e) {
  const cell = e.target;
  const date = cell.dataset.date;
  const mins = parseInt(cell.dataset.mins) || 0;
  const hours = Math.floor(mins / 60);
  const m = mins % 60;
  const timeStr = mins > 0 ? (hours > 0 ? `${hours}h ${m}m` : `${m} min`) : 'No activity';

  const dateObj = new Date(date + 'T12:00:00');
  const dateStr = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

  alert(`${dateStr}\n\nFocused Time: ${timeStr}`);
}

// ---- Recent Sessions ----
function renderRecentSessions() {
  const recent = [...state.sessions].reverse().slice(0, 10);
  if (recent.length === 0) {
    dom.sessionsList.innerHTML = '<p class="empty-state">No sessions yet. Start your first focus session!</p>';
    return;
  }

  let html = '';
  recent.forEach(s => {
    const mins = Math.round(s.duration / 60);
    const dateObj = new Date(s.timestamp);
    const timeStr = dateObj.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const dateStr = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    html += `
      <div class="session-entry">
        <div class="session-entry-icon">🎯</div>
        <div class="session-entry-body">
          <div class="session-entry-title">${escapeHtml(s.label)}</div>
          <div class="session-entry-meta">${dateStr} at ${timeStr}</div>
        </div>
        <div class="session-entry-duration">${mins}m</div>
      </div>`;
  });
  dom.sessionsList.innerHTML = html;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---- Custom Sound UI ----
function loadCustomSoundUI() {
  const name = localStorage.getItem('ff_custom_sound_name');
  if (name) {
    $('custom-sound-info').classList.remove('hidden');
    $('custom-sound-name').textContent = name;
    $('custom-sound-option').style.display = '';
    sound.loadCustomFromStorage();
  }
}

// ---- Panel toggles ----
function togglePanel(panelId, overlayId, show) {
  const panel = $(panelId);
  const overlay = $(overlayId);
  if (show) {
    panel.classList.remove('hidden');
    overlay.classList.remove('hidden');
  } else {
    panel.classList.add('hidden');
    overlay.classList.add('hidden');
  }
}

// ---- Event Listeners ----
function setupEventListeners() {
  // Timer controls
  dom.btnStart.addEventListener('click', startTimer);
  dom.btnReset.addEventListener('click', resetTimer);
  dom.btnSkip.addEventListener('click', skipSession);

  // Mode tabs
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (state.isRunning) {
        if (!confirm('Timer is running. Switch mode?')) return;
        savePartialProgress();
        clearInterval(state.interval);
        sound.stopTicking();
        storage.set('timerState', null);
      }
      setMode(tab.dataset.mode);
    });
  });

  // Session label
  dom.sessionLabel.addEventListener('input', () => {
    state.sessionLabel = dom.sessionLabel.value.trim();
  });

  // Settings panel
  $('settings-toggle').addEventListener('click', () => togglePanel('settings-panel', 'settings-overlay', true));
  $('settings-close').addEventListener('click', () => { saveSettings(); togglePanel('settings-panel', 'settings-overlay', false); });
  $('settings-overlay').addEventListener('click', () => { saveSettings(); togglePanel('settings-panel', 'settings-overlay', false); });

  // Sounds panel
  $('sounds-toggle').addEventListener('click', () => togglePanel('sounds-panel', 'sounds-overlay', true));
  $('sounds-close').addEventListener('click', () => { saveSettings(); togglePanel('sounds-panel', 'sounds-overlay', false); });
  $('sounds-overlay').addEventListener('click', () => { saveSettings(); togglePanel('sounds-panel', 'sounds-overlay', false); });

  // Steppers
  document.querySelectorAll('.stepper-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.target);
      const dir = parseInt(btn.dataset.dir);
      const min = parseInt(input.min);
      const max = parseInt(input.max);
      let val = parseInt(input.value) + dir;
      val = Math.max(min, Math.min(max, val));
      input.value = val;
    });
  });

  // Browser notifications toggle
  $('browser-notifications').addEventListener('change', (e) => {
    if (e.target.checked && 'Notification' in window) {
      Notification.requestPermission();
    }
  });

  // Sound preview
  document.querySelectorAll('.preview-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      sound.playSynthSound(btn.dataset.sound);
    });
  });

  // Custom sound upload
  $('custom-sound-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await sound.loadCustomSound(file);
    $('custom-sound-info').classList.remove('hidden');
    $('custom-sound-name').textContent = file.name;
    $('custom-sound-option').style.display = '';
    // Select custom radio
    document.querySelector('input[name="completion-sound"][value="custom"]').checked = true;
    saveSettings();
  });

  $('remove-custom-sound').addEventListener('click', () => {
    sound.removeCustomSound();
    $('custom-sound-info').classList.add('hidden');
    $('custom-sound-option').style.display = 'none';
    // Switch to bell
    document.querySelector('input[name="completion-sound"][value="bell"]').checked = true;
    saveSettings();
  });

  // Calendar nav
  $('cal-prev').addEventListener('click', () => {
    state.calendarYear--;
    renderCalendar();
  });
  $('cal-next').addEventListener('click', () => {
    state.calendarYear++;
    renderCalendar();
  });

  // Clear history
  $('clear-history').addEventListener('click', () => {
    if (confirm('Clear all session history?')) {
      state.sessions = [];
      saveSessions();
      renderRecentSessions();
      renderCalendar();
      updateTodayStats();
    }
  });

  // Sound radios - save on change
  document.querySelectorAll('input[name="completion-sound"]').forEach(r => {
    r.addEventListener('change', saveSettings);
  });

  // Ticking toggle
  $('ticking-enabled').addEventListener('change', saveSettings);
  $('ticking-volume').addEventListener('input', saveSettings);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); startTimer(); }
    if (e.code === 'KeyR') resetTimer();
  });
}

// ---- Boot ----
document.addEventListener('DOMContentLoaded', init);

// ---- Persist partial progress when app is being killed ----
// pagehide is more reliable than beforeunload on iOS Safari / PWAs
window.addEventListener('pagehide', () => {
  if (state.mode === 'focus') {
    let elapsed = 0;
    if (state.isRunning && state.endTime) {
      const actualRemaining = Math.max(0, Math.round((state.endTime - Date.now()) / 1000));
      elapsed = state.totalTime - actualRemaining;
    } else {
      elapsed = state.totalTime - state.timeRemaining;
    }
    
    if (elapsed >= 5) {
      storage.set('partialProgress', {
        elapsed: elapsed,
        mode: state.mode,
        label: state.sessionLabel,
        timestamp: new Date().toISOString(),
      });
    }
  }
});

window.addEventListener('beforeunload', () => {
  if (state.mode === 'focus') {
    let elapsed = 0;
    if (state.isRunning && state.endTime) {
      const actualRemaining = Math.max(0, Math.round((state.endTime - Date.now()) / 1000));
      elapsed = state.totalTime - actualRemaining;
    } else {
      elapsed = state.totalTime - state.timeRemaining;
    }
    
    if (elapsed >= 5) {
      storage.set('partialProgress', {
        elapsed: elapsed,
        mode: state.mode,
        label: state.sessionLabel,
        timestamp: new Date().toISOString(),
      });
    }
  }
});

// ---- Service Worker Registration ----
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
