import { productionToolRegistry, ToolCall, ToolResult } from './productionToolRegistry';
import { webContainerManager } from './webContainerManager';
import { securityAuditor } from './securityAuditor';

export type AgentState = 
  | 'IDLE' 
  | 'PLANNING' 
  | 'TOOL_CALLING' 
  | 'OBSERVING' 
  | 'EVALUATING' 
  | 'AWAITING_HITL' 
  | 'COMPLETED' 
  | 'ERROR';

export interface AgentContext {
  goal: string;
  currentPhase: number;
  totalPhases: number;
  state: AgentState;
  toolCalls: ToolCall[];
  observations: string[];
  errors: string[];
  securityViolations: Array<{
    toolCall: string;
    violation: any;
    resolved: boolean;
  }>;
  iterationCount: number;
  maxIterations: number;
  startTime: number;
  phaseStartTime: number;
}

export interface StateTransition {
  from: AgentState;
  to: AgentState;
  reason: string;
  timestamp: number;
  context?: any;
}

export class AdvancedReActStateMachine {
  private context: AgentContext;
  private transitions: StateTransition[] = [];
  private listeners: Map<AgentState, Array<(context: AgentContext) => void>> = new Map();
  private isRunning = false;
  private abortController?: AbortController;

  constructor() {
    this.context = this.createInitialContext();
    this.setupDefaultListeners();
  }

  private createInitialContext(): AgentContext {
    return {
      goal: '',
      currentPhase: 1,
      totalPhases: 1,
      state: 'IDLE',
      toolCalls: [],
      observations: [],
      errors: [],
      securityViolations: [],
      iterationCount: 0,
      maxIterations: 10,
      startTime: Date.now(),
      phaseStartTime: Date.now()
    };
  }

  private setupDefaultListeners(): void {
    this.onStateChange('ERROR', (context) => {
      console.error('🚨 Agent entered ERROR state:', context.errors);
      this.isRunning = false;
    });

    this.onStateChange('COMPLETED', (context) => {
      console.log('✅ Agent completed successfully');
      this.isRunning = false;
    });

    this.onStateChange('AWAITING_HITL', (context) => {
      console.log('⏸️ Agent paused for human intervention');
      this.isRunning = false;
    });
  }

  onStateChange(state: AgentState, callback: (context: AgentContext) => void): void {
    if (!this.listeners.has(state)) {
      this.listeners.set(state, []);
    }
    this.listeners.get(state)!.push(callback);
  }

  private transition(to: AgentState, reason: string, context?: any): void {
    const transition: StateTransition = {
      from: this.context.state,
      to,
      reason,
      timestamp: Date.now(),
      context
    };

    this.transitions.push(transition);
    this.context.state = to;

    console.log(`🔄 State transition: ${transition.from} → ${transition.to} (${reason})`);

    // Notify listeners
    const callbacks = this.listeners.get(to);
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(this.context);
        } catch (error) {
          console.error('State listener error:', error);
        }
      });
    }
  }

  async startGoal(goal: string, phases: number = 1, maxIterations: number = 10): Promise<void> {
    if (this.isRunning) {
      throw new Error('Agent is already running');
    }

    this.context = {
      ...this.createInitialContext(),
      goal,
      totalPhases: phases,
      maxIterations
    };

    this.isRunning = true;
    this.abortController = new AbortController();

    console.log(`🎯 Starting goal: "${goal}" (${phases} phases, max ${maxIterations} iterations)`);

    // Initialize WebContainer
    try {
      await webContainerManager.initialize();
      await productionToolRegistry.loadAiIgnoreRules();
    } catch (error) {
      this.context.errors.push(`Initialization failed: ${error}`);
      this.transition('ERROR', 'initialization_failed', { error });
      return;
    }

    this.transition('PLANNING', 'goal_started');
    await this.executeLoop();
  }

  private async executeLoop(): Promise<void> {
    while (this.isRunning && !this.abortController?.signal.aborted) {
      try {
        // Check iteration limit
        if (this.context.iterationCount >= this.context.maxIterations) {
          this.context.errors.push('Maximum iterations exceeded');
          this.transition('ERROR', 'max_iterations_exceeded');
          break;
        }

        this.context.iterationCount++;

        switch (this.context.state) {
          case 'PLANNING':
            await this.executePlanning();
            break;
          case 'TOOL_CALLING':
            await this.executeToolCalling();
            break;
          case 'OBSERVING':
            await this.executeObserving();
            break;
          case 'EVALUATING':
            await this.executeEvaluating();
            break;
          default:
            // Terminal states (IDLE, COMPLETED, ERROR, AWAITING_HITL)
            return;
        }

        // Small delay to prevent tight loops
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error('Loop execution error:', error);
        this.context.errors.push(String(error));
        this.transition('ERROR', 'loop_execution_error', { error });
        break;
      }
    }
  }

  private async executePlanning(): Promise<void> {
    console.log('🧠 Planning phase...');
    
    // In a real implementation, this would call the LLM to generate a plan
    // For now, we'll create a simple plan based on the goal
    const plan = this.generateBasicPlan(this.context.goal);
    
    this.context.observations.push(`Generated plan: ${plan}`);
    
    // Transition to tool calling to execute the plan
    this.transition('TOOL_CALLING', 'plan_generated');
  }

  private generateBasicPlan(goal: string): string {
    // Simple heuristic-based planning
    if (goal.toLowerCase().includes('test')) {
      return 'Run tests to identify issues, then fix any failures';
    } else if (goal.toLowerCase().includes('build')) {
      return 'Check dependencies, run build process, fix any errors';
    } else if (goal.toLowerCase().includes('fix')) {
      return 'Read relevant files, identify the issue, apply fix, verify solution';
    } else {
      return 'Analyze the codebase, identify relevant files, make necessary changes';
    }
  }

  private async executeToolCalling(): Promise<void> {
    console.log('🛠️ Tool calling phase...');
    
    // In a real implementation, this would be driven by LLM tool calls
    // For now, we'll execute some basic tools based on the goal
    const toolCalls = this.generateToolCalls(this.context.goal);
    
    for (const toolCall of toolCalls) {
      const result = await this.executeToolCall(toolCall);
      
      if (!result.success) {
        if (result.securityViolation) {
          this.context.securityViolations.push({
            toolCall: toolCall.name,
            violation: result.securityViolation,
            resolved: false
          });
          
          // Check if this requires human intervention
          if (!result.securityViolation.canBypass) {
            this.transition('AWAITING_HITL', 'security_violation_requires_approval', {
              toolCall,
              violation: result.securityViolation
            });
            return;
          }
        }
        
        this.context.errors.push(`Tool call failed: ${toolCall.name} - ${result.error}`);
      }
      
      this.context.observations.push(
        `Tool: ${toolCall.name} - ${result.success ? 'Success' : 'Failed'}: ${JSON.stringify(result.data || result.error)}`
      );
    }
    
    this.transition('OBSERVING', 'tool_calls_completed');
  }

  private generateToolCalls(goal: string): ToolCall[] {
    const calls: ToolCall[] = [];
    
    // Basic tool call generation based on goal
    if (goal.toLowerCase().includes('test')) {
      calls.push({
        name: 'terminal_run',
        parameters: { command: 'npm', args: ['test'] },
        timestamp: Date.now(),
        id: this.generateId()
      });
    }
    
    if (goal.toLowerCase().includes('list') || goal.toLowerCase().includes('explore')) {
      calls.push({
        name: 'fs_list_tree',
        parameters: { path: '.' },
        timestamp: Date.now(),
        id: this.generateId()
      });
    }
    
    return calls;
  }

  private async executeToolCall(toolCall: ToolCall): Promise<ToolResult> {
    console.log(`🔧 Executing tool: ${toolCall.name}`, toolCall.parameters);
    
    this.context.toolCalls.push(toolCall);
    
    switch (toolCall.name) {
      case 'fs_read_file':
        return productionToolRegistry.fs_read_file(
          toolCall.parameters.path,
          toolCall.parameters.startLine,
          toolCall.parameters.endLine
        );
      case 'fs_apply_diff':
        return productionToolRegistry.fs_apply_diff(
          toolCall.parameters.path,
          toolCall.parameters.searchBlock,
          toolCall.parameters.replaceBlock
        );
      case 'fs_list_tree':
        return productionToolRegistry.fs_list_tree(toolCall.parameters.path);
      case 'workspace_search':
        return productionToolRegistry.workspace_search(
          toolCall.parameters.regex,
          toolCall.parameters.path
        );
      case 'terminal_run':
        return productionToolRegistry.terminal_run(
          toolCall.parameters.command,
          toolCall.parameters.args
        );
      default:
        return {
          success: false,
          error: `Unknown tool: ${toolCall.name}`,
          executionTime: 0
        };
    }
  }

  private async executeObserving(): Promise<void> {
    console.log('👁️ Observing phase...');
    
    // Analyze the observations to determine next action
    const hasErrors = this.context.errors.length > 0;
    const hasSecurityViolations = this.context.securityViolations.some(v => !v.resolved);
    
    if (hasErrors || hasSecurityViolations) {
      // Try to self-correct
      this.transition('PLANNING', 'self_correction_needed');
    } else {
      // Move to evaluation
      this.transition('EVALUATING', 'observations_complete');
    }
  }

  private async executeEvaluating(): Promise<void> {
    console.log('📊 Evaluating phase...');
    
    // In a real implementation, this would use LLM to evaluate success
    // For now, simple heuristic evaluation
    const goalAchieved = this.evaluateGoalAchievement();
    
    if (goalAchieved) {
      this.transition('COMPLETED', 'goal_achieved');
    } else if (this.context.iterationCount < this.context.maxIterations) {
      this.transition('PLANNING', 'goal_not_achieved_retry');
    } else {
      this.context.errors.push('Goal not achieved within iteration limit');
      this.transition('ERROR', 'goal_not_achieved_max_iterations');
    }
  }

  private evaluateGoalAchievement(): boolean {
    // Simple heuristic: goal achieved if no errors in recent observations
    const recentObservations = this.context.observations.slice(-3);
    return recentObservations.every(obs => !obs.toLowerCase().includes('error'));
  }

  private generateId(): string {
    return Math.random().toString(36).substring(2, 15);
  }

  // Public API methods
  getContext(): AgentContext {
    return { ...this.context };
  }

  getTransitions(): StateTransition[] {
    return [...this.transitions];
  }

  isActive(): boolean {
    return this.isRunning;
  }

  async abort(): Promise<void> {
    console.log('🛑 Aborting agent execution...');
    this.abortController?.abort();
    this.isRunning = false;
    this.transition('IDLE', 'manually_aborted');
  }

  async approveSecurityBypass(violationIndex: number): Promise<void> {
    if (violationIndex < this.context.securityViolations.length) {
      this.context.securityViolations[violationIndex].resolved = true;
      console.log('✅ Security violation approved for bypass');
      
      if (this.context.state === 'AWAITING_HITL') {
        this.transition('TOOL_CALLING', 'security_violation_bypassed');
        if (!this.isRunning) {
          this.isRunning = true;
          await this.executeLoop();
        }
      }
    }
  }

  async rejectSecurityBypass(violationIndex: number): Promise<void> {
    if (violationIndex < this.context.securityViolations.length) {
      const violation = this.context.securityViolations[violationIndex];
      this.context.errors.push(`Security violation rejected: ${violation.violation.message}`);
      this.transition('ERROR', 'security_violation_rejected');
    }
  }
}

// Singleton instance
export const advancedReActAgent = new AdvancedReActStateMachine();