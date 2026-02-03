# 🛡️ x-safe-post

[![npm version](https://img.shields.io/npm/v/x-safe-post.svg)](https://www.npmjs.com/package/x-safe-post)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)

**Post to X/Twitter with built-in shadowban avoidance.** Human-like timing, rate limiting, content deduplication, and jitter - all automatic.

```bash
npx x-safe-post post "Hello world!"
```

Stop getting shadowbanned. Post like a human.

---

## 🚀 Quick Start

### 1. Install

```bash
npm install -g x-safe-post
# or use npx
npx x-safe-post --help
```

### 2. Configure

```bash
x-safe-post config \
  --app-key YOUR_APP_KEY \
  --app-secret YOUR_APP_SECRET \
  --access-token YOUR_ACCESS_TOKEN \
  --access-secret YOUR_ACCESS_SECRET
```

### 3. Post

```bash
x-safe-post post "My awesome tweet!"
```

That's it. The tool handles timing, deduplication, and rate limits automatically.

---

## ✨ Features

### 🎲 Human-Like Timing
- Random jitter on all posts (±30 min by default)
- Quiet hours (no posting 11pm-6am)
- Minimum intervals between posts
- No robotic patterns

### 🔄 Content Deduplication
- Tracks all posts for 30 days
- Blocks duplicate content
- Warns on similar content (>80% match)
- Prevents repeat hashtag abuse

### ⚡ Rate Limit Protection
- Tracks X API rate limits
- Auto-backoff when approaching limits
- Daily post caps (default: 8/day)
- Graceful handling of 429 errors

### 🔍 Shadowban Detection
- Built-in shadowban checker
- Monitors account health
- Actionable recommendations

---

## 📖 CLI Usage

### Post a Tweet

```bash
# Basic post
x-safe-post post "Hello world!"

# Reply to a tweet
x-safe-post post "Great point!" --reply-to 1234567890

# Quote tweet
x-safe-post post "This is amazing" --quote 1234567890

# Check safety without posting
x-safe-post post "Test tweet" --dry-run

# Wait if delayed (instead of returning)
x-safe-post post "Hello" --wait

# Skip safety checks (not recommended)
x-safe-post post "YOLO" --force
```

### Check Shadowban Status

```bash
x-safe-post check
```

### View Statistics

```bash
x-safe-post stats
```

### Configure Settings

```bash
# Show current config
x-safe-post config --show

# Set minimum interval to 45 minutes
x-safe-post config --min-interval 45

# Set max 6 posts per day
x-safe-post config --max-daily 6

# Set quiet hours (no posting 10pm - 7am)
x-safe-post config --quiet-start 22 --quiet-end 7

# Disable jitter (not recommended)
x-safe-post config --no-jitter
```

### Get Next Safe Post Time (for cron)

```bash
# Human readable
x-safe-post next-time

# Unix timestamp (for scripts)
x-safe-post next-time --unix

# ISO 8601
x-safe-post next-time --iso
```

### Clear History

```bash
# Clear post history (allows "duplicate" posts again)
x-safe-post clear --history

# Reset daily counter
x-safe-post clear --daily

# Clear everything
x-safe-post clear --all
```

---

## 💻 Programmatic Usage

```typescript
import { XSafePost } from 'x-safe-post';

const client = new XSafePost({
  credentials: {
    appKey: 'YOUR_APP_KEY',
    appSecret: 'YOUR_APP_SECRET',
    accessToken: 'YOUR_ACCESS_TOKEN',
    accessSecret: 'YOUR_ACCESS_SECRET',
  },
  safety: {
    minIntervalMinutes: 30,
    maxPostsPerDay: 8,
    enableJitter: true,
    maxJitterMinutes: 30,
    quietHoursStart: 23,
    quietHoursEnd: 6,
  },
});

// Post with safety checks
const result = await client.post({ text: 'Hello from the API!' });

if (result.success) {
  console.log(`Posted! Tweet ID: ${result.tweetId}`);
} else if (result.delayed) {
  console.log(`Delayed until: ${result.scheduledFor}`);
} else if (result.blocked) {
  console.log(`Blocked: ${result.blockReason}`);
}

// Post and wait if delayed
const result2 = await client.postAndWait({ text: 'This will wait if needed' });

// Check content safety before posting
const safety = await client.checkSafety('My tweet with #too #many #hashtags');
console.log(safety.warnings); // ['Too many hashtags (3) - recommend max 2-3']

// Check for shadowban
const shadowban = await client.checkShadowban();
if (shadowban.likely) {
  console.log('Possible shadowban detected!');
}

// Get next safe posting time
const nextTime = client.getNextPostTime();
console.log(`Next safe time: ${nextTime}`);

// Get stats
const stats = client.getStats();
console.log(`Posts today: ${stats.todayPosts}/${stats.maxDailyPosts}`);
```

---

## ⏰ Cron Integration

### Basic Cron Job

```bash
# Post every 4 hours with random jitter
0 */4 * * * npx x-safe-post post "$(cat /path/to/tweets.txt | shuf -n 1)"
```

### Smart Cron (Check Time First)

```bash
#!/bin/bash
# smart-post.sh

NEXT_TIME=$(x-safe-post next-time --unix)
NOW=$(date +%s)

if [ $NOW -ge $NEXT_TIME ]; then
  x-safe-post post "$1"
else
  echo "Not yet safe to post. Next: $(x-safe-post next-time)"
fi
```

### With Queue (Node.js)

```typescript
import { XSafePost } from 'x-safe-post';
import { CronJob } from 'cron';

const client = new XSafePost({ /* config */ });
const queue: string[] = [
  'Tweet 1',
  'Tweet 2',
  'Tweet 3',
];

// Run every hour, but tool handles actual timing
new CronJob('0 * * * *', async () => {
  if (queue.length === 0) return;
  
  const text = queue.shift()!;
  const result = await client.postAndWait({ text });
  
  if (result.success) {
    console.log(`Posted: ${text}`);
  }
}, null, true);
```

---

## 🛡️ Shadowban Avoidance Tips

This tool handles most issues automatically, but here are extra tips:

### Do ✅
- Vary your content
- Engage with others (not just post)
- Use 1-2 hashtags max
- Post during normal hours
- Mix media types (text, images, threads)

### Don't ❌
- Post identical content
- Use 5+ hashtags
- Post at exact intervals
- Use URL shorteners
- Mention-spam people
- Post 24/7 without breaks

---

## 🔧 Configuration Reference

| Option | Default | Description |
|--------|---------|-------------|
| `minIntervalMinutes` | 30 | Minimum minutes between posts |
| `maxPostsPerDay` | 8 | Maximum posts per 24 hours |
| `enableJitter` | true | Add random timing variance |
| `maxJitterMinutes` | 30 | Maximum jitter in minutes |
| `dedupeWindowDays` | 7 | Days to check for duplicates |
| `quietHoursStart` | 23 | Hour to start quiet period (0-23) |
| `quietHoursEnd` | 6 | Hour to end quiet period (0-23) |
| `enableQuietHours` | true | Enable quiet hour restrictions |

---

## 📄 License

MIT License - see [LICENSE](./LICENSE)

---

## 🔗 Links

- [GitHub](https://github.com/lxgicstudios/x-safe-post)
- [npm](https://www.npmjs.com/package/x-safe-post)
- [Twitter/X](https://x.com/lxgicstudios)
- [Website](https://lxgicstudios.com)

---

<p align="center">
  <b>Built by <a href="https://lxgicstudios.com">LXGIC Studios</a></b><br>
  Free AI dev tools. No installs. Just npx and go.
</p>
