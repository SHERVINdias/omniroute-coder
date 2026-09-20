/**
 * Phase-Based Execution Engine
 * Manages DAG-based phase sequencing, state transitions, and context isolation
 */

export interface PhaseTask {
  id: string;
  text: string;
  completed: boolean;
  dependencies?: string[];
}

export interface Phase {
  phase_id: string;
  name: string;
  description?: string;
  target_files: string[];
  tasks: PhaseTask[];
  dependencies: string[];
  verification_command?: string;
  estimated_duration?: string;
  status: 'pending' | 'active' | 'completed' | 'failed' | 'paused';
  started_at?: string;
  completed_at?: string;
  error?: string;
}

export interface PhasePlan {
  project_title: string;
  description?: string;
  phases: Phase[];
  current_phase_id?: string;
  created_at: string;
  updated_at: string;
}

export enum PhaseEngineState {
  IDLE = 'IDLE',
  PHASE_INITIALIZATION = 'PHASE_INITIALIZATION',
  PLANNING = 'PLANNING',
  TOOL_CALLING = 'TOOL_CALLING',
  OBSERVING = 'OBSERVING',
  PHASE_VERIFICATION = 'PHASE_VERIFICATION',
  AUDITING = 'AUDITING',
  AWAITING_PHASE_GATE = 'AWAITING_PHASE_GATE',
  AWAITING_HITL = 'AWAITING_HITL',
  ALL_PHASES_COMPLETED = 'ALL_PHASES_COMPLETED'
}

export interface PhaseEngineContext {
  plan: PhasePlan;
  currentState: PhaseEngineState;
  currentPhase?: Phase;
  sessionBypasses: string[];
  auditResults?: AuditResult[];
  vectorContext?: VectorContext;
}

export interface AuditResult {
  domain: string;
  passed: boolean;
  violations: SecurityViolation[];
}

export interface SecurityViolation {
  rule_id: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  file: string;
  line?: number;
  description: string;
  suggestion?: string;
  bypassable: boolean;
}

export interface VectorContext {
  embeddings: Map<string, number[]>;
  fileIndex: Map<string, string>;
  lastUpdated: string;
}

export class PhaseEngine {
  private context: PhaseEngineContext;
  private listeners: Set<(context: PhaseEngineContext) => void> = new Set();

  constructor(initialPlan?: PhasePlan) {
    this.context = {
      plan: initialPlan || this.createEmptyPlan(),
      currentState: PhaseEngineState.IDLE,
      sessionBypasses: [],
    };
  }

  // State Management
  getContext(): PhaseEngineContext {
    return { ...this.context };
  }

  subscribe(listener: (context: PhaseEngineContext) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.listeners.forEach(listener => listener(this.getContext()));
  }

  private setState(newState: PhaseEngineState): void {
    this.context.currentState = newState;
    this.emit();
  }

  // Phase Plan Management
  loadPlan(plan: PhasePlan): void {
    this.validatePlanDAG(plan);
    this.context.plan = plan;
    this.context.currentPhase = undefined;
    this.setState(PhaseEngineState.IDLE);
  }

  private createEmptyPlan(): PhasePlan {
    return {
      project_title: "Untitled Project",
      phases: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  private validatePlanDAG(plan: PhasePlan): void {
    const phaseIds = new Set(plan.phases.map(p => p.phase_id));
    
    for (const phase of plan.phases) {
      for (const dep of phase.dependencies) {
        if (!phaseIds.has(dep)) {
          throw new Error(`Phase ${phase.phase_id} depends on non-existent phase ${dep}`);
        }
      }
    }

    // Check for cycles (simplified topological sort check)
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const hasCycle = (phaseId: string): boolean => {
      if (visiting.has(phaseId)) return true;
      if (visited.has(phaseId)) return false;

      visiting.add(phaseId);
      const phase = plan.phases.find(p => p.phase_id === phaseId);
      
      for (const dep of phase?.dependencies || []) {
        if (hasCycle(dep)) return true;
      }

      visiting.delete(phaseId);
      visited.add(phaseId);
      return false;
    };

    for (const phase of plan.phases) {
      if (hasCycle(phase.phase_id)) {
        throw new Error(`Circular dependency detected involving phase ${phase.phase_id}`);
      }
    }
  }

  // Phase Execution
  async startNextPhase(): Promise<void> {
    if (this.context.currentState !== PhaseEngineState.IDLE) {
      throw new Error(`Cannot start phase from state ${this.context.currentState}`);
    }

    const nextPhase = this.getNextAvailablePhase();
    if (!nextPhase) {
      this.setState(PhaseEngineState.ALL_PHASES_COMPLETED);
      return;
    }

    this.context.currentPhase = nextPhase;
    nextPhase.status = 'active';
    nextPhase.started_at = new Date().toISOString();
    
    this.setState(PhaseEngineState.PHASE_INITIALIZATION);
    await this.initializePhaseContext(nextPhase);
  }

  private getNextAvailablePhase(): Phase | undefined {
    return this.context.plan.phases.find(phase => {
      // Must be pending
      if (phase.status !== 'pending') return false;

      // All dependencies must be completed
      return phase.dependencies.every(depId => {
        const dep = this.context.plan.phases.find(p => p.phase_id === depId);
        return dep?.status === 'completed';
      });
    });
  }

  private async initializePhaseContext(phase: Phase): Promise<void> {
    // Inject phase-specific context and .agentrules into system prompt
    const phaseScope = this.buildPhaseScope(phase);
    
    // Clear trajectory memory from previous phase
    await this.clearTrajectoryMemory();
    
    // Update vector context if needed
    await this.updateVectorContext();
    
    this.setState(PhaseEngineState.PLANNING);
  }

  private buildPhaseScope(phase: Phase): string {
    return `
CURRENT PHASE: ${phase.phase_id}
PHASE NAME: ${phase.name}
PHASE OBJECTIVES: ${phase.description || 'No description provided'}

TARGET FILES (you may only modify these):
${phase.target_files.map(f => `- ${f}`).join('\n')}

TASKS TO COMPLETE:
${phase.tasks.map((task, i) => `${i + 1}. ${task.text}`).join('\n')}

RESTRICTIONS:
- You MUST only work on files in the target_files list
- You MUST complete ALL tasks before calling phase_complete()
- You MUST NOT modify files from future phases
- If verification_command exists, it MUST pass before phase completion

${phase.verification_command ? `VERIFICATION: Run "${phase.verification_command}" - it must exit with code 0` : ''}
`;
  }

  private async clearTrajectoryMemory(): Promise<void> {
    // Clear short-term memory while preserving long-term context
    // Implementation would integrate with your existing context management
  }

  private async updateVectorContext(): Promise<void> {
    // Update vector embeddings for modified files
    // This would integrate with your RAG system
  }

  // Phase Completion & Verification
  async completePhase(phaseId: string, summary: string): Promise<void> {
    const phase = this.context.plan.phases.find(p => p.phase_id === phaseId);
    if (!phase || phase !== this.context.currentPhase) {
      throw new Error(`Cannot complete phase ${phaseId}: not the current active phase`);
    }

    this.setState(PhaseEngineState.PHASE_VERIFICATION);

    // Run verification command if specified
    if (phase.verification_command) {
      const verificationPassed = await this.runVerification(phase.verification_command);
      if (!verificationPassed) {
        this.setState(PhaseEngineState.PLANNING); // Return to planning for self-correction
        return;
      }
    }

    // Run security audit
    this.setState(PhaseEngineState.AUDITING);
    const auditResults = await this.runSecurityAudit(phase);
    
    if (auditResults.some(r => !r.passed)) {
      this.context.auditResults = auditResults;
      this.setState(PhaseEngineState.AWAITING_HITL);
      return;
    }

    // Phase passed all checks
    await this.finalizePhase(phase, summary);
  }

  private async runVerification(command: string): Promise<boolean> {
    // This would integrate with your WebContainer or terminal execution
    // For now, return true as placeholder
    return true;
  }

  private async runSecurityAudit(phase: Phase): Promise<AuditResult[]> {
    // This would run the 5 security domain audits
    // For now, return empty results as placeholder
    return [];
  }

  private async finalizePhase(phase: Phase, summary: string): Promise<void> {
    phase.status = 'completed';
    phase.completed_at = new Date().toISOString();
    this.context.plan.updated_at = new Date().toISOString();
    
    this.setState(PhaseEngineState.AWAITING_PHASE_GATE);
  }

  // HITL & Gate Controls
  async bypassViolation(ruleId: string, scope: 'once' | 'session' | 'permanent'): Promise<void> {
    if (scope === 'session' || scope === 'permanent') {
      this.context.sessionBypasses.push(ruleId);
    }

    // Log the bypass
    await this.logAuditEvent({
      timestamp: new Date().toISOString(),
      phase_id: this.context.currentPhase?.phase_id || 'unknown',
      rule_id: ruleId,
      bypassed_by: 'user',
      scope,
      risk_summary: 'Manual bypass by user'
    });

    // Continue execution
    if (this.context.currentPhase) {
      await this.finalizePhase(this.context.currentPhase, 'Completed with bypassed violations');
    }
  }

  async approvePhaseGate(): Promise<void> {
    if (this.context.currentState !== PhaseEngineState.AWAITING_PHASE_GATE) {
      throw new Error('No phase gate awaiting approval');
    }

    this.context.currentPhase = undefined;
    this.setState(PhaseEngineState.IDLE);
    
    // Auto-advance to next phase if available
    await this.startNextPhase();
  }

  private async logAuditEvent(event: any): Promise<void> {
    // This would append to .agent/audit.log
    console.log('Audit event:', event);
  }

  // Utility Methods
  getPhaseProgress(): { completed: number; total: number; current?: string } {
    const completed = this.context.plan.phases.filter(p => p.status === 'completed').length;
    const total = this.context.plan.phases.length;
    const current = this.context.currentPhase?.phase_id;
    
    return { completed, total, current };
  }

  canStartExecution(): boolean {
    return this.context.plan.phases.length > 0 && 
           this.context.currentState === PhaseEngineState.IDLE &&
           this.getNextAvailablePhase() !== undefined;
  }
}

// Export singleton instance
export const phaseEngine = new PhaseEngine();