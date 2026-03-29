(function () {
  const PAGE_SIZE = 50;

  // ── DOM refs ──

  const searchInput = document.getElementById('searchInput');
  const searchMeta = document.getElementById('searchMeta');
  const resultsList = document.getElementById('results');
  const emptyState = document.getElementById('emptyState');
  const loadingEl = document.getElementById('loading');
  const mainContent = document.getElementById('mainContent');
  const scrollSentinel = document.getElementById('scrollSentinel');
  const domainList = document.getElementById('domainList');
  const clearDomainBtn = document.getElementById('clearDomain');
  const dateFrom = document.getElementById('dateFrom');
  const dateTo = document.getElementById('dateTo');
  const statsPages = document.getElementById('statsPages');
  const statsVisits = document.getElementById('statsVisits');

  // ── State ──

  let currentResults = [];
  let selectedIndex = -1;
  let currentQuery = '';
  let activeDomain = null;
  let offset = 0;
  let hasMore = true;
  let expandedPageId = null;
  let loadingMore = false;

  // ── Messaging ──

  function send(type, data) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, data }, (response) => {
        resolve(response || {});
      });
    });
  }

  // ── Search ──

  async function runSearch(append) {
    if (append) {
      if (!hasMore || loadingMore) return;
      loadingMore = true;
    } else {
      offset = 0;
      currentResults = [];
      hasMore = true;
    }

    try {
      const opts = { limit: PAGE_SIZE, offset };
      if (activeDomain) opts.domain = activeDomain;

      const from = dateFrom.value;
      const to = dateTo.value;
      if (from) opts.startDate = new Date(from).getTime();
      if (to) opts.endDate = new Date(to + 'T23:59:59').getTime();

      const query = searchInput.value.trim();
      currentQuery = query;

      let response;
      if (query) {
        response = await send(MSG.SEARCH, { query, opts });
      } else {
        response = await send(MSG.GET_RECENT, { limit: PAGE_SIZE, offset, opts });
      }

      const results = response.results || [];
      if (results.length < PAGE_SIZE) hasMore = false;

      if (append) {
        currentResults = currentResults.concat(results);
      } else {
        currentResults = results;
      }

      offset = currentResults.length;
      render();
    } finally {
      if (append) loadingMore = false;
    }
  }

  // ── Render ──

  function render() {
    loadingEl.style.display = 'none';

    if (!currentResults.length) {
      resultsList.style.display = 'none';
      emptyState.style.display = 'flex';
      scrollSentinel.style.display = 'none';
      searchMeta.textContent = '';
      return;
    }

    emptyState.style.display = 'none';
    resultsList.style.display = 'block';
    scrollSentinel.style.display = hasMore ? 'block' : 'none';

    const terms = currentQuery ? currentQuery.trim().split(/\s+/) : [];
    const count = currentResults.length;
    searchMeta.textContent = currentQuery
      ? `${count} result${count !== 1 ? 's' : ''} for "${currentQuery}"${!hasMore ? '' : '+'}`
      : `Showing ${count} recent pages`;

    resultsList.innerHTML = '';

    currentResults.forEach((page, idx) => {
      const li = document.createElement('li');
      li.className = 'result-item' + (idx === selectedIndex ? ' selected' : '');
      li.dataset.idx = idx;
      li.dataset.pageId = page.id;

      const titleHtml = highlightMatches(page.title || page.url, terms);
      const urlHtml = highlightMatches(page.url, terms);
      const desc = page.meta_description || page.og_description || '';
      const visitText = page.visit_count > 1 ? `${page.visit_count} visits` : '1 visit';
      const timeText = timeAgo(page.last_visited_at);
      const scoreHtml = page._score ? `<span class="result-score">${page._score.toFixed(1)}</span>` : '';

      const faviconHtml = page.favicon_url
        ? `<img class="result-favicon" src="${escapeHtml(page.favicon_url)}" onerror="this.outerHTML='<span class=\\'result-favicon-placeholder\\'>${escapeHtml(page.domain?.[0] || '?')}</span>'">`
        : `<span class="result-favicon-placeholder">${escapeHtml(page.domain?.[0]?.toUpperCase() || '?')}</span>`;

      li.innerHTML = `
        <div class="result-header">
          ${faviconHtml}
          <span class="result-title">${titleHtml}</span>
          <button class="result-delete" title="Delete" data-page-id="${page.id}">&times;</button>
        </div>
        <div class="result-meta">
          <span class="result-url">${urlHtml}</span>
          <span class="result-domain">${escapeHtml(page.domain || '')}</span>
          <span class="result-visits-count">${visitText}</span>
          ${scoreHtml}
          <button type="button" class="result-visits-toggle" data-page-id="${page.id}" title="Visit history">Visits</button>
          <span class="result-time">${timeText}</span>
        </div>
        ${desc ? `<div class="result-description">${escapeHtml(desc)}</div>` : ''}
        <div class="visit-timeline ${expandedPageId === page.id ? 'open' : ''}" id="timeline-${page.id}">
          <ul class="visit-list" id="visits-${page.id}"></ul>
        </div>
      `;

      resultsList.appendChild(li);

      if (expandedPageId === page.id) {
        loadVisits(page.id);
      }
    });
  }

  // ── Visit Timeline ──

  async function loadVisits(pageId) {
    const container = document.getElementById(`visits-${pageId}`);
    if (!container) return;

    const resp = await send(MSG.GET_VISITS, { pageId });
    const visits = resp.visits || [];

    if (!visits.length) {
      container.innerHTML = '<li class="visit-entry">No visit records</li>';
      return;
    }

    container.innerHTML = visits.map(v => {
      const date = formatDate(v.visited_at);
      const typeBadge = v.transition_type ? `<span class="visit-type">${escapeHtml(v.transition_type)}</span>` : '';
      const dur = v.duration_ms > 0
        ? `<span class="visit-duration">${Math.round(v.duration_ms / 1000)}s</span>`
        : '';
      return `<li class="visit-entry">${date} ${typeBadge} ${dur}</li>`;
    }).join('');
  }

  function toggleTimeline(pageId) {
    const el = document.getElementById(`timeline-${pageId}`);
    if (!el) return;

    if (expandedPageId === pageId) {
      el.classList.remove('open');
      expandedPageId = null;
    } else {
      if (expandedPageId) {
        const prev = document.getElementById(`timeline-${expandedPageId}`);
        if (prev) prev.classList.remove('open');
      }
      expandedPageId = pageId;
      el.classList.add('open');
      loadVisits(pageId);
    }
  }

  // ── Domains Sidebar ──

  async function loadDomains() {
    const resp = await send(MSG.GET_TOP_DOMAINS, { limit: 30 });
    const domains = resp.domains || [];

    domainList.innerHTML = domains.map(d => `
      <li class="domain-item ${activeDomain === d.domain ? 'active' : ''}" data-domain="${escapeHtml(d.domain)}">
        <span>${escapeHtml(d.domain)}</span>
        <span class="domain-count">${d.visitCount}</span>
      </li>
    `).join('');

    clearDomainBtn.classList.toggle('visible', !!activeDomain);
  }

  // ── Stats ──

  async function loadStats() {
    const stats = await send(MSG.GET_STATS);
    statsPages.textContent = `${(stats.totalPages || 0).toLocaleString()} pages`;
    statsVisits.textContent = `${(stats.totalVisits || 0).toLocaleString()} visits`;
  }

  // ── Event Handlers ──

  const debouncedSearch = debounce(() => runSearch(false), 200);
  searchInput.addEventListener('input', debouncedSearch);

  dateFrom.addEventListener('change', () => runSearch(false));
  dateTo.addEventListener('change', () => runSearch(false));

  domainList.addEventListener('click', (e) => {
    const item = e.target.closest('.domain-item');
    if (!item) return;
    const domain = item.dataset.domain;
    activeDomain = activeDomain === domain ? null : domain;
    loadDomains();
    runSearch(false);
  });

  clearDomainBtn.addEventListener('click', () => {
    activeDomain = null;
    loadDomains();
    runSearch(false);
  });

  resultsList.addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('.result-delete');
    if (deleteBtn) {
      e.stopPropagation();
      const pageId = Number(deleteBtn.dataset.pageId);
      send(MSG.DELETE_PAGE, { pageId }).then(() => {
        currentResults = currentResults.filter(r => r.id !== pageId);
        render();
        loadStats();
        loadDomains();
      });
      return;
    }

    const visitsToggle = e.target.closest('.result-visits-toggle');
    if (visitsToggle) {
      e.stopPropagation();
      const pageId = Number(visitsToggle.dataset.pageId);
      toggleTimeline(pageId);
      return;
    }

    if (e.target.closest('.visit-timeline')) return;

    const li = e.target.closest('.result-item');
    if (!li) return;

    const idx = Number(li.dataset.idx);
    const page = currentResults[idx];
    if (!page) return;

    window.open(page.url, '_blank');
  });

  // ── Keyboard Navigation ──

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (searchInput.value) {
        searchInput.value = '';
        runSearch(false);
      }
      searchInput.focus();
      selectedIndex = -1;
      render();
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (selectedIndex < currentResults.length - 1) {
        selectedIndex++;
        render();
        scrollToSelected();
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (selectedIndex > 0) {
        selectedIndex--;
        render();
        scrollToSelected();
      } else if (selectedIndex === 0) {
        selectedIndex = -1;
        searchInput.focus();
        render();
      }
      return;
    }

    if (e.key === 'Enter' && selectedIndex >= 0) {
      const page = currentResults[selectedIndex];
      if (page) window.open(page.url, '_blank');
      return;
    }

    // Focus search on typing
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && document.activeElement !== searchInput) {
      searchInput.focus();
    }
  });

  function scrollToSelected() {
    const items = resultsList.querySelectorAll('.result-item');
    if (items[selectedIndex]) {
      items[selectedIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  // ── Export / Import ──

  const exportBtn = document.getElementById('exportBtn');
  const importBtn = document.getElementById('importBtn');
  const importFile = document.getElementById('importFile');
  const backupStatus = document.getElementById('backupStatus');

  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    backupStatus.textContent = 'Exporting...';
    backupStatus.className = 'backup-status';

    try {
      const resp = await send(MSG.EXPORT_DB);
      if (!resp || resp.error || !resp.data) {
        throw new Error(resp?.error || 'Export failed');
      }

      const bytes = new Uint8Array(resp.data);
      const blob = new Blob([bytes], { type: 'application/x-sqlite3' });
      const url = URL.createObjectURL(blob);
      const date = new Date().toISOString().slice(0, 10);
      const a = document.createElement('a');
      a.href = url;
      a.download = `brows-history-${date}.db`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      const sizeKB = (bytes.length / 1024).toFixed(0);
      backupStatus.textContent = `Exported ${sizeKB} KB`;
      backupStatus.className = 'backup-status success';
    } catch (e) {
      backupStatus.textContent = `Export failed: ${e.message}`;
      backupStatus.className = 'backup-status error';
    } finally {
      exportBtn.disabled = false;
    }
  });

  importBtn.addEventListener('click', () => importFile.click());

  importFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    importFile.value = '';

    const confirmed = confirm(
      `Replace current history with "${file.name}"?\n\nThis will overwrite all existing data. Make sure you have an export of your current data first.`
    );
    if (!confirmed) return;

    importBtn.disabled = true;
    backupStatus.textContent = 'Importing...';
    backupStatus.className = 'backup-status';

    try {
      const buffer = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buffer));
      const resp = await send(MSG.IMPORT_DB, { bytes });

      if (!resp || resp.error) {
        throw new Error(resp?.error || 'Import failed');
      }

      backupStatus.textContent = `Imported: ${(resp.totalPages || 0).toLocaleString()} pages, ${(resp.totalVisits || 0).toLocaleString()} visits`;
      backupStatus.className = 'backup-status success';

      await runSearch(false);
      await loadDomains();
      await loadStats();
    } catch (e) {
      backupStatus.textContent = `Import failed: ${e.message}`;
      backupStatus.className = 'backup-status error';
    } finally {
      importBtn.disabled = false;
    }
  });

  async function loadBackupStatus() {
    const stored = await chrome.storage.local.get(['brows-backup-time']);
    const ts = stored['brows-backup-time'];
    if (ts) {
      backupStatus.textContent = `Last auto-backup: ${timeAgo(ts)}`;
    }
  }

  // ── Init ──

  const scrollObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && hasMore && !loadingMore) {
          runSearch(true);
        }
      }
    },
    { root: mainContent, rootMargin: '280px', threshold: 0 }
  );
  scrollObserver.observe(scrollSentinel);

  async function init() {
    await runSearch(false);
    await loadDomains();
    await loadStats();
    await loadBackupStatus();
  }

  // Retry init until DB is ready
  let retries = 0;
  function tryInit() {
    init().catch(() => {
      if (retries++ < 20) {
        setTimeout(tryInit, 500);
      } else {
        loadingEl.textContent = 'Failed to connect to database.';
      }
    });
  }

  tryInit();
})();
