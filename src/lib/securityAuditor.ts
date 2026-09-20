/**
 * Security Audit Engine
 * Implements 5-domain security validation with HITL controls
 */

// Conditional imports - only available on server side
const isServer = typeof window === 'undefined';
let fs: any = null;
let path: any = null;

if (isServer) {
  fs = require('fs');
  path = require('path');
}

export interface SecurityViolation {
  rule_id: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  file: string;
  line?: number;
  column?: number;
  description: string;
  suggestion?: string;
  bypassable: boolean;
  evidence?: string;
}

export interface AuditResult {
  domain: string;
  passed: boolean;
  violations: SecurityViolation[];
  summary: string;
}

export interface AuditContext {
  files: string[];
  projectRoot: string;
  targetFiles?: string[];
  sessionBypasses: string[];
}

export class SecurityAuditor {
  private projectRoot: string;
  private sessionBypasses: Set<string> = new Set();

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  async auditCodebase(context: AuditContext): Promise<AuditResult[]> {
    const results: AuditResult[] = [];

    // Run all 5 security domains
    results.push(await this.auditSecretLeakPrevention(context));
    results.push(await this.auditPersonalDataFlow(context));
    results.push(await this.auditProductionReadiness(context));
    results.push(await this.auditAuthLogic(context));
    results.push(await this.auditSecurityReview(context));

    return results;
  }

  // Domain 1: Secret Leak Prevention (Gitleaks-style)
  private async auditSecretLeakPrevention(context: AuditContext): Promise<AuditResult> {
    const violations: SecurityViolation[] = [];
    
    const secretPatterns = [
      {
        id: 'SEC_LEAK_01',
        name: 'Hardcoded API Key',
        pattern: /(?:api[_-]?key|apikey|access[_-]?token)\s*[:=]\s*['"][^'"]{16,}['"][^;]*$/im,
        severity: 'critical' as const,
        bypassable: false
      },
      {
        id: 'SEC_LEAK_02',
        name: 'AWS Access Key',
        pattern: /AKIA[0-9A-Z]{16}/g,
        severity: 'critical' as const,
        bypassable: false
      },
      {
        id: 'SEC_LEAK_03',
        name: 'Database Connection String',
        pattern: /(?:postgres|mysql|mongodb):\/\/[^\/\s]+:[^\/\s]+@[^\/\s]+/gi,
        severity: 'high' as const,
        bypassable: false
      },
      {
        id: 'SEC_LEAK_04',
        name: 'Private Key',
        pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/gi,
        severity: 'critical' as const,
        bypassable: false
      },
      {
        id: 'SEC_LEAK_05',
        name: 'Exposed Environment Variable',
        pattern: /NEXT_PUBLIC_[A-Z_]*(?:KEY|SECRET|TOKEN|PASSWORD)/gi,
        severity: 'medium' as const,
        bypassable: true
      },
      {
        id: 'SEC_LEAK_06',
        name: 'Console Log Secrets',
        pattern: /console\.log.*(?:password|token|secret|key|auth)/gi,
        severity: 'medium' as const,
        bypassable: true
      }
    ];

    for (const file of context.files) {
      try {
        if (!isServer || !fs || !path) {
          // Skip file reading on client side
          continue;
        }
        const content = fs.readFileSync(path.join(context.projectRoot, file), 'utf-8');
        const lines = content.split('\n');

        for (const pattern of secretPatterns) {
          if (this.sessionBypasses.has(pattern.id)) continue;

          const matches = content.matchAll(new RegExp(pattern.pattern.source, pattern.pattern.flags));
          
          for (const match of matches) {
            const lineNumber = content.substring(0, match.index || 0).split('\n').length;
            
            violations.push({
              rule_id: pattern.id,
              severity: pattern.severity,
              file,
              line: lineNumber,
              description: `${pattern.name}: ${match[0]}`,
              suggestion: 'Move sensitive data to environment variables',
              bypassable: pattern.bypassable,
              evidence: match[0].substring(0, 50) + '...'
            });
          }
        }
      } catch (error) {
        // Skip files that can't be read
        continue;
      }
    }

    return {
      domain: 'Secret Leak Prevention',
      passed: violations.length === 0,
      violations,
      summary: `Found ${violations.length} potential secret leaks`
    };
  }

  // Domain 2: Personal Data Flow (Bearer-style)
  private async auditPersonalDataFlow(context: AuditContext): Promise<AuditResult> {
    const violations: SecurityViolation[] = [];

    const piiPatterns = [
      {
        id: 'PII_FLOW_01',
        name: 'Unhashed Password Storage',
        pattern: /password\s*[:=]\s*['"][^'"]*['"](?!\s*\|\s*bcrypt)/gi,
        severity: 'critical' as const,
        bypassable: false
      },
      {
        id: 'PII_FLOW_02',
        name: 'PII in Logs',
        pattern: /console\.log.*(?:email|phone|ssn|credit.*card)/gi,
        severity: 'high' as const,
        bypassable: true
      },
      {
        id: 'PII_FLOW_03',
        name: 'Insecure Cookie',
        pattern: /res\.cookie\([^)]*(?!.*httpOnly.*secure)/gi,
        severity: 'medium' as const,
        bypassable: true
      },
      {
        id: 'PII_FLOW_04',
        name: 'Weak Password Hashing',
        pattern: /\.hash\s*\(\s*password\s*,\s*[1-9](?![0-9])/gi,
        severity: 'high' as const,
        bypassable: true
      }
    ];

    for (const file of context.files) {
      if (!file.match(/\.(ts|js|tsx|jsx)$/)) continue;
      
      try {
        if (!isServer || !fs || !path) {
          // Skip file reading on client side
          continue;
        }
        const content = fs.readFileSync(path.join(context.projectRoot, file), 'utf-8');
        
        for (const pattern of piiPatterns) {
          if (this.sessionBypasses.has(pattern.id)) continue;

          const matches = content.matchAll(new RegExp(pattern.pattern.source, pattern.pattern.flags));
          
          for (const match of matches) {
            const lineNumber = content.substring(0, match.index || 0).split('\n').length;
            
            violations.push({
              rule_id: pattern.id,
              severity: pattern.severity,
              file,
              line: lineNumber,
              description: pattern.name,
              suggestion: this.getPIISuggestion(pattern.id),
              bypassable: pattern.bypassable,
              evidence: match[0]
            });
          }
        }
      } catch (error) {
        continue;
      }
    }

    return {
      domain: 'Personal Data Flow',
      passed: violations.length === 0,
      violations,
      summary: `Found ${violations.length} PII handling issues`
    };
  }

  // Domain 3: Production Readiness (ECC-style)
  private async auditProductionReadiness(context: AuditContext): Promise<AuditResult> {
    const violations: SecurityViolation[] = [];

    // Check for production anti-patterns
    for (const file of context.files) {
      if (!file.match(/\.(ts|js|tsx|jsx)$/)) continue;
      
      try {
        if (!isServer || !fs || !path) {
          // Skip file reading on client side
          continue;
        }
        const content = fs.readFileSync(path.join(context.projectRoot, file), 'utf-8');
        
        // Debug endpoints in production
        if (content.includes('/debug') || content.includes('/test-')) {
          violations.push({
            rule_id: 'PROD_DEBUG_ENDPOINTS',
            severity: 'high',
            file,
            description: 'Debug endpoints found in production code',
            suggestion: 'Remove debug endpoints or gate them behind environment checks',
            bypassable: false
          });
        }

        // Missing security headers
        if (file.includes('layout.tsx') || file.includes('_app.tsx')) {
          if (!content.includes('helmet') && !content.includes('Content-Security-Policy')) {
            violations.push({
              rule_id: 'PROD_SECURITY_HEADERS',
              severity: 'medium',
              file,
              description: 'Missing security headers (CSP, HSTS, etc.)',
              suggestion: 'Add security headers using next-helmet or middleware',
              bypassable: true
            });
          }
        }

        // Environment variable fallbacks
        const envPattern = /process\.env\.([A-Z_]+)(?!\s*\|\|)/g;
        const matches = content.matchAll(envPattern);
        for (const match of matches) {
          violations.push({
            rule_id: 'PROD_ENV_FALLBACK',
            severity: 'medium',
            file,
            line: content.substring(0, match.index || 0).split('\n').length,
            description: `Environment variable ${match[1]} lacks fallback`,
            suggestion: 'Provide fallback values for environment variables',
            bypassable: true
          });
        }

      } catch (error) {
        continue;
      }
    }

    return {
      domain: 'Production Readiness',
      passed: violations.length === 0,
      violations,
      summary: `Found ${violations.length} production readiness issues`
    };
  }

  // Domain 4: Auth Logic Audit (Trail of Bits-style)
  private async auditAuthLogic(context: AuditContext): Promise<AuditResult> {
    const violations: SecurityViolation[] = [];

    for (const file of context.files) {
      if (!file.match(/\.(ts|js|tsx|jsx)$/)) continue;
      
      try {
        if (!isServer || !fs || !path) {
          // Skip file reading on client side
          continue;
        }
        const content = fs.readFileSync(path.join(context.projectRoot, file), 'utf-8');
        
        // IDOR vulnerabilities
        if (content.includes('params.id') && !content.includes('userId')) {
          violations.push({
            rule_id: 'AUTH_IDOR',
            severity: 'high',
            file,
            description: 'Potential IDOR vulnerability - direct object reference without authorization',
            suggestion: 'Verify user ownership before accessing resources',
            bypassable: true
          });
        }

        // SQL injection risks
        if (content.includes('${') && (content.includes('SELECT') || content.includes('INSERT'))) {
          violations.push({
            rule_id: 'AUTH_SQL_INJECTION',
            severity: 'critical',
            file,
            description: 'Potential SQL injection - string interpolation in query',
            suggestion: 'Use parameterized queries or prepared statements',
            bypassable: false
          });
        }

        // JWT token validation
        if (content.includes('jwt.sign') && !content.includes('expiresIn')) {
          violations.push({
            rule_id: 'AUTH_JWT_EXPIRY',
            severity: 'medium',
            file,
            description: 'JWT tokens without expiration',
            suggestion: 'Set appropriate expiration times for JWT tokens',
            bypassable: true
          });
        }

      } catch (error) {
        continue;
      }
    }

    return {
      domain: 'Authentication Logic',
      passed: violations.length === 0,
      violations,
      summary: `Found ${violations.length} authentication issues`
    };
  }

  // Domain 5: Security Review (Red Team-style)
  private async auditSecurityReview(context: AuditContext): Promise<AuditResult> {
    const violations: SecurityViolation[] = [];

    for (const file of context.files) {
      if (!file.match(/\.(ts|js|tsx|jsx)$/)) continue;
      
      try {
        if (!isServer || !fs || !path) {
          // Skip file reading on client side
          continue;
        }
        const content = fs.readFileSync(path.join(context.projectRoot, file), 'utf-8');
        
        // XSS vulnerabilities
        if (content.includes('dangerouslySetInnerHTML') || content.includes('innerHTML =')) {
          violations.push({
            rule_id: 'SEC_XSS_RISK',
            severity: 'high',
            file,
            description: 'Potential XSS vulnerability - unsafe HTML injection',
            suggestion: 'Sanitize user input or use safe rendering methods',
            bypassable: true
          });
        }

        // CORS misconfigurations
        if (content.includes('cors') && content.includes('*')) {
          violations.push({
            rule_id: 'SEC_CORS_WILDCARD',
            severity: 'medium',
            file,
            description: 'Overly permissive CORS configuration',
            suggestion: 'Restrict CORS to specific domains',
            bypassable: true
          });
        }

        // Rate limiting
        if ((content.includes('/api/') || content.includes('router.')) && !content.includes('rateLimit')) {
          violations.push({
            rule_id: 'SEC_RATE_LIMITING',
            severity: 'low',
            file,
            description: 'API endpoint without rate limiting',
            suggestion: 'Implement rate limiting for API endpoints',
            bypassable: true
          });
        }

      } catch (error) {
        continue;
      }
    }

    return {
      domain: 'Security Review',
      passed: violations.length === 0,
      violations,
      summary: `Found ${violations.length} security vulnerabilities`
    };
  }

  private getPIISuggestion(ruleId: string): string {
    const suggestions: Record<string, string> = {
      'PII_FLOW_01': 'Use bcrypt or argon2 to hash passwords before storage',
      'PII_FLOW_02': 'Remove PII from logs or implement structured logging with data masking',
      'PII_FLOW_03': 'Set httpOnly and secure flags on cookies containing sensitive data',
      'PII_FLOW_04': 'Use a higher salt rounds (minimum 12) for bcrypt hashing'
    };
    return suggestions[ruleId] || 'Review PII handling in this code';
  }

  /**
   * Audit a single code snippet (for real-time validation)
   */
  async auditCodeSnippet(code: string, filepath: string): Promise<AuditResult> {
    const violations: SecurityViolation[] = [];
    
    // Run secret leak prevention on the code snippet
    const secretPatterns = [
      {
        id: 'SEC_LEAK_01',
        name: 'Hardcoded API Key',
        pattern: /(?:api[_-]?key|apikey|access[_-]?token)\s*[:=]\s*['"][^'"]{16,}['"][^;]*$/im,
        severity: 'critical' as const,
        bypassable: false
      },
      {
        id: 'SEC_LEAK_02',
        name: 'AWS Access Key',
        pattern: /AKIA[0-9A-Z]{16}/g,
        severity: 'critical' as const,
        bypassable: false
      },
      {
        id: 'SEC_LEAK_03',
        name: 'Database Connection String',
        pattern: /(?:postgres|mysql|mongodb):\/\/[^\/\s]+:[^\/\s]+@[^\/\s]+/gi,
        severity: 'high' as const,
        bypassable: false
      },
      {
        id: 'SEC_LEAK_04',
        name: 'Private Key',
        pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/gi,
        severity: 'critical' as const,
        bypassable: false
      },
      {
        id: 'SEC_LEAK_05',
        name: 'Hardcoded Password',
        pattern: /password\s*[:=]\s*['"][^'"]{4,}['"]/gi,
        severity: 'high' as const,
        bypassable: false
      }
    ];

    const lines = code.split('\n');
    
    secretPatterns.forEach(pattern => {
      lines.forEach((line, index) => {
        const matches = line.match(pattern.pattern);
        if (matches && !this.sessionBypasses.has(pattern.id)) {
          violations.push({
            rule_id: pattern.id,
            severity: pattern.severity,
            file: filepath,
            line: index + 1,
            description: `${pattern.name}: ${matches[0].substring(0, 50)}...`,
            suggestion: 'Move sensitive data to environment variables',
            bypassable: pattern.bypassable,
            evidence: line.trim()
          });
        }
      });
    });

    return {
      domain: 'Code Snippet Audit',
      passed: violations.length === 0,
      violations,
      summary: violations.length > 0 
        ? `Found ${violations.length} security issues in code snippet`
        : 'Code snippet passed security audit'
    };
  }

  // Bypass management
  addSessionBypass(ruleId: string): void {
    this.sessionBypasses.add(ruleId);
  }

  clearSessionBypasses(): void {
    this.sessionBypasses.clear();
  }

  getSessionBypasses(): string[] {
    return Array.from(this.sessionBypasses);
  }
}

// Utility function to scan files
export function scanProjectFiles(projectRoot: string, extensions: string[] = ['.ts', '.tsx', '.js', '.jsx']): string[] {
  const files: string[] = [];
  
  // Only run on server side
  if (!isServer || !fs || !path) {
    return files;
  }
  
  function scanDirectory(dir: string, relativePath: string = ''): void {
    try {
      const entries = fs.readdirSync(dir);
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const relPath = path.join(relativePath, entry);
        
        // Skip common directories to ignore
        if (entry.startsWith('.') || ['node_modules', 'dist', 'build', '.next'].includes(entry)) {
          continue;
        }
        
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
          scanDirectory(fullPath, relPath);
        } else if (stat.isFile() && extensions.some(ext => entry.endsWith(ext))) {
          files.push(relPath);
        }
      }
    } catch (error) {
      // Skip directories that can't be read
    }
  }
  
  scanDirectory(projectRoot);
  return files;
}

// Conditional export - only create instance on server side
export const securityAuditor = isServer && typeof process !== 'undefined' 
  ? new SecurityAuditor(process.cwd())
  : null;