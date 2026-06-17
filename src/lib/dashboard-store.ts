import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { dashboardSnapshots, marketAlerts } from "@/db/schema";
import { getDashboardData, type Commodity, type DashboardData, type MarketIndex, type NewsItem } from "@/lib/dashboard-data";

const VN_TIME_ZONE = "Asia/Ho_Chi_Minh";
const DEFAULT_MIN_UPDATE_INTERVAL_MINUTES = Number(process.env.MIN_UPDATE_INTERVAL_MINUTES ?? "50");
const HOURLY_REFRESH_MINUTES = 60;

export type UpdateTrigger = "cron" | "on-demand" | "manual";

export type UpdateResult = {
  ok: boolean;
  skipped: boolean;
  trigger: UpdateTrigger;
  snapshotId?: number;
  quoteCount: number;
  newsCount: number;
  message: string;
  dateKey: string;
  hasNewSnapshot?: boolean;
  data: DashboardData;
};

type QuoteResult = {
  symbol: string;
  price: number;
  previousClose?: number;
  change?: number;
  changePct?: number;
  asOf: string;
};

let tablesEnsured = false;

export function getHourlyUpdateIntervalMinutes() {
  return HOURLY_REFRESH_MINUTES;
}

function partsInVietnam(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: VN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  return Object.fromEntries(parts.map((item) => [item.type, item.value]));
}

export function getVietnamDateKey(date = new Date()) {
  const p = partsInVietnam(date);
  return `${p.year}-${p.month}-${p.day}`;
}

export function getVietnamDateShort(date = new Date()) {
  const p = partsInVietnam(date);
  return `${p.day}/${p.month}/${p.year}`;
}

export function getVietnamReportDate(date = new Date()) {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: VN_TIME_ZONE,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

export function getVietnamTimestamp(date = new Date()) {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: VN_TIME_ZONE,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function normalizeDateRank(dateShort: string) {
  const [day, month, year] = dateShort.split("/").map(Number);
  if (!day || !month || !year) return 0;
  return Number(`${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`);
}

async function ensureTables() {
  if (tablesEnsured) return;
  const db = getDb();

  await db.execute(sql`
    create table if not exists dashboard_snapshots (
      id serial primary key,
      snapshot_date date not null default current_date,
      data jsonb not null,
      created_at timestamp not null default now()
    )
  `);

  await db.execute(sql`
    create index if not exists dashboard_snapshots_snapshot_date_idx
    on dashboard_snapshots (snapshot_date)
  `);

  await db.execute(sql`
    create index if not exists dashboard_snapshots_created_at_idx
    on dashboard_snapshots (created_at)
  `);

  await db.execute(sql`
    create table if not exists market_alerts (
      id serial primary key,
      alert_type text not null,
      title text not null,
      message text not null,
      severity text not null,
      created_at timestamp not null default now()
    )
  `);

  tablesEnsured = true;
}

async function fetchJson<T>(url: string, timeoutMs = 8000): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "ORCA-FINANCIAL/1.0",
        accept: "application/json,text/plain,*/*",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (error) {
    console.warn("JSON fetch failed", url, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string, timeoutMs = 8000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "ORCA-FINANCIAL/1.0",
        accept: "application/rss+xml,text/xml,text/plain,*/*",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (error) {
    console.warn("Text fetch failed", url, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchYahooQuote(symbol: string): Promise<QuoteResult | null> {
  type YahooChartResponse = {
    chart?: {
      result?: Array<{
        meta?: {
          regularMarketPrice?: number;
          previousClose?: number;
          chartPreviousClose?: number;
          regularMarketTime?: number;
        };
        indicators?: {
          quote?: Array<{ close?: Array<number | null> }>;
        };
      }>;
    };
  };

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  const json = await fetchJson<YahooChartResponse>(url);
  const result = json?.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta?.regularMarketPrice) return null;

  const closes = result?.indicators?.quote?.[0]?.close?.filter((n): n is number => typeof n === "number") ?? [];
  const previousClose = meta.chartPreviousClose ?? meta.previousClose ?? closes.at(-2);
  const price = meta.regularMarketPrice;
  const change = previousClose ? price - previousClose : undefined;
  const changePct = previousClose && change !== undefined ? (change / previousClose) * 100 : undefined;

  return {
    symbol,
    price,
    previousClose,
    change,
    changePct,
    asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : new Date().toISOString(),
  };
}

function decodeXml(value: string) {
  return value
    .replaceAll("<![CDATA[", "")
    .replaceAll("]]>", "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

async function fetchGoogleNews(query: string, category: "global" | "vietnam", limit = 2): Promise<NewsItem[]> {
  const xml = await fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=vi&gl=VN&ceid=VN:vi`);
  if (!xml) return [];

  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit).map((match) => {
    const block = match[1];
    const title = decodeXml(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "Tin thị trường mới");
    const source = decodeXml(block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? "Google News");
    const pubDate = decodeXml(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? getVietnamTimestamp());
    const impact = /CPI|Fed|VN-Index|Nasdaq|Dow|dầu|vàng|tỷ giá/i.test(title) ? "high" : "medium";

    return {
      headline: title,
      source: `Google News RSS / ${source}`,
      time: pubDate,
      summary: `Tin được hệ thống tự động quét theo lịch mỗi ${HOURLY_REFRESH_MINUTES} phút với từ khóa: "${query}". Luôn nên đọc lại nguồn gốc trước khi ra quyết định đầu tư.`,
      impact,
      riskLevel: impact === "high" ? "Cao" : "Trung bình",
      sectors: category === "vietnam" ? ["Việt Nam", "Toàn thị trường"] : ["Toàn cầu", "Vĩ mô"],
      verified: true,
    };
  });
}

function applyMarketQuote(markets: MarketIndex[], name: string, quote: QuoteResult | null): MarketIndex[] {
  if (quote === null || quote.change === undefined || quote.changePct === undefined) return markets;
  const change = quote.change;
  const changePct = quote.changePct;
  const trend: MarketIndex["trend"] = changePct > 0.3 ? "bullish" : changePct < -0.3 ? "bearish" : "neutral";

  return markets.map((item) =>
    item.name === name
      ? {
          ...item,
          value: Number(quote.price.toFixed(2)),
          dailyChange: Number(change.toFixed(2)),
          dailyChangePct: Number(changePct.toFixed(2)),
          trend,
        }
      : item
  );
}

function applyCommodityQuote(commodities: Commodity[], name: string, quote: QuoteResult | null, source: string): Commodity[] {
  if (quote === null || quote.changePct === undefined) return commodities;
  const changePct = quote.changePct;
  const weeklyTrend: Commodity["weeklyTrend"] = changePct > 0 ? "up" : changePct < 0 ? "down" : "flat";

  return commodities.map((item) =>
    item.name === name
      ? {
          ...item,
          price: Number(quote.price.toFixed(2)),
          dailyChange: Number(changePct.toFixed(2)),
          weeklyTrend,
          source,
          asOf: getVietnamDateShort(),
        }
      : item
  );
}

function stampData(base: DashboardData, trigger: UpdateTrigger): DashboardData {
  const now = new Date();
  return {
    ...base,
    date: getVietnamReportDate(now),
    dateShort: getVietnamDateShort(now),
    timestamp: `Tự động quét mỗi 1 giờ | ${getVietnamTimestamp(now)} | Trigger: ${trigger}`,
  };
}

async function buildFreshDashboardData(trigger: UpdateTrigger): Promise<{ data: DashboardData; quoteCount: number; newsCount: number }> {
  let data: DashboardData = JSON.parse(JSON.stringify(getDashboardData())) as DashboardData;
  data = stampData(data, trigger);

  const quotes = await Promise.all([
    fetchYahooQuote("^GSPC"),
    fetchYahooQuote("^IXIC"),
    fetchYahooQuote("^DJI"),
    fetchYahooQuote("^RUT"),
    fetchYahooQuote("^VNINDEX.VN"),
    fetchYahooQuote("BZ=F"),
    fetchYahooQuote("CL=F"),
    fetchYahooQuote("GC=F"),
    fetchYahooQuote("SI=F"),
    fetchYahooQuote("BTC-USD"),
  ]);

  const [spx, nasdaq, dow, rut, vnindex, brent, wti, gold, silver] = quotes;
  const quoteCount = quotes.filter(Boolean).length;

  data.globalMarkets = applyMarketQuote(data.globalMarkets, "S&P 500", spx);
  data.globalMarkets = applyMarketQuote(data.globalMarkets, "NASDAQ", nasdaq);
  data.globalMarkets = applyMarketQuote(data.globalMarkets, "DOW JONES", dow);
  data.globalMarkets = applyMarketQuote(data.globalMarkets, "Russell 2000", rut);
  data.vietnamMarkets = applyMarketQuote(data.vietnamMarkets, "VNINDEX", vnindex);

  data.commodities = applyCommodityQuote(data.commodities, "Dầu Brent", brent, "Yahoo Finance / Auto scan");
  data.commodities = applyCommodityQuote(data.commodities, "Dầu WTI", wti, "Yahoo Finance / Auto scan");
  data.commodities = applyCommodityQuote(data.commodities, "Vàng spot", gold, "Yahoo Finance / Auto scan");
  data.commodities = applyCommodityQuote(data.commodities, "Bạc", silver, "Yahoo Finance / Auto scan");

  const [globalNews, vietnamNews, marketNews] = await Promise.all([
    fetchGoogleNews("S&P 500 Nasdaq Fed CPI market today", "global", 2),
    fetchGoogleNews("VN-Index chứng khoán Việt Nam hôm nay", "vietnam", 2),
    fetchGoogleNews("Brent oil gold treasury yield dollar today", "global", 1),
  ]);

  const newsCount = globalNews.length + vietnamNews.length + marketNews.length;
  if (globalNews.length || marketNews.length) {
    data.globalNews = [...globalNews, ...marketNews, ...data.globalNews].slice(0, 12);
  }
  if (vietnamNews.length) {
    data.vietnamNews = [...vietnamNews, ...data.vietnamNews].slice(0, 10);
  }

  data.confidenceScores = {
    ...data.confidenceScores,
    dataReliability: Math.max(data.confidenceScores.dataReliability, quoteCount >= 6 ? 92 : 86),
    explanation: `Hệ thống đã tự động quét ${quoteCount} mã thị trường và ${newsCount} tin RSS theo lịch mỗi 1 giờ. ${data.confidenceScores.explanation}`,
  };

  return { data, quoteCount, newsCount };
}

async function getLatestSnapshotMeta() {
  await ensureTables();
  const db = getDb();
  const rows = await db
    .select({
      id: dashboardSnapshots.id,
      snapshotDate: dashboardSnapshots.snapshotDate,
      createdAt: dashboardSnapshots.createdAt,
      data: dashboardSnapshots.data,
    })
    .from(dashboardSnapshots)
    .orderBy(desc(dashboardSnapshots.createdAt))
    .limit(1);

  return rows[0] ?? null;
}

function snapshotAgeMs(createdAt: Date | string | null | undefined) {
  if (!createdAt) return Number.POSITIVE_INFINITY;
  const value = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  return Number.isNaN(value) ? Number.POSITIVE_INFINITY : Date.now() - value;
}

async function hasFreshSnapshot() {
  const latest = await getLatestSnapshotMeta();
  if (!latest) return false;
  return snapshotAgeMs(latest.createdAt) < DEFAULT_MIN_UPDATE_INTERVAL_MINUTES * 60_000;
}

export async function getLatestDashboardData(): Promise<DashboardData> {
  const fallback = getDashboardData();
  try {
    const latest = await getLatestSnapshotMeta();
    if (!latest?.data) return fallback;

    const snapshotData = latest.data as DashboardData;
    return normalizeDateRank(snapshotData.dateShort) >= normalizeDateRank(fallback.dateShort) ? snapshotData : fallback;
  } catch (error) {
    console.warn("Could not read dashboard snapshot, using fallback data:", error);
    return fallback;
  }
}

export async function hasSnapshotForDate(dateKey = getVietnamDateKey()) {
  try {
    await ensureTables();
    const db = getDb();
    const rows = await db
      .select({ id: dashboardSnapshots.id })
      .from(dashboardSnapshots)
      .where(eq(dashboardSnapshots.snapshotDate, dateKey))
      .limit(1);
    return rows.length > 0;
  } catch (error) {
    console.warn("Could not check snapshot date:", error);
    return false;
  }
}

export async function runMarketUpdate({ force = false, trigger = "cron" }: { force?: boolean; trigger?: UpdateTrigger } = {}): Promise<UpdateResult> {
  const dateKey = getVietnamDateKey();

  if (!force && (await hasFreshSnapshot())) {
    return {
      ok: true,
      skipped: true,
      trigger,
      quoteCount: 0,
      newsCount: 0,
      message: `Snapshot gần nhất còn mới (< ${DEFAULT_MIN_UPDATE_INTERVAL_MINUTES} phút), bỏ qua cập nhật trùng.`,
      dateKey,
      hasNewSnapshot: false,
      data: await getLatestDashboardData(),
    };
  }

  const { data, quoteCount, newsCount } = await buildFreshDashboardData(trigger);
  await ensureTables();
  const db = getDb();

  const inserted = await db
    .insert(dashboardSnapshots)
    .values({ snapshotDate: dateKey, data })
    .returning({ id: dashboardSnapshots.id });

  await db.insert(marketAlerts).values({
    alertType: "hourly_auto_update",
    title: `ORCA tự động quét ${getVietnamTimestamp()}`,
    message: `Đã quét ${quoteCount} mã thị trường và ${newsCount} tin tức. Chu kỳ cập nhật: ${HOURLY_REFRESH_MINUTES} phút.`,
    severity: quoteCount >= 6 ? "info" : "warning",
  });

  await db.execute(sql`delete from dashboard_snapshots where created_at < now() - interval '45 days'`);
  await db.execute(sql`delete from market_alerts where created_at < now() - interval '45 days'`);

  return {
    ok: true,
    skipped: false,
    trigger,
    snapshotId: inserted[0]?.id,
    quoteCount,
    newsCount,
    message: "Đã tạo snapshot dashboard mới.",
    dateKey,
    hasNewSnapshot: true,
    data,
  };
}

export async function runDailyTask(): Promise<UpdateResult> {
  const result = await runMarketUpdate({ force: true, trigger: "manual" });
  const db = getDb();
  await db.insert(marketAlerts).values({
    alertType: "daily_task",
    title: `ORCA daily task ${getVietnamDateShort()}`,
    message: `Daily task hoàn tất. Quote: ${result.quoteCount}, News: ${result.newsCount}.`,
    severity: "info",
  });
  return {
    ...result,
    message: "Đã chạy daily task và tạo snapshot mới.",
    hasNewSnapshot: true,
  };
}

export async function maybeRunDueUpdate() {
  if (await hasFreshSnapshot()) return null;
  return runMarketUpdate({ trigger: "on-demand" });
}

// Backward-compatible export names
export type DailyUpdateResult = UpdateResult;
export async function runDailyMarketUpdate(options?: { force?: boolean; trigger?: UpdateTrigger }) {
  return runMarketUpdate(options);
}
