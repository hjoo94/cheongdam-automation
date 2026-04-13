const DEFAULT_KEYWORDS = ['자영업자이야기', '자영업', '소상공인', '장사', '매출', '배민', '쿠팡이츠'];
const DEFAULT_FIELDS = [
  'id',
  'text',
  'permalink',
  'timestamp',
  'username',
  'like_count',
  'reply_count',
  'repost_count',
  'quote_count',
  'view_count',
].join(',');
const ALLOWED_THREADS_API_HOSTS = new Set(['graph.threads.net']);

function normalizeKeywordList(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(/[\n,;]+/);
  return items
    .map((item) => String(item || '').replace(/^#/, '').trim())
    .filter(Boolean)
    .slice(0, 12);
}

function daysAgoIso(days = 7) {
  return new Date(Date.now() - Number(days || 7) * 24 * 60 * 60 * 1000).toISOString();
}

function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value || '').replace(/,/g, '').trim();
  const match = text.match(/(\d+(?:\.\d+)?)\s*([kKmM만천]?)/);
  if (!match) return 0;
  const base = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(base)) return 0;
  if (/m/i.test(unit)) return Math.round(base * 1000000);
  if (/k/i.test(unit)) return Math.round(base * 1000);
  if (unit === '만') return Math.round(base * 10000);
  if (unit === '천') return Math.round(base * 1000);
  return Math.round(base);
}

function extractMetric(text, names) {
  for (const name of names) {
    const pattern = new RegExp(`${name}\\s*[:：]?\\s*([0-9,.]+\\s*(?:k|m|만|천)?)`, 'i');
    const match = String(text || '').match(pattern);
    if (match) return parseNumber(match[1]);
  }
  return 0;
}

function normalizePost(raw = {}, source = 'threads') {
  const text = String(raw.text || raw.caption || raw.message || raw.body || raw.content || '').trim();
  const likeCount = Number(raw.like_count ?? raw.likes ?? raw.likeCount ?? 0) || extractMetric(text, ['좋아요', 'likes', 'like']);
  const replyCount = Number(raw.reply_count ?? raw.replies ?? raw.comment_count ?? raw.comments ?? 0) || extractMetric(text, ['댓글', '답글', 'replies', 'comments']);
  const repostCount = Number(raw.repost_count ?? raw.reposts ?? raw.share_count ?? raw.shares ?? 0) || extractMetric(text, ['리포스트', '공유', 'reposts', 'shares']);
  const quoteCount = Number(raw.quote_count ?? raw.quotes ?? 0) || extractMetric(text, ['인용', 'quotes']);
  const viewCount = Number(raw.view_count ?? raw.views ?? raw.impressions ?? 0) || extractMetric(text, ['조회수', '조회', 'views', 'impressions']);
  const timestamp = raw.timestamp || raw.created_time || raw.createdAt || '';

  return {
    id: String(raw.id || raw.pk || raw.code || raw.url || text.slice(0, 40)),
    text,
    permalink: String(raw.permalink || raw.url || ''),
    username: String(raw.username || raw.owner?.username || raw.user?.username || ''),
    timestamp,
    likeCount,
    replyCount,
    repostCount,
    quoteCount,
    viewCount,
    score: viewCount * 0.2 + likeCount * 3 + replyCount * 5 + repostCount * 6 + quoteCount * 6,
    source,
  };
}

function parseManualPosts(text = '') {
  return String(text || '')
    .split(/\n\s*\n+/)
    .map((block) => normalizePost({ text: block }, 'manual'))
    .filter((item) => item.text.length >= 10);
}

/** 배민·쿠팡 리뷰·사장님 답글 예시 텍스트(캡처 내용 요약·붙여넣기) */
function parseReviewReplyExamples(text = '') {
  return String(text || '')
    .split(/\n\s*\n+/)
    .map((block) => {
      const post = normalizePost({ text: block }, 'review-reply');
      return { ...post, score: post.score + 900 };
    })
    .filter((item) => item.text.length >= 6);
}

function normalizeThreadsApiBaseUrl(value) {
  const raw = String(value || 'https://graph.threads.net/v1.0').trim();
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return '';
    if (!ALLOWED_THREADS_API_HOSTS.has(parsed.hostname)) return '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function flattenThreadsResponse(data = {}) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.media)) return data.media;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

function buildSearchUrls({ apiBaseUrl, keyword, sinceIso, limit }) {
  const base = normalizeThreadsApiBaseUrl(apiBaseUrl) || 'https://graph.threads.net/v1.0';
  const encodedKeyword = encodeURIComponent(keyword);
  const common = `query=${encodedKeyword}&q=${encodedKeyword}&search_terms=${encodedKeyword}&fields=${encodeURIComponent(DEFAULT_FIELDS)}&limit=${limit}&since=${encodeURIComponent(sinceIso)}`;

  return [
    `${base}/keyword_search?${common}`,
    `${base}/threads/search?${common}`,
    `${base}/search?type=media&${common}`,
  ];
}

async function fetchThreadsKeywordPosts({ accessToken = '', apiBaseUrl = '', keywords = [], sinceIso = '', limit = 20 } = {}) {
  const token = String(accessToken || '').trim();
  if (!token) {
    return { posts: [], errors: ['Threads access token이 없어 API 검색은 건너뜁니다.'] };
  }
  const normalizedBase = normalizeThreadsApiBaseUrl(apiBaseUrl);
  if (!normalizedBase) {
    return { posts: [], errors: ['보안 정책상 Threads API 주소는 https://graph.threads.net 만 허용됩니다.'] };
  }

  const posts = [];
  const errors = [];
  const headers = { Authorization: `Bearer ${token}` };

  for (const keyword of normalizeKeywordList(keywords).slice(0, 8)) {
    let keywordOk = false;
    for (const url of buildSearchUrls({ apiBaseUrl: normalizedBase, keyword, sinceIso, limit })) {
      try {
        const response = await fetch(url, { headers });
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          errors.push(`${keyword}: ${response.status} ${body.slice(0, 180)}`);
          continue;
        }
        const data = await response.json();
        flattenThreadsResponse(data).forEach((item) => posts.push(normalizePost(item, `api:${keyword}`)));
        keywordOk = true;
        break;
      } catch (error) {
        errors.push(`${keyword}: ${error.message}`);
      }
    }
    if (!keywordOk) {
      errors.push(`${keyword}: 공식 API 검색 응답을 얻지 못했습니다.`);
    }
  }

  return { posts, errors };
}

function filterRecent(posts = [], sinceIso = '') {
  const sinceMs = new Date(sinceIso || daysAgoIso(7)).getTime();
  if (!Number.isFinite(sinceMs)) return posts;

  return posts.filter((post) => {
    if (!post.timestamp) return true;
    const time = new Date(post.timestamp).getTime();
    return Number.isNaN(time) || time >= sinceMs;
  });
}

function rankPosts(posts = []) {
  const seen = new Set();
  return posts
    .filter((post) => post.text)
    .filter((post) => {
      const key = `${post.permalink || ''}|${post.text.slice(0, 80)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
}

function sanitizeSourcePosts(posts = []) {
  return (posts || [])
    .map((post) => ({
      ...post,
      text: String(post.text || '').slice(0, 600),
      permalink: String(post.permalink || '').slice(0, 320),
      username: String(post.username || '').slice(0, 80),
    }))
    .filter((post) => post.text.length >= 6);
}

async function collectThreadsMarketingSources(options = {}) {
  const keywords = normalizeKeywordList(options.keywords);
  const finalKeywords = keywords.length ? keywords : DEFAULT_KEYWORDS;
  const sinceIso = options.sinceIso || daysAgoIso(Number(options.days || 7));
  const manualPosts = parseManualPosts(options.manualPosts || '');
  const reviewPosts = parseReviewReplyExamples(options.reviewReplyExamples || '');
  const useThreadsApiSearch = options.useThreadsApiSearch !== false;

  const apiResult = useThreadsApiSearch
    ? await fetchThreadsKeywordPosts({
        accessToken: options.accessToken,
        apiBaseUrl: options.apiBaseUrl,
        keywords: finalKeywords,
        sinceIso,
        limit: Number(options.limit || 20),
      })
    : {
        posts: [],
        errors: ['Threads API 검색을 끈 상태입니다. 리뷰·답글 텍스트와 직접 입력만 참고합니다.'],
      };

  const merged = [...apiResult.posts, ...manualPosts, ...reviewPosts];
  const posts = sanitizeSourcePosts(rankPosts(filterRecent(merged, sinceIso)));

  return {
    keywords: finalKeywords,
    sinceIso,
    posts,
    errors: apiResult.errors,
    usedManualCount: manualPosts.length,
    usedReviewReplyCount: reviewPosts.length,
    usedApiCount: apiResult.posts.length,
    useThreadsApiSearch,
  };
}

module.exports = {
  DEFAULT_KEYWORDS,
  collectThreadsMarketingSources,
  daysAgoIso,
  normalizeKeywordList,
  normalizePost,
  parseManualPosts,
  parseReviewReplyExamples,
  rankPosts,
  normalizeThreadsApiBaseUrl,
};
