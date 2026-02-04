#!/usr/bin/env node

/**
 * x-safe-post CLI
 * Post to X/Twitter with shadowban avoidance
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import Conf from 'conf';
import { XSafePost, XSafeConfig, SafetySettings } from './index.js';
import { browserPost } from './browser.js';

const config = new Conf<{
  credentials?: XSafeConfig['credentials'];
  safety?: SafetySettings;
  mode?: 'api' | 'browser';
}>({
  projectName: 'x-safe-post',
});

const program = new Command();

program
  .name('x-safe-post')
  .description('Post to X/Twitter with built-in shadowban avoidance')
  .version('1.0.0');

// ============================================
// CONFIGURE COMMAND
// ============================================

program
  .command('config')
  .description('Configure X API credentials or browser mode')
  .option('--app-key <key>', 'X API App Key')
  .option('--app-secret <secret>', 'X API App Secret')
  .option('--access-token <token>', 'X API Access Token')
  .option('--access-secret <secret>', 'X API Access Secret')
  .option('--mode <mode>', 'Posting mode: api or browser', 'api')
  .option('--min-interval <minutes>', 'Minimum minutes between posts', '30')
  .option('--max-daily <count>', 'Maximum posts per day', '8')
  .option('--quiet-start <hour>', 'Quiet hours start (0-23)', '23')
  .option('--quiet-end <hour>', 'Quiet hours end (0-23)', '6')
  .option('--no-jitter', 'Disable random timing jitter')
  .option('--show', 'Show current configuration')
  .action((options) => {
    if (options.show) {
      const creds = config.get('credentials');
      const safety = config.get('safety') || {};
      const mode = config.get('mode') || 'api';
      
      console.log(chalk.bold('\n📋 Current Configuration\n'));
      
      console.log(chalk.bold('Mode:'), mode === 'browser' ? chalk.cyan('browser (no API keys)') : 'api');
      console.log();
      
      if (mode === 'api') {
        if (creds) {
          console.log(chalk.green('✓ API Credentials configured'));
          console.log(`  App Key: ${creds.appKey.slice(0, 8)}...`);
          console.log(`  Access Token: ${creds.accessToken.slice(0, 8)}...`);
        } else {
          console.log(chalk.red('✗ API Credentials not configured'));
        }
      } else {
        console.log(chalk.cyan('ℹ Browser mode - uses logged-in Chrome session'));
        console.log(chalk.dim('  Make sure you\'re logged into x.com in Chrome'));
      }
      
      console.log(chalk.bold('\n⚙️  Safety Settings'));
      console.log(`  Min interval: ${safety.minIntervalMinutes || 30} minutes`);
      console.log(`  Max daily posts: ${safety.maxPostsPerDay || 8}`);
      console.log(`  Quiet hours: ${safety.quietHoursStart || 23}:00 - ${safety.quietHoursEnd || 6}:00`);
      console.log(`  Jitter: ${safety.enableJitter !== false ? 'enabled' : 'disabled'}`);
      console.log();
      return;
    }

    // Save credentials
    if (options.appKey && options.appSecret && options.accessToken && options.accessSecret) {
      config.set('credentials', {
        appKey: options.appKey,
        appSecret: options.appSecret,
        accessToken: options.accessToken,
        accessSecret: options.accessSecret,
      });
      console.log(chalk.green('✓ Credentials saved'));
    }

    // Save safety settings
    const safety: SafetySettings = config.get('safety') || {};
    
    if (options.minInterval) {
      safety.minIntervalMinutes = parseInt(options.minInterval, 10);
    }
    if (options.maxDaily) {
      safety.maxPostsPerDay = parseInt(options.maxDaily, 10);
    }
    if (options.quietStart) {
      safety.quietHoursStart = parseInt(options.quietStart, 10);
    }
    if (options.quietEnd) {
      safety.quietHoursEnd = parseInt(options.quietEnd, 10);
    }
    if (options.jitter === false) {
      safety.enableJitter = false;
    }

    // Save mode
    if (options.mode && (options.mode === 'api' || options.mode === 'browser')) {
      config.set('mode', options.mode);
      console.log(chalk.green(`✓ Mode set to: ${options.mode}`));
    }

    config.set('safety', safety);
    console.log(chalk.green('✓ Settings saved'));
  });

// ============================================
// POST COMMAND
// ============================================

program
  .command('post <text>')
  .description('Post a tweet with safety checks')
  .option('-r, --reply-to <tweetId>', 'Reply to a tweet')
  .option('-q, --quote <tweetId>', 'Quote a tweet')
  .option('-i, --image <path>', 'Attach an image')
  .option('-f, --force', 'Skip safety checks (not recommended)')
  .option('-w, --wait', 'Wait if delayed instead of returning')
  .option('-b, --browser', 'Force browser mode (no API keys)')
  .option('--dry-run', 'Check safety without posting')
  .action(async (text, options) => {
    const mode = options.browser ? 'browser' : (config.get('mode') || 'api');
    
    // Browser mode - use browser automation
    if (mode === 'browser') {
      const spinner = ora('Posting via browser...').start();
      
      try {
        const replyUrl = options.replyTo 
          ? `https://x.com/i/status/${options.replyTo}` 
          : undefined;
        
        const result = await browserPost({
          text,
          imagePath: options.image,
          replyToUrl: replyUrl,
        });
        
        spinner.stop();
        
        if (result.success) {
          console.log(chalk.green('\n✓ Posted via browser!'));
          console.log(chalk.dim(`  Method: ${result.method}`));
        } else {
          console.log(chalk.red(`\n✗ Browser post failed: ${result.error}`));
        }
        console.log();
        return;
      } catch (error: any) {
        spinner.stop();
        console.error(chalk.red(`\n✗ Browser error: ${error.message}\n`));
        process.exit(1);
      }
    }
    
    // API mode
    const client = getClient();
    if (!client) return;

    const spinner = ora('Checking safety...').start();

    try {
      // Dry run - just check safety
      if (options.dryRun) {
        const check = await client.checkSafety(text);
        spinner.stop();
        
        console.log(chalk.bold('\n🔍 Safety Check Results\n'));
        
        if (check.safe) {
          console.log(chalk.green('✓ Safe to post\n'));
        } else {
          console.log(chalk.red('✗ Not safe to post\n'));
        }
        
        if (check.errors.length > 0) {
          console.log(chalk.red('Errors:'));
          check.errors.forEach(e => console.log(chalk.red(`  • ${e}`)));
          console.log();
        }
        
        if (check.warnings.length > 0) {
          console.log(chalk.yellow('Warnings:'));
          check.warnings.forEach(w => console.log(chalk.yellow(`  • ${w}`)));
          console.log();
        }
        
        if (check.suggestions.length > 0) {
          console.log(chalk.blue('Suggestions:'));
          check.suggestions.forEach(s => console.log(chalk.blue(`  • ${s}`)));
          console.log();
        }

        const stats = client.getStats();
        console.log(chalk.dim(`Posts today: ${stats.todayPosts}/${stats.maxDailyPosts}`));
        console.log(chalk.dim(`Next allowed: ${stats.nextAllowedAt.toLocaleTimeString()}`));
        return;
      }

      // Actually post
      spinner.text = 'Posting...';
      
      const postFn = options.wait ? client.postAndWait.bind(client) : client.post.bind(client);
      
      const result = await postFn({
        text,
        replyTo: options.replyTo,
        quoteTweetId: options.quote,
        force: options.force,
      });

      spinner.stop();

      if (result.success) {
        console.log(chalk.green('\n✓ Posted successfully!'));
        console.log(chalk.dim(`  Tweet ID: ${result.tweetId}`));
        console.log(chalk.dim(`  https://x.com/i/status/${result.tweetId}`));
      } else if (result.delayed) {
        console.log(chalk.yellow('\n⏳ Post delayed'));
        console.log(chalk.dim(`  Reason: ${result.blockReason}`));
        console.log(chalk.dim(`  Scheduled for: ${result.scheduledFor?.toLocaleString()}`));
        console.log(chalk.dim(`  Use --wait to auto-wait, or --force to skip`));
      } else if (result.blocked) {
        console.log(chalk.red('\n✗ Post blocked'));
        console.log(chalk.dim(`  Reason: ${result.blockReason}`));
        if (result.rateLimitReset) {
          console.log(chalk.dim(`  Rate limit resets: ${result.rateLimitReset.toLocaleString()}`));
        }
      }
      console.log();
      
    } catch (error: any) {
      spinner.stop();
      console.error(chalk.red(`\n✗ Error: ${error.message}\n`));
      process.exit(1);
    }
  });

// ============================================
// CHECK COMMAND
// ============================================

program
  .command('check')
  .description('Check for potential shadowban')
  .action(async () => {
    const client = getClient();
    if (!client) return;

    const spinner = ora('Checking shadowban status...').start();

    try {
      const result = await client.checkShadowban();
      spinner.stop();

      console.log(chalk.bold('\n🔍 Shadowban Check\n'));

      result.checks.forEach(check => {
        const icon = check.passed ? chalk.green('✓') : chalk.red('✗');
        console.log(`${icon} ${check.name}`);
        if (check.details) {
          console.log(chalk.dim(`    ${check.details}`));
        }
      });

      console.log();
      
      if (result.likely) {
        console.log(chalk.yellow('⚠️  Possible shadowban detected'));
        console.log(chalk.dim('  Recommendations:'));
        console.log(chalk.dim('  • Stop all automation for 48-72 hours'));
        console.log(chalk.dim('  • Engage manually with other accounts'));
        console.log(chalk.dim('  • Review recent posts for policy violations'));
      } else {
        console.log(chalk.green('✓ No shadowban detected'));
      }
      console.log();
      
    } catch (error: any) {
      spinner.stop();
      console.error(chalk.red(`\n✗ Error: ${error.message}\n`));
      process.exit(1);
    }
  });

// ============================================
// STATS COMMAND
// ============================================

program
  .command('stats')
  .description('Show posting statistics')
  .action(() => {
    const client = getClient();
    if (!client) return;

    const stats = client.getStats();

    console.log(chalk.bold('\n📊 Posting Statistics\n'));
    console.log(`  Posts today: ${stats.todayPosts}/${stats.maxDailyPosts}`);
    console.log(`  Last post: ${stats.lastPostAt?.toLocaleString() || 'Never'}`);
    console.log(`  Next allowed: ${stats.nextAllowedAt.toLocaleString()}`);
    console.log(`  Posts (7 days): ${stats.recentPosts}`);
    
    if (stats.rateLimitRemaining !== null) {
      console.log(`  Rate limit: ${stats.rateLimitRemaining} remaining`);
      if (stats.rateLimitReset) {
        console.log(`  Resets: ${stats.rateLimitReset.toLocaleString()}`);
      }
    }
    console.log();
  });

// ============================================
// CLEAR COMMAND
// ============================================

program
  .command('clear')
  .description('Clear post history and counters')
  .option('--history', 'Clear post history only')
  .option('--daily', 'Reset daily counter only')
  .option('--all', 'Clear everything')
  .action((options) => {
    const client = getClient();
    if (!client) return;

    if (options.history || options.all) {
      client.clearHistory();
      console.log(chalk.green('✓ Post history cleared'));
    }
    
    if (options.daily || options.all) {
      client.resetDailyCount();
      console.log(chalk.green('✓ Daily counter reset'));
    }
    
    if (!options.history && !options.daily && !options.all) {
      console.log(chalk.yellow('Specify --history, --daily, or --all'));
    }
  });

// ============================================
// SCHEDULE COMMAND (for cron integration)
// ============================================

program
  .command('next-time')
  .description('Output next safe posting time (for cron integration)')
  .option('--unix', 'Output as Unix timestamp')
  .option('--iso', 'Output as ISO 8601')
  .action((options) => {
    const client = getClient();
    if (!client) return;

    const next = client.getNextPostTime();
    
    if (options.unix) {
      console.log(Math.floor(next.getTime() / 1000));
    } else if (options.iso) {
      console.log(next.toISOString());
    } else {
      console.log(next.toLocaleString());
    }
  });

// ============================================
// HELPERS
// ============================================

function getClient(): XSafePost | null {
  const creds = config.get('credentials');
  
  if (!creds) {
    console.error(chalk.red('\n✗ Not configured. Run: x-safe-post config --help\n'));
    return null;
  }

  return new XSafePost({
    credentials: creds,
    safety: config.get('safety'),
  });
}

program.parse();
