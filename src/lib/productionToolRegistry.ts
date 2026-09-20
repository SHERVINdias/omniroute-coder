/**
 * src/lib/productionToolRegistry.ts — PARKED, AND ITS DENYLIST IS OBSOLETE
 * ---------------------------------------------------------------------------
 * Part of Production Agent Mode, which does not ship in this release. This
 * file is listed in tsconfig.json's `exclude`, so it is NOT type checked and
 * NOT bundled; the only route that reached it returns 410. See the note at the
 * top of src/app/api/production-agent/route.ts.
 *
 * READ THIS BEFORE REVIVING IT
 *
 * `loadAiIgnoreRules` / `isPathAllowed` below are a second, independent file
 * denylist: a `.aiignore` loader matched with minimatch, with its own hardcoded
 * defaults. It has been superseded. The live app now enforces one shared
 * engine, `src/lib/fileExclusions.ts`, backed by per-user rules in
 * `src/lib/fileExclusionStore.ts` and enforced at the bridge's read, write,
 * edit and listing chokepoints.
 *
 * The bug that engine exists to remove was precisely this: three denylists
 * that disagreed, so which files were protected depended on which mode the
 * user was in and which tool the model happened to reach for. Reviving this
 * mode means deleting the two methods below and calling
 * `getMatcherForUser(userId).decide(relativePath)` instead — not repairing
 * them. Anything else puts the fourth denylist back.
 *
 * Note also that `fs_read_file` here reads through `webContainerManager`, which
 * bypasses `vscodeBridge.guardPath` entirely, so it needs the workspace-root
 * check as well as the exclusion check.
 */

import { minimatch } from 'minimatch';
import { webContainerManager, ExecutionResult } from './webContainerManager';
import { securityAuditor } from './securityAuditor';

export interface ToolCall {
  name: string;
  parameters: Record<string, any>;
  timestamp: number;
  id: string;
}

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  securityViolation?: {
    domain: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    message: string;
    canBypass: boolean;
  };
  executionTime: number;
}

export interface SecurityConfig {
  aiIgnorePatterns: string[];
  secretPatterns: RegExp[];
  allowedCommands: string[];
  maxFileSize: number;
}

export class ProductionToolRegistry {
  private config: SecurityConfig;
  private auditLog: Array<{ timestamp: number; action: string; details: any }> = [];

  constructor() {
    this.config = {
      aiIgnorePatterns: [
        '.env*',
        '*.key',
        '*.pem',
        '**/.git/**',
        '**/node_modules/**',
        '**/.secrets/**',
        '**/credentials/**'
      ],
      secretPatterns: [
        /sk[-_]live[-_][a-zA-Z0-9]{24,}/g,
        /-----BEGIN RSA PRIVATE KEY-----/g,
        /-----BEGIN PRIVATE KEY-----/g,
        /AKIA[0-9A-Z]{16}/g,
        /mongodb(\+srv)?:\/\/[^\s]+/g,
        /postgres(ql)?:\/\/[^\s]+/g,
        /mysql:\/\/[^\s]+/g,
        /redis:\/\/[^\s]+/g
      ],
      allowedCommands: [
        'npm', 'node', 'npx', 'yarn', 'pnpm',
        'git', 'ls', 'cat', 'echo', 'pwd',
        'mkdir', 'cp', 'mv', 'rm', 'chmod',
        'grep', 'find', 'sed', 'awk',
        'test', 'jest', 'vitest', 'mocha',
        'build', 'dev', 'start', 'lint', 'format'
      ],
      maxFileSize: 1024 * 1024 // 1MB
    };
  }

  async loadAiIgnoreRules(): Promise<void> {
    try {
      await webContainerManager.initialize();
      const aiIgnoreContent = await webContainerManager.readFile('.aiignore');
      const patterns = aiIgnoreContent
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
      
      this.config.aiIgnorePatterns = [...this.config.aiIgnorePatterns, ...patterns];
      console.log('✅ Loaded .aiignore rules:', patterns.length, 'patterns');
    } catch (error) {
      console.log('ℹ️ No .aiignore file found, using default patterns');
    }
  }

  private isPathAllowed(path: string): boolean {
    for (const pattern of this.config.aiIgnorePatterns) {
      if (minimatch(path, pattern)) {
        console.log(`🚫 Access denied to ${path} (matches pattern: ${pattern})`);
        return false;
      }
    }
    return true;
  }

  private sanitizeSecrets(content: string): string {
    let sanitized = content;
    for (const pattern of this.config.secretPatterns) {
      sanitized = sanitized.replace(pattern, '[REDACTED_SECRET]');
    }
    return sanitized;
  }

  private logAudit(action: string, details: any): void {
    this.auditLog.push({
      timestamp: Date.now(),
      action,
      details
    });
    console.log(`📝 Audit: ${action}`, details);
  }

  async fs_read_file(path: string, startLine?: number, endLine?: number): Promise<ToolResult> {
    const start = Date.now();
    
    try {
      // Security check: path allowed?
      if (!this.isPathAllowed(path)) {
        this.logAudit('fs_read_file_denied', { path, reason: 'aiignore_pattern' });
        return {
          success: false,
          error: `Access denied: ${path} matches .aiignore pattern`,
          securityViolation: {
            domain: 'file_access',
            severity: 'medium',
            message: `Attempt to read restricted file: ${path}`,
            canBypass: false
          },
          executionTime: Date.now() - start
        };
      }

      await webContainerManager.initialize();
      let content = await webContainerManager.readFile(path);

      // Apply line filtering if specified
      if (startLine !== undefined || endLine !== undefined) {
        const lines = content.split('\n');
        const start = Math.max(0, (startLine || 1) - 1);
        const end = endLine ? Math.min(lines.length, endLine) : lines.length;
        content = lines.slice(start, end).join('\n');
      }

      // Security check: sanitize secrets
      const sanitized = this.sanitizeSecrets(content);
      const hasSecrets = sanitized !== content;

      this.logAudit('fs_read_file', { 
        path, 
        lines: startLine && endLine ? `${startLine}-${endLine}` : 'all',
        secretsFound: hasSecrets 
      });

      return {
        success: true,
        data: { path, content: sanitized, hasSecrets },
        executionTime: Date.now() - start
      };
    } catch (error) {
      this.logAudit('fs_read_file_error', { path, error: String(error) });
      return {
        success: false,
        error: `Failed to read file: ${error}`,
        executionTime: Date.now() - start
      };
    }
  }

  async fs_apply_diff(path: string, searchBlock: string, replaceBlock: string): Promise<ToolResult> {
    const start = Date.now();
    
    try {
      // Security check: path allowed?
      if (!this.isPathAllowed(path)) {
        return {
          success: false,
          error: `Access denied: ${path} matches .aiignore pattern`,
          securityViolation: {
            domain: 'file_modification',
            severity: 'high',
            message: `Attempt to modify restricted file: ${path}`,
            canBypass: false
          },
          executionTime: Date.now() - start
        };
      }

      await webContainerManager.initialize();
      const content = await webContainerManager.readFile(path);
      
      // Apply the diff
      if (!content.includes(searchBlock)) {
        return {
          success: false,
          error: `Search block not found in ${path}`,
          executionTime: Date.now() - start
        };
      }

      const newContent = content.replace(searchBlock, replaceBlock);
      
      // Security audit: check the diff for security issues (server-side only)
      let auditResult = { passed: true, canBypass: false, domain: '', severity: 'low' as const, message: '' };
      
      if (securityAuditor) {
        auditResult = await securityAuditor.auditCodeSnippet(replaceBlock, {
          filePath: path,
          operation: 'modify'
        });
      }

      if (!auditResult.passed && !auditResult.canBypass) {
        return {
          success: false,
          error: 'Security audit failed',
          securityViolation: {
            domain: auditResult.domain,
            severity: auditResult.severity,
            message: auditResult.message,
            canBypass: auditResult.canBypass
          },
          executionTime: Date.now() - start
        };
      }

      await webContainerManager.writeFile(path, newContent);
      
      this.logAudit('fs_apply_diff', { 
        path, 
        searchLength: searchBlock.length,
        replaceLength: replaceBlock.length,
        securityPassed: auditResult.passed
      });

      return {
        success: true,
        data: { path, modified: true, securityAudit: auditResult },
        executionTime: Date.now() - start
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to apply diff: ${error}`,
        executionTime: Date.now() - start
      };
    }
  }

  async fs_list_tree(path: string = '.'): Promise<ToolResult> {
    const start = Date.now();
    
    try {
      await webContainerManager.initialize();
      const entries = await webContainerManager.listDirectory(path);
      
      // Filter out aiignored paths
      const filtered = entries.filter(entry => {
        const entryPath = `${path}/${entry.replace(/^[📁📄] /, '')}`;
        return this.isPathAllowed(entryPath);
      });

      this.logAudit('fs_list_tree', { path, totalEntries: entries.length, filteredEntries: filtered.length });

      return {
        success: true,
        data: { path, entries: filtered },
        executionTime: Date.now() - start
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to list directory: ${error}`,
        executionTime: Date.now() - start
      };
    }
  }

  async workspace_search(regex: string, path: string = '.'): Promise<ToolResult> {
    const start = Date.now();
    
    try {
      // Security check: prevent overly broad searches
      if (regex.length < 3) {
        return {
          success: false,
          error: 'Search pattern too short (minimum 3 characters)',
          executionTime: Date.now() - start
        };
      }

      await webContainerManager.initialize();
      
      // Use grep-like search (simplified implementation)
      const result = await webContainerManager.executeCommand('grep', ['-r', regex, path]);
      const sanitizedOutput = this.sanitizeSecrets(
        result.output.map(o => o.data).join('')
      );

      this.logAudit('workspace_search', { regex, path, matches: result.output.length });

      return {
        success: true,
        data: { regex, path, matches: sanitizedOutput, exitCode: result.exitCode },
        executionTime: Date.now() - start
      };
    } catch (error) {
      return {
        success: false,
        error: `Search failed: ${error}`,
        executionTime: Date.now() - start
      };
    }
  }

  async terminal_run(command: string, args: string[] = []): Promise<ToolResult> {
    const start = Date.now();
    
    try {
      // Security check: command allowed?
      if (!this.config.allowedCommands.includes(command)) {
        return {
          success: false,
          error: `Command not allowed: ${command}`,
          securityViolation: {
            domain: 'command_execution',
            severity: 'high',
            message: `Attempt to execute restricted command: ${command}`,
            canBypass: true
          },
          executionTime: Date.now() - start
        };
      }

      await webContainerManager.initialize();
      const result = await webContainerManager.executeCommand(command, args);
      
      // Sanitize output for secrets
      const sanitizedOutput = result.output.map(output => ({
        ...output,
        data: this.sanitizeSecrets(output.data)
      }));

      this.logAudit('terminal_run', { 
        command, 
        args, 
        exitCode: result.exitCode,
        duration: result.duration 
      });

      return {
        success: true,
        data: { 
          command, 
          args, 
          exitCode: result.exitCode, 
          output: sanitizedOutput,
          duration: result.duration 
        },
        executionTime: Date.now() - start
      };
    } catch (error) {
      return {
        success: false,
        error: `Command execution failed: ${error}`,
        executionTime: Date.now() - start
      };
    }
  }

  getAuditLog(): Array<{ timestamp: number; action: string; details: any }> {
    return [...this.auditLog];
  }

  clearAuditLog(): void {
    this.auditLog = [];
  }
}

// Singleton instance
export const productionToolRegistry = new ProductionToolRegistry();