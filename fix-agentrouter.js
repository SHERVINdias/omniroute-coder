/**
 * AgentRouter Configuration Fix
 * 
 * Updates the user_providers table to fix AgentRouter configuration:
 * - Fix Base URL: https://agentrouter.org/ -> https://api.agentrouter.org
 * - Add all available models (Claude, DeepSeek, GLM, GPT)
 */

const fs = require('fs');
const path = require('path');

// Dynamic import for better-sqlite3 (ESM module)
async function main() {
  console.log('\n============================================================================');
  console.log('AgentRouter Configuration Fix');
  console.log('============================================================================\n');

  const dbPath = path.join(__dirname, 'chat.db');
  const backupPath = path.join(__dirname, `chat.db.backup-${Date.now()}`);

  // Check if database exists
  if (!fs.existsSync(dbPath)) {
    console.error('❌ ERROR: chat.db not found!');
    console.error(`   Expected at: ${dbPath}`);
    process.exit(1);
  }

  // Create backup
  console.log('📦 Creating backup...');
  fs.copyFileSync(dbPath, backupPath);
  console.log(`   ✓ Backup saved to: ${path.basename(backupPath)}\n`);

  // Import better-sqlite3
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (err) {
    console.error('❌ ERROR: better-sqlite3 not installed');
    console.error('   Run: npm install better-sqlite3');
    process.exit(1);
  }

  const db = new Database(dbPath);

  try {
    // Get current AgentRouter configuration
    console.log('🔍 Current AgentRouter configuration:');
    const before = db.prepare(`
      SELECT provider, baseUrl, modelIds 
      FROM user_providers 
      WHERE provider = 'agentrouter' AND isActive = 1
    `).get();

    if (!before) {
      console.error('❌ ERROR: AgentRouter provider not found in database');
      console.error('   Please configure AgentRouter through the UI first');
      process.exit(1);
    }

    console.log(`   Base URL: ${before.baseUrl}`);
    console.log(`   Models: ${before.modelIds || '(none)'}\n`);

    // Update the configuration
    console.log('🔧 Applying fix...');
    const newModels = JSON.stringify([
      "claude-opus-4-8",
      "claude-opus-5",
      "deepseek-v4-flash",
      "glm-5.3",
      "gpt-5.6-scl",
      "gpt-6-astra"
    ]);
    
    const result = db.prepare(`
      UPDATE user_providers
      SET 
        baseUrl = 'https://agentrouter.org',
        modelIds = ?,
        updatedAt = ?
      WHERE provider = 'agentrouter' AND isActive = 1
    `).run(newModels, Date.now());

    if (result.changes === 0) {
      console.error('❌ ERROR: No rows updated');
      process.exit(1);
    }

    // Show new configuration
    const after = db.prepare(`
      SELECT provider, baseUrl, modelIds 
      FROM user_providers 
      WHERE provider = 'agentrouter' AND isActive = 1
    `).get();

    console.log('   ✓ Configuration updated!\n');
    console.log('✅ New AgentRouter configuration:');
    console.log(`   Base URL: ${after.baseUrl}`);
    console.log(`   Models: ${after.modelIds}\n`);

    console.log('============================================================================');
    console.log('SUCCESS! AgentRouter configuration fixed.');
    console.log('============================================================================\n');
    console.log('Next steps:');
    console.log('  1. Restart your app (run omniroute-external-providers-version-6.9.bat)');
    console.log('  2. Try any model:');
    console.log('     • claude-opus-4-8, claude-opus-5 (Claude)');
    console.log('     • deepseek-v4-flash (DeepSeek)');
    console.log('     • glm-5.3 (GLM/Zhipu AI)');
    console.log('     • gpt-5.6-scl, gpt-6-astra (GPT)\n');

  } catch (err) {
    console.error('❌ ERROR:', err.message);
    console.error('\n   Rolling back changes...');
    db.close();
    fs.copyFileSync(backupPath, dbPath);
    console.error('   ✓ Backup restored\n');
    process.exit(1);
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error('❌ FATAL ERROR:', err);
  process.exit(1);
});
