const { Router } = require('express');
const fs = require('fs');
const { adminAuth } = require('../middleware/adminAuth.js');
const store = require('../services/blogStore.js');
const { generateArticleHTML } = require('../services/blogTemplate.js');

const router = Router();

/** Blog moderation: admin, manager and support staff (role matrix §11.3). */
const MODERATORS = ['admin', 'manager', 'staff'];
function blogModerator(req, res, next) {
  if (MODERATORS.indexOf(req.admin && req.admin.role) === -1) return res.status(403).json({ error: 'Forbidden — your role does not allow this' });
  next();
}

router.get('/posts', function (req, res) {
  const posts = store.getPublished().map(function (p) {
    return { id: p.id, title: p.title, slug: p.slug, category: p.category, authorName: p.authorName, excerpt: p.excerpt, readTime: p.readTime, publishedAt: p.publishedAt };
  });
  res.json(posts);
});

router.post('/submit', function (req, res) {
  const { title, category, authorName, authorEmail, content, excerpt } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
  if (!authorName || !authorName.trim()) return res.status(400).json({ error: 'authorName is required' });
  if (!authorEmail || !authorEmail.trim()) return res.status(400).json({ error: 'authorEmail is required' });
  if (!content || !content.trim() || content.trim().length < 200) return res.status(400).json({ error: 'content must be at least 200 characters' });
  if (title.length > 200) return res.status(400).json({ error: 'title too long' });
  const post = store.addPending({ title: title, category: category || 'Wellness', authorName: authorName, authorEmail: authorEmail, content: content, excerpt: excerpt });
  res.json({ success: true, id: post.id, message: 'Submission received — our team will review it within 2-3 business days.' });
});

router.get('/pending', adminAuth, blogModerator, function (req, res) {
  res.json(store.getPublished().concat(store.getPending().map(function (p) { return Object.assign({}, p, { status: 'pending' }); })));
});

router.post('/approve/:id', adminAuth, blogModerator, function (req, res) {
  const post = store.approvePost(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found in pending queue' });
  try {
    store.saveArticle(post.slug, generateArticleHTML(post));
  } catch (e) {
    // The page is generated again on first view, so publishing still succeeds.
    console.error('Failed to write article HTML:', e.message);
  }
  res.json({ success: true, post: post, slug: post.slug });
});

router.post('/reject/:id', adminAuth, blogModerator, function (req, res) {
  const post = store.rejectPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  res.json({ success: true, post: post });
});

/**
 * GET /blog/<slug>.html — published articles are served from DATA_DIR first
 * (generated again, escaped, if the page file is missing); anything else
 * falls through to the old frontend/blog folder.
 */
router.serveArticle = function (req, res, next) {
  const m = /^([a-z0-9][a-z0-9-]{0,80})\.html$/.exec(req.params.file || '');
  if (!m || m[1] === 'index' || m[1] === 'submit') return next();
  const file = store.articlePath(m[1]);
  try {
    if (!fs.existsSync(file)) {
      const post = store.getPublished().find(function (p) { return p.slug === m[1]; });
      if (!post) return next();
      store.saveArticle(post.slug, generateArticleHTML(post));
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('html').send(fs.readFileSync(file, 'utf8'));
  } catch (e) { next(e); }
};

module.exports = router;
