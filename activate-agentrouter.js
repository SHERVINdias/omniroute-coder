#!/usr/bin/env node

const Database = require('better-sqlite3');
const path = require('path');

console.log('============================================================================');
console.log('AgentRouter Activation Script');
console.log('============================================================================\n');

const dbPath = path.join(__dirname, 'chat.db');

try {
  const db = new Database(dbPath);
  
  console.log('📦 Creating backup...');
  const backupPath = `chat.db.backup-${Date.now()}`;
  db.backup(backupPath);
  console.log(`   ✓ Backup saved to: ${backupPath}\n`);
  
  console.log('🔍 Current AgentRouter status:');
  const agentRouterProvider = db.prepare(`
    SELECT * FROM user_providers 
    WHERE provider = 'agentrouter' OR name LIKE '%Agent Router%'
  `).get();
  
  if (!agentRouterProvider) {
    console.log('   ❌ No AgentRouter provider found!');
    process.exit(1);
  }
  
  console.log(`   Provider ID: ${agentRouterProvider.id}`);
  console.log(`   Name: ${agentRouterProvider.name}`);
  console.log(`   Base URL: ${agentRouterProvider.baseUrl}`);
  console.log(`   Active: ${agentRouterProvider.isActive ? 'YES' : 'NO'}`);
  console.log(`   User ID: ${agentRouterProvider.userId}\n`);
  
  if (agentRouterProvider.isActive) {
    console.log('✅ AgentRouter is already active! No changes needed.');
  } else {
    console.log('🔧 Activating AgentRouter...');
    
    // Deactivate all other providers for this user to avoid conflicts
    const deactivateOthers = db.prepare(`
      UPDATE user_providers 
      SET isActive = 0 
      WHERE userId = ? AND rowId != ?
    `);
    
    // Activate AgentRouter
    const activateAgentRouter = db.prepare(`
      UPDATE user_providers 
      SET isActive = 1 
      WHERE rowId = ?
    `);
    
    const transaction = db.transaction(() => {
      deactivateOthers.run(agentRouterProvider.userId, agentRouterProvider.rowId);
      activateAgentRouter.run(agentRouterProvider.rowId);
    });
    
    transaction();
    
    console.log('   ✓ AgentRouter activated!');
    console.log('   ✓ Other providers deactivated to avoid conflicts\n');
  }
  
  // Show final status
  console.log('✅ Final configuration:');
  const activeProviders = db.prepare(`
    SELECT id, name, provider, baseUrl, isActive 
    FROM user_providers 
    WHERE userId = ?
    ORDER BY isActive DESC, rowId
  `).all(agentRouterProvider.userId);
  
  activeProviders.forEach(p => {
    const status = p.isActive ? '🟢 ACTIVE' : '⚪ INACTIVE';
    console.log(`   ${status}: ${p.name} (${p.provider}) - ${p.baseUrl}`);
  });
  
  db.close();
  
  console.log('\n============================================================================');
  console.log('SUCCESS! AgentRouter is now active.');
  console.log('============================================================================\n');
  
  console.log('Next steps:');
  console.log('  1. Stop your current server (Ctrl+C)');
  console.log('  2. Restart your app: omniroute-external-providers-version-6.9.bat');
  console.log('  3. Refresh your browser');
  console.log('  4. Test AgentRouter - it should now work!\n');
  
} catch (error) {
  console.error('❌ Error:', error.message);
  process.exit(1);
}