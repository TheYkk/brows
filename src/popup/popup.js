(function () {
  const input = document.getElementById('popupInput');
  const resultsList = document.getElementById('popupResults');
  const openFullLink = document.getElementById('openFull');

  let results = [];
  let selectedIndex = -1;
  let currentQuery = '';

  function send(type, data) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, data }, (response) => {
        resolve(response || {});
      });
    });
  }

  async function runSearch() {
    const query = input.value.trim();
    currentQuery = query;
    selectedIndex = -1;

    let response;
    if (query) {
      response = await send(MSG.SEARCH, { query, opts: { limit: 10 } });
    } else {
      response = await send(MSG.GET_RECENT, { limit: 10, offset: 0, opts: {} });
    }

    results = response.results || [];
    render();
  }

  function render() {
    if (!results.length) {
      resultsList.innerHTML = '<div class="popup-empty">No results</div>';
      return;
    }

    const terms = currentQuery ? currentQuery.trim().split(/\s+/) : [];

    resultsList.innerHTML = results.map((page, idx) => {
      const title = highlightMatches(page.title || page.url, terms);
      const url = escapeHtml(page.url);
      const ago = timeAgo(page.last_visited_at);
      const visits = page.visit_count > 1 ? `${page.visit_count} visits` : '';
      const sel = idx === selectedIndex ? ' selected' : '';

      return `<li class="popup-item${sel}" data-idx="${idx}">
        <div class="popup-item-title">${title}</div>
        <div class="popup-item-url">${url}</div>
        <div class="popup-item-meta"><span>${ago}</span>${visits ? `<span>${visits}</span>` : ''}</div>
      </li>`;
    }).join('');
  }

  const debouncedSearch = debounce(runSearch, 150);
  input.addEventListener('input', debouncedSearch);

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
