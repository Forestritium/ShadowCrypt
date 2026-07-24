import puppeteer from 'puppeteer';
import { exec } from 'child_process';

async function run() {
  const server = exec('npm run preview', { cwd: '/workspace/app-bu2wys49rfgh' });
  
  // Wait for server to start
  await new Promise(r => setTimeout(r, 3000));

  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
  page.on('pageerror', err => console.log('BROWSER ERROR:', err.toString()));
  
  await page.goto('http://localhost:4173');
  await new Promise(r => setTimeout(r, 2000));
  
  await browser.close();
  server.kill();
  process.exit(0);
}

run();
