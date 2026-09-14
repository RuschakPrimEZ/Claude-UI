// ==UserScript==
// @name         Claude — project badges on chats & tasks
// @namespace    local.claude.projectbadges
// @version      1.3
// @description  Shows which project each conversation belongs to, inline in the sidebar, recents list, and task rows.
// @match        https://claude.ai/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const CFG = {
    refreshMs: 5 * 60 * 1000,   // re-pull the conversation list this often
    pageSize: 200,              // conversations per API page
    maxPages: 15,
    missGraceMs: 20 * 1000,     // min gap between "I saw an unknown chat" refetches
    showUnfiled: false,         // set true to badge chats with no project too
    debug: false,               // set true for an on-page panel showing what was found
  };

  const state = { org: null, projects: new Map(), convos: new Map(), lastMiss: 0, loading: null, stats: {} };

  // ---------- styling ----------
  // Quiet pill that borrows the row's own text colour, tinted by a hue hashed
  // from the project name so each project is recognisable at a glance.
  const style = document.createElement('style');
  style.textContent = `
    .cpb-badge {
      display: inline;
      margin-right: .45em;
      padding: .1em .45em;
      border-radius: .4em;
      font-size: .72em;
      font-weight: 500;
      letter-spacing: .01em;
      white-space: nowrap;
      vertical-align: baseline;
      background: hsl(var(--cpb-h) 55% 50% / .16);
      color: hsl(var(--cpb-h) 60% 38%);
      border: 1px solid hsl(var(--cpb-h) 55% 50% / .25);
    }
    @media (prefers-color-scheme: dark) {
      .cpb-badge { color: hsl(var(--cpb-h) 70% 75%); background: hsl(var(--cpb-h) 55% 60% / .18); }
    }
    .cpb-badge--none { --cpb-h: 0; filter: saturate(0); opacity: .6; }
    #cpb-debug {
      position: fixed; right: 12px; bottom: 12px; z-index: 99999;
      max-width: 30em; max-height: 50vh; overflow: auto;
      padding: .75em .9em; border-radius: .5em;
      background: #111; color: #eee; border: 1px solid #444;
      font: 12px/1.5 ui-monospace, Menlo, Consolas, monospace;
      white-space: pre-wrap;
    }
  `;
  document.head.appendChild(style);

  const hue = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  };

  // ---------- api ----------
  const api = async (path) => {
    const r = await fetch(path, { credentials: 'include', headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json();
  };

  const getOrg = async () => {
    const cookie = document.cookie.match(/lastActiveOrg=([^;]+)/);
    if (cookie) return decodeURIComponent(cookie[1]);
    const orgs = await api('/api/organizations');
    if (!Array.isArray(orgs) || !orgs.length) throw new Error('no organizations returned');
    return orgs[0].uuid;
  };

  const loadProjects = async (org) => {
    const list = await api(`/api/organizations/${org}/projects`);
    state.projects.clear();
    for (const p of list || []) state.projects.set(p.uuid, p.name || 'Untitled project');
  };

  const loadConversations = async (org) => {
    state.convos.clear();
    for (let page = 0; page < CFG.maxPages; page++) {
      const batch = await api(
        `/api/organizations/${org}/chat_conversations?limit=${CFG.pageSize}&offset=${page * CFG.pageSize}`
      );
      if (!Array.isArray(batch) || !batch.length) break;
      for (const c of batch) {
        // the field has moved around between UI versions, so accept either shape
        const pid = c.project_uuid || c.project?.uuid || null;
        const pname = c.project?.name || (pid ? state.projects.get(pid) : null);
        state.convos.set(c.uuid, pname || null);
      }
      if (batch.length < CFG.pageSize) break;
    }
  };

  const refresh = async () => {
    if (state.loading) return state.loading;
    state.loading = (async () => {
      try {
        state.org ||= await getOrg();
        await loadProjects(state.org);
        await loadConversations(state.org);
        paint();
      } catch (e) {
        state.stats.error = e.message;
        console.warn('[project badges] could not load project data:', e.message);
      } finally {
        state.loading = null;
      }
    })();
    return state.loading;
  };

  // ---------- finding where the title sits ----------
  const UUID = /\/chat\/([0-9a-f-]{36})/i;

  // The title is the longest run of text in the row — longer than a timestamp
  // like "4 days ago", and the badge's own text is skipped.
  const titleTextNode = (root) => {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.textContent.trim().length > 1 && !n.parentElement?.closest('.cpb-badge')
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    let best = null;
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!best || n.textContent.trim().length > best.textContent.trim().length) best = n;
    }
    return best;
  };

  // Sidebar links wrap their own title text. Rows in the main list use a
  // stretched overlay link that covers the row but contains no text, so climb
  // to the row container and use the title sitting there instead.
  const badgeAnchorPoint = (a) => {
    let el = a;
    for (let depth = 0; depth < 6 && el; depth++) {
      const text = titleTextNode(el);
      if (text) return text;
      el = el.parentElement;
      // Stop before climbing into something that holds several rows.
      if (!el || el.querySelectorAll('a[href*="/chat/"]').length > 1) return null;
    }
    return null;
  };

  // ---------- painting ----------
  const badge = (label) => {
    const el = document.createElement('span');
    el.className = 'cpb-badge' + (label ? '' : ' cpb-badge--none');
    el.textContent = label || 'no project';
    el.dataset.cpbLabel = label || '∅';
    if (label) el.style.setProperty('--cpb-h', hue(label));
    return el;
  };

  const paint = () => {
    let sawUnknown = false;
    const stats = { links: 0, badged: 0, noTitle: 0, unknown: 0 };

    for (const a of document.querySelectorAll('a[href*="/chat/"]')) {
      const m = (a.getAttribute('href') || '').match(UUID);
      if (!m) continue;
      stats.links++;

      if (!state.convos.has(m[1])) { sawUnknown = true; stats.unknown++; continue; }
      const label = state.convos.get(m[1]);
      if (!label && !CFG.showUnfiled) continue;

      const text = badgeAnchorPoint(a);
      if (!text) { stats.noTitle++; continue; }

      // Check the badge itself rather than remembering we added one — the app
      // re-renders rows and throws our span away, and it has to come back.
      const scope = text.parentElement;
      const existing = scope.querySelector('.cpb-badge');
      if (existing?.dataset.cpbLabel === (label || '∅')) { stats.badged++; continue; }
      existing?.remove();

      scope.insertBefore(badge(label), text);
      scope.title = label ? `Project: ${label}` : 'Not in a project';
      stats.badged++;
    }

    state.stats = { ...stats, projects: state.projects.size, convos: state.convos.size, error: state.stats.error };
    if (CFG.debug) showDebug();

    // A chat we've never seen usually means it was created after the last pull.
    if (sawUnknown && Date.now() - state.lastMiss > CFG.missGraceMs) {
      state.lastMiss = Date.now();
      refresh();
    }
  };

  // ---------- on-page diagnostics (no devtools needed) ----------
  const showDebug = () => {
    let box = document.getElementById('cpb-debug');
    if (!box) {
      box = document.createElement('div');
      box.id = 'cpb-debug';
      document.body.appendChild(box);
    }
    const centre = [...document.querySelectorAll('a[href*="/chat/"]')]
      .find((x) => x.getBoundingClientRect().left > 400);
    const chain = [];
    let el = centre;
    for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
      chain.push(`${i} <${el.tagName.toLowerCase()} class="${(el.className || '').toString().slice(0, 50)}">  text: ${JSON.stringify((el.textContent || '').trim().slice(0, 45))}`);
    }
    box.textContent =
      `project badges v1.3\n` +
      Object.entries(state.stats).map(([k, v]) => `${k}: ${v}`).join('\n') +
      `\n\ncentre row link found: ${!!centre}\n` +
      chain.join('\n');
  };

  // ---------- wiring ----------
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; paint(); });
  };

  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('focus', schedule);
  setInterval(refresh, CFG.refreshMs);

  refresh();
})();
