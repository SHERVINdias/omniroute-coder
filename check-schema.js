/**
 * Check actual database schema
 */

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'chat.db');
const db = new Database(dbPath);

console.log('\n=== user_providers table schema ===\n');
const schema = db.prepare(`PRAGMA table_info(user_providers)`).all();
schema.forEach(col => {
  console.log(`${col.name.padEnd(20)} ${col.type.padEnd(10)} ${col.notnull ? 'NOT NULL' : ''}`);
});

console.log('\n=== All Providers ===\n');
try {
  const allRows = db.prepare(`SELECT * FROM user_providers`).all();
  if (allRows.length > 0) {
    allRows.forEach((row, index) => {
      console.log(`Provider ${index + 1}:`);
      console.log(JSON.stringify(row, null, 2));
      console.log('---');
    });
  } else {
    console.log('No providers found in database');
  }
} catch (err) {
  console.error('Error:', err.message);
}

console.log('\n=== AgentRouter specific search ===\n');
try {
  // Search for AgentRouter by name or base URL
  const agentRouterRows = db.prepare(`SELECT * FROM user_providers WHERE 
    provider LIKE '%agent%' OR 
    name LIKE '%Agent%' OR 
    base_url LIKE '%agentrouter%'`).all();
  
  if (agentRouterRows.length > 0) {
    agentRouterRows.forEach((row, index) => {
      console.log(`AgentRouter match ${index + 1}:`);
      console.log(JSON.stringify(row, null, 2));
      console.log('---');
    });
  } else {
    console.log('No AgentRouter configurations found');
  }
} catch (err) {
  console.error('Error:', err.message);
}

db.close();
