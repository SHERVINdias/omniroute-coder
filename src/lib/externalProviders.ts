/**
 * External Gateway Providers Handler — SUPERSEDED, NOT IMPORTED ANYWHERE.
 *
 * DO NOT WIRE THIS BACK UP AS IT STANDS.
 *
 * Nothing in src/ imports this module. It is the library half of the retired
 * /api/external-chat and /api/external-models routes, and it has the same flaw
 * those routes were retired for: `fetchExternalModels` and the chat function
 * below take `config.baseUrl` and fetch it with no SSRF guard and no
 * `redirect: "manual"`. Importing it from a route would hand any signed-in user
 * a request proxy into the server's own network, with an attacker-chosen
 * Authorization header attached — on a cloud VPS that includes the instance
 * metadata address.
 *
 * The live path is src/lib/upstreamRequest.ts. It resolves the endpoint and the
 * auth scheme from the provider profile (so Azure's `api-key` and Anthropic's
 * `x-api-key` are handled rather than assumed to be Bearer), calls
 * `guardUpstreamUrl` before opening a connection, and refuses redirects. Add
 * new providers to src/lib/providerProfiles.ts and let that path serve them.
 *
 * Kept, rather than deleted, so this note exists where someone would look.
 *
 * ---------------------------------------------------------------------------
 * Original description:
 *
 * This module handles communication with external AI gateways like Agent Router,
 * OpenRouter, etc. that are NOT running on localhost and have their own authentication.
 *
 * This is completely separate from the OmniRoute localhost pipeline.
 */

export interface ExternalProviderConfig {
  baseUrl: string;
  apiKey: string;
  provider: string;
  authScheme?: 'bearer' | 'x-api-key';
  proxyUrl?: string;
}

export interface ExternalChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ExternalChatRequest {
  model: string;
  messages: ExternalChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

/**
 * Normalize base URL to ensure it has /v1 path for Agent Router
 */
export function normalizeExternalBaseUrl(baseUrl: string, provider: string): string {
  let normalized = baseUrl.trim();
  
  // Remove trailing slash
  if (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  
  // Agent Router needs /v1 path
  if (provider === 'agentrouter' && !normalized.includes('/v1')) {
    normalized = `${normalized}/v1`;
  }
  
  return normalized;
}

/**
 * Get the appropriate auth header for external provider
 */
export function getExternalAuthHeader(config: ExternalProviderConfig): Record<string, string> {
  const authScheme = config.authScheme || 'bearer';
  
  if (authScheme === 'x-api-key') {
    return {
      'x-api-key': config.apiKey
    };
  }
  
  // Default to Bearer
  return {
    'Authorization': `Bearer ${config.apiKey}`
  };
}

/**
 * Get WAF bypass headers for Agent Router
 */
export function getWAFBypassHeaders(provider: string): Record<string, string> {
  if (provider === 'agentrouter') {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'HTTP-Referer': 'https://localhost:3000',
      'X-Title': 'Omni-Claude'
    };
  }
  
  return {};
}

/**
 * Build headers for external provider request
 */
export function buildExternalHeaders(config: ExternalProviderConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...getExternalAuthHeader(config),
    ...getWAFBypassHeaders(config.provider)
  };
}

/**
 * Fetch models from external provider
 */
export async function fetchExternalModels(config: ExternalProviderConfig): Promise<any[]> {
  const baseUrl = normalizeExternalBaseUrl(config.baseUrl, config.provider);
  const headers = buildExternalHeaders(config);
  
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10000)
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.data || [];
  } catch (error) {
    console.error('[externalProviders] Failed to fetch models:', error);
    throw error;
  }
}

/**
 * Post chat completion to external provider
 */
export async function postExternalChatCompletion(
  config: ExternalProviderConfig,
  request: ExternalChatRequest
): Promise<Response> {
  const baseUrl = normalizeExternalBaseUrl(config.baseUrl, config.provider);
  const headers = buildExternalHeaders(config);
  
  const endpoint = `${baseUrl}/chat/completions`;
  
  console.log('[externalProviders] Posting to:', endpoint);
  console.log('[externalProviders] Model:', request.model);
  
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(request)
    });
    
    return response;
  } catch (error) {
    console.error('[externalProviders] Request failed:', error);
    throw error;
  }
}
