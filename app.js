const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const RSSParser = require('rss-parser');
const axios = require('axios');
const cron = require('node-cron');
const cheerio = require('cheerio');

dotenv.config();

const app = express();
const parser = new RSSParser();

const PORT = process.env.PORT || 3000;
const FEED_URL = process.env.RSS_FEED_URL;
const REFRESH_INTERVAL_MINUTES = parseInt(process.env.FEED_REFRESH_MINUTES || '15', 10);
const REFRESH_INTERVAL_MS = Math.max(REFRESH_INTERVAL_MINUTES, 1) * 60 * 1000;
const MAX_ARTICLES_PER_REFRESH = Math.max(
  parseInt(process.env.MAX_ARTICLES_PER_REFRESH || '10', 10),
  1
);
const FEED_CRON_SCHEDULE = process.env.FEED_CRON_SCHEDULE || '0 */6 * * *';
const DEFAULT_CATEGORIES = [
  { name: 'Arcades', slug: 'arcades' },
  { name: 'Retro Games', slug: 'retro-games' },
  { name: 'PC Games', slug: 'pc-games' },
  { name: 'PS5 Games', slug: 'ps5-games' },
  { name: 'Mobile Games', slug: 'mobile-games' },
  { name: 'Upcoming Releases', slug: 'upcoming-releases' },
  { name: 'Trending', slug: 'trending' },
  { name: 'Popular', slug: 'popular' }
];
const PRIMARY_CATEGORY_ORDER = DEFAULT_CATEGORIES.map((category) => category.slug);
const DEFAULT_CATEGORY_LOOKUP = new Map(DEFAULT_CATEGORIES.map((category) => [category.slug, category]));
const CATEGORY_ALIAS_MAP = new Map([
  ['arcade', 'arcades'],
  ['arcades', 'arcades'],
  ['arcade-games', 'arcades'],
  ['retro', 'retro-games'],
  ['retro-games', 'retro-games'],
  ['retro-gaming', 'retro-games'],
  ['classic-games', 'retro-games'],
  ['pc', 'pc-games'],
  ['pc-games', 'pc-games'],
  ['computer-games', 'pc-games'],
  ['gaming', 'pc-games'],
  ['ps5', 'ps5-games'],
  ['ps5-games', 'ps5-games'],
  ['ps-5', 'ps5-games'],
  ['playstation', 'ps5-games'],
  ['playstation-5', 'ps5-games'],
  ['mobile', 'mobile-games'],
  ['mobile-games', 'mobile-games'],
  ['smartphone-games', 'mobile-games'],
  ['android-games', 'mobile-games'],
  ['ios-games', 'mobile-games'],
  ['upcoming', 'upcoming-releases'],
  ['upcoming-releases', 'upcoming-releases'],
  ['upcoming-release', 'upcoming-releases'],
  ['new-releases', 'upcoming-releases'],
  ['upcoming-relises', 'upcoming-releases'],
  ['coming-soon', 'upcoming-releases'],
  ['trending', 'trending'],
  ['trending-games', 'trending'],
  ['hot-games', 'trending'],
  ['popular', 'popular'],
  ['popular-games', 'popular'],
  ['fan-favorites', 'popular']
]);
const CATEGORY_KEYWORDS = {
  arcades: ['arcade', 'coin-op', 'arcade cabinet', 'cabinet', 'beat-em-up', 'joystick', 'pinball'],
  'retro-games': [
    'retro',
    'classic',
    '8-bit',
    '16-bit',
    'nostalgia',
    'snes',
    'nes',
    'megadrive',
    'atari'
  ],
  'pc-games': [
    'pc',
    'steam',
    'windows',
    'pc gaming',
    'pc game',
    'mod',
    'gpu',
    'keyboard',
    'mouse'
  ],
  'ps5-games': [
    'ps5',
    'playstation 5',
    'dual sense',
    'sony',
    'ps5 exclusive',
    'ps5 game',
    'console exclusive'
  ],
  'mobile-games': [
    'mobile game',
    'mobile games',
    'android',
    'ios',
    'smartphone',
    'touchscreen',
    'app store',
    'google play'
  ],
  'upcoming-releases': [
    'upcoming',
    'release date',
    'coming soon',
    'launching',
    'announcement',
    'preorder',
    'new release'
  ],
  trending: [
    'trending',
    'viral',
    'buzz',
    'hot title',
    'currently popular',
    'charting',
    'going viral'
  ],
  popular: [
    'popular',
    'fan favorite',
    'best-selling',
    'top seller',
    'player favorite',
    'top rated',
    'most played'
  ]
};

if (!FEED_URL) {
  console.warn('RSS_FEED_URL is not set. The site will not display any news until it is configured.');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.locals.siteName = 'gamingtechware.com';
app.locals.language = 'en';

const rawSiteBaseUrl = process.env.SITE_BASE_URL || 'https://gamingtechware.com';
const SITE_BASE_URL = rawSiteBaseUrl.replace(/\/$/, '');
const rawFeedPath = process.env.SITE_FEED_PATH || '/feed.xml';
const SITE_FEED_PATH = rawFeedPath.startsWith('/') ? rawFeedPath : `/${rawFeedPath}`;
const SITE_FEED_LIMIT = Math.max(parseInt(process.env.SITE_FEED_LIMIT || '30', 10), 1);
const SITE_DESCRIPTION =
  process.env.SITE_DESCRIPTION ||
  'GamingTechWare curates and rewrites the latest gaming and tech stories with full context.';
const DEFAULT_FEED_LANGUAGE = process.env.SITE_FEED_LANGUAGE || app.locals.language || 'en';
const FEED_ROUTE_PATHS = Array.from(new Set(['/feed', '/feed.xml', '/rss.xml', SITE_FEED_PATH]));
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'hello@gamingtechware.com';
const CONTACT_TWITTER =
  process.env.CONTACT_TWITTER || 'https://twitter.com/gamingtechware';
const CONTACT_LINKEDIN =
  process.env.CONTACT_LINKEDIN || 'https://www.linkedin.com/company/gamingtechware';

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.locals.siteName = app.locals.siteName;
  res.locals.language = app.locals.language;
  res.locals.primaryCategories = DEFAULT_CATEGORIES;
  res.locals.feedUrl = SITE_FEED_PATH;
  res.locals.siteBaseUrl = SITE_BASE_URL;
  const requestPath = req.originalUrl ? req.originalUrl.split('?')[0] : '/';
  res.locals.canonicalUrl = `${SITE_BASE_URL}${requestPath === '/' ? '' : requestPath}`;
  next();
});

let feedCache = {
  lastFetched: 0,
  articles: [],
  categories: []
};

const htmlEntitiesMap = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&rsquo;': "'",
  '&lsquo;': "'",
  '&rdquo;': '"',
  '&ldquo;': '"'
};

const decodeHtmlEntities = (value) =>
  (value || '').replace(/&[a-z0-9#]+;/gi, (entity) => htmlEntitiesMap[entity] || entity);

const stripHtml = (html) =>
  decodeHtmlEntities(
    (html || '')
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/\s*(p|div|article|section|li|h[1-6])\s*>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
  );

const condenseWhitespace = (value) =>
  (value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const splitIntoParagraphs = (text) =>
  (text || '')
    .split(/\n{2,}|\r\n\r\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 0);

const EXCERPT_MIN_WORDS = Math.max(parseInt(process.env.EXCERPT_MIN_WORDS || '30', 10), 5);
const EXCERPT_MAX_WORDS = Math.max(
  parseInt(process.env.EXCERPT_MAX_WORDS || '50', 10),
  EXCERPT_MIN_WORDS
);

const DEFAULT_PAGE_SIZE = Math.max(parseInt(process.env.PAGE_SIZE || '30', 10), 1);

const SYNONYM_REPLACEMENTS = new Map([
  ['announce', ['unveil', 'reveal', 'detail']],
  ['announced', ['unveiled', 'revealed', 'detailed']],
  ['announcement', ['reveal', 'debut', 'disclosure']],
  ['game', ['title', 'release', 'experience']],
  ['games', ['titles', 'releases', 'experiences']],
  ['gaming', ['interactive entertainment', 'game industry', 'play']],
  ['player', ['fan', 'gamer', 'player community']],
  ['players', ['fans', 'gamers', 'player communities']],
  ['studio', ['developer', 'team', 'game studio']],
  ['studios', ['developers', 'teams', 'game studios']],
  ['company', ['publisher', 'firm', 'organization']],
  ['companies', ['publishers', 'firms', 'organizations']],
  ['update', ['patch', 'refresh', 'revision']],
  ['updated', ['patched', 'refreshed', 'revised']],
  ['launch', ['debut', 'rollout', 'arrival']],
  ['launches', ['debuts', 'rollouts', 'arrivals']],
  ['release', ['launch', 'rollout', 'drop']],
  ['released', ['launched', 'rolled out', 'dropped']],
  ['releases', ['launches', 'rollouts', 'drops']],
  ['new', ['fresh', 'recent', 'brand-new']],
  ['latest', ['newest', 'current', 'most recent']],
  ['feature', ['capability', 'function', 'mechanic']],
  ['features', ['capabilities', 'functions', 'mechanics']],
  ['event', ['showcase', 'presentation', 'gathering']],
  ['fans', ['supporters', 'enthusiasts', 'followers']],
  ['hardware', ['gear', 'equipment', 'devices']],
  ['software', ['applications', 'programs', 'tools']],
  ['platform', ['ecosystem', 'service', 'system']],
  ['platforms', ['ecosystems', 'services', 'systems']],
  ['community', ['audience', 'crowd', 'fan base']],
  ['global', ['worldwide', 'international', 'planetwide']],
  ['world', ['global stage', 'worldwide scene', 'planet']],
  ['trend', ['movement', 'pattern', 'momentum']],
  ['trending', ['surging', 'rising', 'gaining momentum']],
  ['popular', ['fan-favorite', 'well-liked', 'widely played']]
]);

const TITLE_PREFIXES = [
  'Fresh Insight:',
  'Game Watch:',
  'Industry Brief:',
  'Play Update:',
  'Gaming Spotlight:'
];

const INTRO_PHRASES = [
  'According to the latest update, ',
  'In a fresh development, ',
  'Industry observers note that ',
  'As part of the ongoing story, ',
  'The report highlights that '
];

const SYNONYM_REGEX = new RegExp(
  `\\b(${Array.from(SYNONYM_REPLACEMENTS.keys())
    .sort((a, b) => b.length - a.length)
    .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})\\b`,
  'gi'
);

const normalizeForComparison = (value) =>
  condenseWhitespace(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ');

const tokenizeForSimilarity = (value) =>
  normalizeForComparison(value)
    .split(/\s+/)
    .filter((token) => token.length > 3);

const calculateJaccardSimilarity = (aTokens, bTokens) => {
  if (aTokens.length === 0 || bTokens.length === 0) {
    return 0;
  }
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  const intersection = [...aSet].filter((token) => bSet.has(token));
  const union = new Set([...aSet, ...bSet]);
  return intersection.length / union.size;
};

const isBodyTooSimilar = (originalText, candidateText) => {
  const similarity = calculateJaccardSimilarity(
    tokenizeForSimilarity(originalText),
    tokenizeForSimilarity(candidateText)
  );
  return similarity >= 0.8;
};

const isTitleSimilar = (originalTitle, candidateTitle) =>
  normalizeForComparison(originalTitle) === normalizeForComparison(candidateTitle);

const hashString = (value) => {
  let hash = 0;
  const text = value || '';
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash);
};

const preserveCase = (original, replacement) => {
  if (!original) {
    return replacement;
  }
  if (original === original.toUpperCase()) {
    return replacement.toUpperCase();
  }
  if (original[0] === original[0].toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
};

const applySynonymReplacements = (text) =>
  (text || '').replace(SYNONYM_REGEX, (match) => {
    const alternatives = SYNONYM_REPLACEMENTS.get(match.toLowerCase());
    if (!alternatives || alternatives.length === 0) {
      return match;
    }
    const choice = alternatives[hashString(match) % alternatives.length];
    return preserveCase(match, choice);
  });

const capitalizeSentence = (sentence) => {
  const trimmed = sentence.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
};

const ensureSentenceTermination = (sentence) =>
  /[.!?…]$/.test(sentence) ? sentence : `${sentence}.`;

const rewriteParagraphLocally = (paragraph) => {
  const sentences = (paragraph || '')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);

  if (sentences.length === 0) {
    return '';
  }

  if (sentences.length > 1) {
    const firstSentence = sentences.shift();
    sentences.push(firstSentence);
  }

  const introPrefix = INTRO_PHRASES[hashString(paragraph) % INTRO_PHRASES.length];

  const rewrittenSentences = sentences.map((sentence, index) => {
    let transformed = applySynonymReplacements(sentence);

    if (index === 0) {
      const lowered =
        transformed.length > 1
          ? transformed.charAt(0).toLowerCase() + transformed.slice(1)
          : transformed.toLowerCase();
      transformed = `${introPrefix}${lowered}`;
    }

    transformed = ensureSentenceTermination(capitalizeSentence(transformed));
    return transformed;
  });

  return condenseWhitespace(rewrittenSentences.join(' '));
};

const generateUniqueTitleLocally = (title, referenceParagraphs) => {
  const prefix = TITLE_PREFIXES[hashString(title) % TITLE_PREFIXES.length];
  const base = applySynonymReplacements(title || '');
  const capitalized = capitalizeSentence(base);
  let candidate = `${prefix} ${capitalized}`.trim();

  if (isTitleSimilar(title, candidate)) {
    const fallbackDetail =
      referenceParagraphs && referenceParagraphs.length > 0
        ? referenceParagraphs[0].slice(0, 60)
        : '';
    candidate = `${prefix} ${capitalizeSentence(applySynonymReplacements(fallbackDetail))}`.trim();
    if (!candidate) {
      candidate = `${prefix} ${capitalizeSentence('Latest gaming development')}`;
    }
  }

  return candidate;
};

const localRewriteArticle = (title, content, originalParagraphs) => {
  const baseParagraphs =
    Array.isArray(originalParagraphs) && originalParagraphs.length > 0
      ? originalParagraphs
      : splitIntoParagraphs(content);

  const rewrittenParagraphs = baseParagraphs
    .map((paragraph) => rewriteParagraphLocally(paragraph))
    .filter((paragraph) => paragraph.length > 0);

  if (rewrittenParagraphs.length === 0) {
    rewrittenParagraphs.push(capitalizeSentence(applySynonymReplacements(condenseWhitespace(content))));
  }

  const body = rewrittenParagraphs.join('\n\n');
  const uniqueTitle = generateUniqueTitleLocally(title, rewrittenParagraphs);

  return {
    title: uniqueTitle,
    body,
    paragraphs: rewrittenParagraphs
  };
};

const ensureUniqueRewrite = async (title, originalBody) => {
  const primaryResult = await rewriteWithGrok(title, originalBody);
  const candidateTitle =
    primaryResult && primaryResult.title ? primaryResult.title : title;
  const candidateBody =
    primaryResult && primaryResult.body ? primaryResult.body : originalBody;
  let candidateParagraphs = splitIntoParagraphs(candidateBody);

  const originalNormalized = condenseWhitespace(originalBody);
  const candidateNormalized = condenseWhitespace(candidateBody);

  let finalTitle = candidateTitle;
  let finalBody = candidateBody;
  let finalParagraphs = candidateParagraphs;

  const requiresFallback =
    candidateParagraphs.length === 0 ||
    isBodyTooSimilar(originalNormalized, candidateNormalized);

  if (requiresFallback) {
    return localRewriteArticle(title, originalBody, splitIntoParagraphs(originalBody));
  }

  if (isTitleSimilar(title, candidateTitle)) {
    finalTitle = generateUniqueTitleLocally(title, candidateParagraphs);
  }

  if (isBodyTooSimilar(originalNormalized, candidateNormalized)) {
    const fallback = localRewriteArticle(title, originalBody, splitIntoParagraphs(originalBody));
    finalTitle = fallback.title;
    finalBody = fallback.body;
    finalParagraphs = fallback.paragraphs;
  } else {
    finalBody = candidateParagraphs.join('\n\n');
  }

  if (finalParagraphs.length === 0) {
    finalParagraphs = splitIntoParagraphs(finalBody);
  }

  return {
    title: finalTitle,
    body: finalBody,
    paragraphs: finalParagraphs
  };
};

const createExcerpt = ({ paragraphs, content, originalContent }) => {
  const sourceText = Array.isArray(paragraphs) && paragraphs.length > 0
    ? paragraphs.join(' ')
    : condenseWhitespace(content || originalContent || '');

  if (!sourceText) {
    return '';
  }

  const normalized = condenseWhitespace(sourceText);
  const words = normalized
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);

  if (words.length === 0) {
    return '';
  }

  const desiredLength = Math.min(EXCERPT_MAX_WORDS, Math.max(EXCERPT_MIN_WORDS, words.length));
  const excerptWords = words.slice(0, desiredLength);

  let excerpt = excerptWords.join(' ');
  if (!/[.!?…]$/.test(excerpt) && words.length > desiredLength) {
    excerpt = `${excerpt}…`;
  }

  return excerpt;
};

const extractOriginalBody = (item) => {
  const candidates = [
    item['content:encoded'],
    item.content,
    item.summary,
    item.description,
    item.contentSnippet
  ];
  const raw = candidates.find((entry) => typeof entry === 'string' && entry.trim().length > 0) || '';
  const stripped = stripHtml(raw);
  return condenseWhitespace(stripped);
};

const ARTICLE_CANDIDATE_SELECTORS = [
  'article',
  'main',
  '[role="main"]',
  '#main',
  '#content',
  '.content',
  '.post-content',
  '.entry-content',
  '.article-content',
  '.article-body',
  '.story-body',
  '.post-body',
  '.blog-post',
  '.single-post',
  '.news-content',
  '.news-article',
  'div[class*="article"]',
  'div[class*="content"]',
  'section[class*="article"]',
  'section[class*="content"]'
];

const sanitizeCheerioText = (text) =>
  condenseWhitespace((text || '').replace(/\u00a0/g, ' '));

const extractParagraphsFromElement = ($, element) => {
  const $element = $(element);
  const paragraphs = [];
  $element.find('p').each((_, paragraph) => {
    const text = sanitizeCheerioText($(paragraph).text());
    if (text.length >= 40) {
      paragraphs.push(text);
    }
  });

  if (paragraphs.length === 0) {
    const fallback = sanitizeCheerioText($element.text());
    if (fallback.length > 120) {
      paragraphs.push(fallback);
    }
  }

  return paragraphs;
};

const extractMainContentFromHtml = (html) => {
  if (!html || typeof html !== 'string') {
    return '';
  }

  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe, form, aside, header, footer, nav, video, audio').remove();

  let bestContent = '';
  let bestScore = 0;

  ARTICLE_CANDIDATE_SELECTORS.forEach((selector) => {
    $(selector).each((_, element) => {
      const paragraphs = extractParagraphsFromElement($, element);
      const combined = paragraphs.join('\n\n');
      const wordCount = combined.split(/\s+/).filter(Boolean).length;
      const score = wordCount + paragraphs.length * 20;

      if (wordCount >= 80 && score > bestScore) {
        bestScore = score;
        bestContent = combined;
      }
    });
  });

  if (!bestContent) {
    const paragraphs = [];
    $('p').each((_, element) => {
      const text = sanitizeCheerioText($(element).text());
      if (text.length >= 40) {
        paragraphs.push(text);
      }
    });
    const combined = paragraphs.join('\n\n');
    if (combined.length > bestContent.length) {
      bestContent = combined;
    }
  }

  return bestContent;
};

const fetchFullArticleBody = async (item) => {
  const fallbackContent = extractOriginalBody(item);
  const link = item && item.link ? item.link.trim() : '';

  if (!link) {
    return fallbackContent;
  }

  try {
    const response = await axios.get(link, {
      maxContentLength: 512 * 1024,
      timeout: 15000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
      }
    });

    const html = response && response.data;
    if (typeof html !== 'string') {
      return fallbackContent;
    }

    const extracted = extractMainContentFromHtml(html);
    if (extracted && extracted.length > fallbackContent.length) {
      return extracted;
    }

    return extracted || fallbackContent;
  } catch (error) {
    console.warn(`Failed to fetch full article from ${link}: ${error.message}`);
  }

  return fallbackContent;
};

const slugify = (value) =>
  value
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '') || 'general';

const createArticleSlugFromTitle = (title) => {
  if (!title || !title.trim()) {
    return 'tech-brief';
  }

  const cleaned = title
    .toLowerCase()
    .replace(/['"`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return 'tech-brief';
  }

  let baseSlug = cleaned.replace(/\s+/g, '-').replace(/-+/g, '-');

  const MAX_SLUG_LENGTH = 120;
  if (baseSlug.length > MAX_SLUG_LENGTH) {
    const trimmed = baseSlug.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '');
    baseSlug = trimmed || baseSlug;
  }

  return baseSlug || 'tech-brief';
};

const ensureUniqueSlug = (baseSlug, usedSlugs) => {
  let candidate = baseSlug || 'article';
  let counter = 2;
  while (usedSlugs.has(candidate)) {
    candidate = `${baseSlug}-${counter++}`;
  }
  usedSlugs.add(candidate);
  return candidate;
};

const parseJsonSafe = (text) => {
  if (!text || typeof text !== 'string') {
    return null;
  }

  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    return null;
  }
};

const normalizeRewrittenBody = (body) => {
  if (Array.isArray(body)) {
    return body
      .map((paragraph) => (typeof paragraph === 'string' ? paragraph.trim() : ''))
      .filter((paragraph) => paragraph.length > 0)
      .join('\n\n');
  }

  if (typeof body === 'string') {
    return body
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .trim();
  }

  return '';
};

const escapeForXml = (value) =>
  (value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const sanitizeCdataValue = (value) => (value || '').replace(/]]>/g, ']]]]><![CDATA[>');

const wrapCdata = (value) => `<![CDATA[${sanitizeCdataValue(value)}]]>`;

const buildArticleUrl = (slug, fallbackLink) => {
  if (slug) {
    return `${SITE_BASE_URL}/news/${slug}`;
  }

  if (fallbackLink && /^https?:\/\//i.test(fallbackLink)) {
    return fallbackLink;
  }

  return SITE_BASE_URL;
};

const renderParagraphsAsHtml = (paragraphs, fallbackText) => {
  if (Array.isArray(paragraphs) && paragraphs.length > 0) {
    return paragraphs
      .map((paragraph) => `<p>${escapeForXml(paragraph)}</p>`)
      .join('\n');
  }

  const fallback = condenseWhitespace(fallbackText || '');
  return fallback ? `<p>${escapeForXml(fallback)}</p>` : '';
};

const buildArticleDescription = (paragraphs, fallbackText) => {
  if (Array.isArray(paragraphs) && paragraphs.length > 0) {
    return condenseWhitespace(paragraphs.slice(0, 2).join(' '));
  }

  return condenseWhitespace(fallbackText || '').slice(0, 400);
};

const resolveArticleParagraphs = (article) => {
  if (Array.isArray(article.paragraphs) && article.paragraphs.length > 0) {
    return article.paragraphs;
  }

  const text = article.content || article.originalContent || '';
  return splitIntoParagraphs(text);
};

const buildRssFeedXml = (articles) => {
  const siteName = app.locals.siteName || 'gamingtechware.com';
  const description = SITE_DESCRIPTION;
  const feedArticles = (articles || []).slice(0, SITE_FEED_LIMIT);

  const items = feedArticles
    .map((article) => {
      const paragraphs = resolveArticleParagraphs(article);
      const fallbackText = article.content || article.originalContent || '';
      const articleHtml = renderParagraphsAsHtml(paragraphs, fallbackText);
      const descriptionText = buildArticleDescription(paragraphs, fallbackText);
      const articleUrl = buildArticleUrl(article.slug, article.link);
      const publishedDate = article.publishedAt
        ? new Date(article.publishedAt)
        : article.rewrittenAt
        ? new Date(article.rewrittenAt)
        : new Date();
      const pubDate = isNaN(publishedDate.getTime())
        ? new Date().toUTCString()
        : publishedDate.toUTCString();
      const itemLines = [
        '    <item>',
        `      <title>${escapeForXml(article.title || article.originalTitle || 'Latest update')}</title>`,
        `      <link>${escapeForXml(articleUrl)}</link>`,
        `      <guid isPermaLink="true">${escapeForXml(articleUrl)}</guid>`,
        `      <pubDate>${pubDate}</pubDate>`
      ];

      if (article.author) {
        itemLines.push(`      <author>${escapeForXml(article.author)}</author>`);
      }

      if (Array.isArray(article.categories)) {
        article.categories.forEach((category) => {
          if (category && category.name) {
            itemLines.push(`      <category>${escapeForXml(category.name)}</category>`);
          }
        });
      }

      if (article.link && /^https?:\/\//i.test(article.link)) {
        let sourceLabel = article.link;
        try {
          sourceLabel = new URL(article.link).hostname;
        } catch (error) {
          sourceLabel = article.link;
        }
        itemLines.push(
          `      <source url="${escapeForXml(article.link)}">${escapeForXml(sourceLabel)}</source>`
        );
      }

      itemLines.push(`      <description>${wrapCdata(descriptionText)}</description>`);
      itemLines.push(`      <content:encoded>${wrapCdata(articleHtml)}</content:encoded>`);
      itemLines.push('    </item>');

      return itemLines.join('\n');
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeForXml(siteName)}</title>
    <link>${escapeForXml(SITE_BASE_URL)}</link>
    <description>${escapeForXml(description)}</description>
    <language>${escapeForXml(DEFAULT_FEED_LANGUAGE)}</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;
};

const formatIsoDate = (value) => {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
};

const buildSitemapXml = (articles, categories, lastFetched) => {
  const urls = [];
  const seen = new Set();
  const pushUrl = (path, { lastmod, priority, changefreq } = {}) => {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    if (seen.has(normalizedPath)) {
      return;
    }
    seen.add(normalizedPath);

    const entryLines = [
      '  <url>',
      `    <loc>${escapeForXml(`${SITE_BASE_URL}${normalizedPath}`)}</loc>`
    ];

    if (lastmod) {
      entryLines.push(`    <lastmod>${escapeForXml(lastmod)}</lastmod>`);
    }
    if (changefreq) {
      entryLines.push(`    <changefreq>${escapeForXml(changefreq)}</changefreq>`);
    }
    if (priority) {
      entryLines.push(`    <priority>${escapeForXml(priority.toFixed(1))}</priority>`);
    }

    entryLines.push('  </url>');
    urls.push(entryLines.join('\n'));
  };

  const defaultLastMod = formatIsoDate(lastFetched) || new Date().toISOString();

  pushUrl('/', { lastmod: defaultLastMod, priority: 1.0, changefreq: 'hourly' });
  pushUrl(SITE_FEED_PATH, { lastmod: defaultLastMod, changefreq: 'hourly', priority: 0.6 });

  const categoryList =
    (Array.isArray(categories) && categories.length > 0 ? categories : DEFAULT_CATEGORIES) || [];

  categoryList.forEach((category) => {
    if (!category || !category.slug) {
      return;
    }

    let lastmod = defaultLastMod;
    if (Array.isArray(articles) && articles.length > 0) {
      const latest = articles.find((article) =>
        Array.isArray(article.categories)
          ? article.categories.some((entry) => entry && entry.slug === category.slug)
          : false
      );
      if (latest) {
        lastmod =
          formatIsoDate(latest.publishedAt) ||
          formatIsoDate(latest.rewrittenAt) ||
          defaultLastMod;
      }
    }

    pushUrl(`/category/${category.slug}`, {
      lastmod,
      changefreq: 'hourly',
      priority: 0.8
    });
  });

  (articles || []).forEach((article) => {
    if (!article || !article.slug) {
      return;
    }

    const lastmod =
      formatIsoDate(article.publishedAt) ||
      formatIsoDate(article.rewrittenAt) ||
      defaultLastMod;

    pushUrl(`/news/${article.slug}`, {
      lastmod,
      changefreq: 'hourly',
      priority: 0.9
    });
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`;
};

const renderStaticPage =
  (template, extraLocals = {}) =>
  async (req, res, next) => {
    try {
      const { categories, lastFetched } = await fetchFeed();
      res.render(template, {
        categories,
        lastFetched,
        ...extraLocals
      });
    } catch (error) {
      next(error);
    }
  };

const rewriteWithGrok = async (title, content) => {
  const apiUrl = process.env.GROK_API_URL;
  const apiKey = process.env.GROK_API_KEY;
  const model = process.env.GROK_MODEL || 'xai/grok-2-latest';

  if (!apiUrl || !apiKey) {
    return { title, body: content };
  }

  const isOpenRouter = /openrouter\.ai/.test(apiUrl);

  try {
    const payload = isOpenRouter
      ? {
          model,
          messages: [
            {
              role: 'system',
              content:
                'You rewrite full technology news articles in English. Your job is to produce entirely original wording: craft a new, unique headline and rewrite every paragraph so no sentences or phrasing are copied verbatim. Preserve factual accuracy, include all key details, and maintain a neutral, journalistic tone. Respond as compact JSON with the shape {"title": "...", "body": ["paragraph 1", "paragraph 2", ...]} without additional commentary.'
            },
            {
              role: 'user',
              content: `Rewrite the following technology news article. Provide a reworded headline that does not reuse the original phrasing, and rewrite every paragraph in new language while keeping all facts intact. Avoid copying sentences wholesale. Respond with JSON only.\n\nOriginal Title: ${title}\n\nOriginal Article:\n${content}`
            }
          ],
          max_output_tokens: 1600
        }
      : {
          model,
          prompt: `Rewrite the following technology news article for an English-speaking audience. Produce entirely new wording: craft a unique headline with different phrasing and rewrite every paragraph so the language is original while all facts, figures, and context remain accurate. Respond ONLY with a JSON object using this shape: {"title": "rewritten headline", "body": ["paragraph 1", "paragraph 2", "..."]}.\n\nOriginal Title: ${title}\n\nOriginal Article:\n${content}`
        };

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(isOpenRouter
        ? {
            'HTTP-Referer': process.env.OPENROUTER_REFERRER || 'http://localhost:3000',
            'X-Title': process.env.OPENROUTER_SITE_TITLE || 'gamingtechware.com'
          }
        : {
            'Accept-Language': 'en'
          })
    };

    const response = await axios.post(apiUrl, payload, {
      headers,
      timeout: 15000
    });

    if (response.data && typeof response.data === 'object') {
      if (isOpenRouter) {
        const choice = response.data.choices && response.data.choices[0];
        const rawContent = choice && choice.message && choice.message.content;
        const text = Array.isArray(rawContent)
          ? rawContent
              .map((segment) =>
                typeof segment === 'string'
                  ? segment
                  : segment && typeof segment === 'object' && segment.text
                  ? segment.text
                  : ''
              )
              .join('')
          : rawContent;
        if (text) {
          const parsedObject = parseJsonSafe(text) || { body: text };
          const normalizedTitle =
            parsedObject && typeof parsedObject === 'object' && parsedObject.title
              ? String(parsedObject.title).trim()
              : title;
          const normalizedBody =
            parsedObject && typeof parsedObject === 'object' && parsedObject.body
              ? normalizeRewrittenBody(parsedObject.body)
              : condenseWhitespace(text);
          return {
            title: normalizedTitle || title,
            body: normalizedBody || content
          };
        }
      }

      const normalizedPayload =
        response.data.rewrite || response.data.content || response.data.text;

      if (normalizedPayload) {
        const parsedPayload = parseJsonSafe(normalizedPayload);
        const normalizedTitle =
          parsedPayload && parsedPayload.title
            ? String(parsedPayload.title).trim()
            : title;
        const normalizedBody =
          parsedPayload && parsedPayload.body
            ? normalizeRewrittenBody(parsedPayload.body)
            : condenseWhitespace(normalizedPayload);

        return {
          title: normalizedTitle || title,
          body: normalizedBody || content
        };
      }
    }
  } catch (error) {
    console.warn('Grok rewrite failed, falling back to original content:', error.message);
  }

  return { title, body: content };
};

const normalizeCategoryEntry = (category) => {
  const resolveCategory = (nameOrSlug) => {
    if (!nameOrSlug) {
      return null;
    }

    let slug = slugify(nameOrSlug);
    if (slug === 'general') {
      slug = 'pc-games';
    }
    slug = CATEGORY_ALIAS_MAP.get(slug) || slug;

    return DEFAULT_CATEGORY_LOOKUP.get(slug) || null;
  };

  if (category && typeof category === 'object') {
    const name = category.name || category.label || category.title;
    const fromSlug = resolveCategory(category.slug);
    if (fromSlug) {
      return fromSlug;
    }

    const fromName = resolveCategory(name);
    if (fromName) {
      return fromName;
    }

    return null;
  }

  if (typeof category === 'string' && category.trim().length > 0) {
    const resolved = resolveCategory(category);
    if (resolved) {
      return resolved;
    }
    return null;
  }

  return DEFAULT_CATEGORY_LOOKUP.get('pc-games') || null;
};

const deriveCategoriesFromKeywords = (article) => {
  const text = `${article.title || ''} ${article.originalContent || ''} ${article.content || ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const detected = [];

  Object.entries(CATEGORY_KEYWORDS).forEach(([slug, keywords]) => {
    if (keywords.some((keyword) => text.includes(keyword))) {
      const entry = DEFAULT_CATEGORY_LOOKUP.get(slug);
      if (entry) {
        detected.push(entry);
      }
    }
  });

  if (detected.length === 0) {
    const fallback = DEFAULT_CATEGORY_LOOKUP.get('pc-games');
    if (fallback) {
      detected.push(fallback);
    }
  }

  return detected;
};

const buildCategoryMap = (articles) => {
  const categoryMap = new Map(DEFAULT_CATEGORY_LOOKUP);

  articles.forEach((article) => {
    if (!Array.isArray(article.paragraphs) || article.paragraphs.length === 0) {
      article.paragraphs = splitIntoParagraphs(article.content || article.originalContent || '');
    }

    if (!article.excerpt) {
      article.excerpt = createExcerpt({
        paragraphs: article.paragraphs,
        content: article.content,
        originalContent: article.originalContent
      });
    }

    const { categories } = article;
    let normalizedCategories =
      categories && categories.length > 0
        ? categories
            .map((category) => normalizeCategoryEntry(category))
            .filter((category) => Boolean(category && category.slug))
        : [];

    if (
      normalizedCategories.length === 0 ||
      normalizedCategories.every((category) => category.slug === 'pc-games')
    ) {
      normalizedCategories = deriveCategoriesFromKeywords(article);
    }

    const deduped = [];
    const seen = new Set();
    normalizedCategories.forEach((category) => {
      if (category && category.slug && !seen.has(category.slug)) {
        seen.add(category.slug);
        deduped.push(category);
      }
    });

    if (deduped.length === 0) {
      const fallback = DEFAULT_CATEGORY_LOOKUP.get('pc-games');
      if (fallback) {
        deduped.push(fallback);
      }
    }

    const limited = deduped.slice(0, 4);
    article.categories = limited;
    limited.forEach((category) => categoryMap.set(category.slug, category));
  });

  return PRIMARY_CATEGORY_ORDER.map((slug) => categoryMap.get(slug)).filter(Boolean);
};

const mergeArticles = (existingArticles, incomingArticles) => {
  const combined = [...incomingArticles, ...existingArticles];
  const seen = new Set();
  const merged = [];

  combined.forEach((article) => {
    if (!seen.has(article.slug)) {
      seen.add(article.slug);
      merged.push(article);
    }
  });

  return merged.sort((a, b) => {
    const aDate = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const bDate = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return bDate - aDate;
  });
};

const fetchFeed = async (forceRefresh = false) => {
  const now = Date.now();
  const shouldUseCache =
    !forceRefresh &&
    feedCache.articles.length > 0 &&
    now - feedCache.lastFetched < REFRESH_INTERVAL_MS;

  if (shouldUseCache) {
    return feedCache;
  }

  if (!FEED_URL) {
    feedCache = { lastFetched: now, articles: [], categories: [] };
    return feedCache;
  }

  try {
    const feed = await parser.parseURL(FEED_URL);
    const existingSlugs = new Set(feedCache.articles.map((article) => article.slug));
    const existingSources = new Set(
      feedCache.articles
        .map((article) => article.sourceId || article.id || article.link)
        .filter((identifier) => Boolean(identifier))
    );
    const usedSlugs = new Set(existingSlugs);
    const feedItems = [];

    (feed.items || []).some((item, index) => {
      const title = item.title || `Untitled #${index + 1}`;
      const sourceId = item.guid || item.id || item.link || '';
      if (sourceId && existingSources.has(sourceId)) {
        return false;
      }

      const baseSlug = createArticleSlugFromTitle(title);
      const slug = ensureUniqueSlug(baseSlug, usedSlugs);

      if (feedItems.length < MAX_ARTICLES_PER_REFRESH) {
        feedItems.push({ item, slug, index, title, sourceId });
      }
      return feedItems.length >= MAX_ARTICLES_PER_REFRESH;
    });

    if (feedItems.length === 0) {
      feedCache.lastFetched = now;
      feedCache.categories = buildCategoryMap(feedCache.articles);
      return feedCache;
    }

    const newArticles = await Promise.all(
      feedItems.map(async ({ item, slug, index, title, sourceId }) => {
        const originalBody = await fetchFullArticleBody(item);
        const rewriteResult = await ensureUniqueRewrite(title, originalBody);
        const normalizedParagraphs =
          Array.isArray(rewriteResult.paragraphs) && rewriteResult.paragraphs.length > 0
            ? rewriteResult.paragraphs
            : splitIntoParagraphs(rewriteResult.body);
        const fullContent =
          normalizedParagraphs.length > 0
            ? normalizedParagraphs.join('\n\n')
            : condenseWhitespace(rewriteResult.body || originalBody);
        const finalTitle = rewriteResult.title || title;
        const excerpt = createExcerpt({
          paragraphs: normalizedParagraphs,
          content: fullContent,
          originalContent: originalBody
        });

        const sourceIdentifier = sourceId || slug;
        return {
          id: sourceIdentifier,
          sourceId: sourceIdentifier,
          slug,
          title: finalTitle,
          originalTitle: title,
          link: item.link,
          originalContent: originalBody,
          content: fullContent,
          paragraphs: normalizedParagraphs,
          excerpt,
          rewrittenAt: now,
          categories:
            item.categories && item.categories.length > 0
              ? item.categories
              : item.category
              ? [item.category]
              : ['PC Games'],
          publishedAt: item.isoDate || item.pubDate || null,
          author: 'Editorial Team'
        };
      })
    );

    const mergedArticles = mergeArticles(feedCache.articles, newArticles);
    const categories = buildCategoryMap(mergedArticles);
    feedCache = {
      lastFetched: now,
      articles: mergedArticles,
      categories
    };
  } catch (error) {
    console.error('Failed to fetch RSS feed:', error.message);
    feedCache.lastFetched = now;
    feedCache.categories = buildCategoryMap(feedCache.articles);
  }

  return feedCache;
};

app.get(
  '/about',
  renderStaticPage('about', {
    pageTitle: 'About Gaming Tech Ware'
  })
);

app.get(
  '/editorial-guidelines',
  renderStaticPage('editorial-guidelines', {
    pageTitle: 'Editorial Guidelines',
    contactEmail: CONTACT_EMAIL
  })
);

app.get(
  '/editorial-team',
  renderStaticPage('editorial-team', {
    pageTitle: 'Editorial Team'
  })
);

app.get(
  '/terms-of-use',
  renderStaticPage('terms', {
    pageTitle: 'Terms of Use',
    contactEmail: CONTACT_EMAIL
  })
);

app.get(
  '/privacy-policy',
  renderStaticPage('privacy', {
    pageTitle: 'Privacy Policy',
    contactEmail: CONTACT_EMAIL
  })
);

app.get(
  '/contact',
  renderStaticPage('contact', {
    pageTitle: 'Contact',
    contactEmail: CONTACT_EMAIL,
    contactTwitter: CONTACT_TWITTER,
    contactLinkedIn: CONTACT_LINKEDIN
  })
);

app.get('/sitemap.xml', async (req, res, next) => {
  try {
    const { articles, categories, lastFetched } = await fetchFeed();
    const xml = buildSitemapXml(articles, categories, lastFetched);
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  } catch (error) {
    next(error);
  }
});

app.get(FEED_ROUTE_PATHS, async (req, res, next) => {
  try {
    const { articles } = await fetchFeed();
    const xml = buildRssFeedXml(articles);
    res.set('Content-Type', 'application/rss+xml; charset=utf-8');
    res.send(xml);
  } catch (error) {
    next(error);
  }
});

app.get('/rss-feed', async (req, res, next) => {
  try {
    const { categories, articles, lastFetched } = await fetchFeed();
    const absoluteFeedUrl = `${SITE_BASE_URL}${SITE_FEED_PATH}`;
    res.render('rss-feed', {
      categories,
      articles,
      lastFetched,
      feedUrl: SITE_FEED_PATH,
      absoluteFeedUrl,
      siteDescription: SITE_DESCRIPTION
    });
  } catch (error) {
    next(error);
  }
});

app.get('/', async (req, res, next) => {
  try {
    const { categories, articles, lastFetched } = await fetchFeed();
    const totalArticles = articles.length;
    let page = parseInt(req.query.page, 10);
    if (Number.isNaN(page) || page < 1) {
      page = 1;
    }
    const totalPages = totalArticles > 0 ? Math.ceil(totalArticles / DEFAULT_PAGE_SIZE) : 1;
    if (page > totalPages) {
      page = totalPages;
    }

    const startIndex = (page - 1) * DEFAULT_PAGE_SIZE;
    const endIndex = startIndex + DEFAULT_PAGE_SIZE;
    const paginatedArticles = articles.slice(startIndex, endIndex);

    res.render('home', {
      categories,
      articles: paginatedArticles,
      lastFetched,
      pagination: {
        page,
        totalPages,
        totalItems: totalArticles,
        pageSize: DEFAULT_PAGE_SIZE,
        hasPrevious: page > 1,
        hasNext: page < totalPages,
        basePath: req.path,
        pageParam: 'page'
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get('/category/:categorySlug', async (req, res, next) => {
  try {
    const { categorySlug } = req.params;
    const { categories, articles, lastFetched } = await fetchFeed();
    const category = categories.find((entry) => entry.slug === categorySlug);

    if (!category) {
      return res.status(404).render('not-found', { message: 'Category not found.' });
    }

    const categoryArticlesAll = articles.filter((article) =>
      article.categories.some((entry) => entry.slug === categorySlug)
    );

    const totalArticles = categoryArticlesAll.length;
    let page = parseInt(req.query.page, 10);
    if (Number.isNaN(page) || page < 1) {
      page = 1;
    }
    const totalPages = totalArticles > 0 ? Math.ceil(totalArticles / DEFAULT_PAGE_SIZE) : 1;
    if (page > totalPages) {
      page = totalPages;
    }

    const startIndex = (page - 1) * DEFAULT_PAGE_SIZE;
    const endIndex = startIndex + DEFAULT_PAGE_SIZE;
    const categoryArticles = categoryArticlesAll.slice(startIndex, endIndex);

    res.render('category', {
      category,
      categories,
      articles: categoryArticles,
      lastFetched,
      pagination: {
        page,
        totalPages,
        totalItems: totalArticles,
        pageSize: DEFAULT_PAGE_SIZE,
        hasPrevious: page > 1,
        hasNext: page < totalPages,
        basePath: req.path,
        pageParam: 'page'
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get('/news/:articleSlug', async (req, res, next) => {
  try {
    const { articleSlug } = req.params;
    const { categories, articles, lastFetched } = await fetchFeed();
    const article = articles.find((entry) => entry.slug === articleSlug);

    if (!article) {
      return res.status(404).render('not-found', { message: 'Article not found.' });
    }

    res.render('article', {
      article,
      categories,
      lastFetched
    });
  } catch (error) {
    next(error);
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', fetchedAt: feedCache.lastFetched });
});

app.use((req, res) => {
  res.status(404).render('not-found', { message: 'Page not found.' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { message: 'An unexpected error occurred.' });
});

cron.schedule(FEED_CRON_SCHEDULE, async () => {
  console.log(`Scheduled feed refresh triggered at ${new Date().toISOString()}`);
  try {
    await fetchFeed(true);
    console.log('Scheduled feed refresh completed.');
  } catch (error) {
    console.error('Scheduled feed refresh failed:', error.message);
  }
});

fetchFeed(true).catch((error) => {
  console.error('Initial feed preload failed:', error.message);
});

app.listen(PORT, () => {
  console.log(`gamingtechware.com stage server running at http://localhost:${PORT}`);
});
