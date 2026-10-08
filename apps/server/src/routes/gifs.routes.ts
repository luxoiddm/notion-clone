import { Router } from 'express';
import { createHash } from 'node:crypto';
import { AuthService, requireAuth } from '@core/auth';
import type { ChatGif } from '@core/chat';
import { asyncRoute } from '../middleware/errorHandler.js';
import { readLimiter } from '../middleware/rateLimiter.js';

/**
 * Поиск GIF для чата — прокси к внешнему каталогу, чтобы API-ключ
 * оставался на сервере и не утекал в браузер.
 *
 * Провайдеры включаются ключами в .env (можно оба сразу — тогда в окне
 * GIF у каждого своя вкладка):
 *   KLIPY_API_KEY  — KLIPY (бесплатный, без лимитов; вкладка по умолчанию),
 *   GIPHY_API_KEY  — GIPHY (бесплатный beta-ключ ограничен ~100 запросами в час).
 * Какой провайдер искать — параметр ?provider=klipy|giphy. Если ни один
 * ключ не задан, GIF в чате выключены (кнопка не показывается). Tenor не поддерживается: Google закрыл его API 30.06.2026.
 *
 * Ответ нормализован под один формат: { items: GifItem[], next: string | null }.
 */

export interface GifItem extends ChatGif {
  id: string;
}

type Provider = 'klipy' | 'giphy';

/** Все провайдеры, для которых задан ключ, в порядке приоритета (KLIPY первым). */
function availableProviders(): { provider: Provider; key: string }[] {
  const list: { provider: Provider; key: string }[] = [];
  const klipy = process.env.KLIPY_API_KEY?.trim();
  if (klipy) list.push({ provider: 'klipy', key: klipy });
  const giphy = process.env.GIPHY_API_KEY?.trim();
  if (giphy) list.push({ provider: 'giphy', key: giphy });
  return list;
}

/** Провайдер из ?provider=, если он настроен; иначе — первый доступный. */
function pickProvider(requested: unknown): { provider: Provider; key: string } | null {
  const list = availableProviders();
  return list.find((p) => p.provider === requested) ?? list[0] ?? null;
}

/** Домены CDN, ссылки с которых принимаются в сообщениях (см. isAllowedGifUrl). */
const GIF_HOST_SUFFIXES = ['.klipy.com', '.giphy.com'];

/** Не даём положить в сообщение произвольную внешнюю ссылку под видом GIF — только https с CDN поддерживаемых провайдеров. */
export function isAllowedGifUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && GIF_HOST_SUFFIXES.some((s) => u.hostname === s.slice(1) || u.hostname.endsWith(s));
  } catch {
    return false;
  }
}

/** Проверяет и чистит GIF из тела запроса на отправку сообщения. null — если GIF некорректен. */
export function sanitizeGif(raw: unknown): ChatGif | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;
  if (!isAllowedGifUrl(g.url)) return null;
  const previewUrl = isAllowedGifUrl(g.previewUrl) ? (g.previewUrl as string) : (g.url as string);
  const width = Number(g.width);
  const height = Number(g.height);
  return {
    url: g.url as string,
    previewUrl,
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : 200,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : 200,
    title: typeof g.title === 'string' ? g.title.slice(0, 200) : '',
    provider: g.provider === 'giphy' ? 'giphy' : 'klipy',
  };
}

// ---- KLIPY ------------------------------------------------------------------

interface KlipyFile {
  url?: string;
  width?: number;
  height?: number;
}
interface KlipyItem {
  id?: number | string;
  slug?: string;
  title?: string;
  type?: string;
  file?: Record<string, { gif?: KlipyFile; webp?: KlipyFile }>;
}

function mapKlipy(item: KlipyItem): GifItem | null {
  if (item.type === 'ad') return null; // рекламные позиции в ленте не показываем
  const pick = (size: string) => item.file?.[size]?.gif;
  const main = pick('md') ?? pick('hd') ?? pick('sm');
  const preview = pick('sm') ?? pick('xs') ?? main;
  if (!main?.url) return null;
  return {
    id: String(item.id ?? item.slug ?? main.url),
    url: main.url,
    previewUrl: preview?.url ?? main.url,
    width: main.width ?? preview?.width ?? 200,
    height: main.height ?? preview?.height ?? 200,
    title: item.title ?? '',
    provider: 'klipy',
  };
}

async function klipy(key: string, kind: 'search' | 'trending', q: string, page: number, userId: string) {
  const params = new URLSearchParams({ page: String(page), per_page: '24', content_filter: 'medium', locale: 'ru', customer_id: userId });
  if (kind === 'search') params.set('q', q);
  const res = await fetch(`https://api.klipy.com/api/v1/${encodeURIComponent(key)}/gifs/${kind}?${params}`);
  if (!res.ok) throw new Error(`KLIPY ${res.status}`);
  const body = (await res.json()) as { data?: { data?: KlipyItem[]; has_next?: boolean } };
  const items = (body.data?.data ?? []).map(mapKlipy).filter((x): x is GifItem => !!x);
  return { items, next: body.data?.has_next ? String(page + 1) : null };
}

// ---- GIPHY ------------------------------------------------------------------

interface GiphyImage {
  url?: string;
  width?: string;
  height?: string;
}
interface GiphyItem {
  id: string;
  title?: string;
  images?: Record<string, GiphyImage>;
}

function mapGiphy(item: GiphyItem): GifItem | null {
  const main = item.images?.fixed_width ?? item.images?.downsized ?? item.images?.original;
  const preview = item.images?.fixed_width_small ?? item.images?.preview_gif ?? main;
  if (!main?.url) return null;
  return {
    id: item.id,
    url: main.url,
    previewUrl: preview?.url ?? main.url,
    width: Number(main.width) || 200,
    height: Number(main.height) || 200,
    title: item.title ?? '',
    provider: 'giphy',
  };
}

async function giphy(key: string, kind: 'search' | 'trending', q: string, page: number) {
  const limit = 24;
  const params = new URLSearchParams({ api_key: key, limit: String(limit), offset: String((page - 1) * limit), rating: 'pg-13', lang: 'ru' });
  if (kind === 'search') params.set('q', q);
  const res = await fetch(`https://api.giphy.com/v1/gifs/${kind}?${params}`);
  if (!res.ok) throw new Error(`GIPHY ${res.status}`);
  const body = (await res.json()) as { data?: GiphyItem[]; pagination?: { total_count?: number; count?: number; offset?: number } };
  const items = (body.data ?? []).map(mapGiphy).filter((x): x is GifItem => !!x);
  const p = body.pagination;
  const hasNext = !!p && (p.offset ?? 0) + (p.count ?? 0) < (p.total_count ?? 0);
  return { items, next: hasNext ? String(page + 1) : null };
}

export function gifsRoutes(auth: AuthService) {
  const router = Router();
  router.use(requireAuth(auth));

  router.get('/status', (_req, res) => {
    const providers = availableProviders().map((p) => p.provider);
    res.json({ enabled: providers.length > 0, provider: providers[0] ?? null, providers });
  });

  const handler = (kind: 'search' | 'trending') =>
    asyncRoute(async (req, res) => {
      const p = pickProvider(req.query.provider);
      if (!p) return res.status(404).json({ error: 'GIF-поиск не настроен (нет KLIPY_API_KEY / GIPHY_API_KEY)' });
      const q = String(req.query.q ?? '').trim().slice(0, 100);
      if (kind === 'search' && !q) return res.json({ items: [], next: null });
      const page = Math.max(1, Math.min(50, Number(req.query.page) || 1));
      // Провайдеру — не id пользователя, а его хэш (KLIPY просит customer_id для персонализации).
      const customerId = createHash('sha256').update(req.user!.id).digest('hex').slice(0, 32);
      try {
        res.json(p.provider === 'klipy' ? await klipy(p.key, kind, q, page, customerId) : await giphy(p.key, kind, q, page));
      } catch (err) {
        console.warn('[gifs] provider error:', err instanceof Error ? err.message : err);
        res.status(502).json({ error: 'Сервис GIF сейчас недоступен' });
      }
    });

  router.get('/search', readLimiter, handler('search'));
  router.get('/trending', readLimiter, handler('trending'));

  return router;
}
