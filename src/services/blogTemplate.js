function generateArticleHTML(post) {
  // The submission is public input: escape it, then keep paragraphs and line
  // breaks (Phase 0.5.10, BUG-007).
  const paragraphs = String(post.content || '').split(/\n{2,}/).map(function (p) {
    return '<p>' + escHtml(p.trim()).replace(/\n/g, '<br/>') + '</p>';
  }).join('\n    ');
  const dateStr = new Date(post.publishedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '<meta charset="UTF-8"/>\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0"/>\n' +
    '<title>' + escHtml(post.title) + ' — Sake of Health Blog</title>\n' +
    '<meta name="description" content="' + escHtml(post.excerpt) + '"/>\n' +
    '<link href="https://api.fontshare.com/v2/css?f[]=recoleta@400,700&display=swap" rel="stylesheet"/>\n' +
    '<link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600&display=swap" rel="stylesheet"/>\n' +
    '<link rel="stylesheet" href="../../assets/css/main.css?v=5"/>\n' +
    '<style>\n' +
    'body { padding-top: 72px; }\n' +
    '.article-hero { background: var(--cream-dark); padding: 4rem 5vw 3rem; text-align: center; border-bottom: 1px solid var(--cream-border); }\n' +
    '.article-category { display: inline-block; padding: 0.3rem 1rem; background: rgba(41,103,33,0.08); color: var(--green-deep); border-radius: 50px; font-size: 0.78rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 1rem; }\n' +
    '.article-title { font-family: var(--ff-display); font-size: clamp(1.8rem, 4vw, 3rem); line-height: 1.2; max-width: 760px; margin: 0 auto 1rem; }\n' +
    '.article-meta { font-size: 0.82rem; color: var(--text-muted); }\n' +
    '.article-body { max-width: 720px; margin: 0 auto; padding: 3rem 5vw 5rem; }\n' +
    '.article-body p { font-size: 1rem; line-height: 1.85; color: var(--text-muted); margin-bottom: 1.4rem; font-weight: 300; }\n' +
    '.article-body h2 { font-family: var(--ff-display); font-size: 1.5rem; margin: 2.5rem 0 1rem; color: var(--text); }\n' +
    '.article-body h3 { font-weight: 600; margin: 2rem 0 0.8rem; color: var(--text); }\n' +
    '.article-back { display: inline-flex; align-items: center; gap: 0.4rem; color: var(--green-deep); text-decoration: none; font-weight: 600; font-size: 0.88rem; margin-bottom: 2rem; }\n' +
    '</style>\n</head>\n<body>\n' +
    '<nav class="site-nav"><div class="nav-inner">' +
    '<a href="/" class="logo"><img src="../../assets/images/logo-mark.png" class="logo-mark" alt="" aria-hidden="true"/><div><span class="logo-name">Sake of Health</span><span class="logo-tagline">Premium Gummies</span></div></a>' +
    '<nav class="nav-cats"><a href="../../categories/multivitamins.html" class="nav-cat">Multivitamins</a><a href="../../categories/iron.html" class="nav-cat">Iron</a><a href="../../categories/athletic.html" class="nav-cat">Athletic</a></nav>' +
    '<div class="nav-actions"><a href="../../checkout/" style="position:relative;display:inline-flex;"><button class="nav-cart" aria-label="Cart">🛒<span class="cart-count" style="display:none">0</span></button></a><a href="../../checkout/" class="btn btn-primary btn-sm">Buy Now</a></div>' +
    '</div></nav>\n\n' +
    '<div class="article-hero">\n' +
    '  <span class="article-category">' + escHtml(post.category) + '</span>\n' +
    '  <h1 class="article-title">' + escHtml(post.title) + '</h1>\n' +
    '  <div class="article-meta">By ' + escHtml(post.authorName) + ' &nbsp;\xB7&nbsp; ' + escHtml(dateStr) + ' &nbsp;\xB7&nbsp; ' + escHtml(post.readTime) + '</div>\n' +
    '</div>\n\n' +
    '<div class="article-body">\n' +
    '  <a href="../" class="article-back">← Back to Blog</a>\n\n' +
    '  ' + paragraphs + '\n' +
    '</div>\n\n' +
    '<footer class="site-footer">\n' +
    '  <div class="footer-bottom container" style="border-top:none;padding-top:2rem;">\n' +
    '    <span>\xA9 2025 Sake of Health \xB7 <a href="/">Home</a> \xB7 <a href="mailto:info@sakeofhealth.in">Contact</a></span>\n' +
    '    <span>Minimal shipping charges apply.</span>\n' +
    '  </div>\n' +
    '  <div class="ixitek-note">Sake of Health is a brand of <strong>Ixitek Healthcare and Wellness Pvt. Ltd.</strong> — Registered in India \xB7 FSSAI Lic. No.: 11225998000107</div>\n' +
    '</footer>\n' +
    '<script src="../../assets/js/app.js?v=3"></script>\n' +
    '</body>\n</html>';
}

function escHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { generateArticleHTML };
