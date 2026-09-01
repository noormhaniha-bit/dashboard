// index.js — main entry point
// Usage: node index.js --file input.json [--output D:\recordings]

const fs   = require('fs');
const path = require('path');
require('dotenv').config();

const { processApplicationId } = require('./browserSession');

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { file: null, output: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file'   && args[i+1]) result.file   = args[++i];
    if (args[i] === '--output' && args[i+1]) result.output = args[++i];
  }
  return result;
}

function loadApplicationIds(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
    if (typeof parsed === 'object') return Object.values(parsed).map(String);
    return [String(parsed)];
  } catch {
    return raw.split('\n').map(l => l.trim()).filter(Boolean);
  }
}

function sanitize(str) {
  return String(str).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 80);
}

function createRunDirectory(baseDir) {
  const now = new Date();
  const month = now.toLocaleString('en-US', { month: 'short' }); // Jun
  const day   = now.getDate();                                    // 29
  const hour  = String(now.getHours()).padStart(2, '0');          // 14
  const min   = String(now.getMinutes()).padStart(2, '0');        // 30
  const name  = `FullStory_Recordings_${month}_${day}_${hour}-${min}`;
  const dir   = path.join(baseDir, name);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`Output directory: ${dir}`);
  return dir;
}

function outputPathFor(outputDir, applicationId, session) {
  const timestamp = session.startTime
    ? new Date(session.startTime).toISOString().replace(/[:.]/g, '-').slice(0, 19)
    : sanitize(session.sessionId).slice(0, 30);
  return path.join(outputDir, sanitize(applicationId), `${sanitize(applicationId)}__${timestamp}.mp4`);
}

async function main() {
  const { file, output } = parseArgs();
  if (!file) {
    console.error('Usage: node index.js --file input.json [--output /path/to/recordings]');
    process.exit(1);
  }
  if (!fs.existsSync(file)) { console.error(`File not found: ${file}`); process.exit(1); }

  const baseDir = output || process.env.OUTPUT_DIR;
  if (!baseDir) { console.error('Set OUTPUT_DIR in .env or pass --output'); process.exit(1); }

  const outputDir = createRunDirectory(baseDir);

  const applicationIds = loadApplicationIds(file);
  console.log(`\nProcessing ${applicationIds.length} applicationId(s)...\n`);

  const summary = { success: [], failed: [], skipped: [] };
  const perApp = {};

  for (const appId of applicationIds) {
    console.log(`\n──── ${appId} ────`);
    perApp[appId] = { sessionsFound: 0, recorded: [], skipped: [], failed: [], fatalError: null };

    try {
      const { success, failed } = await processApplicationId(
        appId, null,
        session => outputPathFor(outputDir, appId, session)
      );
      const totalFound = success.length + failed.length;
      perApp[appId].sessionsFound = totalFound;
      success.forEach(s => { perApp[appId].recorded.push(s); summary.success.push({ appId, ...s }); });
      failed.forEach(f => {
        if (f.reason === 'Already recorded') { perApp[appId].skipped.push(f); summary.skipped.push({ appId, ...f }); }
        else { perApp[appId].failed.push(f); summary.failed.push({ appId, ...f }); }
      });
    } catch (err) {
      console.error(`  Error: ${err.message}`);
      perApp[appId].fatalError = err.message;
      summary.failed.push({ appId, reason: err.message });
    }
  }

  console.log('\n══════════════════════════════════════════');
  console.log(`Done.  Recorded: ${summary.success.length}  Skipped: ${summary.skipped.length}  Failed: ${summary.failed.length}`);

  // Write detailed text report
  const reportPath = path.join(outputDir, 'report.txt');
  writeReport(reportPath, applicationIds, perApp, summary, outputDir);
  console.log(`\nReport: ${reportPath}`);
}

function writeReport(reportPath, applicationIds, perApp, summary, outputDir) {
  const now = new Date();
  const lines = [];

  const sep  = '═'.repeat(60);
  const dash = '─'.repeat(60);

  lines.push(sep);
  lines.push('  FULLSTORY SESSION RECORDING REPORT');
  lines.push(sep);
  lines.push(`  Run date    : ${now.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}`);
  lines.push(`  Run time    : ${now.toLocaleTimeString('en-US')}`);
  lines.push(`  Output dir  : ${outputDir}`);
  lines.push(`  IDs in input: ${applicationIds.length}`);
  lines.push(sep);
  lines.push('');

  // Per-application breakdown
  for (const appId of applicationIds) {
    const app = perApp[appId] || {};
    const totalFound    = app.sessionsFound ?? 0;
    const totalRecorded = (app.recorded ?? []).length;
    const totalSkipped  = (app.skipped  ?? []).length;
    const totalFailed   = (app.failed   ?? []).length;
    const status = app.fatalError
      ? 'FATAL ERROR'
      : totalFound === 0
        ? 'NO SESSIONS FOUND'
        : totalFailed > 0
          ? 'COMPLETED WITH ERRORS'
          : 'SUCCESS';

    lines.push(`ApplicationID : ${appId}`);
    lines.push(`Status        : ${status}`);
    lines.push(`Sessions found: ${totalFound}`);
    lines.push(`  ✓ Recorded  : ${totalRecorded}`);
    lines.push(`  ↷ Skipped   : ${totalSkipped}`);
    lines.push(`  ✗ Failed    : ${totalFailed}`);

    if (app.fatalError) {
      lines.push(`  Error       : ${app.fatalError}`);
    }

    if (totalRecorded > 0) {
      lines.push('  Saved files :');
      (app.recorded ?? []).forEach(s => {
        lines.push(`    • ${path.basename(s.path ?? '')}`);
      });
    }

    if (totalFailed > 0) {
      lines.push('  Failures    :');
      (app.failed ?? []).forEach(f => {
        lines.push(`    • ${f.sessionId ?? 'unknown'} — ${f.reason}`);
      });
    }

    lines.push(dash);
    lines.push('');
  }

  // Overall summary
  lines.push('OVERALL SUMMARY');
  lines.push(dash);
  lines.push(`  Total recorded : ${summary.success.length}`);
  lines.push(`  Total skipped  : ${summary.skipped.length}`);
  lines.push(`  Total failed   : ${summary.failed.length}`);
  const overallStatus = summary.failed.length === 0 ? 'SUCCESS' : summary.success.length > 0 ? 'PARTIAL SUCCESS' : 'FAILED';
  lines.push(`  Run result     : ${overallStatus}`);
  lines.push(sep);

  // Prepend a UTF-8 BOM so Windows tools (Notepad, PowerShell) render the box-drawing
  // and ✓/✗ characters correctly instead of mojibake.
  fs.writeFileSync(reportPath, '﻿' + lines.join('\r\n'), 'utf8');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
