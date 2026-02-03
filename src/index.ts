/**
 * x-safe-post - Post to X/Twitter with shadowban avoidance
 * 
 * Features:
 * - Human-like timing with jitter
 * - Rate limit tracking and auto-backoff
 * - Content deduplication (no repeat tweets)
 * - Posting pattern analysis
 * - Shadowban detection
 */

import { TwitterApi, TwitterApiReadWrite } from 'twitter-api-v2';
import Conf from 'conf';
import crypto from 'crypto';

// ============================================
// TYPES
// ============================================

export interface XSafeConfig {
  /** X API credentials */
  credentials: {
    appKey: string;
    appSecret: string;
    accessToken: string;
    accessSecret: string;
  };
  /** Safety settings */
  safety?: SafetySettings;
}

export interface SafetySettings {
  /** Minimum minutes between posts (default: 30) */
  minIntervalMinutes?: number;
  /** Maximum posts per day (default: 8) */
  maxPostsPerDay?: number;
  /** Add random jitter to timing (default: true) */
  enableJitter?: boolean;
  /** Max jitter in minutes (default: 30) */
  maxJitterMinutes?: number;
  /** Prevent duplicate content within N days (default: 7) */
  dedupeWindowDays?: number;
  /** Quiet hours - no posting (default: 23-6) */
  quietHoursStart?: number;
  quietHoursEnd?: number;
  /** Enable quiet hours (default: true) */
  enableQuietHours?: boolean;
  /** Timezone for quiet hours (default: UTC) */
  timezone?: string;
}

export interface PostOptions {
  /** Tweet text */
  text: string;
  /** Reply to tweet ID */
  replyTo?: string;
  /** Quote tweet ID */
  quoteTweetId?: string;
  /** Media IDs to attach */
  mediaIds?: string[];
  /** Skip safety checks (not recommended) */
  force?: boolean;
  /** Custom jitter override in minutes */
  jitterMinutes?: number;
}

export interface PostResult {
  success: boolean;
  tweetId?: string;
  scheduledFor?: Date;
  delayed?: boolean;
  delayMinutes?: number;
  blocked?: boolean;
  blockReason?: string;
  rateLimitRemaining?: number;
  rateLimitReset?: Date;
}

export interface SafetyCheck {
  safe: boolean;
  warnings: string[];
  errors: string[];
  suggestions: string[];
}

interface PostHistory {
  id: string;
  text: string;
  hash: string;
  timestamp: number;
  mediaIds?: string[];
}

interface RateLimitState {
  remaining: number;
  limit: number;
  resetAt: number;
}

interface StoreSchema {
  postHistory: PostHistory[];
  lastPostAt: number | null;
  dailyPostCount: number;
  dailyPostDate: string;
  rateLimit: RateLimitState | null;
}

// ============================================
// DEFAULTS
// ============================================

const DEFAULT_SAFETY: Required<SafetySettings> = {
  minIntervalMinutes: 30,
  maxPostsPerDay: 8,
  enableJitter: true,
  maxJitterMinutes: 30,
  dedupeWindowDays: 7,
  quietHoursStart: 23,
  quietHoursEnd: 6,
  enableQuietHours: true,
  timezone: 'UTC',
};

// ============================================
// MAIN CLASS
// ============================================

export class XSafePost {
  private client: TwitterApiReadWrite;
  private store: Conf<StoreSchema>;
  private safety: Required<SafetySettings>;

  constructor(config: XSafeConfig) {
    // Initialize Twitter client
    const userClient = new TwitterApi({
      appKey: config.credentials.appKey,
      appSecret: config.credentials.appSecret,
      accessToken: config.credentials.accessToken,
      accessSecret: config.credentials.accessSecret,
    });
    this.client = userClient.readWrite;

    // Initialize persistent storage
    this.store = new Conf<StoreSchema>({
      projectName: 'x-safe-post',
      defaults: {
        postHistory: [] as PostHistory[],
        lastPostAt: null,
        dailyPostCount: 0,
        dailyPostDate: '',
        rateLimit: null,
      },
    });

    // Merge safety settings
    this.safety = { ...DEFAULT_SAFETY, ...config.safety };

    // Reset daily count if new day
    this.checkDailyReset();
  }

  // ============================================
  // PUBLIC METHODS
  // ============================================

  /**
   * Post a tweet with all safety checks
   */
  async post(options: PostOptions): Promise<PostResult> {
    const { text, replyTo, quoteTweetId, mediaIds, force } = options;

    // Run safety checks unless forced
    if (!force) {
      const check = await this.checkSafety(text);
      if (!check.safe) {
        return {
          success: false,
          blocked: true,
          blockReason: check.errors.join('; '),
        };
      }
    }

    // Calculate delay with jitter
    const delay = this.calculateDelay(options.jitterMinutes);
    
    if (delay.delayMs > 0 && !force) {
      // Return scheduled info - caller handles the actual delay
      return {
        success: false,
        delayed: true,
        delayMinutes: Math.ceil(delay.delayMs / 60000),
        scheduledFor: new Date(Date.now() + delay.delayMs),
        blockReason: delay.reason,
      };
    }

    // Actually post
    try {
      const tweetData: any = { text };
      
      if (replyTo) {
        tweetData.reply = { in_reply_to_tweet_id: replyTo };
      }
      if (quoteTweetId) {
        tweetData.quote_tweet_id = quoteTweetId;
      }
      if (mediaIds && mediaIds.length > 0) {
        tweetData.media = { media_ids: mediaIds };
      }

      const result = await this.client.v2.tweet(tweetData);

      // Record successful post
      this.recordPost(text, result.data.id, mediaIds);

      // Update rate limit from response headers if available
      // (twitter-api-v2 handles this internally, but we track for reporting)
      
      return {
        success: true,
        tweetId: result.data.id,
        rateLimitRemaining: this.store.get('rateLimit')?.remaining,
      };
    } catch (error: any) {
      // Handle rate limit errors
      if (error.code === 429 || error.rateLimitError) {
        const resetAt = error.rateLimit?.reset 
          ? new Date(error.rateLimit.reset * 1000) 
          : new Date(Date.now() + 15 * 60 * 1000);
        
        this.store.set('rateLimit', {
          remaining: 0,
          limit: error.rateLimit?.limit || 100,
          resetAt: resetAt.getTime(),
        });

        return {
          success: false,
          blocked: true,
          blockReason: 'Rate limit exceeded',
          rateLimitRemaining: 0,
          rateLimitReset: resetAt,
        };
      }

      throw error;
    }
  }

  /**
   * Post with automatic delay handling (waits if needed)
   */
  async postAndWait(options: PostOptions): Promise<PostResult> {
    const result = await this.post(options);
    
    if (result.delayed && result.scheduledFor) {
      const waitMs = result.scheduledFor.getTime() - Date.now();
      if (waitMs > 0) {
        await this.sleep(waitMs);
        return this.post({ ...options, force: true });
      }
    }
    
    return result;
  }

  /**
   * Check if content is safe to post
   */
  async checkSafety(text: string): Promise<SafetyCheck> {
    const warnings: string[] = [];
    const errors: string[] = [];
    const suggestions: string[] = [];

    // Check rate limit
    const rateLimit = this.store.get('rateLimit');
    if (rateLimit && rateLimit.remaining === 0 && rateLimit.resetAt > Date.now()) {
      errors.push(`Rate limit exceeded. Resets at ${new Date(rateLimit.resetAt).toISOString()}`);
    }

    // Check daily limit
    this.checkDailyReset();
    const dailyCount = this.store.get('dailyPostCount');
    if (dailyCount >= this.safety.maxPostsPerDay) {
      errors.push(`Daily post limit reached (${this.safety.maxPostsPerDay})`);
    } else if (dailyCount >= this.safety.maxPostsPerDay - 2) {
      warnings.push(`Approaching daily limit (${dailyCount}/${this.safety.maxPostsPerDay})`);
    }

    // Check quiet hours
    if (this.safety.enableQuietHours && this.isQuietHours()) {
      warnings.push('Currently in quiet hours - post will be delayed');
    }

    // Check for duplicate content
    const hash = this.hashContent(text);
    const history = this.store.get('postHistory');
    const cutoff = Date.now() - (this.safety.dedupeWindowDays * 24 * 60 * 60 * 1000);
    const duplicate = history.find(h => h.hash === hash && h.timestamp > cutoff);
    if (duplicate) {
      errors.push(`Duplicate content detected (posted ${this.timeAgo(duplicate.timestamp)})`);
    }

    // Check for similar content (fuzzy match)
    const similar = history.find(h => 
      h.timestamp > cutoff && this.similarity(text, h.text) > 0.8
    );
    if (similar && similar.hash !== hash) {
      warnings.push(`Very similar to recent post (${Math.round(this.similarity(text, similar.text) * 100)}% match)`);
      suggestions.push('Consider rephrasing to avoid detection as duplicate');
    }

    // Check content patterns that trigger shadowban
    const hashtagCount = (text.match(/#\w+/g) || []).length;
    if (hashtagCount > 3) {
      warnings.push(`Too many hashtags (${hashtagCount}) - recommend max 2-3`);
    }
    if (hashtagCount > 5) {
      errors.push('Excessive hashtags - high shadowban risk');
    }

    // Check for URL shorteners
    if (/bit\.ly|tinyurl|t\.co|goo\.gl|ow\.ly/i.test(text)) {
      warnings.push('URL shorteners may trigger spam filters');
      suggestions.push('Use full URLs or native X links');
    }

    // Check for @mention spam
    const mentionCount = (text.match(/@\w+/g) || []).length;
    if (mentionCount > 5) {
      warnings.push(`Many mentions (${mentionCount}) may appear spammy`);
    }

    // Check minimum interval
    const lastPost = this.store.get('lastPostAt');
    if (lastPost) {
      const minutesSince = (Date.now() - lastPost) / 60000;
      if (minutesSince < this.safety.minIntervalMinutes) {
        const waitMinutes = Math.ceil(this.safety.minIntervalMinutes - minutesSince);
        warnings.push(`Posted ${Math.round(minutesSince)}m ago - recommend waiting ${waitMinutes}m more`);
      }
    }

    return {
      safe: errors.length === 0,
      warnings,
      errors,
      suggestions,
    };
  }

  /**
   * Calculate optimal delay with jitter
   */
  calculateDelay(customJitter?: number): { delayMs: number; reason?: string } {
    let delayMs = 0;
    let reason: string | undefined;

    // Rate limit delay
    const rateLimit = this.store.get('rateLimit');
    if (rateLimit && rateLimit.remaining === 0 && rateLimit.resetAt > Date.now()) {
      delayMs = Math.max(delayMs, rateLimit.resetAt - Date.now());
      reason = 'Rate limit cooldown';
    }

    // Minimum interval delay
    const lastPost = this.store.get('lastPostAt');
    if (lastPost) {
      const minWait = this.safety.minIntervalMinutes * 60 * 1000;
      const timeSince = Date.now() - lastPost;
      if (timeSince < minWait) {
        delayMs = Math.max(delayMs, minWait - timeSince);
        reason = reason || 'Minimum interval';
      }
    }

    // Quiet hours delay
    if (this.safety.enableQuietHours && this.isQuietHours()) {
      const quietEnd = this.getQuietHoursEnd();
      delayMs = Math.max(delayMs, quietEnd - Date.now());
      reason = reason || 'Quiet hours';
    }

    // Add jitter
    if (this.safety.enableJitter && delayMs > 0) {
      const jitterMinutes = customJitter ?? this.safety.maxJitterMinutes;
      const jitterMs = Math.random() * jitterMinutes * 60 * 1000;
      delayMs += jitterMs;
    }

    return { delayMs, reason };
  }

  /**
   * Get next safe posting time
   */
  getNextPostTime(): Date {
    const delay = this.calculateDelay();
    return new Date(Date.now() + delay.delayMs);
  }

  /**
   * Check for potential shadowban
   */
  async checkShadowban(): Promise<{
    likely: boolean;
    checks: { name: string; passed: boolean; details?: string }[];
  }> {
    const checks: { name: string; passed: boolean; details?: string }[] = [];

    try {
      // Get own user info
      const me = await this.client.v2.me();
      
      // Check if account is still accessible
      checks.push({
        name: 'Account accessible',
        passed: !!me.data,
        details: me.data ? `@${me.data.username}` : 'Could not fetch account',
      });

      // Try to fetch recent tweets
      const tweets = await this.client.v2.userTimeline(me.data.id, { max_results: 5 });
      checks.push({
        name: 'Tweets visible',
        passed: (tweets.data?.data?.length ?? 0) > 0,
        details: `${tweets.data?.data?.length ?? 0} recent tweets found`,
      });

      // Check for any restrictions
      // Note: X API doesn't expose shadowban status directly
      // This is a heuristic check
      
    } catch (error: any) {
      checks.push({
        name: 'API access',
        passed: false,
        details: error.message,
      });
    }

    const failedChecks = checks.filter(c => !c.passed).length;
    
    return {
      likely: failedChecks > 0,
      checks,
    };
  }

  /**
   * Get posting statistics
   */
  getStats(): {
    todayPosts: number;
    maxDailyPosts: number;
    lastPostAt: Date | null;
    nextAllowedAt: Date;
    recentPosts: number;
    rateLimitRemaining: number | null;
    rateLimitReset: Date | null;
  } {
    this.checkDailyReset();
    const history = this.store.get('postHistory');
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const rateLimit = this.store.get('rateLimit');

    return {
      todayPosts: this.store.get('dailyPostCount'),
      maxDailyPosts: this.safety.maxPostsPerDay,
      lastPostAt: this.store.get('lastPostAt') 
        ? new Date(this.store.get('lastPostAt')!) 
        : null,
      nextAllowedAt: this.getNextPostTime(),
      recentPosts: history.filter(h => h.timestamp > weekAgo).length,
      rateLimitRemaining: rateLimit?.remaining ?? null,
      rateLimitReset: rateLimit?.resetAt ? new Date(rateLimit.resetAt) : null,
    };
  }

  /**
   * Clear post history
   */
  clearHistory(): void {
    this.store.set('postHistory', []);
  }

  /**
   * Reset daily counter
   */
  resetDailyCount(): void {
    this.store.set('dailyPostCount', 0);
    this.store.set('dailyPostDate', this.getTodayString());
  }

  // ============================================
  // PRIVATE METHODS
  // ============================================

  private recordPost(text: string, tweetId: string, mediaIds?: string[]): void {
    const history = this.store.get('postHistory');
    
    // Add new post
    history.push({
      id: tweetId,
      text,
      hash: this.hashContent(text),
      timestamp: Date.now(),
      mediaIds,
    });

    // Prune old entries (keep 30 days)
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const pruned = history.filter(h => h.timestamp > cutoff);
    
    this.store.set('postHistory', pruned);
    this.store.set('lastPostAt', Date.now());
    this.store.set('dailyPostCount', this.store.get('dailyPostCount') + 1);
  }

  private checkDailyReset(): void {
    const today = this.getTodayString();
    if (this.store.get('dailyPostDate') !== today) {
      this.store.set('dailyPostCount', 0);
      this.store.set('dailyPostDate', today);
    }
  }

  private getTodayString(): string {
    return new Date().toISOString().split('T')[0];
  }

  private hashContent(text: string): string {
    // Normalize text for comparison (lowercase, no extra spaces)
    const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
    return crypto.createHash('md5').update(normalized).digest('hex');
  }

  private similarity(a: string, b: string): number {
    // Simple Jaccard similarity on words
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);
    return intersection.size / union.size;
  }

  private isQuietHours(): boolean {
    const hour = new Date().getHours();
    const start = this.safety.quietHoursStart;
    const end = this.safety.quietHoursEnd;

    if (start > end) {
      // Overnight (e.g., 23-6)
      return hour >= start || hour < end;
    } else {
      // Same day (e.g., 2-6)
      return hour >= start && hour < end;
    }
  }

  private getQuietHoursEnd(): number {
    const now = new Date();
    const end = new Date(now);
    end.setHours(this.safety.quietHoursEnd, 0, 0, 0);
    
    if (end <= now) {
      end.setDate(end.getDate() + 1);
    }
    
    return end.getTime();
  }

  private timeAgo(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export default instance factory
export function createClient(config: XSafeConfig): XSafePost {
  return new XSafePost(config);
}

export default XSafePost;
