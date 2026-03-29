(function () {
  const PAGE_SIZE = 25;

  const input = document.getElementById('popupInput');
  const resultsList = document.getElementById('popupResults');
  const popupResultsWrap = document.getElementById('popupResultsWrap');
  const popupScrollSentinel = document.getElementById('popupScrollSentinel');
  const openFullLink = document.getElementById('openFull');

  let results = [];
  let selectedIndex = -1;
  let currentQuery = '';
  let offset = 0;
  let hasMore = true;
  let loadingMore = false;

  function send(type, data) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, data }, (response) => {
        resolve(response || {});
      });
    });
  }

  async function runSearch() {
    offset = 0;
    hasMore = true;
    results = [];
    selectedIndex = -1;
    currentQuery = input.value.trim();

    const opts = { limit: PAGE_SIZE, offset: 0 };
    let response;
    if (currentQuery) {
      response = await send(MSG.SEARCH, { query: currentQuery, opts });
    } else {
      response = await send(MSG.GET_RECENT, { limit: PAGE_SIZE, offset: 0, opts: {} });
    }

    const batch = response.results || [];
    if (batch.length < PAGE_SIZE) hasMore = false;
    results = batch;
    offset = results.length;
    render();
  }

  async function loadMore() {
    if (!hasMore || loadingMore) return;
    const query = input.value.trim();
    if (query !== currentQuery) return;

    loadingMore = true;
    try {
      const opts = { limit: PAGE_SIZE, offset };
      let response;
      if (query) {
        response = await send(MSG.SEARCH, { query, opts });
      } else {
        response = await send(MSG.GET_RECENT, { limit: PAGE_SIZE, offset, opts: {} });
      }

      const batch = response.results || [];
      if (batch.length < PAGE_SIZE) hasMore = false;
      results = results.concat(batch);
      offset = results.length;
      render();
    } finally {
      loadingMore = false;
    }
  }

  function render() {
    if (!results.length) {
      resultsList.innerHTML = '<li class="popup-empty">No results</li>';
      popupScrollSentinel.style.display = 'none';
      return;
    }

    popupScrollSentinel.style.display = hasMore ? 'block' : 'none';

    const terms = currentQuery ? currentQuery.trim().split(/\s+/) : [];

    resultsList.innerHTML = results.map((page, idx) => {
      const title = highlightMatches(page.title || page.url, terms);
      const url = escapeHtml(page.url);
      const ago = timeAgo(page.last_visited_at);
      const fullDate = formatDate(page.last_visited_at);
      const visits = page.visit_count > 1 ? `${page.visit_count} visits` : '';
      const sel = idx === selectedIndex ? ' selected' : '';

      const faviconHtml = page.favicon_url
        ? `<img class="popup-favicon" src="${escapeHtml(page.favicon_url)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
          + `<span class="popup-favicon-ph" style="display:none">${escapeHtml((page.domain || '?')[0].toUpperCase())}</span>`
        : `<span class="popup-favicon-ph">${escapeHtml((page.domain || '?')[0].toUpperCase())}</span>`;

      return `<li class="popup-item${sel}" data-idx="${idx}">
        <div class="popup-item-header">
          ${faviconHtml}
          <span class="popup-item-title">${title}</span>
        </div>
        <div class="popup-item-url">${url}</div>
        <div class="popup-item-meta">
          <span title="${fullDate}">${ago}</span>
          ${visits ? `<span>${visits}</span>` : ''}
        </div>
      </li>`;
    }).join('');
  }

  const debouncedSearch = debounce(runSearch, 150);
  input.addEventListener('input', debouncedSearch);

  const scrollObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && hasMore && !loadingMore) {
          loadMore();
        }
      }
    },
    { root: popupResultsWrap, rootMargin: '120px', threshold: 0 }
  );
  scrollObserver.observe(popupScrollSentinel);

  resultsList.addEventListener('click', (e) => {
    const item = e.target.closest('.popup-item');
    if (!item) return;
    const idx = Number(item.dataset.idx);
    const page = results[idx];
    if (page) {
      chrome.tabs.create({ url: page.url });
      window.close();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (selectedIndex < results.length - 1) selectedIndex++;
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (selectedIndex > 0) selectedIndex--;
      else { selectedIndex = -1; input.focus(); }
      render();
    } else if (e.key === 'Enter' && selectedIndex >= 0) {
      const page = results[selectedIndex];
      if (page) {
        chrome.tabs.create({ url: page.url });
        window.close();
      }
    }
  });

  openFullLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://history' });
    window.close();
  });

  runSearch();
})();
