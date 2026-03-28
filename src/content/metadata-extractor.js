(function () {
  if (window.__browsMetadataExtracted) return;
  window.__browsMetadataExtracted = true;

  function getMeta(name) {
    const el =
      document.querySelector(`meta[name="${name}"]`) ||
      document.querySelector(`meta[property="${name}"]`);
    return el ? el.getAttribute('content') || '' : '';
  }

  function getFavicon() {
    const link =
      document.querySelector('link[rel="icon"]') ||
      document.querySelector('link[rel="shortcut icon"]') ||
      document.querySelector('link[rel="apple-touch-icon"]');
    if (link && link.href) return link.href;
    return '';
  }

  const data = {
    title: document.title || '',
    metaDescription: getMeta('description'),
    metaKeywords: getMeta('keywords'),
    ogTitle: getMeta('og:title'),
    ogDescription: getMeta('og:description'),
    ogImage: getMeta('og:image'),
    language: document.documentElement.lang || '',
    faviconUrl: getFavicon(),
  };

  const hasContent = data.metaDescription || data.metaKeywords ||
    data.ogTitle || data.ogDescription || data.ogImage ||
    data.language || data.faviconUrl;

  if (hasContent || data.title) {
    chrome.runtime.sendMessage({ type: 'PAGE_METADATA', data }).catch(() => {});
  }
})();
