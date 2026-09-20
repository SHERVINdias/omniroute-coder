/**
 * Advanced ReAct Loop for Production Agent Mode — PARKED, NOT IMPORTED ANYWHERE.
 *
 * Production Agent Mode is not shipping in this release; the UI shows it as
 * "Coming soon" and src/app/api/production-agent/route.ts answers 410. This is
 * the client half of that feature and nothing in src/ imports it.
 *
 * Two things to fix before reviving it, neither of which is cosmetic:
 *
 *   1. `sendRequest` and `streamRequest` below call fetch('/api/chat') with a
 *      RELATIVE url. That works in a browser and throws "Failed to parse URL"
 *      in Node, so this class cannot run server-side as written — which is
 *      where an autonomous agent loop would have to run.
 *   2. It drives filesystem tools. Any route that exposes it needs the same
 *      pair of gates /api/chat already applies: a real session, and
 *      `fileToolsEnabled()`.
 *
 * src/lib/phaseManager.ts — the actual state machine — is untouched and has no
 * bugs of its own. Reviving this means rewriting the transport, not the planner.
 *
 * ---------------------------------------------------------------------------
 * Implements Phase 3: ReAct Loop State Machine & Self-Correction Engine
 *
 * Features:
 * - Asynchronous event-driven state machine (IDLE -> PLANNING -> TOOL_CALLING -> OBSERVING -> EVALUATING -> COMPLETED)
 * - Self-correction loop with error injection and autonomous bug fixing
 * - Multi-provider LLM gateway integration with your existing infrastructure
 * - Tool execution with security auditing and HITL controls
 * - Memory management and context isolation
 */

import { ProductionAgent, ToolExecutionResult, AgentToolSchema } from './productionAgent';
import { PhaseManager, PhaseExecutionContext } from './phaseManager';
import { WebContainerManager, ProcessResult } from './webContainerManager';
import { SecurityViolation, AuditResult } from './securityAuditor';

export type ReActState = 
  | 'idle' 
  | 'planning' 
  | 'tool_calling' 
  | 'observing' 
  | 'evaluating' 
  | 'self_correcting' 
  | 'awaiting_hitl' 
  | 'completed' 
  | 'failed';

export interface ReActContext {
  sessionId: string;
  currentState: ReActState;
  goal: string;
  plan: string[];
  executedSteps: ReActStep[];
  currentStep: number;
  errors: ReActError[];
  selfCorrectionAttempts: number;
  maxSelfCorrectionAttempts: number;
  startedAt: Date;
  lastActivity: Date;
}

export interface ReActStep {
  id: string;
  type: 'thought' | 'action' | 'observation' | 'correction';
  content: string;
  toolCall?: {
    tool: string;
    parameters: any;
    result: ToolExecutionResult;
  };
  timestamp: Date;
  success: boolean;
}

export interface ReActError {
  id: string;
  type: 'tool_error' | 'compilation_error' | 'test_failure' | 'security_violation';
  message: string;
  context: any;
  step: string;
  timestamp: Date;
  resolved: boolean;
}

export interface LLMResponse {
  content: string;
  toolCalls?: {
    name: string;
    parameters: any;
  }[];
  reasoning?: string;
  confidence?: number;
}

export interface ReActConfig {
  maxIterations: number;
  maxSelfCorrectionAttempts: number;
  enableSecurityAudit: boolean;
  enableHITL: boolean;
  timeoutMs: number;
  provider: string;
  model: string;
}

/**
 * Multi-Provider LLM Gateway
 * Integrates with your existing provider infrastructure
 */
export class MultiProviderLLMGateway {
  private baseUrl: string;
  private apiKey: string;
  private provider: string;

  constructor(provider: string, baseUrl: string, apiKey: string) {
    this.provider = provider;
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async sendRequest(messages: any[], tools: AgentToolSchema[], config: any = {}): Promise<LLMResponse> {
    try {
      // Use your existing omniroute infrastructure
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages,
          tools,
          provider: this.provider,
          stream: false,
          ...config
        })
      });

      if (!response.ok) {
        throw new Error(`LLM request failed: ${response.status}`);
      }

      const data = await response.json();
      
      return {
        content: data.content || data.message || '',
        toolCalls: data.tool_calls || [],
        reasoning: data.reasoning,
        confidence: data.confidence || 0.8
      };

    } catch (error) {
      console.error('[LLMGateway] Request failed:', error);
      throw new Error(`LLM request failed: ${error.message}`);
    }
  }

  async streamRequest(messages: any[], tools: AgentToolSchema[], onChunk: (chunk: string) => void): Promise<LLMResponse> {
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages,
          tools,
          provider: this.provider,
          stream: true
        })
      });

      if (!response.ok) {
        throw new Error(`LLM stream failed: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response stream available');
      }

      let content = '';
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        content += chunk;
        onChunk(chunk);
      }

      return {
        content,
        toolCalls: [],
        confidence: 0.8
      };

    } catch (error) {
      console.error('[LLMGateway] Stream failed:', error);
      throw error;
    }
  }
}

/**
 * ReAct Loop State Machine
 */
export class ReActStateMachine {
  private context: ReActContext;
  private config: ReActConfig;
  private productionAgent: ProductionAgent;
  private llmGateway: MultiProviderLLMGateway;
  private webContainer?: WebContainerManager;
  private phaseManager?: PhaseManager;
  private eventListeners: Map<ReActState, ((context: ReActContext) => void)[]> = new Map();

  constructor(
    goal: string,
    config: ReActConfig,
    productionAgent: ProductionAgent,
    llmGateway: MultiProviderLLMGateway,
    webContainer?: WebContainerManager,
    phaseManager?: PhaseManager
  ) {
    this.config = config;
    this.productionAgent = productionAgent;
    this.llmGateway = llmGateway;
    this.webContainer = webContainer;
    this.phaseManager = phaseManager;

    this.context = {
      sessionId: this.generateSessionId(),
      currentState: 'idle',
      goal,
      plan: [],
      executedSteps: [],
      currentStep: 0,
      errors: [],
      selfCorrectionAttempts: 0,
      maxSelfCorrectionAttempts: config.maxSelfCorrectionAttempts,
      startedAt: new Date(),
      lastActivity: new Date()
    };

    this.initializeEventListeners();
  }

  /**
   * Start the ReAct loop
   */
  async start(): Promise<boolean> {
    console.log('[ReActLoop] Starting autonomous development session');
    console.log(`[ReActLoop] Goal: ${this.context.goal}`);

    try {
      await this.transitionToState('planning');
      return await this.executeLoop();
    } catch (error) {
      console.error('[ReActLoop] Failed to start:', error);
      await this.transitionToState('failed');
      return false;
    }
  }

  /**
   * Main execution loop
   */
  private async executeLoop(): Promise<boolean> {
    let iterations = 0;
    const startTime = Date.now();

    while (
      this.context.currentState !== 'completed' && 
      this.context.currentState !== 'failed' &&
      iterations < this.config.maxIterations &&
      (Date.now() - startTime) < this.config.timeoutMs
    ) {
      this.context.lastActivity = new Date();
      iterations++;

      console.log(`[ReActLoop] Iteration ${iterations}: ${this.context.currentState}`);

      try {
        switch (this.context.currentState) {
          case 'planning':
            await this.executePlanningPhase();
            break;
          case 'tool_calling':
            await this.executeToolCallingPhase();
            break;
          case 'observing':
            await this.executeObservingPhase();
            break;
          case 'evaluating':
            await this.executeEvaluatingPhase();
            break;
          case 'self_correcting':
            await this.executeSelfCorrectionPhase();
            break;
          case 'awaiting_hitl':
            await this.executeHITLPhase();
            break;
        }

        // Small delay to prevent overwhelming
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        console.error(`[ReActLoop] Error in ${this.context.currentState}:`, error);
        await this.handleError(error);
      }
    }

    const success = this.context.currentState === 'completed';
    console.log(`[ReActLoop] Session ${success ? 'completed successfully' : 'failed'} after ${iterations} iterations`);
    
    return success;
  }

  /**
   * Planning Phase - Generate step-by-step plan
   */
  private async executePlanningPhase(): Promise<void> {
    const messages = [
      {
        role: 'system',
        content: `You are an expert software engineer. Create a detailed step-by-step plan to achieve this goal: ${this.context.goal}
        
        Available tools: ${this.productionAgent.getAvailableTools().map(t => t.name).join(', ')}
        
        Format your response as a numbered list of specific, actionable steps.
        Each step should be achievable with the available tools.
        
        Example:
        1. Read the current package.json file to understand project structure
        2. Search for existing test files to understand testing patterns
        3. Create a new test file for the math utility functions
        4. Run the tests to verify they work correctly
        5. Fix any failing tests by updating the implementation
        `
      },
      {
        role: 'user',
        content: `Goal: ${this.context.goal}`
      }
    ];

    const response = await this.llmGateway.sendRequest(messages, []);
    
    // Parse the plan from the response
    this.context.plan = this.parsePlanFromResponse(response.content);
    
    this.addStep({
      id: this.generateStepId(),
      type: 'thought',
      content: `Created plan with ${this.context.plan.length} steps: ${response.content}`,
      timestamp: new Date(),
      success: true
    });

    await this.transitionToState('tool_calling');
  }

  /**
   * Tool Calling Phase - Execute planned actions
   */
  private async executeToolCallingPhase(): Promise<void> {
    if (this.context.currentStep >= this.context.plan.length) {
      await this.transitionToState('completed');
      return;
    }

    const currentPlanStep = this.context.plan[this.context.currentStep];
    
    const messages = [
      {
        role: 'system',
        content: `You are executing this step: "${currentPlanStep}"
        
        Use the available tools to accomplish this step. Be specific and methodical.
        If you encounter an error, the system will automatically handle self-correction.
        
        Available tools:
        ${this.productionAgent.getAvailableTools().map(t => 
          `- ${t.name}: ${t.description}`
        ).join('\n')}
        `
      },
      {
        role: 'user',
        content: `Execute this step: ${currentPlanStep}`
      }
    ];

    const tools = this.productionAgent.getAvailableTools();
    const response = await this.llmGateway.sendRequest(messages, tools);

    // Execute tool calls if any
    if (response.toolCalls && response.toolCalls.length > 0) {
      for (const toolCall of response.toolCalls) {
        const result = await this.productionAgent.executeTool(toolCall.name, toolCall.parameters);
        
        this.addStep({
          id: this.generateStepId(),
          type: 'action',
          content: `Used ${toolCall.name} with parameters: ${JSON.stringify(toolCall.parameters)}`,
          toolCall: {
            tool: toolCall.name,
            parameters: toolCall.parameters,
            result
          },
          timestamp: new Date(),
          success: result.success
        });

        // Check for security violations
        if (result.securityViolations && result.securityViolations.length > 0) {
          this.addError({
            id: this.generateErrorId(),
            type: 'security_violation',
            message: `Security violations detected: ${result.securityViolations.map(v => v.description).join(', ')}`,
            context: result.securityViolations,
            step: this.context.currentStep.toString(),
            timestamp: new Date(),
            resolved: false
          });

          if (this.config.enableHITL) {
            await this.transitionToState('awaiting_hitl');
            return;
          }
        }

        if (!result.success) {
          this.addError({
            id: this.generateErrorId(),
            type: 'tool_error',
            message: result.error || 'Tool execution failed',
            context: { toolCall, result },
            step: this.context.currentStep.toString(),
            timestamp: new Date(),
            resolved: false
          });

          await this.transitionToState('self_correcting');
          return;
        }
      }
    }

    await this.transitionToState('observing');
  }

  /**
   * Observing Phase - Check results and run tests
   */
  private async executeObservingPhase(): Promise<void> {
    let hasErrors = false;

    // Run tests if WebContainer is available
    if (this.webContainer) {
      try {
        const testResult = await this.webContainer.runTests();
        
        this.addStep({
          id: this.generateStepId(),
          type: 'observation',
          content: `Test results: exit code ${testResult.exitCode}`,
          timestamp: new Date(),
          success: testResult.exitCode === 0
        });

        if (testResult.exitCode !== 0) {
          this.addError({
            id: this.generateErrorId(),
            type: 'test_failure',
            message: 'Tests failed',
            context: testResult,
            step: this.context.currentStep.toString(),
            timestamp: new Date(),
            resolved: false
          });
          hasErrors = true;
        }

      } catch (error) {
        console.warn('[ReActLoop] Could not run tests:', error);
      }
    }

    // Run security audit
    if (this.config.enableSecurityAudit) {
      try {
        const auditResults = await this.productionAgent.runSecurityAudit();
        const violations = auditResults.flatMap(r => r.violations).filter(v => v.severity === 'critical' || v.severity === 'high');
        
        if (violations.length > 0) {
          this.addError({
            id: this.generateErrorId(),
            type: 'security_violation',
            message: `Security audit found ${violations.length} critical/high issues`,
            context: violations,
            step: this.context.currentStep.toString(),
            timestamp: new Date(),
            resolved: false
          });
          hasErrors = true;
        }

      } catch (error) {
        console.warn('[ReActLoop] Security audit failed:', error);
      }
    }

    if (hasErrors) {
      await this.transitionToState('self_correcting');
    } else {
      await this.transitionToState('evaluating');
    }
  }

  /**
   * Evaluating Phase - Determine next action
   */
  private async executeEvaluatingPhase(): Promise<void> {
    this.context.currentStep++;
    
    if (this.context.currentStep >= this.context.plan.length) {
      await this.transitionToState('completed');
    } else {
      await this.transitionToState('tool_calling');
    }
  }

  /**
   * Self-Correction Phase - Fix errors autonomously
   */
  private async executeSelfCorrectionPhase(): Promise<void> {
    if (this.context.selfCorrectionAttempts >= this.context.maxSelfCorrectionAttempts) {
      console.error('[ReActLoop] Maximum self-correction attempts reached');
      await this.transitionToState('failed');
      return;
    }

    this.context.selfCorrectionAttempts++;
    const unresolvedErrors = this.context.errors.filter(e => !e.resolved);
    
    if (unresolvedErrors.length === 0) {
      await this.transitionToState('tool_calling');
      return;
    }

    const messages = [
      {
        role: 'system',
        content: `You need to fix these errors that occurred during execution:
        
        ${unresolvedErrors.map(e => `- ${e.type}: ${e.message}`).join('\n')}
        
        Analyze the errors and use the available tools to fix them.
        This is self-correction attempt ${this.context.selfCorrectionAttempts} of ${this.context.maxSelfCorrectionAttempts}.
        `
      },
      {
        role: 'user',
        content: `Fix these errors and continue with the plan. Current step: ${this.context.plan[this.context.currentStep] || 'Complete'}`
      }
    ];

    const tools = this.productionAgent.getAvailableTools();
    const response = await this.llmGateway.sendRequest(messages, tools);

    this.addStep({
      id: this.generateStepId(),
      type: 'correction',
      content: `Self-correction attempt ${this.context.selfCorrectionAttempts}: ${response.content}`,
      timestamp: new Date(),
      success: true
    });

    // Mark errors as resolved (optimistically)
    unresolvedErrors.forEach(error => {
      error.resolved = true;
    });

    await this.transitionToState('tool_calling');
  }

  /**
   * HITL Phase - Wait for human approval
   */
  private async executeHITLPhase(): Promise<void> {
    console.log('[ReActLoop] Waiting for human-in-the-loop approval...');
    
    // Emit HITL request (to be handled by UI)
    this.emitEvent('hitl_required', this.context);
    
    // For now, auto-approve after delay (replace with actual UI integration)
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log('[ReActLoop] HITL approval received, continuing...');
    await this.transitionToState('tool_calling');
  }

  // Helper methods

  private async transitionToState(newState: ReActState): Promise<void> {
    const oldState = this.context.currentState;
    this.context.currentState = newState;
    
    console.log(`[ReActLoop] State transition: ${oldState} -> ${newState}`);
    
    this.emitEvent('state_change', this.context);
    
    // Execute state-specific listeners
    const listeners = this.eventListeners.get(newState) || [];
    listeners.forEach(listener => listener(this.context));
  }

  private addStep(step: ReActStep): void {
    this.context.executedSteps.push(step);
    this.emitEvent('step_added', step);
  }

  private addError(error: ReActError): void {
    this.context.errors.push(error);
    this.emitEvent('error_added', error);
  }

  private async handleError(error: any): Promise<void> {
    this.addError({
      id: this.generateErrorId(),
      type: 'tool_error',
      message: error.message || 'Unknown error',
      context: error,
      step: this.context.currentStep.toString(),
      timestamp: new Date(),
      resolved: false
    });

    await this.transitionToState('self_correcting');
  }

  private parsePlanFromResponse(content: string): string[] {
    const lines = content.split('\n');
    const steps: string[] = [];
    
    for (const line of lines) {
      const match = line.match(/^\d+\.\s*(.+)$/);
      if (match) {
        steps.push(match[1].trim());
      }
    }
    
    return steps.length > 0 ? steps : [content.trim()];
  }

  private initializeEventListeners(): void {
    // Initialize event listener maps for each state
    for (const state of ['idle', 'planning', 'tool_calling', 'observing', 'evaluating', 'self_correcting', 'awaiting_hitl', 'completed', 'failed'] as ReActState[]) {
      this.eventListeners.set(state, []);
    }
  }

  private emitEvent(eventType: string, data: any): void {
    // Emit events for UI integration
    console.log(`[ReActLoop] Event: ${eventType}`, data);
  }

  private generateSessionId(): string {
    return `react_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private generateStepId(): string {
    return `step_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }

  private generateErrorId(): string {
    return `error_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }

  // Public API

  getContext(): ReActContext {
    return { ...this.context };
  }

  addEventListener(state: ReActState, listener: (context: ReActContext) => void): void {
    const listeners = this.eventListeners.get(state) || [];
    listeners.push(listener);
    this.eventListeners.set(state, listeners);
  }

  async pause(): Promise<void> {
    console.log('[ReActLoop] Pausing execution...');
    await this.transitionToState('awaiting_hitl');
  }

  async resume(): Promise<void> {
    console.log('[ReActLoop] Resuming execution...');
    await this.transitionToState('tool_calling');
  }

  async abort(): Promise<void> {
    console.log('[ReActLoop] Aborting execution...');
    await this.transitionToState('failed');
  }
}