/**
 * Browser Mode for x-safe-post
 * Post to X/Twitter without API keys using logged-in browser session
 * 
 * macOS: Uses AppleScript + Chrome clipboard paste
 * Other: Uses Playwright with existing Chrome profile
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const execAsync = promisify(exec);

export interface BrowserPostOptions {
  text: string;
  imagePath?: string;
  replyToUrl?: string;
}

export interface BrowserPostResult {
  success: boolean;
  error?: string;
  method: 'applescript' | 'playwright';
}

/**
 * Post to X using browser automation
 */
export async function browserPost(options: BrowserPostOptions): Promise<BrowserPostResult> {
  const platform = process.platform;
  
  if (platform === 'darwin') {
    return macOSPost(options);
  } else {
    return playwrightPost(options);
  }
}

/**
 * macOS: Use AppleScript to control Chrome
 */
async function macOSPost(options: BrowserPostOptions): Promise<BrowserPostResult> {
  const { text, imagePath, replyToUrl } = options;
  
  try {
    // First, navigate to compose URL or reply URL
    const targetUrl = replyToUrl 
      ? replyToUrl  // Navigate to tweet to reply
      : 'https://x.com/compose/post';
    
    // AppleScript to open Chrome and navigate
    const openScript = `
      tell application "Google Chrome"
        activate
        if (count of windows) = 0 then
          make new window
        end if
        set URL of active tab of front window to "${targetUrl}"
      end tell
    `;
    
    await execAsync(`osascript -e '${openScript.replace(/'/g, "'\"'\"'")}'`);
    
    // Wait for page to load
    await sleep(2000);
    
    // If replying, click reply button first
    if (replyToUrl) {
      const clickReplyScript = `
        tell application "Google Chrome"
          execute active tab of front window javascript "
            const replyBtn = document.querySelector('[data-testid=\\"reply\\"]');
            if (replyBtn) replyBtn.click();
          "
        end tell
      `;
      await execAsync(`osascript -e '${clickReplyScript.replace(/'/g, "'\"'\"'")}'`);
      await sleep(1000);
    }
    
    // Copy text to clipboard
    await execAsync(`echo "${text.replace(/"/g, '\\"')}" | pbcopy`);
    
    // Paste into compose box
    const pasteScript = `
      tell application "Google Chrome"
        activate
        tell application "System Events"
          keystroke "v" using command down
        end tell
      end tell
    `;
    await execAsync(`osascript -e '${pasteScript}'`);
    
    // Handle image if provided
    if (imagePath) {
      await sleep(500);
      
      // Click media button and upload
      const mediaScript = `
        tell application "Google Chrome"
          execute active tab of front window javascript "
            const mediaInput = document.querySelector('input[data-testid=\\"fileInput\\"]');
            if (mediaInput) mediaInput.click();
          "
        end tell
      `;
      await execAsync(`osascript -e '${mediaScript.replace(/'/g, "'\"'\"'")}'`);
      
      await sleep(500);
      
      // Use file dialog
      const fileScript = `
        tell application "System Events"
          keystroke "g" using {command down, shift down}
          delay 0.5
          keystroke "${imagePath}"
          keystroke return
          delay 0.5
          keystroke return
        end tell
      `;
      await execAsync(`osascript -e '${fileScript}'`);
      
      await sleep(2000); // Wait for upload
    }
    
    // Click post button
    await sleep(500);
    const postScript = `
      tell application "Google Chrome"
        execute active tab of front window javascript "
          const postBtn = document.querySelector('[data-testid=\\"tweetButton\\"]') || 
                          document.querySelector('[data-testid=\\"tweetButtonInline\\"]');
          if (postBtn && !postBtn.disabled) postBtn.click();
        "
      end tell
    `;
    await execAsync(`osascript -e '${postScript.replace(/'/g, "'\"'\"'")}'`);
    
    return { success: true, method: 'applescript' };
    
  } catch (error: any) {
    return { 
      success: false, 
      error: error.message,
      method: 'applescript' 
    };
  }
}

/**
 * Cross-platform: Use Playwright with existing Chrome profile
 */
async function playwrightPost(options: BrowserPostOptions): Promise<BrowserPostResult> {
  const { text, imagePath, replyToUrl } = options;
  
  try {
    // Dynamic import to avoid requiring playwright on macOS
    // @ts-ignore - playwright is optional
    const { chromium } = await import('playwright').catch(() => {
      throw new Error('Playwright not installed. Run: npm install playwright');
    });
    
    // Find Chrome profile path based on platform
    const profilePath = getChromiumProfilePath();
    
    // Launch browser with existing profile
    const browser = await chromium.launchPersistentContext(profilePath, {
      headless: false,
      channel: 'chrome',
    });
    
    const page = browser.pages()[0] || await browser.newPage();
    
    // Navigate
    const targetUrl = replyToUrl || 'https://x.com/compose/post';
    await page.goto(targetUrl, { waitUntil: 'networkidle' });
    
    // If replying, click reply button
    if (replyToUrl) {
      const replyBtn = page.locator('[data-testid="reply"]');
      if (await replyBtn.isVisible()) {
        await replyBtn.click();
        await page.waitForTimeout(1000);
      }
    }
    
    // Type the tweet text
    const composeBox = page.locator('[data-testid="tweetTextarea_0"]');
    await composeBox.waitFor({ state: 'visible', timeout: 10000 });
    await composeBox.fill(text);
    
    // Handle image
    if (imagePath) {
      const fileInput = page.locator('input[data-testid="fileInput"]');
      await fileInput.setInputFiles(imagePath);
      await page.waitForTimeout(2000);
    }
    
    // Click post
    const postBtn = page.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
    await postBtn.waitFor({ state: 'visible' });
    await postBtn.click();
    
    // Wait for post to complete
    await page.waitForTimeout(2000);
    
    await browser.close();
    
    return { success: true, method: 'playwright' };
    
  } catch (error: any) {
    return { 
      success: false, 
      error: error.message,
      method: 'playwright' 
    };
  }
}

/**
 * Get Chrome profile path based on platform
 */
function getChromiumProfilePath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    case 'win32':
      return join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
    case 'linux':
      return join(home, '.config', 'google-chrome');
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default browserPost;
