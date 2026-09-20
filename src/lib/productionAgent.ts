/**
 * Production Agent Mode
 * ---------------------------------------------------------------------------
 * A production-level agentic service that builds on omniroute-coder's existing
 * infrastructure while adding enterprise-grade security, phase management,
 * and autonomous development capabilities.
 * 
 * This implements the 6-phase architecture:
 * Phase 1: WebContainer Sandbox (browser-based execution)
 * Phase 2: Enhanced Tool Registry + Security Middleware  
 * Phase 3: Advanced ReAct Loop + Self-Correction
 * Phase 4: Enterprise Rules + Security Auditor Agent
 * Phase 5: Human-in-the-Loop + Security Bypass Engine
 * Phase 6: Phase-Wise Plan Execution + Memory Scaling
 */

import { SecurityAuditor, AuditResult, SecurityViolation } from './securityAuditor';
import { vscodeBridge, WriteFileResult, ReadFileResult } from './vscodeBridge';
import { deepCoworkPipeline } from './deepCoworkPipeline';

export type ProductionAgentMode = 'planning' | 'development' | 'testing' | 'security-review' | 'deployment';

export interface ProductionAgentConfig {
  mode: ProductionAgentMode;
  enableWebContainers: boolean;
  enablePhaseManagement: boolean;
  enableSecurityAuditor: boolean;
  enableHITL: boolean;
  maxIterations: number;
  projectRoot: string;
}

export interface AgentToolSchema {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, any>;
    required: string[];
  };
}

export interface ToolExecutionResult {
  success: boolean;
  result?: any;
  error?: string;
  securityViolations?: SecurityViolation[];
}

/**
 * Core Tool Registry for Production Agent
 * Implements secure file operations with .aiignore filtering and secret masking
 */
export class ProductionToolRegistry {
  private securityAuditor: SecurityAuditor;
  private aiignorePatterns: string[] = [];
  private secretPatterns = [
    /sk_live_[a-zA-Z0-9_]+/g,  // Stripe keys
    /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,  // RSA keys
    /[a-zA-Z0-9+/]{40,}={0,2}/g,  // Base64 tokens
    /postgres:\/\/[^:]+:[^@]+@[^/]+\/[^\s]+/g,  // DB connection strings
    /mongodb:\/\/[^:]+:[^@]+@[^/]+\/[^\s]+/g,  // MongoDB URIs
    /redis:\/\/[^:]+:[^@]+@[^/]+\/[^\s]+/g,  // Redis URIs
  ];

  constructor(projectRoot: string) {
    this.securityAuditor = new SecurityAuditor(projectRoot);
    this.loadAiignorePatterns();
  }

  private loadAiignorePatterns() {
    // Load .aiignore patterns for file access control
    try {
      const aiignorePath = '.aiignore';
      const content = vscodeBridge.readFileSync(aiignorePath);
      this.aiignorePatterns = content.split('\n')
        .filter(line => line.trim() && !line.startsWith('#'))
        .map(pattern => pattern.trim());
    } catch (error) {
      // .aiignore not found, use default patterns
      this.aiignorePatterns = [
        '.env*',
        '*.key',
        '*.pem',
        'node_modules/**',
        '.git/**',
        'secrets/**'
      ];
    }
  }

  private isPathAllowed(path: string): boolean {
    // Check against .aiignore patterns using minimatch-style matching
    const minimatch = require('minimatch');
    return !this.aiignorePatterns.some(pattern => minimatch(path, pattern));
  }

  private maskSecrets(content: string): string {
    // Redact potential secrets before sending to LLM
    let masked = content;
    this.secretPatterns.forEach(pattern => {
      masked = masked.replace(pattern, '[REDACTED_SECRET]');
    });
    return masked;
  }

  /**
   * Enhanced file reading with security controls
   */
  async fs_read_file(path: string, start_line?: number, end_line?: number): Promise<ToolExecutionResult> {
    try {
      // Security check: .aiignore filtering
      if (!this.isPathAllowed(path)) {
        return {
          success: false,
          error: `Access denied: ${path} is excluded by .aiignore rules`
        };
      }

      const result: ReadFileResult = await vscodeBridge.readFile(path, start_line, end_line);
      
      if (!result.success) {
        return { success: false, error: result.error };
      }

      // Security check: secret masking
      const maskedContent = this.maskSecrets(result.content || '');

      return {
        success: true,
        result: {
          path: result.path,
          content: maskedContent,
          lines: result.lines,
          hash: result.hash
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to read file: ${error.message}`
      };
    }
  }

  /**
   * Secure diff application with pre-audit
   */
  async fs_apply_diff(path: string, search_block: string, replace_block: string): Promise<ToolExecutionResult> {
    try {
      // Security check: .aiignore filtering
      if (!this.isPathAllowed(path)) {
        return {
          success: false,
          error: `Access denied: ${path} is excluded by .aiignore rules`
        };
      }

      // Security check: audit the replacement content
      const auditResult = await this.securityAuditor.auditCodeSnippet(replace_block, path);
      const criticalViolations = auditResult.violations.filter(v => v.severity === 'critical');
      
      if (criticalViolations.length > 0) {
        return {
          success: false,
          error: `Security audit failed: ${criticalViolations.map(v => v.description).join(', ')}`,
          securityViolations: criticalViolations
        };
      }

      // Execute the diff application
      const result: WriteFileResult = await vscodeBridge.replaceText(path, search_block, replace_block);

      return {
        success: result.success,
        result: result.success ? {
          path: result.path,
          hash: result.hash,
          changes: result.changes || 1
        } : undefined,
        error: result.success ? undefined : result.error,
        securityViolations: auditResult.violations
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to apply diff: ${error.message}`
      };
    }
  }

  /**
   * File tree listing with security filtering
   */
  async fs_list_tree(path: string = '.'): Promise<ToolExecutionResult> {
    try {
      const files = await vscodeBridge.listFiles(path);
      
      // Filter out .aiignore excluded paths
      const allowedFiles = files.filter(file => this.isPathAllowed(file.path));

      return {
        success: true,
        result: {
          root: path,
          files: allowedFiles
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to list directory: ${error.message}`
      };
    }
  }

  /**
   * Workspace search with content masking
   */
  async workspace_search(regex: string): Promise<ToolExecutionResult> {
    try {
      const results = await vscodeBridge.searchWorkspace(regex);
      
      // Filter and mask search results
      const secureResults = results
        .filter(result => this.isPathAllowed(result.file))
        .map(result => ({
          ...result,
          content: this.maskSecrets(result.content)
        }));

      return {
        success: true,
        result: {
          query: regex,
          matches: secureResults
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Search failed: ${error.message}`
      };
    }
  }

  /**
   * Terminal command execution (Phase 1 - will integrate with WebContainers)
   */
  async terminal_run(command: string): Promise<ToolExecutionResult> {
    try {
      // Security check: command validation
      const dangerousCommands = ['rm -rf', 'sudo', 'curl', 'wget', 'ssh'];
      const isDangerous = dangerousCommands.some(cmd => command.includes(cmd));
      
      if (isDangerous) {
        return {
          success: false,
          error: `Dangerous command blocked: ${command}`
        };
      }

      // For now, use existing terminal execution
      // TODO: Phase 1 - Replace with WebContainer execution
      const result = await vscodeBridge.executeCommand(command);

      return {
        success: result.success,
        result: {
          command,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode
        },
        error: result.success ? undefined : result.stderr || 'Command execution failed'
      };
    } catch (error) {
      return {
        success: false,
        error: `Terminal execution failed: ${error.message}`
      };
    }
  }

  /**
   * Get all available tool schemas
   */
  getToolSchemas(): AgentToolSchema[] {
    return [
      {
        name: 'fs_read_file',
        description: 'Read file contents with security filtering and secret masking',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to read' },
            start_line: { type: 'number', description: 'Start line (1-based, optional)' },
            end_line: { type: 'number', description: 'End line (1-based, optional)' }
          },
          required: ['path']
        }
      },
      {
        name: 'fs_apply_diff',
        description: 'Apply code changes with pre-security audit',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to modify' },
            search_block: { type: 'string', description: 'Exact text to find and replace' },
            replace_block: { type: 'string', description: 'Replacement text' }
          },
          required: ['path', 'search_block', 'replace_block']
        }
      },
      {
        name: 'fs_list_tree',
        description: 'List directory contents with .aiignore filtering',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path (defaults to project root)' }
          },
          required: []
        }
      },
      {
        name: 'workspace_search',
        description: 'Search workspace content with security masking',
        parameters: {
          type: 'object',
          properties: {
            regex: { type: 'string', description: 'Search pattern (regex)' }
          },
          required: ['regex']
        }
      },
      {
        name: 'terminal_run',
        description: 'Execute terminal commands with security validation',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Command to execute' }
          },
          required: ['command']
        }
      }
    ];
  }
}

/**
 * Production Agent Core Engine
 */
export class ProductionAgent {
  private config: ProductionAgentConfig;
  private toolRegistry: ProductionToolRegistry;
  private securityAuditor: SecurityAuditor;

  constructor(config: ProductionAgentConfig) {
    this.config = config;
    this.toolRegistry = new ProductionToolRegistry(config.projectRoot);
    this.securityAuditor = new SecurityAuditor(config.projectRoot);
  }

  /**
   * Execute a tool call with full security pipeline
   */
  async executeTool(toolName: string, parameters: any): Promise<ToolExecutionResult> {
    switch (toolName) {
      case 'fs_read_file':
        return await this.toolRegistry.fs_read_file(
          parameters.path, 
          parameters.start_line, 
          parameters.end_line
        );
      case 'fs_apply_diff':
        return await this.toolRegistry.fs_apply_diff(
          parameters.path,
          parameters.search_block,
          parameters.replace_block
        );
      case 'fs_list_tree':
        return await this.toolRegistry.fs_list_tree(parameters.path);
      case 'workspace_search':
        return await this.toolRegistry.workspace_search(parameters.regex);
      case 'terminal_run':
        return await this.toolRegistry.terminal_run(parameters.command);
      default:
        return {
          success: false,
          error: `Unknown tool: ${toolName}`
        };
    }
  }

  /**
   * Get tool schemas for LLM function calling
   */
  getAvailableTools(): AgentToolSchema[] {
    return this.toolRegistry.getToolSchemas();
  }

  /**
   * Run production audit on current codebase
   */
  async runSecurityAudit(): Promise<AuditResult[]> {
    const files = await vscodeBridge.listFiles('.');
    const context = {
      files: files.map(f => f.path),
      projectRoot: this.config.projectRoot,
      sessionBypasses: []
    };
    
    return await this.securityAuditor.auditCodebase(context);
  }
}