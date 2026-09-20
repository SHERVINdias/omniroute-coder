-- ============================================================================
-- AgentRouter Configuration Fix
-- ============================================================================
-- 
-- This script updates your AgentRouter provider configuration in the database
-- to fix the "unauthorized client" error and add support for all available
-- models (Claude, DeepSeek, GLM, GPT).
--
-- WHAT THIS FIXES:
-- 1. Base URL: https://agentrouter.org/ → https://api.agentrouter.org
-- 2. Adds all available model IDs from AgentRouter's model list
--
-- HOW TO RUN:
-- Option 1 - SQLite CLI:
--   sqlite3 chat.db < fix-agentrouter-config.sql
--
-- Option 2 - DB Browser for SQLite:
--   1. Open chat.db in DB Browser
--   2. Go to "Execute SQL" tab
--   3. Copy/paste this script and click "Execute"
--
-- Option 3 - Command Prompt:
--   sqlite3 chat.db ".read fix-agentrouter-config.sql"
--
-- ============================================================================

BEGIN TRANSACTION;

-- Show current AgentRouter configuration (for verification)
SELECT 
  '=== BEFORE UPDATE ===' AS status,
  userId,
  id,
  name,
  provider,
  baseUrl,
  modelIds,
  isActive
FROM user_providers 
WHERE provider = 'agentrouter';

-- Update the base URL and add all available models
UPDATE user_providers
SET 
  baseUrl = 'https://api.agentrouter.org',
  modelIds = 'claude-opus-4-8,claude-opus-5,deepseek-v4-flash,glm-5.3,gpt-5.6-scl,gpt-6-astra',
  updatedAt = unixepoch() * 1000
WHERE provider = 'agentrouter';

-- Show updated configuration
SELECT 
  '=== AFTER UPDATE ===' AS status,
  userId,
  id,
  name,
  provider,
  baseUrl,
  modelIds,
  isActive
FROM user_providers 
WHERE provider = 'agentrouter';

-- Show number of rows updated
SELECT changes() AS rows_updated;

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
--
-- After running this script:
-- 1. Restart your application (run the .bat file)
-- 2. In the UI, your AgentRouter provider should now show:
--    - Base URL: https://api.agentrouter.org
--    - Model IDs: claude-opus-4-8, claude-opus-5, deepseek-v4-flash, 
--                 glm-5.3, gpt-5.6-scl, gpt-6-astra
-- 3. Try sending a message with any of these models
-- 4. The "unauthorized client" error should be gone!
--
-- AVAILABLE MODELS:
-- - claude-opus-4-8   (Anthropic Claude Opus 4.8)
-- - claude-opus-5     (Anthropic Claude Opus 5)
-- - deepseek-v4-flash (DeepSeek V4 Flash)
-- - glm-5.3           (GLM 5.3)
-- - gpt-5.6-scl       (GPT 5.6 SCL)
-- - gpt-6-astra       (GPT 6 Astra)
--
-- ============================================================================
