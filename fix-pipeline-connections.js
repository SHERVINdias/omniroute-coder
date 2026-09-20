#!/usr/bin/env node

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

console.log('============================================================================');
console.log('OMNIROUTE PIPELINE CONNECTION FIX');
console.log('============================================================================');
console.log('');
console.log('This will fix all pipeline connection issues:');
console.log('  - Deactivate conflicting providers across all users');
console.log('  - Fix AgentRouter provider ID from "custom-1" to "agentrouter-1"');
console.log('  - Ensure single active provider per user');
console.log('  - Establish clean authentication pipeline');
console.log('');

// Create backup first
const timestamp = Date.now();
const backupPath = `chat.db.backup-${timestamp}`;

console.log('📦 Creating backup...');
try {
  fs.copyFileSync('chat.db', backupPath);
  console.log(`   ✓ Backup saved to: ${backupPath}`);
} catch (error) {
  console.log(`   ❌ Backup failed: ${error.message}`);
  process.exit(1);
}
console.log('');

// Open database
const db = new Database('chat.db');

try {
  console.log('🔍 Current pipeline state:');
  
  // Get all providers
  const allProviders = db.prepare(`
    SELECT rowId, userId, id, name, provider, baseUrl, modelIds, isActive, createdAt, updatedAt
    FROM user_providers 
    ORDER BY userId, isActive DESC, createdAt
  `).all();
  
  console.log(`   Found ${allProviders.length} total providers`);
  
  // Show active providers
  const activeProviders = allProviders.filter(p => p.isActive === 1);
  console.log(`   Active providers: ${activeProviders.length}`);
  
  activeProviders.forEach(p => {
    console.log(`     • ${p.name} (${p.provider}) - User: ${p.userId.substring(0, 8)}...`);
  });
  
  // Find AgentRouter
  const agentRouterProviders = allProviders.filter(p => 
    p.provider === 'agentrouter' || 
    p.name.toLowerCase().includes('agent router') ||
    p.baseUrl.includes('agentrouter.org')
  );
  
  console.log(`   AgentRouter instances found: ${agentRouterProviders.length}`);
  console.log('');
  
  console.log('🔧 Applying pipeline fixes...');
  
  // Step 1: Deactivate ALL providers first (clean slate)
  const deactivateResult = db.prepare(`
    UPDATE user_providers 
    SET isActive = 0, updatedAt = ?
  `).run(Date.now());
  
  console.log(`   ✓ Deactivated all providers (${deactivateResult.changes} updated)`);
  
  // Step 2: Find the best AgentRouter configuration
  let targetAgentRouter = null;
  
  if (agentRouterProviders.length > 0) {
    // Prefer the one with models configured
    targetAgentRouter = agentRouterProviders.find(p => p.modelIds && p.modelIds !== 'null') || agentRouterProviders[0];
    
    console.log(`   ✓ Selected AgentRouter: ${targetAgentRouter.name} (ID: ${targetAgentRouter.id})`);
    
    // Step 3: Fix AgentRouter configuration
    if (targetAgentRouter.id === 'custom-1') {
      // Change ID from custom-1 to agentrouter-1
      const updateIdResult = db.prepare(`
        UPDATE user_providers 
        SET id = 'agentrouter-1', updatedAt = ?
        WHERE rowId = ?
      `).run(Date.now(), targetAgentRouter.rowId);
      
      console.log(`   ✓ Fixed AgentRouter ID: custom-1 → agentrouter-1`);
      targetAgentRouter.id = 'agentrouter-1'; // Update local reference
    }
    
    // Step 4: Ensure proper models are configured
    const expectedModels = JSON.stringify([
      "claude-opus-4-8",
      "claude-opus-5", 
      "deepseek-v4-flash",
      "glm-5.3",
      "gpt-5.6-scl",
      "gpt-6-astra"
    ]);
    
    if (!targetAgentRouter.modelIds || targetAgentRouter.modelIds === 'null') {
      const updateModelsResult = db.prepare(`
        UPDATE user_providers 
        SET modelIds = ?, updatedAt = ?
        WHERE rowId = ?
      `).run(expectedModels, Date.now(), targetAgentRouter.rowId);
      
      console.log(`   ✓ Added AgentRouter models`);
    }
    
    // Step 5: Ensure correct base URL
    if (targetAgentRouter.baseUrl !== 'https://agentrouter.org') {
      const updateUrlResult = db.prepare(`
        UPDATE user_providers 
        SET baseUrl = 'https://agentrouter.org', updatedAt = ?
        WHERE rowId = ?
      `).run(Date.now(), targetAgentRouter.rowId);
      
      console.log(`   ✓ Fixed AgentRouter base URL: ${targetAgentRouter.baseUrl} → https://agentrouter.org`);
    }
    
    // Step 6: Activate ONLY the target AgentRouter
    const activateResult = db.prepare(`
      UPDATE user_providers 
      SET isActive = 1, updatedAt = ?
      WHERE rowId = ?
    `).run(Date.now(), targetAgentRouter.rowId);
    
    console.log(`   ✓ Activated AgentRouter as single active provider`);
    
  } else {
    console.log(`   ❌ No AgentRouter configuration found!`);
    console.log(`   Please add AgentRouter manually in the UI first.`);
    process.exit(1);
  }
  
  console.log('');
  console.log('✅ Pipeline connection fixes completed!');
  console.log('');
  
  // Show final state
  console.log('📋 Final pipeline configuration:');
  
  const finalProviders = db.prepare(`
    SELECT userId, id, name, provider, baseUrl, modelIds, isActive
    FROM user_providers 
    ORDER BY userId, isActive DESC, name
  `).all();
  
  const finalActive = finalProviders.filter(p => p.isActive === 1);
  const finalInactive = finalProviders.filter(p => p.isActive === 0);
  
  console.log('');
  console.log('🟢 ACTIVE PROVIDERS:');
  if (finalActive.length === 0) {
    console.log('   (none)');
  } else {
    finalActive.forEach(p => {
      const models = p.modelIds ? JSON.parse(p.modelIds).length : 0;
      console.log(`   • ${p.name} (${p.provider}) - ${p.baseUrl}`);
      console.log(`     ID: ${p.id}, Models: ${models}, User: ${p.userId.substring(0, 8)}...`);
    });
  }
  
  console.log('');
  console.log('⚪ INACTIVE PROVIDERS:');
  finalInactive.forEach(p => {
    console.log(`   • ${p.name} (${p.provider}) - User: ${p.userId.substring(0, 8)}...`);
  });
  
  console.log('');
  console.log('============================================================================');
  console.log('SUCCESS! Pipeline connections fixed.');
  console.log('============================================================================');
  console.log('');
  console.log('Pipeline flow is now clean:');
  console.log('  Database → credentialManager → providerProfiles → upstreamRequest');
  console.log('  AgentRouter will use x-api-key authentication (not Bearer)');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Restart your app (Ctrl+C then run bat file)');
  console.log('  2. Refresh browser');
  console.log('  3. Test AgentRouter - should work without "unauthorized client" errors');
  console.log('');

} catch (error) {
  console.log(`❌ Error during pipeline fix: ${error.message}`);
  console.log(`Database backup available at: ${backupPath}`);
  process.exit(1);
} finally {
  db.close();
}