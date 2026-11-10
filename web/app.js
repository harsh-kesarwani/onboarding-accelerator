/**
 * Adobe AI Assistant — app.js
 *
 * Organized into top-level sections; each section has a single concern.
 * External deps (global from CDN): marked, DOMPurify, mermaid.
 *
 * Sections:
 *   §1  DOM refs
 *   §2  Constants
 *   §3  Storage helpers
 *   §4  Utility helpers
 *   §5  Icon library (Lucide subset)
 *   §6  Avatar factory
 *   §7  Theme management
 *   §8  Third-party setup (marked, mermaid)
 *   §9  Suggestions & personalization (HTTP)
 *  §10  Chat session
 *  §11  Markdown decoration (code blocks, links, mermaid)
 *  §12  Message rendering
 *  §13  Welcome / quiz / prompt loader
 *  §14  Form + keyboard wiring
 *  §15  Boot
 */

(function () {
  'use strict';

  // ==========================================================================
  // §1  DOM refs
  // ==========================================================================
  const form            = document.getElementById('chat-form');
  const input           = document.getElementById('input');
  const sendBtn         = document.getElementById('send-btn');
  const messagesEl      = document.getElementById('messages');
  const newChatBtn      = document.getElementById('new-chat-btn');
  const themeGroup      = document.getElementById('theme-toggle');
  const scrollLatestBtn = document.getElementById('scroll-to-latest');
  const sidebarToggle   = document.querySelector('.sidebar-toggle');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');
  const followupRow     = document.getElementById('followup-row');


  // ==========================================================================
  // §2  Constants
  // ==========================================================================
  const STORAGE = {
    theme:    'adobe_theme',
    session:  'adobe_chat_session_id',
    profile:  'adobe_chat_profile',
    prompts:  'adobe_chat_prompts',
  };

  const MAX_INPUT_HEIGHT_PX = 200;    // ~8 lines at 15px/line-height 1.5
  const COPIED_RESET_MS     = 1200;

  /** Default starter prompts (used until /suggestions responds). */
  const FALLBACK_PROMPTS = [
    { icon: 'rocket',   text: 'Walk me through the Falcons dev onboarding and workstation setup' },
    { icon: 'network',  text: 'Explain the Quota Enforcement Service architecture' },
    { icon: 'users',    text: 'How do I onboard as a QES dev?' },
  ];

  /** Maps emoji hints (from the backend) to Lucide icon names. */
  const EMOJI_TO_ICON = {
    '🦅':    'rocket',
    '🏗️':  'network',
    '🏗':    'network',
    '🧑‍💻': 'users',
    '👥':    'users',
    '📚':    'book-open',
    '💬':    'message-square',
    '✨':    'sparkles',
    '🔧':    'wrench',
    '⚙️':    'wrench',
    '🚀':    'rocket',
  };

  const QUIZ_STEPS = [
    {
      key: 'experience',
      title: 'How much software engineering experience do you have?',
      options: ['New grad / <1 year', '1–3 years', '3–7 years', '7+ years'],
    },
    {
      key: 'tech_side',
      title: 'Which side of the stack do you focus on?',
      options: ['Frontend', 'Backend', 'Fullstack', 'Other (SRE / Data / ML)'],
    },
    {
      key: 'tenure',
      title: 'Are you new to Adobe or moving internally?',
      options: ['New hire at Adobe', 'Internal mobility (moving teams)'],
    },
  ];


  // ==========================================================================
  // §3  Storage helpers (fail-soft)
  // ==========================================================================
  const storage = {
    get(key, fallback = null) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : v;
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); } catch { /* ignore */ }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
    },
    getJSON(key, fallback = null) {
      try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
      catch { return fallback; }
    },
    setJSON(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
    },
  };


  // ==========================================================================
  // §4  Utility helpers
  // ==========================================================================
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function uuid() {
    return (crypto.randomUUID && crypto.randomUUID())
      || (Date.now().toString(36) + Math.random().toString(36).slice(2));
  }

  function scrollToEnd() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /**
   * Lightbox for expanded mermaid diagrams.
   *
   * Supports: click-to-open, zoom in/out/reset, pinch-zoom (wheel),
   * drag-to-pan, backdrop/Esc to close.
   */
  const Lightbox = (() => {
    const root  = document.getElementById('lightbox');
    if (!root) return { open() {}, close() {} };

    const stage = document.getElementById('lightbox-stage');
    const zoomLabel = document.getElementById('lightbox-zoom');

    const ZOOM_MIN = 0.25;
    const ZOOM_MAX = 4;
    const ZOOM_STEP = 0.2;

    let scale = 1;
    let pan = { x: 0, y: 0 };
    let dragging = null; // { startX, startY, origX, origY }

    function applyTransform() {
      const svg = stage.querySelector('svg');
      if (!svg) return;
      svg.style.transform =
        `translate(${pan.x}px, ${pan.y}px) scale(${scale})`;
      zoomLabel.textContent = Math.round(scale * 100) + '%';
    }

    function setScale(next) {
      scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
      applyTransform();
    }

    function reset() {
      scale = 1;
      pan = { x: 0, y: 0 };
      applyTransform();
    }

    function open(sourceSvg) {
      if (!sourceSvg) return;
      stage.innerHTML = '';
      const clone = sourceSvg.cloneNode(true);
      clone.removeAttribute('style');
      stage.appendChild(clone);
      root.classList.add('active');
      root.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      reset();
    }

    function close() {
      root.classList.remove('active');
      root.setAttribute('aria-hidden', 'true');
      stage.innerHTML = '';
      document.body.style.overflow = '';
    }

    // Toolbar actions
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-lightbox-close]')) {
        close();
        return;
      }
      const action = e.target.closest('[data-lightbox-action]')?.dataset.lightboxAction;
      if (action === 'zoom-in')  setScale(scale + ZOOM_STEP);
      if (action === 'zoom-out') setScale(scale - ZOOM_STEP);
      if (action === 'reset')    reset();
    });

    // Scroll wheel zoom
    stage.addEventListener('wheel', (e) => {
      if (!root.classList.contains('active')) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
      setScale(scale + delta);
    }, { passive: false });

    // Drag to pan
    stage.addEventListener('pointerdown', (e) => {
      if (!stage.querySelector('svg')) return;
      dragging = { startX: e.clientX, startY: e.clientY, origX: pan.x, origY: pan.y };
      stage.setPointerCapture(e.pointerId);
      stage.style.cursor = 'grabbing';
    });
    stage.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      pan = {
        x: dragging.origX + (e.clientX - dragging.startX),
        y: dragging.origY + (e.clientY - dragging.startY),
      };
      applyTransform();
    });
    stage.addEventListener('pointerup', () => {
      dragging = null;
      stage.style.cursor = '';
    });

    // Esc to close
    document.addEventListener('keydown', (e) => {
      if (!root.classList.contains('active')) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === '+' || e.key === '=') setScale(scale + ZOOM_STEP);
      else if (e.key === '-' || e.key === '_') setScale(scale - ZOOM_STEP);
      else if (e.key === '0') reset();
    });

    return { open, close };
  })();

  /**
   * Indeterminate progress bar at the top of the viewport.
   * Reference-counted so overlapping requests don't flash off.
   */
  const TopProgress = (() => {
    let el = null;
    let count = 0;

    function ensure() {
      if (el) return;
      el = document.createElement('div');
      el.className = 'top-progress';
      el.innerHTML = '<div class="top-progress-bar"></div>';
      document.body.appendChild(el);
    }
    return {
      start() {
        ensure();
        count += 1;
        el.classList.add('active');
      },
      stop() {
        count = Math.max(0, count - 1);
        if (count === 0 && el) el.classList.remove('active');
      },
      /** Wrap a promise-returning function with start/stop. */
      async wrap(fn) {
        this.start();
        try { return await fn(); }
        finally { this.stop(); }
      },
    };
  })();


  // ==========================================================================
  // §5  Icon library (Lucide subset)
  // ==========================================================================
  /** Inline Lucide SVG paths — keeps chip icons themeable via `currentColor`. */
  const ICONS = Object.freeze({
    rocket:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>',
    'git-branch':
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
    'book-open':
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
    network:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/></svg>',
    users:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    sparkles:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/><path d="M19 3v4"/><path d="M21 5h-4"/></svg>',
    'message-square':
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    wrench:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
    copy:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    check:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    'chevron-down':
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    'arrow-up':
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
  });

  /** Returns SVG markup for a known icon name, falling back to sparkles. */
  function iconSVG(name) {
    return ICONS[name] || ICONS.sparkles;
  }

  /**
   * Resolves a chip's `icon` field (from the backend) to rendered markup.
   * Accepts a Lucide icon name, a mapped emoji, or a raw text string.
   */
  function resolveChipIcon(iconField) {
    if (!iconField) return iconSVG('sparkles');
    if (ICONS[iconField]) return iconSVG(iconField);
    if (EMOJI_TO_ICON[iconField]) return iconSVG(EMOJI_TO_ICON[iconField]);
    return `<span>${escapeHtml(iconField)}</span>`;
  }


  // ==========================================================================
  // §6  Avatar factory
  // ==========================================================================
  const ADOBE_A_PATH = 'M42.5 0h155L240 234h-57l-13-33H70.5l-13 33H0L42.5 0zm42 142h71l-35.5-89-35.5 89z';

  /** Returns the markup for the layered-hex bot avatar. */
  function assistantAvatarHTML(size = 'md') {
    const cls = size === 'lg' ? 'avatar-adobe avatar-adobe--lg' : 'avatar-adobe';
    return `
      <div class="${cls}" aria-hidden="true">
        <svg viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg">
          <polygon points="22,6 34,13 34,27 22,34 10,27 10,13" fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.35" transform="rotate(8,22,22)"/>
          <polygon points="22,8 33,14.5 33,27.5 22,34 11,27.5 11,14.5" fill="currentColor"/>
          <polygon points="22,14 28,17.5 28,24.5 22,28 16,24.5 16,17.5" fill="var(--avatar-hex-bg, #1a1a2e)"/>
          <circle cx="22" cy="22" r="3.5" fill="currentColor"/>
          <circle cx="22" cy="22" r="1.5" fill="#fff"/>
          <line x1="22" y1="17" x2="22" y2="15.5" stroke="#fff" stroke-width="1" opacity="0.85"/>
          <line x1="22" y1="27" x2="22" y2="28.5" stroke="#fff" stroke-width="1" opacity="0.85"/>
          <line x1="17" y1="22" x2="15.5" y2="22" stroke="#fff" stroke-width="1" opacity="0.85"/>
          <line x1="27" y1="22" x2="28.5" y2="22" stroke="#fff" stroke-width="1" opacity="0.85"/>
        </svg>
      </div>`;
  }


  // ==========================================================================
  // §7  Theme management — binary light/dark
  //
  //   On first visit (no stored pref), we auto-detect OS preference once
  //   and persist that choice. After that, the user's explicit toggle wins.
  // ==========================================================================
  const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');

  /** Applies the pref to <html> and syncs the toggle UI + mermaid theme. */
  function applyTheme(pref) {
    const isDark = pref === 'dark';
    document.documentElement.classList.toggle('dark', isDark);
    document.documentElement.setAttribute('data-theme', pref);

    if (themeGroup) {
      themeGroup.querySelectorAll('button').forEach(b => {
        const on = b.dataset.theme === pref;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    }

    try {
      mermaid.initialize(mermaidConfig(isDark));
      rerenderMermaidBlocks();
    } catch { /* mermaid not ready yet */ }
  }

  /** Re-renders all already-displayed mermaid diagrams with the current theme. */
  async function rerenderMermaidBlocks() {
    const blocks = document.querySelectorAll('.mermaid-block[data-source]');
    for (const holder of blocks) {
      const source = holder.dataset.source;
      if (!source) continue;
      const id = 'mermaid-' + (++mermaidCounter);
      try {
        const { svg } = await mermaid.render(id, source);
        holder.innerHTML = svg + MERMAID_EXPAND_HINT;
      } catch { /* keep existing render on error */ }
    }
  }

  /** Mermaid config tuned to our design system (Inter, Zinc, Adobe red). */
  function mermaidConfig(isDark) {
    const fg       = isDark ? '#d4d4d8' : '#18181b';
    const surface  = isDark ? '#1f1f22' : '#ffffff';
    const surface2 = isDark ? '#27272a' : '#f4f4f5';
    const border   = isDark ? '#3f3f46' : '#d4d4d8';
    const line     = isDark ? '#8a8a92' : '#a1a1aa';

    return {
      startOnLoad: false,
      securityLevel: 'loose',
      theme: 'base',
      themeVariables: {
        darkMode:           isDark,
        fontFamily: '"Inter", ui-sans-serif, system-ui, sans-serif',
        fontSize: '14px',
        background:         surface,
        primaryColor:       surface,
        primaryTextColor:   fg,
        primaryBorderColor: border,
        secondaryColor:     surface2,
        secondaryTextColor: fg,
        secondaryBorderColor: border,
        tertiaryColor:      surface,
        tertiaryTextColor:  fg,
        tertiaryBorderColor: border,
        lineColor:          line,
        textColor:          fg,
        edgeLabelBackground: surface2,
        noteBkgColor:       surface2,
        noteBorderColor:    border,
        noteTextColor:      fg,
        actorBkg:           surface,
        actorTextColor:     fg,
        actorBorder:        border,
        clusterBkg:         surface2,
        clusterBorder:      border,
        fillType0:          surface,
        fillType1:          surface2,
      },
      flowchart: {
        curve: 'basis',
        nodeSpacing: 44,
        rankSpacing: 54,
        padding: 14,
        htmlLabels: true,
        useMaxWidth: true,
      },
      sequence: {
        actorMargin: 50,
        messageMargin: 40,
        useMaxWidth: true,
      },
      gantt: { useMaxWidth: true },
    };
  }

  /** Persists preference + applies the theme (with View Transitions). */
  function setTheme(pref) {
    storage.set(STORAGE.theme, pref);
    if (document.startViewTransition) {
      document.startViewTransition(() => applyTheme(pref));
    } else {
      applyTheme(pref);
    }
  }

  function initThemeToggle() {
    let current = storage.get(STORAGE.theme);
    if (current !== 'light' && current !== 'dark') {
      current = darkMQ.matches ? 'dark' : 'light';
      storage.set(STORAGE.theme, current);
    }
    applyTheme(current);

    if (themeGroup) {
      themeGroup.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-theme]');
        if (btn) setTheme(btn.dataset.theme);
      });
    }
  }


  // ==========================================================================
  // §8  Third-party setup
  // ==========================================================================
  marked.setOptions({ breaks: true, gfm: true });
  mermaid.initialize(mermaidConfig(document.documentElement.classList.contains('dark')));


  // ==========================================================================
  // §9  Suggestions & personalization (HTTP)
  // ==========================================================================
  /** Module state shared by welcome rendering. */
  const state = {
    starterPrompts: [],
    teamName: 'Adobe',
    sessionId: null,
  };

  async function loadSuggestions() {
    try {
      const res = await fetch('/suggestions');
      const data = await res.json();
      state.starterPrompts = (data.starter_prompts?.length)
        ? data.starter_prompts
        : FALLBACK_PROMPTS;
      if (data.team) state.teamName = data.team;
    } catch {
      state.starterPrompts = FALLBACK_PROMPTS;
    }
  }

  let _adobeFacts = [];
  (async function prefetchFacts() {
    try {
      const res = await fetch('/facts');
      const data = await res.json();
      if (Array.isArray(data.facts) && data.facts.length) _adobeFacts = data.facts;
    } catch { /* non-critical */ }
  })();

  async function personalize(profile) {
    return TopProgress.wrap(async () => {
      const res = await fetch('/personalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: state.sessionId, ...profile }),
      });
      const data = await res.json();
      return data.starter_prompts || [];
    });
  }


  // ==========================================================================
  // §10  Chat session
  // ==========================================================================
  const profile = {
    get()   { return storage.getJSON(STORAGE.profile); },
    set(p)  { storage.setJSON(STORAGE.profile, p); },
    clear() { storage.remove(STORAGE.profile); storage.remove(STORAGE.prompts); },
  };
  const promptsCache = {
    get() { return storage.getJSON(STORAGE.prompts); },
    set(p) { storage.setJSON(STORAGE.prompts, p); },
  };

  function ensureSessionId() {
    let sid = storage.get(STORAGE.session);
    if (!sid) {
      sid = uuid();
      storage.set(STORAGE.session, sid);
    }
    return sid;
  }


  // ==========================================================================
  // §11  Markdown decoration
  // ==========================================================================
  let mermaidCounter = 0;

  /** Hint pill markup shown in the top-right of a mermaid block on hover. */
  const MERMAID_EXPAND_HINT = `
    <span class="expand-hint" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="15 3 21 3 21 9"/>
        <polyline points="9 21 3 21 3 15"/>
        <line x1="21" y1="3" x2="14" y2="10"/>
        <line x1="3" y1="21" x2="10" y2="14"/>
      </svg>
      Click to enlarge
    </span>`;

  async function renderMermaidIn(container) {
    const codes = container.querySelectorAll('pre > code.language-mermaid');
    for (const code of codes) {
      const id = 'mermaid-' + (++mermaidCounter);
      try {
        const { svg } = await mermaid.render(id, code.textContent);
        const holder = document.createElement('div');
        holder.className = 'mermaid-block';
        holder.dataset.source = code.textContent;
        holder.innerHTML = svg + MERMAID_EXPAND_HINT;
        holder.setAttribute('role', 'button');
        holder.setAttribute('tabindex', '0');
        holder.setAttribute('aria-label', 'Expand diagram');
        holder.addEventListener('click', () => Lightbox.open(holder.querySelector('svg')));
        holder.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            Lightbox.open(holder.querySelector('svg'));
          }
        });
        code.parentElement.replaceWith(holder);
      } catch (err) {
        const holder = document.createElement('div');
        holder.className = 'mermaid-block';
        holder.style.color = 'var(--accent-default)';
        holder.style.cursor = 'default';
        holder.textContent = 'Diagram render error: ' + err.message;
        code.parentElement.replaceWith(holder);
      }
    }
  }

  /**
   * Wraps every <pre> with a header (language badge + copy button) and
   * attaches click-to-copy behavior. Idempotent via `data-decorated`.
   */
  function decorateCodeBlocks(container) {
    container.querySelectorAll('pre').forEach(pre => {
      if (pre.dataset.decorated) return;
      pre.dataset.decorated = '1';

      const code  = pre.querySelector('code');
      const match = code?.className?.match(/language-([\w-]+)/);
      const lang  = match ? match[1] : 'text';

      const header = document.createElement('div');
      header.className = 'pre-header';
      header.innerHTML = `
        <span class="pre-lang">${escapeHtml(lang)}</span>
        <button type="button" class="copy-btn" aria-label="Copy code">
          ${iconSVG('copy')}<span class="copy-label">Copy</span>
        </button>
      `;
      pre.insertBefore(header, code);

      const copyBtn = header.querySelector('.copy-btn');
      const label   = header.querySelector('.copy-label');
      copyBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const text = code?.textContent ?? pre.textContent;
        try {
          await navigator.clipboard.writeText(text);
          copyBtn.innerHTML = `${iconSVG('check')}<span class="copy-label">Copied</span>`;
          setTimeout(() => {
            copyBtn.innerHTML = `${iconSVG('copy')}<span class="copy-label">Copy</span>`;
          }, COPIED_RESET_MS);
        } catch { /* clipboard denied */ }
      });
    });
  }

  function upgradeLinks(container) {
    container.querySelectorAll('a').forEach(a => {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    });
  }


  // ==========================================================================
  // §12  Message rendering
  //      User   → right-aligned tinted bubble, no avatar.
  //      Assist → monogram avatar + "Adobe AI" label + borderless prose.
  // ==========================================================================
  function makeUserRow() {
    const wrapper = document.createElement('div');
    wrapper.className = 'msg msg-user';
    const bubble = document.createElement('div');
    bubble.className = 'bubble bubble-u';
    wrapper.appendChild(bubble);
    return { wrapper, bubble };
  }

  function makeAssistantRow() {
    const wrapper = document.createElement('div');
    wrapper.className = 'msg msg-assistant';
    wrapper.innerHTML = `
      <div class="msg-avatar-col">${assistantAvatarHTML('md')}</div>
      <div class="msg-content">
        <div class="bubble bubble-a"></div>
      </div>
    `;
    const bubble = wrapper.querySelector('.bubble');
    return { wrapper, bubble };
  }

  /**
   * Prepends a strip of tool-use status chips to an assistant bubble.
   * Expected shape for each entry: { name?, label?, status? }.
   */
  function renderToolChips(bubble, toolUses) {
    if (!Array.isArray(toolUses) || toolUses.length === 0) return;
    const strip = document.createElement('div');
    strip.className = 'tool-chips';
    toolUses.forEach(tu => {
      const chip = document.createElement('span');
      chip.className = 'tool-chip';
      const label = tu.label || tu.name || 'Tool';
      chip.innerHTML = `${iconSVG('check')}<span>${escapeHtml(label)}</span>`;
      strip.appendChild(chip);
    });
    bubble.prepend(strip);
  }

  function addUserMessage(text) {
    clearWelcome();
    const { wrapper, bubble } = makeUserRow();
    bubble.textContent = text;
    // Enable the bottom scroll-buffer so the new question has somewhere to
    // scroll into. The buffer collapses again once the assistant replies.
    messagesEl.classList.add('awaiting-answer');
    messagesEl.appendChild(wrapper);
    // Scroll the new question to the top of the visible viewport (like
    // Claude / ChatGPT), so the previous answer is pushed out of view.
    // Wait for layout to settle so the ::after scroll-buffer is measured,
    // then write scrollTop directly (more reliable than scrollIntoView).
    requestAnimationFrame(() => {
      const target =
        messagesEl.scrollTop +
        wrapper.getBoundingClientRect().top -
        messagesEl.getBoundingClientRect().top;
      messagesEl.scrollTo({ top: target, behavior: 'smooth' });
    });
  }

  function addAssistantMessage(markdown, { toolUses, suggestions } = {}) {
    clearWelcome();
    const { wrapper, bubble } = makeAssistantRow();
    const rendered = marked.parse(markdown);
    bubble.innerHTML = DOMPurify.sanitize(rendered, { ADD_ATTR: ['target', 'rel'] });
    upgradeLinks(bubble);
    decorateCodeBlocks(bubble);
    renderMermaidIn(bubble);
    renderToolChips(bubble, toolUses);
    messagesEl.appendChild(wrapper);
    // The answer is here — drop the bottom scroll-buffer so we don't leave
    // a giant empty area below the latest reply.
    messagesEl.classList.remove('awaiting-answer');

    // Gradual unfold of the answer (block-by-block fade + slight rise),
    // followed by the suggestion chips once the content has settled.
    const totalRevealMs = revealBubbleContent(bubble);

    if (suggestions?.length && followupRow) {
      followupRow.innerHTML = '';
      suggestions.forEach(q => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'followup-btn';
        btn.textContent = q;
        btn.addEventListener('click', () => {
          followupRow.hidden = true;
          followupRow.innerHTML = '';
          submitQuestion(q);
        });
        followupRow.appendChild(btn);
      });
      // Show the follow-ups in sync with (slightly after) the last revealed block
      followupRow.hidden = false;
      followupRow.classList.add('followup-row--revealing');
      followupRow.style.transitionDelay = `${totalRevealMs}ms`;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          followupRow.classList.add('followup-row--revealed');
        });
      });
      // Clear the inline delay & helper classes after the transition finishes,
      // so subsequent renders start from a clean slate.
      setTimeout(() => {
        followupRow.classList.remove('followup-row--revealing', 'followup-row--revealed');
        followupRow.style.transitionDelay = '';
      }, totalRevealMs + 600);
    }
  }

  /**
   * Stagger-reveals the top-level blocks inside an assistant bubble so the
   * answer "unfolds" instead of slamming onto the screen all at once.
   * Returns the total ms until the last block has started its transition,
   * so callers can chain follow-up UI (suggestion chips, etc.).
   */
  function revealBubbleContent(bubble) {
    const prefersReducedMotion =
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) return 0;

    // Collect units to stagger: each top-level child, but for lists we descend
    // to <li> level so bullets appear one by one (matches Claude/ChatGPT feel).
    const units = [];
    Array.from(bubble.children).forEach(child => {
      const tag = child.tagName.toLowerCase();
      if (tag === 'ul' || tag === 'ol') {
        const items = Array.from(child.children).filter(
          c => c.tagName.toLowerCase() === 'li',
        );
        if (items.length > 0) {
          units.push(...items);
          return;
        }
      }
      units.push(child);
    });

    if (units.length === 0) return 0;

    const stride = 180;           // ms between successive blocks (calmer pacing)
    const capTotalMs = 4500;      // never make the user wait longer than this
    const effectiveStride =
      units.length * stride > capTotalMs ? Math.max(55, capTotalMs / units.length) : stride;

    units.forEach((el, i) => {
      el.classList.add('reveal-unit');
      el.style.transitionDelay = `${Math.round(i * effectiveStride)}ms`;
    });

    // Two RAFs: first paints the initial hidden state, second triggers transition.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        units.forEach(el => el.classList.add('reveal-unit--in'));
      });
    });

    // Cleanup inline delays once everything has settled, so future re-layouts
    // (theme switch, etc.) don't carry stale transition-delay values.
    const totalMs = Math.round((units.length - 1) * effectiveStride) + 800;
    setTimeout(() => {
      units.forEach(el => {
        el.style.transitionDelay = '';
        el.classList.remove('reveal-unit', 'reveal-unit--in');
      });
    }, totalMs + 200);

    return totalMs;
  }

  /** Cycling Adobe facts while waiting for the assistant response. */
  function addThinkingIndicator() {
    const { wrapper, bubble } = makeAssistantRow();

    const facts = _adobeFacts.length ? _adobeFacts : null;
    let factIndex = facts ? Math.floor(Math.random() * facts.length) : 0;

    if (facts) {
      bubble.innerHTML = `
        <span class="fact-ticker">
          <span class="fact-ticker__label">Did you know?</span>
          <span class="fact-ticker__body">
            <span class="fact-ticker__text">${DOMPurify.sanitize(facts[factIndex])}</span>
            <span class="dots fact-ticker__dots"><span></span><span></span><span></span></span>
          </span>
        </span>`;
    } else {
      bubble.innerHTML = `
        <span style="color: var(--fg-muted); display: inline-flex; align-items: center; gap: 8px;">
          Thinking
          <span class="dots"><span></span><span></span><span></span></span>
        </span>`;
    }

    wrapper.dataset.thinking = '1';
    messagesEl.appendChild(wrapper);

    if (facts) {
      const textEl = bubble.querySelector('.fact-ticker__text');
      const interval = setInterval(() => {
        if (!wrapper.isConnected) { clearInterval(interval); return; }
        factIndex = (factIndex + 1) % facts.length;
        const nextHtml = DOMPurify.sanitize(facts[factIndex]);
        // Slide previous fact up & out
        textEl.classList.add('fact-ticker__text--exiting');
        setTimeout(() => {
          if (!wrapper.isConnected) return;
          textEl.innerHTML = nextHtml;
          // Pre-position new fact below, with no transition, then animate in
          textEl.classList.remove('fact-ticker__text--exiting');
          textEl.classList.add('fact-ticker__text--entering');
          // Force reflow so the entering state actually paints before we remove it
          void textEl.offsetWidth;
          textEl.classList.remove('fact-ticker__text--entering');
        }, 450);
      }, 9000);
      wrapper._factInterval = interval;
    }

    return wrapper;
  }

  function setInputLocked(locked) {
    sendBtn.disabled = locked;
    input.disabled   = locked;
    if (!locked) updateSendButtonState();
  }

  /** Mirrors the input state into the send button's visual affordance. */
  function updateSendButtonState() {
    const hasContent = input.value.trim().length > 0;
    sendBtn.classList.toggle('has-content', hasContent && !input.disabled);
    sendBtn.disabled = !hasContent || input.disabled;
  }


  // ==========================================================================
  // §13  Welcome / quiz / prompt loader
  // ==========================================================================
  function renderWelcome() {
    const hero = document.createElement('div');
    hero.id = 'welcome-hero';
    hero.className = 'welcome-hero';
    hero.innerHTML = `
      ${assistantAvatarHTML('lg')}
      <h1>Welcome to ${escapeHtml(state.teamName)}</h1>
      <p>I'll help you onboard smoothly. Start with a suggestion below, or ask me anything.</p>
      <div class="chip-grid"></div>
    `;
    const grid = hero.querySelector('.chip-grid');

    state.starterPrompts.forEach(p => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.innerHTML = `
        <span class="icon">${resolveChipIcon(p.icon)}</span>
        <span>${escapeHtml(p.text)}</span>
      `;
      chip.addEventListener('click', () => {
        input.value = p.text;
        autoResize();
        form.requestSubmit();
      });
      grid.appendChild(chip);
    });

    messagesEl.appendChild(hero);
  }

  function clearWelcome() {
    ['welcome-hero', 'quiz', 'prompt-loader'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
  }

  function renderQuiz(onComplete) {
    const answers = {};
    let idx = 0;

    const box = document.createElement('div');
    box.id = 'quiz';
    box.className = 'quiz';
    messagesEl.appendChild(box);

    function renderStep() {
      const step = QUIZ_STEPS[idx];
      box.innerHTML = `
        ${assistantAvatarHTML('lg')}
        <div class="step">Step ${idx + 1} of ${QUIZ_STEPS.length}</div>
        <h2>${escapeHtml(step.title)}</h2>
        <div class="options"></div>
        <div class="progress"></div>
      `;

      const opts = box.querySelector('.options');
      step.options.forEach(opt => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'option';
        b.textContent = opt;
        b.addEventListener('click', () => {
          answers[step.key] = opt;
          idx += 1;
          if (idx < QUIZ_STEPS.length) renderStep();
          else onComplete(answers);
        });
        opts.appendChild(b);
      });

      const prog = box.querySelector('.progress');
      QUIZ_STEPS.forEach((_, i) => {
        const d = document.createElement('span');
        d.className = 'dot' + (i <= idx ? ' active' : '');
        prog.appendChild(d);
      });
    }
    renderStep();
  }

  function renderPromptLoader() {
    const el = document.createElement('div');
    el.id = 'prompt-loader';
    el.className = 'welcome-hero';
    el.innerHTML = `
      ${assistantAvatarHTML('lg')}
      <h1>Tailoring your starter prompts…</h1>
      <p><span class="dots"><span></span><span></span><span></span></span></p>
    `;
    messagesEl.appendChild(el);
  }


  // ==========================================================================
  // §14  Form + keyboard wiring
  // ==========================================================================
  function autoResize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, MAX_INPUT_HEIGHT_PX) + 'px';
  }

  async function submitQuestion(question) {
    if (followupRow) { followupRow.hidden = true; followupRow.innerHTML = ''; }
    addUserMessage(question);
    const thinking = addThinkingIndicator();
    setInputLocked(true);

    try {
      const res = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, session_id: state.sessionId }),
      });
      const data = await res.json();
      if (thinking._factInterval) clearInterval(thinking._factInterval);
      thinking.remove();
      addAssistantMessage(
        data.answer ?? data.detail ?? 'No response.',
        { toolUses: data.tool_uses, suggestions: data.suggestions },
      );
    } catch {
      if (thinking._factInterval) clearInterval(thinking._factInterval);
      thinking.remove();
      addAssistantMessage('Error: could not reach the server.');
    } finally {
      setInputLocked(false);
      input.focus();
    }
  }

  /** Global shortcuts wired to document, active regardless of focus. */
  function wireGlobalShortcuts() {
    document.addEventListener('keydown', (e) => {
      const meta = e.metaKey || e.ctrlKey;

      // ⌘K — focus the composer from anywhere
      if (meta && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        return;
      }

      // ⌘↵ — submit (works even when a different field has focus)
      if (meta && e.key === 'Enter') {
        if (input.value.trim()) {
          e.preventDefault();
          form.requestSubmit();
        }
        return;
      }

      // Esc — clear draft while input is focused
      if (e.key === 'Escape' && document.activeElement === input && input.value) {
        e.preventDefault();
        input.value = '';
        autoResize();
        updateSendButtonState();
      }
    });
  }

  function wireForm() {
    input.addEventListener('input', () => {
      autoResize();
      updateSendButtonState();
    });
    input.addEventListener('keydown', (e) => {
      // Bare Enter submits; Shift+Enter inserts newline.
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      input.value = '';
      autoResize();
      updateSendButtonState();
      submitQuestion(q);
    });

    newChatBtn.addEventListener('click', async () => {
      await TopProgress.wrap(async () => {
        try {
          await fetch('/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: state.sessionId }),
          });
        } catch { /* best-effort */ }
      });

      storage.remove(STORAGE.session);
      profile.clear();
      state.sessionId = ensureSessionId();
      messagesEl.innerHTML = '';
      await bootFlow();
    });
  }


  // ==========================================================================
  // §15  Boot
  // ==========================================================================
  async function bootFlow() {
    await loadSuggestions();

    const p = profile.get();
    if (p) {
      const cached = promptsCache.get();
      if (cached?.length) state.starterPrompts = cached;
      renderWelcome();
      input.focus();
      return;
    }

    renderQuiz(async (answers) => {
      profile.set(answers);
      clearWelcome();
      renderPromptLoader();
      try {
        const prompts = await personalize(answers);
        if (prompts?.length) {
          state.starterPrompts = prompts;
          promptsCache.set(prompts);
        }
      } catch { /* fall through */ }
      clearWelcome();
      renderWelcome();
      input.focus();
    });
  }

  // ==========================================================================
  //  Phase 5 — Scroll-to-latest pill
  //      Appears when the user scrolls more than ~120px away from the bottom.
  // ==========================================================================
  function wireScrollToLatest() {
    if (!scrollLatestBtn) return;
    const THRESHOLD = 120;

    function update() {
      const fromBottom =
        messagesEl.scrollHeight - messagesEl.clientHeight - messagesEl.scrollTop;
      scrollLatestBtn.classList.toggle('visible', fromBottom > THRESHOLD);
    }

    messagesEl.addEventListener('scroll', update, { passive: true });
    new ResizeObserver(update).observe(messagesEl);
    new MutationObserver(update)
      .observe(messagesEl, { childList: true, subtree: true });

    scrollLatestBtn.addEventListener('click', () => {
      messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
    });

    update();
  }

  // ==========================================================================
  //  Phase 5 — Sidebar drawer (< 1024px)
  //      Hamburger toggles body.sidebar-open. Backdrop / Esc / link clicks
  //      close it. Desktop layout is unaffected.
  // ==========================================================================
  function wireSidebarDrawer() {
    if (!sidebarToggle) return;

    function open()  { document.body.classList.add('sidebar-open'); }
    function close() { document.body.classList.remove('sidebar-open'); }
    function toggle() {
      document.body.classList.toggle('sidebar-open');
    }

    sidebarToggle.addEventListener('click', toggle);
    sidebarBackdrop?.addEventListener('click', close);

    // Close on Esc (only when the drawer is open and no modal has priority)
    document.addEventListener('keydown', (e) => {
      if (
        e.key === 'Escape'
        && document.body.classList.contains('sidebar-open')
        && !document.getElementById('lightbox')?.classList.contains('active')
      ) {
        close();
      }
    });

    // Any primary sidebar action (New chat / history item) closes the drawer
    // on mobile — matches ChatGPT / Linear mobile patterns.
    document.querySelector('.sidebar')?.addEventListener('click', (e) => {
      if (!window.matchMedia('(max-width: 1023px)').matches) return;
      const actionable = e.target.closest('button:not([disabled])');
      if (actionable) close();
    });
  }

  function boot() {
    initThemeToggle();
    state.sessionId = ensureSessionId();
    wireForm();
    wireGlobalShortcuts();
    wireScrollToLatest();
    wireSidebarDrawer();
    updateSendButtonState();
    bootFlow();
  }

  boot();
})();
